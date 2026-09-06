# Backend — Implementation Plan

Companion to `PLAN.md` §2, §5, §6, §7. Covers `apps/api` (Fastify + Postgres) and `packages/shared`.

The API's job description, stated once: **the app never talks to the database directly.** Role scoping, derived balances, sequence allocation and idempotency all live here, where they can be trusted. Everything below is in service of that sentence.

---

## 1. Build order

| Phase | Backend deliverable | Unblocks |
|---|---|---|
| 0 | Fastify skeleton, config, pg pool, migrations 001–005, error envelope, auth, `packages/shared` permission matrix + zod schemas | everything |
| 1 | Jobs module, completion/cancellation, `job_events`, idempotency plugin, sync bootstrap/delta/batch, location ingest, attachments, cash handover declare | Technician app |
| 2 | Dispatcher job queries against `v_job_cards_dispatcher`, assignment + bulk reassign, `v_technician_load`, customer CRUD | Dispatcher app |
| 3 | Companies, sales cards + items, payments, `v_company_balances`, company ledger | Sales Rep app |
| 4 | Cash reconciliation queue + confirm/dispute, location console queries, on-demand FCM requests, employee admin, owner dashboards | Owner app |
| 5 | Tracking-health sweep + alerting, retention jobs, DB role hardening, load sanity | Hardening |

Phase 1 is deliberately the largest. Idempotency, the sync protocol and location ingest are the three pieces that are painful to retrofit, and Phase 1 is the only phase where the surface is small enough to get them right.

---

## 2. Layout

```
apps/api/src/
  server.ts               fastify instance, plugin registration, graceful shutdown
  config.ts               env parsing via zod — fails loudly at boot, never at 3am
  db/
    pool.ts               pg.Pool, single instance
    tx.ts                 withTransaction(fn), withAdvisoryLock(key, fn)
    migrate.ts            node-pg-migrate runner
  plugins/
    request-context.ts    request id, actor, source (mobile|web), device id
    auth.ts               JWT verify, attaches req.actor
    rbac.ts               req.can(resource, action) + scope resolution
    idempotency.ts        Idempotency-Key interception
    errors.ts             error envelope + zod → 422 mapping
    audit.ts              writes job_events / generic audit rows
  modules/
    auth/       employees/   customers/   products/   services/
    jobs/       sales/       payments/    companies/  cash/
    location/   devices/     attachments/ sync/       dashboard/
  lib/
    sequences.ts          allocateNumber('job' | 'sale' | 'payment')
    time.ts               IST business date, work-window predicate
    storage.ts            S3-compatible put/get/sign
    fcm.ts                data-only push
    password.ts           argon2id hash/verify
  jobs/                   scheduled background tasks
```

Each module is `routes.ts` (HTTP + zod), `service.ts` (business rules, transactions), `repo.ts` (SQL). No ORM — the schema uses generated columns, partial indexes and `FULL OUTER JOIN` views that an ORM would either fight or hide. `pg` with tagged SQL, and every query written by hand.

`packages/shared` exports: domain types, zod schemas (request + response), the permission matrix, the job status machine, error codes, and the sequence-number format. Both sides import it, so role logic cannot drift between UI and API.

---

## 3. Cross-cutting plugins

### 3.1 Error envelope

One shape, always:

```jsonc
{ "error": { "code": "JOB_ALREADY_CLOSED",
             "message": "This job was cancelled by the office at 14:32.",
             "details": { "jobId": "…", "status": "cancelled" },
             "requestId": "01JB…" } }
```

`message` is written for the technician holding the phone, not for a log. It is the string the offline conflict banner shows verbatim, so it must be plain and must say *what happened*, not *what failed*.

