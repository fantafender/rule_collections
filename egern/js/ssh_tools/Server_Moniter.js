export default async function (ctx) {

  const C = {
    bg1: '#0d1117', bg2: '#161b22', barBg: '#30363d',
    text: '#f0f6fc', muted: '#8b949e', dim: '#484f58',
    cpu: '#3fb950', mem: '#58a6ff', disk: '#d29922', net: '#f778ba',
    error: '#f85149'
  };

  const pctColor = p => p > 85 ? C.error : (p > 65 ? C.disk : C.cpu);

  const fmt = b => {
    if (!isFinite(b)) return '0B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  // 🇺🇳 国旗
  function countryToFlag(cc) {
    if (!cc || cc.length !== 2 || cc === '??') return '🌐';
    return cc.toUpperCase().replace(/./g, c =>
      String.fromCodePoint(127397 + c.charCodeAt())
    );
  }

  // 🌍 Geo
  async function getGeo(ip) {
    const key = `_geo_${ip}`;
    const c = ctx.storage.getJSON(key);
    if (c) return c;
    try {
      const r = await ctx.fetch(`https://ipinfo.io/${ip}/json`);
      const j = await r.json();
      const geo = { country: j.country || '??' };
      ctx.storage.setJSON(key, geo);
      return geo;
    } catch {
      return { country: '??' };
    }
  }

  async function fetchServer(id) {
    const prefix = `vps${id}_`;
    const host = ctx.env[prefix + 'host'];

    if (!host) return { name: `VPS${id}`, error: 'NO CFG' };

    try {
      const privateKey = ctx.env[prefix + 'key'];
      const password = ctx.env[prefix + 'pass'];

      const session = await ctx.ssh.connect({
        host,
        port: Number(ctx.env[prefix + 'port'] || 22),
        username: ctx.env[prefix + 'user'],
        ...(privateKey ? { privateKey } : { password }),
        timeout: 5000
      });

      const SEP = '<<SEP>>';

      const cmds = [
        'hostname -s',
        'top -bn1 | grep "Cpu(s)"',
        'free -b | grep Mem',
        'df -B1 / | tail -1',
        "awk '/^(eth|en|ens|eno)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
        'cat /proc/loadavg',
        'curl -s ifconfig.me'
      ];

      const { stdout } = await session.exec(cmds.join(` && echo "${SEP}" && `));
      await session.close();

      const p = stdout.split(SEP).map(s => s.trim());
      const now = Date.now();

      // ✅ CPU（实时）
      const cpuMatch = p[1].match(/(\d+\.\d+)\s*id/);
      const cpu = cpuMatch ? Math.round(100 - parseFloat(cpuMatch[1])) : 0;

      // ✅ MEM（稳定）
      const m = p[2].split(/\s+/);
      const total = Number(m[1]);
      const used = Number(m[2]);
      const mem = total > 0 ? Math.round((used / total) * 100) : 0;

      // ✅ DISK（兼容所有系统）
      const d = p[3].split(/\s+/);
      const disk = parseInt(d.find(x => x.includes('%')) || '0');

      // ✅ NET（修复不动问题）
      const [rx, tx] = p[4].split(' ').map(Number);
      const prev = ctx.storage.getJSON(`_net_${id}`);

      let rxR = 0, txR = 0;

      if (prev) {
        const dt = (now - prev.ts) / 1000;
        if (dt >= 1 && dt < 600) {
          rxR = (rx - prev.rx) / dt;
          txR = (tx - prev.tx) / dt;

          if (rxR <= 0) rxR = prev.rxR || 0;
          if (txR <= 0) txR = prev.txR || 0;
        }
      }

      ctx.storage.setJSON(`_net_${id}`, { rx, tx, ts: now, rxR, txR });

      // ✅ 公网 IP → 国旗
      const publicIP = p[6]?.trim();
      const geo = await getGeo(publicIP);

      return {
        name: p[0] || host,
        cpu,
        mem,
        disk,
        rxR,
        txR,
        load: p[5].split(' ')[0],
        country: geo.country
      };

    } catch (e) {
      return {
        name: host,
        error: e.message.includes('auth') ? 'AUTH FAIL' : 'OFFLINE'
      };
    }
  }

  // 🚀 并发
  const servers = await Promise.all([
    fetchServer(1),
    fetchServer(2),
    fetchServer(3)
  ]);

  const bar = (pct, color) => ({
    type: 'stack',
    direction: 'row',
    height: 4,
    borderRadius: 2,
    backgroundColor: C.barBg,
    children: [
      { type: 'stack', flex: Math.max(1, pct), backgroundColor: color },
      { type: 'spacer', flex: 100 - Math.min(pct, 100) }
    ]
  });

  const card = (s) => ({
    type: 'stack',
    direction: 'column',
    flex: 1,
    gap: 8,
    padding: 10,
    children: [
      {
        type: 'stack',
        direction: 'row',
        children: [
          { type: 'text', text: s.name, font: { size: 12, weight: 'bold' }, textColor: C.text },
          { type: 'spacer' },
          { type: 'text', text: countryToFlag(s.country), font: { size: 12 }, textColor: C.muted }
        ]
      },

      ...(s.error ? [
        { type: 'text', text: `❌ ${s.error}`, textColor: C.error, textAlign: 'center' }
      ] : [
        { type: 'text', text: `CPU ${s.cpu}%`, textColor: pctColor(s.cpu) },
        bar(s.cpu, pctColor(s.cpu)),

        { type: 'text', text: `MEM ${s.mem}%`, textColor: pctColor(s.mem) },
        bar(s.mem, pctColor(s.mem)),

        { type: 'text', text: `DSK ${s.disk}%`, textColor: pctColor(s.disk) },
        bar(s.disk, pctColor(s.disk)),

        { type: 'text', text: `↓${fmt(s.rxR)} ↑${fmt(s.txR)}`, font: { size: 10, family: 'Menlo' }, textColor: C.net },
        { type: 'text', text: `LOAD ${s.load}`, font: { size: 9 }, textColor: C.dim }
      ])
    ]
  });

  const hasError = servers.some(s => s.error);

  return {
    type: 'widget',
    backgroundGradient: {
      type: 'linear',
      colors: [C.bg1, C.bg2],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 0, y: 1 }
    },
    padding: 12,
    children: [
      {
        type: 'stack',
        direction: 'row',
        children: [
          { type: 'text', text: 'CLUSTER · MONITOR', font: { size: 12, weight: 'bold' }, textColor: C.muted },
          { type: 'spacer' },
          { type: 'date', date: new Date().toISOString(), format: 'time', font: { size: 10 }, textColor: C.dim }
        ]
      },

      { type: 'spacer' },

      {
        type: 'stack',
        direction: 'row',
        gap: 8,
        children: servers.map(card)
      },

      { type: 'spacer' },

      {
        type: 'text',
        text: hasError ? 'STATUS: DEGRADED' : 'STATUS: ALL SYSTEMS OPERATIONAL',
        textColor: hasError ? C.error : C.dim,
        textAlign: 'center',
        font: { size: 10, weight: 'bold' }
      }
    ]
  };
}
