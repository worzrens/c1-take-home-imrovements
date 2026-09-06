# Working notes

One entry per step, in the order the work was done. Each says what was wrong and
why the fix took the shape it did. The C and N ids are the findings from the
code review this work started from.

---

## PRE-1. Migration tooling

**Problem.** `docker/db/mysql.sql` was mounted into `/docker-entrypoint-initdb.d`,
and the MySQL image runs that directory only when the data directory is empty.
Any schema change added to that file applies on a fresh container and silently
does nothing on an existing one. Five planned changes add columns, constraints or
indexes, so every one of them would have worked for whoever ran it first and
failed for everyone else. The same file also mixed schema with demo data.

**Why this solution.** Umzug over the existing `mysql2` driver, running plain SQL
files. It executes under `tsx` exactly like the seed already did, so it adds no
ORM, no query builder and no second language to the toolchain. `dbmate` would
also have worked but costs an extra image in compose. Prisma and Knex were
rejected because both bring a query layer this codebase does not use, and Prisma
in particular wants to own migrations, which would mean adopting its engine
rather than adding a small runner.

**Choices worth knowing about.**

- `0001_initial.up.sql` is a faithful copy of the old schema, existing flaws
  included. That is what lets an already-running database be baselined by
  inserting the migration name into `_migrations` instead of failing on tables
  that already exist. Fixes go in later migrations.
- Migrations run as a one-shot compose service, not from `src/index.ts` on boot.
  Under `docker compose up --scale api=3` three instances would race the same DDL.
- The runner opens its own connection with `multipleStatements` enabled rather
  than borrowing the shared pool, because that flag should never be set on the
  connection serving user requests.
- `migrate:down` reverts one migration, not all of them. Reverting everything on
  a mistyped command is how databases get lost.
- Demo rows moved into the seed and use `INSERT IGNORE`, so a rerun is a no-op.
  Behaviour on a fresh boot is unchanged.

**Not done here.** The seed still wipes Mongo message bodies on every boot, which
is the C6 data-loss bug. It is marked with a TODO and fixed in its own step.

**Side effect.** Adding a dependency generated `package-lock.json`, which the
repo did not have. Committed, since a dependency change without a lockfile update
is incomplete. The rest of N13, meaning `npm ci` in the Dockerfile, a
`.dockerignore` and a non-root user, is still outstanding.

**Verification.** `npx tsc --noEmit --allowImportingTsExtensions` is clean. Docker
was not running on this machine, so the compose wiring has not been exercised
end to end. Worth confirming on a machine with a working daemon before relying on
it. Separately, this confirmed the N17 finding: `tsc` cannot run against this
repo as shipped, because every import uses a `.ts` extension and
`allowImportingTsExtensions` is missing from `tsconfig.json`.

---

## C2. Route handlers can no longer crash the process

**Problem.** No route had a `try`/`catch` and there was no error middleware.
Express 4 does not forward a rejected promise from an async handler, so any
database error escaped as an unhandledRejection, which Node 22 turns into an
uncaught exception and the process exits. One request with a title over 200
characters was enough to kill the server, and requests already in flight got no
response at all.

**Why this solution.** A `wrap` helper that catches the rejection and calls
`next`, applied to every async handler, plus a terminal error middleware. This is
what Express 5 does natively, so the wrapper is deletable on upgrade. The
alternative, a `try`/`catch` in each handler, repeats the same block five times
and gets forgotten on the sixth.

**Choices worth knowing about.**

- The error middleware echoes the message on 4xx and returns a fixed string on
  5xx. A 4xx describes the caller's own mistake; a 5xx can carry driver internals
  and filesystem paths. Full detail goes to the log either way.
- `res.headersSent` is checked first, because once a response has started the
  only correct move is to let Express abort it.
- Process-level handlers log and exit rather than continuing. Anything reaching
  them has escaped request scope, so the process state is not trustworthy. The
  compose restart policy takes it from there.

**Verification.** Ran an async handler that throws and a request with malformed
JSON against a local Express app using this middleware. The throw returns 500
`{"error":"internal error"}`, the malformed body returns 400 with the parser's
own message, neither response contains a stack or a path, and the process stays
up. This also removes most of SEC-6 in passing, though setting `NODE_ENV` is
still its own step (N4).

---

## C3. A dropped WebSocket client no longer kills the server

**Problem.** The connection handler listened for `message` and `close` but not
`error`. Node rethrows an `error` event that has no listener as an uncaught
exception, so one client dropping mid-frame, hitting a protocol violation or
resetting its socket took the whole process down. Sockets that error also never
emit `close`, so they leaked into the `clients` set and kept being selected for
broadcasts they could not deliver.

**Why this solution.** Listeners on both the server and each connection, which is
the only thing that stops the rethrow. The connection handler also removes the
socket from `clients` and terminates it, because the leak and the crash have the
same cause and fixing one without the other leaves a slow resource drain.

