# Working notes

What was wrong, and what I did about it. In the order the work happened.

The `C` and `N` ids come from the code review this started from. The longer plan
and the review itself stayed local; [`future-improvements.md`](future-improvements.md)
carries forward everything still open.

---

## Groundwork

**PRE-1. Migrations.** `docker/db/mysql.sql` was mounted into the MySQL image's
init directory, which only runs when the data directory is empty. Every schema
change I had planned would have applied for whoever booted first and silently
done nothing for everyone else.

Umzug over the existing `mysql2` driver, running plain SQL files. No ORM, no
query builder, no extra container. The first migration is a faithful copy of the
old schema, flaws included, so a running database can be baselined instead of
failing on tables it already has. Migrations run as a one-shot compose service,
not on boot, because three API instances would otherwise race the same DDL.

**PRE-2. Redis client.** Three of the four feature briefs need shared state, so
the client landed once, on its own, before any of them.

---

## Crashes and data loss

**C2. Route handlers could kill the process.** No handler had a `try`/`catch` and
there was no error middleware. Express 4 does not forward a rejected promise, so
any database error escaped as an unhandled rejection and Node exited. A
conversation title over 200 characters was enough to take the server down.

A `wrap` helper plus a terminal error middleware. That is what Express 5 does
natively, so the wrapper is deletable on upgrade. The middleware echoes the
message on 4xx and returns a fixed string on 5xx, because a 4xx describes the
caller's own mistake while a 5xx can carry driver internals and filesystem paths.

**C3. A dropped socket could kill the process.** The WebSocket handler listened
for `message` and `close` but not `error`. Node rethrows an unhandled `error`
event as an uncaught exception, so one client resetting its socket took the
server with it. Sockets that error also never emit `close`, so they leaked into
the broadcast set.

Listeners on both the server and each connection, and the connection handler now
removes the socket and terminates it. The leak and the crash had the same cause.

**C6. Restarting destroyed message bodies.** The seed ran `deleteMany({})` on
every `docker compose up`, not just the first. MySQL kept its rows because it was
only seeded on an empty data directory, so after a restart every message sent
before it rendered as a blank line, permanently. `bodyById.get(id) ?? ''` in the
read path made that look like an empty message rather than an error.

Three changes, because the bug had three parts. The seed upserts instead of
wiping. Both stores got named volumes, since neither had one and their lifecycles
could drift apart. A missing body now comes back as `null` and is logged, and the
client shows "(message unavailable)". The silent empty string is what let this
survive unnoticed.

**C8. The dual write left silent orphans.** `createMessage` wrote metadata to
MySQL and the body to Mongo as two independent writes with no compensation. A
failed Mongo write left a message that existed forever with no body.

The Mongo write is now wrapped and a failure deletes the MySQL row before
rethrowing. This is compensation, not atomicity, and the code says so. It turns
the common case from silent corruption into a clean error.

Writing the body first is not possible as things stand: the Mongo `_id` **is**
the MySQL auto-increment value. Doing it properly needs application-generated
ids, which changes the id type in the client, the socket payloads and the
pagination cursor. Deliberately not done here. `npm run reconcile` reports
orphans instead, read-only, because choosing between deleting one and restoring
its body is not a call a script should make unattended.

---

## Security

**C5. Stored XSS in the sidebar.** `renderSidebar` interpolated the conversation
title into `innerHTML`. Titles are attacker-controlled and anyone could create a
conversation containing anyone, so `<img src=x onerror=...>` ran in every
participant's browser the moment their sidebar rendered. It was wormable.

Build the nodes with `createElement` and `textContent`, which is what the message
rendering a few lines below already did. An escaping helper would work too, but
it leaves `innerHTML` in the file for the next person to use without one. There
is now no `innerHTML` in `web/app.js` at all.

**C4. Deleted the message "signature".** Two faults in one line. It was not a
signature — no secret, salt hardcoded in the repo — and nothing ever verified it.
It was also `pbkdf2Sync` at 200,000 iterations on the request path, blocking the
event loop for 27 ms per message, which capped the whole server at roughly 37
messages a second.

Deleted rather than replaced with a real HMAC. Nothing reads the field and no
requirement asks for message integrity; a cheaper unused control is still an
unused control. Measured: 27.31 ms of blocked event loop per message before, none
after.

