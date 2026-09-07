import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.ts';
import { redis } from '../db/redis.ts';

export const ISSUER = 'relay';
export const AUDIENCE = 'relay-web';
export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Resolved on first use rather than at import, so the test suite can set
 * JWT_SECRET in its own environment. `src/index.ts` calls this at boot to keep
 * the fail-fast behaviour: a missing secret must stop the process, never fall
 * back to a literal the way config.ts still does for the database URLs.
 */
let cached: Uint8Array | undefined;
export function jwtSecret(): Uint8Array {
  if (cached) return cached;
  const raw = config.jwtSecret;
  if (!raw || raw.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  cached = new TextEncoder().encode(raw);
  return cached;
}

export interface AccessClaims {
  sub: string;
  jti: string;
  exp: number;
}

/**
 * Nothing here but sub, jti and the registered claims. No email, no name, no
 * roles: the payload is base64, not encryption, and anything put in it is
 * readable by anyone holding the token.
 */
export async function signAccessToken(userId: number): Promise<{ token: string; jti: string }> {
  const jti = randomUUID();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(jwtSecret());
  return { token, jti };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, jwtSecret(), {
    // Pinning the algorithm is what closes alg:none and the HS/RS confusion
    // family. Verifying without an allowlist accepts whatever the header claims.
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!payload.sub || !payload.jti || !payload.exp) throw new Error('token missing claims');

  if (await isRevoked(payload.jti)) throw new Error('token revoked');

  return { sub: payload.sub, jti: payload.jti, exp: payload.exp };
}

/* -------------------------------------------------------------------------- */
/* Revocation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A signed JWT cannot be withdrawn before it expires, so logout and password
 * change record the jti here. The key expires when the token would have anyway,
 * which keeps the list bounded without a sweep.
 */
const denyKey = (jti: string) => `revoked:${jti}`;

export async function revokeAccessToken(jti: string, expUnixSeconds: number): Promise<void> {
  const ttl = Math.max(1, expUnixSeconds - Math.floor(Date.now() / 1000));
  await redis().set(denyKey(jti), '1', { EX: ttl });
}

export async function isRevoked(jti: string): Promise<boolean> {
  return (await redis().exists(denyKey(jti))) === 1;
}

/* -------------------------------------------------------------------------- */
/* Refresh tokens                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Opaque and server-side, not a second JWT. A random string in Redis is
 * revocable by deleting it, which is the whole point of a refresh token; a
 * stateless one would have the same "cannot be withdrawn" problem as the access
 * token it is meant to replace.
 */
const refreshKey = (token: string) => `refresh:${token}`;

export async function issueRefreshToken(userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await redis().set(refreshKey(token), String(userId), { EX: REFRESH_TTL_SECONDS });
  return token;
}

/** Single-use: consuming a refresh token deletes it, so replay gets nothing. */
export async function consumeRefreshToken(token: string): Promise<number | null> {
  const key = refreshKey(token);
  const userId = await redis().get(key);
  if (userId === null) return null;
  await redis().del(key);
  return Number(userId);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await redis().del(refreshKey(token));
}
