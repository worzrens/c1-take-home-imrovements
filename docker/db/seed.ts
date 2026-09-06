import { pool, waitForMysql } from '../../src/db/mysql.ts';
import { connectMongo, mongo } from '../../src/db/mongo.ts';

// The demo rows used to sit in docker/db/mysql.sql, which the MySQL image runs
// only when the data directory is empty. That made them unrepeatable, and it
// meant the schema and the sample data shared one file. Schema now lives in
// migrations/; sample data lives here.
//
// INSERT IGNORE keeps a rerun a no-op, so this is safe on an existing database.
await waitForMysql();

await pool.query(
  `INSERT IGNORE INTO users (id, name, email) VALUES
     (1, 'Alice', 'alice@example.com'),
     (2, 'Bob', 'bob@example.com'),
     (3, 'Carol', 'carol@example.com')`,
);

await pool.query(
  `INSERT IGNORE INTO conversations (id, title) VALUES
     (1, 'Support — order #1042'),
     (2, 'Design sync')`,
);

await pool.query(
  `INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES
     (1, 1), (1, 2), (2, 1), (2, 3)`,
);

await pool.query(
  `INSERT IGNORE INTO messages (id, conversation_id, sender_id, client_id) VALUES
     (1, 1, 2, NULL),
     (2, 1, 1, NULL),
     (3, 2, 3, NULL)`,
);

await connectMongo();
const bodies = mongo().collection('message_bodies');

// TODO(C6): this wipe destroys the body of every message sent since the last
// boot while MySQL keeps the rows, so old messages render blank. Left as-is
// here to keep this commit to one change; fixed in the C6 step.
await bodies.deleteMany({});
await bodies.insertMany([
  { _id: 1 as never, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?', createdAt: new Date() },
  { _id: 2 as never, conversationId: 1, senderId: 1, body: 'Checking now — give me a minute.', createdAt: new Date() },
  { _id: 3 as never, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.', createdAt: new Date() },
]);

console.log('seeded demo users, conversations and messages');
process.exit(0);
