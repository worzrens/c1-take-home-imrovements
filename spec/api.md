# API

Every route is under `/api`. Requests and responses are JSON; `application/json`
is the only body format the server parses.

## Authentication

Identity comes from a signed JWT in an `httpOnly` cookie and from nowhere else.
There is no `userId` query parameter and no `senderId` body field — both were
removed rather than deprecated, so there is no fallback path to exploit.

Two cookies are issued on login:

| Cookie | Lifetime | Path | Contents |
| --- | --- | --- | --- |
| `access_token` | 15 minutes | `/` | JWT, HS256, claims `sub` `jti` `iat` `exp` `iss` `aud` and nothing else |
| `refresh_token` | 14 days | `/api/auth/refresh` | opaque random string, stored in Redis |

Both are `HttpOnly`, `Secure`, `SameSite=Lax`. The access token is a JWT so it
verifies without a round trip; the refresh token is opaque and server-side so it
can actually be revoked. The refresh token's narrow `Path` keeps it off every
request but the one that needs it.

Verification pins `algorithms: ['HS256']` and checks `iss` and `aud`, not just
the signature.

**Revocation.** A signed JWT cannot be withdrawn before it expires, so logout
records its `jti` in Redis with a TTL matching the token's remaining life, and
every request checks that list.

### `POST /api/auth/login`

```json
{ "email": "alice@example.com", "password": "…" }
```

`200` with `{ id, name, email }` and both cookies set. `401`
`{ "error": "invalid email or password" }` for a wrong password *and* an unknown
address — identical, so the form cannot be used to enumerate accounts.

### `POST /api/auth/refresh`

Takes the refresh cookie, returns `200 { id }` and a fresh pair. Single use: the
presented token is consumed, so a stolen one is worth one rotation and the theft
shows up as the real user being logged out. `401` if absent or already spent.

### `POST /api/auth/logout`

`204`. Revokes the access token's `jti`, deletes the refresh token, clears both
cookies. Works with an expired token — the cookies still need clearing.

### `GET /api/auth/me`

`200 { id, name, email }`, or `401`.

## Conversations

### `GET /api/conversations`

The caller's own conversations. Three queries regardless of how many there are.

```json
[
  {
    "id": 1,
    "title": "Support — order #1042",
    "messageCount": 12,
    "lastMessage": { "id": 100, "senderId": 2, "createdAt": "2026-09-07T19:17:15.777Z" }
  }
]
```

`lastMessage` is `null` for an empty conversation. Titles are returned as stored,
raw: escaping is the renderer's job, and the client builds text nodes.

### `POST /api/conversations`

```json
{ "title": "New room", "participantIds": [2, 3] }
```

`201 { id, title, participantIds }`. The caller is always added to
`participantIds`, so it is impossible to create a conversation you cannot then
read. The insert and the participant rows are one transaction.

`400` if `title` is missing, over 200 characters, or `participantIds` is not a
non-empty array.

## Messages

### `GET /api/messages`

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `conversationId` | yes | | `403` if the caller is not a participant |
| `limit` | no | 50 | positive integer, capped at 200 |
| `before` | no | | keyset cursor: a message id, exclusive |

```json
{
  "messages": [ { "id": 98, "conversationId": 1, "senderId": 2, "body": "…", "createdAt": "…" } ],
  "hasMore": true,
  "nextBefore": 98
}
```

`messages` is oldest-first. `nextBefore` is the oldest id on the page; pass it as
`before` for the next one. Paging is keyset rather than `OFFSET`, so cost is
constant however deep the history goes and rows are never skipped or repeated
when new messages arrive mid-scroll.

`body` is `null` when the row exists but its body is missing from Mongo. That is
reported rather than smoothed to `""`, which used to disguise real data loss as
an empty message.

### `POST /api/messages`

```json
{ "conversationId": 1, "body": "hello", "clientId": "<uuid>" }
```

`clientId` is required — an idempotency key the client may omit is not one you
can rely on. 1–64 characters, unique per conversation.

