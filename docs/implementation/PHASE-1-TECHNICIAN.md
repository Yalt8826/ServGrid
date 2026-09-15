# Phase 1 — Technician

> **Superseded in part by the online-only decision (2026-09-15, `docs/decisions/2026-09-15-online-only.md`).** This is a historical record. Its offline mirror, outbox, `tech.offline` flag, pending-sync UI and sync endpoints were removed in Phase ON (`docs/implementation/PHASE-ON-ONLINE.md`); where it disagrees with the `PLAN*.md` documents, the plans win.

**Size XL · ~7 weeks · Risk: high**

The largest phase and the one that decides the project. Idempotency, the sync protocol and the location service are all painful to retrofit, and **this is the only phase where the surface is small enough to get them right.**

**Entry gates** (`PLAN-EXECUTION.md` Phase 1):

- Phase 0 exit met.
- At least one handset from **each OEM in the staff roster** physically available, **and borrowed long enough to capture the autostart walkthrough screenshots.** Those cannot be written from documentation and they block the last step of the permission ladder.
- Owner has answered: does a technician see amounts in his own completion history? (`PLAN-BACKEND.md` open item 2 — proposed: **no**.)

**Read before starting:** `PLAN-DATA-MODEL.md` §3.3–3.9 · `PLAN-BACKEND.md` §6, §7, §8, §9, §10 · `PLAN-FRONTEND.md` §5, §6, §9 · `UI/plan-2/04-TECHNICIAN.md` in full.

**The shape of the risk.** Nearly all of it is on the client. The backend's share of location is small but non-negotiable; the outbox, the mirror and the OEM battery fight are where this phase can go wrong quietly.

---

## Task graph

```
T1.1 migrations 006-007 ── T1.2 migrations 008-010 + health view
     │                          │
     ├── T1.3 idempotency ──────┤
     ├── T1.4 sequences         │
     │        │                 │
     │        └── T1.5 jobs read/status ── T1.6 completion ── T1.7 cancellation
     │                                          │
     │                                          ├── T1.8 sync protocol
     │                                          ├── T1.9 location ingest
     │                                          ├── T1.10 attachments
     │                                          ├── T1.11 cash handover
     │                                          └── T1.12 tracking health me
     │
     └── T1.13 sqlite mirror ── T1.14 outbox drain ── T1.15 cold start
              │                        │
              │                        └── T1.17 dashboard ── T1.18 job detail ── T1.19 complete
              │                                                       │
              └── T1.16 location task + ladder                        ├── T1.20 cancel sheet
                                                                      └── T1.21 handover + profile

T1.22 Job Logs prototype   ← side quest, any time, gates Phase 2
T1.23 field parallel run   ← last
```

---

## Part A — Schema

### T1.1 — Migrations 006–007: stack and jobs

**Reads:** `PLAN-DATA-MODEL.md` §3.3 (customer stack), §3.4 (jobs — the structural core), §5 (index plan)
**Depends on:** Phase 0
**Parallel with:** —
**Tier:** free until Phase 1 deploys

> **Serial task.** One agent owns the migration sequence for this phase.

**Build**

**Migration 006 `customer_products`** — what is physically installed at a site. `product_id` nullable with `free_text_name` required when null, for third-party kit. Unique index on `lower(serial_number)` **among active rows** — a serial cannot be installed at two sites at once, and de-installation is `is_active = false`, which releases it. `source_job_id → job_cards` is what makes every stack change traceable to the job that caused it.

**Migration 007 `jobs`** — `job_cards`, `job_completions`, `job_completion_parts`, `job_cancellations`, `job_events`.

**`job_cards` has no money columns.** This is the load-bearing decision of the whole schema: it makes "dispatchers cannot see revenue" a property of the schema rather than a promise about every future `SELECT`.

Two nullable context FKs, both earning their place:

- **`customer_product_id`** — names the specific unit. Without it, a site with five UPS units and three battery banks produces a card reading "battery swap" and leaves the technician to work it out on arrival. Nullable because a site survey has no existing unit, and a dispatcher taking a call may not know which one.
- **`contract_visit_id`** — with the partial unique index below. The FK target does not exist until Phase 2B; **create the column now and add the constraint in migration 015.** Adding the column later would be an expand/contract cycle on the busiest table in the schema.

```sql
CONSTRAINT job_assignment_coherent CHECK (
  (status = 'unassigned' AND assigned_to IS NULL) OR
  (status <> 'unassigned' AND assigned_to IS NOT NULL)
),
CONSTRAINT job_closed_coherent CHECK (
  (status IN ('completed','cancelled')) = (closed_at IS NOT NULL)
)
```

**`job_completions`** — 1:1, PK is `job_card_id`. The discount rule is enforced by the database, not by the service:

```sql
cost              numeric(12,2) NOT NULL CHECK (cost >= 0),
discount_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
discount_reason   text,
amount_collected  numeric(12,2) GENERATED ALWAYS AS (cost - discount_amount) STORED,
collection_mode   collection_mode NOT NULL,
business_date     date GENERATED ALWAYS AS (business_date(completed_at)) STORED,

CONSTRAINT completion_discount_bounded    CHECK (discount_amount <= cost),
CONSTRAINT completion_discount_justified  CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
CONSTRAINT completion_mode_coherent       CHECK ((cost - discount_amount) = 0 OR collection_mode <> 'none')
```

**A shortfall with no explanation is unrepresentable.** That is the point — the alternative is a silent gap between what was owed and what arrived at the handover, appearing weeks later as an unexplained variance.

**`completed_at` is the client's clamped `completedAt`, not `now()`.** This matters more than it looks: `business_date` is generated from it, so cash collected in a basement on Monday lands on **Monday**, whenever it syncs. That is correct — it puts the money on the day it was physically taken.

**`job_completion_parts`** — `line_no` unique within completion, `quantity numeric(10,2) CHECK (quantity > 0)`, `unit_cost` nullable, `from_customer_stock boolean`. **Recording parts does not change how `cost` is computed.** Anyone deriving `cost` from `SUM(quantity × unit_cost)` is reimplementing invoicing, which `PLAN.md` §4 rules out.

**`job_cancellations`** — `replacement_job_id → job_cards` nullable. Moving a job to a different day is **not** a cancellation; it is a `PATCH` of `scheduled_for`.

**`job_events`** — append-only, `bigint` identity, never updated, never deleted. `occurred_at` vs `recorded_at` is the offline seam.

Indexes from §5 — all of them, none extra.

**Tests**

`apps/api/test/integration/schema-jobs.test.ts`
- `cost 5000, discount 500, no reason` → **check violation**
- `cost 5000, discount 500, reason 'goodwill'` → accepted, `amount_collected` = 4500
- `cost 0, discount 0, mode 'none'` → accepted (the warranty job and the prepaid visit are the same shape)
- `cost 5000, discount 0, mode 'none'` → **check violation**
- `discount > cost` → violation
- `status 'assigned', assigned_to NULL` → violation
- `status 'completed', closed_at NULL` → violation
- `business_date` on a completion at `2026-03-14T20:30:00Z` is `2026-03-15`
- Same serial active at two customers → unique violation; deactivate one → allowed

**Done when**
- [ ] Every constraint above proven by a failing insert, not by reading the DDL
- [ ] `contract_visit_id` column exists and is nullable, with no FK yet
- [ ] All §5 indexes for these tables present, verified from `pg_indexes`

**If it fails**
Free window. Reset, edit in place, re-run. Nothing has deployed.

**Commits**
`chore(start): T1.1 stack and jobs schema` → `feat(db): migrations 006-007 — customer stack, job cards, completions, parts, events`

---

### T1.2 — Migrations 008–010: attachments, location, health view, cash

**Reads:** `PLAN-DATA-MODEL.md` §3.6, §3.8, §3.7, §4 (`v_employee_tracking_health`)
**Depends on:** T1.1
**Tier:** free until deploy

**Build**

