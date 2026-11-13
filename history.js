// Reads the listening history Spotify sends on request (privacy page), entirely in the browser.
const History = (() => {
  // Extended history ("Streaming_History_Audio_*.json", older "endsong_*.json") and the 1-year
  // account data ("StreamingHistory_music_*.json", older "StreamingHistory*.json").
  const FILE_RE = /(Streaming_History_Audio_[^/]*|StreamingHistory_music_\d+|StreamingHistory\d*|endsong_\d+)\.json$/i;
  const MIN_MS = 30000; // Spotify counts a stream from 30 seconds of listening
  const KEEP = 3000;

  const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const key = (artist, name) => `${artist}|${name}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function normalize(item) {
    if (!item || typeof item !== 'object') return null;
    if ('ts' in item) {
      const name = text(item.master_metadata_track_name);
      const artist = text(item.master_metadata_album_artist_name);
      if (!name || !artist) return null; // podcasts, audiobooks
      const uri = typeof item.spotify_track_uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(item.spotify_track_uri) ? item.spotify_track_uri : '';
      return { t: Date.parse(item.ts), ms: Number(item.ms_played) || 0, name, artist, album: text(item.master_metadata_album_album_name), uri };
    }
    if ('endTime' in item) {
      const name = text(item.trackName);
      const artist = text(item.artistName);
      if (!name || !artist) return null;
      return { t: Date.parse(String(item.endTime).replace(' ', 'T') + 'Z'), ms: Number(item.msPlayed) || 0, name, artist, album: '', uri: '' };
    }
    return null;
  }

  function aggregate(lists) {
    const map = new Map();
    let streams = 0, ms = 0, from = Infinity, to = 0;
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const e = normalize(raw);
        if (!e || !Number.isFinite(e.t)) continue;
        ms += e.ms;
        if (e.ms < MIN_MS) continue;
        streams++;
        from = Math.min(from, e.t);
        to = Math.max(to, e.t);
        const k = key(e.artist, e.name);
        let r = map.get(k);
        if (!r) map.set(k, (r = { uri: e.uri, name: e.name, artist: e.artist, album: e.album, plays: 0, ms: 0, first: e.t }));
        r.plays++;
        r.ms += e.ms;
        if (e.t < r.first) r.first = e.t;
        if (!r.album && e.album) r.album = e.album;
        if (!r.uri && e.uri) r.uri = e.uri;
      }
    }
    const all = [...map.values()].sort((a, b) => b.plays - a.plays);
    return {
      v: 1,
      streams,
      hours: Math.round(ms / 3.6e6),
      from: streams ? new Date(from).getFullYear() : null,
      to: streams ? new Date(to).getFullYear() : null,
      total: all.length,
      tracks: all.slice(0, KEEP).map((r) => ({
        u: r.uri, n: r.name, a: r.artist, al: r.album, p: r.plays, m: Math.round(r.ms / 60000), f: new Date(r.first).getFullYear(),
      })),
    };
  }

  return { FILE_RE, normalize, aggregate };
})();

if (typeof module !== 'undefined') module.exports = History;