**C1 + C7. Authentication.** Every endpoint was open. Identity was `?userId=` in
the query string and `senderId` in the body, so anyone could read any
conversation and post as anyone. The WebSocket accepted any upgrade and any
subscription.

The token travels in an `httpOnly` cookie rather than a header or `localStorage`.
Script cannot read it, so an XSS bug cannot exfiltrate the credential, and the
browser attaches it to the WebSocket upgrade automatically, which is the only
clean way to authenticate a browser socket. The cost is taken knowingly: CSRF
stops being structurally impossible, so `SameSite=Lax`, an `Origin` check on
every state-changing request, and keeping `express.json()` as the only body
parser replace what used to be free.

Decisions worth knowing:

- **scrypt, not argon2 or bcrypt.** Both are native addons, and this repo already
  lost an afternoon to a `node_modules` built for another platform. scrypt is
  memory-hard, ships with Node, and OWASP accepts it. Cost parameters live in the
  hash string so they can be raised without stranding credentials.
- **The access token is a JWT; the refresh token is not.** A stateless refresh
  token has exactly the "cannot be withdrawn" problem it exists to solve, so it
  is an opaque random string in Redis, single-use, rotated on every refresh.
- **Revocation is a `jti` deny list** with a TTL matching the token's remaining
  life, so the list bounds itself with no sweep.
- **`algorithms: ['HS256']` on verify.** Without an explicit allowlist the token
  header decides, which is `alg:none` and the confusion family.
- **`password_hash` is nullable.** NULL means "cannot log in", treated exactly
  like a wrong password. `NOT NULL` with a default would have handed every legacy
  row the same fake credential.
- **Unknown email and wrong password return the same 401**, or the login form is
  an account enumerator. 403 says nothing about existence either, so it cannot be
  used to walk ids.

**N4. Stack traces in responses.** `NODE_ENV` was never set, so Express ran its
development error handler. Malformed JSON reaches it synchronously, before any
route, and came back with absolute filesystem paths and dependency internals.
`x-powered-by` was on as well.

Set `NODE_ENV=production` and disabled the header. That also surfaced a trap:
`tsx` was in `devDependencies` while `npm start` runs `tsx src/index.ts`. One
`--omit=dev` install away from a container that would not boot.

**N15. Security headers.** No CSP, no `nosniff`, no frame protection. Added
`helmet` with `useDefaults: false`, so the policy is the list in the file rather
than a merge with whatever the library ships this version. The inline `<style>`
block moved to `web/styles.css` so `style-src` does not need `'unsafe-inline'`.

---

## Performance and correctness

**C9. Indexes and foreign keys.** The schema had neither. Four hot queries
scanned whole tables, including the sidebar's last-message and count lookups.
Straight `ALTER TABLE` in a second migration rather than editing the first, so a
running database picks them up too. `ON DELETE CASCADE` where a child row is
meaningless without its parent, but `RESTRICT` on `messages.sender_id` so a user
with history cannot be deleted out from under their own messages.

**N1. The conversation-list N+1.** Two queries per conversation inside an awaited
loop, so 50 conversations meant 101 sequential round trips. Now three queries
regardless of count. A single joined query was possible but needs a derived table
and a self join to get the last row per group, and it reads worse than three
obvious statements.

**N6. One timestamp, from the database.** `created_at` was a `TIMESTAMP`, so
second granularity and a 2038 limit, and the value the API returned was a
separate `new Date()` from Node. The timestamp broadcast over the socket and the
one seen after a reload disagreed. Now `DATETIME(3)`, and the service reads the
stored value back. Two clocks answering for one event was the actual bug.

**N2. Paginated message history.** The endpoint selected every message in a
conversation and sent every id to Mongo in one `$in`. Keyset pagination on `id`
rather than `LIMIT`/`OFFSET`: constant cost however deep the history goes, and it
cannot skip or repeat a row when new messages land between pages, which in a chat
app is constantly. The query asks for one row more than the caller wanted, and
the surplus is how `hasMore` is known.

**N5. `client_id` idempotency.** The column existed, the browser sent a fresh
UUID every time, and nothing read either. Now: insert first and catch the
duplicate key, rather than check-then-insert, which races. A duplicate returns
200 with the original message where a fresh send returns 201, and is **not**
broadcast. Fanning out a retry would render the message twice for what the sender
experienced as one send.

