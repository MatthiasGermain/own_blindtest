// One room = one Durable Object: it holds the room's state and talks to every device over WebSockets.
// Hibernation API: the object may sleep between messages, so the state lives in storage, not in memory.
// The server is the referee: it draws the rounds, keeps the answers secret until the reveal, times and scores.
import { DurableObject } from 'cloudflare:workers';
import { buildGame, finalView, scoreRound, type Game } from './game';
import {
  COUNTDOWN_MS, MAX_MESSAGE_BYTES, MAX_PLAYERS, MIN_TRACKS, ROOM_TTL_MS, ROUND_MS, TRACKS_PER_PLAYER,
  type ClientMessage, type ErrorCode, type MusicSource, type Phase, type PotTrack, type PublicPlayer,
  type RevealView, type RoundView, type ServerMessage,
} from './protocol';

interface Player {
  id: string;
  token: string; // secret: lets a phone that went to sleep take its seat back
  name: string;
  avatar: string;
  host: boolean;
  joinedAt: number;
  source: MusicSource | null;
  tracks: PotTrack[];
}

interface RoomState {
  code: string;
  hostKey: string; // secret given to the creator: the first device to show it becomes host
  createdAt: number;
  expiresAt: number;
  phase: Phase;
  players: Player[];
  game?: Game | null;
  sameRoom?: boolean; // everyone around one loudspeaker: only the host's device plays the sound
  countdown?: boolean; // a "3, 2, 1" before each round
}

interface Attachment { id: string }

