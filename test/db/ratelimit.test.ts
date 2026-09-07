import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { allReachable, mysqlConn, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, ALICE, BOB } from '../helpers/auth.ts';

/**
 * tasks/rate-limiting.md — about 5 sends per 10 seconds, per user per
 * conversation, 429 with Retry-After, and it has to hold across instances.
 */
const up = await allReachable();

describe('rate limiting', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');
  let limitMod: typeof import('../../src/http/rateLimit.ts');
  let conn: Connection;
  const madeIds: number[] = [];

  const send = async (s: ReturnType<typeof app.session>, conversationId: number, n: number) => {
    const res = await s.post('/api/messages', {
      conversationId,
      body: `rate probe ${n}`,
      clientId: `rl-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    if (res.status === 201) madeIds.push((res.body as { id: number }).id);
    return res;
  };

  before(async () => {
    redisMod = await import('../../src/db/redis.ts');
    limitMod = await import('../../src/http/rateLimit.ts');
    await redisMod.connectRedis();
    app = await appServer();
    conn = await mysqlConn();
  });

  // Each case starts from a clean window; otherwise the first test spends the
  // allowance the next one is asserting on.
  beforeEach(async () => {
    const keys = await redisMod.redis().keys('rl:send:*');
    if (keys.length) await redisMod.redis().del(keys);
  });

  after(async () => {
    if (madeIds.length) await conn.query('DELETE FROM messages WHERE id IN (?)', [madeIds]);
    await conn.end();
    await app.close();
    await redisMod.closeRedis();
  });

  it('allows the first five sends and rejects the sixth with 429 + Retry-After', async () => {
    const alice = app.session();
    await alice.login(ALICE);

    const results = [];
    for (let i = 0; i < 6; i++) results.push(await send(alice, 1, i));

    const allowed = results.filter((r) => r.status === 201).length;
    const limited = results.filter((r) => r.status === 429);
    assert.equal(allowed, 5, 'five got through');
    assert.equal(limited.length, 1, 'the sixth was refused');

    const retryAfter = limited[0].headers.get('retry-after');
    assert.ok(retryAfter, 'Retry-After header present');
    const seconds = Number(retryAfter);
    assert.ok(seconds >= 1 && seconds <= 10, `Retry-After looks sane: ${retryAfter}`);
    assert.match((limited[0].body as { error: string }).error, /slow down/);
  });

  it('is per user — one noisy sender does not throttle anyone else in the room', async () => {
    const alice = app.session();
    const bob = app.session();
    await alice.login(ALICE);
    await bob.login(BOB);

    // Alice burns her allowance in conversation 1.
    for (let i = 0; i < 6; i++) await send(alice, 1, i);
    assert.equal((await send(alice, 1, 99)).status, 429, 'Alice is limited');

    // Bob is a participant in the same conversation and is unaffected.
    assert.equal((await send(bob, 1, 0)).status, 201, 'Bob is not');
  });

  it('is per conversation — being limited in one room does not silence another', async () => {
    const alice = app.session();
    await alice.login(ALICE);
    for (let i = 0; i < 6; i++) await send(alice, 1, i);
    assert.equal((await send(alice, 1, 99)).status, 429);
    assert.equal((await send(alice, 2, 0)).status, 201, 'her other conversation still works');
  });

  it('the counter lives in Redis, so every instance shares one window', async () => {
    // Talking to the limiter directly is the only way to prove the state is not
    // in process memory: a second "instance" is just a second caller of the same
    // key, which is exactly what a scaled deployment is.
    const key = `rl:test:${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limitMod.consume(key, 3, 10_000));

    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true, false],
      'the fourth call is refused however many callers there were',
    );
    assert.ok(results[3].retryAfterSeconds >= 1);
    assert.equal(await redisMod.redis().exists(key), 1, 'state is in Redis, not in the process');
    await redisMod.redis().del(key);
  });

  it('the window slides — the allowance comes back', async () => {
    const key = `rl:test:slide:${Date.now()}`;
    // A 1-second window so the test does not sit for ten.
    for (let i = 0; i < 2; i++) await limitMod.consume(key, 2, 1000);
    assert.equal((await limitMod.consume(key, 2, 1000)).allowed, false);

    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await limitMod.consume(key, 2, 1000)).allowed, true, 'allowance returned');
    await redisMod.redis().del(key);
  });
});