**Migration 008 `attachments`** — polymorphic. `owner_type` includes `job_card` **and** `job_completion`: before-photos hang off the card, after-photos off the completion, which is a distinction worth having in the timeline. No FK on `owner_id`, deliberately — five nullable FK columns with an "exactly one is set" constraint is worse to query and no safer. Orphan cleanup is a nightly job (Phase 5).

**`signature` is a photograph, not a drawing.** `customer_signed` is a boolean the technician ticks. A signature drawn with a gloved finger in a stairwell is a scribble with no evidential value, and it costs a component on the highest-stakes screen in the product.

**Migration 009 `location`** — `location_pings`, `location_requests`, **and `v_employee_tracking_health`.**

`UNIQUE (employee_id, recorded_at)` is the important line: buffered batches retry after partial failure, and without it a technician surfacing from a basement double-writes his trail.

**Sizing: do not partition. Do not add PostGIS.** ~125k rows a year. A btree on `(employee_id, recorded_at DESC)` covers every query this app makes.

`v_employee_tracking_health` — last ping via `LATERAL`, minutes since, joined to the most recent Android device's diagnostics, resolving to one `health` value: `not_tracked` / `permission_missing` / `never_reported` / `stale` (>45 min) / `active`.

**This view ships here, in Phase 1, not with the Phase 2 ops views.** The chip is a Phase 1 deliverable *and* a Phase 1 exit criterion. It depends only on `employees`, `devices` and `location_pings`, all of which exist by 009.

`notifications_enabled` is carried through but **not folded into `health`** — a technician with notifications off is still tracking correctly, so collapsing it would either hide it or misreport a healthy device as unhealthy.

**Migration 010 `cash`** — `cash_reconciliations`, keyed on **`employee_id`**, `UNIQUE (employee_id, business_date)`. **No expense columns**, and that is a decision: the owner confirmed technicians do not spend from collections, so every variance in the queue is a real one.

Record the symptom in the migration comment in case that is ever wrong: it would appear as a **small, recurring shortfall for one particular employee**, never large, never for everyone.

**Tests**

`apps/api/test/integration/schema-location.test.ts`
- Duplicate `(employee_id, recorded_at)` → unique violation
- Latitude 91 → check violation
- `v_employee_tracking_health` returns `never_reported` for a technician with a device and no pings
- `permission_missing` when `devices.location_permission <> 'background'`, **even when recent pings exist** — permission state wins
- `stale` at 46 minutes, `active` at 44 — assert both sides of the boundary
- `not_tracked` for owner and dispatcher rows
- A **deactivated** employee does not appear at all

`apps/api/test/integration/schema-cash.test.ts`
- Second row for the same `(employee, business_date)` → unique violation
- `status 'disputed'` with no `owner_note` → check violation
- `status 'submitted'` with `confirmed_at` set → check violation

**Done when**
- [ ] Health view resolves all five values, each proven by a fixture
- [ ] The 45-minute boundary tested at 44 and 46
- [ ] No expense columns exist on `cash_reconciliations`

**If it fails**
A health view resolving the wrong value is the failure to take seriously, because the chip is the only thing standing between a dead tracker and nobody noticing. If `permission_missing` and `stale` disagree with the fixtures, fix the precedence — **permission state wins over ping recency, always**, because a device with revoked permission that pinged four minutes before the revocation is not healthy.

**Commits**
`chore(start): T1.2 attachments, location, cash` → `feat(db): migrations 008-010 — attachments, pings, tracking health view, cash handover`

---

## Part B — API

### T1.3 — Idempotency plugin

**Reads:** `PLAN-BACKEND.md` §3.2 · `PLAN-DATA-MODEL.md` §3.9
**Depends on:** T0.4, T0.6
**Parallel with:** T1.4
**Tier:** T2

**Build**

`plugins/idempotency.ts`, wrapping every `POST`/`PATCH`/`DELETE` from a mobile client. Five paths, each chosen against a specific failure:

1. `INSERT INTO idempotency_keys (...) ON CONFLICT DO NOTHING`
2. **Insert won** → run the handler in a transaction, store `response_status` + `response_body`, clear `locked_at`, return
3. **Insert lost, hash matches, response stored** → **replay the stored response verbatim.** Same status, same body. This is the reconnect case and must be indistinguishable from the original
4. **Insert lost, `request_hash` differs** → `422 IDEMPOTENCY_KEY_REUSED`. A client bug, and the one case where silently replaying would be actively wrong
5. **Insert lost, `locked_at` recent** → `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 2`

**The key row and the business rows commit in the same transaction.** If they did not, a crash between them would either lose the guard or record a response for work that rolled back.

`request_hash` is sha256 of `canonicalJson(body)` from `packages/shared`. **The multipart exception is T1.10** — attachments hash `fileChecksum + ownerType + ownerId + kind` instead, because a multipart stream's boundary changes between retries of the same file.

**Tests**

`apps/api/test/integration/idempotency.test.ts`
- Replay returns byte-identical status and body
- Same key, different body → 422
- **Two concurrent requests with the same key** → one applies, the other gets 409 with `Retry-After`. Run genuinely concurrently against the real pool
- A handler that throws leaves **no** idempotency row — proven by re-issuing the same key and seeing it execute
- Keys past `expires_at` are ignored by the prune query

**Done when**
- [ ] Concurrent-duplicate test is genuinely concurrent, not sequential
- [ ] Rollback leaves no orphan key row

**If it fails**
An orphan key row after a rollback means the insert is outside the transaction. That is the failure mode that turns one crash into a permanently-poisoned key, and it must be fixed here rather than worked around in the client.

**Commits**
`chore(start): T1.3 idempotency` → `feat(api): idempotency plugin with replay, hash mismatch and in-flight guards`

---

### T1.4 — Sequence allocation

**Reads:** `PLAN-DATA-MODEL.md` §3.9 · `PLAN-BACKEND.md` §2 (`lib/sequences.ts`)
**Depends on:** T0.4
**Parallel with:** T1.3
**Tier:** T2

**Build**

`lib/sequences.ts` — `allocateNumber('job' | 'sale' | 'payment' | 'contract')`, formatting `JC-2627-00042` from `next_in_sequence('job:2627')`. Fiscal year from the IST business date: FY starts 1 April, so `2627` is 1 Apr 2026 – 31 Mar 2027.

**Tests**

`apps/api/test/integration/sequences-format.test.ts`
- 31 Mar 2027 23:59 IST → scope `job:2627`; 1 Apr 2027 00:01 IST → scope `job:2728`, value `1`
- Zero-padding to five digits; the 100,000th does not truncate
- `parseSequence()` round-trips every prefix

**Done when**
- [ ] Fiscal-year boundary tested on both sides, in IST not UTC
- [ ] Implicit scope creation at rollover returns 1 (`PLAN-DATA-MODEL.md` open item 5)

**If it fails**
A fiscal-year test failing usually means the boundary was computed in UTC. The scope comes from the **IST** business date: a job created at 19:00 UTC on 31 March belongs to the *next* fiscal year, because it is already 00:30 IST on 1 April.

**Commits**
`chore(start): T1.4 sequences` → `feat(api): fiscal-year sequence allocation with IST boundary`

---

### T1.5 — Jobs module: reads and status transitions

**Reads:** `PLAN-BACKEND.md` §6.1 (status machine), §6.3 (endpoints) · `PLAN.md` §5
**Depends on:** T1.1, T1.3, T0.10
**Tier:** T2 · **Flag:** `tech.jobs`

**Build**

`modules/jobs/` as `routes.ts` / `service.ts` / `repo.ts`. This task ships `GET /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/status`.

**Response shape by role is three separate zod schemas** — `JobCardTechnician`, `JobCardDispatcher`, `JobCardOwner` — **not one schema with optional fields.** An optional field is a field that can leak; a separate schema cannot.

The status machine is imported from `packages/shared`, not re-implemented. `en_route` is skippable — a technician already on site should not have to lie to the app to start work.

`POST /v1/jobs/:id/status` takes `{ to, occurredAt }`. The server clamps `occurredAt`: not in the future, not more than 14 days old, and records the clamp in `job_events.payload` when it happens.

