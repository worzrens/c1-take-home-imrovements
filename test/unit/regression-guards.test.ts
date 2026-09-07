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

  it('C1/SEC-1: caller-supplied identity is gone from every route', async () => {
    for (const file of [
      'src/routes/messages.js',
      'src/routes/conversations.js',
      'src/routes/search.ts',
    ]) {
      const code = stripComments(await read(file));
      assert.ok(!/req\.query\.userId/.test(code), `${file} reads userId from the query string`);
      assert.ok(!/req\.body\.senderId/.test(code), `${file} reads senderId from the body`);
      assert.ok(
        !/const\s*\{[^}]*\bsenderId\b[^}]*\}\s*=\s*req\.body/.test(code),
        `${file} destructures senderId out of the request body`,
      );
    }
  });

  it('C1: JWT verification pins the algorithm and the secret has no fallback', async () => {
    const tokens = await read('src/auth/tokens.ts');
    assert.match(tokens, /algorithms:\s*\['HS256'\]/, 'alg:none and confusion attacks');
    assert.match(tokens, /issuer:\s*ISSUER/);
    assert.match(tokens, /audience:\s*AUDIENCE/);

    const cfg = stripComments(await read('src/config.ts'));
    assert.match(cfg, /jwtSecret:\s*process\.env\.JWT_SECRET \|\| ''/, 'no literal fallback');
  });

  it('C1: the token is an httpOnly cookie, never readable by script', async () => {
    const cookies = await read('src/auth/cookies.ts');
    assert.match(cookies, /httpOnly:\s*true/);
    assert.match(cookies, /secure:\s*true/);
    assert.match(cookies, /sameSite:\s*'lax'/);

    const client = stripComments(await read('web/app.js'));
    assert.ok(!/localStorage|sessionStorage/.test(client), 'no token in web storage');
  });

  it('C7: the WebSocket upgrade is authenticated before the handshake', async () => {
    const hub = await read('src/ws/hub.ts');
    assert.match(hub, /noServer:\s*true/, 'reject before handshake, not after');
    assert.match(hub, /verifyAccessToken/);
    assert.match(hub, /401 Unauthorized/);
    assert.match(hub, /participantConversationIds/, 'subscriptions are server-authorized');
  });

  it('multi-instance: the fan-out goes through Redis, not a local set', async () => {
    const hub = await read('src/ws/hub.ts');
    assert.match(hub, /\.publish\(CHANNEL/);
    assert.match(hub, /subscriber\(\)\.subscribe\(CHANNEL/);
  });

  it('rate limiting: the window lives in Redis, not in process memory', async () => {
    const rl = stripComments(await read('src/http/rateLimit.ts'));
    assert.match(rl, /zRemRangeByScore|zAdd/, 'sorted-set sliding window');
    assert.ok(!/new Map\(|new Set\(/.test(rl), 'no in-process counter');
    assert.match(rl, /Retry-After/);
    assert.match(rl, /429/);
  });

  it('N18/N20: no cwd-relative static path or hardcoded ws scheme in the client', async () => {
    const client = stripComments(await read('web/app.js'));
    assert.ok(!/`ws:\/\//.test(client), 'scheme is derived from location.protocol');
    assert.match(client, /location\.protocol === 'https:' \? 'wss' : 'ws'/);

    // N18 regressed once already: the fix lived in index.ts and was dropped when
    // createApp() moved to app.ts. A bare relative path only resolves when the
    // process happens to start in the repo root.
    const app = stripComments(await read('src/app.ts'));
    assert.ok(
      !/express\.static\(\s*['"`]/.test(app),
      'static root is resolved, not a bare relative path',
    );
    assert.match(app, /fileURLToPath\(import\.meta\.url\)/);
  });
});
