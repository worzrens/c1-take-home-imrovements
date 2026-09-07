import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/mysql.ts';

/**
 * Membership is the only authorization rule in the app: you can read and write a
 * conversation if you are a participant in it.
 *
 * Callers turn a false into a 403 with a body that says nothing about whether
 * the conversation exists — otherwise the error itself enumerates conversation
 * ids for anyone who wants to walk them.
 */
export async function isParticipant(conversationId: number, userId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1',
    [conversationId, userId],
  );
  return rows.length > 0;
}

/** Every conversation id the user belongs to. Used to scope search results. */
export async function participantConversationIds(userId: number): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT conversation_id AS id FROM conversation_participants WHERE user_id = ?',
    [userId],
  );
  return (rows as { id: number }[]).map((r) => r.id);
}
