import { createClient, type RedisClientType } from 'redis';
import { config } from '../config.ts';

/**
 * Redis is the shared state that makes several features work across more than
 * one API instance: the rate-limit counters (N11), the broadcast fan-out (N9),
 * typing presence, and the token deny list that lets logout actually revoke a
 * JWT before it expires (C1).
 *
 * Shaped like `src/db/mongo.ts` on purpose — connect once at boot, then reach
 * for the client through an accessor that throws if it was never connected.
 */
let client: RedisClientType | undefined;
let sub: RedisClientType | undefined;

function make(): RedisClientType {
  const c = createClient({ url: config.redisUrl }) as RedisClientType;
  // Without a listener an 'error' event is rethrown and kills the process, which
  // is the same trap C3 fixed on the WebSocket server.
  c.on('error', (err) => console.error('[redis] client error', err));
  return c;
}

export async function connectRedis(retries = 20): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      client = make();
      await client.connect();
      // Pub/sub puts a connection into subscriber mode, where it can run nothing
      // else. The duplicate is what keeps normal commands working alongside it.
      sub = client.duplicate() as RedisClientType;
      sub.on('error', (err) => console.error('[redis] subscriber error', err));
      await sub.connect();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`redis not reachable: ${lastErr}`);
}

export function redis(): RedisClientType {
  if (!client) throw new Error('redis not connected');
  return client;
}

export function subscriber(): RedisClientType {
  if (!sub) throw new Error('redis not connected');
  return sub;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([sub?.quit(), client?.quit()]);
  client = undefined;
  sub = undefined;
}
