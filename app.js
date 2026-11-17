// The app: screens, music sources, the solo blindtest, sharing and challenges, the home screen.
// Helpers are in util.js, the Spotify account and player in spotify.js.
function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.classList.toggle('hidden', s.id !== id);
  syncBack();
}

const currentScreen = () => [...document.querySelectorAll('main > section')].find((s) => !s.classList.contains('hidden'))?.id;

/* ---------- Phone back button ---------- */

// The screens are not pages: one history entry stands in front of the home screen while the player is
// anywhere else, and "back" acts inside the game (leave the panel, the settings, the game) instead of
// closing the site.
let guarded = false;
let skipPop = false;
let syncing = false;
const atRoot = () => currentScreen() === 'screen-login' && !$('#home-pick').classList.contains('hidden');

// Checked once the current screen change is complete (goHome opens a panel, then shows the screen).
function syncBack() {
  if (syncing) return;
  syncing = true;
  queueMicrotask(() => {
    syncing = false;
    if (!guarded && !atRoot()) {
      history.pushState({ blindtest: true }, '');
      guarded = true;
    } else if (guarded && atRoot()) {
      guarded = false;
      skipPop = true;
      history.back();
    }
  });
}

async function onBack() {
  if (skipPop) { skipPop = false; return; }
  guarded = false;
  switch (currentScreen()) {
    case 'screen-round': await quitGame(); break;
    case 'screen-cover': await Covers.back(); break;
    case 'screen-room': await Salle.back(); break;
    case 'screen-end': backToSetup(); break;
    case 'screen-setup': case 'screen-denied': goHome(); break;
    case 'screen-login': openPanel(null); break;
    default: break;
  }
  syncBack();
}

/* ---------- In-app confirmation ---------- */

// A yes/no question in the game's own style (the browser's confirm() looks like a system alert).
let askDone = null;
function ask(text, yes = 'Oui') {
  const d = $('#ask');
  askDone?.(false);
  $('#ask-text').textContent = text;
  $('#ask-yes').textContent = yes;
  return new Promise((resolve) => {
    askDone = (v) => { askDone = null; if (d.open) d.close(); resolve(v); };
    if (!d.open) d.showModal();
    $('#ask-no').focus();
  });
}

// The Deezer profile is only a public link: forgetting it is all a "log out" needs.
function forgetDeezer() {
  store.del('deezerUser');
  store.del('dzPlaylist');
  deezerPlaylists = null;
  $('#opt-playlist').dataset.from = '';
  $('#deezer-profile').value = '';
  if (store.get('token') || store.get('history')) enterSetup();
  else goHome();
}

/* ---------- Sources de titres ---------- */

let tracks = [];
let loadSeq = 0;

// [label in the form, short label in results]; top tracks have no "added" date.
const ADDED_NAMES = {
  liked: ["Année où tu l'as liké", 'Liké en'],
  playlist: ["Année d'ajout à la playlist", 'Ajouté en'],
  dzliked: ["Année où tu l'as mis en coup de cœur", 'Coup de cœur en'],
  dzplaylist: ["Année d'ajout à la playlist", 'Ajouté en'],
};

// The imported history and Deezer profiles play Deezer previews; the rest needs the Spotify player.
const onDeezer = (kind) => kind === 'history' || kind.startsWith('dz');

// Since Feb 2026, Spotify only returns the contents of playlists the user owns or collaborates on.
async function loadPlaylists() {
  let me = null;
  try { me = (await api('/me')).id; } catch { /* keep every playlist */ }
  const lists = await fetchAll('/me/playlists?limit=50', (p) => p);
  const usable = lists.filter((p) => !me || p.owner?.id === me || p.collaborative);
  const saved = store.get('playlist');
  $('#opt-playlist').dataset.from = 'spotify';
  $('#opt-playlist').replaceChildren(...usable.map((p) => el('option', {
    value: p.id,
    textContent: `${p.name} (${(p.items ?? p.tracks)?.total ?? '?'})`,
    selected: p.id === saved,
  })));
}

function updateSourceFields(source) {
  const kind = source.split(':')[0];
  for (const chip of document.querySelectorAll('#opt-fields [data-sources]')) {
    chip.classList.toggle('hidden', !chip.dataset.sources.split(' ').includes(kind));
  }
  $('#field-added-name').textContent = (ADDED_NAMES[kind] || ["Année d'ajout"])[0];
  // A Deezer preview lasts 30 s: « Tout le morceau » would be the same as 30 s.
  const whole = $('#opt-snippet option[value="0"]');
  whole.hidden = whole.disabled = onDeezer(kind);
  if (whole.disabled && $('#opt-snippet').value === '0') $('#opt-snippet').value = '30';
}

// The most played tracks make the game: they are the ones you should recognise.
function historyTracks() {
  const h = store.get('history');
  if (!h?.tracks) return [];
  return h.tracks.filter((t) => t.p >= 3).slice(0, 400).map((t) => ({
    uri: t.u || `hist:${t.a}|${t.n}`,
    name: t.n,
    artists: [t.a],
    album: t.al || '',
    firstYear: t.f,
    cover: '',
    duration: 30000,
  }));
}

/* ---------- Profil Deezer public ---------- */

let deezerPlaylists = null;

async function deezerPlaylistList(force) {
  if (force || !deezerPlaylists) deezerPlaylists = await Deezer.profile.playlists(store.get('deezerUser').id);
  return deezerPlaylists;
}

