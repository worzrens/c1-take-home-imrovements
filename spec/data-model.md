# Data model

Three stores. The split between the first two is inherited rather than chosen,
and it is the root cause of more than one bug in this codebase, so it is worth
being explicit about what lives where.

| Store | Holds | Why |
| --- | --- | --- |
| MySQL | users, conversations, participants, message **metadata** | relational integrity and ordering |
| Mongo | message **bodies** | text search |
| Redis | sessions, rate-limit windows, real-time fan-out | shared across instances, all of it expiring |

## MySQL

Schema is owned by `migrations/`, applied by Umzug and recorded in a
`_migrations` table. It is the single source of truth: there is no init script,
because a file mounted into `/docker-entrypoint-initdb.d` only runs on an empty
data directory, so every later change silently did nothing on an existing
container.

```
users                        id, name, email (unique), password_hash
conversations                id, title, created_at DATETIME(3)
conversation_participants     conversation_id, user_id            PK (both)
messages                     id, conversation_id, sender_id, client_id, created_at DATETIME(3)
```

Indexes and constraints, all added in `0002`:

- `messages (conversation_id, id)` — every read filters by conversation and
  orders by id. Without it the sidebar scanned the whole table twice per
  conversation.
- `messages (conversation_id, client_id)` **unique** — what makes `clientId` an
  idempotency key rather than a comment. NULLs are not equal to each other in a
  MySQL unique index, so pre-existing rows are unaffected.
- `conversation_participants (user_id)` — membership lookups could not use the
  primary key, since `user_id` is its second column.
- `users (email)` unique.
- Foreign keys: messages and participants cascade from their conversation;
  `sender_id` restricts, so a user with history cannot silently vanish.

`created_at` is `DATETIME(3)`. It was `TIMESTAMP`, which has second granularity —
two messages in the same second were indistinguishable by time — and stops
working in 2038.

`password_hash` is nullable. An account with no hash cannot log in, and the login
route treats that identically to a wrong password. A `NOT NULL` column with a
default would have given every legacy row the same fake credential.

## Mongo

One collection, `message_bodies`, keyed by the MySQL message id:

```json
{ "_id": 302, "conversationId": 1, "senderId": 1, "body": "…", "createdAt": "…" }
```

Indexes are created at boot from code, since Mongo has no migration story here.
`createIndex` is idempotent, so it is safe on every start and every instance:

- a text index on `body` — what makes search possible
- `(conversationId, _id)` — for the search filter and the body lookups

### The write is not atomic

A message write touches both stores and no transaction spans them. The MySQL row
commits first; if the Mongo insert then fails, the row is deleted to compensate.

This is compensation, not atomicity. The delete can itself fail, and a crash
between the two leaves the same orphan. It converts the common case from silent
corruption into a clean error, which is the most this shape allows without a
transactional outbox or a single datastore.

Two things exist because of that honesty:

- a missing body reads as `body: null` from the API and
  "(message unavailable)" in the UI, never as an empty string
- `npm run reconcile` lists MySQL rows with no body in Mongo. Read-only —
  whether to delete an orphan or restore it is not a call a script should make.

## Redis

Everything here is keyed, expiring, and shared by every instance. Nothing in it
is a source of truth; losing it logs everyone out and resets the rate limits,
which is survivable.

| Key | TTL | Purpose |
| --- | --- | --- |
| `refresh:<token>` | 14 days | opaque refresh tokens. Deleting one revokes it. |
| `revoked:<jti>` | token's remaining life | logout deny list. Expires exactly when the token would have anyway, so the list stays bounded without a sweep. |
| `rl:send:<userId>:<conversationId>` | window + 1s | sorted set of send timestamps |
| `relay:events` | — | pub/sub channel for message and typing fan-out |

## Seeding

`docker/db/seed.ts` covers both MySQL and Mongo, and is idempotent — `INSERT
IGNORE` on one side, upsert with `$setOnInsert` on the other.

That matters more than it sounds. The seed used to `deleteMany({})` the bodies on
every boot while MySQL, seeded only on an empty data directory, kept its rows. A
restart therefore destroyed the body of every message ever sent while leaving the
rows in place, and the read path's `?? ''` rendered the result as a blank line.
One script covering both stores with the same lifecycle is what removes the
cause rather than the symptom.
