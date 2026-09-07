/**
 * Reports message rows in MySQL that have no body in Mongo. The two stores are
 * written separately, so they can drift: a crash between the two writes, or a
 * failed compensating delete, leaves a row with nothing to display.
 *
 * Read-only. It prints what it finds and changes nothing, because deciding
 * whether to delete an orphan or restore its body is not a call a script should
 * make on its own.
 */
import { pool, waitForMysql } from './mysql.ts';
import { connectMongo, mongo } from './mongo.ts';

await waitForMysql();
await connectMongo();

const [rows] = await pool.query('SELECT id FROM messages ORDER BY id');
const ids = (rows as { id: number }[]).map((r) => r.id);

const present = new Set(
  (await mongo().collection('message_bodies').find({ _id: { $in: ids as never[] } }, { projection: { _id: 1 } }).toArray())
    .map((d) => d._id as unknown as number),
);

const orphans = ids.filter((id) => !present.has(id));

console.log(`messages in mysql: ${ids.length}`);
console.log(`bodies in mongo:   ${present.size}`);

if (orphans.length === 0) {
  console.log('no orphans');
} else {
  console.log(`orphaned message ids (${orphans.length}): ${orphans.join(', ')}`);
}

await pool.end();
process.exit(orphans.length === 0 ? 0 : 1);
