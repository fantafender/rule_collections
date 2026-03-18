export default async function (ctx) {
  const C = {
    bg1: '#0d1117', bg2: '#161b22', barBg: '#30363d',
    text: '#f0f6fc', muted: '#8b949e', dim: '#484f58',
    cpu: '#3fb950', mem: '#58a6ff', disk: '#d29922', net: '#f778ba', error: '#f85149'
  };

  const fmtBytes = b => {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  const pctColor = (p) => p > 85 ? C.error : (p > 65 ? C.disk : C.cpu);

  // --- SSH 数据采集函数 ---
  async function fetchServer(id) {
    const prefix = `vps${id}_`;
    const host = ctx.env[prefix + 'host'];
    if (!host) return { name: `Offline ${id}`, error: '未配置' };

    const storageKey = `_vps${id}_`;
    try {
      const session = await ctx.ssh.connect({
        host, port: Number(ctx.env[prefix + 'port'] || 22),
        username: ctx.env[prefix + 'user'], password: ctx.env[prefix + 'pass'],
        timeout: 4000
      });

      const cmds = [
        'hostname -s', 'cat /proc/loadavg', 'head -1 /proc/stat',
        'free -b | grep Mem', 'df -b / | tail -1',
        "awk '/^ *(eth|en|ens|eno|bond)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev"
      ];
      const { stdout } = await session.exec(cmds.join(' && echo "<<SEP>>" && '));
      await session.close();

      const p = stdout.split('<<SEP>>').map(s => s.trim());
      const now = Date.now();

      // CPU 计算
      const cpuNums = p[2].replace(/^cpu\s+/, '').split(/\s+/).map(Number);
      const total = cpuNums.reduce((a, b) => a + b, 0), idle = cpuNums[3];
      const prevCpu = ctx.storage.getJSON(storageKey + 'cpu');
      let cpuPct = 0;
      if (prevCpu && total > prevCpu.t) {
        cpuPct = Math.round((1 - (idle - prevCpu.i) / (total - prevCpu.t)) * 100);
      }
      ctx.storage.setJSON(storageKey + 'cpu', { t: total, i: idle });

      // Mem & Disk & Net
      const m = p[3].split(/\s+/), d = p[4].split(/\s+/);
      const [rx, tx] = p[5].split(' ').map(Number);
      const prevNet = ctx.storage.getJSON(storageKey + 'net');
      let rxR = 0, txR = 0;
      if (prevNet) {
        rxR = (rx - prevNet.rx) / ((now - prevNet.ts) / 1000);
        txR = (tx - prevNet.tx) / ((now - prevNet.ts) / 1000);
      }
      ctx.storage.setJSON(storageKey + 'net', { rx, tx, ts: now });

      return { 
        name: p[0] || host, cpu: Math.max(0, cpuPct), 
        mem: Math.round((Number(m[2]) / Number(m[1])) * 100), 
        disk: parseInt(d[4]) || 0, rxR, txR, load: p[1].split(' ')[0] 
      };
    } catch (e) {
      return { name: host.split('.')[0], error: 'OFFLINE' };
    }
  }

  // 并发启动三路连接
  const servers = await Promise.all([fetchServer(1), fetchServer(2), fetchServer(3)]);

  // --- UI 构建模块 ---
  const renderProgress = (label, pct, color) => ({
    type: 'stack', direction: 'column', gap: 4,
    children: [
      { type: 'stack', direction: 'row', children: [
          { type: 'text', text: label, font: { size: 10, weight: 'bold' }, textColor: C.muted },
          { type: 'spacer' },
          { type: 'text', text: `${pct}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(pct) }
      ]},
      { type: 'stack', height: 4, borderRadius: 2, backgroundColor: C.barBg, children: [
          { type: 'stack', width: `${Math.min(pct, 100)}%`, height: 4, borderRadius: 2, backgroundColor: color, children: [] }
      ]}
    ]
  });

  const renderVPSColumn = (s) => ({
    type: 'stack', direction: 'column', flex: 1, gap: 15, padding: [10, 5],
    children: [
      { type: 'text', text: s.name.toUpperCase(), font: { size: 13, weight: 'heavy' }, textColor: C.text, textAlign: 'center', maxLines: 1 },
      { type: 'stack', height: 1, backgroundColor: C.dim, children: [] },
      ...(s.error ? [
        { type: 'spacer' },
        { type: 'image', src: 'sf-symbol:bolt.horizontal.circle', color: C.error, width: 24, height: 24, alignSelf: 'center' },
        { type: 'text', text: s.error, font: { size: 10, weight: 'bold' }, textColor: C.error, textAlign: 'center' },
        { type: 'spacer' }
      ] : [
        renderProgress('CPU', s.cpu, pctColor(s.cpu)),
        renderProgress('MEM', s.mem, pctColor(s.mem)),
        renderProgress('DSK', s.disk, pctColor(s.disk)),
        { type: 'stack', direction: 'column', gap: 4, children: [
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:arrow.down.circle', color: C.net, width: 10, height: 10 },
                { type: 'text', text: `${fmtBytes(s.rxR)}/s`, font: { size: 10, family: 'Menlo' }, textColor: C.net }
            ]},
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:arrow.up.circle', color: C.muted, width: 10, height: 10 },
                { type: 'text', text: `${fmtBytes(s.txR)}/s`, font: { size: 10, family: 'Menlo' }, textColor: C.muted }
            ]}
        ]},
        { type: 'text', text: `LOAD ${s.load}`, font: { size: 9, family: 'Menlo', weight: 'bold' }, textColor: C.dim, textAlign: 'center' }
      ])
    ]
  });

  // --- Large 尺寸布局 ---
  if (ctx.widgetFamily === 'systemLarge' || !ctx.widgetFamily) {
    return {
      type: 'widget', 
      backgroundGradient: { type: 'linear', colors: [C.bg1, C.bg2], startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 1 } },
      padding: [15, 12],
      children: [
        { type: 'stack', direction: 'row', alignItems: 'center', children: [
            { type: 'image', src: 'sf-symbol:server.rack', color: C.cpu, width: 14, height: 14 },
            { type: 'spacer', length: 6 },
            { type: 'text', text: 'SERVER CLUSTER MONITOR', font: { size: 12, weight: 'black' }, textColor: C.muted },
            { type: 'spacer' },
            { type: 'date', date: new Date().toISOString(), format: 'time', font: { size: 10 }, textColor: C.dim }
        ]},
        { type: 'spacer', length: 15 },
        { type: 'stack', direction: 'row', gap: 10, flex: 1, children: [
            renderVPSColumn(servers[0]),
            { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] }, // 垂直分割线
            renderVPSColumn(servers[1]),
            { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] }, // 垂直分割线
            renderVPSColumn(servers[2])
        ]},
        { type: 'spacer', length: 10 },
        { type: 'text', text: 'STATUS: ALL SYSTEMS OPERATIONAL', font: { size: 9, weight: 'bold' }, textColor: C.dim, textAlign: 'center' }
      ]
    };
  }

  // 兜底渲染（Small/Medium）
  return {
    type: 'widget', backgroundColor: C.bg1, padding: 15,
    children: [renderVPSColumn(servers[0])]
  };
}
