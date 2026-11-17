// Entry point: creates rooms and routes each device to its room's Durable Object.
//   POST /rooms              → { code, hostKey }     create a room
//   GET  /rooms/:code        → { phase, players }    does this code exist? (join screen)
//   GET  /rooms/:code/ws     → WebSocket             play
import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
  CREATE_LIMIT?: RateLimit; // rooms created per address and per minute (wrangler.jsonc)
}

// No I or O: a code read aloud across a living room must not be ambiguous.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return origin && allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Vary': 'Origin' }
    : {};
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = cors(origin, env);
    // Rooms are only opened from the game's own site: a browser always says where it comes from.
    if (!headers['Access-Control-Allow-Origin']) return json({ error: 'origin' }, 403, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (url.pathname === '/rooms' && request.method === 'POST') {
      // A script creating rooms in a loop is cut off: each room is storage and an alarm.
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      if (env.CREATE_LIMIT && !(await env.CREATE_LIMIT.limit({ key: ip })).success) return json({ error: 'too-many' }, 429, headers);
      for (let i = 0; i < 6; i++) {
        const code = newCode();
        const hostKey = await env.ROOMS.getByName(code).init(code);
        if (hostKey) return json({ code, hostKey }, 201, headers);
      }
      return json({ error: 'busy' }, 503, headers);
    }

    const m = url.pathname.match(/^\/rooms\/([A-Za-z]{4})(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'not-found' }, 404, headers);
      const room = env.ROOMS.getByName(code);
      if (m[2]) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'upgrade' }, 426, headers);
        return room.fetch(request);
      }
      const info = await room.info();
      return info ? json(info, 200, headers) : json({ error: 'not-found' }, 404, headers);
    }

    return json({ error: 'not-found' }, 404, headers);
  },
} satisfies ExportedHandler<Env>;
