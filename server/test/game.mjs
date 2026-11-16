// Full game test, against the local server: run `npm run dev` in one terminal, then `npm run test:game`.
// Three players, shared songs, answers right and wrong, a timeout, a phone that reconnects mid-round.
const S = 'http://127.0.0.1:8787', O = { Origin: 'http://127.0.0.1:8888' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok) => { console.log(ok ? 'OK ' : 'ÉCHEC', label); if (!ok) failures++; };

function phone(code, hello) {
  const p = { msgs: [], last: (t) => [...p.msgs].reverse().find((m) => m.t === t) };
  p.ws = new WebSocket(`ws://127.0.0.1:8787/rooms/${code}/ws`, { headers: O });
  p.ws.onmessage = (e) => p.msgs.push(JSON.parse(e.data));
  p.closed = new Promise((r) => (p.ws.onclose = (e) => r(e.code)));
  p.opened = new Promise((r) => (p.ws.onopen = () => { p.ws.send(JSON.stringify({ t: 'hello', ...hello })); r(); }));
  p.send = (m) => p.ws.send(JSON.stringify(m));
  return p;
}
const tracks = (from, n, prefix) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), artist: `${prefix} artiste ${i}`, title: `${prefix} titre ${i}`, album: '', cover: '' }));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(50); } return false; };

const { code, hostKey } = await fetch(S + '/rooms', { method: 'POST', headers: O }).then((r) => r.json());
const host = phone(code, { name: 'Matthias', hostKey });
await wait(200);
const lea = phone(code, { name: 'Léa' });
const tom = phone(code, { name: 'Tom' });
await wait(400);
const ids = { host: host.last('welcome').you.id, lea: lea.last('welcome').you.id, tom: tom.last('welcome').you.id };
const owner = { [ids.host]: 'host', [ids.lea]: 'lea', [ids.tom]: 'tom' };
// Léa and Tom share 3 songs (same Deezer ids): "âmes sœurs".
const shared = tracks(9000, 3, 'commun');
host.send({ t: 'music', source: 'deezer', tracks: tracks(1000, 15, 'M') });
lea.send({ t: 'music', source: 'deezer', tracks: [...tracks(2000, 12, 'L'), ...shared] });
tom.send({ t: 'music', source: 'history', tracks: [...shared, ...tracks(3000, 12, 'T')] });
await wait(400);
check('par défaut, le son sort de chaque téléphone', host.last('room').sameRoom === false);
lea.send({ t: 'settings', sameRoom: true }); await wait(200);
check('seul l’hôte règle le son', lea.last('error')?.code === 'not-host' && host.last('room').sameRoom === false);
host.send({ t: 'settings', sameRoom: true }); await wait(300);
check('« même pièce » coché par l’hôte, vu par tous', lea.last('room').sameRoom === true && tom.last('room').sameRoom === true);
host.send({ t: 'start' });
await until(() => host.last('round') && lea.last('round') && tom.last('round'));

let r = host.last('round').round;
// 5 songs each; a song Léa and Tom share counts for both, so there may be a little fewer than 15 rounds.
const TOTAL = r.total;
check(`partie lancée : ${TOTAL} manches (entre 10 et 15)`, TOTAL >= 10 && TOTAL <= 15 && r.index === 0);
check('même pièce : le son (trackId) va à l’hôte seulement', !!r.trackId && !lea.last('round').round.trackId && !tom.last('round').round.trackId);
check('4 propositions de titre, 3 joueurs proposés', r.songs.length === 4 && r.cast.length === 3);
check('les scores partent de 0', host.last('room').players.every((p) => p.score === 0));