**Tests**

`apps/api/test/integration/jobs-status.test.ts`
- Every legal transition from §6.1 accepted
- Every illegal one refused with `409 ILLEGAL_TRANSITION`
- A technician cannot move a job assigned to someone else → `403 OUT_OF_SCOPE`
- `occurredAt` 20 days old is clamped and the clamp appears in the event payload

`apps/api/test/authz/jobs.test.ts`
- **A technician's `GET /v1/jobs/:id` response contains no `cost`, `discount_amount` or `amount_collected` — after his own completion.** Assert on the serialised body, not on the schema type

**Done when**
- [ ] Status machine fully enumerated, legal and illegal
- [ ] Technician payload proven money-free post-completion

**If it fails**
If a technician's payload carries money, **do not filter it at the serialiser.** Three separate response schemas exist so that leak is impossible by construction — find the shared schema someone reintroduced and split it again.

**Commits**
`chore(start): T1.5 jobs reads and status` → `feat(api): job reads with per-role schemas, status transitions`

---

### T1.6 — Completion

**Reads:** `PLAN-BACKEND.md` §6.2 · `PLAN-DATA-MODEL.md` §3.4
**Depends on:** T1.5
**Tier:** T2 · **Flag:** `tech.jobs`

**Build**

`POST /v1/jobs/:id/complete` — **one transaction**, eight steps:

1. Lock the job row (`SELECT … FOR UPDATE`); assert status is `in_progress`, `assigned` or `en_route`; assert actor is `assigned_to` or owner
2. Insert `job_completions`. **Database constraints enforce the discount rule; the service does not re-implement them** — it maps the constraint violation to a readable 422
3. Update `job_cards` → `completed`, `closed_at`
4. Insert `job_events` (`completed`, `occurred_at` from the client, `recorded_at = now()`)
5. Optional: upsert `customer_products` from `stackChanges[]`, each stamped `source_job_id`
6. Optional: insert `job_completion_parts` from `parts[]`. **These do not affect `cost`**
7. If the job is a contract visit, flip `contract_visits.status` — **Phase 2B; leave the hook and a test that skips**
8. Attachments arrive as separate requests; a completion is valid without them

**The warranty rule is a prompt, not a constraint.** With `customer_product_id` set, the *client* knows whether the unit is in warranty and raises a confirmation. The server does **not** force `cost` to zero, because out-of-scope work on an in-warranty unit is legitimately chargeable and a database rule that decided otherwise would be wrong on site.

**Tests**

`apps/api/test/integration/completion.test.ts`
- Discount without reason → **422 with a readable message**, not a 500 leaking the constraint name
- Warranty job `cost 0, discount 0, mode none` accepted
- Completing a `cancelled` job → `409 JOB_ALREADY_CLOSED` with a message naming who cancelled it and when
- `stackChanges[]` creates `customer_products` with `source_job_id` set, in the same transaction — assert both rows or neither
- **A completion with parts and one without produce identical money rows.** This is the test that stops someone deriving `cost` from a parts total
- Replaying the same idempotency key returns the identical body and creates no second completion

**Done when**
- [ ] Every constraint violation surfaces as a readable 422
- [ ] Parts proven not to alter `cost`
- [ ] Transactional atomicity proven by forcing a failure at step 5

**If it fails**
If a constraint violation reaches the client as a 500, the mapping layer is missing — not the constraint. Do not move the rule into the service.

**Commits**
`chore(start): T1.6 completion` → `feat(api): job completion with stack changes and parts in one transaction`

---

### T1.7 — Cancellation and rescheduling

**Reads:** `PLAN-BACKEND.md` §6.3 (cancelling with a date, rescheduling) · `PLAN-DATA-MODEL.md` §3.4
**Depends on:** T1.6
**Tier:** T2 · **Flag:** `tech.jobs`

**Build**

`POST /v1/jobs/:id/cancel` — `{ reasonCode, reasonNote, rescheduleTo? }`.

- **Ordinary job with a date** → creates a successor card in the same transaction, linked by `job_cancellations.replacement_job_id`. Same customer, same service, new date, `unassigned`
- **Ordinary job with no date** → simply cancelled
- **Contract visit** → Phase 2B. Leave the branch and a skipped test

**The technician makes this call, not the office.** He is the one who knows whether the customer said "come Thursday" or "don't bother". Routing it through a dispatcher means the decision is made hours later by someone who was not there.

**Rescheduling is a different operation:** `PATCH /v1/jobs/:id` of `scheduled_for` under `If-Match`, emitting a `rescheduled` event, leaving status alone. It always worked; it was never written down, and an unstated capability gets rebuilt as a special case.

**Nothing advances a job's date on its own.** An open job past its scheduled date surfaces as **Overdue**. Auto-advancing would hide the missed commitment the dispatcher screens exist to show.

`rescheduleTo` is bounded: not in the past.

**Tests**

`apps/api/test/integration/cancellation.test.ts`
- Cancel with a date creates exactly one successor, linked, `unassigned`, with a fresh job number
- Cancel without a date creates none
- `reason_code 'other'` without a note → check violation surfaced as 422
- A technician can cancel his own job; not another's
- `PATCH scheduled_for` emits `rescheduled` and **does not** change status or create a cancellation
- Stale `If-Match` → `409 VERSION_CONFLICT`

**Done when**
- [ ] Successor creation is atomic with the cancellation
- [ ] Reschedule and cancel proven to be distinct paths with distinct events

**If it fails**
If cancel and reschedule have merged into one code path, separate them before continuing. They produce different events, different rows, and different consequences for a contract visit in Phase 2B — a merged path gets untangled under pressure later.

**Commits**
`chore(start): T1.7 cancellation` → `feat(api): cancellation with optional successor, reschedule as a patch`

---

### T1.8 — Sync protocol: bootstrap, delta, batch

**Reads:** `PLAN-BACKEND.md` §7 in full · `PLAN-DATA-MODEL.md` §6
**Depends on:** T1.6, T1.7
**Tier:** T2 · **Flag:** `tech.offline`

**Build**

**`GET /v1/sync/bootstrap`** — the full role-scoped working set for a cold start: the actor's open and recently-closed jobs, the customers those jobs touch and their product stacks, active products and services. Returns `{ data, cursor }`. **Bounded by design** — a technician's set is tens of rows, not the whole database.

**`GET /v1/sync/delta?cursor=`** — rows in scope with `updated_at > cursor`, plus **tombstones**, plus a new cursor. Server caps the page and returns `hasMore`.

**The cursor is the server's `updated_at`, never the device clock.** A device with a skewed clock must not be able to skip records.

**Tombstones cover two cases and the second is the one that bites:**

```jsonc
"tombstones": [
  { "entity": "job", "id": "…", "reason": "deleted" },
  { "entity": "job", "id": "…", "reason": "out_of_scope" }
]
```

A job reassigned from Ravi to Anitha is not deleted and not inactive — it has simply stopped being Ravi's. A delta query that filters by scope before comparing cursors returns nothing about it, and Ravi's mirror keeps it forever: on his dashboard, in his day's count, openable, with a *Start job* button that 403s in front of a customer. **Nothing errors. The row just never leaves.**

So the delta query runs **twice**: once for rows in scope with a newer cursor, once for rows the actor previously held that are no longer in scope, bounded by the same window the bootstrap uses.

**A tombstone never deletes an outbox row.** If Ravi completed the job underground and it was reassigned while he was down there, the mirror loses the job and the outbox keeps the operation. The server decides on drain.

**`POST /v1/sync/batch`** — the outbox drain. Semantics, each chosen against a specific failure:

- **Ordered, not atomic.** One rejection must not roll back a day's other work
- **`dependsOn` short-circuits.** A rejected parent returns its child `skipped`, unattempted
- **Per-operation results**: `{ localId, outcome: 'applied' | 'duplicate' | 'rejected' | 'skipped', status, body?, error? }`. **`duplicate` is a success** — the idempotency layer replayed
- **Batch cap 50**
- **Always HTTP 200** if the envelope parsed. A 4xx on the batch itself means a malformed envelope, which is a client bug

