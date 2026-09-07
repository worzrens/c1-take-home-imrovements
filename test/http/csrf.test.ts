import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { listen, req, type RunningServer } from '../helpers/http.ts';

/**
 * CSRF was structurally impossible before C1, because there was no ambient
 * credential for a forged request to ride on. An httpOnly cookie is exactly that
 * credential, so the defence is now deliberate: SameSite=Lax first, this Origin
 * check second, and express.json() as the only body parser third.
 */
describe('C1: CSRF controls', () => {
  let server: RunningServer;
  before(async () => {
    server = await listen(createApp());
  });
  after(() => server.close());

  it('rejects a state-changing request from another origin', async () => {
    const { status, body } = await req(server.url, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    });
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'cross-origin request rejected' });
  });

  it('allows a same-origin state-changing request through to the route', async () => {
    const { status } = await req(server.url, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: server.url },
      body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    });
    assert.notEqual(status, 403);
  });

  it('does not block GET, which carries no state change', async () => {
    const { status } = await req(server.url, '/api/conversations', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(status, 401, 'blocked by auth, not by the origin check');
  });

  it('urlencoded bodies are not parsed, so a cross-origin form cannot post JSON', async () => {
    const { status } = await req(server.url, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=a@b.c&password=x',
    });
    // Body never populates, so the route sees no fields.
    assert.equal(status, 400);
  });
});
