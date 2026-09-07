import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, Session, ALICE } from '../helpers/auth.ts';

/**
 * The HTTP surface against real databases, end to end:
 *   N2 — GET returns { messages, hasMore, nextBefore } and the keyset cursor
 *        walks history with no gap or repeat.
 *   N5 — a duplicate clientId over HTTP is 200 + duplicate:true, still one row.
 *   N6 — the createdAt from POST is byte-identical to the one from GET.
 *   C8 — a message whose body is missing from Mongo comes back as body:null.
 *   N1 — GET /api/conversations returns lastMessage + messageCount per row.
 */
const up = await allReachable();

describe('HTTP + databases: end to end', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');
  let mongoMod: typeof import('../../src/db/mongo.ts');
  let conn: Connection;
  let alice: Session;
  const CONV = 1;
  let me: { id: number };
  const madeIds: number[] = [];
  const realErr = console.error;

  const post = (body: string, clientId: string) =>
    alice.post('/api/messages', { conversationId: CONV, body, clientId });

  before(async () => {
    console.error = () => {};
    redisMod = await import('../../src/db/redis.ts');
    mongoMod = await import('../../src/db/mongo.ts');
    await redisMod.connectRedis();
    await mongoMod.connectMongo();
    conn = await mysqlConn();
    app = await appServer();
    alice = app.session();
    me = await alice.login(ALICE);
  });

  after(async () => {
    if (madeIds.length) {
      await conn.query('DELETE FROM messages WHERE id IN (?)', [madeIds]);
      await mongoMod.mongo()
        .collection('message_bodies')
        .deleteMany({ _id: { $in: madeIds as never[] } });
    }
    await conn.end();
    await app.close();
    await redisMod.closeRedis();
    console.error = realErr;
  });

  // These suites send more than the rate limit allows in a 10s window; the
  // limiter has its own suite and must not decide the outcome here.
  beforeEach(async () => {
    const keys = await redisMod.redis().keys('rl:send:*');
    if (keys.length) await redisMod.redis().del(keys);
  });

  it('N5 + N6: POST then GET a message, timestamps and body match', async () => {
    const created = await post('hello over http', `e2e-${Date.now()}-a`);
    assert.equal(created.status, 201);
    const msg = created.body as { id: number; body: string; createdAt: string; duplicate: boolean };
    madeIds.push(msg.id);
    assert.equal(msg.duplicate, false);

    const list = await alice.fetch(`/api/messages?conversationId=${CONV}&limit=200`);
    assert.equal(list.status, 200);
    const page = list.body as {
      messages: { id: number; body: string; createdAt: string }[];
      hasMore: boolean;
      nextBefore: number;
    };
    assert.ok(Array.isArray(page.messages), 'paginated shape, not a bare array');
    assert.ok('hasMore' in page && 'nextBefore' in page);

    const back = page.messages.find((m) => m.id === msg.id)!;
    assert.equal(back.body, 'hello over http');
    assert.equal(back.createdAt, msg.createdAt, 'GET timestamp equals POST timestamp exactly');
    assert.match(String(back.createdAt), /\.\d{3}/, 'millisecond component present');
  });

  it('N5: replaying the clientId is 200 duplicate, still one row', async () => {
    const clientId = `e2e-${Date.now()}-b`;
    const first = await post('idem body', clientId);
    const firstId = (first.body as { id: number }).id;
    madeIds.push(firstId);

    const replay = await post('different retry body', clientId);
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { duplicate: boolean }).duplicate, true);
    assert.equal((replay.body as { id: number }).id, firstId);

    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND client_id = ?',
      [CONV, clientId],
    );
    assert.equal((rows as { n: number }[])[0].n, 1);
  });

  it('N2: the keyset cursor walks a burst with no gap or repeat', async () => {
    const tag = `e2e-walk-${Date.now()}`;
    const posted: number[] = [];
    // Below the rate limit, and spread across two conversations would change the
    // ordering, so pace them instead.
    for (let i = 0; i < 4; i++) {
      const r = await post(`walk ${i}`, `${tag}-${i}`);
      assert.equal(r.status, 201, `send ${i}`);
      const id = (r.body as { id: number }).id;
      posted.push(id);
      madeIds.push(id);
    }

    const collected: number[] = [];
    let before: number | null = null;
    let guard = 0;
    while (guard++ < 50) {
      const qs = `conversationId=${CONV}&limit=3${before ? `&before=${before}` : ''}`;
      const { body } = await alice.fetch(`/api/messages?${qs}`);
      const page = body as { messages: { id: number }[]; hasMore: boolean; nextBefore: number };
      collected.unshift(...page.messages.map((m) => m.id));
      if (!page.hasMore) break;
      before = page.nextBefore;
    }

    assert.deepEqual(collected.filter((id) => posted.includes(id)), posted);
    assert.equal(new Set(collected).size, collected.length, 'no id returned twice');
  });

  it('C8: a message with no body in Mongo comes back as body:null', async () => {
    const r = await post('body to be removed', `e2e-${Date.now()}-c`);
    const id = (r.body as { id: number }).id;
    madeIds.push(id);

    await mongoMod.mongo().collection('message_bodies').deleteOne({ _id: id as never });

    const { body } = await alice.fetch(`/api/messages?conversationId=${CONV}&limit=200`);
    const page = body as { messages: { id: number; body: string | null }[] };
    assert.equal(page.messages.find((m) => m.id === id)!.body, null);
  });

  it('N1: GET /api/conversations returns lastMessage and messageCount', async () => {
    const r = await post('newest in conv 1', `e2e-${Date.now()}-d`);
    const id = (r.body as { id: number }).id;
    madeIds.push(id);

    const { status, body } = await alice.fetch('/api/conversations');
    assert.equal(status, 200);
    const list = body as { id: number; messageCount: number; lastMessage: { id: number } | null }[];
    const conv1 = list.find((c) => c.id === CONV)!;
    assert.ok(conv1.messageCount >= 1);
    assert.equal(conv1.lastMessage?.id, id);
  });

  it('C5: an HTML title is stored and returned verbatim as a string', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { status, body } = await alice.post('/api/conversations', {
      title: payload,
      participantIds: [2],
    });
    assert.equal(status, 201);
    const convId = (body as { id: number }).id;

    const { body: list } = await alice.fetch('/api/conversations');
    const created = (list as { id: number; title: unknown }[]).find((c) => c.id === convId)!;
    assert.equal(typeof created.title, 'string');
    assert.equal(created.title, payload, 'server stores raw text; the client escapes on render');

    await conn.query('DELETE FROM conversations WHERE id = ?', [convId]);
  });

  it('validation still applies behind the auth wall', async () => {
    assert.equal((await alice.post('/api/messages', {})).status, 400);
    assert.equal(
      (await alice.post('/api/messages', { conversationId: CONV, body: 'x' })).status,
      400,
      'clientId is required',
    );
    assert.equal(
      (await alice.post('/api/messages', { conversationId: CONV, body: 'x', clientId: 'y'.repeat(65) }))
        .status,
      400,
    );
    assert.equal((await alice.fetch('/api/messages')).status, 400);
    assert.equal((await alice.fetch(`/api/messages?conversationId=${CONV}&limit=0`)).status, 400);
    assert.equal((await alice.fetch(`/api/messages?conversationId=${CONV}&before=abc`)).status, 400);
    assert.equal(
      (await alice.post('/api/conversations', { title: 'a'.repeat(201), participantIds: [2] })).status,
      400,
    );
    assert.ok(me.id > 0);
  });
});
