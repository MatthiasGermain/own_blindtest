const API = 'https://api.spotify.com/v1';
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = [
  'user-library-read', 'streaming', 'user-read-email', 'user-read-private',
  'user-modify-playback-state', 'user-read-playback-state',
  'user-top-read', 'playlist-read-private', 'playlist-read-collaborative',
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
  const isGet = !opts.method || opts.method === 'GET';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + await getToken(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000); continue; }
    if (res.status >= 500 && isGet && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { /* some Spotify errors are plain text */ }
    const plain = txt.trim().startsWith('<') ? '' : txt.slice(0, 200);
    const fallback = res.status >= 500 ? `Spotify ne répond pas (${res.status})` : `Spotify ${res.status}`;
    const msg = data?.error?.message || plain || fallback;
    if (res.status === 403 && /regist/i.test(msg)) {
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
  player?.disconnect();
  location.replace(REDIRECT_URI);
}

/* ---------- Sources de titres ---------- */

let tracks = [];
let loadSeq = 0;

// [label in the form, short label in results]; top tracks have no "added" date.
const ADDED_NAMES = {
  liked: ["Année où tu l'as liké", 'Liké en'],
  playlist: ["Année d'ajout à la playlist", 'Ajouté en'],
};

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

// Since Feb 2026, Spotify only returns the contents of playlists the user owns or collaborates on.
async function loadPlaylists() {
  let me = null;
  try { me = (await api('/me')).id; } catch { /* keep every playlist */ }
  const lists = await fetchAll('/me/playlists?limit=50', (p) => p);
  const usable = lists.filter((p) => !me || p.owner?.id === me || p.collaborative);
  const saved = store.get('playlist');
  $('#opt-playlist').replaceChildren(...usable.map((p) => el('option', {
    value: p.id,
    textContent: `${p.name} (${(p.items ?? p.tracks)?.total ?? '?'})`,
    selected: p.id === saved,
  })));
}

function updateSourceFields(source) {
  const names = ADDED_NAMES[source.split(':')[0]];
  const box = $('#opt-fields input[value="added"]');
  box.disabled = !names;
  box.closest('label').classList.toggle('off', !names);
  box.closest('label').title = names ? '' : "Spotify ne donne pas de date d'ajout pour cette source";
  $('#field-added-name').textContent = names ? names[0] : "Année d'ajout (indisponible ici)";
}

async function loadSource(force = false) {
  const seq = ++loadSeq;
  const source = $('#opt-source').value;
  const status = $('#source-status');
  store.set('source', source);
  status.classList.remove('error');
  status.textContent = 'Chargement…';
  $('#playlist-pick').classList.toggle('hidden', source !== 'playlist');
  updateSourceFields(source);
  tracks = [];
  updateStartButton();
  const progress = (n, total) => { if (seq === loadSeq) status.textContent = `Chargement… ${n} / ${total}`; };
  const step = async (what, fn) => {
    try { return await fn(); } catch (e) { throw Object.assign(new Error(`${what} : ${e.message}`), { notRegistered: e.notRegistered }); }
  };

  try {
    let list;
    if (source === 'liked') {
      list = !force && store.get('liked');
      if (!list?.length) {
        list = await step('titres likés', () => fetchAll('/me/tracks?limit=50', (it) => toTrack(it.track, it.added_at), progress));
        store.set('liked', list);
      }
    } else if (source.startsWith('top:')) {
      list = await step('plus écoutés', () => fetchAll(`/me/top/tracks?limit=50&time_range=${source.slice(4)}`, (t) => toTrack(t, null), progress));
    } else {
      if (force || !$('#opt-playlist').options.length) await step('liste de tes playlists', loadPlaylists);
      const id = $('#opt-playlist').value;
      if (!id) {
        if (seq === loadSeq) status.textContent = "Aucune playlist à toi (Spotify ne donne accès qu'aux playlists que tu as créées ou où tu collabores).";
        return;
      }
      store.set('playlist', id);
      const name = ($('#opt-playlist').selectedOptions[0]?.textContent || 'playlist').replace(/ \([^)]*\)$/, '');
      list = await step(`playlist « ${name} »`, () => fetchAll(`/playlists/${encodeURIComponent(id)}/items?limit=50`, (it) => toTrack(it.item ?? it.track, it.added_at), progress));
    }
    if (seq !== loadSeq) return;
    tracks = [...new Map(list.map((t) => [t.uri, t])).values()];
    const s = tracks.length > 1 ? 's' : '';
    status.textContent = tracks.length ? `${tracks.length} titre${s} prêt${s}.` : 'Aucun titre lisible ici.';
    $('#opt-count').max = tracks.length;
    updateStartButton();
  } catch (e) {
    if (seq !== loadSeq || e.notRegistered) return;
    status.textContent = `Erreur (${e.message}). Clique sur « Recharger » pour réessayer.`;
    status.classList.add('error');
  }
}

