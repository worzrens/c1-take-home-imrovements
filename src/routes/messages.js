import express from 'express';
import { createMessage } from '../services/messages.ts';
import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';
import { broadcast } from '../ws/hub.ts';
import { wrap } from '../http/errors.ts';

export const messagesRouter = express.Router();

messagesRouter.post('/', wrap(async (req, res) => {
  const { conversationId, senderId, body, clientId } = req.body || {};
  if (!conversationId || !senderId || !body) {
    return res.status(400).json({ error: 'conversationId, senderId and body are required' });
  }

  const msg = await createMessage({
    conversationId: Number(conversationId),
    senderId: Number(senderId),
    body: String(body),
    clientId: clientId ?? null,
  });

  broadcast(msg.conversationId, { type: 'message', ...msg });
  res.status(201).json(msg);
}));

messagesRouter.get('/', wrap(async (req, res) => {
  const conversationId = Number(req.query.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  const [rows] = await pool.query(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
     FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
    [conversationId],
  );

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

  res.json(rows.map((r) => ({ ...r, body: bodyById.has(r.id) ? bodyById.get(r.id) : null })));
}));
