# Relay

A small group-chat service: conversations with participants, a message history,
full-text search, and a live feed over WebSocket.

This directory is the reference for how it behaves. It describes the system as
built, not as planned — where something is missing or deliberately unfinished it
says so under [Known gaps](#known-gaps).

- [`api.md`](api.md) — HTTP endpoints and the WebSocket protocol
- [`data-model.md`](data-model.md) — MySQL, Mongo and Redis, and why there are three

## Shape of the system

```
browser ──► envoy :3000 ──► api ×N ──┬──► mysql    metadata, membership, ordering
                                     ├──► mongo    message bodies, text search
                                     └──► redis    sessions, rate limits, fan-out
```

Envoy terminates the client connection and round-robins across API instances,
including WebSocket upgrades. Because any instance can serve any request, no
instance may hold state another one needs — every piece of shared state is in
Redis.

## Running it

```
cp .env.example .env
docker compose up --build
```

Then <http://localhost:3000>, and sign in as `alice@example.com` with
`relay-demo-password`. Bob and Carol exist with the same password; Alice and Bob
share conversation 1, Alice and Carol share conversation 2, which is what makes
the authorization boundary visible by hand.

Startup is ordered, not raced:

1. `mysql` becomes healthy.
2. `migrate` runs to completion — a one-shot service, so scaled API instances
   never race the same DDL.
3. `seed` runs to completion. It is idempotent, so a restart adds nothing and
   destroys nothing.
4. `api` starts, and refuses to start at all if `JWT_SECRET` is missing or under
   32 characters.

To run it as several instances:

```
docker compose up -d --scale api=3
```

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | |
| `MYSQL_URL` | no | compose hostname | |
| `MONGO_URL` | no | compose hostname | |
| `REDIS_URL` | no | compose hostname | |
| `JWT_SECRET` | **yes** | none | ≥ 32 chars. No fallback: a default signing key is a published one. |
| `RATE_LIMIT_MAX` | no | `5` | Sends per window, per user per conversation. |
| `RATE_LIMIT_WINDOW_MS` | no | `10000` | |

The three URLs still fall back to their compose hostnames, which is a loose end
rather than a decision — see the gaps below.

## Tests

```
npm test          # unit + HTTP, no services needed, ~3s
npm run test:db   # brings up mysql/mongo/redis, migrates, seeds, runs everything
```

`npm test` skips the database-backed suites with a printed reason when nothing is
reachable, so it is safe to run anywhere, including a CI job with no services
attached.

## Known gaps

Deliberately not built. Listed so nobody has to rediscover them.

- **No registration, password change or reset.** Accounts come from the seed.
  Password changes would want the token deny list, which already exists.
- **No WebSocket keepalive.** Envoy will drop an idle socket, and neither side
  pings or reconnects with backoff. A quiet conversation goes silently stale
  until the page is reloaded.
- **Unread state is client-side only.** It resets on reload and is not shared
  between a user's devices.
- **No graceful shutdown or health endpoint.** SIGTERM kills in-flight requests,
  and Envoy has no health check to route around a sick instance.
- **Search ranks by relevance only**, with no pagination and no highlighting.
  It is scoped correctly, which was the part that mattered.
- **Container hygiene.** The image runs as root and uses `npm install` rather
  than `npm ci`; there is no `.dockerignore`.
- **MySQL and Mongo publish to all interfaces** in the compose file, and Mongo
  has authentication disabled. Convenient locally, wrong anywhere else.
