// Messages exchanged over a room's WebSocket, as JSON. Shared vocabulary between the server and the site.

export const MAX_PLAYERS = 8;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // a room and its data are erased after 2 hours at most
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const TRACKS_PER_PLAYER = 15; // each player brings this many tracks to the shared pot
export const MIN_TRACKS = 5; // below this, a player cannot be ready
export const ROUND_MS = 20_000; // time to answer, as long as the snippet plays
export const POINTS = { right: 100, speedMax: 50, ownMiss: -50 };

/** A track a player brings, already found on Deezer (the sound always comes from Deezer). */
export interface PotTrack {
  id: string; // Deezer track id
  artist: string;
  title: string;
  album: string;
  cover: string;
}

/** Where a player's music comes from: shown in the lobby, never anything more personal. */
export type MusicSource = 'deezer' | 'history' | 'spotify';

export type Phase = 'lobby' | 'playing' | 'ended';

/** What every device may know about a player. Never the token. */
export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string; // picture URL (Deezer profile), may be empty
  host: boolean;
  online: boolean;
  source: MusicSource | null; // null = still choosing their music
  tracks: number;
  score: number;
}

/** A player as the game remembers them, even if they leave mid-game. */
export interface CastMember { id: string; name: string; avatar: string }

export interface SongOption { title: string; artist: string }

/** A question as one device sees it. The right answers are not in it. */
export interface RoundView {
  index: number; // 0-based
  total: number;
  startedAt: number; // server clock
  deadline: number; // server clock
  now: number; // server clock when sent: lets each device correct its own clock
  cast: CastMember[]; // the possible answers to "whose is it?"
  songs: SongOption[];
  trackId?: string; // the Deezer track to play: sent to the host's device only
  mine: { owner?: string; song?: number }; // this device's answers so far
  answered: string[]; // players who have answered everything
}

export interface RoundResult {
  id: string;
  owner: boolean | null; // null = no answer
  song: boolean | null;
  ownMiss: boolean; // it was their own track and they did not say so
  delta: number;
  score: number;
}

export interface RevealView {
  index: number;
  total: number;
  track: PotTrack;
  owners: string[]; // several when the track was in several pots
  songs: SongOption[];
  song: number; // index of the right option in songs
  results: RoundResult[];
  last: boolean;
}

export interface Award { ids: string[]; title: string; detail: string }

export interface FinalView {
  standings: { id: string; score: number; rank: number }[];
  awards: Award[];
  cast: CastMember[];
}

// Device → server
export type ClientMessage =
  // Join, or come back after a phone went to sleep: the token gives the same seat and score back.
  | { t: 'hello'; name: string; avatar?: string; token?: string; hostKey?: string }
  // The player's tracks for the pot; sent again to change them, while in the lobby.
  | { t: 'music'; source: MusicSource; avatar?: string; tracks: PotTrack[] }
  | { t: 'kick'; id: string } // host only
  | { t: 'start' } // host only
  | { t: 'answer'; index: number; owner?: string; song?: number } // each answer counts once
  | { t: 'next' } // host only: after a reveal, next round or the final standings
  | { t: 'replay' } // host only: back to the lobby, same players and music
  | { t: 'leave' };

// Server → device
export type ServerMessage =
  | { t: 'welcome'; you: { id: string; token: string; host: boolean } }
  | { t: 'room'; code: string; phase: Phase; players: PublicPlayer[]; expiresAt: number }
  | { t: 'round'; round: RoundView }
  | { t: 'progress'; index: number; answered: string[] }
  | { t: 'reveal'; reveal: RevealView }
  | { t: 'final'; final: FinalView }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode = 'bad-message' | 'full' | 'started' | 'not-host' | 'too-few' | 'not-ready' | 'kicked' | 'expired' | 'not-found';
