// Audience measurement without cookies or personal data (Umami or GoatCounter, set in config.js).
// Only game facts are sent (source, mode, score range): never a profile, a track or a name.
const Stats = (() => {
  const conf = typeof STATS === 'object' && STATS ? STATS : {};
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:';
  const queue = [];
  let send = null;

  function load(src, attrs, ready) {
    const s = document.createElement('script');
    s.async = true;
    s.src = src;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = () => { send = ready(); if (send) queue.splice(0).forEach(([n, d]) => send(n, d)); };
    document.head.append(s);
  }

  if (!local && conf.umamiId) {
    load('https://cloud.umami.is/script.js', { 'data-website-id': conf.umamiId }, () =>
      window.umami?.track && ((name, data) => window.umami.track(name, data)));
  } else if (!local && conf.goatcounter) {
    // GoatCounter events have no properties: they are folded into the event path ("partie-lancee/dztop/sudden").
    load('https://gc.zgo.at/count.js', { 'data-goatcounter': `https://${conf.goatcounter}.goatcounter.com/count` }, () =>
      window.goatcounter?.count && ((name, data) => window.goatcounter.count({
        path: [name, ...Object.values(data)].join('/'), title: name, event: true,
      })));
  }

  const enabled = !local && !!(conf.umamiId || conf.goatcounter);

  function track(name, data = {}) {
    if (!enabled) return;
    try { send ? send(name, data) : queue.length < 50 && queue.push([name, data]); } catch { /* never break the game */ }
  }

  // Scores are sent as a range, not an exact value: enough to compare, nothing more.
  const bucket = (score, max) => (max ? `${Math.min(100, Math.floor((score / max) * 10) * 10)}%` : '0%');

  return { track, bucket };
})();