const GRACE_MS = 1500; // an answer sent just before the end may arrive just after it

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const safeUrl = (v: unknown) => {
  const s = clean(v, 300);
  return /^https:\/\/[^\s"'<>]+$/.test(s) ? s : '';
};
const shortId = () => crypto.randomUUID().slice(0, 8);
const SOURCES: MusicSource[] = ['deezer', 'history', 'spotify'];

/** Keeps only well-formed tracks, once each, at most TRACKS_PER_PLAYER. */
function cleanTracks(raw: unknown): PotTrack[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PotTrack[] = [];
  for (const t of raw.slice(0, TRACKS_PER_PLAYER * 2)) {
    const id = typeof t?.id === 'string' || typeof t?.id === 'number' ? String(t.id) : '';
    if (!/^\d{1,12}$/.test(id) || seen.has(id)) continue;
    const track = { id, artist: clean(t.artist, 120), title: clean(t.title, 160), album: clean(t.album, 160), cover: safeUrl(t.cover) };
    if (!track.artist || !track.title) continue;
    seen.add(id);
    out.push(track);
    if (out.length === TRACKS_PER_PLAYER) break;
  }
  return out;
}
const ready = (p: Player) => p.tracks.length >= MIN_TRACKS;

/** Two "Léa" in one room would be unreadable on the scores: the second one becomes "Léa 2". */
function uniqueName(s: RoomState, name: string): string {
  if (!name) return '';
  const taken = new Set(s.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, 17)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export class Room extends DurableObject {
  private state: RoomState | null | undefined; // undefined = not loaded yet

  private async load(): Promise<RoomState | null> {
    if (this.state === undefined) this.state = (await this.ctx.storage.get<RoomState>('room')) ?? null;
    return this.state;
  }

  private async save(s: RoomState) {
    this.state = s;
    await this.ctx.storage.put('room', s);
  }

  /** Called by the Worker for a fresh code. Resolves to the host key, or null when the code is taken. */
  async init(code: string): Promise<string | null> {
    if (await this.load()) return null;
    const now = Date.now();
    const s: RoomState = { code, hostKey: crypto.randomUUID(), createdAt: now, expiresAt: now + ROOM_TTL_MS, phase: 'lobby', players: [], game: null };
    await this.save(s);
    await this.schedule(s);
    return s.hostKey;
  }

  /** Public summary for the join screen. */
  async info() {
    const s = await this.load();
    return s && { code: s.code, phase: s.phase, players: s.players.length, full: s.players.length >= MAX_PLAYERS };
  }

  async fetch(): Promise<Response> {
    if (!(await this.load())) return new Response('not-found', { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const s = await this.load();
    if (!s) return ws.close(4004, 'not-found');
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return this.error(ws, 'bad-message', 'Message illisible.');
    let msg: ClientMessage;
    try { msg = JSON.parse(raw); } catch { return this.error(ws, 'bad-message', 'Message illisible.'); }

    if (msg.t === 'hello') return this.hello(ws, s, msg);

    const me = this.playerOf(ws, s);
    if (!me) return this.error(ws, 'bad-message', 'Présente-toi d’abord.');

    switch (msg.t) {
      case 'leave':
        await this.remove(s, me.id);
        ws.close(1000, 'left');
        return;
      case 'music': {
        if (s.phase !== 'lobby') return this.error(ws, 'started', 'La partie a déjà commencé.');
        const tracks = cleanTracks(msg.tracks);
        if (tracks.length < MIN_TRACKS) return this.error(ws, 'bad-message', `Il faut au moins ${MIN_TRACKS} titres trouvés sur Deezer.`);
        me.source = SOURCES.includes(msg.source) ? msg.source : 'deezer';
        me.tracks = tracks;
        if (msg.avatar !== undefined) me.avatar = safeUrl(msg.avatar);
        await this.save(s);
        this.broadcast(s);
        return;
      }
      case 'kick': {
        if (!me.host) return this.error(ws, 'not-host', 'Seul l’hôte peut faire ça.');
        if (msg.id === me.id) return;
        for (const other of this.socketsOf(msg.id)) { this.send(other, { t: 'error', code: 'kicked', message: 'L’hôte t’a retiré de la salle.' }); other.close(4001, 'kicked'); }
        await this.remove(s, msg.id);
        return;
      }
      case 'settings': {
        if (!me.host) return this.error(ws, 'not-host', 'Seul l’hôte peut changer ça.');
        if (s.phase !== 'lobby') return;
        if (typeof msg.sameRoom === 'boolean') s.sameRoom = msg.sameRoom;
        if (typeof msg.countdown === 'boolean') s.countdown = msg.countdown;
        await this.save(s);
        this.broadcast(s);
        return;
      }
      case 'start': {
        if (!this.leads(s, me)) return this.error(ws, 'not-host', 'Seul l’hôte peut lancer la partie.');
        if (s.phase !== 'lobby') return;
        if (s.players.length < 2) return this.error(ws, 'too-few', 'Il faut au moins 2 joueurs.');
        if (!s.players.every(ready)) return this.error(ws, 'not-ready', 'Tout le monde n’a pas encore choisi sa musique.');
        s.game = buildGame(s.players);
        s.phase = 'playing';
        s.expiresAt = Date.now() + ROOM_TTL_MS; // a long evening: each game gets its two hours
        await this.openRound(s, 0);
        return;
      }
      case 'answer':
        return this.answer(s, me, msg);
      case 'next': {
        if (!this.leads(s, me)) return this.error(ws, 'not-host', 'Seul l’hôte passe à la suite.');
        const g = s.game;
        if (s.phase !== 'playing' || !g || !g.rounds[g.index]?.results) return;
        if (g.index + 1 < g.rounds.length) return this.openRound(s, g.index + 1);
        s.phase = 'ended';
        await this.save(s);
        this.broadcast(s);
        this.sendAll({ t: 'final', final: finalView(g) });
        return;
      }
      case 'replay':
        if (!this.leads(s, me)) return this.error(ws, 'not-host', 'Seul l’hôte peut relancer.');
        if (s.phase === 'lobby') return;
        s.phase = 'lobby';
        s.game = null;
        await this.save(s);
        await this.schedule(s);
        this.broadcast(s);
        return;
      default:
        return this.error(ws, 'bad-message', 'Message inconnu.');
    }
  }

  private async hello(ws: WebSocket, s: RoomState, msg: Extract<ClientMessage, { t: 'hello' }>) {
    let me = this.playerOf(ws, s) ?? (msg.token ? s.players.find((p) => p.token === msg.token) : undefined);
    if (me) {
      // Coming back: the older connection of the same player is replaced.
      for (const old of this.socketsOf(me.id)) if (old !== ws) old.close(4002, 'replaced');
    } else {
      if (s.phase !== 'lobby') return this.error(ws, 'started', 'La partie a déjà commencé.');
      if (s.players.length >= MAX_PLAYERS) return this.error(ws, 'full', `La salle est pleine (${MAX_PLAYERS} joueurs).`);
      const name = uniqueName(s, clean(msg.name, 20));
      if (!name) return this.error(ws, 'bad-message', 'Choisis un pseudo.');
      const host = !!msg.hostKey && msg.hostKey === s.hostKey && !s.players.some((p) => p.host);
      me = { id: shortId(), token: crypto.randomUUID(), name, avatar: safeUrl(msg.avatar), host, joinedAt: Date.now(), source: null, tracks: [] };
      s.players.push(me);
      await this.save(s);
    }
    ws.serializeAttachment({ id: me.id } satisfies Attachment);
    this.send(ws, { t: 'welcome', you: { id: me.id, token: me.token, host: me.host } });
    this.broadcast(s);
    // Back in the middle of a game: where it stands, for this device.
    const g = s.game;
    if (!g) return;
    if (s.phase === 'ended') return this.send(ws, { t: 'final', final: finalView(g) });
    const r = g.rounds[g.index];
    if (!r) return;
    this.send(ws, { t: 'round', round: this.roundView(s, me) });
    if (r.results) this.send(ws, { t: 'reveal', reveal: this.revealView(g) });
  }

  /* ---------- Rounds ---------- */

  private async openRound(s: RoomState, index: number) {
    const g = s.game!;
    const r = g.rounds[index];
    g.index = index;
    r.startedAt = Date.now() + (s.countdown ? COUNTDOWN_MS : 0);
    r.deadline = r.startedAt + ROUND_MS;
    await this.save(s);
    await this.schedule(s);
    this.broadcast(s);
    for (const ws of this.ctx.getWebSockets()) {
      const p = this.playerOf(ws, s);
      if (p) this.send(ws, { t: 'round', round: this.roundView(s, p) });
    }
  }

  private roundView(s: RoomState, p: Player): RoundView {
    const g = s.game!;
    const r = g.rounds[g.index];
    const a = r.answers[p.id] ?? {};
    return {
      index: g.index,
      total: g.rounds.length,
      startedAt: r.startedAt,
      deadline: r.deadline,
      now: Date.now(),
      cast: g.cast,
      songs: r.songs,
      // Only the devices that play the sound learn which track it is.
      ...(p.host || !s.sameRoom ? { trackId: r.track.id } : {}),
      mine: { owner: a.owner, song: a.song },
      answered: this.answered(s),
      started: this.started(s),
    };
  }

  private answered(s: RoomState) {
    const r = s.game!.rounds[s.game!.index];
    return Object.entries(r.answers).filter(([, a]) => a.owner !== undefined && a.song !== undefined).map(([id]) => id);
  }

  private started(s: RoomState) {
    const r = s.game!.rounds[s.game!.index];
    return Object.entries(r.answers).filter(([, a]) => a.owner !== undefined || a.song !== undefined).map(([id]) => id);
  }

  private async answer(s: RoomState, me: Player, msg: Extract<ClientMessage, { t: 'answer' }>) {
    const g = s.game;
    if (s.phase !== 'playing' || !g || msg.index !== g.index) return;
    const r = g.rounds[g.index];
    const now = Date.now();
    if (r.results || !g.cast.some((c) => c.id === me.id) || now > r.deadline + GRACE_MS) return;
    // A tap during the countdown (a phone whose clock is a little off) counts as made at the start.
    const at = Math.max(r.startedAt, Math.min(now, r.deadline));
    const a = (r.answers[me.id] ??= {});
    // Each answer counts once: no changing your mind after seeing the others' faces.
    if (msg.owner !== undefined && a.owner === undefined && g.cast.some((c) => c.id === msg.owner)) {
      a.owner = msg.owner;
      a.ownerAt = at;
    }
    if (msg.song !== undefined && a.song === undefined && Number.isInteger(msg.song) && msg.song >= 0 && msg.song < r.songs.length) {
      a.song = msg.song;
      a.songAt = at;
    }
    // Everyone still here has answered: no need to wait for the clock.
    const present = s.players.filter((p) => g.cast.some((c) => c.id === p.id) && this.socketsOf(p.id).length);
    const done = new Set(this.answered(s));
    if (present.length && present.every((p) => done.has(p.id))) return this.closeRound(s);
    await this.save(s);
    this.sendAll({ t: 'progress', index: g.index, answered: [...done], started: this.started(s) });
  }

  private async closeRound(s: RoomState) {
    const g = s.game!;
    const r = g.rounds[g.index];
    if (r.results) return;
    r.results = scoreRound(r, g.cast, g.scores);
    await this.save(s);
    await this.schedule(s);
    this.broadcast(s);
    this.sendAll({ t: 'reveal', reveal: this.revealView(g) });
  }

  private revealView(g: Game): RevealView {
    const r = g.rounds[g.index];
    return {
      index: g.index, total: g.rounds.length, track: r.track, owners: r.owners,
      songs: r.songs, song: r.song, results: r.results!, last: g.index === g.rounds.length - 1,
    };
  }

  /* ---------- Clock: one alarm, for the end of the round or the end of the room ---------- */

  private async schedule(s: RoomState) {
    const r = s.phase === 'playing' ? s.game?.rounds[s.game.index] : undefined;
    const at = r && !r.results ? Math.min(r.deadline + GRACE_MS, s.expiresAt) : s.expiresAt;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const s = await this.load();
    if (!s) return;
    if (Date.now() >= s.expiresAt) return this.expire();
    const r = s.phase === 'playing' ? s.game?.rounds[s.game.index] : undefined;
    if (r && !r.results && Date.now() >= r.deadline) await this.closeRound(s);
    else await this.schedule(s);
  }

  private async expire() {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: 'error', code: 'expired', message: 'La salle a expiré.' });
      ws.close(4003, 'expired');
    }
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  /* ---------- Players ---------- */

  private async remove(s: RoomState, id: string) {
    const gone = s.players.find((p) => p.id === id);
    s.players = s.players.filter((p) => p.id !== id);
    // The host left for good: the next player to have joined takes over.
    if (gone?.host && s.players.length) s.players[0].host = true;
    await this.save(s);
    this.broadcast(s);
  }

  async webSocketClose(ws: WebSocket) {
    // A closed phone keeps its seat (it may come back with its token); the others just see it offline.
    const s = await this.load();
    if (s) this.broadcast(s, ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /* ---------- helpers ---------- */

  /** The host leads the game; while the host's phone is away, anyone may, so the room is never stuck. */
  private leads(s: RoomState, p: Player) {
    return p.host || !s.players.some((o) => o.host && this.socketsOf(o.id).length);
  }

  private socketsOf(id: string, except?: WebSocket) {
    return this.ctx.getWebSockets().filter((w) => w !== except && (w.deserializeAttachment() as Attachment | null)?.id === id);
  }

  private playerOf(ws: WebSocket, s: RoomState) {
    const id = (ws.deserializeAttachment() as Attachment | null)?.id;
    return id ? s.players.find((p) => p.id === id) : undefined;
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  private sendAll(msg: ServerMessage) {
    for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()) this.send(ws, msg);
  }

  private error(ws: WebSocket, code: ErrorCode, message: string) {
    this.send(ws, { t: 'error', code, message });
  }

  /** Sends the room to every device; `closing` is a socket about to disappear (counted offline). */
  private broadcast(s: RoomState, closing?: WebSocket) {
    const players: PublicPlayer[] = s.players.map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, host: p.host, online: this.socketsOf(p.id, closing).length > 0,
      source: p.source, tracks: p.tracks.length, score: s.game?.scores[p.id] ?? 0,
    }));
    const msg: ServerMessage = { t: 'room', code: s.code, phase: s.phase, players, expiresAt: s.expiresAt, sameRoom: !!s.sameRoom, countdown: !!s.countdown };
    for (const ws of this.ctx.getWebSockets()) if (ws !== closing) this.send(ws, msg);
  }
}