**A unique violation on an offline create is a first-class outcome, not a 500** — `rejected` with `DUPLICATE_ENTITY` and `details.existing` naming the server's row.

**Tests**

`apps/api/test/integration/sync.test.ts`
- Bootstrap for a technician contains his jobs and **no other technician's**
- Delta with a cursor returns only newer rows; cursor is monotonic across calls
- **Scope exit**: reassign a job away → next delta carries an `out_of_scope` tombstone → **and his queued completion for it still exists**
- Soft-deleted customer arrives as a `deleted` tombstone
- Batch: `l_02 dependsOn l_01`, `l_01` rejected → `l_02` is `skipped`, not attempted
- Batch with one rejection applies the other four
- Batch of 51 → 422 on the envelope
- Every-ping-rejected batch still returns HTTP 200

**Done when**
- [ ] Scope-exit tombstone proven, **both halves** — row leaves the mirror, outbox row survives
- [ ] `dependsOn` short-circuit proven by asserting the child handler never ran
- [ ] Cursor monotonic under concurrent writes

**If it fails**
This is the highest-value task in the phase to get right. If the scope-exit query is expensive, bound it by the bootstrap window rather than dropping it — a stale job on a technician's phone is a wrong answer given to a customer.

**Commits**
`chore(start): T1.8 sync protocol` → `feat(api): bootstrap, delta with scope-exit tombstones, ordered batch drain`

---

### T1.9 — Location ingest

**Reads:** `PLAN-BACKEND.md` §8 · `PLAN.md` §7 · `PLAN-DATA-MODEL.md` §3.8
**Depends on:** T1.2
**Parallel with:** T1.10, T1.11
**Tier:** T2 · **Flag:** `tech.location`

**Build**

`POST /v1/location/pings` — batch of up to 200. Per-ping validation:

1. **Work window 09:00–19:00 IST, Monday–Saturday**, evaluated against `recorded_at`. The device already filters; the server checks again, because **a rule governing staff should not trust the device clock**
2. `recorded_at` not more than 5 minutes in the future, not older than 7 days
3. Coordinate ranges; `accuracy_m` above 2000 recorded but flagged
4. `ON CONFLICT (employee_id, recorded_at) DO NOTHING` — a retried batch is free

Response is per-ping: `{ accepted: n, rejected: [{ index, code }] }` with `PingRejectCode` values. **HTTP 200 even when every ping is rejected** — a rejected ping is a normal outcome, not a client error, and the client must clear its buffer on any of these rather than retry forever.

`POST /v1/devices` upserts by `(employee_id, installId)`, carrying the FCM token and the four diagnostics. Called on login, on foreground when permissions change, and after each ladder step. **This endpoint is how the health chip becomes truthful** — without a fresh `location_permission`, the chip can only report absence of pings, not the reason.

Rate limit: ping ingest 60/min per device.

**Tests**

`apps/api/test/integration/location-ingest.test.ts`
- A ping at 08:59 IST rejected `OUT_OF_WINDOW`; 09:01 accepted — **construct both from a UTC instant, so the test proves the IST conversion**
- A Sunday ping rejected regardless of hour
- 8 days old → `TOO_OLD`; 10 minutes in the future → `FUTURE`
- A duplicate `(employee, recorded_at)` → `DUPLICATE`, and the batch still returns 200
- **All 200 pings rejected → HTTP 200** with 200 entries in `rejected`
- `POST /v1/devices` twice with the same `installId` updates rather than duplicating

**Done when**
- [ ] Work-window boundaries proven on both sides in IST
- [ ] Fully-rejected batch returns 200

**If it fails**
If the client is retrying rejected pings forever, the response shape is wrong, not the client. `PingRejectCode` is deliberately not an `ErrorCode` for exactly this reason.

**Commits**
`chore(start): T1.9 location ingest` → `feat(api): ping batch ingest with server-side work window, device registration`

---

### T1.10 — Attachments

**Reads:** `PLAN-BACKEND.md` §9 · `PLAN-DATA-MODEL.md` §3.6
**Depends on:** T1.2, T1.3
**Parallel with:** T1.9, T1.11
**Tier:** T2

**Build**

`POST /v1/attachments` — **one multipart request** carrying the file, `ownerType`, `ownerId`, `kind`, `capturedAt`, `fileChecksum`, and an `Idempotency-Key`.

Single request rather than presign/PUT/confirm. **Three round trips on a flaky 2G connection is three chances to fail**, and the offline drain would have to reason about a half-created attachment. At 14 users the API can absorb the bytes. Presigned direct-to-storage is the documented scale path, not the starting point.

Server: validate MIME against `image/jpeg|png|webp` and `application/pdf`; re-encode JPEG to **max 1600px long edge** (a completion photo does not need 12 MP); compute sha256; write to `{ownerType}/{yyyy}/{mm}/{uuid}.{ext}`; insert the row.

**`request_hash` is defined differently here.** A multipart body has no JSON to canonicalise, and the boundary string changes between retries of the same file. So `request_hash = sha256(fileChecksum + ownerType + ownerId + kind)`. That also gives a free integrity check: bytes that do not hash to the client's `fileChecksum` were truncated on a bad link and are rejected rather than stored as a corrupt image nobody looks at until it matters.

`GET /v1/attachments/:id` — permission-checked, then a **302 to a 5-minute presigned URL. Never proxied** — that is the one place the API should not spend bandwidth.

**Tests**

`apps/api/test/integration/attachments.test.ts`
- 20 MB upload → 413 before the bytes are written
- A `.exe` renamed `.jpg` → rejected on sniffed MIME, not on extension
- A 4000px JPEG comes back at 1600px long edge
- Retrying with the same key and the same file replays; the same key with a **different** file → 422
- **Corrupted upload** (checksum mismatch) → rejected, and no object written
- `GET` as a technician for another technician's job's attachment → 403

**Done when**
- [ ] Checksum mismatch proven to leave no object in MinIO
- [ ] `GET` is a 302, never a proxy — assert on the status code and the absence of a body

**If it fails**
If uploads time out on a slow link, reduce the re-encode target before adding a presign step. The three-round-trip design was rejected for a reason, and reintroducing it here forces the outbox to reason about a half-created attachment.

**Commits**
`chore(start): T1.10 attachments` → `feat(api): single-request multipart upload, checksum-based idempotency, presigned reads`

---

### T1.11 — Cash handover

**Reads:** `PLAN-BACKEND.md` §10 · `PLAN-DATA-MODEL.md` §3.7 · `UI/plan-2/04-TECHNICIAN.md` §T6
**Depends on:** T1.2, T1.3
**Parallel with:** T1.9, T1.10
**Tier:** T2 · **Flag:** `tech.jobs`

**Build**

`POST /v1/cash/handovers` — `{ businessDate, declaredAmount, note }`, idempotent, unique per `(employee, date)`. **`businessDate` bounded: not in the future, not more than 7 days back.**

`PATCH /v1/cash/handovers/:id` — the declaring employee, `If-Match`, **only while `status = 'submitted'`.**

**That correction path is not a convenience.** Without it a technician who types ₹4,500 for ₹45,000 has no route at all: the row is unique per employee-day so he cannot resubmit, and *reopen* only returns a **confirmed** row to `submitted`, which his is already. The mistake would sit in the owner's queue as a ₹40,500 variance until someone confirmed a figure they could see was wrong — and a queue where variances are sometimes typos is a queue that gets skimmed.

The rule mirrors completion amendment exactly: **correctable until it is signed off, then it takes a deliberate second action.** Once `confirmed` or `disputed`, the `PATCH` is refused with `409 RECONCILIATION_CONFIRMED`. The prior amount goes to the audit trail.

`GET /v1/cash/handovers/me` — own history. **Response omits `expected_cash`.** He declares what he is handing over; the system's expectation is the check, and showing him the answer first turns a reconciliation into a form-fill.

