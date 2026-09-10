# Backend — Implementation Plan

Companion to `PLAN.md` §2, §5, §6, §7. Covers `apps/api` (Fastify + Postgres) and `packages/shared`.

The API's job description, stated once: **the app never talks to the database directly.** Role scoping, derived balances, sequence allocation and idempotency all live here, where they can be trusted. Everything below is in service of that sentence.

---

## 1. Build order

| Phase | Backend deliverable | Unblocks |
|---|---|---|
| 0 | Fastify skeleton, config, pg pool, migrations 001–005, error envelope, auth, **employee CRUD (§4.1)**, `packages/shared` permission matrix + zod schemas, **FCM project confirmed and a push sent end to end** | everything |
| 1 | Jobs module, completion/cancellation, `job_events`, idempotency plugin, sync bootstrap/delta/batch, location ingest, attachments, cash handover declare, stack changes **via the completion payload**, **`v_employee_tracking_health` + `GET /v1/location/health/me`** | Technician app |
| 2 | Dispatcher job queries against `v_job_cards_dispatcher`, assignment + bulk reassign, `v_technician_load`, customer CRUD, **standalone stack endpoints (§6.4)**, **assignment push notifications** | Dispatcher app |
| 2B | `service_contracts` + `contract_visits` CRUD, nightly visit generator, `v_contracts_expiring` | Contracts |
| 3 | Companies with rep ownership, sales cards + items, payments, `v_company_balances`, company ledger, rep cash handover | Sales Rep app |
| 4 | Cash reconciliation queue + confirm/dispute/reopen, **completion amendment**, location console queries, on-demand FCM requests, employee **deactivation preconditions and role change**, owner dashboards | Owner app |
| 5 | Tracking-health sweep + alerting, retention jobs, DB role hardening, load sanity | Hardening |

Phase 1 is deliberately the largest. Idempotency, the sync protocol and location ingest are the three pieces that are painful to retrofit, and Phase 1 is the only phase where the surface is small enough to get them right.

**FCM moves forward two phases.** It was scoped as a Phase 4 concern for the owner's *Locate now*. Assignment notifications (§12) need it the moment dispatchers exist, so the Google project must be confirmed in Phase 0 and the channel is a **Phase 2 blocker**. Confirming it early costs an afternoon; discovering in Phase 2 that the account does not exist costs the phase.

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
| `DUPLICATE_ENTITY` | 409 | unique violation on an offline create; `details.existing` names the server's row |
| `RECONCILIATION_CONFIRMED` | 409 | completion amendment refused — that day is signed off; `details` names the reconciliation |
| `EMPLOYEE_HAS_OPEN_WORK` | 409 | deactivation refused; `details` lists open jobs and owned companies |
| `IDEMPOTENCY_IN_FLIGHT` | 409 | same key still processing |
| `IDEMPOTENCY_KEY_REUSED` | 422 | same key, different body |
| `VALIDATION_FAILED` | 422 | zod issues in `details.issues` |
| `RATE_LIMITED` | 429 | |
| `INTERNAL` | 500 | unhandled server fault — the body never carries a stack; safe to retry later |

**Per-ping outcomes are a separate, smaller union** — `PingRejectCode` in `packages/shared`: `OUT_OF_WINDOW`, `TOO_OLD`, `FUTURE`, `DUPLICATE`. They are not error codes and never appear in an error envelope, because a rejected ping is a normal outcome of a batch that succeeded (§8). Keeping them in a different type is what stops a client treating an out-of-window ping as a request failure and retrying forever.

### 3.2 Idempotency

Every `POST`/`PATCH`/`DELETE` from a mobile client sends `Idempotency-Key: <uuid>`. The plugin wraps the handler:

1. `INSERT INTO idempotency_keys (employee_id, key, endpoint, request_hash, locked_at) … ON CONFLICT DO NOTHING`.
2. Insert won: run the handler inside a transaction, store `response_status` + `response_body`, clear `locked_at`, return.
3. Insert lost, stored row has a response, `request_hash` matches: **replay the stored response verbatim.** Same status, same body. This is the reconnect case and must be indistinguishable from the original.
4. Insert lost, `request_hash` differs: `422 IDEMPOTENCY_KEY_REUSED`. A client bug, and the one case where silently replaying would be actively wrong.
5. Insert lost, `locked_at` set and recent: `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 2`.

The key row and the business rows commit in the same transaction. If they did not, a crash between them would either lose the guard or record a response for work that rolled back.

**[impl] Services join that transaction ambiently, not by threading a client.** The plugin runs each mutation handler inside an `AsyncLocalStorage` context holding the open transaction's client (`db/ambient-tx.ts`); `withTransaction` and `query` join it whenever the caller passes none. That makes the join structural — a service cannot forget to thread the client through and write outside the transaction whose `COMMIT` also stores the response. The store is entered by **wrapping the handler**, not by `enterWith` in a `preHandler`: Fastify resumes its lifecycle in the async context captured before the hooks ran, so an `enterWith` there is invisible to the handler that follows.

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

**If the owner forgets his password, nobody can reset it.** Accounts are owner-created, there is no email and no reset flow, and there is one owner. `PLAN-DATA-MODEL.md` §3.1 states the simplification without following it to its conclusion. Two answers, both cheap, both in the Phase 0 runbook:

1. **A second owner-role account** created at go-live and held by one other trusted person. This is the real answer — an administrative control, not a feature, and it costs nothing to create.
2. **A break-glass CLI** in `apps/api`: `npm run admin:reset-password -- --username <u>`. It runs only with shell access to the VPS, prints a temporary password, sets `must_change_password`, revokes every token for that account, and writes an audit row. This is the answer when the second account is also lost.

**Deactivating an employee** — `PATCH /v1/employees/:id { isActive: false }`. Refused with **409 `EMPLOYEE_HAS_OPEN_WORK`** if any of three things is true, with the blocking rows in `details` so the owner can resolve and retry:

