// A challenge travels entirely in the link: compressed JSON, base64url, after "#c=".
const Challenge = (() => {
  const COVER = 'https://i.scdn.co/image/';
  const FIELDS = ['artist', 'title', 'album', 'year', 'added', 'discovered'];
  const KINDS = ['liked', 'playlist', 'top', 'dztop', 'dzliked', 'dzplaylist', 'history'];
  const SQUARES = ['⬛', '🟫', '🟧'];

  const toB64 = (bytes) => {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const pipe = async (bytes, transform) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());

  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const int = (v, min, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  };

  // A track is its Deezer id when known ("dz123", played from the preview, no account needed),
  // else its Spotify id. Tracks with neither (a history line Deezer never found) are left out.
  function packTrack(t) {
    const dz = t.uri.startsWith('dz:') ? t.uri.slice(3) : t.dzId;
    const id = dz ? `dz${dz}` : t.uri.startsWith('spotify:track:') ? t.uri.slice(14) : null;
    if (!id) return null;
    const cover = t.cover?.startsWith(COVER) ? t.cover.slice(COVER.length) : '';
    return [id, t.name, t.artists, t.album, t.releaseYear || 0, t.addedYear || 0, cover, t.startMs || 0, t.firstYear || 0];
  }

  // Links come from anyone: every value is checked and bounded before use.
  function unpackTrack(a) {
    if (!Array.isArray(a)) return null;
    const dz = /^dz(\d{1,12})$/.exec(a[0])?.[1];
    if (!dz && !/^[A-Za-z0-9]{22}$/.test(a[0])) return null;
    const artists = Array.isArray(a[2]) ? a[2].map((x) => str(x, 100)).filter(Boolean).slice(0, 10) : [];
    if (!artists.length || !str(a[1])) return null;
    return {
      uri: dz ? `dz:${dz}` : 'spotify:track:' + a[0],
      name: str(a[1]),
      artists,
      album: str(a[3]),
      releaseYear: int(a[4], 0, 3000) || null,
      addedYear: int(a[5], 0, 3000) || null,
      cover: /^[a-f0-9]{40}$/.test(a[6]) ? COVER + a[6] : '',
      startMs: int(a[7], 0, 3600000),
      firstYear: int(a[8], 0, 3000) || null,
      duration: 0,
    };
  }

  async function encode(c) {
    const payload = {
      v: 1, n: c.name, o: c.owner, k: c.kind, src: c.source, m: c.mode, a: c.answers === 'choice' ? 'c' : 't', f: c.fields,
      s: c.snippetMs, sc: c.score, mx: c.max, g: c.grid.join(''), t: c.tracks.map(packTrack).filter(Boolean),
    };
    return toB64(await pipe(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('deflate-raw')));
  }

  async function decode(code) {
    const raw = JSON.parse(new TextDecoder().decode(await pipe(fromB64(code), new DecompressionStream('deflate-raw'))));
    if (raw?.v !== 1 || !Array.isArray(raw.t)) throw new Error('Lien de défi invalide.');
    const tracks = raw.t.slice(0, 200).map(unpackTrack).filter(Boolean);
    if (!tracks.length) throw new Error('Ce défi ne contient aucun titre.');
    const fields = Array.isArray(raw.f) ? FIELDS.filter((f) => raw.f.includes(f)) : [];
    const name = str(raw.n, 40) || 'Un pote';
    return {
      name,
      owner: str(raw.o, 40) || name,
      kind: KINDS.includes(raw.k) ? raw.k : 'top',
      source: str(raw.src, 80),
      mode: raw.m === 'sudden' ? 'sudden' : 'classic',
      answers: raw.a === 'c' ? 'choice' : 'type',
      fields: fields.length ? fields : ['artist', 'title'],
      snippetMs: int(raw.s, 0, 60000),
      score: int(raw.sc, 0, 100000),
      max: int(raw.mx, 0, 100000),
      grid: String(raw.g ?? '').replace(/[^012]/g, '').slice(0, 200).split('').map(Number),
      tracks,
    };
  }

  const squares = (grid) => grid.map((g) => SQUARES[g]).join('');

  return { encode, decode, squares };
})();

if (typeof module !== 'undefined') module.exports = Challenge;
