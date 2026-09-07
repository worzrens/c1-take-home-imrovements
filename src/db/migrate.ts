import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { Umzug, type UmzugStorage } from 'umzug';
import { config } from '../config.ts';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

interface Context {
  conn: mysql.Connection;
}

/**
 * Migrations run on their own connection rather than the shared pool: they need
 * multipleStatements so a single .sql file can hold several statements, and that
 * flag is one we never want on the connection serving user requests.
 */
async function connect(retries = 40): Promise<mysql.Connection> {
  const url = new URL(config.mysqlUrl);
  let lastErr: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      return await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port) || 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
        multipleStatements: true,
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw new Error(`mysql not reachable: ${lastErr}`);
}

const storage: UmzugStorage<Context> = {
  async executed({ context }) {
    await context.conn.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    const [rows] = await context.conn.query('SELECT name FROM _migrations ORDER BY name');
    return (rows as { name: string }[]).map((r) => r.name);
  },

  async logMigration({ name, context }) {
    await context.conn.execute('INSERT INTO _migrations (name) VALUES (?)', [name]);
  },

  async unlogMigration({ name, context }) {
    await context.conn.execute('DELETE FROM _migrations WHERE name = ?', [name]);
  },
};

async function runSqlFile(conn: mysql.Connection, file: string): Promise<void> {
  await conn.query(await readFile(file, 'utf8'));
}

export function migrator(context: Context) {
  return new Umzug({
    context,
    storage,
    logger: console,
    migrations: {
      glob: ['*.up.sql', { cwd: migrationsDir }],
      resolve: ({ name, path: file }) => ({
        name: name.replace(/\.up\.sql$/, ''),
        up: async () => runSqlFile(context.conn, file!),
        down: async () => runSqlFile(context.conn, file!.replace(/\.up\.sql$/, '.down.sql')),
      }),
    },
  });
}

const conn = await connect();
try {
  const umzug = migrator({ conn });
  // `down` reverts a single migration, which is the only safe default: reverting
  // everything on a typo is how people lose a database.
  await (process.argv[2] === 'down' ? umzug.down() : umzug.up());
} finally {
  await conn.end();
}