| Status | Meaning |
| --- | --- |
| `201` | created; the message is broadcast |
| `200` | `clientId` already used — the original message is returned with `duplicate: true`, and it is **not** broadcast again |
| `400` | missing field, or a bad `clientId` |
| `403` | not a participant |
| `429` | rate limited; see below |

`senderId` is the token subject. Sending one in the body is ignored, not
rejected.

`createdAt` is read back from the row that was just written, so the value
broadcast over the socket and the value returned on reload are the same string.

### Rate limiting

5 sends per 10 seconds, per user **per conversation** — one noisy sender in one
room cannot throttle anybody else, or throttle themselves everywhere. The window
is a sorted set in Redis, so the limit is shared by every instance rather than
multiplied by their number.

Over the limit: `429`, a `Retry-After` header in seconds, and
`{ "error": "too many messages, slow down", "retryAfter": n }`. Every response
carries `RateLimit-Limit` and `RateLimit-Remaining`.

If Redis is unreachable the limiter fails open and logs — being unable to count
should not stop people talking.

## Search

### `GET /api/search`

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `q` | yes | | 1–200 characters |
| `limit` | no | 20 | capped at 100 |

```json
[ { "messageId": 302, "conversationId": 1, "conversationTitle": "Support — order #1042", "body": "…" } ]
```

Mongo full-text search over message bodies, ranked by relevance, **restricted to
conversations the caller belongs to**. Without that scope, search is a way to
read every message in the system without guessing a single id.

`q` is coerced with `String()` before it reaches the query. Express parses
`?q[$ne]=x` into an object and a repeated `?q=` into an array; either would
otherwise land in an operator position.

An empty `q` returns `[]` rather than everything.

## Errors

`{ "error": "…" }` throughout. A 4xx message describes the caller's own mistake
and is safe to echo. A 5xx is always the fixed string `"internal error"` — detail
goes to the log, because driver messages carry filesystem paths and internals.

## CSRF

Cookies are an ambient credential, so three controls, all cheap:

1. `SameSite=Lax` keeps the cookie off cross-site state-changing requests.
2. Every non-GET request has its `Origin` checked; a mismatch is `403`.
3. `express.json()` is the only body parser. A cross-origin HTML form cannot
   produce `application/json`, and a `fetch` that sets it triggers a preflight
   that fails. **Adding `express.urlencoded()` would quietly remove this.**

There is no CORS configuration and there should not be: the frontend is served
from the same origin.

## WebSocket

One socket at `/`, same origin, same port.

**The upgrade is authenticated.** The cookie is sent automatically on upgrade,
which is the reason the token lives in one. No valid `access_token` means the
handshake is refused with `401` — not accepted and closed afterwards.

### Client → server

```json
{ "type": "subscribe", "conversationIds": [1, 2] }
```

The server intersects the requested set with the conversations the user is
actually in, so asking for someone else's conversation gets you nothing. Send it
again whenever the set changes.

```json
{ "type": "typing", "conversationId": 1 }
```

Ignored unless the socket is subscribed to that conversation. Throttled to one
frame every 2 seconds per socket per conversation, and **dropped rather than
rejected** — a `429` for a keystroke is noise the client cannot use.

Malformed frames and unknown types are ignored, never fatal.

### Server → client

```json
{ "type": "message", "id": 302, "conversationId": 1, "senderId": 1, "body": "…", "createdAt": "…" }
{ "type": "typing",  "conversationId": 1, "userId": 1, "name": "Alice" }
```

There is no "stopped typing" event; the client expires an indicator after about
four seconds.

### Fan-out

Every event is published to the Redis channel `relay:events` and each instance
subscribes and delivers to its own sockets. The instance that handled the request
receives its own publish, so there is one delivery path rather than a local
shortcut and a remote one.

This is what makes `--scale api=3` work. Before it, a message only reached the
subset of users who happened to be connected to the instance that handled the
POST.