let ownMissSeen = false, sharedSeen = false, rounds = 0, perOwner = { host: 0, lea: 0, tom: 0 };
for (let i = 0; i < TOTAL; i++) {
  await until(() => host.last('round')?.round.index === i);
  r = host.last('round').round;
  if (i === 2) {
    // Round 3: Tom's phone sleeps then comes back; nobody answers until the clock ends it.
    const token = tom.last('welcome').you.token;
    tom.ws.close();
    await wait(300);
    const tom2 = phone(code, { name: 'Tom', token });
    await until(() => tom2.last('round'));
    check('Tom revient en pleine manche et retrouve la question', tom2.last('round')?.round.index === 2 && tom2.last('welcome').you.id === ids.tom);
    Object.assign(tom, { ws: tom2.ws, msgs: tom2.msgs, last: tom2.last, send: tom2.send, closed: tom2.closed });
    const t0 = Date.now();
    const closedByClock = await until(() => host.last('reveal')?.reveal.index === 2, 25000);
    check(`sans réponse, la manche se ferme au chrono (${Math.round((Date.now() - t0) / 1000)} s)`, closedByClock);
    const rv = host.last('reveal').reveal;
    for (const o of rv.owners) perOwner[owner[o]]++;
    check('personne n’a de points, sauf les pénalités', rv.results.every((x) => x.owner === null && x.song === null && x.delta === (x.ownMiss ? -50 : 0)));
  } else {
    // Fixed answers: the host says Léa, Léa says herself, Tom says the host. Only the server knows who is right.
    host.send({ t: 'answer', index: i, owner: ids.lea, song: 0 });
    host.send({ t: 'answer', index: i, owner: ids.tom, song: 1 }); // a second answer must not count
    lea.send({ t: 'answer', index: i, owner: ids.lea, song: 0 });
    await wait(100);
    check(`manche ${i + 1} : réponse partielle → progression`, i > 0 || host.last('progress')?.answered.length === 2);
    if (i === 0) {
      // Tom answers one question only: he shows as "half done", the round stays open.
      tom.send({ t: 'answer', index: i, owner: ids.host });
      await wait(150);
      const pg = host.last('progress');
      check('une seule réponse sur deux → « à moitié », la manche continue', pg.started.includes(ids.tom) && !pg.answered.includes(ids.tom) && host.last('reveal')?.reveal.index !== 0);
    }
    tom.send({ t: 'answer', index: i, owner: ids.host, song: 2 });
    const closed = await until(() => host.last('reveal')?.reveal.index === i, 3000);
    if (!closed) { check(`manche ${i + 1} fermée dès que tout le monde a répondu`, false); break; }
    const rv = host.last('reveal').reveal;
    const res = Object.fromEntries(rv.results.map((x) => [owner[x.id], x]));
    const leaOwns = rv.owners.includes(ids.lea);
    if (rv.owners.length > 1) sharedSeen = true;
    for (const o of rv.owners) perOwner[owner[o]]++;
    if (i === 0) {
      check('l’hôte n’a pas pu changer d’avis', res.host.owner === leaOwns);
      check('bonne réponse rapide ≈ 100 + bonus vitesse', !res.lea.owner || (res.lea.delta >= 140));
    }
    if (rv.owners.includes(ids.host) && !ownMissSeen) {
      ownMissSeen = true;
      check('l’hôte n’a pas reconnu son propre titre : -50', res.host.ownMiss && res.host.delta <= -50 + 150);
    }
  }
  rounds++;
  if (i < TOTAL - 1) host.send({ t: 'next' });
}
check(`${TOTAL} manches jouées`, rounds === TOTAL);
check('chacun a eu au moins 5 titres à lui (équilibre)', Object.values(perOwner).every((n) => n >= 5));
console.log(`   titre en commun tiré dans la partie : ${sharedSeen ? 'oui' : 'non (tirage au hasard)'}`);

lea.send({ t: 'next' }); await wait(200);
check('seul l’hôte passe à la suite', lea.last('error')?.code === 'not-host');
host.send({ t: 'next' });
await until(() => lea.last('final'));
const f = lea.last('final').final;
check('podium envoyé à tous', !!f && !!host.last('final') && !!tom.last('final'));
check('classement trié', f.standings.every((s, i, a) => !i || a[i - 1].score >= s.score));
const scoreOf = (id) => host.last('room').players.find((p) => p.id === id).score;
check('scores du salon = podium', f.standings.every((s) => s.score === scoreOf(s.id)));
check('Âmes sœurs : Léa et Tom', f.awards.some((a) => a.title === 'Âmes sœurs musicales' && a.ids.includes(ids.lea) && a.ids.includes(ids.tom)));
console.log('   titres :', f.awards.map((a) => `${a.title} → ${a.detail}`).join(' | '));

const late = phone(code, { name: 'Retard', token: lea.last('welcome').you.token });
await until(() => late.last('final'));
check('revenir après la fin redonne le podium', !!late.last('final'));
late.ws.close();

host.send({ t: 'replay' });
// (Léa's first connection was replaced by the "late" one above: check from the host.)
await until(() => host.last('room')?.phase === 'lobby');
const room = host.last('room');
check('Rejouer : retour au salon, mêmes joueurs, musique gardée, scores à 0', room.phase === 'lobby' && room.players.length === 3 && room.players.every((p) => p.tracks >= 5 && p.score === 0));

// Second game, each on their own: every phone gets the sound.
host.send({ t: 'settings', sameRoom: false });
await wait(200);
host.send({ t: 'start' });
await until(() => host.last('round')?.round.index === 0 && tom.last('round')?.round.index === 0 && host.last('room').phase === 'playing');
check('chacun chez soi : le son va à tous les téléphones', !!host.last('round').round.trackId && !!tom.last('round').round.trackId);

for (const p of [host, lea, tom]) p.ws.close();
console.log(failures ? `${failures} échec(s)` : 'Tout est bon.');
process.exit(failures ? 1 : 0);