The owner's queue is Phase 4. Between now and then technicians declare into a table nobody reads — which is correct, because the old process remains the record of truth during parallel run.

**Tests**

`apps/api/test/integration/cash-handover.test.ts`
- Second declaration for the same day → 409, not a duplicate row
- `businessDate` tomorrow → 422; 8 days ago → 422; 7 days ago → accepted
- `PATCH` while `submitted` succeeds and writes an audit row carrying the previous amount
- `PATCH` after `confirmed` → `409 RECONCILIATION_CONFIRMED`
- **`GET /me` response has no `expected_cash` key at all** — assert on key absence, not on a null value
- A technician cannot read another's handovers

**Done when**
- [ ] Amend-then-refuse cycle proven across both statuses
- [ ] `expected_cash` proven absent from the serialised body

**If it fails**
If `expected_cash` appears in the response, the handler is selecting from the queue view rather than the table. **That figure must not reach the employee before he declares** — showing him the answer first turns a reconciliation into a form-fill, and the check stops being a check.

**Commits**
`chore(start): T1.11 cash handover` → `feat(api): cash declaration with same-day amendment, expected figure withheld`

---

### T1.12 — Tracking health, self-scoped

**Reads:** `PLAN-BACKEND.md` §8 (health reads) · `PLAN-DATA-MODEL.md` §4
**Depends on:** T1.2, T1.9
**Tier:** T2 · **Flag:** `tech.location`

**Build**

`GET /v1/location/health/me` — technician and sales rep. Returns the actor's own `v_employee_tracking_health` row plus `notifications_enabled`, and **nothing about anyone else.**

This is the endpoint that is easy to miss. The chip is a Phase 1 deliverable and a Phase 1 exit criterion — it must have shown a **true red** in the field before the phase closes. Both the view and this endpoint are Phase 1 work, not Phase 4 work the chip borrows early.

**Tests**

`apps/api/test/authz/health.test.ts`
- Returns exactly one row, the actor's
- A technician cannot reach another employee's health by any path
- A dispatcher gets 403 on `/me` for a technician and **404 rather than 403** on a path that would enumerate — do not leak existence

**Done when**
- [ ] Single-row response proven for all four roles that can call it

**If it fails**
Small module; reset and rewrite. The one thing not to do under time pressure is reuse the owner's console query with a `WHERE employee_id = :actor` bolted on — that is one forgotten predicate away from every technician seeing the whole roster.

**Commits**
`chore(start): T1.12 self tracking health` → `feat(api): self-scoped tracking health endpoint`

---

## Part C — Mobile client

### T1.13 — SQLite mirror

**Reads:** `PLAN-FRONTEND.md` §4 (state layers), §5 · `PLAN-DATA-MODEL.md` §6
**Depends on:** T0.11, T1.8
**Tier:** T1 · **Flag:** `tech.offline`

**Build**

`expo-sqlite` mirror of the role's working set: jobs, customers, `customer_products`, products, services. Schema mirrors the server's shape but carries only what the role needs — a technician's mirror has no money columns to mirror, because the API never sent any.

**Dispatchers and owners get no SQLite at all.** Enforced by `roleCapabilities[role].offline`, checked once at provider setup, so **the module is never even initialised** for them. On Android they are on office wifi; their failure mode is a clear error state, not a queue.

Delta application: upsert by id, delete on tombstone (both reasons), advance the cursor **only after** the whole page applies.

**The mirror is cleared on user switch.** The outbox is filtered by `employee_id`, not wiped — those two rules disagree about a day's work on a shared handset, and T1.14 resolves it.

**Tests**

`apps/mobile/src/db/mirror.test.ts`
- Applying a delta page is atomic: a failure mid-page leaves the cursor unmoved
- A `deleted` tombstone and an `out_of_scope` tombstone both remove the row
- Bootstrap then delta produces the same state as bootstrap alone with the later data
- **A dispatcher session never opens the database** — assert the module was not imported

**Done when**
- [ ] Cursor advances only on a fully-applied page
- [ ] SQLite proven uninitialised for online-only roles

**If it fails**
A partially-applied page with an advanced cursor is **silent, permanent data loss on that device** — the rows it skipped will never be requested again. If atomicity is hard to achieve, apply the page inside one SQLite transaction and move the cursor as the last statement in it, rather than reconciling afterwards.

**Commits**
`chore(start): T1.13 sqlite mirror` → `feat(mobile): sqlite mirror with atomic delta application`

---

### T1.14 — Outbox and drain manager

**Reads:** `PLAN-FRONTEND.md` §5 in full · `PLAN-BACKEND.md` §7
**Depends on:** T1.13
**Tier:** T1 · **Flag:** `tech.offline`

> The single most important client task in the project. Read `PLAN-FRONTEND.md` §5 twice.

**Build**

The outbox table exactly as specified, **including `employee_id`** — a handset may be shared, and without that column "keep the rejected rows" and "clear the previous user's data" are the same operation pulling in opposite directions.

**Enqueue is synchronous with the optimistic write.** User acts → mirror updates → row enqueues → the UI already shows the new state. Nothing in the UI blocks on the network.

**`idempotency_key` is generated once, at enqueue, and reused across every retry.** Regenerating on retry defeats the entire server-side guard, and it is the single easiest mistake to make in this codebase.

**Drain triggers:** reconnect, app foreground, a 60-second timer while active, manual pull-to-refresh.

**Two passes per cycle**, because attachments cannot ride the JSON batch:

1. **JSON pass** — up to 50 ordered non-attachment operations to `/v1/sync/batch`
2. **Binary pass** — each attachment row whose `depends_on` is now `done` uploads individually to `/v1/attachments`, **sequentially**, each with its own key. A parent that is `rejected` or still `queued` means the child is skipped this cycle

Sequential rather than parallel because these upload from a van on 2G, and three concurrent 2 MB requests on a bad link fail slower than three sequential ones.

**The delta call happens after both passes**, so the cursor reflects the attachments too.

Per-outcome handling per the table in §5. The three that matter:

- `duplicate` → mark **done**. A replay is a success
- `rejected` → mark rejected, **keep the local record**, raise a banner
- `401` → refresh once, retry once; if refresh fails, pause the drain and prompt re-login — **never discard queued items**

**Logout is a gate.** Blocked while any row is `queued` or `inflight`; the button reports "3 items not yet synced" and offers *Retry now*. **There is no confirm-and-lose path**, because the technician tapping it is tired and about to hand the phone over. If only `rejected` or `failed` rows remain, logout proceeds and those rows are **kept**, keyed to him.

**Tests**

`apps/mobile/src/sync/outbox.test.ts` — fake timers + MSW
- **The idempotency key is byte-identical across five retries.** The single highest-value assertion in the client
- Backoff is `2^n` capped at 5 minutes
- `dependsOn` parent rejected → child stays `queued` and is never sent
- 401 → refresh → retry once → success, with **nothing discarded**
- 401 → refresh fails on a network error → queue intact, session intact
- Attachment rows are excluded from the JSON batch and sent individually afterwards
- Attachment whose parent is `rejected` is not sent

`apps/mobile/src/sync/logout.test.ts`
- Logout blocked with one `queued` row; the count in the message is correct
- Logout allowed with only `rejected` rows, and those rows **survive**
- After a user switch, employee A's rejected rows are **invisible to employee B** and reappear for A

**Done when**
- [ ] Key stability proven across retries — this is the phase's named unit gate
- [ ] Logout gate proven in both directions
- [ ] Rejected rows proven to survive a user switch and stay scoped

**If it fails**
If the key is being regenerated, it is almost certainly because the retry path rebuilds the request object. Store the key **on the row**, not in the request builder.

**Commits**
`chore(start): T1.14 outbox drain` → `feat(mobile): outbox with two-transport drain, key stability, logout gate`

---

### T1.15 — Cold start with no signal

**Reads:** `PLAN-FRONTEND.md` §5.1
**Depends on:** T1.13, T1.14
**Tier:** T1

**Build**

