// « Pochette surprise » : find the album from its cover, pixelated at first, sharper after each try.
// A game of its own on the home screen: the player picks their music on its panel (a Deezer profile, their history
// or Spotify), or opens a challenge link (#p=…: the same five covers as a friend). The details (year, genre,
// number of songs) come from Deezer.
// It uses the helpers of util.js ($, el, shuffle, store, shareOrCopy, playerName), app.js (show, ask, goHome,
// historyTracks) and spotify.js (login, api, toTrack).
const Covers = (() => {
  const ROUNDS = 5;
  const TRIES = 6;
  const BLOCKS = [6, 10, 16, 26, 44]; // pixels across the cover, try after try; then the real cover
  const SNIPPET_MS = 5000;

  let game = null; // { rounds: [], index, results: [], library, challenge }
  let dare = null; // a challenge link opened on this visit, until it is played or dismissed
  let round = null; // { album, tries: [], done, found }
  let image = null; // the current cover, loaded
  let suggestTimer = null;
  let suggestSeq = 0;
  let shown = []; // the suggestions on screen
  let snippetTimer = null;

  const norm = Scoring.norm;
  // "Random Access Memories (10th Anniversary Edition)" and "Random Access Memories" are one album.
  const albumKey = (s) => norm(Scoring.clean(s).replace(/\b(deluxe|remaster(ed)?|expanded|edition|version)\b.*$/i, ''));
  const keyOf = (a) => `${albumKey(a.title)}|${norm(a.artist)}`;
  // With and without what is in brackets: "Come What(ever) May" is also typed in full.
  const forms = (s) => [albumKey(s), norm(s)].filter(Boolean);
  const sameTitle = (x, y) => forms(x).some((g) => forms(y).some((t) => Scoring.similarity(g, t) >= 0.85));

  /* ---------- Which albums ---------- */

  // The albums of the loaded songs: the ones the player has several songs of first, singles last,
  // and the covers seen in recent games after the others.
  function candidates(list) {
    const map = new Map();
    for (const t of list) {
      if (!t.album || !t.artists?.[0]) continue;
      const a = { title: t.album, artist: t.artists[0] };
      const key = keyOf(a);
      const e = map.get(key) || { ...a, key, cover: t.cover || '', year: t.releaseYear || null, albumId: t.albumId || null, tracks: [] };
      e.tracks.push(t);
      e.cover ||= t.cover || '';
      map.set(key, e);
    }
    const seen = new Set(store.get('coversSeen') || []);
    const tier = (e) => (seen.has(e.key) ? 3 : 0) + (e.tracks.length > 1 ? 0 : e.tracks.some((t) => albumKey(t.name) !== albumKey(e.title)) ? 1 : 2);
    const all = shuffle([...map.values()]);
    return [0, 1, 2, 3, 4, 5].flatMap((n) => all.filter((e) => tier(e) === n));
  }

  // Year, genre and size from Deezer, and a cover when the source had none. Null when there is no cover at all.
  async function details(e) {
    let id = e.albumId ? String(e.albumId) : null;
    if (!id) id = await Deezer.album.find(e.artist, e.title).catch(() => null);
    const d = id ? await Deezer.album.get(id).catch(() => null) : null;
    const cover = d?.cover_xl || d?.cover_big || e.cover;
    if (!cover) return null;
    return {
      ...e,
      dzId: d ? String(d.id) : null,
      artistId: d?.artist?.id || null,
      cover,
      year: parseInt(d?.release_date, 10) || e.year || null,
      genre: d?.genres?.data?.[0]?.name || '',
      size: d?.nb_tracks || null,
    };
  }

  /* ---------- Which music: picked on its own home panel, like in « Qui écoute ça ? » ---------- */

  let picked = null; // { source, list }: the songs of the last music picked, dealt again by « Rejouer »

  function say(text, error = false) {
    $('#covers-status').textContent = text;
    $('#covers-status').classList.toggle('error', error);
  }

  // The panel offers what this browser already knows (a Deezer profile, a history, Spotify) and a Deezer search.
  function renderSources() {
    const dz = store.get('deezerUser');
    $('#cv-use-dz').classList.toggle('hidden', !dz);
    if (dz) $('#cv-use-dz').textContent = `Mon profil Deezer : ${dz.name}`;
    $('#cv-use-history').classList.toggle('hidden', !store.get('history'));
    $('#cv-use-spotify').classList.toggle('hidden', !(SPOTIFY_CLIENT_ID || store.get('clientId')));
  }

  function toPanel() {
    renderSources();
    goHome('pochette');
  }

  const panelOpen = () => !$('#screen-login').classList.contains('hidden') && !$('[data-panel="pochette"]').classList.contains('hidden');

  // Loads the songs of a source, then deals five covers from them. explain: a clearer message for some errors.
  async function play(source, loading, load, explain = () => null) {
    const buttons = document.querySelectorAll('.cv-sources button, #cv-dz-form button');
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

  // A Deezer profile: the albums of its coups de cœur and of its top.
  function fromDeezer(user) {
    $('#cv-dz-results').replaceChildren();
    return play('deezer', `Chargement des albums de ${user.name}…`, async () => {
      const lists = await Deezer.profile.playlists(user.id);
      const loved = lists.find((p) => p.loved);
      const [liked, top] = await Promise.all([loved ? Deezer.profile.playlist(loved.id, 500) : [], Deezer.profile.top(user.id).catch(() => [])]);
      return [...liked, ...top];
    }, (e) => (e.deezer ? 'Profil introuvable ou privé : il doit être public sur Deezer.' : null));
  }

  function fromHistory() {
    return play('history', 'Lecture de ton historique…', async () => historyTracks());
  }

  // Spotify: the liked songs and the top. Without a session yet, the login leaves the page; boot() comes back here.
  async function fromSpotify() {
    if (!store.get('token')) {
      store.set('pochetteSpotify', true);
      await login();
      return;
    }
    await play('spotify', 'Lecture de tes titres Spotify…', async () => {
      // The solo blindtest may already have them all; otherwise the 200 most recent are enough.
      const liked = store.get('liked') || [];
      if (!liked.length) {
        for (let offset = 0; offset < 200; offset += 50) {
          const data = await api(`/me/tracks?limit=50&offset=${offset}`);
          for (const it of data.items) { const t = toTrack(it.track, it.added_at); if (t) liked.push(t); }
          if (!data.next) break;
        }
      }
      const top = (await api('/me/top/tracks?limit=50&time_range=medium_term')).items.map((t) => toTrack(t, null)).filter(Boolean);
      return [...liked, ...top];
    }, (e) => {
      // api() shows its "not allowed" screen: the player stays on this panel instead.
      if (e.notRegistered) { toPanel(); return 'Ton compte Spotify n’est pas encore autorisé sur le jeu (Spotify limite le nombre de comptes pour l’instant). Choisis une autre source.'; }
      if (/token|non connecté|refresh/i.test(e.message || '')) { store.del('token'); return 'Ta connexion Spotify a expiré. Touche « Mon compte Spotify » pour te reconnecter.'; }
      return null;
    });
  }

  async function searchDeezer(e) {
    e.preventDefault();
    const q = $('#cv-dz-query').value.trim();
    const list = $('#cv-dz-results');
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

  /* ---------- Game ---------- */

  // Five albums with a cover, of five different artists, from the songs picked.
  // out: where the progress shows; alive: false once the player went elsewhere. Resolves to true once the game starts.
  async function deal(from, out, alive) {
    const list = candidates(from.list);
    if (list.length < ROUNDS) throw new Error(`Il faut au moins ${ROUNDS} albums différents dans ces titres. Choisis une autre source.`);
    const rounds = [];
    const artists = new Set();
    for (const e of list) {
      if (rounds.length === ROUNDS) break;
      if (artists.has(norm(e.artist))) continue;
      out(`Préparation des pochettes… ${rounds.length} / ${ROUNDS}`);
      const a = await details(e).catch((err) => { throw new Error(`Deezer ne répond pas (${err.message}).`); });
      if (!a) continue;
      rounds.push(a);
      artists.add(norm(a.artist));
    }
    if (rounds.length < 3) throw new Error('Pas assez de pochettes retrouvées. Choisis une autre source.');
    out('');
    if (!alive()) return false;
    Stats.track('pochette-lancee', { source: from.source });
    begin(rounds, list, null);
    return true;
  }

  // « Rejouer » on the end screen: five other covers from the same music.
  async function again() {
    if (!picked) return;
    const button = $('#cv-again');
    const out = (text, error = false) => { $('#cv-share-feedback').textContent = text; $('#cv-share-feedback').classList.toggle('error', error); };
    button.disabled = true;
    try {
      await deal(picked, out, () => !$('#screen-cover').classList.contains('hidden'));
    } catch (e) {
      out(e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function begin(rounds, library, challenge) {
    game = { rounds, index: 0, results: [], library, challenge };
    store.set('coversSeen', [...rounds.map((r) => r.key), ...(store.get('coversSeen') || [])].slice(0, 60));
    $('#cv-end').classList.add('hidden');
    $('#cv-game').classList.remove('hidden');
    show('screen-cover');
    window.scrollTo(0, 0);
    openRound();
  }

  /* ---------- Challenges: the same covers for a friend ---------- */

  const VERDICTS = ['right', 'artist', 'wrong', 'skip'];
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

  // The link: name, score and grid of the player, and the Deezer ids of the albums (those Deezer knows).
  function dareLink() {
    const ids = game.rounds.map((r) => r.dzId).filter(Boolean);
    if (ids.length < 3) return null;
    const grid = game.results.filter((r) => r.album.dzId).map((r) => r.tries.map((t) => VERDICTS.indexOf(t.verdict)).join(''));
    const code = b64(JSON.stringify({ v: 1, n: playerName(), s: points(), a: ids, g: grid }));
    return `${location.origin}${location.pathname}#p=${code}`;
  }

  // Links come from anyone: every value is checked and bounded.
  function readDare(code) {
    const raw = JSON.parse(unb64(code));
    if (raw?.v !== 1 || !Array.isArray(raw.a)) throw new Error('lien invalide');
    const ids = raw.a.map(String).filter((id) => /^\d{1,12}$/.test(id)).slice(0, ROUNDS);
    if (ids.length < 3) throw new Error('lien invalide');
    const grid = (Array.isArray(raw.g) ? raw.g : []).slice(0, ROUNDS).map((l) => String(l).replace(/[^0-3]/g, '').slice(0, TRIES));
    const score = Math.max(0, Math.min(ids.length * TRIES, Math.round(Number(raw.s)) || 0));
    return { name: String(raw.n || '').slice(0, 40) || 'Un pote', score, ids, grid };
  }

  const gridText = (lines) => lines.map((l) => [...l].map((d) => MARK[VERDICTS[d]] || '').join('')).join('\n');

  // Called at start-up: a #p= link shows its challenge on the home screen.
  function capture() {
    const code = location.hash.match(/^#p=([A-Za-z0-9_-]+)$/)?.[1];
    if (!code) return;
    history.replaceState(null, '', location.pathname + location.search);
    try { dare = readDare(code); } catch { return; }
    Stats.track('pochette-defi-ouvert');
    for (const box of document.querySelectorAll('.cv-dare')) {
      box.querySelector('.challenge-title').textContent = `${dare.name} te défie à Pochette surprise !`;
      box.querySelector('.status').textContent = `${dare.ids.length} pochettes · score à battre : ${dare.score} / ${dare.ids.length * TRIES}. Pas besoin de compte.`;
      box.classList.remove('hidden');
    }
  }

  function dropDare() {
    dare = null;
    for (const box of document.querySelectorAll('.cv-dare')) box.classList.add('hidden');
  }

  async function startDare(button) {
    const d = dare;
    if (!d) return;
    const out = button.closest('.cv-dare').querySelector('.cv-dare-status');
    button.disabled = true;
    out.textContent = 'Préparation des pochettes…';
    try {
      const rounds = [];
      for (const id of d.ids) {
        const a = await Deezer.album.get(id).catch(() => null);
        const cover = a?.cover_xl || a?.cover_big;
        if (!cover) continue;
        const first = (a.tracks?.data || []).find((t) => t.preview);
        const e = { title: a.title, artist: a.artist?.name || '', albumId: a.id, tracks: first ? [{ uri: `dz:${first.id}`, preview: first.preview, name: first.title }] : [] };
        rounds.push({ ...e, key: keyOf(e), dzId: String(a.id), artistId: a.artist?.id || null, cover, year: parseInt(a.release_date, 10) || null, genre: a.genres?.data?.[0]?.name || '', size: a.nb_tracks || null });
      }
      if (rounds.length < 3) throw new Error('Deezer ne retrouve plus ces albums.');
      out.textContent = '';
      dropDare();
      begin(rounds, [], d);
    } catch (e) {
      out.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }

  function openRound() {
    const album = game.rounds[game.index];
    round = { album, tries: [], done: false, found: false, artist: '' }; // artist: the right one, once named
    clearTimeout(snippetTimer);
    Deezer.player.pause();
    $('#cv-num').textContent = `${game.index + 1} / ${game.rounds.length}`;
    $('#cv-bar').style.width = `${(game.index / game.rounds.length) * 100}%`;
    $('#cv-score').textContent = points();
    $('#cv-play').classList.remove('hidden');
    $('#cv-result').classList.add('hidden');
    $('#cv-guess').value = '';
    clearTimeout(suggestTimer);
    suggestSeq++; // a search still on its way is dropped
    $('#cv-suggest').replaceChildren();
    shown = [];
    $('#cv-tries').replaceChildren();
    $('#cv-sound').textContent = '';
    image = null;
    draw();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (round?.album === album) { image = img; draw(); } };
    // Some image hosts refuse cross-origin requests: the cover still shows, the canvas just can't be read back.
    img.onerror = () => { if (!img.dataset.retry) { img.dataset.retry = '1'; img.removeAttribute('crossorigin'); img.src = album.cover; } };
    img.src = album.cover;
    hints();
    // The next cover loads in the background.
    const next = game.rounds[game.index + 1];
    if (next) new Image().src = next.cover;
    // On a phone the keyboard would hide the cover: no focus there.
    if (!matchMedia('(pointer: coarse)').matches) $('#cv-guess').focus({ preventScroll: true });
  }

  // The cover, drawn in a few big squares: smaller ones after each try, the real one at the end.
  function draw() {
    const canvas = $('#cv-canvas');
    const size = canvas.width;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2724';
    ctx.fillRect(0, 0, size, size);
    if (!image) return;
    const step = round.done ? null : BLOCKS[Math.min(round.tries.length, BLOCKS.length - 1)];
    if (!step) { ctx.imageSmoothingEnabled = true; ctx.drawImage(image, 0, 0, size, size); return; }
    const small = document.createElement('canvas');
    small.width = small.height = step;
    small.getContext('2d').drawImage(image, 0, 0, step, step);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, size, size);
  }

  // One more clue after each try.
  function hints() {
    const a = round.album;
    const n = round.done ? TRIES : round.tries.length;
    const rows = [];
    if (n >= 1) rows.push(['Sortie', a.year || 'inconnue']);
    if (n >= 2) rows.push(['Album', [a.genre, a.size ? `${a.size} titre${a.size > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || 'pas plus d’infos']);
    if (round.done) rows.push(['Artiste', a.artist]);
    else if (n >= 3) rows.push(['Artiste', a.artist.replace(/[\p{L}\p{N}]/gu, (c, i) => (i === 0 || /\s/.test(a.artist[i - 1]) ? c : '·'))]);
    $('#cv-hints').replaceChildren(...rows.map(([k, v], i) => el('li', { style: `--i: ${i}` }, [el('span', { className: 'status', textContent: k }), el('strong', { textContent: String(v) })])));
    $('#cv-listen').classList.toggle('hidden', n < 4 || round.done);
    const left = TRIES - round.tries.length;
    $('#cv-left').textContent = round.done ? '' : `${left} essai${left > 1 ? 's' : ''} · ${n < 4 ? `indice à chaque essai` : 'tu peux écouter un extrait'}`;
  }

  /* ---------- Guesses ---------- */

  // right: the album; artist: another album of the right artist; wrong; skip.
  function judge(guess) {
    const a = round.album;
    if (guess.id && a.dzId && guess.id === a.dzId) return 'right';
    const title = sameTitle(guess.title, a.title);
    if (!guess.artist) return title ? 'right' : 'wrong';
    const artist = Scoring.artists(guess.artist, [a.artist]) >= 10;
    return title && artist ? 'right' : artist ? 'artist' : 'wrong';
  }

  function guess(g) {
    if (!round || round.done) return;
    const verdict = g ? judge(g) : 'skip';
    round.tries.push({ verdict, key: g?.artist ? keyOf(g) : null, text: g ? (g.artist ? `${g.title} — ${g.artist}` : g.title) : 'Passé' });
    $('#cv-guess').value = '';
    clearTimeout(suggestTimer);
    suggestSeq++; // a search still on its way is dropped
    $('#cv-suggest').replaceChildren();
    shown = [];
    if (verdict === 'right') { round.found = true; round.done = true; } else if (round.tries.length >= TRIES) round.done = true;
    paintTries();
    draw();
    hints();
    if (round.done) { finishRound(); return; }
    if (verdict === 'artist') round.artist = g.artist;
    $('#cv-sound').textContent = verdict === 'artist' ? 'Bon artiste, mais pas cet album : choisis parmi ses albums.' : '';
    // The right artist stays in the field: only the album is left to find.
    if (round.artist) { $('#cv-guess').value = round.artist; suggest(); }
  }

  // The site's squares, as in the blindtest grid: found, half (the right artist), missed.
  const MARK = { right: '🟧', artist: '🟫', wrong: '⬛', skip: '⬛' };

  function paintTries() {
    $('#cv-tries').replaceChildren(...round.tries.map((t, i) => el('li', { className: t.verdict, style: `--i: ${i}` }, [
      el('span', { textContent: MARK[t.verdict], ariaHidden: 'true' }),
      el('span', { textContent: t.text }),
    ])));
  }

  // An artist's albums, fetched once per game.
  const discographies = new Map();
  // The artist named is the right one: their Deezer id is the album's, when Deezer has the album.
  function discography(name) {
    const k = norm(name);
    if (!discographies.has(k)) discographies.set(k, Deezer.album.ofArtist(name, round.album.artistId).catch(() => { discographies.delete(k); return []; }));
    return discographies.get(k);
  }

  // Suggestions: the player's own albums that match, then Deezer's. Never a cover: it would give it away.
  function suggest() {
    clearTimeout(suggestTimer);
    const q = $('#cv-guess').value.trim();
    const box = $('#cv-suggest');
    if (q.length < 2) { shown = []; box.replaceChildren(); return; }
    const n = norm(q);
    // The right artist in the field: all of their albums, not a mix of everything that matches.
    const artistOnly = !!round.artist && n === norm(round.artist);
    const max = artistOnly ? 60 : 8;
    // Albums already tried are not offered again.
    const keys = new Set(round.tries.filter((t) => t.key).map((t) => t.key));
    const fresh = (a) => !keys.has(keyOf(a)) && keys.add(keyOf(a));
    // The order is Deezer's, which knows nothing of the answer. The player's own albums come only after,
    // in alphabetical order, when Deezer does not have them: listed first, the answer (always one of
    // them, and the first drawn) was too often on top.
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      const found = await (artistOnly ? discography(q) : Deezer.album.search(q, max)).catch(() => []);
      if (seq !== suggestSeq) return;
      const mine = game.library.filter((e) => (artistOnly ? norm(e.artist) === n : norm(e.title).includes(n) || norm(e.artist).includes(n)))
        .map((e) => ({ title: e.title, artist: e.artist, id: null }))
        .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
      render([...found, ...mine].filter(fresh).slice(0, max));
    }, artistOnly ? 0 : 250);
    function render(list) {
      shown = list;
      box.replaceChildren(...list.map((a) => el('li', {}, el('button', { type: 'button', onclick: () => guess(a) }, [
        el('strong', { textContent: a.title }), el('span', { className: 'status', textContent: a.artist }),
      ]))));
    }
  }

  // Enter: the suggestion whose title is the typed text, or the typed text as an album title.
  function submit(e) {
    e.preventDefault();
    const text = $('#cv-guess').value.trim();
    if (!text) return;
    const same = shown.find((a) => sameTitle(text, a.title));
    guess(same || { title: text, artist: '', id: null });
  }

  // A few seconds of one of the player's songs from this album.
  async function listen() {
    Deezer.player.activateElement();
    const t = round.album.tracks[0];
    $('#cv-sound').textContent = 'Chargement de l’extrait…';
    try {
      if (!t || !(t.uri?.startsWith('dz:') ? await Deezer.refresh(t) : await Deezer.resolve(t))) throw new Error('Pas d’extrait pour cet album.');
      await Deezer.player.play(t.preview, 8);
      $('#cv-sound').textContent = '';
      clearTimeout(snippetTimer);
      snippetTimer = setTimeout(() => Deezer.player.pause(), SNIPPET_MS);
    } catch (e) {
      if (!e.replaced) $('#cv-sound').textContent = e.message;
    }
  }

  /* ---------- Results ---------- */

  const pointsOf = (r) => (r.found ? TRIES + 1 - r.tries.length : 0);
  const points = () => game.results.reduce((s, r) => s + pointsOf(r), 0);
  const line = (r) => r.tries.map((t) => MARK[t.verdict]).join('');

  function finishRound() {
    clearTimeout(snippetTimer);
    game.results.push(round);
    const a = round.album;
    $('#cv-play').classList.add('hidden');
    $('#cv-result').classList.remove('hidden');
    $('#cv-title').textContent = a.title;
    $('#cv-artist').textContent = [a.artist, a.year].filter(Boolean).join(' · ');
    $('#cv-verdict').textContent = round.found ? `Trouvé en ${round.tries.length} essai${round.tries.length > 1 ? 's' : ''} : +${pointsOf(round)}` : 'Raté !';
    $('#cv-score').textContent = points();
    $('#cv-bar').style.width = `${((game.index + 1) / game.rounds.length) * 100}%`;
    const last = game.index === game.rounds.length - 1;
    $('#cv-next').textContent = last ? 'Voir le score' : 'Pochette suivante';
    $('#cv-next').focus({ preventScroll: true });
  }

  function next() {
    Deezer.player.pause();
    if (game.index < game.rounds.length - 1) { game.index++; openRound(); return; }
    end();
  }

  function end() {
    const max = game.rounds.length * TRIES;
    $('#cv-game').classList.add('hidden');
    $('#cv-end').classList.remove('hidden');
    $('#cv-end-score').textContent = `${points()} / ${max}`;
    $('#cv-end-grid').replaceChildren(game.results.map(line).join('\n'));
    $('#cv-end-recap').replaceChildren(...game.results.map((r, i) => el('li', { style: `--i: ${i}` }, [
      el('img', { src: r.album.cover, alt: '', loading: 'lazy' }),
      el('span', { textContent: `${r.album.artist} — ${r.album.title}` }),
      el('strong', { textContent: String(pointsOf(r)) }),
    ])));
    $('#cv-share-feedback').textContent = '';
    // Against a friend's link: who wins, and both grids.
    const c = game.challenge;
    $('#cv-end-verdict').classList.toggle('hidden', !c);
    $('#cv-end-grid-them').classList.toggle('hidden', !c);
    if (c) {
      const mine = points();
      $('#cv-end-verdict').textContent = verdictText(mine, c.score, c.name);
      $('#cv-end-grid-them').replaceChildren(el('small', { textContent: c.name }), gridText(c.grid));
      $('#cv-end-grid').prepend(el('small', { textContent: 'Toi' }));
    }
    // « Rejouer » draws from the music picked: none after a challenge opened without one.
    $('#cv-again').classList.toggle('hidden', !picked);
    $('#cv-settings').textContent = picked ? 'Changer de musique' : 'Jouer avec ma musique';
    window.scrollTo(0, 0);
    Stats.track('pochette-finie', { score: Stats.bucket(points(), max), defi: c ? 'oui' : 'non' });
  }

  // The grid and a link to the same covers: the friend who opens it plays them and sees the score to beat.
  async function share() {
    const url = dareLink() || location.origin + location.pathname;
    const text = `Pochette surprise · ${points()} / ${game.rounds.length * TRIES}\n${game.results.map(line).join('\n')}\nÀ toi de battre ça : ${url}`;
    Stats.track('pochette-partage');
    const done = await shareOrCopy({ text }, text);
    if (done === 'copied') $('#cv-share-feedback').textContent = 'Copié ! Colle-le dans ton groupe.';
    if (done === 'failed') $('#cv-share-feedback').textContent = text;
  }

  // The back button: during a game it asks first, like « Quitter la partie ».
  async function back() {
    if (game && !$('#cv-game').classList.contains('hidden')) return confirmQuit();
    quit();
  }

  async function confirmQuit() {
    if (await ask('Abandonner la partie en cours ?', 'Abandonner')) quit();
  }

  // to: where the player goes (the game's panel by default, home from the end screen's « ← Accueil »).
  function quit(to = toPanel) {
    clearTimeout(snippetTimer);
    Deezer.player.pause();
    game = null;
    round = null;
    to();
  }

  function wire() {
    document.querySelector('[data-open="pochette"]').addEventListener('click', () => { renderSources(); say(''); $('#cv-dz-results').replaceChildren(); });
    $('#cv-use-dz').onclick = () => fromDeezer(store.get('deezerUser'));
    $('#cv-use-history').onclick = fromHistory;
    $('#cv-use-spotify').onclick = fromSpotify;
    $('#cv-dz-form').onsubmit = searchDeezer;
    $('#cv-form').onsubmit = submit;
    $('#cv-guess').oninput = suggest;
    $('#cv-skip').onclick = () => guess(null);
    $('#cv-listen').onclick = listen;
    $('#cv-next').onclick = next;
    $('#cv-again').onclick = again;
    $('#cv-settings').onclick = () => quit();
    $('#cv-share').onclick = share;
    $('#cv-quit').onclick = confirmQuit;
    $('#cv-end-back').onclick = () => quit(() => goHome());
    for (const box of document.querySelectorAll('.cv-dare')) {
      box.querySelector('.cv-dare-go').onclick = (e) => startDare(e.currentTarget);
      box.querySelector('.cv-dare-skip').onclick = dropDare;
    }
    capture();
  }

  // At start-up: a challenge link opens on the home screen, and a Spotify login started on the panel comes back to it.
  function boot() {
    if (store.get('pochetteSpotify')) {
      store.del('pochetteSpotify');
      toPanel();
      const error = $('#login-error').textContent;
      if (error) say(error, true);
      else fromSpotify();
      return true;
    }
    if (dare) { goHome(); return true; }
    return false;
  }

  return { wire, boot, back };
})();
