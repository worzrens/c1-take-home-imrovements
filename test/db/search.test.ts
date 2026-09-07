import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, ALICE, CAROL } from '../helpers/auth.ts';

/** tasks/search.md — full-text search, scoped to the caller's conversations. */
const up = await allReachable();

describe('search', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');
  let mongoMod: typeof import('../../src/db/mongo.ts');
  let conn: Connection;
  const madeIds: number[] = [];
  const TAG = `zqxjkv${Date.now()}`; // a token that appears nowhere else

  before(async () => {
    redisMod = await import('../../src/db/redis.ts');
    mongoMod = await import('../../src/db/mongo.ts');
    await redisMod.connectRedis();
    await mongoMod.connectMongo();
    await mongoMod.ensureMongoIndexes();
    app = await appServer();
    conn = await mysqlConn();

    // One message in conversation 1 (Alice + Bob) and one in 2 (Alice + Carol).
    const alice = app.session();
    await alice.login(ALICE);
    for (const conversationId of [1, 2]) {
      const res = await alice.post('/api/messages', {
        conversationId,
        body: `needle ${TAG} in conversation ${conversationId}`,
        clientId: `search-${TAG}-${conversationId}`,
      });
      madeIds.push((res.body as { id: number }).id);
    }
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
  });

  it('finds a message by a word in its body', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const { status, body } = await alice.fetch(`/api/search?q=${TAG}`);
    assert.equal(status, 200);
    const hits = body as { conversationId: number; conversationTitle: string; body: string }[];
    assert.ok(hits.length >= 2, 'both messages found');
    assert.ok(hits.every((h) => h.body.includes(TAG)));
  });

  it('returns the shape the sidebar renders', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const { body } = await alice.fetch(`/api/search?q=${TAG}`);
    const hit = (body as Record<string, unknown>[])[0];
    assert.ok('conversationId' in hit && 'conversationTitle' in hit && 'body' in hit);
    assert.equal(typeof hit.conversationTitle, 'string');
  });

  it('scopes results to the caller — Carol never sees conversation 1', async () => {
    const carol = app.session();
    await carol.login(CAROL);
    const { body } = await carol.fetch(`/api/search?q=${TAG}`);
    const hits = body as { conversationId: number }[];
    assert.ok(hits.length >= 1, 'she does find her own');
    assert.ok(
      hits.every((h) => h.conversationId === 2),
      'search is not a way to read every message in the system',
    );
  });

  it('an operator object in q is coerced to a string, not injected', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    // Express parses ?q[$ne]= into an object; String() flattens it before it can
    // reach an operator position in the Mongo query.
    const { status, body } = await alice.fetch('/api/search?q[$ne]=x');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'no injection, no error — just no matches');
  });

  it('an empty query returns nothing rather than everything', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    assert.deepEqual((await alice.fetch('/api/search?q=')).body, []);
    assert.deepEqual((await alice.fetch('/api/search')).body, []);
  });

  it('rejects an absurdly long query and a bad limit', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    assert.equal((await alice.fetch(`/api/search?q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await alice.fetch(`/api/search?q=${TAG}&limit=0`)).status, 400);
  });

  it('honours limit', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    const { body } = await alice.fetch(`/api/search?q=${TAG}&limit=1`);
    assert.equal((body as unknown[]).length, 1);
  });
});