Wire the non-blocking bootstrap from T0.11 to the now-existing mirror. **The app must open, authenticate against what it already has, and render the mirror with no network at all.** This is not an edge case — the first thing a technician does some mornings is open the app in a lift lobby, and the access token expired hours ago.

Fonts and tokens are bundled, not fetched. The splash gate waits on `expo-font` loading local assets and nothing else.

**Tests**

`apps/mobile/e2e/cold-start-offline.yaml` (Maestro, on device)
- Airplane mode on, app killed, access token expired → app opens to the technician's dashboard showing yesterday's mirrored jobs, **no login screen**, pending badge intact

**Done when**
- [ ] Green on a real device with the radio genuinely off

**If it fails**
Look for an awaited refresh in the layout's effect chain. The fix is to make the refresh lazy, never to shorten the splash.

**Commits**
`chore(start): T1.15 offline cold start` → `feat(mobile): render mirror on cold start with no network`

---

### T1.16 — Location task and the permission ladder

**Reads:** `PLAN-FRONTEND.md` §6 in full · `PLAN.md` §7 · `UI/plan-2/08-SHARED-SCREENS.md` §X4
**Depends on:** T1.9, T1.12, T0.14
**Tier:** **T3** — batch this APK
**Flag:** `tech.location`

**Build**

**Task registration at module scope.** This is a requirement, not a style choice: it must be registered before the OS can revive the app into it.

```
accuracy: Accuracy.Balanced          // ample for "where is this technician"
timeInterval: 15 * 60 * 1000
distanceInterval: 100
deferredUpdatesInterval: 15 * 60 * 1000
foregroundService: { notificationTitle, notificationBody, notificationColor }
pausesUpdatesAutomatically: false
```

The foreground service with its persistent notification is the only configuration that survives on Android 8+. `High` accuracy is reserved for on-demand fixes.

**The client does not fight OS jitter.** No compensating timer, no treating drift as failure. The 45-minute staleness threshold exists to absorb exactly this, and fighting the batching costs battery for nothing.

**Work-window filter on device**, before buffering. Filter, don't schedule: the task stays alive and out-of-window fixes are discarded locally. The server checks again independently.

**Buffering** to a local SQLite table, uploading in batches of up to 200. The buffer is pruned on server acknowledgement **including rejections** — an `OUT_OF_WINDOW` ping is done, not pending.

**The permission ladder, four steps, each its own screen, resumable, showing `Step 2 of 4`:**

1. **Foreground location** — in-flow prompt
2. **Background location** — **cannot be requested in-flow on Android 11+.** A screen explains why, quotes the Android wording verbatim (*Tap **Permissions** → **Location** → **Allow all the time***), then `Linking.openSettings()`. The app polls on foreground return and advances automatically — **the user should never have to tell the app they did it**
3. **Battery optimisation** — `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
4. **OEM autostart** — manufacturer-detected deep link plus **a screenshot walkthrough per vendor**, ending in an *"I've done this"* confirmation that posts `autostart_confirmed`, because there is no API to verify it

**Step 4 cannot be written from documentation.** Xiaomi, Realme, Vivo, Oppo and OnePlus each hide autostart somewhere different and the paths change between OS versions. This is why Phase 1 entry requires borrowing one of each.

**Notification permission comes after the ladder, not inside it.** Android 13+ runtime prompt, needed for assignment alerts rather than tracking. Placed after step 4 so a refusal cannot strand someone mid-ladder. A refusal is not fatal — tracking is unaffected and the fourth chip state reports it.

Each completed step posts to `/v1/devices` immediately.

**`location/` is `.native.ts` only.** The web bundle has no counterpart file and never imports one.

**Tests**

`apps/mobile/src/location/window.test.ts`
- 08:59 and 19:01 IST discarded; 09:00 and 18:59 buffered; Sunday discarded
- Buffer pruned on a response containing only rejections

`apps/mobile/src/location/ladder.test.tsx`
- Ladder resumes at the failed step, not from the start
- Step 2 polls on foreground and advances without user action
- Each step posts to `/v1/devices` on completion

Manual, per handset: overnight survival, basement gap recovery.

**Done when**
- [ ] Ladder resumable and self-advancing on return from settings
- [ ] **Autostart screenshots captured for every OEM in the roster** — real photographs, not placeholders
- [ ] Buffer prunes on rejection

**If it fails**
T3 — a new APK and a reinstall for every member of staff. **Batch it; do not ship it alone.** If tracking proves unusable on the majority of handsets after genuine mitigation, take the pre-decided descope: ship without continuous background tracking, keep on-demand *Locate now*, add a manual "I'm on site" check-in, and move continuous tracking to a Phase 5 spike. That is a real option, not a consolation — jobs, offline completion, cash handover and the stack are the majority of the value and none of them depend on a ping every 15 minutes.

**Commits**
`chore(start): T1.16 location task and ladder` → `feat(mobile): foreground-service tracking, buffered upload, four-step permission ladder`

---

## Part D — Screens

All five universal states are defined on every screen (`UI/plan-2/08-SHARED-SCREENS.md` §X5). Density `field`. **No screen here shows a loading spinner for its own content** — every one reads the local mirror, and a skeleton there would be a lie about the architecture.

### T1.17 — T1 Dashboard, T2 Jobs

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T1, §T2 · `UI/plan-2/02-MOTION.md` §6
**Depends on:** T1.13, T1.14, T0.13
**Tier:** T1 · **Flag:** `tech.jobs`

**Build**

**T1 Dashboard.** Worst moment: 09:05, sunlight through a windscreen, engine running, phone in one hand.

- **Three figures only** — today's open, done today, overdue. `display` 32 Condensed, tabular. **Not six. Not a chart.**
- **Tracking health chip**, always visible, tappable into the ladder when red or amber
- **NEXT** — the single next job as a full `JobCard` with *Navigate* (secondary) and *Start job* (primary, **the screen's one accent**)
- **LATER TODAY** — compact rows
- Pull to refresh drains the outbox; the `PendingBadge` is the indicator, **not a platform spinner**

Motion: figures count up from zero **on first focus only**, 380ms, tabular so nothing reflows. On subsequent focus they are already correct. The NEXT card does not animate in.

**Offline: no banner.** The mirror is the source, and permanent "offline" chrome trains people to ignore it. Only a *failed drain* raises anything.

**Not on this screen:** no revenue, no charts, no team activity, no motivational copy, **no earnings figure** — that is where the read-back temptation lands first.

**T2 Jobs.** Three tabs: Today · Upcoming · Completed. FlashList, `estimatedItemSize` from a measured row, `renderItem` hoisted and memoised.

Sort: Today by `scheduled_for` ascending, **overdue first**.

**A search field appears only when the tab holds more than 12 jobs.** A technician with six does not need search, and an always-present empty field is clutter he scrolls past.

**Rejected state:** the card **keeps its real status rail** and takes the `stale` dashed inset in `feedback.danger`, plus a one-line reason. The rail is not repainted red — `cancelled` is already `#B3261E`, so a red rail would make a rejection read as an office cancellation, and the technician cannot tell which from a colour.

Motion: tabs slide the accent underline 220ms, content cross-fades 140ms. **No stagger, no entrance animation** — except a card arriving from a sync, which animates in at 140ms because that means "this is new".

**Tests**

`apps/mobile/src/screens/technician/dashboard.test.tsx`
- Three figures, tabular, from the mirror with no fetch
- Offline renders **no banner**
- Count-up runs once; a second focus renders final values immediately
- No element renders a currency symbol

`apps/mobile/src/screens/technician/jobs.test.tsx`
- Search absent at 12 jobs, present at 13
- Overdue sorts first within Today
- A rejected job keeps its status rail colour and gains the danger inset

**Done when**
- [ ] **Zero dropped frames scrolling 200 job rows** on the roster's slowest handset
- [ ] No money rendered anywhere in either screen's tree