// Resolves to the tracks, or null when the profile has no public playlist to pick.
async function loadDeezerSource(source, force) {
  const user = store.get('deezerUser');
  if (source === 'dztop') return Deezer.profile.top(user.id);
  const lists = await deezerPlaylistList(force);
  if (source === 'dzliked') {
    const loved = lists.find((p) => p.loved);
    return loved ? Deezer.profile.playlist(loved.id) : [];
  }
  const pick = $('#opt-playlist');
  if (force) pick.dataset.from = '';
  const usable = lists.filter((p) => !p.loved && p.total > 0);
  if (pick.dataset.from !== 'deezer') {
    const saved = store.get('dzPlaylist');
    pick.dataset.from = 'deezer';
    pick.replaceChildren(...usable.map((p) => el('option', { value: p.id, textContent: `${p.title} (${p.total})`, selected: p.id === saved })));
  }
  if (!pick.value) return null;
  store.set('dzPlaylist', pick.value);
  return Deezer.profile.playlist(pick.value);
}

async function connectDeezer(e) {
  e.preventDefault();
  const status = $('#deezer-status');
  status.classList.remove('error');
  const id = Deezer.profile.id($('#deezer-profile').value);
  if (!id) {
    status.textContent = /link\.deezer|deezer\.page\.link/i.test($('#deezer-profile').value)
      ? "Ce lien de partage ne s'ouvre pas ici : ouvre-le dans ton navigateur et copie l'adresse finale, avec /profile/ et des chiffres."
      : 'Il faut le lien de ton profil, avec /profile/ suivi de chiffres.';
    status.classList.add('error');
    return;
  }
  status.textContent = 'Recherche du profil…';
  try {
    const user = await Deezer.profile.user(id);
    store.set('deezerUser', user);
    Stats.track('deezer-connecte');
    deezerPlaylists = null;
    $('#opt-playlist').dataset.from = '';
    store.set('source', 'dztop');
    status.textContent = '';
    enterSetup();
  } catch (err) {
    status.textContent = err.deezer ? 'Profil introuvable : vérifie le lien.' : `Deezer ne répond pas (${err.message}).`;
    status.classList.add('error');
  }
}

