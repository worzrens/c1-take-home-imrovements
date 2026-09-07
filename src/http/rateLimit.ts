import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { redis } from '../db/redis.ts';

export const DEFAULT_LIMIT = Number(process.env.RATE_LIMIT_MAX) || 5;
export const DEFAULT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Sliding-window log in a Redis sorted set: one member per request, scored by
 * timestamp, with everything older than the window trimmed before counting.
 *
 * A counter in process memory would reset on deploy and, more to the point,
 * would give each instance its own allowance — three instances behind the proxy
 * would mean three times the limit. The state has to be somewhere shared.
 *
 * A fixed window would have been one INCR, but it lets a caller send the full
 * allowance at the end of one window and again at the start of the next, so the
 * real burst is double the limit. The log costs one extra command and does not.
 */
export async function consume(
  key: string,
  limit = DEFAULT_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<RateLimitResult> {
  const now = Date.now();
  const cutoff = now - windowMs;

  const client = redis();
  // Trim and count in one round trip. The window is short and the set is tiny,
  // so this stays cheap.
  const [, countRaw] = (await client
    .multi()
    .zRemRangeByScore(key, 0, cutoff)
    .zCard(key)
    .exec()) as unknown as [number, number];

  const count = Number(countRaw);
  if (count >= limit) {
    // How long until the oldest request in the window falls out of it.
    const oldest = await client.zRangeWithScores(key, 0, 0);
    const freesAt = (oldest[0]?.score ?? now) + windowMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)),
    };
  }

  await client
    .multi()
    .zAdd(key, { score: now, value: `${now}-${randomUUID()}` })
    // Expire slightly past the window so an idle key cleans itself up.
    .pExpire(key, windowMs + 1000)
    .exec();

  return { allowed: true, remaining: limit - count - 1, retryAfterSeconds: 0 };
}

/**
 * Per user and per conversation, which is what the brief asks for: one noisy
 * sender in one room must not throttle anyone else, or the limit becomes a way
 * to silence a conversation you are in.
 */
export function limitMessageSends(limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (req.method !== 'POST') return next();
    const conversationId = Number(req.body?.conversationId);
    if (!req.userId || !Number.isInteger(conversationId)) return next();

    consume(`rl:send:${req.userId}:${conversationId}`, limit, windowMs)
      .then((result) => {
        res.setHeader('RateLimit-Limit', String(limit));
        res.setHeader('RateLimit-Remaining', String(result.remaining));
        if (result.allowed) return next();

        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        res.status(429).json({
          error: 'too many messages, slow down',
          retryAfter: result.retryAfterSeconds,
        });
      })
      // Redis being down must not stop people talking. Fail open and say so.
      .catch((err) => {
        console.error('[ratelimit] check failed, allowing request', err);
        next();
      });
  };
}
