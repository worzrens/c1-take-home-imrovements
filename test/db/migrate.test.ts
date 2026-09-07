import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'mysql2/promise';
import { bothReachable, mysqlConn, MYSQL_URL, MONGO_URL, SKIP_DB } from '../helpers/db.ts';

/**
 * PRE-1 — schema moved from a mount-once init script to Umzug migrations. The
 * property that matters operationally: running `migrate` again is a no-op, so it
 * is safe to run on every deploy.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = promisify(execFile);
const up = await bothReachable();

describe('PRE-1: migrations are idempotent', { skip: up ? false : SKIP_DB }, () => {
  let conn: Connection;
  before(async () => {
    conn = await mysqlConn();
  });
  after(async () => {
    await conn.end();
  });

  it('a second `migrate` run applies nothing and changes no _migrations rows', async () => {
    const [beforeRows] = await conn.query('SELECT name FROM _migrations ORDER BY name');

    const { stdout } = await run('node', ['--import', 'tsx', 'src/db/migrate.ts'], {
      cwd: root,
      env: { ...process.env, MYSQL_URL, MONGO_URL },
    });

    // Umzug logs an `event: 'migrating'` line for each migration it runs.
    assert.ok(!/event: 'migrating'/.test(stdout), 'nothing was migrated on the rerun');

    const [afterRows] = await conn.query('SELECT name FROM _migrations ORDER BY name');
    assert.deepEqual(afterRows, beforeRows);
  });
});