async function loadSource(force = false) {
  const seq = ++loadSeq;
  const source = $('#opt-source').value;
  const status = $('#source-status');
  store.set('source', source);
  status.classList.remove('error');
  status.textContent = 'Chargement…';
  $('#playlist-pick').classList.toggle('hidden', source !== 'playlist' && source !== 'dzplaylist');
  updateSourceFields(source);
  tracks = [];
  updateStartButton();
  const progress = (n, total) => { if (seq === loadSeq) status.textContent = `Chargement… ${n} / ${total}`; };
  const step = async (what, fn) => {
    try { return await fn(); } catch (e) { throw Object.assign(new Error(`${what} : ${e.message}`), { notRegistered: e.notRegistered }); }
  };

  try {
    let list;
    if (source === 'history') {
      list = historyTracks();
      const h = store.get('history');
      if (seq !== loadSeq) return;
      tracks = list;
      status.textContent = list.length
        ? `${list.length} de tes titres les plus écoutés, sur ${h.streams.toLocaleString('fr-FR')} écoutes (${h.from}–${h.to}).`
        : "Pas assez d'écoutes dans ton historique (il faut des titres écoutés au moins 3 fois).";
      $('#opt-count').max = list.length;
      updateStartButton();
      return;
    }
    if (source.startsWith('dz')) {
      list = await loadDeezerSource(source, force);
      if (!list) { if (seq === loadSeq) status.textContent = 'Aucune playlist publique sur ce profil.'; return; }
      if (!list.length) throw new Error("Deezer ne montre aucun titre. Si ton profil est privé, rends-le public dans Paramètres → Confidentialité");
    } else if (source === 'liked') {
      list = !force && store.get('liked');
      if (!list?.length) {
        list = await step('titres likés', () => fetchAll('/me/tracks?limit=50', (it) => toTrack(it.track, it.added_at), progress));
        store.set('liked', list);
      }
    } else if (source.startsWith('top:')) {
      list = await step('plus écoutés', () => fetchAll(`/me/top/tracks?limit=50&time_range=${source.slice(4)}`, (t) => toTrack(t, null), progress));
    } else {
      if (force || !$('#opt-playlist').options.length || $('#opt-playlist').dataset.from !== 'spotify') await step('liste de tes playlists', loadPlaylists);
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
    Stats.track('erreur-source', { source: source.split(':')[0] });
    status.textContent = `Erreur (${e.message}). Clique sur « Recharger » pour réessayer.`;
    status.classList.add('error');
  }
}

/* ---------- Champs à deviner ---------- */

const DEFAULT_FIELDS = ['artist', 'title'];
const LABELS = { artist: 'Artiste', title: 'Titre', album: 'Album', year: 'Sortie', added: 'Ajouté en', discovered: 'Découvert en' };

/* ---------- Réponses à choisir ---------- */

const TEXT_FIELDS = ['artist', 'title', 'album'];
const YEAR_PROPS = { year: 'releaseYear', added: 'addedYear', discovered: 'firstYear' };
const choiceMode = () => game?.answers === 'choice';
const sameText = (a, b) => Scoring.norm(a) === Scoring.norm(b);

function answerText(field, t) {
  if (field === 'artist') return t.artists.join(', ');
  const v = field === 'title' ? t.name : t.album;
  return Scoring.clean(v) || v || '';
}

// Wrong answers come from the player's own music, and from the same artist first: that is what keeps it hard.
function buildOptions(field, t) {
  const right = answerText(field, t);
  if (!right) return null;
  const byArtist = (x) => x !== t && x.artists.some((a) => t.artists.some((b) => sameText(a, b)));
  const others = game.library.filter((x) => x !== t && !byArtist(x));
  const sameArtist = shuffle(game.library.filter(byArtist)).map((x) => answerText(field, x));
  // Albums the player has not met yet are padded with the artist's discography (an imported history knows no album).
  const discography = field === 'album' ? shuffle((t.discography || []).map((a) => Scoring.clean(a))) : [];
  // Several artists to find: the wrong answers list several too, keeping one of the real ones,
  // so the right answer is not simply the only one with a comma.
  const several = (x, i) => (x.artists.length > 1 ? x.artists.join(', ')
    : (i % 2 ? [t.artists[0], x.artists[0], ...t.artists.slice(2)] : [x.artists[0], ...t.artists.slice(1)]).join(', '));
  const elsewhere = shuffle(others).map((x) => answerText(field, x));
  // When the artist is asked too, four titles (or albums) of one artist would give it away: the wrong ones
  // then come from other artists, the artist's own only when there are too few of them.
  const artistAsked = game.fields.includes('artist');
  const pool = field === 'artist'
    ? shuffle(others).map((x, i) => (t.artists.length > 1 ? several(x, i) : x.artists[0]))
    : artistAsked ? [...elsewhere, ...sameArtist, ...discography] : [...sameArtist, ...discography, ...elsewhere];
  const seen = new Set([Scoring.norm(right)]);
  const wrong = [];
  for (const c of pool) {
    if (wrong.length === 3) break;
    const k = Scoring.norm(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    wrong.push(c);
  }
  return shuffle([right, ...wrong]);
}

function nextOpenField(from) {
  const open = [...document.querySelectorAll('#guess-form [data-field]:not(.hidden)')]
    .filter((d) => TEXT_FIELDS.includes(d.dataset.field) && !d.querySelector('input.typed').value);
  return open.find((d) => d.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING) || open[0];
}

function pick(field, value, container) {
  $(`#g-${field}`).value = value;
  for (const b of container.children) b.setAttribute('aria-pressed', String(b.textContent === value));
  const next = nextOpenField(container);
  const firstYear = document.querySelector('#guess-form [data-field]:not(.hidden) .picker');
  // With only picks to make, the last tap validates; with years to set, go to the first one.
  if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (!firstYear) $('#guess-form').requestSubmit();
  else firstYear.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderChoices(t) {
  t.options ??= {};
  for (const field of TEXT_FIELDS) {
    if (!game.fields.includes(field)) continue;
    // Rebuilt while incomplete: the album and the discography arrive once Deezer has answered.
    if (!(t.options[field]?.length >= 4)) t.options[field] = buildOptions(field, t);
    const box = document.querySelector(`.choices[data-for="${field}"]`);
    const chosen = $(`#g-${field}`).value;
    box.replaceChildren(...(t.options[field] || []).map((o) => el('button', {
      type: 'button', textContent: o, onclick: () => pick(field, o, box),
    }, [])));
    for (const b of box.children) b.setAttribute('aria-pressed', String(!!chosen && b.textContent === chosen));
    if (!t.options[field]) box.append(el('p', { className: 'status', textContent: 'Propositions en chargement…' }));
  }
}

// Years are picked on a slider, still scored by how close they are. Nothing counts until it is touched.
function resetPickers() {
  const now = new Date().getFullYear();
  for (const [field, prop] of Object.entries(YEAR_PROPS)) {
    const p = document.querySelector(`.picker[data-for="${field}"]`);
    const vals = game.library.map((x) => x[prop]).filter(Boolean).sort((a, b) => a - b);
    const range = p.querySelector('input');
    range.min = Math.min(vals[0] ?? 1970, now - 30) - 2;
    range.max = Math.min(now, (vals.at(-1) ?? now) + 2);
    range.value = vals[Math.floor(vals.length / 2)] ?? now - 10;
    p.querySelector('output').textContent = '?';
    $(`#g-${field}`).value = '';
  }
}

function setYear(field, value) {
  const p = document.querySelector(`.picker[data-for="${field}"]`);
  const range = p.querySelector('input');
  range.value = value;
  $(`#g-${field}`).value = range.value;
  p.querySelector('output').textContent = range.value;
}

function setupChoiceUi() {
  for (const field of TEXT_FIELDS) {
    const box = el('div', { className: 'choices' });
    box.dataset.for = field;
    $(`#g-${field}`).after(box);
  }
  for (const field of Object.keys(YEAR_PROPS)) {
    const range = el('input', { type: 'range', step: 1, ariaLabel: 'Année' });
    // The first tap shows the starting year; the next ones move it.
    const step = (d) => setYear(field, Number(range.value) + ($(`#g-${field}`).value ? d : 0));
    const p = el('div', { className: 'picker' }, [
      el('button', { type: 'button', textContent: '−', ariaLabel: 'Un an plus tôt', onclick: () => step(-1) }),
      el('output', { textContent: '?' }),
      el('button', { type: 'button', textContent: '+', ariaLabel: 'Un an plus tard', onclick: () => step(1) }),
      range,
    ]);
    p.dataset.for = field;
    range.oninput = () => setYear(field, range.value);
    $(`#g-${field}`).after(p);
  }
}

function selectedFields() {
  return [...document.querySelectorAll('#opt-fields input')]
    .filter((i) => i.checked && !i.closest('label').classList.contains('hidden'))
    .map((i) => i.value);
}

/* ---------- Import de l'historique (Spotify ou YouTube Music) ---------- */

async function importHistory(files) {
  const status = $('#history-status');
  status.classList.remove('error');
  status.textContent = 'Lecture du fichier…';
  try {
    const lists = [];
    let html = false;
    for (const file of files) {
      if (/\.html?$/i.test(file.name)) { html = true; continue; }
      if (/\.zip$/i.test(file.name)) {
        if (!window.JSZip) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files).filter((f) => !f.dir && History.FILE_RE.test(f.name));
        html ||= Object.values(zip.files).some((f) => /youtube[^/]*\/.*\.html$/i.test(f.name));
        for (const [i, entry] of entries.entries()) {
          status.textContent = `Lecture de ton historique… ${i + 1} / ${entries.length}`;
          lists.push(JSON.parse(await entry.async('string')));
        }
      } else {
        lists.push(JSON.parse(await file.text()));
      }
    }
    const h = History.aggregate(lists);
    if (!h.streams && html) throw new Error("l'export YouTube est au format HTML. Refais-le dans Google Takeout en choisissant le format JSON pour l'historique");
    if (!h.streams) throw new Error("aucune écoute de musique trouvée. Vérifie que c'est bien le fichier envoyé par Spotify ou par Google Takeout");
    store.set('history', h);
    if (!store.get('history')) throw new Error('ton navigateur refuse de garder les données');
    store.set('source', 'history');
    Stats.track('historique-importe', { format: h.src === 'spotify' ? (h.tracks.some((t) => t.u) ? 'etendu' : 'annee') : h.src });
    enterSetup();
  } catch (e) {
    status.textContent = `Import impossible : ${e.message}.`;
    status.classList.add('error');
  }
}

let snippetTimer = null;
let stallTimer = null;
let pending = null;

// History games play Deezer previews in an <audio> element; everything else plays through Spotify.
const activePlayer = () => (game?.engine === 'deezer' ? Deezer.player : player);

function onPlayback(paused, uris) {
  isPaused = paused;
  $('#stage').classList.toggle('playing', !paused);
  $('#btn-pause').textContent = paused ? 'Lecture' : 'Pause';
  if (paused || !pending || !uris.includes(pending.uri)) return;
  $('#round-loading').classList.add('hidden');
  clearTimeout(snippetTimer);
  clearTimeout(stallTimer);
  if (pending.snippetMs) {
    snippetTimer = setTimeout(() => activePlayer().pause(), pending.snippetMs);
    countdown('run', pending.snippetMs);
  }
  pending = null;
}

Deezer.player.onState((paused) => onPlayback(paused, [game?.tracks[game.index]?.uri]));

// In sudden death and challenges, "Passer" would dodge hard tracks, so it only appears when a track can't play.
const freeSkip = () => game.mode !== 'sudden' && !game.challenge;

function unplayable(reason) {
  if (!$('#result').classList.contains('hidden')) return;
  $('#round-error').textContent = `Lecture impossible (${reason}). Clique sur « Passer ».`;
  $('#btn-skip').classList.remove('hidden');
}

// state: 'ready' (full bar, waiting for sound), 'run' (draining over ms), 'off' (hidden)
function countdown(state, ms = 0) {
  const c = $('#countdown');
  c.classList.remove('run');
  c.classList.toggle('off', state === 'off');
  if (state === 'run') {
    void c.offsetWidth;
    c.style.setProperty('--dur', `${ms}ms`);
    c.classList.add('run');
  }
}

function bump(node) {
  node.classList.remove('bump');
  void node.offsetWidth;
  node.classList.add('bump');
}

// The snippet countdown starts once the SDK reports the track playing, not at request time.
async function playFrom(uri, positionMs, snippetMs) {
  clearTimeout(snippetTimer);
  pending = { uri, snippetMs };
  $('#round-loading').classList.remove('hidden');
  countdown(snippetMs ? 'ready' : 'off');
  if (snippetMs) snippetTimer = setTimeout(() => activePlayer().pause(), snippetMs + 8000);
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => { if (pending?.uri === uri) unplayable('le son ne démarre pas'); }, 10000);
  try {
    if (game.engine === 'deezer') {
      await Deezer.player.play(currentTrack().preview, positionMs / 1000);
    } else {
      await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
      });
    }
  } catch (e) {
    if (e.replaced) throw e; // a newer play took over: its state must stay
    pending = null;
    clearTimeout(stallTimer);
    $('#round-loading').classList.add('hidden');
    countdown('off');
    throw e;
  }
}

