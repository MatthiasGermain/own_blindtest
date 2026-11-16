// The rules of « Qui écoute ça ? », as pure functions: drawing the rounds, scoring, awards.
// No storage and no sockets here, so it can be tested on its own.
import {
  POINTS, ROUND_MS,
  type Award, type CastMember, type FinalView, type PotTrack, type RoundResult, type SongOption,
} from './protocol';

export interface Answer { owner?: string; ownerAt?: number; song?: number; songAt?: number }

export interface GameRound {
  track: PotTrack;
  owners: string[];
  songs: SongOption[];
  song: number; // right option
  startedAt: number; // 0 = not open yet
  deadline: number;
  answers: Record<string, Answer>;
  results?: RoundResult[]; // set once closed
}

export interface Game {
  cast: CastMember[];
  rounds: GameRound[];
  index: number;
  scores: Record<string, number>;
  shared: { a: string; b: string; count: number }[]; // tracks two players both brought
}

type Rand = () => number;

export function shuffle<T>(list: T[], rand: Rand = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The same song from two pots: same Deezer id, or same artist and title once versions are ignored.
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const songKey = (t: PotTrack) => `${norm(t.artist)}|${norm(t.title)}`;

/** Between 10 and 15 rounds when the pots allow it, the same number for every player. */
export function roundsPerPlayer(players: number) {
  let per = Math.max(1, Math.floor(15 / players));
  if (per * players < 10) per++;
  return per;
}

export function buildGame(players: { id: string; name: string; avatar: string; tracks: PotTrack[] }[], rand: Rand = Math.random): Game {
  // Every distinct song of the pot, with everyone who brought it.
  const pot = new Map<string, { track: PotTrack; owners: Set<string> }>();
  const byId = new Map<string, string>();
  for (const p of players) {
    for (const t of p.tracks) {
      const key = byId.get(t.id) ?? songKey(t);
      byId.set(t.id, key);
      const entry = pot.get(key) ?? { track: t, owners: new Set<string>() };
      entry.owners.add(p.id);
      pot.set(key, entry);
    }
  }

  const shared: Game['shared'] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const count = [...pot.values()].filter((e) => e.owners.has(players[i].id) && e.owners.has(players[j].id)).length;
      if (count) shared.push({ a: players[i].id, b: players[j].id, count });
    }
  }

  // Each player gets the same number of their own songs; a shared song counts for everyone who has it.
  const per = roundsPerPlayer(players.length);
  const picked = new Set<string>();
  const count = new Map(players.map((p) => [p.id, 0]));
  for (const p of shuffle(players, rand)) {
    for (const t of shuffle(p.tracks, rand)) {
      if ((count.get(p.id) ?? 0) >= per) break;
      const key = byId.get(t.id)!;
      if (picked.has(key)) continue;
      picked.add(key);
      for (const o of pot.get(key)!.owners) count.set(o, (count.get(o) ?? 0) + 1);
    }
  }

  // Order: shuffled, then nobody twice in a row when it can be avoided.
  const order = shuffle([...picked], rand);
  for (let i = 1; i < order.length; i++) {
    const prev = pot.get(order[i - 1])!.owners;
    if (![...pot.get(order[i])!.owners].some((o) => prev.has(o))) continue;
    const j = order.findIndex((k, n) => n > i && ![...pot.get(k)!.owners].some((o) => prev.has(o)));
    if (j > 0) [order[i], order[j]] = [order[j], order[i]];
  }

  const keys = [...pot.keys()];
  const rounds: GameRound[] = order.map((key) => {
    const { track, owners } = pot.get(key)!;
    const others = shuffle(keys.filter((k) => k !== key), rand).slice(0, 3).map((k) => pot.get(k)!.track);
    const options = shuffle([track, ...others], rand);
    return {
      track,
      owners: [...owners],
      songs: options.map((t) => ({ title: t.title, artist: t.artist })),
      song: options.indexOf(track),
      startedAt: 0,
      deadline: 0,
      answers: {},
    };
  });

  return {
    cast: players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar })),
    rounds,
    index: -1,
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    shared,
  };
}