**If it fails**
Dropped frames on the job list are almost always an inline `renderItem` arrow function or a missing `estimatedItemSize`. Fix those before reaching for memoisation. If the count-up is janky, **delete it** — it is the one piece of motion on these screens that is not load-bearing.

**Commits**
`chore(start): T1.17 dashboard and jobs` → `feat(mobile): technician dashboard and job tabs`

---

### T1.18 — T3 Job detail and the status stepper

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T3 · `UI/plan-2/02-MOTION.md` §5.1 · `UI/plan-2/03-COMPONENTS.md` (`StatusStepper`, `StatusPill`)
**Depends on:** T1.17
**Tier:** T1 · **Flag:** `tech.jobs`

**Build**

Layout per §T3. The **docket header** — job number in mono, top right, always the same place — is one of the five signature tells.

- **Stepper at the top.** Position in the day's work is the first thing
- **The unit** with serial. The warranty chip carries the expiry date
- **Contract chip** when present — the word **prepaid** is the load-bearing part
- **Call** dials; **Navigate** deep-links `google.navigation:q=lat,lng`. **There is no map in the technician app**
- **Timeline** from `job_events`, collapsed, `occurred_at` times

**The stepper is the hero and the one orchestrated moment in the product** (`PLAN.md` §9). 520ms total: segment fill 0–320ms `enter`; node pop 240–400ms `spring.press`; the card's rail cross-fades 0–520ms; the next label fades in 320–460ms. `Light` haptic on advance, `Success` on reaching completed.

`en_route` renders **dimmed-but-present** rather than being removed — a technician who went straight to work should see he skipped a step, not a stepper that silently changed shape.

**Cancelled is a fifth rendering, not a fifth node.** The stepper freezes at the node the job reached, everything after goes `slate.200`, and a terminal cap replaces the trailing segment with the word **Cancelled**. The frozen position is the information: *cancelled after arriving* and *cancelled before setting off* are different events. **No animation** — nothing was achieved, so nothing fills.

**Never on this screen:** no amount, ever, after completion. No edit — a technician advances a job, he does not edit it.

**Tests**

`apps/mobile/src/screens/technician/job-detail.test.tsx`
- Stepper renders four nodes with `en_route` dimmed when skipped
- A cancelled job freezes at its reached node and renders the terminal cap with no fill animation
- Post-completion, the tree contains **no** `cost`, `amount` or `₹`
- Rejected state pins a banner under the header carrying the server's `message` **verbatim**, with *Discard my copy* and *View the office version*

**Done when**
- [ ] Stepper runs at 60fps on the slowest roster handset — measured, not assumed
- [ ] The two rail states that fail the 3:1 non-text floor (`in_progress`, `en_route`) always render beside their status **word** (`UI/plan-2/01-FOUNDATIONS.md` §1.6)

**If it fails**
If the stepper drops frames, confirm it runs as a Reanimated worklet on the UI thread and animates only `transform` and `opacity`. This is the one orchestrated moment in the product; **a stepper that stutters is worse than no stepper**, and reducing it to an instant state flip is a legitimate fallback while the cause is found.

**Commits**
`chore(start): T1.18 job detail` → `feat(mobile): job detail with the status stepper hero`

---

### T1.19 — T4 Complete sheet

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T4 · `PLAN-FRONTEND.md` §9 · `UI/plan-2/03-COMPONENTS.md` (`Sheet`, `MoneyGate`, `PartsList`)
**Depends on:** T1.18, T1.6
**Tier:** T1 · **Flag:** `tech.jobs`

> **The highest-stakes screen in the product.** Filled one-handed, in poor light, possibly gloved, by someone who wants to leave, sometimes at 8% battery.

**Build**

**One screen. No wizard. No page two.**

Order: Work done → **Amount collected** → *+ Add discount* → **Paid by** → Parts & equipment / Photos → *Customer confirmed the work* → submit.

**`MoneyGate` takes a required `action` prop.** `<MoneyGate action="create">` around the amount and collection mode. A gate defaulting to `read` would hide the amount field from the technician filling it in, because his `job.money` read scope is `none` — the component doing exactly what it was built to prevent, on this screen, and looking correct in review.

**Three conditional behaviours:**

- **Prepaid contract visit** → the amount field and the Paid-by segments are **absent**. Not zero, not disabled. The `ContractChip` reading "prepaid" sits in their place. A field showing ₹0 invites a tap, and the server rejects a non-zero cost on a prepaid visit anyway. *(Phase 2B fills the condition; build the branch now.)*
- **Amount after discount is zero or empty** → the Paid-by segments are replaced **in place** by a single non-interactive line reading **"No payment taken"**, and `collection_mode: 'none'` is submitted. A warranty job forced to record *paid by cash* puts ₹0 of phantom cash into that technician's reconciliation.
- **In-warranty unit with a charge** → one confirmation on submit: *"This unit is under warranty until 14 Mar 2027. Charge anyway?"* A prompt, not a block. **The only dialog on this sheet**, which is what keeps it meaningful — a technician who dismisses two dialogs a day dismisses this one without reading it.

**Three segments, not five.** `bank_transfer` does not happen at a doorstep; `none` is a consequence, not a choice.

**Parts & equipment is one list, not two.** A battery he just fitted is both a part used and equipment fitted, and two sections means entering it twice or guessing. One list, one extra question per line: **"Add to this site's equipment"**, defaulting **on** for `ups`/`battery`/`inverter` and **off** for `accessory`/`spare` and free-text lines. One UI list still produces both server arrays — `parts[]` and `stackChanges[]` — because *consumed on this job* and *standing at that site* are different facts.

**Never a subtotal.** Ever. Below the amount, never above.

**Motion.** Rises **from the button that opened it**, `spring.sheet` 300ms, **stepper still visible above** — which needs ~140pt of context strip, not the 64pt minimum. Submit: button to `loading`, sheet dismisses at 220ms, `NotificationSuccess` **when the outbox confirms, not on tap** — the honest signal is delivery, not intent.

**Never:** never disable submit for a network reason. Never require a photo — a technician in a dark basement with a cracked camera still needs to close the job. Never a second page. Never show the expected-cash figure.

**Tests**

`apps/mobile/src/screens/technician/complete.test.tsx`
- Amount emptied → Paid-by replaced by "No payment taken"; submitted payload carries `collection_mode: 'none'`
- Discount disclosure opens amount **and** reason together; submit blocked without a reason
- In-warranty + charge raises **exactly one** confirmation
- Parts list renders **no subtotal** and changes no figure
- A `battery`-category line has the equipment checkbox **on** by default; an `accessory` line **off**
- One list produces both `parts[]` and `stackChanges[]` in the payload, with only ticked lines in the latter
- Submit is enabled with the network down
- Success haptic fires on outbox confirmation, not on tap
- Prepaid branch hides amount **and** Paid-by

**Done when**
- [ ] Every conditional branch proven
- [ ] Sheet leaves the stepper visible — assert the stepper is in the tree and unobscured
- [ ] Usable one-handed at 200% dynamic type without clipping

**If it fails**
This screen gets more review than any other. If a behaviour is ambiguous, re-read §T4 rather than choosing — every line of it is a decision someone already argued.

**Commits**
`chore(start): T1.19 complete sheet` → `feat(mobile): completion sheet with unified parts list and conditional money fields`

---

### T1.20 — T5 Cancel sheet

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T5 · `PLAN-BACKEND.md` §6.3
**Depends on:** T1.19, T1.7
**Tier:** T1 · **Flag:** `tech.jobs`

**Build**

Reason code as **large tappable rows, not a dropdown**. Note required for `other`. **Reschedule to** — a date picker, skippable.

This is where a wasted trip gets recorded. The technician standing at a locked gate is the only person who knows whether the customer said "come Thursday" or "don't bother".

Choosing a date reveals a one-line confirmation: *"Visit moves to 22 Mar."*

**The contract warning is Phase 2B**, but build the slot now: above the date picker, in `body` not `caption` —

> **Skipping without a date spends one of this customer's 4 visits.**

**This is the one place in the app where a technician is warned about a default** rather than trusted to know it, because the consequence is invisible and lands on the customer.

