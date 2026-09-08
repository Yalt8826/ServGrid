# Phase 0 — Foundation

**Size M · ~3 weeks · Risk: low, except distribution**

The only phase with a free rollback, because nothing is live yet. Use that: every schema correction in this phase is a text edit to a file that has not run. After Phase 0 deploys, the same correction is an expand/contract cycle with a backfill and a dual-write (`PLAN-EXECUTION.md` Part I §1).

**What this phase proves:** that fourteen accounts can exist, log in on a real handset and on a laptop, that a push reaches a device, that a backup restores, and that the two lint rules and the permission matrix are enforced by CI rather than by memory.

**Read before starting:** `PLAN.md` in full, once. `PLAN-EXECUTION.md` Part I and Phase 0. `UI/plan-2/00-PHILOSOPHY.md` and `UI/plan-2/01-FOUNDATIONS.md`.

**The one thing that can end this phase.** If the signed APK will not sideload on a staff handset — MDM restriction, "install unknown apps" locked by an OEM, Play Protect refusing — the distribution decision in `PLAN.md` §2 collapses and there is no budgeted fallback. **T0.15 runs in week 1, not week 3.**

---

## Task graph

```
T0.1 repo ──┬── T0.2 db+migrations 001 ── T0.3 enums+identity ── T0.4 sync+reference
            │                                                          │
            ├── T0.5 packages/shared ──────────────────────────────────┤
            │        │                                                 │
            │        ├── T0.6 fastify skeleton ── T0.7 auth ── T0.8 employees ── T0.9 consent
            │        │                                │
            │        └── T0.10 rbac + matrix suites ──┘
            │
            ├── T0.11 app shell ── T0.12 tokens+primitives+gallery ── T0.13 NavShell
            │                                                              │
            │                                                    T0.14 login/pwd/consent
            │
            ├── T0.15 EAS + sideload + FCM        ← week 1, in parallel with everything
            └── T0.16 ops: VPS, backups, uptime
```

---

### T0.1 — Monorepo, tooling, CI

**Reads:** `PLAN.md` §2 · `PLAN-BACKEND.md` §2, §13 (CI) · `PLAN-EXECUTION.md` Phase 0 Ships
**Depends on:** —
**Parallel with:** —
**Flag:** —
**Tier:** free (nothing deployed)

**Build**

```
servgrid/
  package.json              workspaces: apps/*, packages/*
  pnpm-workspace.yaml
  .npmrc                    node-linker=hoisted
  tsconfig.base.json        strict: true, noUncheckedIndexedAccess: true
  .eslintrc.cjs             + three custom rules (below)
  .prettierrc
  .github/workflows/ci.yml
  docker-compose.yml        (T0.2)
  apps/api/                 (T0.6)
  apps/mobile/              (T0.11)
  packages/shared/          (T0.5)
```

**[impl] pnpm with `node-linker=hoisted`.** Expo's Metro resolver does not follow pnpm's symlinked `node_modules` reliably. Hoisted linking gives npm-shaped layout with pnpm's workspace ergonomics. Pin the package manager in `packageManager` so CI and every agent resolve identically.

**[impl] Node 22 LTS, TypeScript 5.x, `strict: true`.** Pin Node in `.nvmrc` and in the CI matrix. `noUncheckedIndexedAccess` is on because half this codebase indexes arrays returned from SQL.

**The three lint rules are the deliverable, not the config file.** From `PLAN-BACKEND.md` §13:

1. **No literal `#F2C200` outside `theme.ts`.** `no-restricted-syntax` on string literals matching the hex, case-insensitive.
2. **No `job_completions` or `service_contracts` in `apps/api/src/modules/**/repo.dispatcher.ts`.** The revenue-leak defence.
3. **No `location_pings` or `location_requests` in the same files.** The `location.health` / `location.read` split (`PLAN-BACKEND.md` §5).

CI on pull request, all required to merge: typecheck · lint · unit + integration against testcontainers Postgres · migration `up → down → up` on a clean database. On merge to `main`: build and push the API image, migrate staging, deploy staging. **EAS builds stay manual** — an APK is a decision, never a side effect of a merge.

**Tests**

- `.github/workflows/ci.yml` runs on a scratch PR.
- `packages/shared/src/__fixtures__/lint-violations/` — three files, one per rule, each expected to fail lint. A script asserts each produces exactly one error. **A lint rule with no failing fixture is a lint rule nobody has proven fires.**

**Done when**

- [ ] `pnpm install && pnpm typecheck && pnpm lint` clean from a fresh clone
- [ ] Each of the three lint rules **proven by deliberately breaking it once** and watching CI go red
- [ ] CI blocks merge on a failing test — proven the same way
- [ ] `pnpm -F mobile start` opens Metro; `pnpm -F api dev` starts and exits cleanly

**If it fails**
Metro failing to resolve a workspace package is the expected failure and it is `.npmrc`. Confirm `node-linker=hoisted`, delete `node_modules` and the pnpm store lock, reinstall. If Expo still cannot resolve `@servgrid/shared`, add it to `metro.config.js` `watchFolders` before reaching for a different package manager.

**Commits**
`chore(start): T0.1 monorepo and CI` → `chore(repo): monorepo, strict TS, three custom lint rules, CI gate`

---

### T0.2 — Database, migration runner, migration 001

**Reads:** `PLAN-DATA-MODEL.md` §1 (migration order), §2 (helpers) · `PLAN-BACKEND.md` §13 (deployment)
**Depends on:** T0.1
**Parallel with:** T0.5, T0.11
**Tier:** free

**Build**

`docker-compose.yml` — Postgres 16, MinIO, Caddy. One VPS in production; the compose file is the same shape locally.