Codes are an exhaustive union in `packages/shared`, so the client can switch on them:

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing/expired access token |
| `TOKEN_REUSED` | 401 | revoked refresh token replayed — whole chain revoked |
| `FORBIDDEN` | 403 | role lacks the permission |
| `OUT_OF_SCOPE` | 403 | role has the permission but not for this row |
| `NOT_FOUND` | 404 | |
| `VERSION_CONFLICT` | 409 | `If-Match` version stale |
| `ILLEGAL_TRANSITION` | 409 | status machine refused |
| `JOB_ALREADY_CLOSED` | 409 | completed/cancelled while client was offline |
| `IDEMPOTENCY_IN_FLIGHT` | 409 | same key still processing |
| `IDEMPOTENCY_KEY_REUSED` | 422 | same key, different body |
| `VALIDATION_FAILED` | 422 | zod issues in `details.issues` |
| `PING_OUT_OF_WINDOW` | 200* | per-ping outcome, not a request failure |
| `RATE_LIMITED` | 429 | |

### 3.2 Idempotency

Every `POST`/`PATCH`/`DELETE` from a mobile client sends `Idempotency-Key: <uuid>`. The plugin wraps the handler:

1. `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at) … ON CONFLICT DO NOTHING`.
2. Insert won: run the handler inside a transaction, store `response_status` + `response_body`, clear `locked_at`, return.
3. Insert lost, stored row has a response, `request_hash` matches: **replay the stored response verbatim.** Same status, same body. This is the reconnect case and must be indistinguishable from the original.
4. Insert lost, `request_hash` differs: `422 IDEMPOTENCY_KEY_REUSED`. A client bug, and the one case where silently replaying would be actively wrong.
5. Insert lost, `locked_at` set and recent: `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 2`.

The key row and the business rows commit in the same transaction. If they did not, a crash between them would either lose the guard or record a response for work that rolled back.

`request_hash` is sha256 of the body canonicalised with sorted keys — the client and server must agree on canonicalisation, so it lives in `packages/shared`.

### 3.3 Request context and audit

Every request carries `requestId` (ULID), `actor` (`{id, role}`), `source` (`mobile | web | system`, from a header) and `deviceId`. Written into structured logs and into `job_events.source`. The audit plugin exposes `req.recordJobEvent(...)` so a service never has to remember the actor.

### 3.4 Validation

zod schemas from `packages/shared` on both request body and response. Response validation runs in dev and staging only, and it is worth the cost: it is what catches a completion field accidentally reaching a dispatcher payload.

---

## 4. Auth

**Login** — `POST /v1/auth/login` with `{ username, password, device: { installId, platform, appVersion, osVersion, manufacturer, model } }`. Verifies argon2id (`m=19456, t=2, p=1` — the OWASP baseline), upserts the `devices` row, issues tokens, updates `last_login_at`.

Returns `{ accessToken, refreshToken, employee, mustChangePassword, consent: { required, version } }`.

**Tokens** — access JWT, HS256, **15 minutes**, claims `{ sub, role, deviceId, jti }`. Refresh token opaque 256-bit random, sha256-stored, **60 days**, rotated on every use.

60 days is long on purpose. Field staff are offline for hours, and a technician re-entering a password on a 6" screen in the sun to clear a queued outbox is a failure of the design, not of the technician. The mitigation for the long window is rotation plus reuse detection: presenting a revoked refresh token revokes the entire chain and forces a fresh login.

**Offline interaction.** The outbox drain treats `401 UNAUTHENTICATED` as "refresh, then retry once" — never as "drop the operation". If the refresh also fails, the queue *stays queued* and the UI shows a re-login prompt without discarding a single pending item. This rule is stated here because it is a backend contract as much as a client one: the API must never return a body on 401 that a naive client would treat as a terminal rejection.

**Password change** — `POST /v1/auth/password` for self; `POST /v1/employees/:id/password` for the owner resetting someone. Both revoke every refresh token for that employee.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/login` | rate-limited 5/min per username + IP |
| POST | `/v1/auth/refresh` | rotation + reuse detection |
| POST | `/v1/auth/logout` | revokes the presented refresh token |
| POST | `/v1/auth/password` | self-service change |
| GET | `/v1/auth/me` | actor, role, permissions snapshot, consent state |

---

## 5. Permissions

The matrix in `PLAN.md` §5, expressed once in `packages/shared` and imported by both sides.

```ts
type Resource =
  | 'job' | 'job.money' | 'job.assign'
  | 'customer' | 'customer.stack'
  | 'company' | 'sale' | 'payment'
  | 'cash.declare' | 'cash.confirm'
  | 'employee' | 'location.read' | 'location.send';