/* ---------- Champs à deviner ---------- */

const ALL_FIELDS = ['artist', 'title', 'album', 'year', 'added'];
const LABELS = { artist: 'Artiste', title: 'Titre', album: 'Album', year: 'Sortie', added: 'Ajouté en' };

function selectedFields() {
  return [...document.querySelectorAll('#opt-fields input')].filter((i) => i.checked && !i.disabled).map((i) => i.value);
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
  $('#btn-start').disabled = !(tracks.length && deviceId && selectedFields().length);
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
  const count = Math.max(1, Math.min(tracks.length, parseInt($('#opt-count').value, 10) || 10));
  const pool = shuffle(tracks);
  const names = ADDED_NAMES[$('#opt-source').value.split(':')[0]] || ["Année d'ajout", 'Ajouté en'];
  game = {
    fields: selectedFields(),
    addedNames: names,
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
  $('#label-added').textContent = game.addedNames[0];
  for (const d of document.querySelectorAll('#guess-form [data-field]')) {
    d.classList.toggle('hidden', !game.fields.includes(d.dataset.field));
  }
  $('#guess-form').classList.remove('hidden');
  $('#result').classList.add('hidden');
  $('#btn-skip').classList.remove('hidden');
  $('#guess-form [data-field]:not(.hidden) input').focus();
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

const label = (k) => (k === 'added' ? game.addedNames[1] : LABELS[k]);

function submitGuess(e) {
  e.preventDefault();
  const t = currentTrack();
  const guess = {
    artist: $('#g-artist').value, title: $('#g-title').value, album: $('#g-album').value,
    year: $('#g-year').value, added: $('#g-added').value,
  };
  const all = Scoring.round(guess, t);
  const pts = Object.fromEntries(game.fields.map((k) => [k, all[k]]));
  const total = Object.values(pts).reduce((a, b) => a + b, 0);
  game.results.push({ track: t, pts, total });

  const truth = {
    artist: t.artists.join(', '), title: t.name, album: t.album,
    year: t.releaseYear ?? '?', added: t.addedYear ?? '?',
  };
  $('#r-max').textContent = `sur ${game.fields.length * 10}`;
  $('#r-table').replaceChildren(...game.fields.map((k) => el('tr', {}, [
    el('td', { textContent: label(k) }),
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
  const max = game.results.length * game.fields.length * 10;
  $('#end-score').textContent = `${total} / ${max}`;
  $('#end-detail').textContent = game.fields
    .map((k) => `${label(k)} ${game.results.reduce((s, r) => s + r.pts[k], 0)}`)
    .join(' · ');
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
  $('#btn-logout-denied').onclick = logout;
  $('#btn-retry').onclick = () => { store.del('liked'); location.reload(); };
  $('#btn-reload').onclick = () => loadSource(true);
  $('#opt-source').value = store.get('source', 'liked');
  if (!$('#opt-source').value) $('#opt-source').value = 'liked';
  $('#opt-source').onchange = () => loadSource();
  $('#opt-playlist').onchange = () => loadSource();
  const savedFields = store.get('fields', ALL_FIELDS);
  const fieldBoxes = [...document.querySelectorAll('#opt-fields input')];
  for (const box of fieldBoxes) {
    box.checked = savedFields.includes(box.value);
    box.onchange = () => {
      store.set('fields', fieldBoxes.filter((b) => b.checked).map((b) => b.value));
      updateStartButton();
    };
  }
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
  if (store.get('token') && !store.get('token').scope) {
    store.del('token');
    $('#login-error').textContent = "Nouvelle version : reconnecte-toi pour autoriser l'accès à tes playlists et à tes plus écoutés.";
  }
  if (!store.get('token')) { show('screen-login'); return; }

  show('screen-setup');
  loadSource();
  initPlayer()
    .then(() => { $('#player-status').textContent = 'Lecteur prêt.'; updateStartButton(); })
    .catch((e) => { $('#player-status').textContent = e.message; $('#player-status').classList.add('error'); });
}

main();
