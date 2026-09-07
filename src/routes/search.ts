import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';
import { wrap } from '../http/errors.ts';
import { participantConversationIds } from '../auth/authorize.ts';

export const searchRouter = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface TitleRow extends RowDataPacket {
  id: number;
  title: string;
}

/**
 * Full-text search over message bodies, scoped to the caller's conversations.
 *
 * Two things matter more than the ranking here.
 *
 * First, `q` is forced through String() before it goes anywhere near the query.
 * This is the only route that puts user input into a Mongo query, and Express
 * hands back an object for `?q[$ne]=`, an array for a repeated `?q=`. Either
 * would reach an operator position and turn the search box into $where.
 *
 * Second, results are restricted to conversations the caller is a participant
 * in. Without that, search is a way to read every message in the system — worse
 * than the IDOR it would be sitting next to, because it needs no ids guessed.
 */
searchRouter.get('/', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);
  if (q.length > 200) return res.status(400).json({ error: 'q must be 200 characters or fewer' });

  const requested = req.query.limit === undefined ? DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(requested) || requested < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  const limit = Math.min(requested, MAX_LIMIT);

  const allowed = await participantConversationIds(req.userId!);
  if (allowed.length === 0) return res.json([]);

  const hits = await mongo()
    .collection('message_bodies')
    .find(
      { conversationId: { $in: allowed }, $text: { $search: q } },
      { projection: { body: 1, conversationId: 1, score: { $meta: 'textScore' } } },
    )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .toArray();

  if (hits.length === 0) return res.json([]);

  // Titles live in MySQL. One lookup for the distinct conversations in the page
  // rather than one per hit.
  const ids = [...new Set(hits.map((h) => h.conversationId as number))];
  const [titles] = await pool.query<TitleRow[]>(
    'SELECT id, title FROM conversations WHERE id IN (?)',
    [ids],
  );
  const titleById = new Map(titles.map((t) => [t.id, t.title]));

  res.json(
    hits.map((h) => ({
      messageId: h._id as unknown as number,
      conversationId: h.conversationId as number,
      conversationTitle: titleById.get(h.conversationId as number) ?? null,
      body: h.body as string,
    })),
  );
}));
