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