type Action = 'read' | 'create' | 'update' | 'delete';
type Scope  = 'all' | 'own' | 'assigned' | 'none';

function permit(role: Role, resource: Resource, action: Action): Scope;
```

Three scopes beyond all/none, and the distinction matters:

- `own` — rows where the actor is the author or owner (`sales_rep_id`, `received_by`, `technician_id`).
- `assigned` — rows reachable *through* an assignment. A technician reads a customer not because he created it but because he has a job there.

The `rbac` plugin turns a scope into a SQL predicate, so scoping is applied in the query, never by filtering in JavaScript after the fact.

**Two rules the matrix alone does not capture, enforced in the services:**

1. `job.money` for a technician is **write-once at completion, no read afterwards**. He submits `cost` and `discount_amount`; the job detail he sees after completion shows the work summary and collection mode but not a revenue figure. The completion he submitted is his own record, not a report.
2. Dispatcher job reads select from `v_job_cards_dispatcher`. Not a habit — a lint rule (`no-restricted-syntax` on `job_completions` inside `modules/jobs/repo.dispatcher.ts`) plus the optional DB grant in `PLAN-DATA-MODEL.md` §7.

**Permission tests are the highest-value tests in the codebase.** A table-driven suite iterates all `role × resource × action` combinations against the matrix, and a second suite hits every endpoint as every role asserting 403/404. That second suite is what actually protects the revenue guarantee; the first only protects the table.

---

## 6. Jobs module

### 6.1 Status machine

Defined in `packages/shared` so client and server agree on what is legal before a request is made.

| From | To | Who |
|---|---|---|
| `unassigned` | `assigned` | dispatcher, owner |
| `assigned` | `en_route`, `in_progress` | assigned technician, owner |
| `assigned` | `assigned` (reassign) | dispatcher, owner |
| `en_route` | `in_progress` | assigned technician, owner |
| `in_progress` | `completed` | assigned technician, owner |
| any non-terminal | `cancelled` | dispatcher, owner; technician with a reason |
| `completed`, `cancelled` | — | terminal |

`en_route` is skippable — a technician already on site should not have to lie to the app to start work.

**The transition that matters** is the one `PLAN.md` §6 names: a technician completes a job offline that the office cancelled while he was underground. The server rejects with `409 JOB_ALREADY_CLOSED` and a message naming who cancelled it and when. The client keeps the local record and shows a banner. **No silent overwrite in either direction** — the server does not accept it, and it does not delete the technician's work either. The rejected completion stays in the outbox as `rejected` and is inspectable.

### 6.2 Completion

`POST /v1/jobs/:id/complete` is a single transaction:

1. Lock the job row (`SELECT … FOR UPDATE`), assert status `in_progress` (or `assigned`/`en_route` — completing straight from assigned is legal), assert actor is `assigned_to` or owner.
2. Insert `job_completions`. Database constraints enforce the discount rule; the service does not re-implement them, it maps the constraint violation to a readable 422.
3. Update `job_cards` → `completed`, `closed_at`.
4. Insert `job_events` (`completed`, with `occurred_at` from the client's `completedAt`, `recorded_at = now()`).
5. Optional: upsert `customer_products` rows from `stackChanges[]` in the same transaction, each stamped `source_job_id`.
6. Attachments arrive as separate requests and reference the job id; a completion is valid without them.

The client sends `completedAt` from the device clock. The server accepts it but clamps it: not in the future, not more than 14 days old. Both bounds recorded in `job_events.payload` when clamping occurs.

### 6.3 Endpoints

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/v1/jobs` | all | role-scoped; filters `status[]`, `technicianId`, `customerId`, `from`, `to`, `q`; cursor paginated |
| POST | `/v1/jobs` | dispatcher, owner | allocates `job_number` |
| GET | `/v1/jobs/:id` | scoped | response shape differs by role — see below |
| PATCH | `/v1/jobs/:id` | dispatcher, owner | `If-Match: version` |
| POST | `/v1/jobs/:id/assign` | dispatcher, owner | `{ technicianId }` |
| POST | `/v1/jobs/bulk-assign` | dispatcher, owner | `{ jobIds[], technicianId }`, one transaction, partial results |
| POST | `/v1/jobs/:id/status` | technician (own), owner | `{ to, occurredAt }` |
| POST | `/v1/jobs/:id/complete` | technician (own), owner | idempotent |
| POST | `/v1/jobs/:id/cancel` | dispatcher, owner, technician (own) | |
| GET | `/v1/jobs/:id/events` | dispatcher, owner | timeline |
| GET | `/v1/technicians/load` | dispatcher, owner | `v_technician_load` for the picker |