function setVolume(v) {
  store.set('volume', v);
  player?.setVolume(v / 100);
  Deezer.player.setVolume(v / 100);
}

/* ---------- Partie ---------- */

let game = null;

function updateStartButton() {
  const needsSpotify = !onDeezer($('#opt-source').value);
  $('#btn-start').disabled = !(tracks.length && (deviceId || !needsSpotify) && selectedFields().length);
  // A challenge plays Deezer previews when Spotify can't: it only waits for a Spotify player still starting.
  $('#btn-challenge').disabled = !!store.get('token') && !deviceId && !$('#player-status').classList.contains('error');
  // « Pochette surprise » needs only the songs: no player.
  $('#btn-covers').disabled = !tracks.length;
}

const TOP_NAMES = { short_term: 'Top 4 semaines', medium_term: 'Top 6 mois', long_term: 'Top de toujours' };

// The same few facts describe every game in the stats.
const gameFacts = () => ({ source: game.kind, mode: game.mode, reponses: game.answers, defi: game.challenge ? 'oui' : 'non', son: game.engine });

function beginGame(settings) {
  game = { index: 0, results: [], pool: [], challenge: null, fixedStarts: false, engine: 'spotify', answers: 'type', ...settings };
  game.library ??= game.tracks;
  Stats.track('partie-lancee', gameFacts());
  activePlayer().activateElement();
  show('screen-round');
  startRound();
}

function startGame() {
  const mode = $('#opt-mode').value;
  const source = $('#opt-source').value;
  const kind = source.split(':')[0];
  const pool = shuffle(tracks);
  const count = mode === 'sudden' ? pool.length : Math.max(1, Math.min(pool.length, parseInt($('#opt-count').value, 10) || 10));
  beginGame({
    mode,
    kind,
    engine: onDeezer(kind) ? 'deezer' : 'spotify',
    detail: kind === 'top' ? TOP_NAMES[source.slice(4)] : kind === 'playlist' || kind === 'dzplaylist' ? $('#opt-playlist').selectedOptions[0]?.textContent.replace(/ \([^)]*\)$/, '') : '',
    fields: selectedFields(),
    answers: $('#opt-answers').value,
    library: tracks,
    addedNames: ADDED_NAMES[kind] || ["Année d'ajout", 'Ajouté en'],
    tracks: pool.slice(0, count),
    pool: mode === 'sudden' ? [] : pool.slice(count),
    snippetMs: parseInt($('#opt-snippet').value, 10) * 1000,
    randomStart: $('#opt-start').value === 'random',
  });
}

