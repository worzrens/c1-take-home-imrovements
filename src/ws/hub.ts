import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

type Client = WebSocket & { subs?: Set<number> };

const clients = new Set<Client>();

export function attachWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server });

  // An 'error' event with no listener is rethrown by EventEmitter as an uncaught
  // exception, so a single client dropping mid-frame took the whole server down.
  wss.on('error', (err) => {
    console.error('[ws] server error', err);
  });

  wss.on('connection', (ws: Client) => {
    ws.subs = new Set();
    clients.add(ws);

    // Sockets that error never emit 'close', so without this they leaked into
    // `clients` and kept receiving broadcasts they could not deliver.
    ws.on('error', (err) => {
      console.error('[ws] connection error', err);
      clients.delete(ws);
      ws.terminate();
    });

    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'subscribe' && Array.isArray(m.conversationIds)) {
          ws.subs = new Set(m.conversationIds.map(Number));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  return wss;
}

/** Test seam: the broadcast set is module state, so tests need a way to reset it. */
export function _clientCount(): number {
  return clients.size;
}

export function broadcast(conversationId: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