**Response shape by role** is enforced by three separate zod response schemas — `JobCardTechnician`, `JobCardDispatcher`, `JobCardOwner` — not by one schema with optional fields. An optional field is a field that can leak; a separate schema cannot.

---

## 7. Sync protocol

Three endpoints. Technician and sales rep only; dispatcher and owner use the normal REST surface online.

**`GET /v1/sync/bootstrap`** — the full role-scoped working set for a cold start: the actor's open and recently-closed jobs, the customers those jobs touch and their product stacks, active products and services, and (for a rep) his companies with balances. Returns `{ data: {...}, cursor: "<iso8601>" }`. Bounded by design — a technician's set is tens of rows, not the whole database.

**`GET /v1/sync/delta?cursor=`** — everything in that same scope with `updated_at > cursor`, plus tombstones (rows now `is_active = false`), plus a new cursor. Server caps the page and returns `hasMore` so a client that has been offline a fortnight pages rather than times out.

The cursor is the server's `updated_at`, never the device clock. A device with a skewed clock must not be able to skip records.

**`POST /v1/sync/batch`** — the outbox drain.

```jsonc
{ "operations": [
  { "localId": "l_01",  "idempotencyKey": "…", "method": "POST",
    "path": "/v1/jobs/{id}/status", "body": { "to": "in_progress", "occurredAt": "…" } },
  { "localId": "l_02",  "dependsOn": "l_01", "idempotencyKey": "…", "method": "POST",
    "path": "/v1/jobs/{id}/complete", "body": { … } }
] }
```

Semantics, each chosen against a specific failure:

- **Ordered, not atomic.** Operations apply in array order, each in its own transaction. One rejection must not roll back a day's other work.
- **`dependsOn` short-circuits.** If `l_01` is rejected, `l_02` is returned `skipped` without being attempted. Without this, a rejected status change is followed by a completion that fails for a confusing second reason.
- **Per-operation results.** `{ localId, outcome: 'applied' | 'duplicate' | 'rejected' | 'skipped', status, body?, error? }`. `duplicate` is a success — it means the idempotency layer replayed, and the client should mark the item done.
- **Batch cap 50.** Larger queues page.
- **Always HTTP 200** if the envelope parsed. A 4xx on the batch itself means the envelope was malformed, which is a client bug; individual failures live in the results array.

The client drains, then immediately calls `delta` with the cursor from the batch response, so the local mirror reflects server-assigned job numbers and any server-side changes in one round trip.

---

## 8. Location pipeline

`PLAN.md` §7 calls this the highest-risk part of the build. The backend's share of that risk is small but non-negotiable.

**`POST /v1/location/pings`** — batch of up to 200, buffered on device.

Per-ping server-side validation:

1. **Work window: 09:00–19:00 IST, Monday–Saturday**, evaluated against `recorded_at`. The device already filters; the server checks again, because *a rule governing staff should not trust the device clock.*
2. `recorded_at` not in the future beyond 5 minutes of skew, not older than 7 days.
3. Coordinate ranges; `accuracy_m` above 2000 recorded but flagged.
4. `ON CONFLICT (employee_id, recorded_at) DO NOTHING` — a retried batch is free.

Response is per-ping: `{ accepted: n, rejected: [{ index, code }] }` with codes `OUT_OF_WINDOW`, `TOO_OLD`, `FUTURE`, `DUPLICATE`. **HTTP 200 even when every ping is rejected** — a rejected ping is a normal outcome, not a client error, and the client must clear its buffer on any of these rather than retry forever.

