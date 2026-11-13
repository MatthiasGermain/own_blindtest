const Scoring = (() => {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  // "Titre (feat. X) - Remastered 2011" -> "Titre"
  const clean = (s) => String(s || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .trim();

  function levenshtein(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const similarity = (a, b) => (!a.length && !b.length) ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length);

  function text(guess, answers) {
    const g = norm(guess);
    if (!g) return 0;
    let best = 0;
    for (const a of answers) {
      for (const v of [a, clean(a)]) {
        const n = norm(v);
        if (n) best = Math.max(best, similarity(g, n));
      }
    }
    if (best >= 0.8) return 10;
    if (best >= 0.55 && g.length >= 3) return 5;
    return 0;
  }

  // Each expected artist is worth an equal share of 10 points.
  function artists(guess, expected) {
    if (!norm(guess)) return 0;
    const pieces = String(guess).split(/\s*(?:,|\/|\+|&|\bet\b|\bfeat\.?|\bft\.?|\bx\b)\s*/i).filter((p) => norm(p));
    const candidates = [guess, ...pieces];
    const sum = expected.reduce((s, a) => s + Math.max(...candidates.map((c) => text(c, [a]))), 0);
    return Math.round(sum / expected.length);
  }

  function year(guess, actual) {
    const g = parseInt(guess, 10);
    if (!g || !actual) return 0;
    const d = Math.abs(g - actual);
    return d === 0 ? 10 : d === 1 ? 6 : d <= 3 ? 3 : 0;
  }

  // Play counts are judged on relative error, with a small absolute margin for rarely played tracks.
  function plays(guess, actual) {
    const g = parseInt(guess, 10);
    if (!Number.isFinite(g) || g < 0 || !actual) return 0;
    const d = Math.abs(g - actual);
    if (actual < 20) return d <= 1 ? 10 : d <= 3 ? 6 : d <= 6 ? 3 : 0;
    const e = d / actual;
    return e <= 0.1 ? 10 : e <= 0.25 ? 6 : e <= 0.5 ? 3 : 0;
  }

  function round(guess, track) {
    return {
      artist: artists(guess.artist, track.artists),
      title: text(guess.title, [track.name]),
      album: text(guess.album, [track.album]),
      year: year(guess.year, track.releaseYear),
      added: year(guess.added, track.addedYear),
      plays: plays(guess.plays, track.plays),
      discovered: year(guess.discovered, track.firstYear),
    };
  }

  return { norm, clean, similarity, text, artists, year, plays, round };
})();

if (typeof module !== 'undefined') module.exports = Scoring;
