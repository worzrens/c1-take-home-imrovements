import express from 'express';
import type { RowDataPacket } from 'mysql2';
import { pool } from '../db/mysql.ts';
import { wrap } from '../http/errors.ts';
import { verifyPassword } from '../auth/passwords.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
  signAccessToken,
} from '../auth/tokens.ts';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  readCookies,
  setAuthCookies,
} from '../auth/cookies.ts';
import { authenticate, optionalAuthenticate } from '../auth/middleware.ts';

export const authRouter = express.Router();

interface UserRow extends RowDataPacket {
  id: number;
  name: string;
  email: string;
  password_hash: string | null;
}

async function issueSession(userId: number) {
  const [{ token }, refresh] = await Promise.all([
    signAccessToken(userId),
    issueRefreshToken(userId),
  ]);
  return { token, refresh };
}

authRouter.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const [rows] = await pool.query<UserRow[]>(
    'SELECT id, name, email, password_hash FROM users WHERE email = ?',
    [email],
  );
  const user = rows[0];

  // One message and one code for both "no such account" and "wrong password".
  // Distinguishing them turns the login form into an account enumerator.
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok) return res.status(401).json({ error: 'invalid email or password' });

  const { token, refresh } = await issueSession(user.id);
  setAuthCookies(res, token, refresh);
  res.json({ id: user.id, name: user.name, email: user.email });
}));

authRouter.post('/refresh', wrap(async (req, res) => {
  const presented = readCookies(req)[REFRESH_COOKIE];
  if (!presented) return res.status(401).json({ error: 'authentication required' });

  // Single use. The old token is gone whether or not the rotation succeeds, so a
  // stolen refresh token is worth at most one use and the theft is detectable as
  // the real user being logged out.
  const userId = await consumeRefreshToken(presented);
  if (userId === null) return res.status(401).json({ error: 'authentication required' });

  const { token, refresh } = await issueSession(userId);
  setAuthCookies(res, token, refresh);
  res.json({ id: userId });
}));

authRouter.post('/logout', optionalAuthenticate, wrap(async (req, res) => {
  const cookies = readCookies(req);

  // Best effort on both halves: a logout must clear the cookies even if the
  // token was already expired or malformed.
  if (cookies[REFRESH_COOKIE]) await revokeRefreshToken(cookies[REFRESH_COOKIE]);
  if (req.userId && req.tokenJti && req.tokenExp) {
    await revokeAccessToken(req.tokenJti, req.tokenExp);
  }

  clearAuthCookies(res);
  res.status(204).end();
}));

authRouter.get('/me', authenticate, wrap(async (req, res) => {
  const [rows] = await pool.query<UserRow[]>('SELECT id, name, email FROM users WHERE id = ?', [
    req.userId,
  ]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'authentication required' });
  res.json({ id: user.id, name: user.name, email: user.email });
}));
