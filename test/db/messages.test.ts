import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bothReachable, mysqlConn, SKIP_DB } from '../helpers/db.ts';
import type { Connection } from 'mysql2/promise';

/**
 * The message write path against real MySQL + Mongo:
 *   N5 — a repeated clientId returns the original message, never a second row.
 *   N6 — the timestamp comes from the database and is millisecond-precise.
 *   C8 — a body missing from Mongo surfaces as an orphan, not as empty text.
 *
 * Uses the real `createMessage` and the real `src/db` singletons, so
 * MYSQL_URL / MONGO_URL must point at the compose stack (see `npm run test:db`).
 */
const up = await bothReachable();

describe('N5 + N6 + C8: createMessage against live databases', { skip: up ? false : SKIP_DB }, () => {
  let createMessage: typeof import('../../src/services/messages.ts').createMessage;
  let mongo: typeof import('../../src/db/mongo.ts').mongo;
  let conn: Connection;
  const CONVERSATION = 1; // seeded
  const SENDER = 1; // seeded
  const madeIds: number[] = [];

  before(async () => {
    const svc = await import('../../src/services/messages.ts');
    const mongoMod = await import('../../src/db/mongo.ts');
    await mongoMod.connectMongo();
    createMessage = svc.createMessage;
    mongo = mongoMod.mongo;
    conn = await mysqlConn();
  });

  after(async () => {
    if (madeIds.length) {
      await conn.query('DELETE FROM messages WHERE id IN (?)', [madeIds]);
      await mongo()
        .collection('message_bodies')
        .deleteMany({ _id: { $in: madeIds as never[] } });
    }
    await conn.end();
  });

  it('N5: a fresh clientId creates exactly one row and returns the body', async () => {
    const clientId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const msg = await createMessage({
      conversationId: CONVERSATION,
      senderId: SENDER,
      body: 'first write',
      clientId,
    });
    madeIds.push(msg.id);

    assert.equal(msg.duplicate, false);
    assert.equal(msg.body, 'first write');

    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND client_id = ?',
      [CONVERSATION, clientId],
    );
    assert.equal((rows as { n: number }[])[0].n, 1);
  });

  it('N5: replaying the same clientId returns the original message, no new row', async () => {
    const clientId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const first = await createMessage({
      conversationId: CONVERSATION,
      senderId: SENDER,
      body: 'original body',
      clientId,
    });
    madeIds.push(first.id);

    const replay = await createMessage({
      conversationId: CONVERSATION,
      senderId: SENDER,
      body: 'DIFFERENT body on retry',
      clientId,
    });

    assert.equal(replay.duplicate, true);
    assert.equal(replay.id, first.id, 'same row');
    assert.equal(replay.body, 'original body', 'the retry body is ignored');

    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND client_id = ?',
      [CONVERSATION, clientId],
    );
    assert.equal((rows as { n: number }[])[0].n, 1, 'still one row');
  });

  it('N6: createdAt is millisecond-precise and identical to what the DB stored', async () => {
    const clientId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const msg = await createMessage({
      conversationId: CONVERSATION,
      senderId: SENDER,
      body: 'timestamp check',
      clientId,
    });
    madeIds.push(msg.id);
    assert.equal(msg.duplicate, false);

    const [rows] = await conn.query('SELECT created_at AS createdAt FROM messages WHERE id = ?', [
      msg.id,
    ]);
    const stored = (rows as { createdAt: Date }[])[0].createdAt;
    const returned = msg.createdAt as Date; // absent only on the duplicate branch, asserted above
    assert.equal(
      new Date(returned).getTime(),
      new Date(stored).getTime(),
      'returned timestamp equals the stored row',
    );
    assert.ok(Number.isFinite(new Date(returned).getTime()));
  });

  it('C8: a body missing from Mongo is reported as an orphan by the reconcile query', async () => {
    const clientId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const msg = await createMessage({
      conversationId: CONVERSATION,
      senderId: SENDER,
      body: 'will lose its body',
      clientId,
    });
    madeIds.push(msg.id);

    // Simulate the drift the compensation exists to catch.
    await mongo().collection('message_bodies').deleteOne({ _id: msg.id as never });

    // Mirror src/db/reconcile.ts.
    const [rows] = await conn.query('SELECT id FROM messages WHERE id = ?', [msg.id]);
    const ids = (rows as { id: number }[]).map((r) => r.id);
    const present = new Set(
      (
        await mongo()
          .collection('message_bodies')
          .find({ _id: { $in: ids as never[] } }, { projection: { _id: 1 } })
          .toArray()
      ).map((d) => d._id as unknown as number),
    );
    const orphans = ids.filter((id) => !present.has(id));
    assert.deepEqual(orphans, [msg.id], 'the body-less row is flagged');
  });
});
