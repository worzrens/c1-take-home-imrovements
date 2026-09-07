import type { Request, Response } from 'express';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from './tokens.ts';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

/**
 * The token travels in an httpOnly cookie, not an Authorization header and not
 * localStorage. Script cannot read it, so the stored XSS class of bug cannot
 * exfiltrate the credential, and the browser sends it automatically on the
 * WebSocket upgrade — which is the only clean way to authenticate a browser
 * socket. The cost is that CSRF stops being structurally impossible, which is
 * what `requireSameOrigin` below is for.
 */

/**
 * The WebSocket upgrade has a raw IncomingMessage, not an Express Request, so
 * the parser works on the header string and `readCookies` is the thin wrapper.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Express only populates req.cookies with cookie-parser; this is that, minus the dependency. */
export function readCookies(req: Request): Record<string, string> {
  return parseCookieHeader(req.headers.cookie);
}

const base = {
  httpOnly: true,
  // Browsers treat localhost as a secure context, so this works over plain HTTP
  // in development and still requires TLS anywhere real.
  secure: true,
  sameSite: 'lax' as const,
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: '/', maxAge: ACCESS_TTL_SECONDS * 1000 });
  // Scoped to the one endpoint that needs it, so it is not attached to every
  // request and its exposure surface is a single route.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    path: '/api/auth/refresh',
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth/refresh' });
}
