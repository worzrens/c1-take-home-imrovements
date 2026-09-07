import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyAccessToken } from './tokens.ts';
import { ACCESS_COOKIE, readCookies } from './cookies.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
      tokenJti?: string;
      tokenExp?: number;
    }
  }
}

function unauthorized(res: Response) {
  return res.status(401).json({ error: 'authentication required' });
}

/**
 * Identity comes from the token's `sub` and nowhere else. `req.query.userId` and
 * `req.body.senderId` are gone from the API surface entirely rather than
 * deprecated, so there is no fallback path left to exploit.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  const token = readCookies(req)[ACCESS_COOKIE];
  if (!token) return unauthorized(res);

  verifyAccessToken(token)
    .then((claims) => {
      req.userId = Number(claims.sub);
      req.tokenJti = claims.jti;
      req.tokenExp = claims.exp;
      next();
    })
    .catch(() => unauthorized(res));
};

/**
 * Same as `authenticate`, but a missing or invalid token is not an error. Logout
 * uses it: the cookies must be cleared even when the token has already expired,
 * while a still-valid one needs its jti added to the deny list.
 */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  const token = readCookies(req)[ACCESS_COOKIE];
  if (!token) return next();

  verifyAccessToken(token)
    .then((claims) => {
      req.userId = Number(claims.sub);
      req.tokenJti = claims.jti;
      req.tokenExp = claims.exp;
    })
    .catch(() => {})
    .finally(() => next());
};

/**
 * CSRF layer two. SameSite=Lax is the primary control and keeps the cookie off
 * cross-site POSTs; this catches the cases it does not, and costs one header
 * comparison.
 *
 * Layer three is that express.json() is the only body parser: a cross-origin
 * HTML form cannot produce application/json, and a fetch that sets it triggers a
 * preflight with no CORS headers to satisfy it. Adding express.urlencoded()
 * would quietly undo that.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const origin = req.get('origin');
  // Same-origin fetch from a browser always sends Origin on a state-changing
  // request. Absent means a non-browser client, which CSRF does not apply to.
  if (!origin) return next();

  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin !== expected) {
    res.status(403).json({ error: 'cross-origin request rejected' });
    return;
  }
  next();
}
