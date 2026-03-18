export default async function (ctx) {
  const C = {
    bg1: '#0d1117', bg2: '#161b22', barBg: '#30363d',
    text: '#f0f6fc', muted: '#8b949e', dim: '#484f58',
    cpu: '#3fb950', mem: '#58a6ff', disk: '#d29922', net: '#f778ba',
    error: '#f85149'
  };

  const pctColor = p => p > 85 ? C.error : (p > 65 ? C.disk : C.cpu);
  const fmt = b => {
    if (!isFinite(b) || b < 0) return '0B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  function countryToFlag(cc) {
    if (!cc || cc === '??') return '🌐';
    return cc.toUpperCase().replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt()));
  }

  async function getGeo(ip) {
    if (!ip || ip === '0.0.0.0') return { country: '??' };
    const key = `_geo_${ip}`;
    const cached = ctx.storage.getJSON(key);
    if (cached) return cached;
    try {
      const r = await ctx.fetch(`https://ipinfo.io/${ip}/json`, { timeout: 2000 });
      const j = await r.json();
      const geo = { country: j.country || '??' };
      ctx.storage.setJSON(key, geo);
      return geo;
    } catch { return { country: '??' }; }
  }

  async function fetchServer(id) {
    const prefix = `vps${id}_`;
    const host = ctx.env[prefix + 'host'];
    if (!host) return { name: `VPS${id}`, error: '未配置' };

    const sk = `_vps_ext_${id}_`; // 独立存储 Key

    try {
      const session = await ctx.ssh.connect({
        host,
        port: Number(ctx.env[prefix + 'port'] || 22),
        username: ctx.env[prefix + 'user'],
        password: ctx.env[prefix + 'pass'],
        privateKey: ctx.env[prefix + 'key'],
        timeout: 5000
      });

      const SEP = '<<SEP>>';
      const cmds = [
        'hostname -s',
        'head -n1 /proc/stat', // 精准 CPU 滴答
        'free -b | grep Mem',
        'df -B1 / | tail -1',
        "awk '/^(eth|en|ens|eno|bond)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
        'cat /proc/loadavg',
        'curl -s --connect-timeout 2 ifconfig.me || echo "0.0.0.0"'
      ];

      const { stdout } = await session.exec(cmds.join(` && echo "${SEP}" && `));
      await session.close();

      const p = stdout.split(SEP).map(s => s.trim());
      const now = Date.now();

      // ✅ 高精度 CPU 计算 (proc/stat)
      const cpuParts = p[1].split(/\s+/).slice(1).map(Number);
      const total = cpuParts.reduce((a, b) => a + b, 0);
      const idle = cpuParts[3];
      const prevCpu = ctx.storage.getJSON(sk + 'cpu') || { t: 0, i: 0 };
      let cpu = 0;
      if (prevCpu.t > 0) {
        const diffT = total - prevCpu.t;
        const diffI = idle - prevCpu.i;
        cpu = Math.round((1 - diffI / diffT) * 100);
      }
      ctx.storage.setJSON(sk + 'cpu', { t: total, i: idle });

      // ✅ MEM & DISK
      const m = p[2].split(/\s+/);
      const memTotal = Number(m[1]), memUsed = Number(m[2]);
      const mem = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
      const d = p[3].split(/\s+/);
      const disk = parseInt(d.find(x => x.includes('%')) || '0');

      // ✅ 网络速率 (独立隔离)
      const [rx, tx] = p[4].split(' ').map(Number);
      const prevNet = ctx.storage.getJSON(sk + 'net');
      let rxR = 0, txR = 0;
      if (prevNet) {
        const dt = (now - prevNet.ts) / 1000;
        if (dt > 0.5) {
          rxR = Math.max(0, (rx - prevNet.rx) / dt);
          txR = Math.max(0, (tx - prevNet.tx) / dt);
        }
      }
      ctx.storage.setJSON(sk + 'net', { rx, tx, ts: now });

      const geo = await getGeo(p[6]);

      return {
        name: p[0] || host,
        cpu: Math.max(0, Math.min(100, cpu)),
        mem, disk, rxR, txR,
        load: p[5].split(' ')[0],
        country: geo.country
      };
    } catch (e) {
      return { name: host, error: e.message.includes('auth') ? '鉴权失败' : '连接超时' };
    }
  }

  const servers = await Promise.all([fetchServer(1), fetchServer(2), fetchServer(3)]);

  // --- UI Components ---
  const bar = (pct, color) => ({
    type: 'stack', direction: 'row', height: 4, borderRadius: 2, backgroundColor: C.barBg,
    children: [
      { type: 'stack', flex: Math.max(1, pct), backgroundColor: color, borderRadius: 2, children: [] },
      { type: 'spacer', flex: 100 - Math.min(pct, 100) }
    ]
  });

  const card = (s) => ({
    type: 'stack', direction: 'column', flex: 1, gap: 8, padding: 8,
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', children: [
          { type: 'text', text: s.name, font: { size: 12, weight: 'bold' }, textColor: C.text, maxLines: 1 },
          { type: 'spacer' },
          { type: 'text', text: countryToFlag(s.country), font: { size: 12 } }
      ]},
      { type: 'stack', height: 1, backgroundColor: C.dim, opacity: 0.3, children: [] },
      ...(s.error ? [
        { type: 'spacer' },
        { type: 'text', text: s.error, font: { size: 10 }, textColor: C.error, textAlign: 'center' },
        { type: 'spacer' }
      ] : [
        { type: 'stack', direction: 'column', gap: 2, children: [
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'CPU', font: { size: 10 } }, { type: 'spacer' }, { type: 'text', text: `${s.cpu}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.cpu) }] },
            bar(s.cpu, pctColor(s.cpu))
        ]},
        { type: 'stack', direction: 'column', gap: 2, children: [
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'MEM', font: { size: 10 } }, { type: 'spacer' }, { type: 'text', text: `${s.mem}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.mem) }] },
            bar(s.mem, pctColor(s.mem))
        ]},
        { type: 'stack', direction: 'column', gap: 2, children: [
            { type: 'stack', direction: 'row', children: [{ type: 'text', text: 'DSK', font: { size: 10 } }, { type: 'spacer' }, { type: 'text', text: `${s.disk}%`, font: { size: 10, family: 'Menlo' }, textColor: pctColor(s.disk) }] },
            bar(s.disk, pctColor(s.disk))
        ]},
        { type: 'stack', direction: 'column', gap: 1, children: [
            { type: 'text', text: `↓ ${fmt(s.rxR)}/s`, font: { size: 9, family: 'Menlo' }, textColor: C.net, maxLines: 1 },
            { type: 'text', text: `↑ ${fmt(s.txR)}/s`, font: { size: 9, family: 'Menlo' }, textColor: C.muted, maxLines: 1 }
        ]},
        { type: 'text', text: `L: ${s.load}`, font: { size: 9, family: 'Menlo' }, textColor: C.dim, textAlign: 'right' }
      ])
    ]
  });

  const hasErr = servers.some(s => s.error);

  return {
    type: 'widget', padding: 12,
    backgroundGradient: { type: 'linear', colors: [C.bg1, C.bg2], startPoint: { x: 0, y: 0 }, endPoint: { x: 0, y: 1 } },
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', children: [
          { type: 'text', text: 'SERVER CLUSTER монитор', font: { size: 11, weight: 'heavy' }, textColor: C.muted },
          { type: 'spacer' },
          { type: 'date', date: new Date().toISOString(), format: 'time', font: { size: 10 }, textColor: C.dim }
      ]},
      { type: 'spacer', length: 10 },
      { type: 'stack', direction: 'row', gap: 6, flex: 1, children: [
          card(servers[0]),
          { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] },
          card(servers[1]),
          { type: 'stack', width: 0.5, backgroundColor: C.barBg, children: [] },
          card(servers[2])
      ]},
      { type: 'spacer', length: 8 },
      { type: 'text', text: hasErr ? 'SYSTEM DEGRADED' : 'ALL SYSTEMS OPERATIONAL', font: { size: 9, weight: 'bold' }, textAlign: 'center', textColor: hasErr ? C.error : C.dim }
    ]
  };
}