1. **Open jobs assigned to him.** A technician silently deactivated mid-week leaves six jobs assigned to someone who can no longer log in, and nothing in the dispatcher's views would say why they stopped moving.
2. **Companies he owns.** Reassign or null them first — otherwise a rep's accounts become invisible to both reps at once.
3. **Cash reconciliations still `submitted` or `disputed`.** This is the one that is easy to omit and worst to omit. The first two are visible on screens the owner already looks at; an unconfirmed handover is a row in a queue he may not have reached. Deactivating the person is how a real discrepancy becomes an unanswerable one — the only person who could explain it can no longer log in and has probably left. Confirm or dispute the day first; that takes a minute and is the point of the queue.

**A role change is gated the same way.** `PATCH /v1/employees/:id { role }` is refused under the same three conditions plus a fourth: a technician promoted to dispatcher loses offline capability at his next login, so his outbox must be empty. The client already handles the queue-drain half (`PLAN-FRONTEND.md` §5); the server refusing the change while work is open is what stops the two halves disagreeing.

On success: revoke every refresh token, mark his devices inactive, and exclude him from `v_employee_tracking_health` so a deactivated account does not sit permanently amber in the owner's console. Completions, payments and pings are untouched — `is_active` was never a delete.

**Endpoints**

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/login` | rate-limited 5/min per username + IP |
| POST | `/v1/auth/refresh` | rotation + reuse detection |
| POST | `/v1/auth/logout` | revokes the presented refresh token |
| POST | `/v1/auth/password` | self-service change |
| GET | `/v1/auth/me` | actor, role, permissions snapshot, **feature flags**, consent state |
| GET | `/v1/consents/required` | the consent kinds and versions this actor still owes |
| POST | `/v1/consents` | `{ kind, version, deviceId }` — records acceptance |

**The consent endpoints exist because nothing else wrote them down.** The `consents` table ships in migration 003, the consent screen is a Phase 0 deliverable, `PLAN-FRONTEND.md` §6 says the acceptance is “posted to the server”, and until now no document said where. That is a Phase 0 blocker discovered on the last day of Phase 0.

`POST /v1/consents` inserts `(employee_id, kind, version, accepted_at, device_id, ip_address)`. The `UNIQUE (employee_id, kind, version)` makes a double-tap free, so it needs no idempotency key. The server records `ip_address` itself and ignores any the client sends — this row is DPDP Act evidence, and evidence a client can author is not evidence.

**Consent gates the location task, not the app.** A technician who has not accepted still sees his jobs; the background task is simply not started and the tracking-health chip reads `permission_missing`. This matters because the alternative — a hard block at login — makes the first thing a new employee meets an ultimatum, which is the opposite of what `PLAN.md` §7 says the screen is for. The consent screen is presented at first login and on a version change, and it is not dismissible, but the failure mode of ignoring it is degraded tracking rather than an unusable app.

Versions are the **date string** of the copy revision. Rewording the screen means bumping the version, which makes every employee re-accept — so the version is bumped for a change in what is being consented to, not for a typo fix.

### 4.1 Employee administration

Owner only, except `GET /v1/employees/me`. There is no self-registration and no public surface here at all.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/employees` | filters `role[]`, `isActive`; the roster |
| POST | `/v1/employees` | `{ username, fullName, phone, role, tempPassword }` → `must_change_password = true` |
| GET | `/v1/employees/:id` | includes device diagnostics and tracking health for the owner |
| PATCH | `/v1/employees/:id` | `If-Match`; name, phone, role, `isActive` |
| POST | `/v1/employees/:id/password` | owner resets someone; revokes every token |
| GET | `/v1/employees/me` | any role, self only |

`POST /v1/employees` is needed from **Phase 0**, not Phase 4: the fourteen accounts have to exist before anyone can log in, and seeding them by hand into production is how a password ends up in a shell history. The owner-facing *screen* is Phase 4; the endpoint is Phase 0.

Role changes are allowed but not free — a technician promoted to dispatcher keeps his historical completions, which is correct, but his offline capability disappears on next login and any queued items must drain first. The client handles this the same way it handles logout (`PLAN-FRONTEND.md` §5): the role change takes effect after the queue is empty.

---

## 5. Permissions

The matrix in `PLAN.md` §5, expressed once in `packages/shared` and imported by both sides.

```ts
type Resource =
  | 'job' | 'job.money' | 'job.assign'
  | 'customer' | 'customer.stack'
  | 'company' | 'contract' | 'contract.money'
  | 'sale' | 'payment'
  | 'cash.declare' | 'cash.confirm'
  | 'employee' | 'location.read' | 'location.health' | 'location.send';

type Action = 'read' | 'create' | 'update' | 'delete';
type Scope  = 'all' | 'own' | 'assigned' | 'none';

function permit(role: Role, resource: Resource, action: Action): Scope;
```

Three scopes beyond all/none, and the distinction matters:

- `own` — rows where the actor is the author or owner (`sales_rep_id`, `received_by`, `employee_id`, `companies.owner_rep_id`).
- `assigned` — rows reachable *through* an assignment. A technician reads a customer not because he created it but because he has a job there.

The `rbac` plugin turns a scope into a SQL predicate, so scoping is applied in the query, never by filtering in JavaScript after the fact.

**`own` on `company` means `owner_rep_id = :actor OR owner_rep_id IS NULL`.** Each rep owns his accounts; a NULL owner is a house account visible to both. `PLAN.md` §5 previously gave reps company access with no scope at all, which left "his companies" in §7's bootstrap pointing at nothing. Only the owner can change `owner_rep_id` — a rep cannot claim or hand off an account, which is also how leave is covered.

**`location.health` is split from `location.read` for the same reason.** `location.read` is *where someone is* — coordinates, trails, the console — and it is the owner's alone. `location.health` is *whether the device is reporting at all*: a health value and the age of the last ping, with no position in it. The dispatcher gets the second and not the first, because he is the person who notices a technician has gone quiet and the person who will ring him, but tracking staff is not part of his job and `PLAN.md` §7 is explicit that this must not become surveillance by the desk.