const CHALLENGE_ADDED = {
  liked: (o) => [`Année où ${o} l'a liké`, 'Liké en'],
  dzliked: (o) => [`Année où ${o} l'a mis en coup de cœur`, 'Coup de cœur en'],
};

function startChallenge() {
  const c = pendingChallenge;
  dropChallenge();
  const addedNames = CHALLENGE_ADDED[c.kind]?.(c.owner) || ["Année d'ajout à la playlist", 'Ajouté en'];
  // Full Spotify tracks only for a Spotify challenge on a ready Spotify player; Deezer previews otherwise.
  const deezer = !deviceId || c.tracks.some((t) => t.uri.startsWith('dz:'));
  // A preview lasts 30 s: a start picked in a full Spotify track is brought back inside it.
  const room = Math.max(0, 30000 - (c.snippetMs || 30000));
  beginGame({
    mode: c.mode,
    kind: c.kind,
    engine: deezer ? 'deezer' : 'spotify',
    fields: c.fields,
    answers: c.answers,
    addedNames,
    tracks: c.tracks.map((t) => ({ ...t, startMs: deezer ? Math.min(t.startMs, room) : t.startMs })),
    snippetMs: c.snippetMs,
    fixedStarts: true,
    challenge: c,
  });
}

const streak = () => game.results.filter((r) => r.survived).length;
const totalPoints = () => game.results.reduce((s, r) => s + r.total, 0);

function currentTrack() { return game.tracks[game.index]; }

async function startRound() {
  const t = currentTrack();
  if (!game.fixedStarts) {
    // Deezer previews last 30 s: pick a start that still leaves the whole snippet to hear.
    const room = game.engine === 'deezer' ? Math.max(0, 30000 - (game.snippetMs || 30000)) : 0;
    t.startMs = !game.randomStart ? 0
      : game.engine === 'deezer' ? Math.floor(Math.random() * room)
      : Math.floor(t.duration * (0.2 + Math.random() * 0.4));
  }
  const sudden = game.mode === 'sudden';
  const num = String(game.index + 1).padStart(2, '0');
  $('#round-num').textContent = sudden ? `${game.index + 1}` : `${game.index + 1} / ${game.tracks.length}`;
  $('#score-label').textContent = sudden ? 'Série' : 'Score';
  $('#round-score').textContent = sudden ? streak() : totalPoints();
  $('#round-progress-bar').classList.toggle('hidden', sudden);
  $('#round-progress').style.width = `${(game.index / game.tracks.length) * 100}%`;
  const c = game.challenge;
  $('#round-target').classList.toggle('hidden', !c);
  if (c) $('#round-target').textContent = sudden ? `À battre : la série de ${c.score} de ${c.name}` : `À battre : ${c.score} / ${c.max} de ${c.name}`;
  $('#stage').classList.remove('revealed');
  $('#stage-num').replaceChildren(num, ...(sudden ? [] : [el('small', { textContent: `/${game.tracks.length}` })]));
  $('#round-error').textContent = '';
  $('#guess-form').reset();
  $('#label-artist').textContent = t.artists.length > 1
    ? `Artistes (${t.artists.length} attendus, séparés par des virgules)`
    : 'Artiste';
  $('#label-added').textContent = game.addedNames[0];
  for (const d of document.querySelectorAll('#guess-form [data-field]')) {
    d.classList.toggle('hidden', !game.fields.includes(d.dataset.field));
  }
  $('#guess-form').classList.toggle('choice', choiceMode());
  if (choiceMode()) { resetPickers(); renderChoices(t); }
  $('#guess-form').classList.remove('hidden');
  $('#result').classList.add('hidden');
  $('#btn-skip').classList.toggle('hidden', !freeSkip());
  // No keyboard popping up when answers are picked.
  if (!choiceMode()) $('#guess-form [data-field]:not(.hidden) input').focus();
  await replay();
}

