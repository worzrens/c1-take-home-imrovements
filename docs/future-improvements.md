# What I'd do next

Everything I found and chose not to do, roughly in the order I'd pick it up.
Nothing here is a surprise: each one was a deliberate stop, either because it was
out of scope or because it wanted more thought than the time allowed.

The `N` ids match [`notes.md`](notes.md) and the original review.

---

## First, if this were going anywhere real

**Validate input at the route boundary (N3).** Validation today is ad hoc, a few
length checks written where a bug demanded one. It wants a schema library at the
edge of every route and a single error shape behind it: title and body with real
bounds, `clientId` capped, `participantIds` as a non-empty array of positive
integers with a maximum, ids rejected if they are floats or infinite. The
`express.json()` limit is still the 100 KB default and should probably come down.

The reason this is first is that most of the bugs I fixed were a missing bound
somewhere, and right now nothing stops the next one.

**Stop exposing the datastores (N14).** MySQL and Mongo both publish their ports
to the host, MySQL runs as `root` with the password in the compose file, and
Mongo has no authentication at all. Fine on a laptop, indefensible anywhere else.
Bind the ports to loopback or drop them, create a non-root MySQL user for the
app, turn Mongo auth on.

The config also still falls back to `mysql://root:root@mysql` when `MYSQL_URL` is
missing. `JWT_SECRET` already fails fast at boot with a length check; every other
variable should be validated the same way rather than defaulting into a
misconfiguration that only shows up later.

**Container hygiene (N13).** The Dockerfile runs `npm install` rather than
`npm ci`, copies the whole repo with no `.dockerignore` — so `.git` and `.env` go
into the image — ships dev dependencies, and runs as root. A multi-stage build
with a non-root `USER` fixes all of it. The compose file also bind-mounts the
whole repo over the image, which is a development convenience living in the
default path; it belongs in an override file.

The lockfile is committed, at least. It wasn't when I started.

---

## Keeping the sockets honest

**WebSocket liveness (N8).** This is the gap I'm least comfortable leaving. There
is no ping, no `isAlive` tracking and no client reconnect, so a socket that dies
quietly stays in the broadcast set and the user simply stops receiving messages
with no indication anything is wrong. Envoy's idle timeout will also close a
quiet connection.

It needs `stream_idle_timeout: 0s` on the proxy, a server-side ping interval that
terminates sockets that stop answering, exponential-backoff reconnect on the
client, and a refetch on reconnect to close the gap of missed messages. A
connection-state indicator in the UI, too, since right now a dead socket and an
idle room look identical.

Two things make this worse than it sounds. Under multiple instances a dropped
socket used to just mean one sad tab; now it means a user silently missing
messages other people can see. And constant typing traffic keeps the idle timer
alive, so the failure will show up mainly for the people who are only reading.

**Stale subscriptions (N10).** The client sends its subscription list once, at
connect. Create a conversation and it will not appear until a reload, because the
socket has no idea it exists. Either send an incremental subscribe whenever the
known set changes, or give each user their own channel so membership changes push
themselves.

---

## Operability

**Graceful shutdown and health checks (N16).** `SIGTERM` currently kills the
process mid-request. It should stop accepting connections, drain what is in
flight, then close the MySQL pool, the Mongo client and Redis. There is also no
`GET /healthz`, so compose has no healthcheck for the API and Envoy has no way to
route around an instance that is up but broken. That last part matters more now
that there are three of them.

**Types and CI (N17).** `conversations.js` and `messages.js` are still JavaScript,
so the two files with the most logic in them are the two the type checker cannot
see. `pool.query` results are implicit `any` throughout. Converting them and
typing the row shapes is mechanical work I ran out of appetite for.

There is also no CI. The typecheck and the test suite both exist and both pass;
nothing runs them on push. The database suites already skip cleanly when nothing
is listening, so a workflow with no services attached would still be useful.

---

## Product gaps

**Unread state (N19).** The unread flag is computed in the browser and forgotten
on reload, so it means nothing. It wants `last_read_message_id` on the
participant row, an endpoint to mark a conversation read, and the count computed
server-side in the conversation list.

**Search pagination.** Search returns a flat top-N with no cursor. Message history
got keyset pagination in N2 and search should use the same shape, otherwise the
one endpoint most likely to match thousands of rows is also the only one with no
way to page through them. Highlighting would help too.

---

## One thing I'd want to talk about

**Whether the MySQL-plus-Mongo split should exist at all.**

It is the root cause of three separate bugs I fixed. C6 was the two stores
drifting apart on restart. C8 is a dual write with no transaction across it,
which I could only compensate for, not solve. The `_id` coupling — Mongo's
document id *is* MySQL's auto-increment value — is why the body cannot be written
first, and unpicking that changes the id type in the client, the socket payloads
and the pagination cursor.

The split buys full-text search. MySQL 8 has `FULLTEXT` indexes, which would
cover what this app actually does with search today. So the honest question is
whether the second datastore is earning its keep, and my instinct is that it is
not.

I did not act on that. It is a big change, it is reversible in neither direction
cheaply, and it is exactly the kind of decision that should be made by whoever
owns the roadmap rather than by whoever happened to be reading the code. But it
is the single highest-leverage thing on this list, and every workaround above it
gets cheaper if the answer is "collapse it".