Without the split there were only two options, both wrong: give dispatchers `location.read`, which hands the desk a live map of eight people it has no business watching, or give them nothing, which leaves the dashboard's tracking warning (`UI/plan-2/05-DISPATCHER.md` §D1) reading data the matrix forbids. The DB grant in `PLAN-DATA-MODEL.md` §7 follows the same line: `v_employee_tracking_health` is granted to `servgrid_dispatcher`, `location_pings` is not.

**`contract.money` exists for the same reason `job.money` does.** `service_contracts.contract_value` is revenue, and the dispatcher guarantee covers revenue wherever it lives, not only in `job_completions`. A dispatcher reads contract *context* — which visit of how many, under which contract number, prepaid or not — from `v_contract_visits_dispatcher`, which has no value column. Adding contracts without this split would have reintroduced the leak in a new table.

**Three rules the matrix alone does not capture, enforced in the services:**

1. `job.money` for a technician is **write-once at completion, no read afterwards**. He submits `cost` and `discount_amount`; the job detail he sees after completion shows the work summary and collection mode but not a revenue figure. The completion he submitted is his own record, not a report.
2. Dispatcher job reads select from `v_job_cards_dispatcher`, and dispatcher contract reads from `v_contract_visits_dispatcher`. Not a habit — a lint rule (`no-restricted-syntax` on `job_completions` and `service_contracts` inside `modules/**/repo.dispatcher.ts`) plus the optional DB grant in `PLAN-DATA-MODEL.md` §7.
3. **Dispatchers cannot set `customers.company_id`.** They create customers and have no company permission at all, so the field is stripped from dispatcher payloads server-side rather than merely omitted from their form. A field a role cannot read is a field it must not be able to write — otherwise a dispatcher can attach a customer to an account he cannot see, and the first symptom is a company ledger with a site nobody put there.

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
| `en_route` | `assigned` (reassign) | dispatcher, owner |
| `en_route` | `in_progress` | assigned technician, owner |
| `in_progress` | `completed` | assigned technician, owner |
| any non-terminal | `cancelled` | dispatcher, owner; technician with a reason |
| `completed`, `cancelled` | — | terminal |

`en_route` is skippable — a technician already on site should not have to lie to the app to start work.

**Reassignment is legal from `assigned` and `en_route`, and refused from `in_progress`.** Reassigning someone who is driving is a normal Tuesday — he has not started, and the office redirecting him is the whole job of a dispatcher. Reassigning someone who has *started work* is not: he is on site with the unit open, and moving the card to another technician means the person who did the work cannot close it and the person who can was never there. The refusal is `409 ILLEGAL_TRANSITION` with a message naming who is on site, and the dispatcher's real options are to ring him or cancel the job with a reason.

Reassigning from `en_route` resets the status to `assigned` — the new technician has not set off — and emits `reassigned`, which fires the push to both handsets (§12.1). **Bulk reassign applies the same rule per job**, so a multi-select spanning a started job returns partial results naming it, which is the honest outcome the dispatcher screen already renders (`UI/plan-2/05-DISPATCHER.md` §D2).

**The transition that matters** is the one `PLAN.md` §6 names: a technician completes a job offline that the office cancelled while he was underground. The server rejects with `409 JOB_ALREADY_CLOSED` and a message naming who cancelled it and when. The client keeps the local record and shows a banner. **No silent overwrite in either direction** — the server does not accept it, and it does not delete the technician's work either. The rejected completion stays in the outbox as `rejected` and is inspectable.

### 6.2 Completion

`POST /v1/jobs/:id/complete` is a single transaction:

1. Lock the job row (`SELECT … FOR UPDATE`), assert status `in_progress` (or `assigned`/`en_route` — completing straight from assigned is legal), assert actor is `assigned_to` or owner.
2. Insert `job_completions`. Database constraints enforce the discount rule; the service does not re-implement them, it maps the constraint violation to a readable 422.
3. Update `job_cards` → `completed`, `closed_at`.
4. Insert `job_events` (`completed`, with `occurred_at` from the client's `completedAt`, `recorded_at = now()`).
5. Optional: upsert `customer_products` rows from `stackChanges[]` in the same transaction, each stamped `source_job_id`.
6. Optional: insert `job_completion_parts` from `parts[]` — what was fitted or consumed. **These do not affect `cost`**, which the technician enters as one figure; parts are a record, not a bill (`PLAN-DATA-MODEL.md` §3.4).
7. If the job is a contract visit, flip `contract_visits.status` to `completed`.
8. Attachments arrive as separate requests and reference the job id; a completion is valid without them.

The client sends `completedAt` from the device clock. The server accepts it but clamps it: not in the future, not more than 14 days old. Both bounds recorded in `job_events.payload` when clamping occurs.

**A prepaid contract visit completes with no money.** When the job is linked to a `contract_visits` row whose contract is `billing = 'upfront'`, the service asserts `cost = 0` and rejects anything else with a readable 422. The client already hides the amount field in that case (`PLAN-FRONTEND.md` §9); this is the server refusing to trust it.

### 6.2b Amending a completion

`POST /v1/jobs/:id/completion/amend`, **owner only**, `reason` required.

Until now `job_completions` had a 1:1 primary key and no correction path at all. A technician who typed ₹50,000 for ₹5,000 poisoned `v_employee_expected_cash` and reached the owner as a ₹45,000 variance with no explanation and no way to fix it — while sales and payments could already be voided with a reason. Completions were the one money-bearing record in the system that could not be corrected.

1. Lock the completion row, apply the new `cost` / `discount_amount` / `discount_reason`. The same database constraints apply; a discount still needs a reason.
2. Write `job_events` type `completion_amended` with the before and after values in `payload`. **No history columns on the table** — the append-only event log is where trails belong here, and `version` already moves under the `touch_updated_at()` trigger.
3. **Refuse with 409 if the covering `cash_reconciliations` row for that employee-day is `confirmed`.** Amending a confirmed day silently moves a figure the owner has signed off. The `details` name the reconciliation, so the client can offer to reopen it.

Reopening is `POST /v1/cash/handovers/:id/reopen` (§10), owner only, reason required, audited. Two deliberate actions rather than one convenient one: the reconciliation is the point at which money stops being provisional, and walking it backwards should feel like a decision.

### 6.3 Endpoints

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/v1/jobs` | all | role-scoped; filters `status[]`, `technicianId`, `customerId`, `from`, `to`, `overdue`, `q`; cursor paginated |
| POST | `/v1/jobs` | dispatcher, owner | allocates `job_number` |
| GET | `/v1/jobs/:id` | scoped | response shape differs by role — see below |
| PATCH | `/v1/jobs/:id` | dispatcher, owner | `If-Match: version`; this is also how a job is **rescheduled** |
| POST | `/v1/jobs/:id/assign` | dispatcher, owner | `{ technicianId }`, **`If-Match: version`** |
| POST | `/v1/jobs/bulk-assign` | dispatcher, owner | `{ jobIds[], technicianId }`, one transaction, partial results, per-job `If-Match` |
| POST | `/v1/jobs/:id/status` | technician (own), owner | `{ to, occurredAt }` |
| POST | `/v1/jobs/:id/complete` | technician (own), owner | idempotent |
| POST | `/v1/jobs/:id/completion/amend` | **owner only** | `{ cost, discountAmount, discountReason, reason }`, audited |
| POST | `/v1/jobs/:id/cancel` | dispatcher, owner, technician (own) | `{ reasonCode, reasonNote, rescheduleTo? }` — see below |
| GET | `/v1/jobs/:id/events` | dispatcher, owner | timeline |
| GET | `/v1/technicians/load` | dispatcher, owner | `v_technician_load` for the picker |

**`If-Match` on assign is not optional.** Three dispatchers work the same unassigned queue every morning; two of them opening the same job and picking a technician is a routine Tuesday, not a race condition worth ignoring. A lost race returns `409 VERSION_CONFLICT` **naming the current assignee** — "Ravi was assigned this 20 seconds ago" is actionable, "version conflict" is not.

**Rescheduling is a `PATCH` of `scheduled_for`**, under `If-Match`, emitting a `rescheduled` event, leaving status alone. It always worked; it was never written down, and an unstated capability gets rebuilt as a special case. It is *not* a cancellation — `job_cancellations.replacement_job_id` covers the different case where a job is abandoned and a successor raised.

**Cancelling with a date is how a wasted trip is recorded.** A technician at a locked gate cancels the job with a `reasonCode` and, if the work can still happen, a `rescheduleTo` date. What that does depends on whether the job came from a contract:

- **Ordinary job** — `rescheduleTo` creates a successor job card in the same transaction, linked by `job_cancellations.replacement_job_id`. Same customer, same service, new date, `unassigned`.
- **Contract visit** — the visit returns to `scheduled` with `due_date = rescheduleTo`, and the generator raises a fresh card when it comes due. No successor is created here, because creating one *and* leaving the visit scheduled would double-raise the work.
- **No `rescheduleTo`** — an ordinary job is simply cancelled; a contract visit becomes `skipped`, carrying the cancellation reason, and the customer has spent it.

**The technician makes this call, not the office.** He is the one who knows whether the customer said "come Thursday" or "don't bother". Routing it through a dispatcher would mean the decision is made by someone who was not there, from a reason code, hours later.

`rescheduleTo` is bounded: not in the past, and for a contract visit not beyond `service_contracts.end_date` — a visit pushed past the term is a visit that cannot happen, and accepting the date would produce a contract that never completes.

**Overdue is a filter, not a state.** `?overdue=true` selects open jobs whose `scheduled_date` has passed, reading `is_overdue` from `v_job_cards_dispatcher` so the list, the dashboard count and any later report cannot disagree about the definition. Nothing advances the date automatically — an open job stays on the day it was promised for, because moving it silently hides the missed commitment the dispatcher exists to see.

**Response shape by role** is enforced by three separate zod response schemas — `JobCardTechnician`, `JobCardDispatcher`, `JobCardOwner` — not by one schema with optional fields. An optional field is a field that can leak; a separate schema cannot.

---

### 6.4 Customers, the product stack, and reference data

Specified here because `customer CRUD` appears in the Phase 2 build order and nowhere else, and because the technician's stack update is a permission in `PLAN.md` §5 with no endpoint behind it.

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/v1/customers` | dispatcher, owner (all); technician (`assigned`) | search `q` over name and phone; cursor paginated |
| POST | `/v1/customers` | dispatcher, owner | **`company_id` stripped for dispatchers** (§5) |
| GET | `/v1/customers/:id` | scoped | includes the active product stack |
| PATCH | `/v1/customers/:id` | dispatcher, owner | `If-Match` |
| GET | `/v1/customers/:id/stack` | scoped | active `customer_products` |
| POST | `/v1/customers/:id/stack` | technician (assigned), owner | add a unit; idempotent |
| PATCH | `/v1/customers/:id/stack/:itemId` | technician (assigned), owner | `If-Match`; serial, warranty, quantity |
| DELETE | `/v1/customers/:id/stack/:itemId` | technician (assigned), owner | soft: `is_active = false`, which releases the serial |
| GET/POST | `/v1/products`, `/v1/services` | read: all; write: owner | |
| PATCH | `/v1/products/:id`, `/v1/services/:id` | owner | `If-Match`; deactivate rather than delete |

**Stack changes have two doors, deliberately.** The completion payload carries `stackChanges[]` (§6.2 step 5) so a technician who fits a battery records it in the same transaction that closes the job — that is the path that matters, because it is the one he will actually use, and `source_job_id` makes it auditable. These standalone endpoints exist for the correction case: a wrong serial noticed the next day, a unit removed without a job. They stamp no `source_job_id`, and that absence is itself the signal that a change did not come from work done.

**A technician's scope on the stack is `assigned`, not `all`.** He can edit the stack at a site he has or has had a job for. Widening this to `all` would let any technician rewrite any site's equipment record, and the audit trail would say it was legitimate.

Products and services are read by everyone — the completion form and the sales line-item picker both need them — and written only by the owner. They are small, slow-moving tables; there is no pagination and no search beyond a client-side filter.

---

## 7. Sync protocol

Three endpoints. Technician and sales rep only; dispatcher and owner use the normal REST surface online.

**`GET /v1/sync/bootstrap`** — the full role-scoped working set for a cold start: the actor's open and recently-closed jobs, the customers those jobs touch and their product stacks, active products and services, and (for a rep) **the companies he owns plus the house accounts**, with balances. Returns `{ data: {...}, cursor: "<iso8601>" }`. Bounded by design — a technician's set is tens of rows, not the whole database.

A technician's jobs carry `contract: { number, billing, visitsRemaining } | null` inline. Contracts are not a separate synced collection: the technician needs the context of the visit in front of him, never the contract as an entity, and a table he cannot act on has no business in his mirror.

**`GET /v1/sync/delta?cursor=`** — everything in that same scope with `updated_at > cursor`, plus tombstones, plus a new cursor. Server caps the page and returns `hasMore` so a client that has been offline a fortnight pages rather than times out.

The cursor is the server's `updated_at`, never the device clock. A device with a skewed clock must not be able to skip records.

**Tombstones cover two cases, and the second is the one that bites.** The obvious one is deletion — a row now `is_active = false`. The other is **scope exit**: a row that is still perfectly alive but has stopped being this actor's business.

```jsonc
"tombstones": [
  { "entity": "job",     "id": "…", "reason": "deleted" },
  { "entity": "job",     "id": "…", "reason": "out_of_scope" },
  { "entity": "company", "id": "…", "reason": "out_of_scope" }
]
```

A job reassigned from Ravi to Anitha is not deleted and not inactive; it is simply no longer in Ravi's scope. A delta query that filters by scope *before* comparing cursors therefore returns nothing about it, and Ravi's mirror keeps a job that is not his — on his dashboard, in his "6 today" figure, and openable, with a *Start job* button that will 403 when he taps it in front of a customer. Nothing errors. The row just never leaves.

So the delta query runs **twice**: once for rows in scope with `updated_at > cursor`, and once for rows the actor previously held that are no longer in scope. The second needs the server to know what he held, which is `assigned_to <> :actor` over jobs he could have seen — bounded by the same window the bootstrap uses, so it is a small query, not a diff of the world. The client deletes those rows from the mirror and drops them from any list.

**A tombstone never deletes an outbox row.** If Ravi completed the job underground and it was reassigned while he was down there, his completion is still queued and still his work; the mirror loses the job, the outbox keeps the operation, and the server decides on drain — which is `409 JOB_ALREADY_CLOSED` or an accepted completion depending on what actually happened. **The rule from `PLAN.md` §6 holds at this door too: no path in this app silently discards a technician's work.**

Same shape for a rep when the owner reassigns a company: the account leaves his list, his queued payment against it does not.

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

**A unique violation on an offline create is a first-class outcome, not a 500.** Two reps create the same company offline; the case-insensitive unique name rejects the second on sync, and its queued sale now points at an entity that does not exist. The operation returns `rejected` with `DUPLICATE_ENTITY` and `details.existing` carrying the server's row — id, name, and enough to identify it — so the client can offer *Use the existing company* and rewrite the dependent outbox rows to that id rather than making the rep re-enter the sale.

Rep account ownership (§5) makes this rare, since two reps rarely create the same account. Rare is the reason to specify it: a path that fires once a quarter is one nobody will recognise when it does.

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

**Health reads, and they are not all the owner's.** Three surfaces read `v_employee_tracking_health` and they ship in three different phases, so they are three endpoints rather than one:

| Method | Path | Roles | Phase | Serves |
|---|---|---|---|---|
| GET | `/v1/location/health/me` | technician, sales rep | **1** | the health chip on his own profile |
| GET | `/v1/location/health` | dispatcher, owner | 2 / 4 | dispatcher: the roster warning on his dashboard. Owner: the console |
| GET | `/v1/location/employees` | owner | 4 | latest position + health per tracked employee |
| GET | `/v1/location/employees/:id/trail?date=` | owner | 4 | a day's ordered pings |

`/v1/location/health/me` is the one that is easy to miss. The chip is a **Phase 1** deliverable and a Phase 1 exit criterion — it must have shown a true red in the field before the phase closes — so both the view (migration 009) and this endpoint are Phase 1 work, not Phase 4 work that the chip borrows early. It returns the actor's own row plus `notifications_enabled`, and nothing about anyone else.

**A dispatcher reads health but not position.** He is the person who will actually notice that a technician stopped reporting, and his dashboard shows it inline (`UI/plan-2/05-DISPATCHER.md` §D1). That is a `location.health` read, not a `location.read` — see §5. The row he receives carries the employee, the health value and the last-ping *age*; it carries no coordinates, no trail and no last-ping location.

**Device registration** — `POST /v1/devices` upserts by `(employee_id, installId)`, carrying the FCM token and the four diagnostics. Called on login, on app foreground when permissions change, and after each onboarding step completes. **This endpoint is how the health chip becomes truthful**; without a fresh `location_permission`, the chip can only report absence of pings, not the reason.

---

## 9. Attachments

**`POST /v1/attachments`** — one multipart request carrying the file, `ownerType`, `ownerId`, `kind`, `capturedAt`, and an `Idempotency-Key`.

Single request rather than presign/PUT/confirm. Three round trips on a flaky 2G connection is three chances to fail, and the offline drain has to reason about a half-created attachment. At 14 users the API can absorb the bytes. **Presigned direct-to-storage is the documented scale path, not the starting point.**

Server: validates MIME against `image/jpeg|png|webp` and `application/pdf`, re-encodes JPEG to max 1600px long edge (a completion photo does not need 12 MP), computes sha256, writes to S3-compatible storage under `{ownerType}/{yyyy}/{mm}/{uuid}.{ext}`, inserts the row.

**`request_hash` is defined differently here, and it has to be.** §3.2 canonicalises a JSON body with sorted keys; a multipart upload has no JSON body to canonicalise, and hashing the raw multipart stream is unstable — the boundary string changes between retries of the same file. So for this endpoint `request_hash` is `sha256(fileChecksum + ownerType + ownerId + kind)`, where `fileChecksum` is the sha256 of the file bytes the client computes before enqueueing and sends as a field.

That makes a retried upload of the same photo a clean replay, and a *different* photo sent under a reused key a `422 IDEMPOTENCY_KEY_REUSED` exactly as elsewhere. It also gives the server a free integrity check: if the bytes it received do not hash to the client's `fileChecksum`, the upload was truncated on a bad link and is rejected rather than stored as a corrupt image nobody looks at until it matters.

**`GET /v1/attachments/:id`** — permission-checked, then a 302 to a 5-minute presigned URL. Never proxied — that is the one place the API should not spend bandwidth.

---

## 10. Cash handover

| Method | Path | Role |
|---|---|---|
| POST | `/v1/cash/handovers` | **technician or sales rep** — `{ businessDate, declaredAmount, note }`, idempotent, unique per `(employee, date)`. `businessDate` bounded: not in the future, not more than **7 days** back |
| PATCH | `/v1/cash/handovers/:id` | **the declaring employee**, `If-Match`; **only while `status = 'submitted'`** — corrects his own declaration before the owner has looked |
| GET | `/v1/cash/handovers/me` | technician, rep — own history; **response omits `expected_cash`** |
| GET | `/v1/cash/queue` | owner — `v_cash_reconciliation_queue`, filters `from`, `to`, `flag[]`, `role` |
| POST | `/v1/cash/handovers/:id/confirm` | owner — `{ confirmedAmount }` |
| POST | `/v1/cash/handovers/:id/dispute` | owner — `{ ownerNote }`, note required |
| POST | `/v1/cash/handovers/:id/reopen` | owner — `{ reason }`, required; returns the row to `submitted` |

**Sales reps declare too.** `cash_reconciliations` is keyed on `employee_id`, and expected cash now unions cash payments with cash completions (`PLAN-DATA-MODEL.md` §4). A rep who accepts cash from a company was previously holding money the system would never ask him about. Because rep cash is *rare*, this is more dangerous rather than less: an unreconciled path nobody exercises is one nobody notices is broken. There is no new screen — the rep's handover is the technician's screen with a different heading.

**No expenses field.** An earlier draft carried one, to stop a technician who bought a part out of collected cash from raising a variance that was not real. The owner has confirmed that does not happen. So **every variance in the queue is a genuine discrepancy**, which is what makes the flag worth the owner's attention at all — the removed field would have been the only route by which a shortfall could be explained away rather than investigated.

**Reopen** exists because a completion cannot be amended once its day is confirmed (§6.2b). Owner only, reason required, audited, and deliberately a second action rather than a flag on the amend call: confirmation is where money stops being provisional, and reversing that should feel like a decision.

**An employee can correct his own declaration until the owner acts on it.** Without the `PATCH` there is no correction path at all: a technician who types ₹4,500 for ₹45,000 cannot resubmit — the row is unique per `(employee, date)` — and cannot get it reopened, because `reopen` returns a *confirmed* row to `submitted` and his is already `submitted`. The mistake would sit in the queue as a ₹40,500 variance until the owner confirmed a figure he could see was wrong, and the whole point of the flag is that a variance means something.

The rule mirrors completion amendment exactly (§6.2b): **correctable until it is signed off, then it takes a deliberate second action.** Once the row is `confirmed` or `disputed` the `PATCH` is refused with `409 RECONCILIATION_CONFIRMED`; the owner reopens, and the reopen is audited. The prior declared amount is written to the audit trail, because a self-corrected figure is exactly the kind of thing someone will want to look at later.

The employee does not see the expected figure before declaring. He declares what he is handing over; the system's expectation is the check, and showing him the answer first turns a reconciliation into a form-fill.

**The queue lags the field by a sync, and the owner has to know that.** `job_completions.business_date` is generated from `completed_at`, which is the technician's clamped device time — so cash collected in a basement on Monday lands on **Monday**, whenever it syncs. That is right: it puts the money on the day it was physically taken, which is the day it was handed over.

The consequence is that a day's expected figure is not final until that day's work has drained. A technician who declares on Monday evening and syncs on Tuesday morning produces, for a few hours, a Monday row with a declaration and no expected cash — flagged `no_expected_cash`, which reads exactly like the problem it is not. So the queue **defaults to a range ending yesterday**, with today reachable but marked *“still syncing”*. An owner who learns that the flags lie on the current day learns to discount the flags, which costs more than a one-day delay ever will.

The owner's queue must default to a range that includes days with no submission — the `missing_submission` flag is the row the whole feature exists to catch, and a default filter of "submitted handovers" would hide exactly it.

---

## 11. Sales, payments and contracts

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/v1/companies` | rep (own + house), owner (all) | with balances from `v_company_balances` |
| POST/PATCH | `/v1/companies`, `/v1/companies/:id` | rep (own + house), owner | dispatcher: none. Create sets `owner_rep_id` to the creator |
| PATCH | `/v1/companies/:id/owner` | **owner only** | `{ ownerRepId \| null }` — reassignment and leave cover |
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

A rep who creates a company becomes its owner. He cannot claim another rep's account or hand one off — that is `PATCH /v1/companies/:id/owner`, owner only. Setting it to `null` makes the account a house account visible to both reps, which is how a fortnight of leave is covered without inventing a delegation model.

### 11.1 Service contracts — Phase 2B

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/v1/contracts` | rep (`sold_by`), owner | filters `status[]`, `customerId`, `expiringWithinDays` |
| POST | `/v1/contracts` | rep, owner | draft; **409 if the site already has an active contract** |
| GET | `/v1/contracts/:id` | rep (`sold_by`), owner | includes the visit schedule and each visit's attempts |
| PATCH | `/v1/contracts/:id` | rep (`sold_by`, draft only), owner | `If-Match` |
| POST | `/v1/contracts/:id/activate` | rep, owner | draft → active, allocates `contract_number`, generates the visit rows |
| POST | `/v1/contracts/:id/cancel` | **owner only** | reason required; unraised visits become `skipped`, raised jobs untouched |
| GET | `/v1/contracts/expiring` | rep (`sold_by`), owner | `v_contracts_expiring` |
| PATCH | `/v1/contracts/visits/:id` | dispatcher, owner | move `due_date` without a site visit — the office-side reschedule |
| POST | `/v1/contracts/visits/:id/skip` | dispatcher, owner | `{ reason }`, required |
| GET | `/v1/jobs/:id/contract` | technician (own job), dispatcher, owner | dispatcher reads `v_contract_visits_dispatcher` — **no contract value** |

**A rep is scoped by `sold_by`, not by account ownership.** Contracts hang off `customer_id` and rep ownership lives on `companies.owner_rep_id`, so there is no path between them — a site is not an account. A rep sees the contracts he sold. This is the one place where rep scoping does *not* follow `companies.owner_rep_id`, and it follows from one site holding one AMC (`PLAN-DATA-MODEL.md` §3.10).

**One active contract per site**, enforced by a partial unique index. The API returns `409 DUPLICATE_ENTITY` naming the existing contract rather than letting the constraint surface as a 500 — a rep drafting a renewal for a site that already has one is a normal thing to do, and he needs to be told which one.

**Activation expires an outgoing predecessor in the same transaction.** The renewal case is the ordinary case, and without this it fails on the ordinary day. A contract ends 31 March; the rep signs the renewal on the 28th and activates it; the partial unique index refuses, because the old one is still `active` until `expire-contracts` runs at 03:00 on 1 April. The rep is told to come back in four days, for a reason no one can explain to a customer.

So `POST /v1/contracts/:id/activate` first expires any `active` contract at the same site whose `end_date < the new contract's start_date`, then activates. If the predecessor's term has *not* ended — a genuine overlap, two live agreements for the same site — the 409 stands and names it, because that is a commercial mistake rather than a scheduling one and it needs a person. The nightly `expire-contracts` job remains, for contracts nothing renews.

The technician's on-site reschedule is *not* here: it is `POST /v1/jobs/:id/cancel` with a `rescheduleTo` (§6.3), because from where he is standing the thing he is acting on is a job, not a contract. `PATCH /v1/contracts/visits/:id` is the office equivalent, for when the customer phones ahead.

**Visit rows are generated at activation, not on the fly.** Activating a contract writes all `visits_included` rows with `due_date` stepped by `visit_interval_days`. Materialising the schedule up front means the owner can see it, a rep can point at it when the customer asks, and a due date can be moved individually without recomputing an interval — a customer who wants the March visit in April is a normal request, and an implied schedule cannot answer it.

The number is allocated at activation for the same reason a sale number is allocated at confirm: a draft that never activates should not burn one.

**Cancelling a contract does not touch jobs already raised.** Unraised visits become `skipped` with the cancellation as the reason; visits that already produced a job card leave that job alone, because it may already be done. This follows the module's central property — once a visit becomes a job, it is just a job.

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
| `generate-contract-visits` | nightly 03:00 IST | raise `unassigned` job cards for `scheduled` visits with `due_date <= current_date + 7` — **no lower bound**; flip the visit to `job_created` |
| `expire-contracts` | nightly | active contracts past `end_date` → `expired` |

The health sweep is the one that earns its place: `PLAN.md` §7's "make failure loud" is not satisfied by a chip nobody is looking at.

**The visit generator needs no idempotency key.** The partial unique index on `job_cards (contract_visit_id) WHERE status <> 'cancelled'` permits at most one live card per visit, so a generator that runs twice, or resumes after a crash mid-batch, cannot double-raise. The constraint *is* the guard — the same argument as `location_pings`' `UNIQUE (employee_id, recorded_at)`, and cheaper than threading the idempotency plugin through a job with no HTTP request behind it.

The index is partial rather than total precisely so a rescheduled visit works: its cancelled first attempt stays under the visit as history, and the generator is free to raise a second card when the new date arrives.

It raises jobs seven days ahead so the dispatcher has a week of visibility and can schedule around them, and so a generator that fails for a night or two is invisible rather than urgent.

**The window has no lower bound, and that is deliberate.** `due_date <= current_date + 7` and not a symmetric window around today, because a `scheduled` visit whose date is already in the past is exactly the state the reschedule path produces. A technician who cancels a visit's job on Tuesday and picks Wednesday returns the visit to `scheduled` with tomorrow's date; the generator raises it at 03:00 and everything is fine. But a technician who picks *today*, or a generator that does not run for two nights, or a customer who phones the office to move a visit to a date that then passes — each leaves a `scheduled` visit whose date is behind the window's leading edge.

With a lower bound those visits are **orphaned permanently**: the visit is `scheduled`, never becomes a job, never expires, and quietly stops the contract from completing. Nothing errors and nothing is flagged. Sweeping everything overdue means a missed night self-heals on the next run, which is the property that makes a nightly cron acceptable at all. The `(status, due_date)` partial index serves the query either way.

A visit raised late is raised for the day it was due, not for today — `scheduled_for` comes from `due_date`, so the card arrives already **Overdue** in the dispatcher's list. That is correct: the commitment was missed, and `PLAN-DATA-MODEL.md` §3.4 is explicit that a date never silently rolls forward.

### 12.1 Assignment notifications — event-driven, not scheduled

Not a cron row, because it is triggered by a mutation. On assign, reassign, cancellation of an assigned job, and priority escalation, the service sends a **data-only** FCM message to the assigned technician's devices.

The message **carries no job content**. It wakes the app, which runs a delta sync and raises a *local* notification from the row it just received. A push that carried the job would be stale the moment the office changed something, and would deliver job details to a handset that may since have been logged out.

**Why this exists at all:** the client drains and syncs on reconnect, on foreground, and on a 60-second timer *while the app is active*. None of those fire when the app is backgrounded, so without a push a technician learns about an urgent job when he next happens to open it. For a dispatch application that is close to a defect.

**The system must remain correct with every push dropped.** Push is a latency improvement over the existing sync triggers, never the transport for anything. A technician who receives none still gets the job on next foreground. Keeping FCM off the correctness path is what makes it safe to depend on a delivery channel nobody controls — and it means an expired token, a dead Google project or a silenced OEM degrades timeliness rather than losing work.

Failures clear the stale token exactly as `/v1/location/requests` does (§8), and a device that cannot be reached is a tracking-health finding either way.

---

## 13. Operations

**Config** — zod-parsed env, fails at boot. `DATABASE_URL`, `JWT_SECRET`, `S3_*`, `FCM_SERVICE_ACCOUNT`, `WORK_WINDOW_START/END`, `PING_RETENTION_DAYS`, `LOG_LEVEL`.

**Deployment** — one VPS, Docker Compose: Postgres 16, the API, MinIO, Caddy for TLS. 14 users and ~125k location rows a year do not need managed Kubernetes, and the operational surface of the simple version is something one person can hold in their head.

**Backups** — nightly `pg_dump` plus WAL archiving to off-site object storage; MinIO bucket replicated. **Test the restore in Phase 5.** An untested backup is a belief, not a backup.

**Observability** — `pino` structured JSON with `requestId`; slow-query log above 200ms; a `/healthz` covering DB and storage reachability. Metrics that actually get looked at: outbox rejection rate by error code, ping acceptance rate per device manufacturer, sync batch size distribution. The middle one is the OEM investigation's dataset.

**Alerting.** `/healthz` is polled every five minutes by an external uptime checker, alerting the developer and the owner by phone. That plus the existing `tracking-health-sweep` push is the entire alerting story, and saying so is the point: at 14 users there is no on-call rota and there should not be one, but a silent API outage on a Tuesday morning stops the business. Naming the destination now stops Phase 5 discovering a gap and over-building in response.

**CI.** GitHub Actions. Nothing in this document or `PLAN-FRONTEND.md` §10 previously said what runs where or what blocks a merge — only what the tests contain.

*On pull request, all required to merge:*

1. Typecheck across the monorepo.
2. Lint, including the three custom rules that carry real guarantees — no literal `#F2C200` outside `theme.ts`; no `job_completions` or `service_contracts` reference inside `modules/**/repo.dispatcher.ts`; and no `location_pings` or `location_requests` reference there either. These are not style rules. The first is the accent-erosion defence, the second the revenue-leak defence, and the third keeps the `location.health` / `location.read` split (§5) from eroding the same way — a dispatcher may know a device went quiet, never where anyone is.
3. **The nav map and the permission matrix agree.** A test walks every route in every role's `GROUPS` entry (`PLAN-FRONTEND.md` §3) and asserts `permit()` allows it, and walks every route the matrix allows and asserts it appears in that role's map. A permitted route with no tab is unreachable and a tab to a forbidden route is a 403 the user tapped — neither raises an error at runtime, which is why it is a build gate.
4. Unit and integration suites against a testcontainers Postgres.
5. Migration `up → down → up` on a clean database. Down-migrations are never run in production (`PLAN-EXECUTION.md` Part I) but they are how a developer resets locally, and an untested one fails at the worst moment.

*On merge to main:* build and push the API image, migrate staging, deploy staging.

**EAS builds stay manual** — one per phase plus the contingency slot. `PLAN-EXECUTION.md`'s T3 rollback tier costs hours to days, so an APK must be a decision, never a side effect of a merge.

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
| Views | SQL fixtures | especially `v_cash_reconciliation_queue`'s `missing_submission` row, and that a day with cash collected on *both* sides — a completion and a payment — sums into one expected figure |
| Contract | zod schemas shared with the client | response shape per role |
| Contracts module | integration | generator idempotency under a repeated run, prepaid visit rejects a non-zero cost, cancellation leaves raised jobs alone |
| Amendment | integration | amend before confirm succeeds; amend after confirm returns 409; reopen then amend succeeds; the event trail carries before and after |
| Concurrency | integration | two simultaneous assigns — one wins, the loser gets 409 naming the assignee |

Two suites deserve naming as the ones that protect a promise rather than a function:

- **Endpoint authorisation as every role** already protected the revenue guarantee. It now also has to assert that no dispatcher payload contains `contract_value`, because contracts put revenue in a second table and the original test only knew about the first.
- **The `missing_submission` fixture** asserts that a day with collected cash and no declaration row survives the `FULL OUTER JOIN` and reaches the queue. It is the only flag whose row does not exist on one side of the join, so it is the only one a naive `LEFT JOIN` would silently drop — and it is the row the entire feature exists to catch.

No mocked database anywhere. The schema's generated columns, partial indexes and `FULL OUTER JOIN` are the parts most likely to be wrong, and a mock cannot be wrong about them.

---

## 15. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Access-token lifetime vs. offline drain — 15 min is fine given refresh-on-401, but the retry-once rule needs an integration test with an expired token and a full queue | Medium | Phase 1 |
| 2 | Whether the technician's own completion history should show amounts. Matrix says "writes own"; read-back is unspecified. Proposed: no. | Low, but visible to staff | Phase 1, confirm with owner |
| 3 | `dependsOn` is single-parent. A completion depending on both a status change and an attachment would need a list. | Low — no current case | Revisit Phase 3 |
| 4 | FCM requires a Google project even without Play Store distribution. **Now needed for assignment notifications, not just *Locate now*.** | **Confirm in Phase 0, blocking for Phase 2** | Before Phase 2 |
| 5 | Bulk reassign notification — the losing technician now *does* get a push, since §12.1 fires on reassign. What the local notification should say when work is taken away is a wording decision, not a technical one. | Low | Phase 2 |
| 6 | Should a technician be pushed for a job assigned outside the 09:00–19:00 work window? The location service has a window; notifications do not. Proposed: suppress until the window opens, except `priority = 'urgent'`. | Medium — a staff-relations question as much as a technical one | Phase 2 |
| 7 | ~~Contract visit `due_date` moves — who may do it.~~ **Closed: dispatcher and owner**, per the §11.1 endpoint table and `PLAN.md` §5. A customer phoning ahead reaches the office, so the office moves the date; the technician's equivalent is the on-site reschedule from his cancel sheet. A rep cannot — he sold the agreement, he does not run the schedule. | — | Done |
| 8 | Whether a technician should be able to *see* a completion he amended — the owner's correction is invisible to him, which is right for revenue and arguably wrong for a disputed job. Proposed: no change; the owner rings him. | Low | Phase 4, confirm with owner |