/** Points for a right answer: a base, plus up to POINTS.speedMax for answering early. */
const points = (at: number | undefined, r: GameRound) =>
  POINTS.right + Math.round(POINTS.speedMax * Math.max(0, Math.min(1, (r.deadline - (at ?? r.deadline)) / ROUND_MS)));

export function scoreRound(r: GameRound, cast: CastMember[], scores: Record<string, number>): RoundResult[] {
  return cast.map(({ id }) => {
    const a = r.answers[id] ?? {};
    const owner = a.owner === undefined ? null : r.owners.includes(a.owner);
    const song = a.song === undefined ? null : a.song === r.song;
    // Your own song, and you did not even recognise it.
    const ownMiss = r.owners.includes(id) && a.owner !== id;
    const delta = (owner ? points(a.ownerAt, r) : 0) + (song ? points(a.songAt, r) : 0) + (ownMiss ? POINTS.ownMiss : 0);
    scores[id] = (scores[id] ?? 0) + delta;
    return { id, owner, song, ownMiss, delta, score: scores[id] };
  });
}

export function finalView(g: Game): FinalView {
  const sorted = [...g.cast].sort((a, b) => (g.scores[b.id] ?? 0) - (g.scores[a.id] ?? 0));
  const standings = sorted.map((p) => ({ id: p.id, score: g.scores[p.id] ?? 0, rank: 1 }));
  standings.forEach((s, i) => { s.rank = i && s.score === standings[i - 1].score ? standings[i - 1].rank : i + 1; });
  return { standings, awards: awards(g), cast: g.cast };
}

function awards(g: Game): Award[] {
  const played = g.rounds.filter((r) => r.results);
  const out: Award[] = [];

  // How often each player's songs were rightly attributed to them.
  const guessed = g.cast.map(({ id }) => {
    let right = 0, asked = 0;
    for (const r of played) {
      if (!r.owners.includes(id)) continue;
      for (const res of r.results!) if (!r.owners.includes(res.id) && res.owner !== null) { asked++; if (res.owner) right++; }
    }
    return { id, right, asked, rate: asked ? right / asked : -1 };
  }).filter((x) => x.asked > 0);
  if (guessed.length >= 2) {
    const most = [...guessed].sort((a, b) => b.rate - a.rate)[0];
    const least = [...guessed].sort((a, b) => a.rate - b.rate)[0];
    out.push({ ids: [most.id], title: 'Le plus prévisible', detail: `Ses titres ont été reconnus ${most.right} fois sur ${most.asked}.` });
    if (least.id !== most.id) {
      const detail = least.right ? `Ses titres n'ont été reconnus que ${least.right} fois sur ${least.asked}.` : `Personne n'a reconnu ses titres (0 sur ${least.asked}).`;
      out.push({ ids: [least.id], title: 'Le plus mystérieux', detail });
    }
  }

  const best = [...g.shared].sort((a, b) => b.count - a.count)[0];
  if (best) out.push({ ids: [best.a, best.b], title: 'Âmes sœurs musicales', detail: `${best.count} titre${best.count > 1 ? 's' : ''} en commun dans leurs pots.` });

  const misses = g.cast.map(({ id }) => ({ id, n: played.filter((r) => r.results!.find((x) => x.id === id)?.ownMiss).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (misses.length) out.push({ ids: [misses[0].id], title: 'Amnésique', detail: `N'a pas reconnu ${misses[0].n} de ses propres titres.` });

  const ears = g.cast.map(({ id }) => ({ id, n: played.filter((r) => r.results!.find((x) => x.id === id)?.song).length }))
    .sort((a, b) => b.n - a.n);
  if (ears[0]?.n) out.push({ ids: [ears[0].id], title: 'Oreille absolue', detail: `A trouvé ${ears[0].n} titre${ears[0].n > 1 ? 's' : ''} sur ${played.length}.` });

  return out;
}
