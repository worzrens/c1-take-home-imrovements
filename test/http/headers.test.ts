import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { listen, req, type RunningServer } from '../helpers/http.ts';

/**
 * N4 — stop advertising the framework (`x-powered-by`).
 * N15 — Helmet with an explicit, strict Content-Security-Policy.
 */
describe('N4 + N15: security headers', () => {
  let server: RunningServer;
  before(async () => {
    server = await listen(createApp());
  });
  after(() => server.close());

  it('N4: no x-powered-by header on any response', async () => {
    const paths = ['/', '/api/search', '/api/messages'];
    for (const p of paths) {
      const { headers } = await req(server.url, p);
      assert.equal(headers.get('x-powered-by'), null, p);
    }
  });

  it('N15: sends a Content-Security-Policy', async () => {
    const { headers } = await req(server.url, '/');
    const csp = headers.get('content-security-policy');
    assert.ok(csp, 'CSP header present');
  });

  it('N15: CSP is strict — self-only, no unsafe-inline, locked-down fallbacks', async () => {
    const { headers } = await req(server.url, '/');
    const csp = headers.get('content-security-policy') ?? '';

    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/, 'same-origin WebSocket must be allowed');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes("'unsafe-inline'"), 'no unsafe-inline');
    assert.ok(!csp.includes("'unsafe-eval'"), 'no unsafe-eval');
  });

  it('N15: other Helmet defaults are in place', async () => {
    const { headers } = await req(server.url, '/');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  it('still serves the static frontend', async () => {
    const { status, text } = await req(server.url, '/');
    assert.equal(status, 200);
    assert.match(text, /<title>|<script/i);
  });
});
