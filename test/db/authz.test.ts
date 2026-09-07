import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, ALICE, CAROL } from '../helpers/auth.ts';

/**
 * SEC-1 — the IDOR. Conversation 1 seeds Alice and Bob; Carol is only in
 * conversation 2. Before C1 she could read and post to conversation 1 by putting
 * someone else's id in the query string.
 */
const up = await allReachable();

describe('C1/C7: conversation membership is enforced', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');
  let conn: Connection;
  const madeIds: number[] = [];

  before(async () => {
    redisMod = await import('../../src/db/redis.ts');
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

  // These suites send more than the rate limit allows in a 10s window; the
  // limiter has its own suite and must not decide the outcome here.
  beforeEach(async () => {
    const keys = await redisMod.redis().keys('rl:send:*');
    if (keys.length) await redisMod.redis().del(keys);
  });

  it('a participant can read and post', async () => {
    const alice = app.session();
    await alice.login(ALICE);

    const read = await alice.fetch('/api/messages?conversationId=1');
    assert.equal(read.status, 200);

    const sent = await alice.post('/api/messages', {
      conversationId: 1,
      body: 'from a participant',
      clientId: `authz-ok-${Date.now()}`,
    });
    assert.equal(sent.status, 201);
    madeIds.push((sent.body as { id: number }).id);
  });

  it('a non-participant gets 403 reading, and the body says nothing about existence', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const { status, body } = await carol.fetch('/api/messages?conversationId=1');
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'not a participant in this conversation' });
  });

  it('a non-participant gets 403 posting', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const { status } = await carol.post('/api/messages', {
      conversationId: 1,
      body: 'should not land',
      clientId: `authz-no-${Date.now()}`,
    });
    assert.equal(status, 403);
  });

  it('a 403 is indistinguishable from a conversation that does not exist', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const real = await carol.fetch('/api/messages?conversationId=1');
    const fake = await carol.fetch('/api/messages?conversationId=999999');
    assert.equal(real.status, fake.status);
    assert.deepEqual(real.body, fake.body);
  });

  it('senderId in the body is ignored — you post as your token, not as who you claim', async () => {
    const alice = app.session();
    const me = await alice.login(ALICE);
    const sent = await alice.post('/api/messages', {
      conversationId: 1,
      senderId: 999,
      body: 'impersonation attempt',
      clientId: `authz-spoof-${Date.now()}`,
    });
    assert.equal(sent.status, 201);
    const msg = sent.body as { id: number; senderId: number };
    madeIds.push(msg.id);
    assert.equal(msg.senderId, me.id, 'sender came from the token');
  });

  it('the conversation list is the caller’s own, with no userId parameter to change it', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    // The old ?userId= is inert now.
    const { status, body } = await carol.fetch('/api/conversations?userId=1');
    assert.equal(status, 200);
    const ids = (body as { id: number }[]).map((c) => c.id);
    assert.ok(!ids.includes(1), 'Carol cannot see conversation 1 by asking for Alice');
    assert.ok(ids.includes(2), 'she does see her own');
  });

  it('the creator is always a participant in a conversation they create', async () => {
    const carol = app.session();
    const me = await carol.login(CAROL);
    const created = await carol.post('/api/conversations', {
      title: `authz probe ${Date.now()}`,
      participantIds: [2],
    });
    assert.equal(created.status, 201);
    const { id, participantIds } = created.body as { id: number; participantIds: number[] };
    assert.ok(participantIds.includes(me.id));

    // And she can immediately read it back.
    assert.equal((await carol.fetch(`/api/messages?conversationId=${id}`)).status, 200);
    await conn.query('DELETE FROM conversations WHERE id = ?', [id]);
  });
});
