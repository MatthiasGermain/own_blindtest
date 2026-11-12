const API = 'https://api.spotify.com/v1';
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = [
  'user-library-read', 'streaming', 'user-read-email', 'user-read-private',
  'user-modify-playback-state', 'user-read-playback-state',
].join(' ');

const $ = (s) => document.querySelector(s);

const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.classList.toggle('hidden', s.id !== id);
}

function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) n.append(c);
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const clientId = SPOTIFY_CLIENT_ID || $('#client-id').value.trim();
  if (!clientId) { $('#login-error').textContent = 'Colle ton Client ID.'; return; }
  store.set('clientId', clientId);
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
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Erreur token');
  store.set('token', {
    access: data.access_token,
    refresh: data.refresh_token || store.get('token')?.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
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

async function api(path, opts = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + await getToken(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000); continue; }
    const txt = await res.text();
    const data = txt ? JSON.parse(txt) : null;
    const msg = data?.error?.message || `Spotify ${res.status}`;
    if (res.status === 403 && /regist/i.test(msg)) {
      throw new Error("ton compte Spotify n'est pas autorisé sur cette app. Demande à l'organisateur de t'ajouter.");
    }
    if (!res.ok) throw new Error(msg);
    return data;
  }
  throw new Error('Trop de requêtes, réessaie dans un moment.');
}

function logout() {
  store.del('token');
  store.del('liked');
  player?.disconnect();
  location.replace(REDIRECT_URI);
}

/* ---------- Titres likés ---------- */

let liked = [];

async function loadLiked(force = false) {
  const status = $('#liked-status');
  const cached = !force && store.get('liked');
  if (cached?.length) {
    liked = cached;
  } else {
    const tracks = [];
    let url = '/me/tracks?limit=50';
    while (url) {
      const data = await api(url);
      for (const { track: t, added_at } of data.items) {
        if (!t || t.is_local || !t.uri) continue;
        tracks.push({
          uri: t.uri,
          name: t.name,
          artists: t.artists.map((a) => a.name),
          album: t.album.name,
          releaseYear: parseInt(t.album.release_date, 10) || null,
          addedYear: new Date(added_at).getFullYear(),
          cover: t.album.images?.[0]?.url || '',
          duration: t.duration_ms,
        });
      }
      status.textContent = `Chargement des titres likés… ${tracks.length} / ${data.total}`;
      url = data.next;
    }
    liked = tracks;
    store.set('liked', liked);
  }
  status.textContent = `${liked.length} titres likés prêts.`;
  $('#opt-count').max = liked.length;
  updateStartButton();
}

/* ---------- Lecteur (Web Playback SDK, Premium requis) ---------- */

let player = null;
let deviceId = null;
let isPaused = true;

function initPlayer() {
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new Spotify.Player({ name: 'Blindtest Likés', getOAuthToken: (cb) => getToken().then(cb), volume: store.get('volume', 70) / 100 });
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
        isPaused = !s || s.paused;
        $('#eq').classList.toggle('paused', isPaused);
        $('#btn-pause').textContent = isPaused ? 'Lecture' : 'Pause';
        const cur = s?.track_window?.current_track;
        if (!isPaused && pending && cur && (cur.uri === pending.uri || cur.linked_from?.uri === pending.uri)) {
          $('#round-loading').classList.add('hidden');
          clearTimeout(snippetTimer);
          if (pending.snippetMs) snippetTimer = setTimeout(() => player.pause(), pending.snippetMs);
          pending = null;
        }
      });
      player.connect();
    };
    document.body.append(el('script', { src: 'https://sdk.scdn.co/spotify-player.js' }));
  });
}

let snippetTimer = null;
let pending = null;

// The snippet countdown starts once the SDK reports the track playing, not at request time.
async function playFrom(uri, positionMs, snippetMs) {
  clearTimeout(snippetTimer);
  pending = { uri, snippetMs };
  $('#round-loading').classList.remove('hidden');
  if (snippetMs) snippetTimer = setTimeout(() => player.pause(), snippetMs + 8000);
  try {
    await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
    });
  } catch (e) {
    pending = null;
    $('#round-loading').classList.add('hidden');
    throw e;
  }
}

function setVolume(v) {
  store.set('volume', v);
  player?.setVolume(v / 100);
}

/* ---------- Partie ---------- */

let game = null;

