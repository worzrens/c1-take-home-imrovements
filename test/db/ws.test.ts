import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Connection } from 'mysql2/promise';
import { WebSocket } from 'ws';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, Session, ALICE, BOB, CAROL } from '../helpers/auth.ts';

/**
 * C3 (error handling), C7 (upgrade auth and subscription authorization),
 * tasks/multi-instance.md (Redis fan-out) and tasks/typing-indicator.md, all of
 * which live in the same hub.
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
  let wss: Awaited<ReturnType<typeof hub.attachWs>>;
  const open: WebSocket[] = [];
  const madeIds: number[] = [];
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
    if (madeIds.length) await conn.query('DELETE FROM messages WHERE id IN (?)', [madeIds]);
    await conn.end();
    await app.close();
    await redisMod.closeRedis();
  });

  beforeEach(async () => {
    console.error = () => {};
    // Sends in these cases must not be throttled by a previous one.
    const keys = await redisMod.redis().keys('rl:send:*');
    if (keys.length) await redisMod.redis().del(keys);

    wsServer = http.createServer();
    wss = await hub.attachWs(wsServer);
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

  /* ------------------------------------------------------ multi-instance --- */

  it('multi-instance: a broadcast is published to Redis, not kept in-process', async () => {
    // A raw subscriber stands in for another instance. If the payload shows up
    // here, an instance that never handled the request can still deliver it.
    const spy = redisMod.redis().duplicate();
    await spy.connect();
    const seen: string[] = [];
    try {
      await spy.subscribe('relay:events', (m: string) => seen.push(m));

      hub.broadcast(1, { type: 'message', conversationId: 1, body: 'over the wire' });
      await new Promise((r) => setTimeout(r, 300));

      assert.equal(seen.length, 1, 'exactly one publish');
      const frame = JSON.parse(seen[0]);
      assert.equal(frame.conversationId, 1);
      assert.equal(frame.payload.body, 'over the wire');
    } finally {
      await spy.unsubscribe('relay:events').catch(() => {});
      await spy.quit().catch(() => {});
    }
  });

  it('multi-instance: an event from another instance reaches this one’s sockets', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const ws = await connect(alice);
    await subscribe(ws, [1]);

    // Published by a client that is not this hub — the other instance.
    const other = redisMod.redis().duplicate();
    await other.connect();
    try {
      await other.publish(
        'relay:events',
        JSON.stringify({
          conversationId: 1,
          payload: { type: 'message', conversationId: 1, body: 'from instance two' },
        }),
      );
      const got = await nextMessage(ws);
      assert.equal(got?.body, 'from instance two', 'delivered to a socket on this instance');
    } finally {
      await other.quit().catch(() => {});
    }
  });

  it('multi-instance: an event for a conversation this socket is not in is not delivered', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const ws = await connect(carol);
    await subscribe(ws, [2]);

    const other = redisMod.redis().duplicate();
    await other.connect();
    try {
      await other.publish(
        'relay:events',
        JSON.stringify({ conversationId: 1, payload: { type: 'message', body: 'not hers' } }),
      );
      assert.equal(await nextMessage(ws), null, 'the fan-out still respects subscriptions');
    } finally {
      await other.quit().catch(() => {});
    }
  });

  it('multi-instance: a real POST fans out to a subscriber, not just a direct broadcast', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const ws = await connect(alice);
    await subscribe(ws, [1]);

    const res = await alice.post('/api/messages', {
      conversationId: 1,
      body: 'through the route',
      clientId: `ws-route-${Date.now()}`,
    });
    assert.equal(res.status, 201);
    madeIds.push((res.body as { id: number }).id);

    const got = await nextMessage(ws);
    assert.equal(got?.type, 'message');
    assert.equal(got?.body, 'through the route');
  });

  /* ------------------------------------------------------------- typing --- */

  it('typing: a frame reaches the other participant with a name', async () => {
    const alice = app.session();
    const bob = app.session();
    await alice.login(ALICE);
    await bob.login(BOB);

    const aliceWs = await connect(alice);
    const bobWs = await connect(bob);
    await subscribe(aliceWs, [1]);
    await subscribe(bobWs, [1]);

    aliceWs.send(JSON.stringify({ type: 'typing', conversationId: 1 }));

    const got = await nextMessage(bobWs);
    assert.equal(got?.type, 'typing');
    assert.equal(got?.conversationId, 1);
    assert.equal(got?.name, 'Alice', 'carries a name so the UI can say who');
  });

  it('typing: throttled, so a fast typist does not flood the room', async () => {
    const alice = app.session();
    const bob = app.session();
    await alice.login(ALICE);
    await bob.login(BOB);

    const aliceWs = await connect(alice);
    const bobWs = await connect(bob);
    await subscribe(aliceWs, [1]);
    await subscribe(bobWs, [1]);

    const seen: unknown[] = [];
    bobWs.on('message', (d) => seen.push(JSON.parse(d.toString())));

    // Ten frames in quick succession, as a keystroke handler would send.
    for (let i = 0; i < 10; i++) aliceWs.send(JSON.stringify({ type: 'typing', conversationId: 1 }));
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(seen.length, 1, 'dropped rather than rejected, and only the first got through');
  });

  it('typing: a frame for a conversation you are not in is dropped', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const carolWs = await connect(carol);
    await subscribe(carolWs, [2]);

    const alice = app.session();
    await alice.login(ALICE);
    const aliceWs = await connect(alice);
    await subscribe(aliceWs, [1]);

    // Carol claims to be typing in conversation 1, which she is not in.
    carolWs.send(JSON.stringify({ type: 'typing', conversationId: 1 }));
    assert.equal(await nextMessage(aliceWs), null, 'nothing leaked into conversation 1');
  });
});
