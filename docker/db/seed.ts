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

// This used to be deleteMany({}) followed by insertMany. Because the MySQL side
// was seeded only on an empty data directory, a restart left the message rows in
// place while their bodies were destroyed, and every older message rendered
// blank for good. Upsert with $setOnInsert instead: a rerun touches nothing, and
// bodies written by real traffic are never in scope.
const demo = [
  { _id: 1, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?' },
  { _id: 2, conversationId: 1, senderId: 1, body: 'Checking now, give me a minute.' },
  { _id: 3, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.' },
];

for (const doc of demo) {
  await bodies.updateOne(
    { _id: doc._id as never },
    { $setOnInsert: { ...doc, createdAt: new Date() } },
    { upsert: true },
  );
}

console.log('seeded demo users, conversations and messages');
process.exit(0);
