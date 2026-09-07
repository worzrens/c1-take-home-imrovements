import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.ts';

const client = new MongoClient(config.mongoUrl);
let db: Db | undefined;

export async function connectMongo(retries = 20): Promise<Db> {
  for (let i = 0; i < retries; i++) {
    try {
      await client.connect();
      db = client.db();
      return db;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('mongo not reachable');
}

/**
 * Mongo has no migration story here the way MySQL does, so indexes are declared
 * in code and created at boot. createIndex is idempotent, so this is safe to run
 * on every start and on every instance.
 *
 * The text index is what makes search possible at all; conversationId is what
 * keeps the search filter and the body lookups from collection-scanning.
 */
export async function ensureMongoIndexes(): Promise<void> {
  const bodies = mongo().collection('message_bodies');
  await bodies.createIndex({ body: 'text' }, { name: 'txt_message_bodies_body' });
  await bodies.createIndex({ conversationId: 1, _id: -1 }, { name: 'idx_bodies_conversation' });
}

export function mongo(): Db {
  if (!db) throw new Error('mongo not connected');
  return db;
}
