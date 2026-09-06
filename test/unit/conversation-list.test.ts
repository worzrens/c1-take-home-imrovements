import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationList } from '../../src/routes/conversations.js';

/**
 * N1 — the sidebar N+1. The route used to run two queries per conversation in a
 * loop. Now it runs three queries total and `buildConversationList` stitches the
 * result sets together. This is that pure assembly step.
 */
describe('N1: buildConversationList', () => {
  it('joins stats and last-message rows onto each conversation', () => {
    const conversations = [
      { id: 1, title: 'Support' },
      { id: 2, title: 'Design sync' },
    ];
    const stats = [
      { conversationId: 1, messageCount: 12, lastId: 100 },
      { conversationId: 2, messageCount: 3, lastId: 55 },
    ];
    const lastMessages = [
      { id: 100, senderId: 7, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 55, senderId: 2, createdAt: '2026-01-02T00:00:00.000Z' },
    ];

    const out = buildConversationList(conversations, stats, lastMessages);

    assert.deepEqual(out[0], {
      id: 1,
      title: 'Support',
      messageCount: 12,
      lastMessage: { id: 100, senderId: 7, createdAt: '2026-01-01T00:00:00.000Z' },
    });
    assert.equal(out[1].messageCount, 3);
    assert.equal(out[1].lastMessage.id, 55);
  });

  it('is defensive when a conversation has no messages at all', () => {
    const out = buildConversationList([{ id: 9, title: 'Empty' }], [], []);
    assert.deepEqual(out, [{ id: 9, title: 'Empty', messageCount: 0, lastMessage: null }]);
  });

  it('is defensive when the stats row points at a last message that is missing', () => {
    const out = buildConversationList(
      [{ id: 1, title: 'Support' }],
      [{ conversationId: 1, messageCount: 5, lastId: 100 }],
      [], // lookup by id 100 misses
    );
    assert.equal(out[0].messageCount, 5, 'count still comes through');
    assert.equal(out[0].lastMessage, null, 'no last message rather than a crash');
  });

  it('preserves conversation order and passes through extra columns', () => {
    const conversations = [
      { id: 3, title: 'C', extra: 'keep-me' },
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ];
    const out = buildConversationList(conversations, [], []);
    assert.deepEqual(out.map((c: { id: number }) => c.id), [3, 1, 2]);
    assert.equal(out[0].extra, 'keep-me');
  });
});
