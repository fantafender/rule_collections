export default async function (ctx) {
  const C = {
    bg1: '#0d1117', bg2: '#161b22', barBg: '#30363d',
    text: '#e6edf3', muted: '#8b949e', dim: '#484f58',
    cpu: '#3fb950', mem: '#58a6ff', disk: '#d29922', net: '#f778ba', error: '#ff7b72'
  };

  const fmtBytes = b => {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  const pctColor = (p) => p > 85 ? C.error : (p > 65 ? C.disk : C.cpu);

  // --- 单台服务器抓取逻辑 ---
  async function fetchServer(id) {
    const prefix = `vps${id}_`;
    const host = ctx.env[prefix + 'host'];
    if (!host) return { name: `未配置 ${id}`, error: 'Empty' };

    const storageKey = `_vps${id}_`;

    try {
      const session = await ctx.ssh.connect({
        host,
        port: Number(ctx.env[prefix + 'port'] || 22),
        username: ctx.env[prefix + 'user'],
        password: ctx.env[prefix + 'pass'],
        timeout: 4500
      });

      const cmds = [
        'hostname -s',
        'cat /proc/loadavg',
        'head -1 /proc/stat',
        'free -b | grep Mem',
        'df -b / | tail -1',
        "awk '/^ *(eth|en|ens|eno|bond)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev"
      ];
      
      const { stdout } = await session.exec(cmds.join(' && echo "<<SEP>>" && '));
      await session.close();

      const p = stdout.split('<<SEP>>').map(s => s.trim());
      
      // CPU
      const cpuNums = p[2].replace(/^cpu\s+/, '').split(/\s+/).map(Number);
      const total = cpuNums.reduce((a, b) => a + b, 0), idle = cpuNums[3];
      const prevCpu = ctx.storage.getJSON(storageKey + 'cpu');
      let cpuPct = 0;
      if (prevCpu && total > prevCpu.t) {
        cpuPct = Math.round((1 - (idle - prevCpu.i) / (total - prevCpu.t)) * 100);
      }
      ctx.storage.setJSON(storageKey + 'cpu', { t: total, i: idle });

      // Mem & Disk
      const m = p[3].split(/\s+/), d = p[4].split(/\s+/);
      const memPct = Math.round((Number(m[2]) / Number(m[1])) * 100);
      const diskPct = parseInt(d[4]) || 0;

      // Net
      const [rx, tx] = p[5].split(' ').map(Number);
      const now = Date.now();
      const prevNet = ctx.storage.getJSON(storageKey + 'net');
      let rxR = 0, txR = 0;
      if (prevNet && now > prevNet.ts) {
        rxR = (rx - prevNet.rx) / ((now - prevNet.ts) / 1000);
        txR = (tx - prevNet.tx) / ((now - prevNet.ts) / 1000);
      }
      ctx.storage.setJSON(storageKey + 'net', { rx, tx, ts: now });

      return { 
        name: p[0] || host, 
        cpu: Math.max(0, cpuPct), mem: memPct, disk: diskPct, 
        rxR, txR, load: p[1].split(' ')[0], status: 'ok' 
      };
    } catch (e) {
      return { name: host, error: 'OFFLINE' };
    }
  }

  // 并发请求
  const servers = await Promise.all([fetchServer(1), fetchServer(2), fetchServer(3)]);

  // --- UI 构建模块 ---
  const renderBar = (pct, color) => ({
    type: 'stack', height: 5, borderRadius: 2.5, backgroundColor: C.barBg, 
    children: [{ type: 'stack', width: `${Math.min(pct, 100)}%`, height: 5, borderRadius: 2.5, backgroundColor: color, children: [] }]
  });

  const renderColumn = (s) => ({
    type: 'stack', direction: 'column', flex: 1, gap: 12,
    children: [
      { type: 'text', text: s.name.toUpperCase(), font: { size: 13, weight: 'bold' }, textColor: C.text, textAlign: 'center', maxLines: 1 },
      { type: 'stack', height: 0.5, backgroundColor: C.dim, children: [] },
      ...(s.error ? [
        { type: 'spacer' },
        { type: 'image', src: 'sf-symbol:wifi.slash', color: C.error, width: 20, height: 20, alignSelf: 'center' },
        { type: 'text', text: 'CONNECTION FAILED', font: { size: 9 }, textColor: C.error, textAlign: 'center' },
        { type: 'spacer' }
      ] : [
        { type: 'stack', direction: 'column', gap: 6, children: [
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'CPU', font: { size: 10 }, textColor: C.muted }, { type: 'spacer' }, { type: 'text', text: `${s.cpu}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.cpu) }] },
            renderBar(s.cpu, pctColor(s.cpu)),
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'MEM', font: { size: 10 }, textColor: C.muted }, { type: 'spacer' }, { type: 'text', text: `${s.mem}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.mem) }] },
            renderBar(s.mem, pctColor(s.mem)),
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'DSK', font: { size: 10 }, textColor: C.muted }, { type: 'spacer' }, { type: 'text', text: `${s.disk}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.disk) }] },
            renderBar(s.disk, pctColor(s.disk))
        ]},
        { type: 'stack', direction: 'column', gap: 2, children: [
            { type: 'text', text: `↓ ${fmtBytes(s.rxR)}/s`, font: { size: 10, family: 'Menlo' }, textColor: C.net },
            { type: 'text', text: `↑ ${fmtBytes(s.txR)}/s`, font: { size: 10, family: 'Menlo' }, textColor: C.muted }
        ]},
        { type: 'text', text: `Load: ${s.load}`, font: { size: 10, family: 'Menlo' }, textColor: C.dim, textAlign: 'right' }
      ])
    ]
  });

  // --- 布局输出 ---
  // 仅在 Large 尺寸显示三列
  if (ctx.widgetFamily === 'systemLarge') {
    return {
      type: 'widget', backgroundGradient: { type: 'linear', colors: [C.bg1, C.bg2], startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 1 } },
      padding: 16,
      children: [
        { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'CLUSTER OVERVIEW', font: { size: 11, weight: 'heavy' }, textColor: C.muted }, { type: 'spacer' }, { type: 'date', date: new Date().toISOString(), format: 'time', font: { size: 10 }, textColor: C.dim }] },
        { type: 'spacer', length: 12 },
        { type: 'stack', direction: 'row', gap: 12, flex: 1, children: [
            renderColumn(servers[0]),
            { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] },
            renderColumn(servers[1]),
            { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] },
            renderColumn(servers[2])
        ]}
      ]
    };
  }

  // 其他尺寸默认显示第一台 VPS 的简化版
  return {
    type: 'widget', backgroundColor: C.bg1, padding: 16,
    children: [renderColumn(servers[0])]
  };
}