`apps/api/src/db/` — `pool.ts` (single `pg.Pool`), `tx.ts` (`withTransaction`, `withAdvisoryLock`), `migrate.ts` (node-pg-migrate runner, plain SQL files, run on boot in dev and as a separate release step in prod).

**Migration 001 `extensions_and_helpers`:**

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Asia/Kolkata has had no transition since 1945 and none is proposed.
-- IMMUTABLE is technically a lie; it is what lets this appear in
-- generated columns and index expressions. The alternative is a
-- redundant column the application must remember to set.
CREATE FUNCTION business_date(ts timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE AS $$
    SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date
  $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger ...  -- sets updated_at, bumps version
```

The comment above `business_date` is required, not decorative — `PLAN-DATA-MODEL.md` §2 says to document the assumption in the migration.

**No ORM.** `pg` with hand-written SQL. The schema uses generated columns, partial indexes and `FULL OUTER JOIN` views that an ORM would fight or hide.

**Tests**

`apps/api/test/integration/migrations.test.ts`
- `up → down → up` on a clean database, no manual intervention
- `business_date('2026-03-14T20:30:00Z')` = `2026-03-15` (IST is +05:30, so a 20:30 UTC timestamp is next-day IST) — **the boundary case is the test**
- `touch_updated_at` bumps `version` and `updated_at` on a scratch table, and does not bump `version` when the caller already changed it

**Done when**
- [ ] `docker compose up` gives a reachable Postgres and MinIO
- [ ] Migration 001 runs, reverses and re-runs clean
- [ ] The IST boundary test passes for a timestamp on each side of midnight IST

**If it fails**
`git reset --hard <start-sha>`, `docker compose down -v`. Nothing else has run.

**Commits**
`chore(start): T0.2 database and migration runner` → `feat(db): compose stack, migration runner, migration 001 helpers`

---

### T0.3 — Migration 002 enums, 003 identity

**Reads:** `PLAN-DATA-MODEL.md` §2.1 (the enum catalogue — all 21, with values), §3.1 (identity tables)
**Depends on:** T0.2
**Parallel with:** T0.5
**Tier:** free

**Build**

**Migration 002 `enums`** — the eighteen types listed in §2.1 that are not contract types. Copy the values from the catalogue exactly; it is the authority and it exists because an earlier draft said "18 enum types" and listed none, which would have blocked an agent at the second file in the project.

Two of them are load-bearing rather than descriptive: `collection_mode` and `payment_mode` both decide whether money enters the cash reconciliation, because the expected-cash view filters on the literal `'cash'` in both. **A comment in the migration must say so** — adding a value that represents physical currency is the one enum change in this schema that is not automatically safe.

**Migration 003 `identity`** — `employees`, `refresh_tokens`, `devices`, `consents`, per §3.1. Note specifically:

- `employees.username citext UNIQUE`, shape-checked `^[a-z0-9._-]{3,32}$`, `must_change_password` defaults **true**
- `refresh_tokens.token_hash UNIQUE` (sha256 of the opaque token), with `replaced_by` self-FK for rotation
- `devices` — `UNIQUE (employee_id, install_id)`, carrying `fcm_token` and the four diagnostics (`location_permission`, `battery_opt_exempt`, `autostart_confirmed`, `notifications_enabled`). These are **not decoration**: without a per-handset record of which mitigations were completed, a "tracking stopped" report in Phase 5 is unfalsifiable.
- `consents` — `UNIQUE (employee_id, kind, version)`, `version` is a date string

Attach `touch_updated_at` to every mutable table here.

**Tests**

`apps/api/test/integration/schema-identity.test.ts`
- All 18 enum types exist with exactly the values in §2.1 — enumerate them from `pg_enum` and diff against a fixture array. **This catches a typo in a value, which is otherwise found by a 500 in Phase 3.**
- `username` rejects `AB` (too short), `has space`, `Ünicode`; accepts `ravi.k`
- Inserting a second `devices` row with the same `(employee_id, install_id)` raises unique violation
- `must_change_password` defaults true

**Done when**
- [ ] The enum diff test passes with all 18 present and no extras
- [ ] Identity tables round-trip an insert/update with `version` incrementing

**If it fails**
Reset and re-edit the migration in place. Nothing has run in any environment; this is the free window `PLAN-EXECUTION.md` Part I §1 describes.

**Commits**
`chore(start): T0.3 enums and identity` → `feat(db): migrations 002-003 — 18 enums, employees, tokens, devices, consents`

---

### T0.4 — Migration 004 sync plumbing, 005 reference data

**Reads:** `PLAN-DATA-MODEL.md` §3.9 (idempotency, sequences), §3.2 (reference data)
**Depends on:** T0.3
**Parallel with:** T0.5, T0.11
**Tier:** free

**Build**

**Migration 004 `sync_plumbing`:**

- `idempotency_keys` — PK `(employee_id, key)`, plus `endpoint`, `request_hash`, `response_status`, `response_body jsonb`, `locked_at`, `expires_at` default +30 days. Index `(expires_at)` for the nightly prune.
- `sequences` — `scope text PK`, `current_value bigint`. And `next_in_sequence(text)` exactly as written in §3.9: one atomic upsert, no explicit lock, no gap-free guarantee.

Format is `JC-2627-00042` where `2627` is FY 2026–27. Not a Postgres `SEQUENCE`, because the per-fiscal-year reset and the prefix live in the scope key.

**Migration 005 `reference_data`** — `companies`, `customers`, `products`, `services` per §3.2. Note:

- `companies.owner_rep_id` nullable → **NULL means a house account visible to every rep**. Case-insensitive unique name among active rows.
- `customers.latitude`/`longitude` paired: `CHECK ((latitude IS NULL) = (longitude IS NULL))`
- `customers.company_id` is a **context link only** — it creates no financial relationship
- Index `customers (phone)` and GIN on `to_tsvector(name)` for dispatcher search

**Tests**

`apps/api/test/integration/sequences.test.ts`
- **50 concurrent `next_in_sequence('job:2627')` calls produce 50 distinct values.** Run them as 50 parallel clients against the real pool, not sequentially.
- A scope that does not exist is created implicitly on first call and returns `1` — this is the fiscal-year rollover path (`PLAN-DATA-MODEL.md` open item 5) and it is untested anywhere else.

`apps/api/test/integration/schema-reference.test.ts`
- Two active companies with names differing only in case → unique violation; one inactive → allowed
- A customer with latitude and no longitude → check violation

**Done when**
- [ ] Zero duplicates across 50 concurrent allocations
- [ ] Implicit scope creation returns 1 and increments from there
- [ ] Migrations 001–005 run, reverse and re-run clean as a set

**If it fails**
Duplicate allocations mean the function was rewritten as `SELECT ... FOR UPDATE` plus `UPDATE`. Restore the single-statement `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` from §3.9 — the atomicity is the point.

**Commits**
`chore(start): T0.4 sync plumbing and reference data` → `feat(db): migrations 004-005 — idempotency, sequences, reference data`

---

### T0.5 — `packages/shared`

**Reads:** `PLAN-BACKEND.md` §3.1 (error codes), §5 (permissions), §6.1 (status machine), §3.2 (canonicalisation) · `PLAN.md` §5
**Depends on:** T0.1
**Parallel with:** T0.2–T0.4, T0.11
**Tier:** T1/T2 (imported by both sides)

> **Serial task.** One agent owns this file set for the whole phase. It is imported by the API and the app, and a concurrent edit to the permission matrix is a merge conflict in the one file that must not be wrong.

**Build**

```
packages/shared/src/
  domain/          entity types mirroring the schema
  schemas/         zod, request + response, per endpoint
  permissions.ts   Resource, Action, Scope, permit()
  status.ts        job status machine + canTransition()
  errors.ts        ErrorCode union, PingRejectCode union
  sequence.ts      number format + parser
  canonical.ts     canonicalJson() — sorted keys, for request_hash
  theme/           tokens (T0.12 fills these)
```

`permit(role, resource, action): Scope` over the matrix in `PLAN.md` §5. The `Resource` union is in `PLAN-BACKEND.md` §5 and includes both money splits — `job.money` / `contract.money` and `location.read` / `location.health`. Do not collapse either pair.

**Three rules the matrix does not carry**, enforced in services rather than here, but documented in this file so nobody re-derives them:

1. A technician's `job.money` is **write-once at completion, no read afterwards**.
2. Dispatcher job reads select from `v_job_cards_dispatcher`, contract reads from `v_contract_visits_dispatcher`.
3. Dispatchers cannot set `customers.company_id` — stripped server-side, not merely absent from the form.

`ErrorCode` is an **exhaustive union** so the client can switch on it. `PingRejectCode` is a *separate, smaller* union — per-ping outcomes are not error codes and never appear in an error envelope, because a rejected ping is a normal outcome of a batch that succeeded.

`canonicalJson()` lives here because client and server must agree on it byte for byte. Sorted keys, no whitespace, numbers in their shortest round-trip form.

**Tests**

`packages/shared/src/permissions.test.ts`
- **Table-driven over every `role × resource × action`** — 4 × 16 × 4 = 256 combinations (the `Resource` union in `PLAN-BACKEND.md` §5 has 16 entries; an earlier draft of this line said 17 × 4 = 272), each with an expected `Scope`. Enumerate exhaustively; a missing combination must fail, not default.
- `permit('dispatcher', 'job.money', 'read')` is `'none'` for every action
- `permit('technician', 'job.money', 'read')` is `'none'` but `'create'` is `'own'` — **the case that trips `MoneyGate`** (`UI/plan-2/03-COMPONENTS.md`)
- `permit('sales_rep', 'company', 'read')` is `'own'`, and `own` on company resolves to `owner_rep_id = actor OR owner_rep_id IS NULL`

`packages/shared/src/status.test.ts`
- Every legal transition from §6.1 accepted, including `en_route → assigned` (reassign) and `assigned → in_progress` (skipping en route)
- `in_progress → assigned` **refused** — reassigning someone who has started work
- Both terminal states accept nothing

`packages/shared/src/canonical.test.ts`
- Key order in the input does not change the output
- Nested objects and arrays are stable
- The same object serialised in Node and in Hermes produces the same sha256 — assert against a checked-in fixture hash

**Done when**
- [ ] 256 matrix combinations enumerated, zero defaults
- [ ] Status machine covers every row of §6.1 plus the three refusals
- [ ] Canonicalisation fixture hash matches

**If it fails**
A matrix test failing means the table or the doc is wrong. **Fix the doc first**, then the code — `PLAN.md` §5 is the source and a silent divergence here is how the UI and API drift apart, which is the exact failure `packages/shared` exists to prevent.

**Commits**
`chore(start): T0.5 shared package` → `feat(shared): permission matrix, status machine, error unions, canonical JSON`

---

### T0.6 — Fastify skeleton and cross-cutting plugins

**Reads:** `PLAN-BACKEND.md` §2 (layout), §3.1 (error envelope), §3.3 (request context), §3.4 (validation), §13 (config, observability)
**Depends on:** T0.2, T0.5
**Parallel with:** T0.11
**Tier:** T2

**Build**

`apps/api/src/` per the tree in §2. This task ships `server.ts`, `config.ts`, and the plugins **except** `auth`, `rbac` and `idempotency` (T0.7, T0.10, T1.3).

**`config.ts` — zod-parsed env, fails at boot, never at 3am.** `DATABASE_URL`, `JWT_SECRET`, `S3_*`, `FCM_SERVICE_ACCOUNT`, `WORK_WINDOW_START/END`, `PING_RETENTION_DAYS`, `LOG_LEVEL`. A missing variable throws before the server listens.

**`plugins/errors.ts` — one envelope shape, always:**

```jsonc
{ "error": { "code": "JOB_ALREADY_CLOSED",
             "message": "This job was cancelled by the office at 14:32.",
             "details": { "jobId": "…", "status": "cancelled" },
             "requestId": "01JB…" } }
```

`message` is **written for the technician holding the phone**, not for a log. It is the string the offline conflict banner shows verbatim (`UI/plan-2/03-COMPONENTS.md`, `Banner`), so it must say what happened, not what failed. Map zod failures to `422 VALIDATION_FAILED` with issues in `details.issues`.

**`plugins/request-context.ts`** — `requestId` (ULID), `actor`, `source` (`mobile | web | system`, from a header), `deviceId`. Into structured logs and into `job_events.source` later.

**Response validation in dev and staging only.** It is worth the cost: it is what catches a completion field accidentally reaching a dispatcher payload.

`pino` structured JSON with `requestId`. Slow-query log above 200ms. `/healthz` covering DB **and storage** reachability — storage matters because an attachment upload failing at 09:00 with a green health check is a bad morning.

**Tests**

`apps/api/test/integration/config.test.ts`
- **Boot with each required env var missing in turn** → fails loudly at boot with the variable named. Not at runtime.

`apps/api/test/integration/errors.test.ts`
- A thrown `AppError` produces the envelope with all four fields
- A zod failure produces `422 VALIDATION_FAILED` with populated `details.issues`
- An unhandled exception produces a `500` envelope with a `requestId` and **no stack trace in the body**

`apps/api/test/integration/health.test.ts`
- `/healthz` green with both up; **red when MinIO is stopped**, not just when Postgres is

**Done when**
- [ ] Every required env var proven to fail boot when absent
- [ ] `/healthz` goes red for a storage outage
- [ ] Response validation is active in `NODE_ENV=test`

**If it fails**
T2: redeploy the previous image. Nothing is deployed yet, so: reset to the start SHA.

**Commits**
`chore(start): T0.6 fastify skeleton` → `feat(api): server, boot-time config validation, error envelope, request context`

---

### T0.7 — Auth: login, rotation, reuse detection

**Reads:** `PLAN-BACKEND.md` §4 in full · `PLAN-DATA-MODEL.md` §3.1
**Depends on:** T0.3, T0.6
**Parallel with:** T0.11
**Tier:** T2

**Build**

`POST /v1/auth/login` — `{ username, password, device: { installId, platform, appVersion, osVersion, manufacturer, model } }`. Verify argon2id at **`m=19456, t=2, p=1`** (the OWASP baseline). Upsert the `devices` row. Issue tokens. Update `last_login_at`.

Returns `{ accessToken, refreshToken, employee, mustChangePassword, consent: { required, version } }`.

**Tokens.** Access JWT, HS256, **15 minutes**, claims `{ sub, role, deviceId, jti }`. Refresh opaque 256-bit random, sha256-stored, **60 days**, rotated on every use.

60 days is long on purpose. Field staff are offline for hours, and a technician re-entering a password on a 6" screen in the sun to clear a queued outbox is a failure of the design. The mitigation is rotation plus **reuse detection: presenting a revoked refresh token revokes the entire chain** and forces a fresh login.

**The 401 contract is a backend obligation, not just a client one.** The outbox drain treats `401 UNAUTHENTICATED` as "refresh, then retry once" — never as "drop the operation". The API must never return a body on 401 that a naive client would treat as terminal.

`POST /v1/auth/refresh`, `/logout`, `/password`, `GET /v1/auth/me` (actor, role, permissions snapshot, **feature flags**, consent state). Rate-limit login **5/min per username + IP**.

**Tests**

`apps/api/test/integration/auth.test.ts`
- Login with a good password issues both tokens and upserts exactly one `devices` row for a repeat `installId`
- **Refresh rotates**: old row gets `revoked_at` and `replaced_by`; the new token works
- **Replaying a revoked refresh token revokes the whole chain** and every descendant token stops working — this is the test that matters
- Password change revokes every refresh token for that employee
- 6 logins in a minute for one username → `429 RATE_LIMITED`
- An expired access token returns `401 UNAUTHENTICATED` with the standard envelope and **no `Clear-Site-Data`, no logout directive**

**Done when**
- [ ] Chain revocation proven with a three-deep rotation
- [ ] argon2id parameters asserted from the stored hash prefix
- [ ] 401 body carries nothing a client could read as terminal

**If it fails**
Reuse detection is the part most likely to be subtly wrong. If the chain does not fully revoke, walk `replaced_by` recursively in one `WITH RECURSIVE` statement rather than looping in JS — a partial revocation is worse than none because it looks like it worked.

**Commits**
`chore(start): T0.7 auth` → `feat(api): login, refresh rotation with reuse detection, password change`

---

### T0.8 — Employee administration and password recovery

**Reads:** `PLAN-BACKEND.md` §4.1 · `PLAN-EXECUTION.md` Phase 0 (Admin row)
**Depends on:** T0.7
**Parallel with:** T0.9
**Tier:** T2

**Build**

The six endpoints in §4.1. **`POST /v1/employees` is needed from Phase 0, not Phase 4** — the fourteen accounts have to exist before anyone can log in, and seeding them by hand into production is how a password ends up in a shell history. The owner-facing *screen* is Phase 4; the endpoint is now.

Owner only, except `GET /v1/employees/me`. No self-registration and no public surface at all.

**Deactivation preconditions are stubbed here and completed in Phase 4** — the three blocking conditions (open jobs, owned companies, unconfirmed cash) reference tables that do not exist yet. Ship the endpoint returning `409 EMPLOYEE_HAS_OPEN_WORK` with an empty `details` array and a `TODO` referencing T4.5. **Write the test now, skipped, with the reason in the skip message.**

**Password recovery — both answers, and both must be *exercised*, not merely written:**

1. **A second owner-role account**, created at go-live and held by one other trusted person. This is the real answer: an administrative control, not a feature, and it costs nothing.
2. **A break-glass CLI** — `apps/api/scripts/admin-reset-password.ts`, run as `pnpm -F api admin:reset-password -- --username <u>`. Requires shell access to the VPS. Prints a temporary password, sets `must_change_password`, revokes every token for the account, writes an audit row.

If the owner forgets his password and neither exists, nobody can reset it. There is no email and there is one owner.

**Tests**

`apps/api/test/authz/employees.test.ts`
- Every endpoint as every role: technician, dispatcher and rep get `403` on all but `GET /me`
- `GET /v1/employees/me` returns self and **never another employee's row**, including by id in the path

`apps/api/test/integration/break-glass.test.ts`
- The CLI resets a password, revokes tokens, and writes exactly one audit row
- Running it for a non-existent username exits non-zero and writes nothing

**Done when**
- [ ] Authorisation matrix green for all six endpoints × four roles
- [ ] **Break-glass CLI run once against staging and the audit row verified by hand**
- [ ] Second owner account created and handed over — this is a person-to-person step, tick it when it has actually happened

**If it fails**
An untested recovery path is the same class of belief as an untested backup, and this phase already refuses that one. Do not exit Phase 0 with this box unticked.

**Commits**
`chore(start): T0.8 employee admin` → `feat(api): owner-only employee CRUD, break-glass password reset CLI`

---

### T0.9 — Consent endpoints

**Reads:** `PLAN-BACKEND.md` §4 (consent endpoints) · `PLAN-DATA-MODEL.md` §3.1 · `PLAN.md` §7 · `UI/plan-2/08-SHARED-SCREENS.md` §X3
**Depends on:** T0.7
**Parallel with:** T0.8
**Tier:** T2

**Build**

`GET /v1/consents/required` — the kinds and versions this actor still owes.
`POST /v1/consents` — `{ kind, version, deviceId }`, inserts `(employee_id, kind, version, accepted_at, device_id, ip_address)`.

**The server records `ip_address` itself and ignores any the client sends.** This row is DPDP Act evidence, and evidence a client can author is not evidence.

`UNIQUE (employee_id, kind, version)` makes a double-tap free, so **no idempotency key is needed** here.

**Consent gates the location task, not the app.** A technician who has not accepted still sees his jobs; the background task is simply not started and his health chip reads `permission_missing`. A hard block at login makes the first thing a new employee meets an ultimatum, which is the opposite of what `PLAN.md` §7 says the screen is for; proceeding silently with tracking on would be worse, because it hides the refusal from everyone. Visible degradation, surfaced to both parties, is the only version that is honest in both directions.

Versions are the **date string of the copy revision**. Bump it for a change in what is being consented to, not for a typo fix — a bump makes all fourteen people re-accept.

**Tests**

`apps/api/test/integration/consent.test.ts`
- Posting the same `(kind, version)` twice is idempotent by constraint and returns the same result
- A client-supplied `ipAddress` field is **ignored**; the recorded value is the request's
- `GET /required` returns the current version for a technician who has accepted nothing, and empty after acceptance
- Bumping the version makes it required again for someone who accepted the previous one

**Done when**
- [ ] Version bump re-requires acceptance for all four roles that need it
- [ ] Client-supplied IP proven to be ignored

**If it fails**
Reset. This is a small, self-contained module.

**Commits**
`chore(start): T0.9 consent` → `feat(api): consent record and required-consent query`

---

### T0.10 — RBAC plugin and the authorisation suites

**Reads:** `PLAN-BACKEND.md` §5 in full · `PLAN.md` §5
**Depends on:** T0.5, T0.7
**Parallel with:** T0.11
**Tier:** T2

**Build**

`plugins/rbac.ts` — `req.can(resource, action)` plus scope resolution. **The plugin turns a scope into a SQL predicate**, so scoping is applied in the query, never by filtering in JavaScript after the fact. That distinction is the whole defence: a filter applied after a `SELECT` is a filter someone can forget in the next endpoint.

Scope predicates:

| Scope | Predicate |
|---|---|
| `all` | none |
| `own` | actor is author or owner — `sales_rep_id`, `received_by`, `employee_id`, `sold_by` |
| `own` on `company` | `owner_rep_id = :actor OR owner_rep_id IS NULL` |
| `assigned` | reachable *through* an assignment — a technician reads a customer because he has a job there |
| `none` | 403 before the query runs |

**Tests**

`apps/api/test/authz/matrix.test.ts` — **the suite that protects the revenue guarantee.** Every endpoint that exists so far, as every role, asserting 403 or 404 rather than assuming it. This suite grows in every subsequent phase and is never allowed to shrink.

`apps/api/test/authz/scope.test.ts`
- `own` on company includes house accounts (`owner_rep_id IS NULL`) for both reps
- `own` on company **excludes the other rep's accounts** — assert on rows returned, not on a count
- `assigned` on customer includes a site the technician has a *closed* job at, and excludes one he never had

**Done when**
- [ ] Every endpoint built so far appears in the authz suite
- [ ] Scope resolution produces SQL predicates — assert by inspecting the generated query text, not just the result set

**If it fails**
If a scope is being applied in JS, that is not a failing test to patch — it is the wrong shape. Move it into the predicate before continuing.

**Commits**
`chore(start): T0.10 rbac` → `feat(api): rbac plugin with SQL-predicate scoping, authorisation suite`

---

### T0.11 — Mobile app shell

**Reads:** `PLAN-FRONTEND.md` §2 (route tree), §4 (state layers), §5.1 (cold start) · `UI/plan-2/08-SHARED-SCREENS.md` §X1
**Depends on:** T0.1
**Parallel with:** T0.2–T0.10
**Tier:** **T3** — batch with T0.15

**Build**

Expo Router, the route tree in `PLAN-FRONTEND.md` §2 as empty screens. **One tree; roles differ in which routes are reachable, not in which files exist.**

**Pin the Expo SDK and never float it.** Reanimated must be the Expo-recommended version for that SDK — Reanimated 4 requires the New Architecture, which must be on from the first commit rather than migrated to later.

**`tokenStore` is a `.native.ts` / `.web.ts` pair behind one interface.** `expo-secure-store` is native-only and the owner's desktop build is the one surface that needs a token store without it. An agent who writes `SecureStore.getItemAsync` in shared code gets a web build that silently cannot log in — the symptom is a login that appears to succeed and bounces back on every reload.

**Session bootstrap never blocks on the network** (`PLAN-FRONTEND.md` §5.1). Read the stored actor and refresh token, route to the role's landing screen, render. No refresh call is awaited before first paint. An expired access token is refreshed lazily, on the first request that needs it — which for an offline role may be hours later.

**Only a `TOKEN_REUSED`, or a 401 on a refresh round trip that actually completed, logs anyone out.** A refresh that fails because there is no connection is a retry. Getting this backwards logs a technician out in a basement with a full outbox.

API client: `fetch` wrapper carrying `Idempotency-Key`, `X-Source`, `X-Device-Id`, with refresh-on-401 and retry-once.

TanStack Query v5. `staleTime` 30s for lists, 0 for a job detail being actively worked. Offline roles `networkMode: 'offlineFirst'`; online roles `'online'`, so a failed fetch surfaces immediately instead of hanging on a hopeful retry.

**Tests**

`apps/mobile/src/lib/tokenStore.test.ts` — native and web implementations satisfy the same contract test.

`apps/mobile/src/lib/apiClient.test.ts`
- 401 → one refresh → one retry → success
- 401 → refresh fails **with a network error** → the request is retried later and **the session survives**
- 401 → refresh returns `TOKEN_REUSED` → session cleared exactly once

`apps/mobile/e2e/cold-start-offline.yaml` — airplane mode, expired access token, app opens to the role's landing route. Runs properly in Phase 1 when there is a mirror to render; the flow is written here.

**Done when**
- [ ] `pnpm -F mobile start` renders the route tree on device and web
- [ ] Network-failed refresh proven not to log out
- [ ] New Architecture confirmed on: `expo config` shows it enabled

**If it fails**
T3. Anything wrong in `app.json`, the SDK pin or the Reanimated version needs a new APK. **Do not ship this alone at 5pm on a Friday** — batch it with T0.15.

**Commits**
`chore(start): T0.11 app shell` → `feat(mobile): expo router shell, platform-split token store, non-blocking session bootstrap`

---

### T0.12 — Design tokens, primitives, the component gallery

**Reads:** `UI/plan-2/01-FOUNDATIONS.md` in full · `UI/plan-2/02-MOTION.md` §1–3, §7, §8 · `UI/plan-2/03-COMPONENTS.md` (the eight states, primitives) · `UI/plan-2/08-SHARED-SCREENS.md` §X8
**Depends on:** T0.11
**Parallel with:** T0.6–T0.10
**Tier:** T1

**Build**

`packages/shared/theme/` — the complete token set from `UI/plan-2/01-FOUNDATIONS.md`: the slate scale **including `slate.400` `#7C8B9A`**, semantic aliases, status colours, type ramp, 4pt space scale, radii, the three density modes, elevation as **borders not shadows on Android**.

Fonts: IBM Plex Sans and IBM Plex Sans Condensed via `expo-font` behind the splash gate. **No text renders in a fallback face.**

Primitives, each in all eight states: `Button`, `TextField`, `MoneyField`, `Select`, `DatePicker`, `Sheet`, `Banner`, `Skeleton`, `Chip`, `EmptyState`, `ConfirmDialog`.

The eighth state is **`stale`** — showing local data the server has not confirmed. Treatment everywhere: a 2px `slate.400` dashed left inset plus a `caption` reading `Pending sync`. Never a spinner. Never greyed out; the data is real.

Motion tokens: the six durations, four easings, three springs. **Never a spring with damping below 15** — visible bounce reads as toy, and this is equipment. Haptic mapping from §8.

**The deliverable that makes everything after this enforceable is the gallery.** `apps/mobile/app/_dev/gallery.tsx`, reachable only in dev builds: every component, every state, at all three densities. Without it, `stale` and `error` get reinvented per screen and the app is four different products by Phase 4.

**Tests**

`packages/shared/theme/contrast.test.ts` — **compute every ratio, do not copy the table.** An earlier draft of the design docs carried approximations and every error ran in the flattering direction.

- `slate.900` on `surface` ≥ 7:1 (actual 16.16)
- `slate.500` on `surface` ≥ 4.5:1 (5.39) **and on `surfaceDense`** (4.98)
- `slate.400` on both ≥ 3:1 (3.43 / 3.17)
- `slate.900` on `accent` ≥ 7:1 (9.79)
- **White on `accent` < 2:1** — asserted as a *guard*, so nobody ever ships it (1.68)

`apps/mobile/src/components/ui/*.test.tsx` — each primitive renders in all eight states without throwing; `Button` disabled always renders an accompanying caption; `MoneyField` groups `100000` as `1,00,000` on blur and strips grouping while typing.

**Done when**
- [ ] Gallery renders every primitive × eight states × three densities
- [ ] Contrast suite computes and passes, with the measured values in the assertion messages
- [ ] Fonts gate the splash: no frame renders in a system face

**If it fails**
A contrast assertion failing means a token is wrong, not that the assertion is strict. `UI/plan-2/01-FOUNDATIONS.md` §1.5 carries the measured figures; do not soften a floor to make a test pass.

**Commits**
`chore(start): T0.12 tokens and primitives` → `feat(mobile): design tokens, eleven primitives in eight states, component gallery`

---

### T0.13 — NavShell, density provider, RoleGate

**Reads:** `PLAN-FRONTEND.md` §3 (the per-role group map) · `PLAN.md` §8 · `UI/plan-2/08-SHARED-SCREENS.md` §X6 · `UI/plan-2/01-FOUNDATIONS.md` §3.3
**Depends on:** T0.12, T0.5
**Parallel with:** T0.6–T0.10
**Tier:** T1

> **Serial task.** `NavShell` is one of the three files where a merge conflict is silent rather than textual.

**Build**

The **per-role** group map from `PLAN-FRONTEND.md` §3. This is a map per role, **not the owner's map filtered by permission** — filtering strands the technician's cash handover and the rep's contract list, both permitted, both routed, neither reachable, and neither failure raises anything.

Tab counts: **technician 4 · dispatcher 3 · sales rep 4 · owner 5.**

`NavShell` branches **once**, on `Platform.OS === 'web' && width >= 1024`. That branch appears exactly once in the codebase; screens never ask what platform they are on.

The same component sets **density** from role and platform — `field` / `console` / `desk` — exactly once. Screens never set density.

Active tab: **2px accent underline** above the label, sliding 220ms. Not a filled pill.

`<RoleGate>` in `(app)/_layout.tsx` reading `permit()`. A route the role cannot reach **redirects to that role's landing route** rather than rendering an error — a technician deep-linked to `/companies` lands on his jobs, not on a wall.

**Tests**

`apps/mobile/src/navigation/navmap.test.ts` — **the cross-check, and it runs in CI as a merge gate:**

- For every role, every route in that role's group map is permitted by `permit()`
- For every role, every route `permit()` allows has a tab that reaches it
- Technician's map contains `/cash/handover`; rep's contains `/contracts` **and** `/contracts/renewals`

A permitted route with no tab is unreachable; a tab to a forbidden route is a 403 the user tapped. Neither raises at runtime, which is why this is a build gate.

`apps/mobile/src/navigation/NavShell.test.tsx`
- Exactly one platform branch — assert by grepping the source for `Platform.OS` and requiring a single occurrence in this file and zero in `app/**/*.tsx`
- Density resolves to `field` for technician, `console` for dispatcher, `desk` for owner on web ≥1024

**Done when**
- [ ] Cross-check green in both directions for all four roles
- [ ] `Platform.OS` appears once in the mobile codebase
- [ ] Tab counts are 4 / 3 / 4 / 5

**If it fails**
If the cross-check fails, decide whether the map or the matrix is wrong by reading `PLAN.md` §8 — then fix the doc, then the code.

**Commits**
`chore(start): T0.13 navshell` → `feat(mobile): per-role nav map, single platform branch, density provider, RoleGate`

---

### T0.14 — Login, forced password change, consent

**Reads:** `UI/plan-2/08-SHARED-SCREENS.md` §X1–X3 · `PLAN-BACKEND.md` §4
**Depends on:** T0.13, T0.7, T0.9
**Parallel with:** —
**Tier:** T1

**Build**

**X1 Login.** Worst moment: first morning, a technician who has never used the app, a temporary password written on paper, standing in the yard.

- **Username, not email.** There is no email in the schema.
- **A visible password toggle, on by default for the first login.** Typing a temporary password blind on a 6" screen in the sun is a real failure, and the masking argument does not survive contact with a yard.
- **"Forgot your password? Ask the owner."** — the truthful instruction. A dead reset link that goes nowhere is worse than no link.
- On lockout: *"Too many attempts. Try again in 3 minutes."* — with the actual number.
- Error: *"Username or password is wrong."* **Never which one.**
- **No animation on arrival.** No animated logo, no fade-in sequence. The app opens and is usable.

**X2 Forced password change.** Not skippable, no back. Rules stated **before** typing, not as errors after.

**X3 Consent.** The highest-stakes copy in the product, and the screen that decides whether the app is experienced as something done *with* staff or *to* them.

- **State the limits before the capability.** The hours come before the tracking.
- The last sentence says plainly what is **not** collected. Volunteering that is what makes the rest credible.
- No legalese, no scroll-to-accept, no pre-ticked boxes.
- **No "Decline" button that logs the user out with no explanation.** It is not dismissible and there is no second button, but it gates the location task, not the app.

**Tests**

`apps/mobile/src/screens/login.test.tsx`
- Password visible by default; toggle flips it
- Wrong credentials render one banner and never name the field
- Offline renders *"No connection — sign-in needs one"* — this is the one place offline genuinely blocks

`apps/mobile/src/screens/consent.test.tsx`
- Renders the five limit lines before the capability paragraph
- No decline control exists in the tree
- Accept posts exactly one `POST /v1/consents` with the current version

**Done when**
- [ ] Cold start → login rendered in **under 2.5s** on the roster's slowest handset, measured
- [ ] Consent copy read aloud to an actual technician before it ships — `UI/plan-2/README.md` open question 5. **A person, not a review comment.**

**If it fails**
T1 republish. The consent copy is the item most likely to need a second pass; budget for it.

**Commits**
`chore(start): T0.14 auth screens` → `feat(mobile): login, forced password change, consent screen`

---

### T0.15 — Distribution and push, end to end

**Reads:** `PLAN.md` §2 (distribution) · `PLAN-EXECUTION.md` Phase 0 (the blocking item), Part III go/no-go · `PLAN-BACKEND.md` §12.1
**Depends on:** T0.11
**Parallel with:** everything
**Tier:** **T3**

> **Run this in week 1.** It is the only task in the phase that can invalidate the project's shape, and discovering it in Phase 5 is a project-level failure.

**Build**

EAS internal-distribution build producing a **signed APK that installs by sideload**. No Play Store means no background-location policy review, which is a real saving — and it means the install path is the risk.

**FCM Google project confirmed, and a data-only push delivered to a real handset end to end.** The thing to prove is not that an account exists but that a **data-only** message reaches a device and is handled by the app. That is the step that fails.

FCM moved from Phase 4 to Phase 0 because assignment notifications need it in Phase 2. Confirming it here costs an afternoon; discovering in Phase 2 that no Google account exists costs the phase.

**Tests**

Manual, on hardware, recorded:

- Sideload on a handset that has **never had the app** — a fresh install, not an upgrade
- Sideload on **one handset per OEM in the staff roster** (Xiaomi, Realme, Vivo, Oppo, OnePlus, whichever are present)
- A data-only push from the API's `fcm.ts` reaches the app's background handler and logs

**Done when**
- [ ] APK path proven end to end: EAS build → download link → install on a virgin handset
- [ ] **A data-only FCM push delivered to that handset and handled by the app**
- [ ] Install tested on at least one handset per OEM in the roster

**If it fails**
**Stop and re-plan distribution.** There is no budgeted fallback in `PLAN.md`. Raise it as a project-level decision the same day — not as a task blocker. Options to bring to that conversation: MDM-managed install, a Play Store internal testing track (which reintroduces the background-location review), or a per-device "install unknown apps" grant with the owner's authority.

**Commits**
`chore(start): T0.15 distribution and push` → `chore(ops): EAS internal distribution proven, FCM data-only push verified end to end`

---

### T0.16 — Environments, backups, alerting

**Reads:** `PLAN-BACKEND.md` §13 · `PLAN-EXECUTION.md` Part I §5 (environments), Phase 0 exit
**Depends on:** T0.6
**Parallel with:** T0.7–T0.14
**Tier:** T2

**Build**

Staging and production on one VPS, Docker Compose: Postgres 16, the API, MinIO, Caddy for TLS. 14 users and ~125k location rows a year do not need managed Kubernetes, and the operational surface of the simple version is something one person can hold in their head.

Separate DB and bucket for staging. **Production data is never copied to staging** — location trails are personal data about identifiable employees under the DPDP Act, and a staging database is not a place where consent extends. Staging is seeded from `fixtures/demo.sql`.

Nightly `pg_dump` plus WAL archiving to off-site object storage; MinIO bucket replicated.

**Alerting, and this is the whole story:** `/healthz` polled every five minutes by an external uptime checker, alerting the developer and the owner **by phone**. That plus the Phase 5 tracking-health sweep is all of it. At 14 users there is no on-call rota and there should not be one, but a silent API outage on a Tuesday morning stops the business. Naming the destination now stops Phase 5 discovering a gap and over-building in response.

Seed data: `seed/001_owner.sql`, `seed/002_services.sql`, `seed/003_products.sql`.

**Tests**

- **Take a backup and restore it into a scratch database.** An untested backup is a belief, not a backup.
- Stop the API; confirm the uptime checker alerts a phone within its interval.
- Confirm staging cannot reach the production bucket — a wrong `S3_BUCKET` should fail loudly, not silently write to production.

**Done when**
- [ ] `pg_dump` **restored into a scratch database successfully** — not just scheduled
- [ ] Uptime check alerts a real phone when the API is stopped
- [ ] Secrets in place: `JWT_SECRET`, S3 credentials, TLS, `FCM_SERVICE_ACCOUNT`

**If it fails**
A restore that does not verify is the failure this task exists to catch. Do not tick the box on a `pg_dump` that completed; tick it on a database you queried.

**Commits**
`chore(start): T0.16 environments and backups` → `chore(ops): staging and production, verified restore, uptime alerting`

---

## Phase 0 exit

All of `PLAN-EXECUTION.md` Phase 0's exit criteria, plus the task boxes above. The ones that are person-shaped rather than code-shaped, restated because they are the ones that get skipped:

- [ ] An owner account logs in on a physical Android device **and** on desktop web
- [ ] Backup **restored** into a scratch database
- [ ] APK installs on a handset that has never had it
- [ ] A data-only FCM push handled by the app
- [ ] **Second owner account created and handed to a person**
- [ ] **Break-glass reset run once and the audit row read**
- [ ] CI blocks a merge on: a failing test, any of the three lint rules, a nav-map/matrix disagreement, a failing down-migration — **each proven by deliberately breaking it once**
- [ ] Uptime check alerts a phone

**Descope:** nothing here is optional. Every item is load-bearing.

**Rollback:** T2 for the API. For everything else, revert the branch and drop the database. There is no production data and no installed app. **This is the last time that is true**, and it is why both gap passes ran before this phase rather than after.
