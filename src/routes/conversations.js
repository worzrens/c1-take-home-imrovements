import express from 'express';
import { pool } from '../db/mysql.ts';
import { wrap } from '../http/errors.ts';

export const conversationsRouter = express.Router();

/**
 * Pure assembly step, kept separate from the queries so it can be tested without
 * a database. Takes the three result sets and produces the response body.
 */
export function buildConversationList(conversations, stats, lastMessages) {
  const lastById = new Map(lastMessages.map((m) => [m.id, m]));
  const statsByConversation = new Map(stats.map((s) => [s.conversationId, s]));

  return conversations.map((c) => {
    const s = statsByConversation.get(c.id);
    const last = s ? lastById.get(s.lastId) : undefined;
    return {
      ...c,
      lastMessage: last
        ? { id: last.id, senderId: last.senderId, createdAt: last.createdAt }
        : null,
      messageCount: s ? s.messageCount : 0,
    };
  });
}

conversationsRouter.get('/', wrap(async (req, res) => {
  // Identity is the token's subject. `?userId=` used to be the whole auth story
  // and is gone from the surface rather than deprecated, so there is no fallback
  // left to exploit.
  const userId = req.userId;

  const [conversations] = await pool.query(
    `SELECT c.id, c.title
     FROM conversations c
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ?
     ORDER BY c.id ASC`,
    [userId],
  );

  if (conversations.length === 0) return res.json([]);

  // This used to be two queries per conversation inside a loop, so a user in 50
  // conversations meant 101 sequential round trips for one page load. Count and
  // last-message id now come from one grouped pass, and the last messages
  // themselves from one lookup by primary key. Three queries, whatever the count.
  const ids = conversations.map((c) => c.id);
  const [stats] = await pool.query(
    `SELECT conversation_id AS conversationId, COUNT(*) AS messageCount, MAX(id) AS lastId
     FROM messages
     WHERE conversation_id IN (?)
     GROUP BY conversation_id`,
    [ids],
  );

  const lastIds = stats.map((s) => s.lastId);
  const [lastMessages] = lastIds.length
    ? await pool.query(
        `SELECT id, sender_id AS senderId, created_at AS createdAt
         FROM messages
         WHERE id IN (?)`,
        [lastIds],
      )
    : [[]];

  res.json(buildConversationList(conversations, stats, lastMessages));
}));

conversationsRouter.post('/', wrap(async (req, res) => {
  const { title, participantIds } = req.body || {};
  if (!title || !Array.isArray(participantIds) || participantIds.length === 0) {
    return res.status(400).json({ error: 'title and a non-empty participantIds[] are required' });
  }
  // Bounded to the column width. Unbounded, this raised a MySQL error that before
  // C2 killed the process, and it is the field that carried the stored XSS.
  if (typeof title !== 'string' || title.length > 200) {
    return res.status(400).json({ error: 'title must be a string of at most 200 characters' });
  }

  // The creator is always a participant, whatever the client sent. Otherwise it
  // is possible to create a conversation you cannot then read.
  const participants = [...new Set([req.userId, ...participantIds.map(Number)])];

  // One transaction: a conversation with no participants is unreachable for
  // everyone, and that is exactly what a failure halfway through the loop used
  // to leave behind.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [created] = await conn.execute('INSERT INTO conversations (title) VALUES (?)', [title]);
    const id = created.insertId;
    for (const uid of participants) {
      await conn.execute(
        'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)',
        [id, uid],
      );
    }
    await conn.commit();
    res.status(201).json({ id, title, participantIds: participants });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));
