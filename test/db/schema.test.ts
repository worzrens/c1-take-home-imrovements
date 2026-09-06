import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection } from 'mysql2/promise';
import { mysqlReachable, mysqlConn, SKIP_DB } from '../helpers/db.ts';

/**
 * C9 — the messages table had no index on conversation_id, no unique key for
 * idempotency and no foreign keys at all. Migration 0002 adds them.
 * N6 — created_at was second-granularity TIMESTAMP; migration 0003 makes it
 * DATETIME(3).
 *
 * These assert the live schema after migrations have run, so they need MySQL.
 */
const up = await mysqlReachable();

describe('C9 + N6: live schema after migrations', { skip: up ? false : SKIP_DB }, () => {
  let conn: Connection;
  before(async () => {
    conn = await mysqlConn();
  });
  after(async () => {
    await conn.end();
  });

  const indexColumns = async (table: string, index: string) => {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, NON_UNIQUE AS nonUnique
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
       ORDER BY SEQ_IN_INDEX`,
      [table, index],
    );
    return rows as { col: string; seq: number; nonUnique: number }[];
  };

  it('C9: idx_messages_conversation covers (conversation_id, id)', async () => {
    const cols = await indexColumns('messages', 'idx_messages_conversation');
    assert.deepEqual(cols.map((c) => c.col), ['conversation_id', 'id']);
  });

  it('C9: idx_participants_user exists on conversation_participants(user_id)', async () => {
    const cols = await indexColumns('conversation_participants', 'idx_participants_user');
    assert.deepEqual(cols.map((c) => c.col), ['user_id']);
  });

  it('C9: uq_messages_client is a UNIQUE index on (conversation_id, client_id)', async () => {
    const cols = await indexColumns('messages', 'uq_messages_client');
    assert.deepEqual(cols.map((c) => c.col), ['conversation_id', 'client_id']);
    assert.equal(cols[0].nonUnique, 0, 'must be unique');
  });

  it('C9: uq_users_email is a UNIQUE index on users(email)', async () => {
    const cols = await indexColumns('users', 'uq_users_email');
    assert.deepEqual(cols.map((c) => c.col), ['email']);
    assert.equal(cols[0].nonUnique, 0);
  });

  it('C9: the four foreign keys exist with the right parents', async () => {
    const [rows] = await conn.query(
      `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS child, COLUMN_NAME AS col,
              REFERENCED_TABLE_NAME AS parent, REFERENCED_COLUMN_NAME AS parentCol
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    const byName = new Map(
      (rows as { name: string }[]).map((r) => [r.name, r as Record<string, string>]),
    );
    assert.deepEqual(
      [byName.get('fk_messages_conversation')?.parent, byName.get('fk_messages_conversation')?.child],
      ['conversations', 'messages'],
    );
    assert.deepEqual(
      [byName.get('fk_messages_sender')?.parent, byName.get('fk_messages_sender')?.col],
      ['users', 'sender_id'],
    );
    assert.ok(byName.has('fk_participants_conversation'));
    assert.ok(byName.has('fk_participants_user'));
  });

  it('C9: the FK actually rejects a message in a non-existent conversation', async () => {
    await assert.rejects(
      conn.execute('INSERT INTO messages (conversation_id, sender_id) VALUES (?, ?)', [
        2_000_000_000, 1,
      ]),
      /foreign key constraint fails/i,
    );
  });

  it('N6: messages.created_at and conversations.created_at are DATETIME(3)', async () => {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS t, DATA_TYPE AS type, DATETIME_PRECISION AS prec
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'created_at'
         AND TABLE_NAME IN ('messages', 'conversations')`,
    );
    for (const r of rows as { t: string; type: string; prec: number }[]) {
      assert.equal(r.type, 'datetime', `${r.t}.created_at data type`);
      assert.equal(Number(r.prec), 3, `${r.t}.created_at precision`);
    }
    assert.equal((rows as unknown[]).length, 2);
  });

  it('PRE-1: every migration is recorded in _migrations', async () => {
    const [rows] = await conn.query('SELECT name FROM _migrations ORDER BY name');
    const names = (rows as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, [
      '0001_initial',
      '0002_indexes_and_keys',
      '0003_millisecond_timestamps',
    ]);
  });
});