**N7. Conversation creation is transactional.** The insert and the participant
rows were separate statements with nothing tying them together, so a failure
halfway left a conversation nobody was in. One connection, one transaction, one
multi-row participant insert, rollback on error. The creator is now added
automatically, which they were not before.

**N12. Send failures are visible.** The input used to clear on submit regardless
of what the server said. It now clears only on confirmation, and a 429 shows its
`Retry-After` instead of the message vanishing.

**N18. Static files resolve from the source file.** `express.static('web')` is
relative to the working directory, so it only worked when the process was started
from the repo root. Resolved from `import.meta.url` instead. (This one was ticked
off early and then quietly undone when `createApp()` moved out of `index.ts`. The
regression suite is what made it findable again.)

**N20. WebSocket scheme.** Hardcoded `ws:`, which breaks the socket the moment
the page is served over TLS. Derived from `location.protocol`.

---

## Features

**Search.** The endpoint ignored `q` and returned `[]`. Now a Mongo text index on
the bodies, which already live there, so search stays in the store that holds the
text.

Scoped to the caller's conversations — unscoped, search reads every message in
the system without even guessing an id, which is strictly worse than the IDOR
next to it. `String(q)` before the query, because Express parses `?q[$ne]=x` into
an object and a repeated `?q=` into an array, and either reaches an operator
position. Indexes are created at boot from code, since Mongo has no migration
story here and `createIndex` is idempotent.

No pagination, no highlighting, relevance ranking only.

**Rate limiting.** A sliding-window log in a Redis sorted set, keyed on user
*and* conversation. In-process counters would give each instance its own
allowance, so three instances would mean three times the limit. A fixed window
would have been one `INCR`, but it lets a caller spend the full allowance at the
end of one window and again at the start of the next, doubling the real burst.

Per user and per conversation, so one noisy sender cannot throttle the room and
being limited in one room does not silence someone everywhere. It fails open: if
Redis is unreachable the limiter logs and allows, because being unable to count
should not stop people talking.

**Multi-instance real-time.** The proxy already spread traffic across instances,
but the broadcast set lived in one process, so a message only reached users
connected to the instance that handled the POST.

One Redis channel for every real-time event. Each instance publishes, and every
instance including the publisher subscribes and fans out to its own sockets.
Having the publisher receive its own message keeps one delivery path, so local
and remote clients cannot disagree.

The subscription is guarded to once per process. Attaching twice stacked
callbacks on the same channel and delivered every event once per call — the
typing test found it, as twelve copies of one frame.

**Typing indicator.** Rides the same channel, so it is multi-instance correct for
free. Throttled separately from message sends and dropped rather than rejected:
typing is far chattier, must not eat the message allowance, and a 429 for a
keystroke is noise the client cannot act on. There is no "stopped typing" event,
so the indicator expires itself after about four seconds.

---

## Tests

Fifteen commits of fixes verified one at a time and mostly by hand. Nothing
stopped a later change from quietly reversing an earlier one, which is the
guarantee the brief actually asks for.

`node:test` driven by `tsx`, no new dependency. Three layers:

- `test/unit/` — pure logic and in-process HTTP. Pagination walked across a
  125-row table and across new rows arriving mid-scroll, the conversation-list
  assembly, the error middleware through a real Express app, and the socket hub
  through a real `ws` server including an abrupt reset. Plus static guards for
  fixes whose regression would be a source edit rather than a behaviour change.
- `test/http/` — the app on an ephemeral port with no database: every validation
  path that returns before a query, and the header assertions.
- `test/db/` — the real thing. Live schema after migrations, idempotency and
  timestamps, orphan detection, seed and migration reruns, auth, authorization,
  search, rate limiting and the socket, end to end.

The database suites probe for MySQL, Mongo and Redis and skip the whole
`describe` with a reason if any is missing, so `npm test` on a laptop with
nothing running is green in about a second. `npm run test:db` brings the stack up
first.

113 tests, all passing. Every commit typechecks in isolation.

The suite paid for itself twice: it found the stacked socket subscription above,
and it caught N18 coming undone.

---

## Spec

`spec/` held a `.gitkeep`. It now has the HTTP and WebSocket contract with status
codes, the data model across all three stores and why there are three, the
container topology and startup ordering, and what is deliberately unfinished.

Written last, on purpose, so it describes what is actually there rather than what
was planned.
