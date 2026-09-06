import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Static guards for improvements whose regression would be a change to a
 * specific file rather than observable behaviour in a unit test. Each one fails
 * loudly if the fix is reverted.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFile(path.join(root, p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const exists = (p: string) =>
  access(path.join(root, p)).then(
    () => true,
    () => false,
  );

describe('regression guards (static)', () => {
  it('C4: the fake pbkdf2 "signature" is gone from the message service', async () => {
    const src = await read('src/services/messages.ts');
    assert.ok(!/pbkdf2|createHmac|\bsignature\b/i.test(src), 'no signature/HMAC code');
  });

  it('C5: the sidebar renders the conversation title as text, never innerHTML', async () => {
    const app = await read('web/app.js');
    assert.match(app, /label\.textContent\s*=/, 'title goes through textContent');
    // The only innerHTML writes in the file are clearing to an empty string.
    const innerHtmlWrites = [...app.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const rhs of innerHtmlWrites) {
      assert.ok(rhs === "''" || rhs === '""', `innerHTML assigned non-empty value: ${rhs}`);
    }
  });

  it('PRE-1: schema lives in migrations, not a mounted init script', async () => {
    assert.equal(await exists('docker/db/mysql.sql'), false, 'docker/db/mysql.sql removed');
    assert.ok(await exists('migrations/0001_initial.up.sql'));
    const compose = await read('docker-compose.yml');
    assert.ok(!/docker-entrypoint-initdb\.d/.test(compose), 'no initdb.d mount');
    assert.match(compose, /npm run migrate/, 'a one-shot migrate service exists');
  });

  it('N4: NODE_ENV=production and tsx is a real dependency', async () => {
    const compose = await read('docker-compose.yml');
    assert.match(compose, /NODE_ENV:\s*production/);
    const pkg = JSON.parse(await read('package.json'));
    assert.ok(pkg.dependencies.tsx, 'tsx in dependencies, not devDependencies');
    assert.ok(!pkg.devDependencies?.tsx);
  });

  it('N6: created_at is DATETIME(3), not TIMESTAMP', async () => {
    const up = await read('migrations/0003_millisecond_timestamps.up.sql');
    assert.match(up, /messages\s+MODIFY created_at DATETIME\(3\)/i);
    assert.match(up, /conversations\s+MODIFY created_at DATETIME\(3\)/i);
  });

  it('C6: the seed upserts message bodies instead of wiping them', async () => {
    const seed = await read('docker/db/seed.ts');
    // Strip comments — the fix note deliberately mentions the old `deleteMany`.
    const code = stripComments(seed);
    assert.ok(!/\.deleteMany\s*\(|\.insertMany\s*\(/.test(code), 'no destructive reseed call');
    assert.match(code, /\$setOnInsert/);
    assert.match(code, /upsert:\s*true/);
    assert.match(code, /INSERT IGNORE/);
  });

  it('C9: migration 0002 adds the indexes, unique keys and foreign keys', async () => {
    const up = await read('migrations/0002_indexes_and_keys.up.sql');
    for (const needle of [
      'idx_messages_conversation',
      'idx_participants_user',
      'uq_messages_client',
      'uq_users_email',
      'fk_messages_conversation',
      'fk_messages_sender',
      'fk_participants_conversation',
      'fk_participants_user',
    ]) {
      assert.match(up, new RegExp(needle), needle);
    }
  });

  it('C8: the dual write compensates by deleting the orphaned row', async () => {
    const svc = await read('src/services/messages.ts');
    assert.match(svc, /DELETE FROM messages WHERE id = \?/);
    assert.match(svc, /orphaned message row/);
  });
});
