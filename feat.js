// « Feat sur feat » : chain the featurings. The game starts from an artist of the player's music; the player types
// an artist who made a song with them, who becomes the next one, and so on. 30 seconds per feat, never the same
// artist twice. Deezer is the referee: a feat counts when a song credits both artists, and that song is played.
// A challenge link (#f=…) starts a friend from the same artist.
// It uses the helpers of util.js ($, el, shuffle, store, shareOrCopy, playerName, verdictText), app.js (show, ask,
// goHome, historyTracks) and deezer.js (profiles, artists and their featurings, the preview player).
const Feats = (() => {
  const TIME_MS = 30000;
  const LATE_MS = 5000; // the clock turns orange
  const MIN_PARTNERS = 3; // a start with fewer feats on Deezer could be a dead end
  const norm = Scoring.norm;

  let picked = null; // { source, list }: the songs of the music picked, dealt again by « Rejouer »
  let dare = null; // a challenge link opened on this visit, until it is played or dismissed
  let game = null; // { chain: [{ artist, track }], challenge, over, checking }
  let clock = { left: TIME_MS, since: null, tick: null };
  let suggestTimer = null;
  let suggestSeq = 0;
  let shown = []; // the suggestions on screen

  const feats = () => (game ? game.chain.length - 1 : 0);
  const current = () => game.chain.at(-1).artist;

  /* ---------- Which music: picked on the game's home panel ---------- */

  function say(text, error = false) {
    $('#ft-panel-status').textContent = text;
    $('#ft-panel-status').classList.toggle('error', error);
  }

  // What this browser already knows (a Deezer profile, a history), and a Deezer profile search.
  // No Spotify: its rules for developers forbid games built on it.
  function renderSources() {
    const dz = store.get('deezerUser');
    $('#ft-use-dz').classList.toggle('hidden', !dz);
    if (dz) $('#ft-use-dz').textContent = `Mon profil Deezer : ${dz.name}`;
    $('#ft-use-history').classList.toggle('hidden', !store.get('history'));
  }

  function toPanel() {
    renderSources();
    goHome('feat');
  }

  const panelOpen = () => !$('#screen-login').classList.contains('hidden') && !$('[data-panel="feat"]').classList.contains('hidden');

  // Loads the songs of a source, then picks the first artist among them. explain: a clearer message for some errors.
  async function play(source, loading, load, explain = () => null) {
    Deezer.player.activateElement(); // inside the tap: the feats found later may play on a phone
    const buttons = document.querySelectorAll('#ft-sources button, #ft-dz-form button');
    for (const b of buttons) b.disabled = true;
    say(loading);
    try {
      const from = { source, list: await load() };
      if (!panelOpen()) return; // the player went elsewhere meanwhile
      if (await deal(from, say, panelOpen)) picked = from;
    } catch (e) {
      say(explain(e) || e.message || 'Ça n’a pas marché. Réessaie.', true);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }

  // A Deezer profile: the artists of its top and of its coups de cœur.
  function fromDeezer(user) {
    $('#ft-dz-results').replaceChildren();
    return play('deezer', `Chargement de la musique de ${user.name}…`, async () => {
      const lists = await Deezer.profile.playlists(user.id);
      const loved = lists.find((p) => p.loved);
      const [liked, top] = await Promise.all([loved ? Deezer.profile.playlist(loved.id, 500) : [], Deezer.profile.top(user.id).catch(() => [])]);
      return [...top, ...liked];
    }, (e) => (e.deezer ? 'Profil introuvable ou privé : il doit être public sur Deezer.' : null));
  }

  const fromHistory = () => play('history', 'Lecture de ton historique…', async () => historyTracks());

  async function searchDeezer(e) {
    e.preventDefault();
    const q = $('#ft-dz-query').value.trim();
    const list = $('#ft-dz-results');
    list.replaceChildren();
    if (!q) return;
    const id = Deezer.profile.id(q);
    say('Recherche…');
    try {
      const users = id ? [await Deezer.profile.user(id)] : await Deezer.profile.search(q);
      say(users.length ? 'Lequel est ton profil ?' : 'Aucun profil à ce nom. Essaie le lien de ton profil.');
      list.replaceChildren(...users.map((u) => el('li', {}, el('button', { type: 'button', className: 'pick', onclick: () => fromDeezer(u) }, [
        u.picture ? el('img', { className: 'avatar', src: u.picture, alt: '', loading: 'lazy' })
          : el('span', { className: 'avatar', textContent: u.name.slice(0, 1).toUpperCase(), ariaHidden: 'true' }),
        el('span', { textContent: u.name }),
      ]))));
    } catch {
      say('Profil introuvable ou privé.', true);
    }
  }

  /* ---------- The first artist ---------- */

  // The artists of the songs, the most listened first (in a new order among the most listened),
  // the recent starts last: the first artist is one the player knows.
  function startCandidates(list) {
    const map = new Map();
    for (const t of list) {
      const name = t.artists?.[0];
      if (!name) continue;
      const e = map.get(norm(name)) || { name, id: t.artistId ? String(t.artistId) : null, songs: 0 };
      e.songs++;
      map.set(norm(name), e);
    }
    const recent = new Set(store.get('featStarts') || []);
    const all = [...map.values()].sort((a, b) => b.songs - a.songs);
    const head = shuffle(all.slice(0, 25));
    return [...head.filter((a) => !recent.has(norm(a.name))), ...head.filter((a) => recent.has(norm(a.name))), ...all.slice(25)];
  }

  // The first candidate Deezer knows with enough feats. out: where the progress shows; alive: false once the
  // player went elsewhere. Resolves to true once the game starts.
  async function deal(from, out, alive) {
    const list = startCandidates(from.list);
    if (!list.length) throw new Error('Aucun artiste dans cette musique. Choisis une autre source.');
    out('Choix de l’artiste de départ…');
    for (const c of list.slice(0, 10)) {
      const artist = await (c.id ? Deezer.artist.get(c.id) : Deezer.artist.find(c.name)).catch(() => null);
      if (!alive()) return false;
      if (!artist?.id) continue;
      const partners = await Deezer.artist.partners(artist).catch(() => []);
      if (!alive()) return false;
      if (partners.length < MIN_PARTNERS) continue;
      out('');
      Stats.track('feat-lancee', { source: from.source });
      begin(artist, null);
      return true;
    }
    throw new Error('Deezer ne trouve pas assez de feats pour les artistes de cette musique. Choisis une autre source.');
  }

  // « Rejouer » on the end screen: another first artist from the same music.
  async function again() {
    if (!picked) return;
    Deezer.player.activateElement();
    const button = $('#ft-again');
    const out = (text, error = false) => { $('#ft-share-feedback').textContent = text; $('#ft-share-feedback').classList.toggle('error', error); };
    button.disabled = true;
    try {
      await deal(picked, out, () => !$('#screen-feat').classList.contains('hidden'));
    } catch (e) {
      out(e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- Game ---------- */

  function begin(artist, challenge) {
    game = { chain: [{ artist, track: null }], challenge, over: false, checking: false };
    store.set('featStarts', [norm(artist.name), ...(store.get('featStarts') || [])].slice(0, 10));
    $('#ft-end').classList.add('hidden');
    $('#ft-game').classList.remove('hidden');
    $('#ft-guess').value = '';
    $('#ft-guess').disabled = false;
    clearSuggestions();
    status('');
    show('screen-feat');
    window.scrollTo(0, 0);
    paint();
    clock = { left: TIME_MS, since: null, tick: null };
    runClock();
    // On a phone, the keyboard only opens on a tap in the field.
    if (!matchMedia('(pointer: coarse)').matches) $('#ft-guess').focus({ preventScroll: true });
  }

  function status(text, error = false) {
    $('#ft-status').textContent = text;
    $('#ft-status').classList.toggle('error', error);
  }

  // The artist to link, the last feat found (with its song), and the chain so far, the newest first.
  function paint() {
    const now = current();
    $('#ft-count').textContent = feats();
    $('#ft-artist').textContent = now.name;
    $('#ft-who').textContent = now.name;
    $('#ft-pic').classList.toggle('hidden', !now.picture);
    if (now.picture) $('#ft-pic').src = now.picture;
    restart($('#ft-now'));
    const last = game.chain.at(-1).track;
    $('#ft-proof').classList.toggle('hidden', !last);
    if (last) {
      $('#ft-proof-cover').src = last.cover;
      $('#ft-proof-cover').classList.toggle('hidden', !last.cover);
      $('#ft-proof-title').textContent = last.title;
      $('#ft-proof-artists').textContent = last.artists.join(', ');
      restart($('#ft-proof'));
    }
    $('#ft-chain').replaceChildren(...game.chain.slice(1).map((l, i) => el('li', {}, [
      el('span', { className: 'ft-link', textContent: `${game.chain[i].artist.name} → ${l.artist.name}` }),
      el('span', { className: 'status', textContent: l.track.title }),
    ])).reverse());
  }

  // Plays an element's entrance again.
  function restart(node) {
    node.classList.remove('enter');
    void node.offsetWidth;
    node.classList.add('enter');
  }

  /* ---------- The clock: 30 s per feat, stopped while Deezer checks ---------- */

  const timeLeft = () => (clock.since === null ? clock.left : clock.left - (performance.now() - clock.since));

  function runClock() {
    clearInterval(clock.tick);
    clock.since = performance.now();
    clock.tick = setInterval(paintClock, 100);
    paintClock();
  }

  function holdClock() {
    clock.left = timeLeft();
    clock.since = null;
    clearInterval(clock.tick);
    paintClock();
  }

  function paintClock() {
    const ms = Math.max(0, timeLeft());
    $('#ft-time').textContent = Math.ceil(ms / 1000);
    $('#ft-clock').style.width = `${(ms / TIME_MS) * 100}%`;
    $('#ft-clock').classList.toggle('late', ms <= LATE_MS);
    if (ms <= 0 && clock.since !== null) end('time');
  }

  /* ---------- Answers ---------- */

  // choice: an artist from the suggestions ({ id, name, picture }), or a typed name ({ name }).
  async function guess(choice) {
    const g = game;
    if (!g || g.over || g.checking || !choice.name.trim()) return;
    g.checking = true;
    holdClock();
    status('Vérification sur Deezer…');
    $('#ft-form').classList.add('checking');
    clearSuggestions();
    let found = false;
    try {
      const from = current();
      const artist = choice.id ? choice : (await Deezer.artist.find(choice.name).catch(() => null)) || { id: null, name: choice.name.trim(), picture: '' };
      if (g !== game || g.over) return;
      if (Deezer.sameArtist(artist, from)) { status('C’est le même artiste !', true); return; }
      if (g.chain.some((l) => Deezer.sameArtist(l.artist, artist))) { status(`${artist.name} est déjà dans la chaîne.`, true); return; }
      const track = await Deezer.artist.collab(from, artist).catch(() => null);
      if (g !== game || g.over) return;
      if (!track) { status(`Pas de feat entre ${from.name} et ${artist.name} sur Deezer.`, true); return; }
      found = true;
      link(artist, track);
    } finally {
      if (g === game && !g.over) {
        g.checking = false;
        $('#ft-form').classList.remove('checking');
        if (found) clock.left = TIME_MS;
        runClock();
        // A miss stays in the field, selected: a typo is fixed, another name typed over it.
        if (!found) $('#ft-guess').select();
      }
    }
  }

  function link(artist, track) {
    game.chain.push({ artist, track });
    $('#ft-guess').value = '';
    status('');
    paint();
    bump($('#ft-count'));
    listen(track);
    // The picture of a typed artist Deezer found without one.
    if (!artist.picture && artist.id) {
      Deezer.artist.get(artist.id).then((a) => {
        artist.picture = a.picture;
        if (game && current() === artist && a.picture) { $('#ft-pic').src = a.picture; $('#ft-pic').classList.remove('hidden'); }
      }).catch(() => {});
    }
  }

  // Each feat found plays its song (its 30 s preview), unless the sound is off.
  function listen(track) {
    if (!store.get('featSound', true) || !track?.preview) return;
    Deezer.player.play(track.preview, 0).catch(() => {});
  }

  function toggleSound() {
    const on = !store.get('featSound', true);
    store.set('featSound', on);
    paintSound();
    if (!on) Deezer.player.pause();
  }

  const paintSound = () => { $('#ft-sound').textContent = store.get('featSound', true) ? 'Couper le son' : 'Remettre le son'; };

  /* ---------- Suggestions: Deezer's artists, never filtered by the answer ---------- */

  function clearSuggestions() {
    clearTimeout(suggestTimer);
    suggestSeq++; // a search still on its way is dropped
    shown = [];
    $('#ft-suggest').replaceChildren();
  }

  function suggest() {
    clearTimeout(suggestTimer);
    const q = $('#ft-guess').value.trim();
    if (q.length < 2) { clearSuggestions(); return; }
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      const list = await Deezer.artist.search(q, 6).catch(() => []);
      if (seq !== suggestSeq || !game || game.over) return;
      shown = list;
      $('#ft-suggest').replaceChildren(...list.map((a) => el('li', {}, el('button', {
        type: 'button',
        className: 'ft-suggestion',
        // The field keeps the focus: on a phone the keyboard stays open for the next name.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => guess(a),
      }, [
        a.picture ? el('img', { src: a.picture, alt: '', loading: 'lazy' }) : el('span', { className: 'ft-noface', ariaHidden: 'true' }),
        el('span', { textContent: a.name }),
      ]))));
    }, 250);
  }

  // Enter: the suggestion with exactly that name, else the typed name as is.
  function submit(e) {
    e.preventDefault();
    const text = $('#ft-guess').value.trim();
    if (!text) return;
    guess(shown.find((a) => norm(a.name) === norm(text)) || { name: text });
  }

  /* ---------- End ---------- */

  // why: 'time' (the clock ran out) or 'stop' (the player stopped).
  function end(why) {
    if (!game || game.over) return;
    game.over = true;
    holdClock();
    clearSuggestions();
    $('#ft-guess').disabled = true;
    const n = feats();
    const best = store.get('featBest', 0);
    if (n > best) store.set('featBest', n);
    $('#ft-game').classList.add('hidden');
    $('#ft-end').classList.remove('hidden');
    $('#ft-end-score').textContent = `${n} feat${n > 1 ? 's' : ''}`;
    $('#ft-end-detail').textContent = [
      why === 'time' ? 'Temps écoulé' : 'Tu t’es arrêté là',
      `départ : ${game.chain[0].artist.name}`,
      n > best && best ? 'nouveau record !' : `record : ${Math.max(n, best)}`,
    ].join(' · ');
    const c = game.challenge;
    $('#ft-end-verdict').classList.toggle('hidden', !c);
    if (c) $('#ft-end-verdict').textContent = verdictText(n, c.score, c.name);
    $('#ft-end-grid').textContent = squares(n);
    $('#ft-end-chain').replaceChildren(...game.chain.slice(1).map((l, i) => el('li', { style: `--i: ${i}` }, [
      l.track.cover ? el('img', { src: l.track.cover, alt: '', loading: 'lazy' }) : el('span'),
      el('span', { textContent: `${game.chain[i].artist.name} → ${l.artist.name} · ${l.track.title}` }),
      el('strong', { textContent: String(i + 1) }),
    ])));
    missed(game);
    $('#ft-share-feedback').textContent = '';
    $('#ft-again').classList.toggle('hidden', !picked);
    $('#ft-settings').textContent = picked ? 'Changer de musique' : 'Jouer avec ma musique';
    window.scrollTo(0, 0);
    Stats.track('feat-finie', { feats: n >= 10 ? '10+' : n >= 5 ? '5-9' : n >= 2 ? '2-4' : String(n), fin: why === 'time' ? 'temps' : 'arret', defi: c ? 'oui' : 'non' });
  }

  // A few feats the last artist had, that the chain did not use: what could have been said.
  async function missed(g) {
    const last = g.chain.at(-1).artist;
    $('#ft-end-missed').textContent = '';
    if (!last.id) return;
    const partners = await Deezer.artist.partners(last).catch(() => []);
    if (g !== game) return;
    const free = shuffle(partners.filter((p) => !g.chain.some((l) => Deezer.sameArtist(l.artist, p)))).slice(0, 3);
    if (free.length) $('#ft-end-missed').textContent = `Avec ${last.name}, il y avait aussi : ${free.map((p) => p.name).join(', ')}.`;
  }

  const squares = (n) => (n ? '🟧'.repeat(Math.min(n, 30)) + (n > 30 ? ` +${n - 30}` : '') : '⬛');

  /* ---------- Challenges: the same first artist for a friend ---------- */

  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

  function dareLink() {
    const first = game.chain[0].artist;
    const code = b64(JSON.stringify({ v: 1, n: playerName(), s: feats(), a: first.id, an: first.name }));
    return `${location.origin}${location.pathname}#f=${code}`;
  }

  // Links come from anyone: every value is checked and bounded.
  function readDare(code) {
    const raw = JSON.parse(unb64(code));
    if (raw?.v !== 1 || !/^\d{1,12}$/.test(String(raw.a))) throw new Error('lien invalide');
    return {
      name: String(raw.n || '').slice(0, 40) || 'Un pote',
      score: Math.max(0, Math.min(999, Math.round(Number(raw.s)) || 0)),
      artist: { id: String(raw.a), name: String(raw.an || '').slice(0, 100) || '?', picture: '' },
    };
  }

  // Called at start-up: a #f= link shows its challenge on the home screen.
  function capture() {
    const code = location.hash.match(/^#f=([A-Za-z0-9_-]+)$/)?.[1];
    if (!code) return;
    history.replaceState(null, '', location.pathname + location.search);
    try { dare = readDare(code); } catch { return; }
    Stats.track('feat-defi-ouvert');
    const box = $('#ft-dare');
    box.querySelector('.challenge-title').textContent = `${dare.name} te défie à Feat sur feat !`;
    box.querySelector('.status').textContent = `Départ : ${dare.artist.name} · ${dare.score} feat${dare.score > 1 ? 's' : ''} à battre. Pas besoin de compte.`;
    box.classList.remove('hidden');
  }

  function dropDare() {
    dare = null;
    $('#ft-dare').classList.add('hidden');
  }

  async function startDare() {
    const d = dare;
    if (!d) return;
    Deezer.player.activateElement();
    const button = $('#ft-dare-go');
    const out = $('#ft-dare-status');
    button.disabled = true;
    out.textContent = 'Chargement…';
    try {
      const artist = await Deezer.artist.get(d.artist.id).catch(() => d.artist);
      out.textContent = '';
      dropDare();
      begin(artist.id ? artist : d.artist, d);
    } finally {
      button.disabled = false;
    }
  }

  // The squares and a link to the same first artist. The chain itself stays secret: it would give the answers.
  async function share() {
    const n = feats();
    const text = `Feat sur feat · ${n} feat${n > 1 ? 's' : ''} d’affilée en partant de ${game.chain[0].artist.name}\n${squares(n)}\nÀ toi de faire mieux : ${dareLink()}`;
    Stats.track('feat-partage');
    const done = await shareOrCopy({ text }, text);
    if (done === 'copied') $('#ft-share-feedback').textContent = 'Copié ! Colle-le dans ton groupe.';
    if (done === 'failed') $('#ft-share-feedback').textContent = text;
  }

  /* ---------- Leaving ---------- */

  // The back button: during a game it asks first.
  async function back() {
    if (game && !game.over) return confirmQuit();
    quit();
  }

  async function confirmQuit() {
    if (await ask('Abandonner la partie en cours ?', 'Abandonner')) quit();
  }

  // to: where the player goes (the game's panel by default, home from the end screen's « ← Accueil »).
  function quit(to = toPanel) {
    if (game) game.over = true;
    holdClock();
    clearSuggestions();
    Deezer.player.pause();
    game = null;
    to();
  }

  function wire() {
    document.querySelector('[data-open="feat"]').addEventListener('click', () => { renderSources(); say(''); $('#ft-dz-results').replaceChildren(); });
    $('#ft-use-dz').onclick = () => fromDeezer(store.get('deezerUser'));
    $('#ft-use-history').onclick = fromHistory;
    $('#ft-dz-form').onsubmit = searchDeezer;
    $('#ft-form').onsubmit = submit;
    $('#ft-guess').oninput = suggest;
    $('#ft-stop').onclick = () => end('stop');
    $('#ft-sound').onclick = toggleSound;
    $('#ft-again').onclick = again;
    $('#ft-settings').onclick = () => quit();
    $('#ft-share').onclick = share;
    $('#ft-end-back').onclick = () => quit(() => goHome());
    $('#ft-dare-go').onclick = startDare;
    $('#ft-dare-skip').onclick = dropDare;
    paintSound();
    capture();
  }

  // At start-up: a challenge link opens on the home screen.
  function boot() {
    if (dare) { goHome(); return true; }
    return false;
  }

  return { wire, boot, back };
})();
