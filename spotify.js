// Spotify: sign-in without a backend (OAuth PKCE), its Web API with the rate-limit backoff, and the
// Web Playback SDK player (Premium). The game logic that uses them is in app.js.
const API = 'https://api.spotify.com/v1';
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = [
  'user-library-read', 'streaming', 'user-read-email', 'user-read-private',
  'user-modify-playback-state', 'user-read-playback-state',
  'user-top-read', 'playlist-read-private', 'playlist-read-collaborative',
].join(' ');

/* ---------- Auth (OAuth PKCE, sans backend) ---------- */

function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (b) => chars[b % chars.length]).join('');
}

async function sha256Base64Url(str) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  // Already signed in (back from "Changer de source"): no new round trip to Spotify. Not from a room, which wants its lists.
  if (store.get('token') && !store.get('salleSpotify')) {
    store.set('source', 'liked');
    $('#opt-source').value = 'liked';
    enterSetup();
    return;
  }
  const clientId = SPOTIFY_CLIENT_ID || $('#client-id').value.trim();
  if (!clientId) { $('#login-error').textContent = 'Colle ton Client ID.'; return; }
  store.set('clientId', clientId);
  Stats.track('spotify-connexion');
  const verifier = randomString(64);
  const state = randomString(16);
  store.set('pkce', { verifier, state });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
    state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: store.get('clientId'), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Connexion Spotify refusée (${res.status})`);
  store.set('token', {
    access: data.access_token,
    refresh: data.refresh_token || store.get('token')?.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
    scope: data.scope ?? store.get('token')?.scope ?? SCOPES,
  });
}

async function handleCallback() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  if (p.has('error')) throw new Error('Connexion refusée : ' + p.get('error'));
  const pkce = store.get('pkce');
  store.del('pkce');
  if (!pkce || p.get('state') !== pkce.state) throw new Error('Réponse de connexion invalide, réessaie.');
  await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: REDIRECT_URI, code_verifier: pkce.verifier });
  // Just signed in to Spotify: play its songs, not the source used before (a Deezer profile, say).
  // Not when the login came from a room: a phone can't play Spotify itself, the solo game keeps its source.
  if (!store.get('salleSpotify')) {
    store.set('source', 'liked');
    $('#opt-source').value = 'liked';
  }
}

let refreshing = null;
async function getToken() {
  const t = store.get('token');
  if (!t) throw new Error('Non connecté');
  if (Date.now() < t.expires) return t.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }).finally(() => { refreshing = null; });
  await refreshing;
  return store.get('token').access;
}

// Spotify's "too many requests". Its Retry-After header is not readable from a web page (Spotify does not
// expose it), so the length of the block is unknown: each new refusal doubles the gap before the next try
// (30 s, 2 min, 10 min, 30 min, 1 h), and no call goes out meanwhile, since calls during a block prolong it.
const PAUSES = [30, 120, 600, 1800, 3600];

function spotifyPause() {
  const until = store.get('spotifyPause', 0);
  if (Date.now() >= until) return null;
  const s = Math.ceil((until - Date.now()) / 1000);
  const wait = s < 60 ? `${s} s` : s < 3600 ? `${Math.ceil(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.ceil((s % 3600) / 60)).padStart(2, '0')}`;
  return Object.assign(new Error(`Spotify bloque les appels de l'app, pour une durée qu'il ne précise pas. Prochain essai possible dans ${wait}`), { rateLimited: true });
}

function spotifyRefused(retryAfter) {
  const n = store.get('spotifyRefusals', 0);
  Stats.track('spotify-bloque', { fois: String(n + 1) });
  store.set('spotifyRefusals', n + 1);
  store.set('spotifyPause', Date.now() + Math.max(retryAfter, PAUSES[Math.min(n, PAUSES.length - 1)]) * 1000);
}

async function api(path, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  for (let attempt = 0; attempt < 5; attempt++) {
    const paused = spotifyPause();
    if (paused) throw paused;
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + await getToken(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 429) {
      // Read when Spotify allows it (it may some day); otherwise one short retry, then the backoff.
      const wait = Number(res.headers.get('Retry-After')) || 0;
      if (attempt === 0 && wait <= 10) { await sleep((wait || 3) * 1000); continue; }
      spotifyRefused(wait);
      throw spotifyPause();
    }
    store.del('spotifyRefusals');
    if (res.status >= 500 && isGet && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { /* some Spotify errors are plain text */ }
    const plain = txt.trim().startsWith('<') ? '' : txt.slice(0, 200);
    const fallback = res.status >= 500 ? `Spotify ne répond pas (${res.status})` : `Spotify ${res.status}`;
    const msg = data?.error?.message || plain || fallback;
    if (res.status === 403 && /regist/i.test(msg)) {
      if ($('#screen-denied').classList.contains('hidden')) Stats.track('spotify-refuse');
      show('screen-denied');
      throw Object.assign(new Error("ton compte Spotify n'est pas autorisé sur cette app."), { notRegistered: true });
    }
    if (!res.ok) throw new Error(msg);
    return data;
  }
  throw new Error('Trop de requêtes, réessaie dans un moment.');
}

function logout() {
  store.del('token');
  store.del('liked');
  store.del('myName');
  player?.disconnect();
  location.replace(REDIRECT_URI);
}

function toTrack(t, addedAt) {
  if (!t || t.is_local || !t.uri || (t.type && t.type !== 'track')) return null;
  return {
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album.name,
    releaseYear: parseInt(t.album.release_date, 10) || null,
    addedYear: addedAt ? new Date(addedAt).getFullYear() : null,
    cover: t.album.images?.[0]?.url || '',
    duration: t.duration_ms,
  };
}

async function fetchAll(url, pick, onProgress) {
  const out = [];
  while (url) {
    const data = await api(url);
    for (const it of data.items) {
      const x = it && pick(it);
      if (x) out.push(x);
    }
    onProgress?.(out.length, data.total);
    url = data.next;
  }
  return out;
}

/* ---------- Lecteur (Web Playback SDK, Premium requis) ---------- */

let player = null;
let deviceId = null;
let isPaused = true;

function initPlayer() {
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new Spotify.Player({ name: 'Blindtest', getOAuthToken: (cb) => getToken().then(cb), volume: store.get('volume', 70) / 100 });
      player.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        // Making the browser the active device up front avoids a slow first play.
        api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) })
          .catch(() => {})
          .finally(resolve);
      });
      player.addListener('not_ready', () => { deviceId = null; });
      player.addListener('initialization_error', ({ message }) => reject(new Error('Navigateur non compatible : ' + message)));
      player.addListener('authentication_error', ({ message }) => reject(new Error('Authentification : ' + message)));
      player.addListener('account_error', () => reject(new Error('La lecture nécessite un compte Spotify Premium.')));
      player.addListener('player_state_changed', (s) => {
        const cur = s?.track_window?.current_track;
        onPlayback(!s || s.paused, [cur?.uri, cur?.linked_from?.uri]);
      });
      player.connect();
    };
    document.body.append(el('script', { src: 'https://sdk.scdn.co/spotify-player.js' }));
  });
}
