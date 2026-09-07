import { pool } from '../db/mysql.ts';
import { mongo } from '../db/mongo.ts';

export interface NewMessage {
  conversationId: number;
  senderId: number;
  body: string;
  /** Caller-supplied idempotency key. Required, so a retry is always safe. */
  clientId: string;
}

/**
 * Looks up the message a duplicate key collided with, so a retry gets back the
 * message it already created rather than an error.
 */
async function findByClientId(conversationId: number, clientId: string) {
  const [rows] = await pool.query(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId, created_at AS createdAt
     FROM messages WHERE conversation_id = ? AND client_id = ?`,
    [conversationId, clientId],
  );
  const row = (rows as { id: number }[])[0];
  if (!row) return null;

  const doc = await mongo().collection('message_bodies').findOne({ _id: row.id as never });
  return { ...row, body: (doc?.body as string | undefined) ?? null };
}

export async function createMessage(input: NewMessage) {
  const { conversationId, senderId, body, clientId } = input;

  let id: number;
  try {
    const [res] = await pool.execute(
      'INSERT INTO messages (conversation_id, sender_id, client_id) VALUES (?, ?, ?)',
      [conversationId, senderId, clientId],
    );
    id = (res as { insertId: number }).insertId;
  } catch (err) {
    // The unique index on (conversation_id, client_id) added in C9 is what makes
    // this reachable. Letting the database detect the collision avoids the
    // check-then-insert race that a SELECT first would introduce.
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const existing = await findByClientId(conversationId, clientId);
      if (existing) return { ...existing, duplicate: true };
    }
    throw err;
  }

  // Read the timestamp back rather than generating one in Node. The row already
  // has a value from the column default, and a second clock produces a different
  // answer: the one broadcast over the WebSocket disagreed with the one returned
  // on reload, by clock skew and always by up to a second while the column was a
  // TIMESTAMP.
  const [stored] = await pool.query('SELECT created_at AS createdAt FROM messages WHERE id = ?', [id]);
  const createdAt = (stored as { createdAt: Date }[])[0].createdAt;

  // Two stores, no transaction spanning them. The MySQL row is already committed
  // by this point, so a failure here used to leave a message that exists but has
  // no body, permanently and silently.
  //
  // This is compensation, not atomicity: the delete can itself fail, and a crash
  // between the two leaves the same orphan. It converts the common case from
  // silent corruption into a clean error, which is the most this shape allows.
  // Real atomicity needs a transactional outbox or one datastore. See the
  // datastore-split decision in the fix plan.
  try {
    await mongo().collection('message_bodies').insertOne({
      _id: id as never,
      conversationId,
      senderId,
      body,
      createdAt,
    });
  } catch (err) {
    try {
      await pool.execute('DELETE FROM messages WHERE id = ?', [id]);
    } catch (cleanupErr) {
      // Losing the compensation is worse than the original failure, because the
      // orphan is now invisible. Log loudly; `npm run reconcile` finds these.
      console.error('[data] orphaned message row', id, cleanupErr);
    }
    throw err;
  }

  return { id, conversationId, senderId, body, createdAt, duplicate: false };
}
