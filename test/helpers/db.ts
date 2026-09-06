import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';

/**
 * The database-backed suites only run when a real MySQL and Mongo are reachable.
 * In CI or on a laptop with nothing running, `describe` calls `bothReachable()`
 * and skips, rather than hanging on the 30s connection retry loops in `src/db`.
 *
 * The defaults deliberately match `src/config.ts` — the compose-network
 * hostnames `mysql` and `mongo`, which do not resolve on the host. So a bare
 * `npm test` probes them, fails in under two seconds and skips every DB suite.
 * `npm run test:db` first brings the stack up and exports the published-port
 * URLs, which the probe and `src/config.ts` then both use.
 */
export const MYSQL_URL =
  process.env.MYSQL_URL ?? 'mysql://root:root@mysql:3306/relay?charset=utf8mb4';
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://mongo:27017/relay';

let mysqlOk: boolean | undefined;
let mongoOk: boolean | undefined;

export async function mysqlReachable(): Promise<boolean> {
  if (mysqlOk !== undefined) return mysqlOk;
  try {
    const conn = await mysql.createConnection({ uri: MYSQL_URL, connectTimeout: 2000 });
    await conn.query('SELECT 1');
    await conn.end();
    mysqlOk = true;
  } catch {
    mysqlOk = false;
  }
  return mysqlOk;
}

export async function mongoReachable(): Promise<boolean> {
  if (mongoOk !== undefined) return mongoOk;
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    mongoOk = true;
  } catch {
    mongoOk = false;
  } finally {
    await client.close().catch(() => {});
  }
  return mongoOk;
}

export async function bothReachable(): Promise<boolean> {
  const [a, b] = await Promise.all([mysqlReachable(), mongoReachable()]);
  return a && b;
}

/** A fresh mysql2 connection for a test. Caller closes it. */
export function mysqlConn() {
  return mysql.createConnection({ uri: MYSQL_URL, multipleStatements: true });
}

/** A connected MongoClient for a test. Caller closes it. */
export async function mongoClient() {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 });
  await client.connect();
  return client;
}

export const SKIP_DB = 'no MySQL/Mongo reachable — set MYSQL_URL and MONGO_URL to run';
