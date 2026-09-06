import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'mysql2/promise';
import type { MongoClient } from 'mongodb';
import { bothReachable, mysqlConn, mongoClient, MYSQL_URL, MONGO_URL, SKIP_DB } from '../helpers/db.ts';

/**
 * C6 — the seed used to `deleteMany({})` the message bodies and re-insert the
 * demo set on every boot. Because MySQL was only seeded on an empty data
 * directory, a restart left the rows and destroyed their bodies, so every older
 * message rendered blank permanently. The seed is now idempotent: a rerun must
 * touch neither the demo bodies nor anything written by real traffic.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = promisify(execFile);
const up = await bothReachable();

describe('C6: the seed is idempotent and never destroys bodies', { skip: up ? false : SKIP_DB }, () => {
  let conn: Connection;
  let mongo: MongoClient;
  const TRAFFIC_ID = 424242;

  const runSeed = () =>
    run('node', ['--import', 'tsx', 'docker/db/seed.ts'], {
      cwd: root,
      env: { ...process.env, MYSQL_URL, MONGO_URL },
    });

  before(async () => {
    conn = await mysqlConn();
    mongo = await mongoClient();
    // A body that stands in for one written by a real user after the last seed.
    await mongo
      .db()
      .collection('message_bodies')
      .updateOne(
        { _id: TRAFFIC_ID as never },
        { $set: { _id: TRAFFIC_ID, conversationId: 1, senderId: 1, body: 'real traffic body', createdAt: new Date() } },
        { upsert: true },
      );
  });

  after(async () => {
    await mongo.db().collection('message_bodies').deleteOne({ _id: TRAFFIC_ID as never });
    await conn.end();
    await mongo.close();
  });

  it('runs twice in a row, exit 0 both times', async () => {
    const a = await runSeed();
    assert.match(a.stdout, /seeded demo/);
    const b = await runSeed();
    assert.match(b.stdout, /seeded demo/);
  });

  it('leaves the three demo bodies exactly as they were', async () => {
    const bodies = mongo.db().collection('message_bodies');
    const demo = await bodies.find({ _id: { $in: [1, 2, 3] as never[] } }).sort({ _id: 1 }).toArray();
    assert.equal(demo.length, 3);
    assert.deepEqual(
      demo.map((d) => d.body),
      ['Hi, any update on order #1042?', 'Checking now, give me a minute.', 'Notes from the design sync are in the doc.'],
    );
  });

  it('leaves a body written by real traffic untouched', async () => {
    const doc = await mongo.db().collection('message_bodies').findOne({ _id: TRAFFIC_ID as never });
    assert.equal(doc?.body, 'real traffic body');
  });

  it('keeps the demo message rows in MySQL with their NULL client_id', async () => {
    const [rows] = await conn.query(
      'SELECT id, client_id AS clientId FROM messages WHERE id IN (1, 2, 3) ORDER BY id',
    );
    assert.deepEqual(rows, [
      { id: 1, clientId: null },
      { id: 2, clientId: null },
      { id: 3, clientId: null },
    ]);
  });
});