**On-demand.** `POST /v1/location/requests { employeeId, mode: 'fix' | 'live' }` (owner only) inserts a `location_requests` row, then sends a data-only FCM push to that employee's Android devices. `fix` expires in 2 minutes; `live` in 5 and instructs the device to switch to ~10s intervals then revert. The row is polled by the console (`GET /v1/location/requests/:id`) so the UI can say "requested 40s ago, device has not answered" instead of spinning forever.

FCM failures (`UNREGISTERED`, `SENDER_ID_MISMATCH`) clear the stale `fcm_token` and set `failure_reason` — a device that cannot be reached is itself a tracking-health finding.

**Console reads** — `GET /v1/location/employees` (latest position + health per tracked employee), `GET /v1/location/employees/:id/trail?date=` (a day's ordered pings), `GET /v1/location/health` (the `v_employee_tracking_health` rows).

**Device registration** — `POST /v1/devices` upserts by `(employee_id, installId)`, carrying the FCM token and the four diagnostics. Called on login, on app foreground when permissions change, and after each onboarding step completes. **This endpoint is how the health chip becomes truthful**; without a fresh `location_permission`, the chip can only report absence of pings, not the reason.

---

## 9. Attachments

**`POST /v1/attachments`** — one multipart request carrying the file, `ownerType`, `ownerId`, `kind`, `capturedAt`, and an `Idempotency-Key`.

Single request rather than presign/PUT/confirm. Three round trips on a flaky 2G connection is three chances to fail, and the offline drain has to reason about a half-created attachment. At 14 users the API can absorb the bytes. **Presigned direct-to-storage is the documented scale path, not the starting point.**

Server: validates MIME against `image/jpeg|png|webp` and `application/pdf`, re-encodes JPEG to max 1600px long edge (a completion photo does not need 12 MP), computes sha256, writes to S3-compatible storage under `{ownerType}/{yyyy}/{mm}/{uuid}.{ext}`, inserts the row.

**`GET /v1/attachments/:id`** — permission-checked, then a 302 to a 5-minute presigned URL. Never proxied — that is the one place the API should not spend bandwidth.

---

## 10. Cash handover

| Method | Path | Role |
|---|---|---|
| POST | `/v1/cash/handovers` | technician — `{ businessDate, declaredAmount, note }`, idempotent, unique per `(technician, date)` |
| GET | `/v1/cash/handovers/me` | technician — his own history; **response omits `expected_cash`** |
| GET | `/v1/cash/queue` | owner — `v_cash_reconciliation_queue`, filters `from`, `to`, `flag[]` |
| POST | `/v1/cash/handovers/:id/confirm` | owner — `{ confirmedAmount }` |
| POST | `/v1/cash/handovers/:id/dispute` | owner — `{ ownerNote }`, note required |

The technician does not see the expected figure before declaring. He declares what he is handing over; the system's expectation is the check, and showing him the answer first turns a reconciliation into a form-fill.

The owner's queue must default to a range that includes days with no submission — the `missing_submission` flag is the row the whole feature exists to catch, and a default filter of "submitted handovers" would hide exactly it.

---

## 11. Sales and payments

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/v1/companies` | rep, owner | with balances from `v_company_balances` |
| POST/PATCH | `/v1/companies`, `/v1/companies/:id` | rep, owner | dispatcher: none |
| GET | `/v1/companies/:id/ledger` | rep, owner | interleaved sales + payments, running balance |
| GET | `/v1/companies/balances?minBalance=0.01` | rep, owner | the Pending tab |
| GET/POST | `/v1/sales` | rep (own), owner | items nested in the create payload |
| PATCH | `/v1/sales/:id` | rep (own, draft only), owner | `If-Match` |
| POST | `/v1/sales/:id/confirm` | rep (own), owner | allocates `sale_number`, sets `confirmed_at` |
| POST | `/v1/sales/:id/void` | owner | reason required |
| GET/POST | `/v1/payments` | rep (own), owner | proof photo via attachments |
| POST | `/v1/payments/:id/void` | owner | reason required |

Sale numbers are allocated **at confirm, not at create.** A draft that never confirms should not burn a number, and the rep's device shows "Draft" until then — consistent with `PLAN.md` §6's rule that the device never shows a fake local number.

Reps create and confirm; only the owner voids. A rep who needs a sale reversed asks, which is the correct amount of friction for the operation that moves a company's balance.

---

## 12. Background jobs

In-process `node-cron`, single API instance. At this scale a queue would be infrastructure without a reason.

| Job | Cadence | Work |
|---|---|---|
| `prune-idempotency` | hourly | delete `expires_at < now()` |
| `expire-location-requests` | every minute | close unfulfilled requests past `expires_at`, set `failure_reason` |
| `tracking-health-sweep` | every 15 min, inside the work window | find `health IN ('stale','permission_missing')`, push to the owner at most once per employee per day |
| `prune-location-pings` | nightly 02:30 IST | delete `recorded_at < now() - 180 days` |
| `orphan-attachments` | weekly | rows whose `owner_id` no longer exists → delete object + row |
| `prune-refresh-tokens` | nightly | expired or revoked > 30 days |

The health sweep is the one that earns its place: `PLAN.md` §7's "make failure loud" is not satisfied by a chip nobody is looking at.

---

## 13. Operations

**Config** — zod-parsed env, fails at boot. `DATABASE_URL`, `JWT_SECRET`, `S3_*`, `FCM_SERVICE_ACCOUNT`, `WORK_WINDOW_START/END`, `PING_RETENTION_DAYS`, `LOG_LEVEL`.

**Deployment** — one VPS, Docker Compose: Postgres 16, the API, MinIO, Caddy for TLS. 14 users and ~125k location rows a year do not need managed Kubernetes, and the operational surface of the simple version is something one person can hold in their head.

**Backups** — nightly `pg_dump` plus WAL archiving to off-site object storage; MinIO bucket replicated. **Test the restore in Phase 5.** An untested backup is a belief, not a backup.

**Observability** — `pino` structured JSON with `requestId`; slow-query log above 200ms; a `/healthz` covering DB and storage reachability. Metrics that actually get looked at: outbox rejection rate by error code, ping acceptance rate per device manufacturer, sync batch size distribution. The middle one is the OEM investigation's dataset.

**Rate limits** — login 5/min per username+IP; ping ingest 60/min per device; everything else 300/min per actor.

---

## 14. Testing

| Layer | Tool | Scope |
|---|---|---|
| Permission matrix | vitest, table-driven | every `role × resource × action` |
| Endpoint authorisation | supertest + testcontainers Postgres | every endpoint as every role — the suite that protects the revenue guarantee |
| Business rules | integration against real Postgres | status machine, discount constraint, sequence allocation under concurrency |
| Idempotency | integration | replay, differing-body reuse, concurrent in-flight |
| Sync | integration | `dependsOn` short-circuit, rejection isolation, cursor monotonicity |
| Views | SQL fixtures | especially `v_cash_reconciliation_queue`'s `missing_submission` row |
| Contract | zod schemas shared with the client | response shape per role |

No mocked database anywhere. The schema's generated columns, partial indexes and `FULL OUTER JOIN` are the parts most likely to be wrong, and a mock cannot be wrong about them.

---

## 15. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Access-token lifetime vs. offline drain — 15 min is fine given refresh-on-401, but the retry-once rule needs an integration test with an expired token and a full queue | Medium | Phase 1 |
| 2 | Whether the technician's own completion history should show amounts. Matrix says "writes own"; read-back is unspecified. Proposed: no. | Low, but visible to staff | Phase 1, confirm with owner |
| 3 | `dependsOn` is single-parent. A completion depending on both a status change and an attachment would need a list. | Low — no current case | Revisit Phase 3 |
| 4 | FCM requires a Google project even without Play Store distribution. Confirm the account exists. | **Blocking for Phase 4** | Before Phase 4 |
| 5 | Bulk reassign notification — should the losing technician be told? Not specified. | Low | Phase 2 |
