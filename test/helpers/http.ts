import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type express from 'express';

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts an Express app on an ephemeral port and returns its base URL. */
export async function listen(app: express.Express): Promise<RunningServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** fetch wrapper that also parses JSON and keeps the status and headers. */
export async function req(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown; text: string }> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave body as text */
  }
  return { status: res.status, headers: res.headers, body, text };
}

export const jsonPost = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