function updateStartButton() {
  $('#btn-start').disabled = !(liked.length && deviceId);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame() {
  player.activateElement();
  const count = Math.max(1, Math.min(liked.length, parseInt($('#opt-count').value, 10) || 10));
  const pool = shuffle(liked);
  game = {
    tracks: pool.slice(0, count),
    pool: pool.slice(count),
    index: 0,
    results: [],
    snippetMs: parseInt($('#opt-snippet').value, 10) * 1000,
    randomStart: $('#opt-start').value === 'random',
  };
  show('screen-round');
  startRound();
}

function currentTrack() { return game.tracks[game.index]; }

async function startRound() {
  const t = currentTrack();
  t.startMs = game.randomStart ? Math.floor(t.duration * (0.2 + Math.random() * 0.4)) : 0;
  const total = game.results.reduce((s, r) => s + r.total, 0);
  $('#round-num').textContent = `${game.index + 1} / ${game.tracks.length}`;
  $('#round-score').textContent = total;
  $('#round-error').textContent = '';
  $('#guess-form').reset();
  $('#label-artist').textContent = t.artists.length > 1
    ? `Artistes (${t.artists.length} attendus, séparés par des virgules)`
    : 'Artiste';
  $('#guess-form').classList.remove('hidden');
  $('#result').classList.add('hidden');
  $('#btn-skip').classList.remove('hidden');
  $('#g-artist').focus();
  await replay();
}

async function replay() {
  const t = currentTrack();
  $('#round-error').textContent = '';
  try {
    await playFrom(t.uri, t.startMs, $('#result').classList.contains('hidden') ? game.snippetMs : 0);
  } catch (e) {
    $('#round-error').textContent = `Lecture impossible (${e.message}). Clique sur « Passer ».`;
  }
}

function skip() {
  if (game.pool.length) {
    game.tracks[game.index] = game.pool.shift();
    startRound();
  } else {
    game.tracks.splice(game.index, 1);
    game.index >= game.tracks.length ? endGame() : startRound();
  }
}

const LABELS = { artist: 'Artiste', title: 'Titre', album: 'Album', year: 'Sortie', added: 'Liké en' };

function submitGuess(e) {
  e.preventDefault();
  const t = currentTrack();
  const guess = {
    artist: $('#g-artist').value, title: $('#g-title').value, album: $('#g-album').value,
    year: $('#g-year').value, added: $('#g-added').value,
  };
  const pts = Scoring.round(guess, t);
  const total = Object.values(pts).reduce((a, b) => a + b, 0);
  game.results.push({ track: t, pts, total });

  const truth = {
    artist: t.artists.join(', '), title: t.name, album: t.album,
    year: t.releaseYear ?? '?', added: t.addedYear,
  };
  $('#r-table').replaceChildren(...Object.keys(LABELS).map((k) => el('tr', {}, [
    el('td', { textContent: LABELS[k] }),
    el('td', {}, [String(truth[k]), el('div', { className: 'guess', textContent: guess[k] ? `ta réponse : ${guess[k]}` : 'pas de réponse' })]),
    el('td', { className: 'pts ' + (pts[k] === 10 ? 'ok' : pts[k] > 0 ? 'mid' : 'ko'), textContent: `+${pts[k]}` }),
  ])));
  $('#r-cover').src = t.cover;
  $('#r-points').textContent = `+${total}`;
  $('#round-score').textContent = game.results.reduce((s, r) => s + r.total, 0);
  $('#guess-form').classList.add('hidden');
  $('#btn-skip').classList.add('hidden');
  $('#result').classList.remove('hidden');
  $('#btn-next').textContent = game.index + 1 < game.tracks.length ? 'Suivant' : 'Voir le score';
  $('#btn-next').focus();

  clearTimeout(snippetTimer);
  if (pending) pending.snippetMs = 0;
  if (isPaused) player.resume();
}

function next() {
  game.index++;
  game.index < game.tracks.length ? startRound() : endGame();
}

function endGame() {
  clearTimeout(snippetTimer);
  pending = null;
  $('#round-loading').classList.add('hidden');
  player.pause();
  const total = game.results.reduce((s, r) => s + r.total, 0);
  const max = game.results.length * 50;
  $('#end-score').textContent = `${total} / ${max}`;
  const sums = Object.fromEntries(Object.keys(LABELS).map((k) => [k, game.results.reduce((s, r) => s + r.pts[k], 0)]));
  $('#end-detail').textContent = Object.keys(LABELS).map((k) => `${LABELS[k]} ${sums[k]}`).join(' · ');
  $('#end-recap').replaceChildren(...game.results.map((r) => el('li', {}, [
    el('span', { textContent: `${r.track.artists[0]} — ${r.track.name}` }),
    el('strong', { textContent: `${r.total}` }),
  ])));
  show('screen-end');
}

/* ---------- Démarrage ---------- */

async function main() {
  $('#redirect-uri').textContent = REDIRECT_URI;
  $('#client-id').value = store.get('clientId', '');
  if (SPOTIFY_CLIENT_ID) {
    $('#login-setup').classList.add('hidden');
    $('#login-hint').classList.remove('hidden');
  }
  $('#btn-login').onclick = login;
  $('#btn-logout').onclick = logout;
  $('#btn-reload').onclick = () => loadLiked(true).catch((e) => { $('#liked-status').textContent = e.message; });
  $('#btn-start').onclick = startGame;
  $('#btn-replay').onclick = replay;
  $('#btn-pause').onclick = () => player.togglePlay();
  $('#btn-skip').onclick = skip;
  $('#btn-next').onclick = next;
  $('#btn-again').onclick = () => show('screen-setup');
  $('#guess-form').onsubmit = submitGuess;
  $('#volume').value = store.get('volume', 70);
  $('#volume').oninput = (e) => setVolume(Number(e.target.value));

  try {
    await handleCallback();
  } catch (e) {
    $('#login-error').textContent = e.message;
  }
  if (!store.get('token')) { show('screen-login'); return; }

  show('screen-setup');
  loadLiked().catch((e) => { $('#liked-status').textContent = 'Erreur : ' + e.message; $('#liked-status').classList.add('error'); });
  initPlayer()
    .then(() => { $('#player-status').textContent = 'Lecteur prêt.'; updateStartButton(); })
    .catch((e) => { $('#player-status').textContent = e.message; $('#player-status').classList.add('error'); });
}

main();