async function replay() {
  const t = currentTrack();
  $('#round-error').textContent = '';
  if (game.engine === 'deezer') {
    // Instant when prefetched; otherwise finds the preview (history) or the release year (profiles).
    $('#round-loading').classList.remove('hidden');
    const found = await Deezer.resolve(t);
    if (currentTrack() !== t) return;
    // Not the player's fault: a track missing on Deezer is replaced silently, in every mode.
    if (!found) { skip(); return; }
    // The album of a history track is only known once Deezer has found it.
    if (choiceMode() && $('#result').classList.contains('hidden')) renderChoices(t);
    if (choiceMode() && game.fields.includes('album') && !game.fields.includes('artist') && !t.discography) {
      Deezer.album.ofArtist(t.artists[0], t.artistId).catch(() => []).then((list) => {
        t.discography = list.map((a) => a.title);
        if (currentTrack() === t && $('#result').classList.contains('hidden')) renderChoices(t);
      });
    }
    Deezer.resolve(game.tracks[game.index + 1]);
  }
  const snippet = () => ($('#result').classList.contains('hidden') ? game.snippetMs : 0);
  try {
    await playFrom(t.uri, t.startMs, snippet());
  } catch (e) {
    if (e.replaced) return;
    if (game.engine !== 'deezer' || currentTrack() !== t || !(await Deezer.refresh(t)) || currentTrack() !== t) { unplayable(e.message); return; }
    try { await playFrom(t.uri, t.startMs, snippet()); } catch (e2) { unplayable(e2.message); }
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
    discovered: $('#g-discovered').value,
  };
  const all = Scoring.round(guess, t);
  // A picked answer is right or wrong: no partial credit for a name that merely looks alike.
  if (choiceMode()) for (const f of TEXT_FIELDS) all[f] = guess[f] && sameText(guess[f], answerText(f, t)) ? 10 : 0;
  const pts = Object.fromEntries(game.fields.map((k) => [k, all[k]]));
  const total = Object.values(pts).reduce((a, b) => a + b, 0);
  const max = game.fields.length * 10;
  const sudden = game.mode === 'sudden';
  // Sudden death: you survive by finding the artist or the title (or half the points if neither is asked).
  const keyFields = game.fields.filter((k) => k === 'artist' || k === 'title');
  const survived = keyFields.length ? keyFields.some((k) => pts[k] > 0) : total * 2 >= max;
  const grid = sudden ? (survived ? 2 : 0) : total === max ? 2 : total > 0 ? 1 : 0;
  game.results.push({ track: t, pts, total, survived, grid });

  const truth = {
    artist: t.artists.join(', '), title: t.name, album: t.album,
    year: t.releaseYear ?? '?', added: t.addedYear ?? '?',
    discovered: t.firstYear ?? '?',
  };
  $('#r-max').textContent = sudden ? `sur ${max} · ${survived ? 'la série continue' : 'fin de la série'}` : `sur ${max}`;
  $('#r-table').replaceChildren(...game.fields.map((k, i) => el('tr', { style: `--i: ${i}` }, [
    el('td', { textContent: label(k) }),
    el('td', {}, [String(truth[k]), el('div', { className: 'guess', textContent: guess[k] ? `ta réponse : ${guess[k]}` : 'pas de réponse' })]),
    el('td', { className: 'pts' }, [
      el('span', { className: 'badge ' + (pts[k] === 10 ? 'ok' : pts[k] > 0 ? 'mid' : 'ko'), textContent: `+${pts[k]}` }),
    ]),
  ])));
  $('#r-cover').src = t.cover;
  $('#r-cover').classList.toggle('hidden', !t.cover);
  $('#r-points').textContent = `+${total}`;
  bump($('#r-points'));
  $('#round-score').textContent = sudden ? streak() : totalPoints();
  if (sudden ? survived : total) bump($('#round-score'));
  $('#stage-title').textContent = t.name;
  $('#stage').classList.add('revealed');
  $('#round-progress').style.width = `${((game.index + 1) / game.tracks.length) * 100}%`;
  countdown('off');
  $('#guess-form').classList.add('hidden');
  $('#btn-skip').classList.add('hidden');
  $('#result').classList.remove('hidden');
  const over = (sudden && !survived) || game.index + 1 >= game.tracks.length;
  $('#btn-next').textContent = over ? 'Voir le score' : 'Suivant';
  $('#btn-next').focus();

  clearTimeout(snippetTimer);
  if (pending) pending.snippetMs = 0;
  if (isPaused) activePlayer().resume();
}

function next() {
  const last = game.results.at(-1);
  if (game.mode === 'sudden' && last && !last.survived) { endGame(); return; }
  game.index++;
  game.index < game.tracks.length ? startRound() : endGame();
}

// Back to the settings mid-game: the sound stops, nothing is scored.
async function quitGame() {
  if (!(await ask('Abandonner la partie en cours ?', 'Abandonner'))) return;
  Stats.track('partie-abandonnee', { ...gameFacts(), titre: String(game.index + 1) });
  clearTimeout(snippetTimer);
  clearTimeout(stallTimer);
  pending = null;
  $('#round-loading').classList.add('hidden');
  activePlayer()?.pause();
  backToSetup();
}

// The settings, or home for a visitor who only came to play a challenge (no source yet).
const backToSetup = () => (store.get('token') || store.get('history') || store.get('deezerUser') ? show('screen-setup') : goHome());

function endGame() {
  clearTimeout(snippetTimer);
  clearTimeout(stallTimer);
  pending = null;
  $('#round-loading').classList.add('hidden');
  activePlayer().pause();
  const sudden = game.mode === 'sudden';
  const total = totalPoints();
  const max = game.results.length * game.fields.length * 10;
  const mine = sudden ? streak() : total;
  $('#end-title').textContent = sudden ? 'Mort subite' : 'Fini !';
  $('#end-score').textContent = sudden ? `Série de ${mine}` : `${total} / ${max}`;
  $('#end-detail').textContent = sudden
    ? `${total} points sur ${game.results.length} titre${game.results.length > 1 ? 's' : ''}`
    : game.fields.map((k) => `${label(k)} ${game.results.reduce((s, r) => s + r.pts[k], 0)}`).join(' · ');

  const grid = game.results.map((r) => r.grid);
  const c = game.challenge;
  $('#end-verdict').classList.toggle('hidden', !c);
  $('#end-grid-them').classList.toggle('hidden', !c);
  $('#end-grid').replaceChildren(...(c ? [el('small', { textContent: 'Toi' })] : []), Challenge.squares(grid));
  if (c) {
    $('#end-verdict').textContent = verdictText(mine, c.score, c.name);
    $('#end-grid-them').replaceChildren(el('small', { textContent: c.name }), Challenge.squares(c.grid));
  }

  $('#end-recap').replaceChildren(...game.results.map((r, i) => el('li', { style: `--i: ${i}` }, [
    r.track.cover ? el('img', { src: r.track.cover, alt: '', loading: 'lazy' }) : el('span'),
    el('span', { textContent: `${r.track.artists[0]} — ${r.track.name}` }),
    el('strong', { textContent: `${r.total}` }),
  ])));
  // A challenge is replayed from its link, not from this player's settings.
  $('#btn-again').classList.toggle('hidden', !!c || !tracks.length);
  show('screen-end');
  Stats.track('partie-finie', { ...gameFacts(), titres: String(game.results.length), score: Stats.bucket(total, max) });
  prepareShare(mine, max, grid);
}

