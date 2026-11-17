// « Pochette surprise » : find the album from its cover, pixelated at first, sharper after each try.
// The albums come from the songs loaded on the setup screen (app.js `tracks`); the details (year,
// genre, number of songs) from Deezer. It uses app.js helpers ($, el, show, shuffle, store, backToSetup).
const Covers = (() => {
  const ROUNDS = 5;
  const TRIES = 6;
  const BLOCKS = [6, 10, 16, 26, 44]; // pixels across the cover, try after try; then the real cover
  const SNIPPET_MS = 5000;

  let game = null; // { rounds: [], index, results: [] }
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
      cover,
      year: parseInt(d?.release_date, 10) || e.year || null,
      genre: d?.genres?.data?.[0]?.name || '',
      size: d?.nb_tracks || null,
    };
  }

  /* ---------- Game ---------- */

  async function start() {
    const list = candidates(typeof tracks !== 'undefined' ? tracks : []);
    const say = (text, error = false) => { $('#covers-status').textContent = text; $('#covers-status').classList.toggle('error', error); };
    if (list.length < ROUNDS) { say(`Il faut au moins ${ROUNDS} albums différents dans ces titres. Choisis une autre source.`, true); return; }
    $('#btn-covers').disabled = true;
    say('Préparation des pochettes…');
    try {
      // Five albums with a cover, of five different artists.
      const rounds = [];
      const artists = new Set();
      for (const e of list) {
        if (rounds.length === ROUNDS) break;
        if (artists.has(norm(e.artist))) continue;
        say(`Préparation des pochettes… ${rounds.length} / ${ROUNDS}`);
        const a = await details(e);
        if (!a) continue;
        rounds.push(a);
        artists.add(norm(a.artist));
      }
      if (rounds.length < 3) { say('Pas assez de pochettes retrouvées. Choisis une autre source.', true); return; }
      say('');
      game = { rounds, index: 0, results: [], library: list };
      store.set('coversSeen', [...rounds.map((r) => r.key), ...(store.get('coversSeen') || [])].slice(0, 60));
      Stats.track('pochette-lancee', { source: ($('#opt-source').value || '').split(':')[0] });
      $('#cv-end').classList.add('hidden');
      $('#cv-game').classList.remove('hidden');
      show('screen-cover');
      window.scrollTo(0, 0);
      openRound();
    } catch (e) {
      say(`Deezer ne répond pas (${e.message}).`, true);
    } finally {
      $('#btn-covers').disabled = false;
    }
  }

  function openRound() {
    const album = game.rounds[game.index];
    round = { album, tries: [], done: false, found: false };
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
    round.tries.push({ verdict, text: g ? (g.artist ? `${g.title} — ${g.artist}` : g.title) : 'Passé' });
    $('#cv-guess').value = '';
    clearTimeout(suggestTimer);
    suggestSeq++; // a search still on its way is dropped
    $('#cv-suggest').replaceChildren();
    shown = [];
    if (verdict === 'right') { round.found = true; round.done = true; } else if (round.tries.length >= TRIES) round.done = true;
    paintTries();
    draw();
    hints();
    if (round.done) finishRound();
    else if (verdict === 'artist') $('#cv-sound').textContent = 'Bon artiste, mais pas cet album.';
    else $('#cv-sound').textContent = '';
  }

  const MARK = { right: '🟩', artist: '🟨', wrong: '🟥', skip: '⬛' };

  function paintTries() {
    $('#cv-tries').replaceChildren(...round.tries.map((t, i) => el('li', { className: t.verdict, style: `--i: ${i}` }, [
      el('span', { textContent: MARK[t.verdict], ariaHidden: 'true' }),
      el('span', { textContent: t.text }),
    ])));
  }

  // Suggestions: the player's own albums that match, then Deezer's. Never a cover: it would give it away.
  function suggest() {
    clearTimeout(suggestTimer);
    const q = $('#cv-guess').value.trim();
    const box = $('#cv-suggest');
    if (q.length < 2) { shown = []; box.replaceChildren(); return; }
    const n = norm(q);
    const mine = game.library.filter((e) => norm(e.title).includes(n) || norm(e.artist).includes(n)).slice(0, 4)
      .map((e) => ({ title: e.title, artist: e.artist, id: null }));
    render(mine);
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(async () => {
      const found = await Deezer.album.search(q).catch(() => []);
      if (seq !== suggestSeq) return;
      const keys = new Set(mine.map(keyOf));
      render([...mine, ...found.filter((a) => !keys.has(keyOf(a)) && keys.add(keyOf(a)))].slice(0, 8));
    }, 250);
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
      if (!(t.uri?.startsWith('dz:') ? await Deezer.refresh(t) : await Deezer.resolve(t))) throw new Error('Pas d’extrait pour cet album.');
      await Deezer.player.play(t.preview, 8);
      $('#cv-sound').textContent = '';
      clearTimeout(snippetTimer);
      snippetTimer = setTimeout(() => Deezer.player.pause(), SNIPPET_MS);
    } catch (e) {
      $('#cv-sound').textContent = e.message;
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
    $('#cv-end-grid').textContent = game.results.map(line).join('\n');
    $('#cv-end-recap').replaceChildren(...game.results.map((r, i) => el('li', { style: `--i: ${i}` }, [
      el('img', { src: r.album.cover, alt: '', loading: 'lazy' }),
      el('span', { textContent: `${r.album.artist} — ${r.album.title}` }),
      el('strong', { textContent: String(pointsOf(r)) }),
    ])));
    $('#cv-share-feedback').textContent = '';
    window.scrollTo(0, 0);
    Stats.track('pochette-finie', { score: Stats.bucket(points(), max) });
  }

  async function share() {
    const text = `Pochette surprise · ${points()} / ${game.rounds.length * TRIES}\n${game.results.map(line).join('\n')}`;
    const url = location.origin + location.pathname;
    Stats.track('pochette-partage');
    if (navigator.share) {
      try { await navigator.share({ title: 'Pochette surprise', text, url }); return; } catch { /* closed: copy instead */ }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      $('#cv-share-feedback').textContent = 'Copié : colle-le où tu veux.';
    } catch {
      $('#cv-share-feedback').textContent = text;
    }
  }

  function quit() {
    clearTimeout(snippetTimer);
    Deezer.player.pause();
    game = null;
    round = null;
    backToSetup();
  }

  function wire() {
    $('#btn-covers').onclick = start;
    $('#cv-form').onsubmit = submit;
    $('#cv-guess').oninput = suggest;
    $('#cv-skip').onclick = () => guess(null);
    $('#cv-listen').onclick = listen;
    $('#cv-next').onclick = next;
    $('#cv-again').onclick = () => { backToSetup(); start(); };
    $('#cv-share').onclick = share;
    $('#cv-quit').onclick = quit;
    $('#cv-end-back').onclick = quit;
  }

  return { wire, start };
})();
