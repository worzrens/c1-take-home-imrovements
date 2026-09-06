import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { bothReachable, mysqlConn, SKIP_DB } from '../helpers/db.ts';
import { listen, req, jsonPost, type RunningServer } from '../helpers/http.ts';

/**
 * The HTTP surface against real databases, end to end:
 *   N2 — GET returns { messages, hasMore, nextBefore } and the keyset cursor
 *        walks history with no gap or repeat.
 *   N5 — a duplicate clientId over HTTP is 200 + duplicate:true, still one row.
 *   N6 — the createdAt from POST is byte-identical to the one from GET.
 *   C8 — a message whose body is missing from Mongo comes back as body:null.
 *   N1 — GET /api/conversations returns lastMessage + messageCount per row.
 */
const up = await bothReachable();

describe('HTTP + databases: end to end', { skip: up ? false : SKIP_DB }, () => {
  let server: RunningServer;
  let conn: Connection;
  let mongo: typeof import('../../src/db/mongo.ts').mongo;
  const CONV = 1;
  const USER = 1;
  const madeIds: number[] = [];

  const post = (body: string, clientId: string) =>
    req(server.url, '/api/messages', jsonPost({ conversationId: CONV, senderId: USER, body, clientId }));

  // The C8 case below deliberately removes a body; the route logs that. Expected.
  const realErr = console.error;

  before(async () => {
    console.error = () => {};
    const { createApp } = await import('../../src/app.ts');
    const mongoMod = await import('../../src/db/mongo.ts');
    await mongoMod.connectMongo();
    mongo = mongoMod.mongo;
    conn = await mysqlConn();
    server = await listen(createApp());
  });

  after(async () => {
    if (madeIds.length) {
      await conn.query('DELETE FROM messages WHERE id IN (?)', [madeIds]);
      await mongo().collection('message_bodies').deleteMany({ _id: { $in: madeIds as never[] } });
    }
    await conn.end();
    await server.close();
    console.error = realErr;
  });

  it('N5 + N6: POST then GET a message, timestamps and body match', async () => {
    const clientId = `e2e-${Date.now()}-a`;
    const created = await post('hello over http', clientId);
    assert.equal(created.status, 201);
    const msg = created.body as { id: number; body: string; createdAt: string; duplicate: boolean };
    madeIds.push(msg.id);
    assert.equal(msg.duplicate, false);

    const list = await req(server.url, `/api/messages?conversationId=${CONV}&limit=200`);
    assert.equal(list.status, 200);
    const page = list.body as { messages: { id: number; body: string; createdAt: string }[]; hasMore: boolean; nextBefore: number };
    assert.ok(Array.isArray(page.messages), 'response is the paginated shape, not a bare array');
    assert.ok('hasMore' in page && 'nextBefore' in page);

    const back = page.messages.find((m) => m.id === msg.id)!;
    assert.equal(back.body, 'hello over http');
    assert.equal(back.createdAt, msg.createdAt, 'GET timestamp equals POST timestamp exactly');
    assert.match(String(back.createdAt), /\.\d{3}/, 'millisecond component present');
  });

  it('N5: replaying the clientId over HTTP is 200 duplicate, still one row', async () => {
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

  it('N2: the keyset cursor walks a burst of messages with no gap or repeat', async () => {
    const tag = `e2e-walk-${Date.now()}`;
    const posted: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await post(`walk ${i}`, `${tag}-${i}`);
      const id = (r.body as { id: number }).id;
      posted.push(id);
      madeIds.push(id);
    }

    const collected: number[] = [];
    let before: number | null = null;
    let guard = 0;
    while (guard++ < 50) {
      const qs = `conversationId=${CONV}&limit=3${before ? `&before=${before}` : ''}`;
      const { body } = await req(server.url, `/api/messages?${qs}`);
      const page = body as { messages: { id: number }[]; hasMore: boolean; nextBefore: number };
      collected.unshift(...page.messages.map((m) => m.id));
      if (!page.hasMore) break;
      before = page.nextBefore;
    }

    // Every id we posted appears exactly once, in ascending order.
    const walkedOurs = collected.filter((id) => posted.includes(id));
    assert.deepEqual(walkedOurs, posted);
    assert.equal(new Set(collected).size, collected.length, 'no id returned twice');
  });

  it('C8: a message with no body in Mongo comes back as body:null', async () => {
    const clientId = `e2e-${Date.now()}-c`;
    const r = await post('body to be removed', clientId);
    const id = (r.body as { id: number }).id;
    madeIds.push(id);

    await mongo().collection('message_bodies').deleteOne({ _id: id as never });

    const { body } = await req(server.url, `/api/messages?conversationId=${CONV}&limit=200`);
    const page = body as { messages: { id: number; body: string | null }[] };
    const back = page.messages.find((m) => m.id === id)!;
    assert.equal(back.body, null, 'reported as missing, not as an empty string');
  });

  it('N1: GET /api/conversations returns lastMessage and messageCount', async () => {
    const clientId = `e2e-${Date.now()}-d`;
    const r = await post('newest in conv 1', clientId);
    const id = (r.body as { id: number }).id;
    madeIds.push(id);

    const { status, body } = await req(server.url, `/api/conversations?userId=${USER}`);
    assert.equal(status, 200);
    const list = body as { id: number; messageCount: number; lastMessage: { id: number } | null }[];
    const conv1 = list.find((c) => c.id === CONV)!;
    assert.ok(conv1.messageCount >= 1);
    assert.equal(conv1.lastMessage?.id, id, 'last message is the one just posted');
  });

  it('C5: an HTML title is stored and returned verbatim as a string', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { status, body } = await req(
      server.url,
      '/api/conversations',
      jsonPost({ title: payload, participantIds: [USER, 2] }),
    );
    assert.equal(status, 201);
    const convId = (body as { id: number }).id;

    const { body: list } = await req(server.url, `/api/conversations?userId=${USER}`);
    const created = (list as { id: number; title: unknown }[]).find((c) => c.id === convId)!;
    assert.equal(typeof created.title, 'string');
    assert.equal(created.title, payload, 'server stores raw text; the client escapes on render');

    await conn.query('DELETE FROM conversations WHERE id = ?', [convId]); // cascades
  });
});
