import express from 'express';
import { pool } from '../db/mysql.ts';
import { wrap } from '../http/errors.ts';

export const conversationsRouter = express.Router();

conversationsRouter.get('/', wrap(async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const [conversations] = await pool.query(
    `SELECT c.id, c.title
     FROM conversations c
     JOIN conversation_participants p ON p.conversation_id = c.id
     WHERE p.user_id = ?
     ORDER BY c.id ASC`,
    [userId],
  );

  const result = [];
  for (const c of conversations) {
    const [[last]] = await pool.query(
      `SELECT id, sender_id AS senderId, created_at AS createdAt
       FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`,
      [c.id],
    );
    const [[counted]] = await pool.query(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
      [c.id],
    );
    result.push({ ...c, lastMessage: last || null, messageCount: counted.count });
  }

  res.json(result);
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

  const [created] = await pool.execute('INSERT INTO conversations (title) VALUES (?)', [title]);
  const id = created.insertId;
  for (const uid of participantIds) {
    await pool.execute(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)',
      [id, Number(uid)],
    );
  }

  res.status(201).json({ id, title, participantIds: participantIds.map(Number) });
}));
