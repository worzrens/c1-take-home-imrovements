import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { allReachable, SKIP_REDIS } from '../helpers/db.ts';
import { appServer, Session, ALICE, DEMO_PASSWORD } from '../helpers/auth.ts';

/** C1 — login, session, rotation and revocation against the real stack. */
const up = await allReachable();

describe('C1: authentication', { skip: up ? false : SKIP_REDIS }, () => {
  let app: Awaited<ReturnType<typeof appServer>>;
  let redisMod: typeof import('../../src/db/redis.ts');

  before(async () => {
    redisMod = await import('../../src/db/redis.ts');
    await redisMod.connectRedis();
    app = await appServer();
  });

  after(async () => {
    await app.close();
    await redisMod.closeRedis();
  });

  it('logs in with the seeded credentials and returns the user', async () => {
    const s = app.session();
    const user = await s.login(ALICE);
    assert.equal(user.email, ALICE);
    assert.ok(user.id > 0);
    assert.ok(s.cookieHeader.includes('access_token='), 'access cookie set');
    assert.ok(s.cookieHeader.includes('refresh_token='), 'refresh cookie set');
  });

  it('the cookies are httpOnly, Secure and SameSite=Lax', async () => {
    const s = new Session(app.server.url);
    const res = await s.post('/api/auth/login', { email: ALICE, password: DEMO_PASSWORD });
    const set = res.headers.getSetCookie();
    const access = set.find((c) => c.startsWith('access_token='))!;
    const refresh = set.find((c) => c.startsWith('refresh_token='))!;

    for (const cookie of [access, refresh]) {
      assert.match(cookie, /HttpOnly/i, 'script must not be able to read the token');
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /SameSite=Lax/i);
    }
    assert.match(refresh, /Path=\/api\/auth\/refresh/, 'refresh is scoped to one endpoint');
  });

  it('rejects a wrong password and an unknown email identically', async () => {
    const s = app.session();
    const wrong = await s.post('/api/auth/login', { email: ALICE, password: 'nope' });
    const unknown = await s.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: DEMO_PASSWORD,
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    // Identical, or the login form becomes an account enumerator.
    assert.deepEqual(wrong.body, unknown.body);
  });

  it('/api/auth/me reflects the logged-in user', async () => {
    const s = app.session();
    const user = await s.login(ALICE);
    const { status, body } = await s.fetch('/api/auth/me');
    assert.equal(status, 200);
    assert.equal((body as { id: number }).id, user.id);
  });

  it('logout revokes the access token immediately, before it expires', async () => {
    const s = app.session();
    await s.login(ALICE);
    assert.equal((await s.fetch('/api/auth/me')).status, 200);

    // Keep the token that logout is about to revoke, to prove the deny list is
    // what stops it rather than the cookie simply being cleared.
    const stolen = s.cookieHeader;
    assert.equal((await s.fetch('/api/auth/logout', { method: 'POST' })).status, 204);

    const replay = await fetch(`${app.server.url}/api/auth/me`, { headers: { cookie: stolen } });
    assert.equal(replay.status, 401, 'a still-unexpired token is refused after logout');
  });

  it('refresh rotates the pair and the old refresh token is single-use', async () => {
    const s = app.session();
    await s.login(ALICE);
    const firstRefresh = s.cookieHeader.match(/refresh_token=([^;]+)/)![1];

    const rotated = await s.fetch('/api/auth/refresh', { method: 'POST' });
    assert.equal(rotated.status, 200);
    const secondRefresh = s.cookieHeader.match(/refresh_token=([^;]+)/)![1];
    assert.notEqual(secondRefresh, firstRefresh, 'a new refresh token was issued');

    // Replaying the consumed one gets nothing.
    const replay = await fetch(`${app.server.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `refresh_token=${firstRefresh}`, origin: app.server.url },
    });
    assert.equal(replay.status, 401);
  });

  it('the session still works after a refresh', async () => {
    const s = app.session();
    await s.login(ALICE);
    await s.fetch('/api/auth/refresh', { method: 'POST' });
    assert.equal((await s.fetch('/api/auth/me')).status, 200);
  });
});
