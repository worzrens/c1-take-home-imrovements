import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { wrap, errorHandler, installProcessHandlers } from '../../src/http/errors.ts';
import { listen, req, jsonPost, type RunningServer } from '../helpers/http.ts';

/**
 * C2 — an async route handler that rejected used to escape as an
 * unhandledRejection and take the process down, with no response sent. `wrap`
 * funnels the rejection into the terminal error middleware instead.
 */
describe('C2: async errors do not crash the process', () => {
  let server: RunningServer;
  // The handler logs every error it catches; that is the point of it. Keep the
  // expected stack traces out of the test output.
  const realErr = console.error;

  before(async () => {
    console.error = () => {};
    const app = express();
    app.use(express.json());

    app.get('/throws', wrap(async () => {
      throw new Error('boom with a filesystem path /Users/secret/app.ts inside');
    }));

    app.get('/rejects-4xx', wrap(async () => {
      const err = new Error('conversationId is required') as Error & { status: number };
      err.status = 400;
      throw err;
    }));

    app.get('/ok', wrap(async (_req, res) => {
      res.json({ ok: true });
    }));

    app.get('/double', wrap(async (_req, res) => {
      res.json({ first: true });
      throw new Error('thrown after the response already went out');
    }));

    app.use(errorHandler);
    server = await listen(app);
  });

  after(async () => {
    console.error = realErr;
    await server.close();
  });

  it('turns a thrown error into a 500 with no internals in the body', async () => {
    const { status, body, text } = await req(server.url, '/throws');
    assert.equal(status, 500);
    assert.deepEqual(body, { error: 'internal error' });
    assert.ok(!text.includes('/Users/secret'), 'no path leak');
    assert.ok(!text.toLowerCase().includes('stack'), 'no stack trace');
  });

  it('echoes a 4xx message because it describes the caller’s own mistake', async () => {
    const { status, body } = await req(server.url, '/rejects-4xx');
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'conversationId is required' });
  });

  it('returns 400 with the parser message on malformed JSON, no stack', async () => {
    const { status, body, text } = await req(server.url, '/ok', {
      ...jsonPost({}),
      body: '{ not json',
    });
    assert.equal(status, 400);
    assert.ok(!text.toLowerCase().includes('at json.parse'), 'no stack frames');
    assert.equal(typeof (body as { error: string }).error, 'string');
  });

  it('leaves a normal response untouched', async () => {
    const { status, body } = await req(server.url, '/ok');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
  });

  it('does not blow up when a handler throws after headers were sent', async () => {
    const { status, body } = await req(server.url, '/double');
    assert.equal(status, 200);
    assert.deepEqual(body, { first: true });
    // The point is the next request still succeeds — the process is alive.
    const again = await req(server.url, '/ok');
    assert.equal(again.status, 200);
  });
});

describe('C2: process-level handlers are installed', () => {
  it('registers unhandledRejection and uncaughtException listeners', () => {
    const before = {
      rej: process.listenerCount('unhandledRejection'),
      exc: process.listenerCount('uncaughtException'),
    };
    installProcessHandlers();
    assert.ok(process.listenerCount('unhandledRejection') > before.rej);
    assert.ok(process.listenerCount('uncaughtException') > before.exc);
    // Clean up the listeners this test just added so it stays idempotent.
    const rejListeners = process.listeners('unhandledRejection');
    const excListeners = process.listeners('uncaughtException');
    process.removeListener('unhandledRejection', rejListeners[rejListeners.length - 1]);
    process.removeListener('uncaughtException', excListeners[excListeners.length - 1]);
  });
});