**Verification.** Sent a frame with reserved opcode 15 from a client. Against the
current hub the error is logged, the bad socket is dropped, a second healthy
client still receives a broadcast, and the process exits 0. Against a hub with no
error listener the same frame exits the process with code 1. Before and after both
observed rather than assumed.

---

## C4. Removed the message "signature"

**Problem.** Two separate faults in one line. It was not a signature: no secret,
and a salt hardcoded in the repo, so anyone could recompute it and it detected no
tampering. Nothing in the codebase ever verified it. It was also
`crypto.pbkdf2Sync` at 200,000 iterations on the request path, which blocks the
single event loop thread for 27 ms per message. During that window the process
serves nothing at all, which capped the entire server at roughly 37 messages per
second and made a flood trivially effective.

**Why this solution.** Deleted rather than replaced. The obvious alternative was
`createHmac` with a key from configuration, which would be a real MAC for
microseconds. I did not do that, because nothing reads the field and no
requirement asks for message integrity. Replacing an unused control with a
cheaper unused control is still carrying it. If integrity becomes a requirement
it is a small, well understood addition, and doing it then means keying and
verifying it properly rather than inheriting this shape.

**Choices worth knowing about.** Documents already in Mongo keep their old
`signature` field. It is inert and harmless, so no backfill.

**Verification.** Measured on this machine: 27.31 ms of blocked event loop per
message before, none after. The ceiling is now set by database round trips rather
than by CPU.

---

## C9. Indexes and foreign keys

**Problem.** The schema had no secondary indexes and no foreign keys. Four hot
queries scanned a whole table: last message per conversation, message count per
conversation, message history, and participant lookup by `user_id`, which could
not use the primary key because `user_id` is its second column. With three seed
rows this is invisible; at a hundred thousand messages the sidebar scans the
messages table twice per conversation.

**Why this solution.** Straight `ALTER TABLE` in migration 0002 rather than
folding the changes back into 0001, so an already-running database picks them up
too. That is the whole reason PRE-1 exists.

**Choices worth knowing about.**

- `(conversation_id, id)` rather than `(conversation_id)`. InnoDB appends the
  primary key to a secondary index, so the two are physically identical. The
  explicit form states the intent, which is filter then order.
- The unique index on `(conversation_id, client_id)` lands here rather than with
  N5, because it is a schema change and N5 is the application logic that uses it.
  MySQL does not treat NULLs as equal in a unique index, so the existing rows with
  a NULL `client_id` are unaffected.
- `ON DELETE CASCADE` where a child row is meaningless without its parent, but
  `RESTRICT` on `messages.sender_id`, so a user with history cannot be deleted out
  from under their own messages.

**Risk.** Adding foreign keys fails if existing rows already violate them, for
example a message pointing at a conversation id that was never created. Nothing
prevented that before, so a database with test traffic in it may need cleaning
before this migration applies. Seed data is consistent, so a fresh boot is fine.

**Not verified.** Docker is not available here, so this has not been run against a
live MySQL. It needs `npm run migrate` on a real instance before it is trusted.

---

## C6. Restarting no longer destroys message bodies

**Problem.** The seed ran `deleteMany({})` on `message_bodies` and reinserted only
the three demo documents, on every `docker compose up` rather than only on first
boot. The MySQL side was seeded only when the data directory was empty, so on a
restart with reused containers the message rows survived while their bodies were
wiped. Every message sent before the restart then rendered as an empty line,
permanently, and `bodyById.get(r.id) ?? ''` in the read path made that look like
an empty message rather than an error.

**Why this solution.** Three changes, because the bug had three parts.

- The seed upserts with `$setOnInsert` instead of wiping. A rerun touches nothing,
  and bodies written by real traffic are never in scope of the query.
- Named volumes for both MySQL and Mongo. Neither had one, so their lifecycles
  could drift apart, which is the condition that let one store keep rows whose
  counterpart in the other had gone.
- The read path reports a missing body as `null` and logs the offending ids,
  instead of coercing it to an empty string. The client renders "(message
  unavailable)" in grey. A silent empty string is what let this survive
  unnoticed.

**Choices worth knowing about.** `null` rather than omitting the message. The row
exists and the ordering matters, so hiding it would make the history quietly
wrong in a different way.

**Not verified.** The restart behaviour needs Docker to confirm end to end.

---

## C8. Dual write no longer leaves silent orphans

**Problem.** `createMessage` inserted the metadata row into MySQL and the body
into Mongo as two independent writes with no transaction and no compensation. If
the Mongo write failed the MySQL row was already committed, so the message
existed forever with no body, and the failure then escaped as an unhandled
rejection, which before C2 killed the process.

**Why this solution, and what it does not do.** The Mongo write is wrapped, and a
failure deletes the MySQL row before rethrowing. This is compensation, not
atomicity, and the code says so: the delete can itself fail, and a crash between
the two writes leaves the same orphan. What it buys is turning the common case
from silent corruption into a clean error the caller sees.

