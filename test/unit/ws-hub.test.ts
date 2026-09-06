import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachWs, broadcast, _clientCount } from '../../src/ws/hub.ts';

/**
 * C3 — the connection handler listened for 'message' and 'close' but not
 * 'error'. An 'error' with no listener is rethrown by EventEmitter as an
 * uncaught exception, so one client resetting its socket took the whole server
 * down. Errored sockets also never emit 'close', so they leaked into the
 * broadcast set.
 */
describe('C3: WebSocket errors are contained', () => {
  let server: http.Server;
  let url: string;
  let wss: ReturnType<typeof attachWs>;
  const open: WebSocket[] = [];

  const connect = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      open.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  const subscribe = (ws: WebSocket, ids: number[]) =>
    new Promise<void>((resolve) => {
      ws.send(JSON.stringify({ type: 'subscribe', conversationIds: ids }));
      // The hub sets subs synchronously on the message event; a round trip is enough.
      setTimeout(resolve, 50);
    });

  const nextMessage = (ws: WebSocket, ms = 300): Promise<unknown> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(Symbol('timeout')), ms);
      ws.once('message', (d) => {
        clearTimeout(t);
        resolve(JSON.parse(d.toString()));
      });
    });

  // The hub logs every socket and server error it handles — expected here.
  const realErr = console.error;

  beforeEach(async () => {
    console.error = () => {};
    server = http.createServer();
    wss = attachWs(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    for (const ws of open.splice(0)) ws.close();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
    console.error = realErr;
  });

  it('delivers a broadcast only to subscribed, open clients', async () => {
    const a = await connect();
    const b = await connect();
    await subscribe(a, [1]);
    await subscribe(b, [2]);

    broadcast(1, { type: 'message', id: 99, conversationId: 1 });

    assert.deepEqual(await nextMessage(a), { type: 'message', id: 99, conversationId: 1 });
    assert.equal(typeof (await nextMessage(b)), 'symbol', 'client subscribed to 2 hears nothing');
  });

  it('a client error removes it from the broadcast set and does not crash the server', async () => {
    const a = await connect();
    const doomed = await connect();
    await subscribe(a, [1]);
    await subscribe(doomed, [1]);
    assert.equal(_clientCount(), 2);

    // Abrupt reset: the peer vanishes without a close frame. The server-side
    // socket emits 'error', never 'close'.
    (doomed as unknown as { _socket: { destroy: () => void } })._socket.destroy();
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(_clientCount(), 1, 'leaked socket was cleaned up on error');

    // The server is still alive and still serving the survivor.
    broadcast(1, { type: 'message', id: 7, conversationId: 1 });
    assert.deepEqual(await nextMessage(a), { type: 'message', id: 7, conversationId: 1 });
  });

  it('ignores malformed frames without dropping the connection', async () => {
    const a = await connect();
    await subscribe(a, [1]);

    a.send('this is not json');
    a.send(JSON.stringify({ type: 'nonsense' }));
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(a.readyState, WebSocket.OPEN);
    broadcast(1, { type: 'message', id: 5, conversationId: 1 });
    assert.deepEqual(await nextMessage(a), { type: 'message', id: 5, conversationId: 1 });
  });

  it('a server-level error is logged, not thrown', () => {
    assert.doesNotThrow(() => wss.emit('error', new Error('synthetic server error')));
  });
});
