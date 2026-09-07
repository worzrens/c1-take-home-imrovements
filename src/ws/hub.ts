import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { parseCookieHeader, ACCESS_COOKIE } from '../auth/cookies.ts';
import { verifyAccessToken } from '../auth/tokens.ts';
import { participantConversationIds } from '../auth/authorize.ts';
import { redis, subscriber } from '../db/redis.ts';

type Client = WebSocket & {
  userId?: number;
  subs?: Set<number>;
};

const clients = new Set<Client>();

/**
 * One channel for every real-time event. Each instance publishes here and every
 * instance — including the one that published — receives it and fans out to its
 * own sockets. The local `clients` set is the last hop only, which is what makes
 * `--scale api=3` work: before this, a message only reached the subset of users
 * who happened to be connected to the instance that handled the POST.
 */
const CHANNEL = 'relay:events';

let redisReady = false;
// One subscription per process. Subscribing again on every attachWs would stack
// callbacks on the same channel and deliver each event once per call.
let fanoutSubscribed = false;

/* -------------------------------------------------------------------------- */
/* Delivery                                                                    */
/* -------------------------------------------------------------------------- */

function deliverLocal(conversationId: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Publishes rather than delivering directly. The subscriber below picks it back
 * up on this instance too, so there is exactly one delivery path and no branch
 * where local and remote clients see different things.
 *
 * With no Redis connected it falls back to local delivery, which keeps the unit
 * tests honest without a server. `src/index.ts` fails fast if Redis is
 * unreachable, so a real deployment never takes that branch.
 */
export function broadcast(conversationId: number, payload: unknown): void {
  if (!redisReady) return deliverLocal(conversationId, payload);
  redis()
    .publish(CHANNEL, JSON.stringify({ conversationId, payload }))
    .catch((err) => {
      console.error('[ws] publish failed, delivering locally only', err);
      deliverLocal(conversationId, payload);
    });
}

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

export async function attachWs(server: Server): Promise<WebSocketServer> {
  // noServer, so the upgrade can be rejected before the handshake completes
  // rather than accepting the socket and closing it afterwards.
  const wss = new WebSocketServer({ noServer: true });

  wss.on('error', (err) => console.error('[ws] server error', err));

  // The endpoint used to accept any upgrade on any path and any subscription.
  // The cookie is sent automatically on upgrade, which is the reason the token
  // lives in one.
  server.on('upgrade', (req, socket, head) => {
    const token = parseCookieHeader(req.headers.cookie)[ACCESS_COOKIE];
    if (!token) return reject(socket);

    verifyAccessToken(token)
      .then((claims) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          (ws as Client).userId = Number(claims.sub);
          wss.emit('connection', ws);
        });
      })
      .catch(() => reject(socket));
  });

  wss.on('connection', (ws: Client) => {
    ws.subs = new Set();
    clients.add(ws);

    // Sockets that error never emit 'close', so without this they leaked into
    // the broadcast set and kept being selected for sends they could not make.
    ws.on('error', (err) => {
      console.error('[ws] connection error', err);
      clients.delete(ws);
      ws.terminate();
    });

    ws.on('message', (raw) => {
      let m: { type?: string; conversationIds?: unknown };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return; /* ignore malformed frames */
      }
      if (m.type === 'subscribe') void handleSubscribe(ws, m.conversationIds);
    });

    ws.on('close', () => clients.delete(ws));
  });

  await subscribeToFanout();
  return wss;
}

function reject(socket: { write: (s: string) => void; destroy: () => void }): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

async function subscribeToFanout(): Promise<void> {
  if (fanoutSubscribed) return;
  try {
    await subscriber().subscribe(CHANNEL, (raw) => {
      try {
        const { conversationId, payload } = JSON.parse(raw);
        deliverLocal(conversationId, payload);
      } catch (err) {
        console.error('[ws] bad fan-out frame', err);
      }
    });
    fanoutSubscribed = true;
    redisReady = true;
  } catch (err) {
    console.error('[ws] no Redis fan-out; real-time is single-instance only', err);
    redisReady = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound frames                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The client asks for a set of conversations; the server intersects it with the
 * ones the user is actually in. A client could previously subscribe to any id
 * and receive that conversation's traffic in real time.
 */
async function handleSubscribe(ws: Client, requested: unknown): Promise<void> {
  if (!Array.isArray(requested) || ws.userId === undefined) return;
  try {
    const allowed = new Set(await participantConversationIds(ws.userId));
    ws.subs = new Set(requested.map(Number).filter((id) => allowed.has(id)));
  } catch (err) {
    console.error('[ws] subscribe failed', err);
  }
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                  */
/* -------------------------------------------------------------------------- */

export function _clientCount(): number {
  return clients.size;
}

export function _reset(): void {
  for (const ws of clients) ws.terminate();
  clients.clear();
}
