import { listen, req, type RunningServer } from './http.ts';

export const DEMO_PASSWORD = 'relay-demo-password';
export const ALICE = 'alice@example.com';
export const BOB = 'bob@example.com';
export const CAROL = 'carol@example.com';

/**
 * The credential is an httpOnly cookie, so tests have to keep a cookie jar the
 * way a browser would. Nothing here reads the token — that is the point of the
 * transport, and a test that reached into it would not be testing the real path.
 */
export class Session {
  private jar = new Map<string, string>();

  constructor(readonly base: string) {}

  get cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(headers: Headers): void {
    // Node exposes multiple Set-Cookie headers through getSetCookie().
    for (const line of headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('cookie', this.cookieHeader);
    // Same-origin Origin header, so the CSRF check sees what a browser sends.
    if (init.method && init.method !== 'GET') headers.set('origin', this.base);
    const res = await req(this.base, path, { ...init, headers });
    this.absorb(res.headers);
    return res;
  }

  post(path: string, payload: unknown) {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async login(email: string, password = DEMO_PASSWORD) {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
    return res.body as { id: number; name: string; email: string };
  }
}

/** Boots the real app and returns a server plus a helper to make sessions on it. */
export async function appServer(): Promise<{
  server: RunningServer;
  session: () => Session;
  close: () => Promise<void>;
}> {
  const { createApp } = await import('../../src/app.ts');
  const server = await listen(createApp());
  return {
    server,
    session: () => new Session(server.url),
    close: () => server.close(),
  };
}
