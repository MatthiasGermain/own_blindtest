// Protocol smoke test, against the local server: run `npm run dev` in one terminal, then `npm test`.
const S = 'http://127.0.0.1:8787', O = { Origin: 'http://127.0.0.1:8888' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function phone(code, hello) {
  const p = { msgs: [], last: (t) => [...p.msgs].reverse().find((m) => m.t === t) };
  p.ws = new WebSocket(`ws://127.0.0.1:8787/rooms/${code}/ws`, { headers: O });
  p.ws.onmessage = (e) => p.msgs.push(JSON.parse(e.data));
  p.closed = new Promise((r) => (p.ws.onclose = (e) => r(e.code)));
  p.ws.onopen = () => p.ws.send(JSON.stringify({ t: 'hello', ...hello }));
  p.send = (m) => p.ws.send(JSON.stringify(m));
  return p;
}
const check = (label, ok) => console.log(ok ? 'OK ' : 'ÉCHEC', label);

const bad = await fetch(S + '/rooms', { method: 'POST', headers: { Origin: 'https://evil.example' } });
check('site étranger refusé (403)', bad.status === 403);
const { code, hostKey } = await fetch(S + '/rooms', { method: 'POST', headers: O }).then((r) => r.json());
check(`salle créée : ${code}`, /^[A-HJ-NP-Z]{4}$/.test(code) && !!hostKey);
check('code inconnu → 404', (await fetch(S + '/rooms/ZZZZ', { headers: O })).status === 404 || code === 'ZZZZ');

const host = phone(code, { name: 'Matthias', hostKey });
await wait(300);
const lea = phone(code, { name: 'Léa', avatar: 'javascript:alert(1)' });
const tom = phone(code, { name: '  Tom   le   boss  ' });
await wait(400);
let room = host.last('room');
check('3 joueurs dans le salon', room.players.length === 3);
check('Matthias est hôte, seul', room.players.filter((p) => p.host).map((p) => p.name).join() === 'Matthias');
check('avatar dangereux vidé', room.players.find((p) => p.name === 'Léa').avatar === '');
check('pseudo nettoyé', room.players.some((p) => p.name === 'Tom le boss'));
check('aucun jeton dans le salon', !JSON.stringify(room).includes(lea.last('welcome').you.token));

lea.send({ t: 'start' }); await wait(200);
check('Léa ne peut pas lancer', lea.last('error')?.code === 'not-host');

const leaToken = lea.last('welcome').you.token, leaId = lea.last('welcome').you.id;
lea.ws.close(); await wait(300);
check('Léa vue hors ligne', host.last('room').players.find((p) => p.id === leaId).online === false);
const lea2 = phone(code, { name: 'autre', token: leaToken }); await wait(300);
check('Léa revient à sa place (même id)', lea2.last('welcome').you.id === leaId && host.last('room').players.length === 3);
check('Léa de nouveau en ligne', host.last('room').players.find((p) => p.id === leaId).online === true);

host.send({ t: 'kick', id: tom.last('welcome').you.id });
check('Tom retiré (code 4001)', (await tom.closed) === 4001);
await wait(200);
check('plus que 2 joueurs', host.last('room').players.length === 2);

const extra = [];
for (let i = 0; i < 7; i++) extra.push(phone(code, { name: 'X' + i }));
await wait(600);
check('salle pleine à 8', extra.some((p) => p.last('error')?.code === 'full') && host.last('room').players.length === 8);

host.send({ t: 'start' }); await wait(300);
check('lancement refusé sans musique', host.last('error')?.code === 'not-ready');
const music = (k) => ({ t: 'music', source: 'deezer', tracks: Array.from({ length: 20 }, (_, i) => ({ id: String(1000 * k + i), artist: 'A' + i, title: 'T' + i, album: '', cover: 'https://x.test/c.jpg' })) });
host.send({ t: 'music', source: 'nope', tracks: [{ id: 'x', artist: 'a', title: 'b' }] }); await wait(200);
check('musique invalide refusée', host.last('error')?.code === 'bad-message');
[host, lea2, ...extra].forEach((p, k) => p.send(music(k + 1))); await wait(500);
const me = host.last('room').players.find((p) => p.name === 'Matthias');
check('15 titres gardés sur 20, source Deezer', me.tracks === 15 && me.source === 'deezer');
check('les titres ne sont pas diffusés', !JSON.stringify(host.last('room')).includes('T14'));
host.send({ t: 'start' }); await wait(300);
check('partie lancée', lea2.last('room').phase === 'playing');
const late = phone(code, { name: 'Retard' }); await wait(300);
check('retardataire refusé', late.last('error')?.code === 'started');

host.send({ t: 'leave' }); await host.closed; await wait(300);
check('l’hôte part, Léa (la suivante) devient hôte', lea2.last('room').players.find((p) => p.id === leaId).host);
const info = await fetch(S + '/rooms/' + code, { headers: O }).then((r) => r.json());
check('résumé public sans secret', !JSON.stringify(info).includes(hostKey) && info.phase === 'playing');
for (const p of [lea2, late, ...extra]) p.ws.close();
process.exit(0);
