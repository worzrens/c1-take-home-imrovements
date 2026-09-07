import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Connection } from 'mysql2/promise';
import { WebSocket } from 'ws';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, Session, ALICE, CAROL } from '../helpers/auth.ts';

/**
 * C3 (error handling) and C7 (upgrade authentication and server-side
 * authorization of subscriptions).
 */
const up = await allReachable();

describe('WebSocket hub', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');
  let hub: typeof import('../../src/ws/hub.ts');
  let conn: Connection;

  // The hub attaches to its own bare http server; the app server next to it just
  // issues cookies.
  let wsServer: http.Server;
  let wsUrl: string;
  let wss: ReturnType<typeof hub.attachWs>;
  const open: WebSocket[] = [];
  const realErr = console.error;

  const connect = (session: Session): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { cookie: session.cookieHeader } });
      open.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  const subscribe = (ws: WebSocket, ids: number[]) =>
    new Promise<void>((resolve) => {
      ws.send(JSON.stringify({ type: 'subscribe', conversationIds: ids }));
      // The hub resolves membership from the database before it applies the set.
      setTimeout(resolve, 150);
    });

  const nextMessage = (ws: WebSocket, ms = 1500): Promise<Record<string, unknown> | null> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      ws.once('message', (d) => {
        clearTimeout(t);
        resolve(JSON.parse(d.toString()));
      });
    });

  before(async () => {
    redisMod = await import('../../src/db/redis.ts');
    hub = await import('../../src/ws/hub.ts');
    await redisMod.connectRedis();
    app = await appServer();
    conn = await mysqlConn();
  });

  after(async () => {
    await conn.end();
    await app.close();
    await redisMod.closeRedis();
  });

  beforeEach(async () => {
    console.error = () => {};
    wsServer = http.createServer();
    wss = hub.attachWs(wsServer);
    await new Promise<void>((r) => wsServer.listen(0, '127.0.0.1', r));
    wsUrl = `ws://127.0.0.1:${(wsServer.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    for (const ws of open.splice(0)) ws.close();
    hub._reset();
    wss.close();
    await new Promise<void>((r) => wsServer.close(() => r()));
    console.error = realErr;
  });

  /* ---------------------------------------------------------------- C7 ---- */

  it('C7: rejects an upgrade with no cookie', async () => {
    const ws = new WebSocket(wsUrl);
    open.push(ws);
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(err.message, /401/, 'handshake refused, not accepted then closed');
  });

  it('C7: rejects an upgrade with a bogus token', async () => {
    const ws = new WebSocket(wsUrl, { headers: { cookie: 'access_token=nonsense' } });
    open.push(ws);
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    assert.match(err.message, /401/);
  });

  it('C7: accepts an authenticated upgrade', async () => {
    const s = app.session();
    await s.login(ALICE);
    const ws = await connect(s);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it('C7: a subscription to a conversation you are not in is dropped', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const ws = await connect(carol);
    // Carol is in conversation 2 only. She asks for both.
    await subscribe(ws, [1, 2]);

    hub.broadcast(1, { type: 'message', conversationId: 1, body: 'private' });
    assert.equal(await nextMessage(ws), null, 'nothing from conversation 1');

    hub.broadcast(2, { type: 'message', conversationId: 2, body: 'hers' });
    const got = await nextMessage(ws);
    assert.equal(got?.conversationId, 2, 'her own conversation still works');
  });

  /* ---------------------------------------------------------------- C3 ---- */

  it('C3: an errored socket leaves the broadcast set and the server survives', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const a = await connect(alice);
    const doomed = await connect(alice);
    await subscribe(a, [1]);
    await subscribe(doomed, [1]);
    assert.equal(hub._clientCount(), 2);

    (doomed as unknown as { _socket: { destroy: () => void } })._socket.destroy();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hub._clientCount(), 1, 'the dead socket was cleaned up');

    hub.broadcast(1, { type: 'message', conversationId: 1, body: 'still here' });
    assert.equal((await nextMessage(a))?.body, 'still here');
  });

  it('C3: a malformed frame is ignored without dropping the connection', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const ws = await connect(alice);
    await subscribe(ws, [1]);

    ws.send('not json at all');
    ws.send(JSON.stringify({ type: 'unknown-verb' }));
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(ws.readyState, WebSocket.OPEN);
    hub.broadcast(1, { type: 'message', conversationId: 1, body: 'survived' });
    assert.equal((await nextMessage(ws))?.body, 'survived');
  });
});