The plan also proposed reordering the writes so the body lands first. That is not
possible as the code stands, because the Mongo `_id` **is** the MySQL
`AUTO_INCREMENT` value, so the body cannot be written before the id exists.
Reordering requires application-generated ids, which is a much larger change:
message ids appear in the client, in the WebSocket payloads and in the keyset
pagination cursor added in N2, and keyset paging needs a sortable id, so it would
have to be ULID rather than UUIDv4. I have deliberately not done that here. It
belongs with the decision about whether the two-datastore split should exist at
all, which is still open.

**Also added.** `npm run reconcile` reports MySQL rows with no matching body. It
is read-only on purpose: choosing between deleting an orphan and restoring its
body is not a call a script should make unattended.

**Verification.** Typechecks. The failure path needs a live Mongo to exercise
properly, which is one of the things to try on a machine with Docker.

---

## C5. Stored XSS in the sidebar

**Problem.** `renderSidebar` built each list item with `innerHTML` and
interpolated the conversation title into it. The title is attacker-controlled:
`POST /api/conversations` accepted any string, and nothing encoded it on either
side. A conversation titled `<img src=x onerror=...>` executed in the browser of
every participant the moment their sidebar rendered. Since anyone could create a
conversation containing anyone, it was wormable.

**Why this solution.** Build the nodes with `createElement` and `textContent`,
which is what `appendMessage` a few lines below was already doing correctly. An
escaping helper would work too, but it leaves `innerHTML` in the file for the next
person to use without one.

Also added a server-side length bound on the title. It is defence in depth for
this, and it independently removes the input that used to crash the process
before C2.

**Verification.** Rendered the fixed node-building path in a DOM with
`<img src=x onerror=...>` as the title. Zero elements created from it; the payload
comes out as escaped text. The bytes are still there, visible as literal
characters, which is the correct outcome for a title someone chose.

**Related.** The message body was never vulnerable, and search results are not
either: both already use `textContent`. The title was the only `innerHTML` in the
file, and there is now none.

---

## Regression test suite

**Problem.** Fifteen commits of fixes, verified one at a time and mostly by hand.
Nothing stopped a later change from quietly reversing an earlier one, and the
brief asks for exactly that guarantee between steps.

**Why this solution.** The built-in `node:test` runner, driven by `tsx` for the
`.ts` sources, and no new dependency. The suite splits three ways:

- `test/unit/` — pure logic and in-process HTTP. `shapePage` (N2) walked across a
  125-row table and across new rows arriving mid-scroll; `buildConversationList`
  (N1); the `wrap`/`errorHandler` pair (C2) driven through a real Express app;
  the WebSocket hub (C3) driven through a real `ws` server, including an abrupt
  socket reset to prove the errored client leaves the broadcast set and the
  process survives. `test/unit/regression-guards.test.ts` holds the static checks
  for fixes whose regression is a source edit rather than a behaviour change
  (C4, C5, C6, C8, C9, N4, N6, PRE-1).
- `test/http/` — `createApp()` on an ephemeral port with no database: every
  validation path that returns before a query (N2 params, N5 `clientId` rules,
  the C2 over-long title), and the header assertions for N4 and N15.
- `test/db/` — the real thing against MySQL and Mongo. Live schema after
  migrations (C9 indexes, unique keys, foreign keys; N6 `DATETIME(3)`), the
  `createMessage` idempotency and timestamp guarantees (N5, N6), orphan
  detection (C8), seed idempotency including a body that stands in for real
  traffic (C6), migration idempotency (PRE-1), and the same guarantees again
  through the HTTP surface end to end.

**Choices worth knowing about.**

- `createApp()` was split out of `src/index.ts` so the app can be built without
  `waitForMysql()` / `connectMongo()` running at import time. `index.ts` is now
  just that plus the server, WebSocket and database wait.
- `attachWs` returns the `WebSocketServer` and exports `_clientCount()`. The
  broadcast set is module state; the test needs to see it shrink.
- The database suites probe MySQL and Mongo with a 2-second timeout and, if
  either is unreachable, mark the whole `describe` skipped rather than failing.
  `npm test` on a laptop with nothing running is green in about a second; CI with
  no services attached is the same. `npm run test:db` brings the stack up first
  and points `MYSQL_URL` / `MONGO_URL` at the published ports.
- `--test-force-exit`, because `src/db/mysql.ts` and `src/db/mongo.ts` hold open
  a pool and a client that no test owns or should close.
- `tsconfig.json` now includes `test/`, so `tsc --noEmit` covers the suite too.

**Verification.** Full run against the compose stack: 68 pass, 0 fail, `tsc`
clean. Run again with `MYSQL_URL` / `MONGO_URL` pointed at dead ports: the
`test/db/` suites report as skipped with the reason string, exit 0, no hang. The
compose smoke tests in the handoff were also walked by hand against a fresh
volume — migrate exits 0 before seed, a message body survives `docker compose
restart`, a repeated `clientId` returns 200 with `duplicate: true` and one row,
malformed JSON is a 400 with no stack, an `<img onerror>` title is stored as text
and rendered through `textContent`, and `npm run reconcile` finds no orphans.
