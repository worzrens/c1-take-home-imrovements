import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.ts';
import { listen, req, jsonPost, type RunningServer } from '../helpers/http.ts';

/**
 * Request validation that returns before any database call, so it runs with no
 * MySQL or Mongo. Covers the input contract added by N2 (pagination params),
 * N5 (clientId is mandatory) and C2 (the over-long title that used to crash the
 * process now being a clean 400).
 */
describe('HTTP contract: validation without a database', () => {
  let server: RunningServer;
  before(async () => {
    server = await listen(createApp());
  });
  after(() => server.close());

  describe('POST /api/messages', () => {
    it('400 when body fields are missing', async () => {
      const { status, body } = await req(server.url, '/api/messages', jsonPost({}));
      assert.equal(status, 400);
      assert.match((body as { error: string }).error, /conversationId, senderId and body are required/);
    });

    it('N5: 400 when clientId is absent', async () => {
      const { status, body } = await req(
        server.url,
        '/api/messages',
        jsonPost({ conversationId: 1, senderId: 1, body: 'hi' }),
      );
      assert.equal(status, 400);
      assert.match((body as { error: string }).error, /clientId must be a string of 1 to 64 characters/);
    });

    it('N5: 400 when clientId is empty', async () => {
      const { status } = await req(
        server.url,
        '/api/messages',
        jsonPost({ conversationId: 1, senderId: 1, body: 'hi', clientId: '' }),
      );
      assert.equal(status, 400);
    });

    it('N5: 400 when clientId is longer than 64 characters', async () => {
      const { status } = await req(
        server.url,
        '/api/messages',
        jsonPost({ conversationId: 1, senderId: 1, body: 'hi', clientId: 'x'.repeat(65) }),
      );
      assert.equal(status, 400);
    });
  });

  describe('GET /api/messages', () => {
    it('400 without conversationId', async () => {
      const { status } = await req(server.url, '/api/messages');
      assert.equal(status, 400);
    });
    it('N2: 400 when limit is not a positive integer', async () => {
      for (const q of ['limit=0', 'limit=-3', 'limit=abc', 'limit=1.5']) {
        const { status } = await req(server.url, `/api/messages?conversationId=1&${q}`);
        assert.equal(status, 400, q);
      }
    });
    it('N2: 400 when before is not a positive id', async () => {
      for (const q of ['before=0', 'before=-1', 'before=abc']) {
        const { status } = await req(server.url, `/api/messages?conversationId=1&${q}`);
        assert.equal(status, 400, q);
      }
    });
  });

  describe('POST /api/conversations', () => {
    it('400 when title or participantIds missing', async () => {
      const { status } = await req(server.url, '/api/conversations', jsonPost({ title: 'x' }));
      assert.equal(status, 400);
    });

    it('C2: 400 (not a crash) when the title exceeds the 200-char column', async () => {
      const { status, body } = await req(
        server.url,
        '/api/conversations',
        jsonPost({ title: 'a'.repeat(201), participantIds: [1] }),
      );
      assert.equal(status, 400);
      assert.match((body as { error: string }).error, /at most 200 characters/);
      // Server is still up.
      const health = await req(server.url, '/api/messages');
      assert.equal(health.status, 400);
    });
  });

  describe('GET /api/conversations', () => {
    it('400 without userId', async () => {
      const { status } = await req(server.url, '/api/conversations');
      assert.equal(status, 400);
    });
  });

  describe('GET /api/search (stub, no database)', () => {
    it('returns [] for an empty query', async () => {
      const { status, body } = await req(server.url, '/api/search');
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });
    it('returns [] for a real query — search is not implemented yet', async () => {
      const { status, body } = await req(server.url, '/api/search?q=hello');
      assert.equal(status, 200);
      assert.deepEqual(body, []);
    });
  });
});
