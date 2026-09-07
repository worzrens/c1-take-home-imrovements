import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { listen, req, jsonPost, type RunningServer } from '../helpers/http.ts';

/**
 * C1/SEC-1 — every endpoint used to be open, with identity taken from
 * `?userId=` and `senderId` in the body. These assertions need no database: with
 * no cookie present `authenticate` rejects before anything is queried, which is
 * also why an unauthenticated flood cannot reach the datastores.
 */
describe('C1: the API is closed by default', () => {
  let server: RunningServer;
  before(async () => {
    server = await listen(createApp());
  });
  after(() => server.close());

  const protectedRoutes: [string, string, unknown?][] = [
    ['GET', '/api/conversations'],
    ['POST', '/api/conversations', { title: 'x', participantIds: [2] }],
    ['GET', '/api/messages?conversationId=1'],
    ['POST', '/api/messages', { conversationId: 1, body: 'hi', clientId: 'a' }],
    ['GET', '/api/search?q=hello'],
    ['GET', '/api/auth/me'],
  ];

  for (const [method, path, payload] of protectedRoutes) {
    it(`401 without a token: ${method} ${path}`, async () => {
      const init = payload ? jsonPost(payload) : undefined;
      const { status, body } = await req(server.url, path, init);
      assert.equal(status, 401, `${method} ${path}`);
      assert.deepEqual(body, { error: 'authentication required' });
    });
  }

  it('401 when the cookie holds a token this server did not sign', async () => {
    const { status } = await req(server.url, '/api/conversations', {
      headers: { cookie: 'access_token=not.a.real.token' },
    });
    assert.equal(status, 401);
  });

  it('login and refresh stay reachable without a token', async () => {
    // Wrong credentials, but the route must be reachable — a 401 from the
    // credential check, not from the middleware.
    const login = await req(server.url, '/api/auth/login', jsonPost({ email: 'x', password: 'y' }));
    assert.notEqual(login.status, 404);
    const refresh = await req(server.url, '/api/auth/refresh', { method: 'POST' });
    assert.equal(refresh.status, 401);
  });

  it('the static frontend is still public', async () => {
    const { status } = await req(server.url, '/');
    assert.equal(status, 200);
  });
});
