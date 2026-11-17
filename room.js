// « Qui écoute ça ? » : rooms played by several people, each on their own phone (server in server/).
// This file handles the lobby (create or join a room, bring one's music, see the others arrive) and the
// game as each phone sees it: the question, the reveal, the podium. Each phone plays the sound, or only the
// host's when everyone is in the same room.
// It uses the helpers of util.js ($, el, store, shuffle, shareOrCopy) and app.js (show, ask, goHome, historyTracks),
// and spotify.js for a player who brings Spotify songs.
const Salle = (() => {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // The site served locally talks to the local server (npm run dev in server/), the published one to ROOMS_URL.
  const BASE = local ? 'http://127.0.0.1:8787' : (typeof ROOMS_URL === 'string' && ROOMS_URL) || '';
  const PER_PLAYER = 15;
  // Closing codes after which coming back makes no sense.
  const FINAL = { 1000: true, 4001: 'L’hôte t’a retiré de la salle.', 4002: true, 4003: 'La salle a expiré.', 4004: 'Cette salle n’existe plus.' };

  let ws = null;
  let room = null; // last state sent by the server
  let me = null; // { id, token, host }
  let saved = null; // { code, name, token, hostKey } kept across reloads
  let retries = 0;
  let retryTimer = null;
  let music = null; // { source, label, avatar, tracks } chosen on this phone
  let changing = false; // the player is picking another source: the server's old one must not hide the picker
  let played = new Set(); // Deezer ids of the songs heard in this room's games: a new draw avoids them

  const available = () => !!BASE;
  // The host leads (starts, moves on, replays); while the host's phone is away, anyone may.
  const hostAway = () => !!room && !room.players.some((p) => p.host && p.online);
  const leads = () => !!me && !!room && (me.host || hostAway());
  const link = (code) => `${location.origin}${location.pathname}?salle=${code}`;
  const save = () => store.set('salle', saved);

  /* ---------- Connection ---------- */

  function status(text, isError = false) {
    for (const id of ['#salle-status', '#room-error']) {
      const p = $(id);
      p.textContent = text;
      p.classList.toggle('error', isError);
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/rooms/${saved.code}/ws`);
    const socket = ws;
    socket.onopen = () => {
      retries = 0;
      send({ t: 'hello', name: saved.name, token: saved.token, hostKey: saved.hostKey, avatar: music?.avatar });
    };
    socket.onmessage = (e) => onMessage(JSON.parse(e.data));
    socket.onclose = (e) => {
      if (socket !== ws) return;
      ws = null;
      const final = FINAL[e.code];
      if (final) { if (typeof final === 'string') end(final); return; }
      // A phone that slept or lost the network comes back on its own, to the same seat.
      $('#room-live').textContent = 'Reconnexion…';
      retryTimer = setTimeout(connect, Math.min(10000, 800 * 2 ** retries++));
    };
  }

  function send(msg) {
    if (ws?.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function onMessage(m) {
    if (m.t === 'welcome') {
      me = m.you;
      saved.token = me.token;
      delete saved.hostKey; // used once: the seat now goes with the token
      save();
      // Music chosen before the connection (or before a reconnection) is sent again, while in the lobby.
      if (music && (!room || room.phase === 'lobby')) send({ t: 'music', source: music.source, avatar: music.avatar, tracks: music.tracks });
      // Answers tapped while the connection was down: the server keeps only the first of each.
      Game.resend();
    } else if (m.t === 'room') {
      const replay = room && room.phase !== 'lobby' && m.phase === 'lobby';
      room = m;
      render();
      if (replay && canReroll()) $('#room-music-status').textContent = 'Nouvelle partie : tire d’autres titres pour ne pas réentendre les mêmes.';
    } else if (m.t === 'round') {
      Game.round(m.round);
    } else if (m.t === 'progress') {
      Game.progress(m);
    } else if (m.t === 'reveal') {
      Game.reveal(m.reveal);
    } else if (m.t === 'final') {
      Game.final(m.final);
    } else if (m.t === 'error') {
      if (['started', 'full', 'expired', 'not-found', 'kicked'].includes(m.code) && !room) { end(m.message); return; }
      status(m.message, true);
    }
  }

  // Leaves the room on this phone (kicked, expired, or by choice) and goes back home.
  function end(message = '') {
    clearTimeout(retryTimer);
    const socket = ws;
    ws = null;
    socket?.close();
    room = null;
    me = null;
    saved = null;
    music = null;
    changing = false;
    played = new Set();
    store.del('salle');
    resetPanel();
    goHome('salle');
    status(message, !!message);
  }

  // Both choices again (create or join), even after an invitation link.
  function resetPanel() {
    $('[data-panel="salle"]').classList.remove('invited');
    $('#salle-join button').textContent = 'Rejoindre';
    $('#salle-code').value = '';
  }

  /* ---------- Create / join ---------- */

  function nameOk() {
    const name = $('#salle-name').value.replace(/\s+/g, ' ').trim();
    if (!name) { status('Choisis un pseudo.', true); $('#salle-name').focus(); return null; }
    store.set('pseudo', name);
    return name;
  }

  async function create() {
    const name = nameOk();
    if (!name) return;
    status('Création de la salle…');
    try {
      const res = await fetch(`${BASE}/rooms`, { method: 'POST' });
      if (res.status === 429) { status('Trop de salles créées d’ici en peu de temps. Réessaie dans une minute.', true); return; }
      if (!res.ok) throw new Error();
      const { code, hostKey } = await res.json();
      Stats.track('salle-creee');
      enter({ code, name, hostKey });
    } catch {
      status('Impossible de créer la salle pour le moment. Réessaie dans un instant.', true);
    }
  }

  async function join(e) {
    e.preventDefault();
    const code = $('#salle-code').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { status('Le code fait 4 lettres.', true); return; }
    const name = nameOk();
    if (!name) return;
    status('Recherche de la salle…');
    try {
      const res = await fetch(`${BASE}/rooms/${code}`);
      if (res.status === 404) { status(`Aucune salle ${code}. Vérifie le code.`, true); return; }
      const info = await res.json();
      if (info.phase !== 'lobby') { status('La partie a déjà commencé dans cette salle.', true); return; }
      if (info.full) { status('Cette salle est pleine.', true); return; }
      Stats.track('salle-rejointe', { via: $('[data-panel="salle"]').classList.contains('invited') ? 'lien' : 'code' });
      enter({ code, name });
    } catch {
      status('Impossible de joindre la salle. Vérifie ta connexion.', true);
    }
  }

  function enter(s) {
    saved = s;
    save();
    room = null;
    status('');
    $('#room-code').textContent = s.code;
    $('#room-link').textContent = link(s.code).replace(/^https?:\/\//, '');
    drawQr(s.code);
    $('#room-music-status').textContent = '';
    renderMusic();
    show('screen-room');
    window.scrollTo(0, 0);
    connect();
  }

  /* ---------- Invitation ---------- */

  async function drawQr(code) {
    const box = $('#room-qr');
    box.replaceChildren();
    try {
      if (!window.qrcode) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js');
      const qr = qrcode(0, 'M');
      qr.addData(link(code));
      qr.make();
      box.innerHTML = qr.createSvgTag(4, 0);
      box.classList.remove('hidden');
    } catch {
      box.classList.add('hidden');
    }
  }

  async function invite() {
    const url = link(saved.code);
    const text = `Rejoins ma salle « Qui écoute ça ? » : code ${saved.code}`;
    const done = await shareOrCopy({ title: 'Qui écoute ça ?', text, url }, url);
    if (done === 'copied') $('#room-live').textContent = 'Lien copié.';
    if (done === 'failed') $('#room-live').textContent = url;
  }

  /* ---------- Music: each phone brings its own ---------- */

  const toPot = (t) => ({ id: t.dzId || t.uri.slice(3), artist: t.artists[0], title: t.name, album: t.album || '', cover: t.cover || '' });

  // m.pool: every song the 15 were drawn from (app tracks), for a new draw. m.seen: the Deezer ids already sent.
  function useMusic(m, redraw = false) {
    // Which music people bring: the source, and likes, top or playlist (read from our own label).
    const choix = m.source === 'history' ? 'historique' : /playlist/.test(m.label) ? 'playlist' : /\btop\b/.test(m.label) ? 'top' : 'likes';
    Stats.track(redraw ? 'salle-retirage' : 'salle-musique', { source: m.source, choix });
    m.seen = new Set([...(m.seen || []), ...m.tracks.map((t) => t.id)]);
    music = m;
    changing = false;
    $('#room-music-status').textContent = '';
    renderMusic();
    send({ t: 'music', source: m.source, avatar: m.avatar, tracks: m.tracks });
  }

  // Only songs the player has liked: first the ones they also play the most, then their other likes.
  // Shuffled, so two games differ.
  const MIN_LIKED = 5;
  // Each artist once before any artist twice, the order kept otherwise: a pot of 15 varied songs.
  function spreadArtists(list) {
    const rank = new Map();
    return list
      .map((t, i) => { const a = (t.artists[0] || '').toLowerCase(); const r = rank.get(a) ?? 0; rank.set(a, r + 1); return { t, r, i }; })
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.t);
  }

  function likedFirst(liked, top) {
    const hot = new Set(top.map((t) => t.uri));
    return [...shuffle(liked.filter((t) => hot.has(t.uri))), ...shuffle(liked.filter((t) => !hot.has(t.uri)).slice(0, 200))];
  }

  // The first PER_PLAYER songs of the list that Deezer can play, once each.
  async function potOf(list) {
    const tracks = [];
    const ids = new Set();
    for (const t of list) {
      if (tracks.length === PER_PLAYER) break;
      if (!t.preview) $('#room-music-status').textContent = `Recherche de tes titres sur Deezer… ${tracks.length} / ${PER_PLAYER}`;
      if (!(t.preview || await Deezer.resolve(t))) continue;
      const p = toPot(t);
      if (!ids.has(p.id)) { ids.add(p.id); tracks.push(p); }
    }
    return tracks;
  }

  // Another 15 from the same source: songs never brought first, then the ones not heard yet, the heard ones last.
  const dzIdOf = (t) => t.dzId || (t.uri?.startsWith('dz:') ? t.uri.slice(3) : '');
  const canReroll = () => !!music?.pool && music.pool.length > music.tracks.length && (!room || room.phase === 'lobby');

  async function reroll() {
    if (!canReroll()) return;
    const m = music;
    const tier = (t) => (played.has(dzIdOf(t)) ? 2 : m.seen.has(dzIdOf(t)) ? 1 : 0);
    const order = [0, 1, 2].flatMap((n) => spreadArtists(shuffle(m.pool.filter((t) => tier(t) === n))));
    $('#room-reroll').disabled = true;
    $('#room-music-status').textContent = 'Nouveau tirage…';
    try {
      const tracks = await potOf(order);
      if (music !== m) return; // another source was chosen meanwhile
      if (tracks.length < 5) throw new Error('Pas assez de titres retrouvés sur Deezer.');
      useMusic({ ...m, tracks }, true);
      const fresh = tracks.filter((t) => !m.seen.has(t.id)).length;
      $('#room-music-status').textContent = fresh === tracks.length ? `${fresh} nouveaux titres.`
        : fresh ? `${fresh} nouveaux titres, ta source n’en a pas plus : les autres sont mélangés.` : 'Ta source n’a pas d’autres titres : les mêmes, dans un autre ordre.';
    } catch (e) {
      $('#room-music-status').textContent = e.message;
    } finally {
      $('#room-reroll').disabled = false;
    }
  }

  /* Which titles: the account's likes first, then its playlists. */

  function showLists(title, rows) {
    pickAgain();
    $('#room-sources').classList.add('hidden');
    $('#room-lists').classList.remove('hidden');
    $('#room-lists-title').textContent = title;
    $('#room-lists-items').replaceChildren(...rows.map((r) => el('li', {}, el('button', { type: 'button', className: 'pick', onclick: r.pick }, [
      r.picture ? el('img', { className: 'avatar list-icon', src: r.picture, alt: '', loading: 'lazy' }) : el('span', { className: 'avatar list-icon', textContent: r.icon || '♪', ariaHidden: 'true' }),
      el('span', {}, [el('strong', { textContent: r.name }), el('span', { className: 'status', textContent: r.detail })]),
    ]))));
    $('#room-lists-items').scrollTop = 0;
  }

  // Back to the sources, even when a music is already in the pot.
  function pickAgain() {
    music = null;
    changing = true;
    renderMusic();
  }

  function hideLists() {
    $('#room-lists').classList.add('hidden');
    $('#room-sources').classList.remove('hidden');
  }

  const count = (n) => (n == null ? '' : `${n} titre${n > 1 ? 's' : ''}`);

  // A playlist: its songs shuffled, as many artists as possible.
  const fromList = (tracks) => spreadArtists(shuffle(tracks));

  // Deezer: the profile's coups de cœur or one of its public playlists.
  async function fromDeezer(user) {
    $('#room-music-status').textContent = `Chargement des playlists de ${user.name}…`;
    try {
      const lists = await Deezer.profile.playlists(user.id);
      const loved = lists.find((p) => p.loved);
      const others = lists.filter((p) => !p.loved && p.total > 0);
      $('#room-music-status').textContent = '';
      if (!others.length) return deezerLiked(user, lists);
      showLists(`Quels titres de ${user.name} ?`, [
        { name: 'Mes coups de cœur', detail: loved ? count(loved.total) : 'les plus écoutés, faute de coups de cœur', icon: '♥', pick: () => deezerLiked(user, lists) },
        ...others.map((p) => ({ name: p.title, detail: count(p.total), picture: p.picture, pick: () => deezerPlaylist(user, p) })),
      ]);
    } catch (e) {
      $('#room-music-status').textContent = e.deezer ? 'Profil introuvable ou privé.' : e.message;
    }
  }

  async function deezerPlaylist(user, p) {
    $('#room-music-status').textContent = `Chargement de « ${p.title} »…`;
    try {
      const all = await Deezer.profile.playlist(p.id, 500);
      const tracks = await potOf(fromList(all));
      if (tracks.length < 5) throw new Error('Pas assez de titres écoutables dans cette playlist. Choisis-en une autre.');
      hideLists();
      useMusic({ source: 'deezer', label: `ta playlist « ${p.title} »`, avatar: user.picture || '', tracks, pool: all });
    } catch (e) {
      $('#room-music-status').textContent = e.deezer ? 'Playlist introuvable ou privée.' : e.message;
    }
  }

  // The coups de cœur (the most played ones first), or the top when there are too few of them.
  async function deezerLiked(user, lists) {
    $('#room-music-status').textContent = `Chargement des coups de cœur de ${user.name}…`;
    try {
      const top = await Deezer.profile.top(user.id).catch(() => []);
      const loved = lists.find((p) => p.loved);
      const liked = loved ? await Deezer.profile.playlist(loved.id, 500) : [];
      const enough = liked.length >= MIN_LIKED;
      const pool = spreadArtists(enough ? likedFirst(liked, top) : shuffle(top.slice(0, 40)));
      const tracks = await potOf(pool);
      if (tracks.length < 5) throw new Error('Ce profil n’a pas assez de coups de cœur publics. Il doit être public sur Deezer.');
      const label = enough ? `tes coups de cœur Deezer (${user.name})` : `ton top Deezer (${user.name}), faute de coups de cœur`;
      hideLists();
      useMusic({ source: 'deezer', label, avatar: user.picture || '', tracks, pool: enough ? liked : top });
    } catch (e) {
      $('#room-music-status').textContent = e.deezer ? 'Profil introuvable ou privé.' : e.message;
    }
  }

  async function fromHistory() {
    // The 60 most played songs first; a new draw goes further down the history.
    const all = historyTracks().slice(0, 150);
    const tracks = await potOf(spreadArtists(shuffle(all.slice(0, 60))));
    if (tracks.length < 5) { $('#room-music-status').textContent = 'Pas assez de titres retrouvés sur Deezer.'; return; }
    useMusic({ source: 'history', label: 'ton historique d’écoute', avatar: music?.avatar || '', tracks, pool: all });
  }

  // Spotify: the player's liked songs (the ones they also play the most first), each found on Deezer for
  // the preview. Their top tracks only when they have liked too few songs.
  // Without a session yet, the login leaves the page; boot() brings the phone back here and resumes.
  async function fromSpotify() {
    if (!store.get('token')) {
      store.set('salleSpotify', true);
      await login();
      return;
    }
    const say = (text) => { $('#room-music-status').textContent = text; };
    say('Lecture de tes playlists Spotify…');
    try {
      // Spotify only opens the playlists the player made or collaborates on.
      const meId = (await spotifyMe())?.id;
      const lists = [];
      for (let offset = 0; offset < 100; offset += 50) {
        const data = await api(`/me/playlists?limit=50&offset=${offset}`);
        lists.push(...data.items.filter((p) => p && (!meId || p.owner?.id === meId || p.collaborative)));
        if (!data.next) break;
      }
      say('');
      const usable = lists.filter((p) => ((p.items ?? p.tracks)?.total ?? 1) > 0);
      if (!usable.length) return spotifyLiked();
      showLists('Quels titres de ton Spotify ?', [
        { name: 'Mes titres likés', detail: 'les plus écoutés d’abord', icon: '♥', pick: spotifyLiked },
        ...usable.map((p) => ({ name: p.name, detail: count((p.items ?? p.tracks)?.total), picture: p.images?.[0]?.url, pick: () => spotifyPlaylist(p) })),
      ]);
    } catch (e) {
      spotifyError(e);
    }
  }

  // Spotify counts every call: the profile is read once per visit.
  let me_ = null;
  async function spotifyMe() {
    if (!me_) me_ = await api('/me').catch((e) => { if (e.rateLimited) throw e; return null; });
    return me_;
  }

  // Finds the songs on Deezer, for the preview, until there are enough of them.
  // first: the songs to try first, in order; all: every song of the source, for a new draw.
  async function spotifyPot(first, label, all) {
    const avatar = (await spotifyMe())?.images?.[0]?.url || music?.avatar || '';
    const tracks = await potOf(first);
    if (tracks.length < 5) throw new Error('Pas assez de titres retrouvés sur Deezer. Choisis une autre source.');
    hideLists();
    useMusic({ source: 'spotify', label, avatar, tracks, pool: all });
  }

  async function spotifyPlaylist(p) {
    $('#room-music-status').textContent = `Lecture de « ${p.name} »…`;
    try {
      const list = [];
      for (let offset = 0; offset < 200; offset += 50) {
        const data = await api(`/playlists/${encodeURIComponent(p.id)}/items?limit=50&offset=${offset}`);
        for (const it of data.items) { const t = toTrack(it.item ?? it.track, it.added_at); if (t) list.push(t); }
        if (!data.next) break;
      }
      await spotifyPot(fromList(list).slice(0, 60), `ta playlist « ${p.name} »`, list);
    } catch (e) {
      spotifyError(e);
    }
  }

  async function spotifyLiked() {
    const say = (text) => { $('#room-music-status').textContent = text; };
    say('Lecture de tes titres Spotify…');
    try {
      const top = [];
      for (const range of ['short_term', 'medium_term']) {
        const data = await api(`/me/top/tracks?limit=50&time_range=${range}`);
        for (const t of data.items) {
          const track = toTrack(t, null);
          if (track && !top.some((x) => x.uri === track.uri)) top.push(track);
        }
        if (top.length >= 30) break;
      }
      say('Lecture de tes titres likés…');
      // The solo game may already have them all; otherwise the 200 most recent are enough.
      let liked = store.get('liked') || [];
      if (!liked.length) {
        for (let offset = 0; offset < 200; offset += 50) {
          const data = await api(`/me/tracks?limit=50&offset=${offset}`);
          for (const it of data.items) { const t = toTrack(it.track, it.added_at); if (t) liked.push(t); }
          if (!data.next) break;
        }
      }
      const enough = liked.length >= MIN_LIKED;
      await spotifyPot(spreadArtists(enough ? likedFirst(liked, top) : shuffle(top.slice(0, 40))), enough ? 'tes titres likés Spotify' : 'ton top Spotify, faute de titres likés', enough ? liked : top);
    } catch (e) {
      spotifyError(e);
    }
  }

  function spotifyError(e) {
    const say = (text) => { $('#room-music-status').textContent = text; };
    // api() shows its "not allowed" screen: this phone stays in the room instead.
    if (e.notRegistered) {
      show('screen-room');
      hideLists();
      say('Ton compte Spotify n’est pas encore autorisé sur le jeu (Spotify limite le nombre de comptes pour l’instant). Choisis une autre source.');
    } else if (/token|non connecté|refresh/i.test(e.message || '')) {
      // A session that no longer works: forget it, the next tap logs in again.
      store.del('token');
      hideLists();
      say('Ta connexion Spotify a expiré. Touche « Mon compte Spotify » pour te reconnecter.');
    } else {
      say(e.message || 'Spotify ne répond pas. Réessaie ou choisis une autre source.');
    }
  }

  async function searchDeezer(e) {
    e.preventDefault();
    const q = $('#room-dz-query').value.trim();
    const list = $('#room-dz-results');
    list.replaceChildren();
    if (!q) return;
    const id = Deezer.profile.id(q);
    $('#room-music-status').textContent = 'Recherche…';
    try {
      const users = id ? [await Deezer.profile.user(id)] : await Deezer.profile.search(q);
      $('#room-music-status').textContent = users.length ? 'Lequel est ton profil ?' : 'Aucun profil à ce nom. Essaie le lien de ton profil.';
      list.replaceChildren(...users.map((u) => el('li', {}, el('button', { type: 'button', className: 'pick', onclick: () => fromDeezer(u) }, [
        avatarOf(u.picture, u.name), el('span', { textContent: u.name }),
      ]))));
    } catch {
      $('#room-music-status').textContent = 'Profil introuvable ou privé.';
    }
  }

  function renderMusic() {
    // After a reload the music is only known by the server: the lobby says so instead of asking again.
    const mine = room?.players.find((p) => p.id === me?.id);
    const chosen = !changing && (!!music || !!mine?.source);
    $('#room-music-chosen').classList.toggle('hidden', !chosen);
    $('#room-music-pick').classList.toggle('hidden', chosen);
    if (music) $('#room-music-label').textContent = `${music.tracks.length} titres de ${music.label}`;
    else if (chosen) $('#room-music-label').textContent = `${mine.tracks} titres (${SOURCE_NAMES[mine.source]})`;
    $('#room-reroll').classList.toggle('hidden', !canReroll());
    const dz = store.get('deezerUser');
    $('#room-use-mine').classList.toggle('hidden', !dz);
    if (dz) $('#room-use-mine').textContent = `Mon profil Deezer : ${dz.name}`;
    $('#room-use-history').classList.toggle('hidden', !store.get('history'));
    $('#room-use-spotify').classList.toggle('hidden', !(SPOTIFY_CLIENT_ID || store.get('clientId')));
  }

  /* ---------- Lobby ---------- */

  function avatarOf(src, name) {
    return src
      ? el('img', { className: 'avatar', src, alt: '', loading: 'lazy' })
      : el('span', { className: 'avatar', textContent: (name || '?').slice(0, 1).toUpperCase(), ariaHidden: 'true' });
  }

  const SOURCE_NAMES = { deezer: 'Deezer', history: 'historique', spotify: 'Spotify' };

  function render() {
    if (!room || !me) return;
    me.host = !!room.players.find((p) => p.id === me.id)?.host;
    $('#room-live').textContent = '';
    const list = $('#room-players');
    list.replaceChildren(...room.players.map((p, i) => {
      const status = !p.online ? 'hors ligne' : p.source ? `prêt · ${p.tracks} titres (${SOURCE_NAMES[p.source]})` : 'choisit sa musique…';
      return el('li', { className: `${p.online ? '' : 'off'} ${p.source ? 'ready' : ''}`, style: `--i: ${i}` }, [
        avatarOf(p.avatar, p.name),
        el('div', { className: 'who' }, [
          el('strong', { textContent: p.name + (p.id === me.id ? ' (toi)' : '') }),
          el('span', { className: 'status', textContent: (p.host ? 'hôte · ' : '') + status }),
        ]),
        me.host && p.id !== me.id
          ? el('button', { type: 'button', className: 'kick', textContent: 'Retirer', ariaLabel: `Retirer ${p.name}`, onclick: async () => { if (await ask(`Retirer ${p.name} de la salle ?`, 'Retirer')) send({ t: 'kick', id: p.id }); } })
          : '',
      ]);
    }));
    $('#room-count').textContent = `${room.players.length} / 8`;
    renderMusic();

    // During a game the lobby steps aside: the round takes the whole screen.
    const playing = room.phase !== 'lobby';
    $('.room-grid').classList.toggle('in-game', playing);
    $('#room-lobby').classList.toggle('hidden', playing);
    $('#room-people').classList.toggle('hidden', playing);
    $('#room-game').classList.toggle('hidden', !playing);
    if (!playing) Game.reset();
    Game.scores();

    // The sound: on every phone, or only on the host's when everyone sits around it.
    $('#room-same-row').classList.toggle('hidden', !me.host);
    $('#room-same').checked = !!room.sameRoom;
    // A server not yet updated knows no countdown (it leaves the field out): the box would untick itself.
    $('#room-countdown-row').classList.toggle('hidden', !me.host || !('countdown' in room));
    $('#room-countdown').checked = !!room.countdown;
    $('#room-same-info').textContent = (room.sameRoom
      ? (me.host ? 'Le son sort seulement de ton téléphone : monte le volume.' : 'Le son sort du téléphone de l’hôte.')
      : (me.host ? 'Le son sort de chaque téléphone. Coche si vous êtes ensemble, pour éviter l’écho.' : 'Le son sort de chaque téléphone : monte le volume.'))
      + (room.countdown && !me.host ? ' Un décompte 3, 2, 1 précède chaque extrait.' : '');

    const missing = room.players.filter((p) => !p.source).map((p) => p.name);
    const startBtn = $('#room-start');
    startBtn.classList.toggle('hidden', !leads());
    startBtn.disabled = room.players.length < 2 || missing.length > 0;
    $('#room-wait').textContent = room.players.length < 2
      ? 'Invite au moins une autre personne pour jouer.'
      : missing.length ? `En attente de la musique de ${missing.join(', ')}.`
        : me.host ? 'Tout le monde est prêt !'
          : leads() ? 'Tout le monde est prêt. L’hôte est déconnecté : tu peux lancer la partie.' : 'Tout le monde est prêt. L’hôte va lancer la partie.';
    Game.leaders();
  }

  function start() {
    Stats.track('salle-lancee', { joueurs: String(room?.players.length || 0), son: room?.sameRoom ? 'meme-piece' : 'chaque-telephone' });
    // Inside the tap: phones only let a page play sound after a touch.
    Deezer.player.activateElement();
    send({ t: 'start' });
  }

  /* ---------- Game: question, reveal, podium ---------- */

  const Game = (() => {
    let round = null; // RoundView
    let offset = 0; // server clock − this device's clock
    let ticker = null;
    let cast = [];
    let soundFor = -1; // round whose sound this device already started
    let local = { index: -1, a: {} }; // this phone's answers to the current round, kept across reconnections
    let shown = null; // the reveal on screen, for the "next" button when the host comes and goes

    const person = (id) => cast.find((c) => c.id === id) || room?.players.find((p) => p.id === id) || { id, name: '?', avatar: '' };
    const scoreOf = (id) => room?.players.find((p) => p.id === id)?.score ?? 0;
    const remaining = () => (round ? round.deadline - (Date.now() + offset) : 0);
    const untilStart = () => (round ? round.startedAt - (Date.now() + offset) : 0); // > 0 during the countdown
    const view = (name) => { for (const v of ['question', 'reveal', 'final']) $(`#rg-${v}`).classList.toggle('hidden', v !== name); };

    function reset() {
      clearInterval(ticker);
      round = null;
      shown = null;
      soundFor = -1;
      local = { index: -1, a: {} };
      Deezer.player.pause();
    }

    function scores() {
      if (me) $('#rg-score').textContent = scoreOf(me.id);
    }

    function header(index, total) {
      $('#rg-num').textContent = `${index + 1} / ${total}`;
      $('#rg-bar').style.width = `${(index / total) * 100}%`;
      scores();
    }

    /* Question */

    function round_(r) {
      round = r;
      shown = null;
      cast = r.cast;
      offset = r.now - Date.now();
      header(r.index, r.total);
      view('question');
      $('#rg-question').classList.toggle('done', false);

      // What the server already has, completed by what this phone tapped while offline.
      const mine = { ...(local.index === r.index ? local.a : {}), ...r.mine };
      local = { index: r.index, a: mine };
      let counting = untilStart() > 0;
      const answer = (field, value) => {
        if (mine[field] !== undefined || remaining() <= 0 || counting) return;
        mine[field] = value;
        send({ t: 'answer', index: r.index, [field]: value });
        paint(field);
      };
      $('#rg-owners').replaceChildren(...r.cast.map((c) => el('button', {
        type: 'button', className: 'owner', onclick: () => answer('owner', c.id),
      }, [avatarOf(c.avatar, c.name), el('span', { textContent: c.id === me.id ? `${c.name} (moi)` : c.name })])));
      $('#rg-songs').replaceChildren(...r.songs.map((s, i) => el('button', {
        type: 'button', onclick: () => answer('song', i),
      }, [el('strong', { textContent: s.title }), el('span', { className: 'status', textContent: s.artist })])));

      function paint(just) {
        [...$('#rg-owners').children].forEach((b, i) => {
          b.setAttribute('aria-pressed', String(r.cast[i].id === mine.owner));
          b.disabled = counting || mine.owner !== undefined;
        });
        [...$('#rg-songs').children].forEach((b, i) => {
          b.setAttribute('aria-pressed', String(i === mine.song));
          b.disabled = counting || mine.song !== undefined;
        });
        const both = mine.owner !== undefined && mine.song !== undefined;
        $('#rg-question').classList.toggle('done', both);
        if (both) $('#rg-mine').textContent = 'Réponses envoyées. On attend les autres…';
        else if (mine.owner !== undefined || mine.song !== undefined) {
          // Half done: the other question is often below the fold on a phone.
          const next = mine.owner === undefined ? '#rg-owners' : '#rg-songs';
          $('#rg-mine').textContent = mine.owner === undefined ? 'Et maintenant : à qui est ce titre ?' : 'Et maintenant : quel titre ?';
          const box = $(next).getBoundingClientRect();
          if (just && (box.top < 0 || box.bottom > innerHeight)) $(next).scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      $('#rg-mine').textContent = '';
      paint();
      progress({ index: r.index, answered: r.answered, started: r.started || [] });

      // The clock: a draining bar and the seconds left, on the server's time. With the countdown,
      // "3, 2, 1" first: the bar waits full, the answers stay hidden and the sound starts at the end of it.
      const bar = $('#rg-countdown i');
      const total = r.deadline - r.startedAt;
      const left = Math.max(0, Math.min(total, remaining()));
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.transform = `scaleX(${left / total})`;
      bar.style.animation = `drain ${left}ms linear ${Math.max(0, untilStart())}ms forwards`;
      const stage = $('#rg-question .rg-stage');
      clearInterval(ticker);
      const tick = () => {
        const wait = untilStart();
        stage.classList.toggle('counting', wait > 0);
        // The answers show only at "top": nobody reads the titles ahead of the sound.
        $('#rg-question').classList.toggle('counting', wait > 0);
        $('#rg-stage-q').textContent = wait > 0 ? 'Prêts ?' : 'Qui écoute ça ?';
        if (wait > 0) { $('#rg-time').textContent = Math.ceil(wait / 1000); return; }
        if (counting) { counting = false; paint(); }
        const left = Math.max(0, Math.ceil(remaining() / 1000));
        $('#rg-time').textContent = left;
        if (left === 0) {
          clearInterval(ticker);
          for (const b of document.querySelectorAll('#rg-owners button, #rg-songs button')) b.disabled = true;
          if (mine.owner === undefined || mine.song === undefined) $('#rg-mine').textContent = 'Temps écoulé !';
        }
      };
      tick();
      ticker = setInterval(tick, 250);

      // Every phone plays the sound, or only the host's when everyone is in the same room.
      $('#rg-host').classList.toggle('hidden', !r.trackId);
      if (r.trackId && soundFor !== r.index) { soundFor = r.index; play(r.trackId, r.index); }
    }

    async function play(trackId, index) {
      const t = { uri: `dz:${trackId}` };
      $('#rg-sound').textContent = 'Chargement du son…';
      try {
        if (!(await Deezer.refresh(t))) throw new Error('Extrait introuvable sur Deezer.');
        // Starts a little into the song: the very first notes are often a silence or a jingle.
        await Deezer.player.load(t.preview, 2);
        $('#rg-sound').textContent = '';
        // Loaded during the countdown, played at its end.
        const wait = round?.index === index ? untilStart() : 0;
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        if (round?.index !== index) return; // the game moved on meanwhile
        await Deezer.player.start();
      } catch (e) {
        if (e.replaced) return; // « Réécouter » tapped again: the newer load carries on
        // A reloaded page may not play sound before a touch: the button below does it.
        $('#rg-sound').textContent = e.name === 'NotAllowedError' ? 'Touche « Réécouter » pour lancer le son.' : e.message;
      }
    }

    function progress(m) {
      if (!round || m.index !== round.index) return;
      const done = new Set(m.answered);
      const started = new Set(m.started || []);
      const half = cast.filter((c) => started.has(c.id) && !done.has(c.id)).length;
      $('#rg-answered').replaceChildren(...cast.map((c) => {
        const a = avatarOf(c.avatar, c.name);
        a.classList.toggle('dim', !started.has(c.id) && !done.has(c.id));
        a.classList.toggle('half', started.has(c.id) && !done.has(c.id));
        a.title = c.name;
        return a;
      }));
      $('#rg-answered-text').textContent = `${done.size} / ${cast.length} ont répondu${half ? ` · ${half} à moitié` : ''}`;
    }

    /* Reveal */

    function reveal(v) {
      clearInterval(ticker);
      header(v.index, v.total);
      $('#rg-bar').style.width = `${((v.index + 1) / v.total) * 100}%`;
      view('reveal');
      $('#rv-cover').src = v.track.cover || '';
      $('#rv-cover').classList.toggle('hidden', !v.track.cover);
      $('#rv-title').textContent = v.track.title;
      $('#rv-artist').textContent = v.track.artist;
      $('#rv-owners').replaceChildren(...v.owners.map((id) => {
        const p = person(id);
        return el('span', { className: 'rv-person' }, [avatarOf(p.avatar, p.name), el('strong', { textContent: p.id === me.id ? 'toi' : p.name })]);
      }));
      $('#rv-owners-label').textContent = v.owners.length > 1 ? 'C’était à tous les deux…' : 'C’était à';

      // How many named the right person, among those it wasn't to.
      const guessers = v.results.filter((x) => !v.owners.includes(x.id));
      const right = guessers.filter((x) => x.owner).length;
      $('#rv-found').textContent = guessers.length ? `${right} sur ${guessers.length} ${right > 1 ? 'ont' : 'a'} deviné` : '';

      const rows = ranked(v.results, v.index > 0); // after the first round everyone was tied: no moves to show
      const mine = rows.find((x) => x.id === me.id);
      if (mine) {
        const d = $('#rv-delta');
        d.textContent = mine.delta > 0 ? `+${mine.delta}` : String(mine.delta);
        d.classList.toggle('neg', mine.delta <= 0);
        $('#rv-rank').replaceChildren(`${mine.rank}${mine.rank === 1 ? 'er' : 'e'} `, ...move(mine), el('small', { textContent: ` · ${mine.score} pts` }));
        $('#rv-marks').replaceChildren(mark(mine.owner, 'qui'), mark(mine.song, 'titre'));
        $('#rv-detail').textContent = mine.ownMiss ? 'Tu n’as pas reconnu ton propre titre (−50).' : '';
      }
      const known = v.results.some((x) => 'vote' in x); // a server from before the votes sends none
      $('#rv-head-vote').textContent = known ? 'a voté' : 'qui';
      $('#rv-board').replaceChildren(...rows.map((r, i) => {
        const p = person(r.id);
        const voted = r.vote ? person(r.vote) : null;
        return el('li', { className: `rv-row${r.id === me.id ? ' me' : ''}`, style: `--i: ${i}` }, [
          el('span', { className: 'rv-pos' }, [String(r.rank), ...move(r)]),
          avatarOf(p.avatar, p.name),
          el('span', { className: 'rv-name', textContent: p.id === me.id ? 'Toi' : p.name }),
          el('span', { className: 'rv-vote', title: voted ? `a voté ${voted.name}` : 'pas de vote' },
            known && voted ? [avatarOf(voted.avatar, voted.name), icon(r.owner)] : [icon(r.owner)]),
          el('span', { className: 'rv-mark' }, [icon(r.song)]),
          el('span', { className: 'rv-pts' }, [
            el('strong', { textContent: r.score }),
            el('span', { className: r.delta < 0 ? 'neg' : '', textContent: r.delta > 0 ? `+${r.delta}` : r.delta ? String(r.delta) : '' }),
          ]),
        ]);
      }));

      played.add(v.track.id);
      shown = v;
      leaders();
    }

    // Who may move on: the host, or anyone while the host's phone is away.
    function leaders() {
      if (!room || !me) return;
      const lead = leads();
      const away = lead && !me.host;
      if (shown) {
        $('#rv-next').classList.toggle('hidden', !lead);
        $('#rv-next').textContent = shown.last ? 'Voir le podium' : 'Manche suivante';
        $('#rv-wait').textContent = away ? 'L’hôte est déconnecté : tu peux passer à la suite.'
          : lead ? '' : shown.last ? 'L’hôte va dévoiler le podium…' : 'L’hôte lance la manche suivante…';
      }
      $('#fn-replay').classList.toggle('hidden', !lead);
      $('#fn-wait').textContent = away ? 'L’hôte est déconnecté : tu peux relancer une partie.'
        : lead ? '' : 'L’hôte peut relancer une partie avec les mêmes joueurs.';
    }

    // Ranks after this round and before it (ties share a rank), best first.
    function ranked(results, moves = true) {
      const rank = (x, key) => 1 + results.filter((y) => key(y) > key(x)).length;
      const before = (x) => x.score - x.delta;
      return results.map((x) => {
        const now = rank(x, (y) => y.score);
        return { ...x, rank: now, was: moves ? rank(x, before) : now };
      })
        .sort((a, b) => a.rank - b.rank || b.delta - a.delta);
    }
    // "▲2" or "▼1" next to a rank that moved this round.
    function move(r) {
      const n = r.was - r.rank;
      return n ? [el('small', { className: n > 0 ? 'is-ok' : 'is-ko', textContent: `${n > 0 ? '▲' : '▼'}${Math.abs(n)}` })] : [];
    }
    const icon = (ok) => el('span', { className: ok ? 'is-ok' : 'is-ko', textContent: ok ? '✓' : ok === false ? '✗' : '–', title: ok ? 'trouvé' : ok === false ? 'raté' : 'pas de réponse' });
    const mark = (ok, what) => el('span', { className: ok ? 'is-ok' : 'is-ko', textContent: `${ok ? '✓' : ok === false ? '✗' : '–'} ${what}` });

    function board(list, rows) {
      const sorted = [...rows].sort((a, b) => b.score - a.score);
      list.replaceChildren(...sorted.map((r, i) => {
        const p = person(r.id);
        return el('li', { className: r.id === me.id ? 'me' : '', style: `--i: ${i}` }, [
          el('span', { className: 'rank', textContent: r.rank ?? i + 1 }),
          avatarOf(p.avatar, p.name),
          el('span', { className: 'name', textContent: p.id === me.id ? `${p.name} (toi)` : p.name }),
          r.delta !== undefined ? el('span', { className: `delta ${r.delta < 0 ? 'neg' : ''}`, textContent: r.delta > 0 ? `+${r.delta}` : r.delta ? String(r.delta) : '' }) : '',
          el('strong', { textContent: r.score }),
        ]);
      }));
    }

    /* Podium */

    function final(f) {
      reset();
      cast = f.cast;
      view('final');
      $('#rg-num').textContent = 'Fin';
      $('#rg-bar').style.width = '100%';
      board($('#fn-board'), f.standings);
      const winner = person(f.standings[0]?.id);
      $('#fn-winner').textContent = f.standings[0]?.id === me.id ? 'Tu gagnes !' : `${winner.name} gagne !`;
      $('#fn-awards').replaceChildren(...f.awards.map((a, i) => el('div', { className: 'award', style: `--i: ${i}` }, [
        el('div', { className: 'award-people' }, a.ids.map((id) => avatarOf(person(id).avatar, person(id).name))),
        el('div', {}, [
          el('p', { className: 'award-title', textContent: a.title }),
          el('p', { className: 'award-who', textContent: a.ids.map((id) => (id === me.id ? 'Toi' : person(id).name)).join(' et ') }),
          el('p', { className: 'status', textContent: a.detail }),
        ]),
      ])));
      leaders();
      Stats.track('salle-finie', { joueurs: String(f.cast.length) });
    }

    function wire() {
      $('#rg-replay').onclick = () => { if (round?.trackId) play(round.trackId, round.index); };
      // Taps: they also keep the right to play sound on phones.
      $('#rv-next').onclick = () => { Deezer.player.activateElement(); send({ t: 'next' }); };
      $('#fn-replay').onclick = () => send({ t: 'replay' });
      $('#fn-leave').onclick = back;
    }

    function resend() {
      if (!round || local.index !== round.index) return;
      const { owner, song } = local.a;
      if (owner !== undefined || song !== undefined) send({ t: 'answer', index: round.index, owner, song });
    }

    return { round: round_, progress, reveal, final, reset, scores, wire, resend, leaders };
  })();

  // « Quitter la salle », and the phone's back button: the seat is given up, so it asks first.
  async function back() {
    const playing = room && room.phase === 'playing';
    if (!(await ask(playing ? 'Quitter la salle ? La partie continue sans toi.' : 'Quitter la salle ?', 'Quitter'))) return;
    send({ t: 'leave' });
    end();
  }

  /* ---------- Wiring ---------- */

  // Called by app.js main(): resolves to true when this page is a room (link or ongoing room).
  async function boot() {
    if (!available()) return false;
    $('#tile-salle').classList.remove('hidden');
    $('#salle-name').value = store.get('pseudo') || store.get('deezerUser')?.name || '';
    $('#salle-create').onclick = create;
    // Opened from the home tile: both choices again, even after an invitation link.
    $('#tile-salle').addEventListener('click', resetPanel);
    $('#salle-join').onsubmit = join;
    $('#salle-code').oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); };
    $('#room-invite').onclick = invite;
    $('#room-leave').onclick = back;
    $('#room-start').onclick = start;
    Game.wire();
    $('#room-dz-form').onsubmit = searchDeezer;
    $('#room-use-mine').onclick = () => fromDeezer(store.get('deezerUser'));
    $('#room-use-history').onclick = fromHistory;
    $('#room-use-spotify').onclick = fromSpotify;
    $('#room-lists-back').onclick = () => { hideLists(); $('#room-music-status').textContent = ''; };
    // Both settings each time: a server that only knows sameRoom reads it as before.
    const settings = () => send({ t: 'settings', sameRoom: $('#room-same').checked, countdown: $('#room-countdown').checked });
    $('#room-same').onchange = settings;
    $('#room-countdown').onchange = settings;
    $('#room-reroll').onclick = reroll;
    // Phones only let a page play sound after a touch: any tap in the room unlocks it for the rounds.
    $('#screen-room').addEventListener('click', () => Deezer.player.activateElement(), true);
    $('#room-change').onclick = () => { hideLists(); pickAgain(); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && saved && !ws) { retries = 0; connect(); }
    });

    const params = new URLSearchParams(location.search);
    const code = (params.get('salle') || '').toUpperCase();
    if (code) {
      params.delete('salle');
      history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
    }
    const ongoing = store.get('salle');
    // Back from the Spotify login started in the lobby: carry on with that music.
    const spotifyBack = store.get('salleSpotify');
    store.del('salleSpotify');
    // Back on the page while in a room (reload, phone woken up): straight back to it.
    if (ongoing?.token && (!code || code === ongoing.code)) {
      // Only a room the server says is gone is given up: a network hiccup keeps the seat and reconnects.
      const res = await fetch(`${BASE}/rooms/${ongoing.code}`).catch(() => null);
      // Gone (expired, or the game ended long ago): the usual start, without an error to read.
      if (res?.status === 404) store.del('salle');
      else {
        enter(ongoing);
        if (spotifyBack) {
          pickAgain();
          const error = $('#login-error').textContent;
          if (error) { $('#login-error').textContent = ''; $('#room-music-status').textContent = `Connexion Spotify : ${error}`; }
          else if (store.get('token')) fromSpotify();
        }
        return true;
      }
    }
    if (/^[A-Z]{4}$/.test(code)) {
      goHome('salle');
      // Invited: the panel only offers to join this room.
      $('[data-panel="salle"]').classList.add('invited');
      $('#salle-join button').textContent = `Rejoindre la salle ${code}`;
      $('#salle-code').value = code;
      status('');
      ($('#salle-name').value ? $('#salle-join button') : $('#salle-name')).focus();
      return true;
    }
    return false;
  }

  return { boot, available, back };
})();