/* ---------- Partage et défis ---------- */

let pendingChallenge = null;

async function myName() {
  // A Deezer game is signed with the profile (or room) name: no Spotify call.
  if (game.engine === 'deezer' || !store.get('token')) return playerName();
  const cached = store.get('myName');
  if (cached) return cached;
  let name = 'Un pote';
  try { name = (await api('/me')).display_name || name; } catch { /* keep the fallback */ }
  store.set('myName', name);
  return name;
}

function sourceLabel(name) {
  if (game.challenge) return game.challenge.source;
  if (game.kind === 'playlist' || game.kind === 'dzplaylist') return `Playlist « ${game.detail} »`;
  if (game.kind === 'top') return `${game.detail} de ${name}`;
  if (game.kind === 'dztop') return `Top Deezer de ${name}`;
  if (game.kind === 'dzliked') return `Coups de cœur de ${name}`;
  if (game.kind === 'history') return `Historique de ${name}`;
  return `Likés de ${name}`;
}

// Picked and typed scores are never compared: the share says which one it was.
const answersTag = () => (game.answers === 'choice' ? ' · Choix' : ' · Saisie');

async function prepareShare(score, max, grid) {
  const btn = $('#btn-share');
  btn.disabled = true;
  $('#share-link').value = '';
  $('#share-feedback').textContent = '';
  try {
    const name = await myName();
    const sudden = game.mode === 'sudden';
    const played = game.results.map((r) => r.track);
    // Sudden death needs tracks beyond the fatal one so the next player can beat the streak.
    const extra = sudden ? game.tracks.slice(game.index + 1, game.index + 16) : [];
    const source = sourceLabel(name);
    const code = await Challenge.encode({
      name,
      owner: game.challenge?.owner ?? name,
      kind: game.kind,
      source,
      mode: game.mode,
      answers: game.answers,
      fields: game.fields,
      snippetMs: game.snippetMs,
      score,
      max,
      grid,
      tracks: [...played, ...extra],
    });
    const url = `${REDIRECT_URI}#c=${code}`;
    const head = sudden ? `Blindtest${answersTag()} · Mort subite · ${source} · série de ${score}` : `Blindtest${answersTag()} · ${source} · ${score}/${max}`;
    game.shareText = `${head}\n${Challenge.squares(grid)}\nÀ toi de battre ça : ${url}`;
    $('#share-link').value = url;
    btn.disabled = false;
  } catch (e) {
    $('#share-feedback').textContent = `Impossible de créer le lien de défi (${e.message}).`;
  }
}

async function shareGame() {
  Stats.track('partage', { ...gameFacts(), lien: 'oui' });
  const done = await shareOrCopy({ text: game.shareText }, game.shareText);
  if (done === 'copied') $('#share-feedback').textContent = 'Copié ! Colle-le dans ton groupe.';
  if (done === 'failed') { $('#share-link').select(); $('#share-feedback').textContent = 'Copie le lien ci-dessus.'; }
}

function showChallenge() {
  const c = pendingChallenge;
  const what = c.mode === 'sudden'
    ? `Mort subite · ${c.source} · série à battre : ${c.score}`
    : `${c.tracks.length} titres · ${c.source} · score à battre : ${c.score} / ${c.max}`;
  const fields = c.fields.map((k) => (k === 'added' ? "année d'ajout" : LABELS[k].toLowerCase())).join(', ');
  $('#login-challenge-title').textContent = `${c.name} te défie !`;
  $('#login-challenge-desc').textContent = `${what}.`;
  $('#challenge-title').textContent = `${c.name} te défie !`;
  const how = c.answers === 'choice' ? 'réponses à choisir' : 'réponses à taper';
  $('#challenge-desc').textContent = `${what}. À deviner : ${fields}, ${how}.`;
  $('#login-challenge').classList.remove('hidden');
  $('#challenge-box').classList.remove('hidden');
}

function dropChallenge() {
  pendingChallenge = null;
  store.del('challengeCode');
  $('#challenge-box').classList.add('hidden');
  $('#login-challenge').classList.add('hidden');
}

