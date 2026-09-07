import express from 'express';
import { createMessage } from '../services/messages.ts';
import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';
import { broadcast } from '../ws/hub.ts';
import { wrap } from '../http/errors.ts';
import { isParticipant } from '../auth/authorize.ts';

export const messagesRouter = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Turns the newest-first rows from the query into one page. The query asks for
 * one row more than the caller wanted, so the surplus is what tells us an older
 * page exists. Kept separate from the query so the cursor arithmetic, which is
 * where paging bugs live, can be tested without a database.
 */
export function shapePage(newestFirst, limit) {
  const hasMore = newestFirst.length > limit;
  const rows = (hasMore ? newestFirst.slice(0, limit) : newestFirst).reverse();
  return { rows, hasMore, nextBefore: rows.length ? rows[0].id : null };
}

messagesRouter.post('/', wrap(async (req, res) => {
  // senderId used to come from the request body, so anyone could post as anyone.
  // It is the token subject now and the field is gone from the API.
  const senderId = req.userId;
  const { conversationId, body, clientId } = req.body || {};
  if (!conversationId || !body) {
    return res.status(400).json({ error: 'conversationId and body are required' });
  }
  // Required rather than optional: an idempotency key the client may omit is not
  // one you can rely on, and the retry path in the UI depends on it.
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64) {
    return res.status(400).json({ error: 'clientId must be a string of 1 to 64 characters' });
  }

  // 403 rather than 404, with nothing in the body about whether the conversation
  // exists, so this cannot be used to enumerate ids.
  if (!(await isParticipant(Number(conversationId), senderId))) {
    return res.status(403).json({ error: 'not a participant in this conversation' });
  }

  const msg = await createMessage({
    conversationId: Number(conversationId),
    senderId: Number(senderId),
    body: String(body),
    clientId,
  });

  // A retry must not fan out a second time, or every subscriber renders the
  // message twice for what the sender experienced as one send.
  if (!msg.duplicate) broadcast(msg.conversationId, { type: 'message', ...msg });

  res.status(msg.duplicate ? 200 : 201).json(msg);
}));

messagesRouter.get('/', wrap(async (req, res) => {
  const conversationId = Number(req.query.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  if (!(await isParticipant(conversationId, req.userId))) {
    return res.status(403).json({ error: 'not a participant in this conversation' });
  }

  const requested = req.query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(req.query.limit);
  if (!Number.isInteger(requested) || requested < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const limit = Math.min(requested, MAX_PAGE_SIZE);

  let before = null;
  if (req.query.before !== undefined) {
    before = Number(req.query.before);
    if (!Number.isInteger(before) || before < 1) {
      return res.status(400).json({ error: 'before must be a positive message id' });
    }
  }

  // Keyset, not OFFSET: seeking by id uses idx_messages_conversation and stays
  // constant cost however deep the history goes. It also cannot skip or repeat a
  // row when new messages arrive between one page and the next.
  const params = [conversationId];
  let sql = `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
             FROM messages WHERE conversation_id = ?`;
  if (before !== null) {
    sql += ' AND id < ?';
    params.push(before);
  }
  // Fetching one more row than asked for tells us whether an older page exists
  // without paying for a second query.
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1);

  const [newestFirst] = await pool.query(sql, params);
  const { rows, hasMore, nextBefore } = shapePage(newestFirst, limit);

  const ids = rows.map((r) => r.id);
  const bodies = ids.length
    ? await mongo().collection('message_bodies').find({ _id: { $in: ids } }).toArray()
    : [];
  const bodyById = new Map(bodies.map((b) => [b._id, b.body]));

  // A missing body means the two stores disagree. Reporting it as an empty string
  // made that look like an empty message and hid real data loss for a long time.
  const missing = rows.filter((r) => !bodyById.has(r.id)).map((r) => r.id);
  if (missing.length) {
    console.error('[data] message rows with no body in mongo:', missing.join(','));
  }

  res.json({
    messages: rows.map((r) => ({ ...r, body: bodyById.has(r.id) ? bodyById.get(r.id) : null })),
    hasMore,
    nextBefore,
  });
}));
