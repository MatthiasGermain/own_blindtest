// 30-second previews from Deezer's public API: no account, works on phones.
const Deezer = (() => {
  // The API sends no CORS headers, so it is called through its JSONP output.
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = `__dz${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const done = () => { clearTimeout(timer); delete window[cb]; script.remove(); };
      const timer = setTimeout(() => { done(); reject(new Error('Deezer ne répond pas')); }, 8000);
      window[cb] = (data) => { done(); resolve(data); };
      script.onerror = () => { done(); reject(new Error('Deezer injoignable')); };
      script.src = `${url}&output=jsonp&callback=${cb}`;
      document.head.append(script);
    });
  }

  const strip = (s) => s.replace(/"/g, '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();

  async function search(artist, title) {
    const strict = `artist:"${strip(artist)}" track:"${strip(title)}"`;
    let res = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(strict)}&limit=5`);
    if (!res?.data?.length) res = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(`${strip(artist)} ${strip(title)}`)}&limit=5`);
    const wanted = Scoring.norm(artist);
    return (res?.data || []).find((d) => d.preview && Scoring.similarity(Scoring.norm(d.artist?.name || ''), wanted) >= 0.6) || null;
  }

  // Fills preview, cover, album and release year on the track; resolves to false when Deezer has no match.
  function resolve(track) {
    if (!track) return Promise.resolve(false);
    track.resolving ??= (async () => {
      if (!track.preview) {
        // A Deezer track (a challenge link keeps only its id) is fetched as is; any other one is searched.
        const d = track.uri?.startsWith('dz:')
          ? await jsonp(`https://api.deezer.com/track/${track.uri.slice(3)}?`).then((r) => (r?.preview ? r : null))
          : await search(track.artists[0], track.name);
        if (!d) return false;
        if (track.releaseYear === undefined && d.release_date) track.releaseYear = parseInt(d.release_date, 10) || null;
        track.preview = d.preview;
        track.cover ||= d.album?.cover_xl || d.album?.cover_big || '';
        track.album ||= d.album?.title || '';
        track.artistId ??= d.artist?.id;
        track.dzId ??= String(d.id);
      }
      // Profile tracks come without a release date: it lives on the album.
      if (track.releaseYear === undefined && track.albumId) {
        const a = await jsonp(`https://api.deezer.com/album/${track.albumId}?`).catch(() => null);
        track.releaseYear = parseInt(a?.release_date, 10) || null;
      }
      return true;
    })().catch(() => { track.resolving = null; return false; });
    return track.resolving;
  }

  // The artist's discography, albums first: the hardest wrong answers for "which album?".
  const discographies = new Map();
  function albums(track) {
    const id = track?.artistId;
    if (!id) return Promise.resolve([]);
    if (!discographies.has(id)) {
      discographies.set(id, jsonp(`https://api.deezer.com/artist/${id}/albums?limit=50`)
        .then((res) => (res?.data || []).sort((a, b) => (b.record_type === 'album') - (a.record_type === 'album')).map((a) => a.title).filter(Boolean))
        .catch(() => { discographies.delete(id); return []; }));
    }
    return discographies.get(id);
  }

  // Preview links are signed and expire: fetch a fresh one when a stored link stops loading.
  async function refresh(track) {
    if (track.uri.startsWith('dz:')) {
      const d = await jsonp(`https://api.deezer.com/track/${track.uri.slice(3)}?`).catch(() => null);
      if (!d?.preview) return false;
      track.preview = d.preview;
      return true;
    }
    track.preview = '';
    track.resolving = null;
    return resolve(track);
  }

  /* ---------- Public profiles: no login, only the profile link ---------- */

  // "deezer.com/fr/profile/123456" or "123456". App share links (link.deezer.com) can't be followed from a page.
  function profileId(input) {
    const s = String(input || '').trim();
    return s.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?profile\/(\d{1,12})/i)?.[1] || s.match(/^\d{1,12}$/)?.[0] || null;
  }

  async function call(path) {
    const res = await jsonp(`https://api.deezer.com${path}${path.includes('?') ? '' : '?'}`);
    if (res?.error) throw Object.assign(new Error(res.error.message || 'erreur Deezer'), { deezer: res.error });
    return res;
  }

  async function all(path, max = 2000) {
    const out = [];
    for (let index = 0; out.length < max; index += 100) {
      const res = await call(`${path}?limit=100&index=${index}`);
      out.push(...(res.data || []));
      if (!res.data?.length || out.length >= (res.total ?? 0)) break;
    }
    return out.slice(0, max);
  }

  // Deezer's lists give only the main artist: the featured ones are in the title,
  // "Cuenta (feat. Meryl & Shay)" or "Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)".
  const FEAT = /[([][^)\]]*?\b(?:feat|ft|featuring)\b\.?\s+([^)\]]+)[)\]]/i;
  function artistsOf(d) {
    const out = [d.artist?.name || '?'];
    const featured = FEAT.exec(d.title || '')?.[1] || '';
    for (const name of featured.split(/\s*(?:,|&|\band\b|\bet\b)\s*/i)) {
      const n = name.trim();
      if (n && !out.some((a) => a.toLowerCase() === n.toLowerCase())) out.push(n);
    }
    return out;
  }

  const toTrack = (d) => (!d?.preview || d.readable === false ? null : {
    uri: `dz:${d.id}`,
    name: d.title_short || d.title,
    artists: artistsOf(d),
    artistId: d.artist?.id,
    album: d.album?.title || '',
    albumId: d.album?.id || null,
    cover: d.album?.cover_xl || d.album?.cover_big || '',
    preview: d.preview,
    addedYear: d.time_add ? new Date(d.time_add * 1000).getFullYear() : null,
    duration: 30000,
  });
  const tracksOf = (list) => [...new Map(list.map(toTrack).filter(Boolean).map((t) => [t.uri, t])).values()];

  const profile = {
    id: profileId,
    async user(id) {
      const u = await call(`/user/${id}`);
      return { id: String(u.id), name: u.name || 'Profil Deezer', picture: u.picture_medium || '' };
    },
    // Profiles by name, for joining a room without hunting for one's profile link.
    async search(q) {
      const res = await call(`/search/user?q=${encodeURIComponent(q)}&limit=8`);
      return (res.data || []).map((u) => ({ id: String(u.id), name: u.name || '?', picture: u.picture_medium || '' }));
    },
    async top(id) { return tracksOf(await all(`/user/${id}/charts/tracks`, 100)); },
    async playlists(id) {
      return (await all(`/user/${id}/playlists`, 500)).map((p) => ({ id: String(p.id), title: p.title, total: p.nb_tracks, loved: !!p.is_loved_track, picture: p.picture_medium || '' }));
    },
    async playlist(id, max) { return tracksOf(await all(`/playlist/${id}/tracks`, max)); },
  };

  // Same surface as the Spotify SDK player the game already drives.
  const audio = new Audio();
  audio.preload = 'auto';
  let listener = () => {};
  audio.addEventListener('playing', () => listener(false));
  audio.addEventListener('pause', () => listener(true));
  audio.addEventListener('ended', () => listener(true));
  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  const player = {
    onState(fn) { listener = fn; },
    // Called inside a click so iOS lets later, script-started playback through.
    activateElement() {
      if (audio.src) return;
      audio.src = SILENCE;
      audio.play().catch(() => {});
    },
    // Loads the snippet and goes to startSec, without playing yet: start() plays it.
    async load(src, startSec) {
      audio.src = src;
      await new Promise((ok, fail) => {
        audio.addEventListener('loadedmetadata', ok, { once: true });
        audio.addEventListener('error', () => fail(new Error("l'extrait ne se charge pas")), { once: true });
      });
      audio.currentTime = Math.min(startSec, Math.max(0, audio.duration - 5));
    },
    start() { return audio.play(); },
    async play(src, startSec) {
      await player.load(src, startSec);
      await audio.play();
    },
    pause() { audio.pause(); },
    resume() { audio.play().catch(() => {}); },
    togglePlay() { audio.paused ? player.resume() : audio.pause(); },
    setVolume(v) { audio.volume = v; },
  };

  return { resolve, refresh, albums, player, profile };
})();