// The OAuth redirect loses the URL hash, so a challenge link is parked in storage first.
function captureChallenge() {
  const code = location.hash.match(/^#c=([A-Za-z0-9_-]+)$/)?.[1];
  if (code) {
    store.set('challengeCode', code);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const saved = store.get('challengeCode');
  if (!saved) return;
  Challenge.decode(saved)
    .then((c) => {
      pendingChallenge = c;
      showChallenge();
      if (code) Stats.track('defi-ouvert', { mode: c.mode, reponses: c.answers });
    })
    .catch(() => store.del('challengeCode'));
}

function updateModeHint() {
  const sudden = $('#opt-mode').value === 'sudden';
  store.set('mode', $('#opt-mode').value);
  $('#mode-hint').classList.toggle('hidden', !sudden);
  $('#count-wrap').classList.toggle('hidden', sudden);
}

/* ---------- Accueil ---------- */

// The home screen shows one tile per source; a tile opens its own panel, like a screen in an app.
function openPanel(name) {
  if (name === 'spotify') $('#btn-login').textContent = store.get('token') ? 'Continuer avec Spotify' : 'Se connecter à Spotify';
  $('#home-pick').classList.toggle('hidden', !!name);
  for (const p of document.querySelectorAll('#screen-login [data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== name);
  window.scrollTo(0, 0);
  syncBack();
}

function goHome(panel = null) {
  openPanel(panel);
  show('screen-login');
}

/* ---------- Démarrage ---------- */

let playerStarted = false;

// Each source needs its own way in: a Spotify login, an imported history or a Deezer profile.
function enterSetup() {
  const loggedIn = !!store.get('token');
  const hasHistory = !!store.get('history');
  const dzUser = store.get('deezerUser');
  const available = (v) => (v === 'history' ? hasHistory : v.startsWith('dz') ? !!dzUser : loggedIn);
  const options = [...$('#opt-source').options];
  for (const o of options) {
    o.disabled = !available(o.value);
    o.hidden = o.disabled;
  }
  if (!$('#opt-source').value || $('#opt-source').selectedOptions[0].disabled) {
    $('#opt-source').value = options.find((o) => !o.disabled)?.value || 'liked';
  }
  // Short labels in the list (a phone cuts long ones): whose profile it is goes on the link that forgets it.
  if (dzUser) $('#btn-forget-dz').textContent = `Oublier le profil ${dzUser.name}`;
  $('#btn-logout').classList.toggle('hidden', !loggedIn);
  $('#btn-forget-dz').classList.toggle('hidden', !dzUser);
  $('#btn-reload').classList.toggle('hidden', !loggedIn && !dzUser);
  $('#btn-home').textContent = 'Changer de source';
  show('screen-setup');
  loadSource();
  if (!loggedIn) {
    $('#player-status').textContent = 'Son : extraits Deezer de 30 secondes, sans compte.';
  } else if (!playerStarted) {
    playerStarted = true;
    initPlayer()
      .then(() => { $('#player-status').textContent = 'Lecteur prêt.'; updateStartButton(); })
      .catch((e) => { $('#player-status').textContent = e.message; $('#player-status').classList.add('error'); });
  }
}

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
  $('#btn-forget-dz').onclick = forgetDeezer;
  $('#btn-retry').onclick = () => { store.del('liked'); location.reload(); };
  $('#btn-reload').onclick = () => loadSource(true);
  $('#btn-home').onclick = () => goHome();
  for (const id of ['#btn-setup-back', '#btn-denied-back', '#btn-end-home']) $(id).onclick = () => goHome();
  $('#btn-quit').onclick = quitGame;
  $('#ask-yes').onclick = () => askDone?.(true);
  $('#ask-no').onclick = () => askDone?.(false);
  $('#ask').addEventListener('cancel', (e) => { e.preventDefault(); askDone?.(false); });
  window.addEventListener('popstate', onBack);
  // Does the game bring visitors to the portfolio?
  for (const a of document.querySelectorAll('[data-credit]')) a.addEventListener('click', () => Stats.track('lien-auteur', { lien: a.dataset.credit }));
  for (const tile of document.querySelectorAll('[data-open]')) {
    tile.onclick = () => { Stats.track('source-ouverte', { source: tile.dataset.open }); openPanel(tile.dataset.open); };
  }
  for (const back of document.querySelectorAll('#screen-login .back')) back.onclick = () => openPanel(null);
  $('#history-file').onchange = (e) => { if (e.target.files.length) importHistory([...e.target.files]); };
  $('#deezer-form').onsubmit = connectDeezer;
  $('#deezer-profile').value = store.get('deezerUser') ? `deezer.com/profile/${store.get('deezerUser').id}` : '';
  $('#opt-source').value = store.get('source', 'liked');
  $('#opt-source').onchange = () => loadSource();
  $('#opt-playlist').onchange = () => loadSource();
  // A first game asks the artist and the title: five questions per song is a lot to start with.
  let savedFields = store.get('fields');
  if (!savedFields) {
    savedFields = [...DEFAULT_FIELDS];
    store.set('fieldsHistory', true);
  } else if (!store.get('fieldsHistory')) {
    // Saved before "Année de découverte" existed: it is added once.
    savedFields = [...savedFields, 'discovered'];
    store.set('fields', savedFields);
    store.set('fieldsHistory', true);
  }
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
  $('#btn-pause').onclick = () => activePlayer().togglePlay();
  $('#btn-skip').onclick = skip;
  $('#btn-next').onclick = next;
  $('#btn-again').onclick = startGame;
  $('#btn-settings').onclick = backToSetup;
  Deezer.player.setVolume(store.get('volume', 70) / 100);
  $('#btn-share').onclick = shareGame;
  $('#btn-challenge').onclick = startChallenge;
  $('#btn-challenge-home').onclick = startChallenge;
  $('#btn-challenge-skip').onclick = dropChallenge;
  setupChoiceUi();
  Covers.wire();
  $('#opt-answers').value = store.get('answers', matchMedia('(pointer: coarse)').matches ? 'choice' : 'type');
  if (!$('#opt-answers').value) $('#opt-answers').value = 'type';
  $('#opt-answers').onchange = () => store.set('answers', $('#opt-answers').value);
  $('#opt-mode').value = store.get('mode', 'classic');
  if (!$('#opt-mode').value) $('#opt-mode').value = 'classic';
  $('#opt-mode').onchange = updateModeHint;
  // Blindtest or Pochette surprise: the same music, each game its own options.
  const pickGame = (g) => { $('#screen-setup').dataset.game = g; store.set('game', g); };
  const savedGame = store.get('game') === 'covers' ? 'covers' : 'blindtest';
  for (const r of document.querySelectorAll('input[name="game"]')) {
    r.checked = r.value === savedGame;
    r.onchange = () => pickGame(r.value);
  }
  pickGame(savedGame);
  updateModeHint();
  captureChallenge();
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
  // A failed Spotify login lands back on its own panel, where the error is shown
  // (or back in the room, when it was started from a room's lobby).
  if ($('#login-error').textContent && !store.get('salleSpotify')) { goHome('spotify'); return; }
  // A room link, or a room this phone is still in, wins over everything else.
  if (await Salle.boot()) return;
  if (!store.get('token') && !store.get('history') && !store.get('deezerUser')) { goHome(); return; }
  enterSetup();
}

main();
