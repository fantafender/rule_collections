export default async function (ctx) {

  // ───────── 配色 ─────────
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

  // ───────── IP 地理缓存 ─────────
  async function getGeo(ip) {
    const key = `_geo_${ip}`;
    const cached = ctx.storage.getJSON(key);
    if (cached) return cached;

    try {
      const res = await ctx.fetch(`https://ipinfo.io/${ip}/json`);
      const j = await res.json();
      const geo = { country: j.country || '??' };
      ctx.storage.setJSON(key, geo);
      return geo;
    } catch {
      return { country: '??' };
    }
  }

  // ───────── 单节点获取（带缓存） ─────────
  async function fetchServer(id) {
    const prefix = `vps${id}_`;
    const host = ctx.env[prefix + 'host'];
    if (!host) return { name: `VPS${id}`, error: 'NO CFG' };

    const cacheKey = `_cache_${id}`;
    const cache = ctx.storage.getJSON(cacheKey);

    // 👉 15秒缓存（避免3连SSH）
    if (cache && Date.now() - cache.ts < 15000) return cache.data;

    try {
      const session = await ctx.ssh.connect({
        host,
        port: Number(ctx.env[prefix + 'port'] || 22),
        username: ctx.env[prefix + 'user'],
        password: ctx.env[prefix + 'pass'],
        timeout: 4000
      });

      const SEP = '<<SEP>>';
      const cmds = [
        'hostname -s',
        'cat /proc/loadavg',
        'head -1 /proc/stat',
        'free -b | grep Mem',
        'df -B1 / | tail -1',
        "awk '/^(eth|en|ens|eno)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev"
      ];

      const { stdout } = await session.exec(cmds.join(` && echo "${SEP}" && `));
      await session.close();

      const p = stdout.split(SEP).map(s => s.trim());
      const now = Date.now();

      // CPU
      const cpuNums = p[2].replace(/^cpu\s+/, '').split(/\s+/).map(Number);
      const total = cpuNums.reduce((a, b) => a + b, 0);
      const idle = cpuNums[3];

      const prev = ctx.storage.getJSON(`_cpu_${id}`);
      let cpu = 0;
      if (prev && total > prev.t) {
        cpu = Math.round((1 - (idle - prev.i) / (total - prev.t)) * 100);
      }
      ctx.storage.setJSON(`_cpu_${id}`, { t: total, i: idle });

      // MEM
      const m = p[3].split(/\s+/);
      const mem = m[1] ? Math.round((Number(m[2]) / Number(m[1])) * 100) : 0;

      // DISK
      const d = p[4].split(/\s+/);
      const disk = parseInt(d[4]) || 0;

      // NET
      const [rx, tx] = p[5].split(' ').map(Number);
      const prevNet = ctx.storage.getJSON(`_net_${id}`);
      let rxR = 0, txR = 0;

      if (prevNet && now > prevNet.ts) {
        const dt = (now - prevNet.ts) / 1000;
        if (dt > 0 && dt < 3600) {
          rxR = Math.max(0, (rx - prevNet.rx) / dt);
          txR = Math.max(0, (tx - prevNet.tx) / dt);
        }
      }

      ctx.storage.setJSON(`_net_${id}`, { rx, tx, ts: now });

      // GEO
      const geo = await getGeo(host);

      const data = {
        name: p[0] || host,
        cpu: Math.max(0, cpu),
        mem,
        disk,
        rxR,
        txR,
        load: p[1].split(' ')[0],
        country: geo.country
      };

      ctx.storage.setJSON(cacheKey, { ts: now, data });

      return data;

    } catch {
      return { name: host, error: 'OFFLINE' };
    }
  }

  // ───────── 拉取三节点 ─────────
  const servers = [
    await fetchServer(1),
    await fetchServer(2),
    await fetchServer(3)
  ];

  // ───────── UI 组件 ─────────
  const bar = (pct, color) => ({
    type: 'stack',
    direction: 'row',
    height: 4,
    borderRadius: 2,
    backgroundColor: C.barBg,
    children: pct > 0 ? [
      { type: 'stack', flex: Math.max(1, pct), backgroundColor: color, borderRadius: 2 },
      ...(pct < 100 ? [{ type: 'spacer', flex: 100 - pct }] : [])
    ] : [{ type: 'spacer' }]
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
          { type: 'text', text: s.country || '??', font: { size: 10 }, textColor: C.muted }
        ]
      },

      ...(s.error ? [
        { type: 'spacer' },
        { type: 'text', text: s.error, textColor: C.error, textAlign: 'center' },
        { type: 'spacer' }
      ] : [

        { type: 'text', text: `CPU ${s.cpu}%`, font: { size: 10 }, textColor: pctColor(s.cpu) },
        bar(s.cpu, pctColor(s.cpu)),

        { type: 'text', text: `MEM ${s.mem}%`, font: { size: 10 }, textColor: pctColor(s.mem) },
        bar(s.mem, pctColor(s.mem)),

        { type: 'text', text: `DSK ${s.disk}%`, font: { size: 10 }, textColor: pctColor(s.disk) },
        bar(s.disk, pctColor(s.disk)),

        {
          type: 'text',
          text: `↓${fmt(s.rxR)} ↑${fmt(s.txR)}`,
          font: { size: 10, family: 'Menlo' },
          textColor: C.net
        },

        {
          type: 'text',
          text: `LOAD ${s.load}`,
          font: { size: 9, family: 'Menlo' },
          textColor: C.dim
        }
      ])
    ]
  });

  // ───────── 状态判断 ─────────
  const hasError = servers.some(s => s.error);

  // ───────── Large 布局 ─────────
  if (ctx.widgetFamily === 'large' || ctx.widgetFamily === 'systemLarge' || !ctx.widgetFamily) {
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
          children: [
            card(servers[0]),
            card(servers[1]),
            card(servers[2])
          ]
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

  // fallback
  return {
    type: 'widget',
    backgroundColor: C.bg1,
    padding: 12,
    children: [card(servers[0])]
  };
}