**Tests**

`apps/mobile/src/screens/technician/cancel.test.tsx`
- `other` without a note blocks submit
- A past date is refused with a message, not silently clamped
- Choosing a date renders the confirmation line with the formatted date
- Reason rows are ≥52pt

**Done when**
- [ ] Contract warning slot exists and renders nothing pre-2B

**If it fails**
T1 republish. The risk on this screen is the opposite of a crash: a technician who skips the reschedule when the customer *did* ask for one. That is a copy failure, not a code failure, and it is only visible in the field — carry it into T1.23 as something to ask about.

**Commits**
`chore(start): T1.20 cancel sheet` → `feat(mobile): cancel sheet with reason codes and optional reschedule`

---

### T1.21 — T6 Cash handover, T7 Profile

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T6, §T7 · `PLAN-FRONTEND.md` §5 (logout gate), §6 (health chip)
**Depends on:** T1.11, T1.12, T1.16
**Tier:** T1 · **Flag:** `tech.jobs`

**Build**

**T6 Cash handover** — its own tab, not a row inside Profile. Touched once a day, at the end of a shift, by someone who wants to leave; a screen two taps deep at that moment is a screen that gets skipped, and a skipped handover is the `missing_submission` row the owner's whole queue exists to catch.

Date (today, changeable back 7 days) · **one large `MoneyField`** · optional note · *Submit declaration*. Below: his own history with status pills.

**The two absences, both deliberate:** no expected figure, no expenses field.

**States:** already submitted and not yet acted on → the amount, the status pill, and an **Amend** action. Confirmed or disputed → read-only, with copy saying why: *"The office has confirmed this day. Ask the owner to reopen it."*

**T7 Profile** — worst moment: the owner has just asked why his location stopped updating at 11:00.

`TrackingHealthChip` prominent, four states, red and amber deep-linking into the ladder **at the failed step**. Then the ladder as four rows with individual state, pending sync count, app version, device model, *Change password*, *Log out*.

**Never animate the chip.** A pulsing red chip would run continuously on the device whose battery this app is trying to protect.

**Logout is a gate**, per T1.14. The button reports the count and offers *Retry now*. There is no confirm-and-lose path.

Motion: ladder rows resolve with a 140ms colour change and a checkmark scale-in on return from settings — **the one place a small celebratory beat is earned**, because the user just completed something genuinely tedious.

**Not on this screen:** no earnings, no performance stats, **no ranking of technicians against each other**. `PLAN.md` §11 names employee reaction to tracking as a live risk, and gamified surveillance is the fastest way to realise it.

**Tests**

`apps/mobile/src/screens/technician/handover.test.tsx`
- No `expected` figure anywhere in the tree
- Amend visible while `submitted`, absent when `confirmed`, with the explanatory copy present
- Date picker refuses 8 days back

`apps/mobile/src/screens/technician/profile.test.tsx`
- All four chip states render; red and amber are tappable and route to the failed ladder step
- The chip has no animation driver attached
- Logout blocked with a queued row, and the count matches

**Done when**
- [ ] Chip renders all four states from real view data
- [ ] Logout gate proven on device, including an end-of-shift handover

**If it fails**
If the logout gate blocks when nothing is queued, check that `rejected` and `failed` rows are excluded from the blocking count — they are kept deliberately and must not trap someone at the end of a shift. **A gate that cries wolf gets worked around**, and the workaround is a factory reset.

**Commits**
`chore(start): T1.21 handover and profile` → `feat(mobile): cash handover with amendment, profile with health chip and logout gate`

---

## Part E — Gates

### T1.22 — Job Logs prototype (side quest)

**Reads:** `PLAN-FRONTEND.md` §9 (dispatcher), open item 1 · `UI/plan-2/05-DISPATCHER.md` §D2 · `PLAN-EXECUTION.md` Phase 2 entry
**Depends on:** T1.17
**Parallel with:** everything in Part D
**Tier:** throwaway

**This is a Phase 2 entry gate, built in Phase 1's spare capacity.** `PLAN.md` §11 names Job Logs on a phone as the one screen where the phone-first decision costs something real.

**Build** a throwaway prototype: `console` density, 56pt two-line rows, sticky `FilterBar`, FlashList, **200+ real-shaped jobs** — not six.

**Tests** — the measurement *is* the test, and it runs on people rather than code:

*A dispatcher answers "who has the Kormangala jobs today" in under five seconds, on a phone.* Two real dispatchers, their own handsets, five trials each, stopwatch. **Record every raw time, not just the median** — a median of 4s hiding two 9-second outliers is a screen that fails on the calls that matter.

Also record how they got there (filter chips or search) and what they reached for first. That says which affordance to enlarge if the number is close.

**Done when**
- [ ] **Median under 5 seconds**, written down with the raw times
- [ ] Zero dropped frames scrolling 200 rows

**If it fails**
Take the descope **before Phase 2 starts, not during**: give dispatchers the desktop web build, pulling `NavShell`'s rail and `DataTable` forward by two phases. Budget **+2 weeks** and note it as a deviation from `PLAN.md` §1 requiring the owner's sign-off. The fallback within phone-first is a compact two-line row at 44pt.

**Commits**
`chore(start): T1.22 job logs prototype` → `chore(spike): job logs prototype at 200 rows, timings recorded`

---

### T1.23 — Parallel run and phase exit

**Reads:** `PLAN-EXECUTION.md` Part I §4, Phase 1 exit criteria
**Depends on:** all of Phase 1
**Tier:** T0 per flag

*Checklist rewritten for the online-only app on 2026-09-15; the run is still pending.*

**Build** nothing. **Run the app in the field and measure.**

**2 weeks, 2 technicians, then 1 week all 8.** The old process remains the record of truth. Cutover is a separate, announced decision, and the owner can call it off.

**Tests** — the field is the test. Collect daily: ping delivery per handset, failed submits by error code (and *not reached* counts), and **any moment a technician fell back to paper**. The last is qualitative and is the most useful thing in the set.

**Done when** — all of the following, measured over the final week, numbers written down:

- [ ] **Ping delivery ≥ 90%** of expected in-window pings on the two field handsets
- [ ] **Submit failure rate < 2%**, excluding legitimate conflicts (office cancellations)
- [ ] **Zero duplicate job cards** attributable to replay
- [ ] **Zero completions with an unexplained shortfall** — the constraint held in the field, not just in tests
- [ ] Both technicians completed a full day **without falling back to the old process**
- [ ] **Basement recovery observed in the wild** — a gap that filled in on reconnect rather than staying a gap
- [ ] **The health chip showed a true red at least once and the technician acted on it.** A chip that has only ever been green is untested
- [ ] **No submitted work silently lost** — every failed submit was seen and retried or recorded, including across at least one deliberate end-of-shift handset handover
- [ ] **The *No connection* screen seen in the wild at least once**, and the half-typed sheet was intact when signal returned
- [ ] Parts recorded on real completions, and **no technician asked why the amount did not change** — if anyone did, the sheet implies a bill it does not produce

**If it fails**

Nothing here is undone by reverting a branch — the app is on people's phones and the flags are the instrument. Match the symptom to the tier, and **turn one thing off at a time** so the next day's data means something:

| Scenario | Tier | Action |
|---|---|---|
| A technician screen is wrong | T0 | `tech.jobs` off for that person |
| Submits failing in the field | T0 | `tech.jobs` off for that person; the old process resumes, and nothing is stored on the phone to recover |
| Location draining battery | T0 | `tech.location` off; server stops accepting, device stops the task on next foreground |
| Logic bug in the app | T1 | previous EAS update, ~5 min |
| API bug | T2 | previous image, ~2 min |
| `expo-location` config wrong | **T3** | new APK — batch it, never alone at 5pm on a Friday |
| Bad completion data | T4 | compensating record via `job_events`, never an `UPDATE` that erases history |

**Commits**
`chore(start): T1.23 parallel run` → `docs(ops): phase 1 exit criteria measured and recorded`
