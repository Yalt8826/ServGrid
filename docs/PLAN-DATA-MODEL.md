# Data Model — Implementation Plan

Companion to `PLAN.md`. This turns §4 into a buildable specification: every table, every constraint that carries a business rule, every derived view, and the order the migrations land in.

Nothing here overrides `PLAN.md`. Where `PLAN.md` left something open, this document proposes a resolution and marks it **[resolves]** so it can be argued with.

**Conventions**
- Postgres 15+. Money is `NUMERIC(12,2)`, line totals `NUMERIC(14,2)`.
- All timestamps `timestamptz`. Business dates are the Asia/Kolkata calendar day.
- Primary keys are `uuid` (`gen_random_uuid()`) except append-only logs, which use `bigint` identity.
- Every mutable table carries `version integer`, `created_at`, `updated_at`. `version` drives optimistic concurrency for offline sync.
- Soft delete via `is_active boolean`, never `DELETE`.

---

## 1. Migration order

Migrations are numbered and forward-only. This ordering respects FK dependencies and matches the build phases in `PLAN.md` §10.

| # | Migration | Contents | Phase |
|---|---|---|---|
| 001 | `extensions_and_helpers` | `pgcrypto`, `citext`, `business_date()`, `touch_updated_at()` | 0 |
| 002 | `enums` | All 18 enum types up front — cheap, and avoids scattering them | 0 |
| 003 | `identity` | `employees`, `refresh_tokens`, `devices`, `consents` | 0 |
| 004 | `sync_plumbing` | `idempotency_keys`, `sequences`, `next_in_sequence()` | 0 |
| 005 | `reference_data` | `companies`, `customers`, `products`, `services` | 0 |
| 006 | `customer_products` | Product stack at each site | 1 |
| 007 | `jobs` | `job_cards`, `job_completions`, `job_cancellations`, `job_events` | 1 |
| 008 | `attachments` | Polymorphic attachment table | 1 |
| 009 | `location` | `location_pings`, `location_requests` | 1 |
| 010 | `cash` | `cash_reconciliations` | 1 |
| 011 | `sales` | `sales_cards`, `sales_card_items`, `payments` | 3 |
| 012 | `views_money` | `v_sales_card_totals`, `v_company_balances`, cash views | 3 |
| 013 | `views_ops` | `v_job_cards_dispatcher`, `v_technician_load`, `v_employee_tracking_health` | 2–4 |
| 014 | `grants_hardening` | Optional `servgrid_dispatcher` role (§7) | 5 |

Migrations 006–010 land in Phase 1 even though only the technician app consumes them, because the technician app is the thing that exercises offline sync and location while scope is still small.

**Tooling.** `node-pg-migrate`, plain SQL files, run from `apps/api` on boot in dev and as a separate release step in prod. No ORM migrations — the schema carries too many `CHECK` constraints and generated columns for an ORM's DSL to express honestly.

---

## 2. Two helpers everything else leans on

**`business_date(timestamptz) → date`** returns `(ts AT TIME ZONE 'Asia/Kolkata')::date`.

Declared `IMMUTABLE` so it can appear in generated columns and index expressions. This is technically a lie — the tz database can change — but Asia/Kolkata has had no transition since 1945 and none is proposed. The alternative is storing a redundant `business_date` column the application must remember to set, which is the class of bug this whole model is trying to avoid. **Document the assumption in the migration comment.**

**`touch_updated_at()`** trigger sets `updated_at = now()` and increments `version` on every `UPDATE` where the caller did not already change it. Attached to every mutable table. `updated_at` is indexed on the sync-relevant tables and is the cursor for delta sync.

---

## 3. Table-by-table specification

### 3.1 Identity

**`employees`** — `id`, `username citext UNIQUE` (shape-checked `^[a-z0-9._-]{3,32}$`), `password_hash` (argon2id), `full_name`, `phone`, `role employee_role`, `is_active`, `must_change_password`, `created_by → employees`, `last_login_at`.

Owner-created only. No self-registration, no email, no password reset flow — 14 people, the owner resets it. `must_change_password` defaults true so the owner can hand over a temporary credential.

**`refresh_tokens`** — `token_hash UNIQUE` (sha256 of the opaque token), `employee_id`, `device_id`, `issued_at`, `expires_at`, `revoked_at`, `replaced_by → refresh_tokens`, `user_agent`.

Rotation on every use: the old row gets `revoked_at` and `replaced_by`. Reuse of a revoked token revokes the whole chain — cheap detection of a stolen token on a shared handset.

**`devices`** — one row per install, `UNIQUE (employee_id, install_id)`. Carries `fcm_token` for *Locate now*, and the diagnostics that make OEM background-kill debuggable: `manufacturer`, `model`, `os_version`, `app_version`, `location_permission`, `battery_opt_exempt`, `autostart_confirmed`, `notifications_enabled`, `last_seen_at`.

Those four boolean/enum diagnostics are not decoration. `PLAN.md` §11 names OEM task-killing as the dominant risk; without a per-handset record of which mitigations were actually completed, a "tracking stopped" report is unfalsifiable.

**`consents`** — `employee_id`, `kind` (`location_tracking`), `version` (a date string), `accepted_at`, `device_id`, `ip_address`. `UNIQUE (employee_id, kind, version)`.

Versioned so a reworded consent screen requires re-acceptance. This is the DPDP Act evidence trail from `PLAN.md` §7.

### 3.2 Reference data

**`companies`** — B2B accounts the sales reps sell to. Dues accrue here. `name`, `contact_person`, `phone`, `email`, address fields, `gstin`, `notes`, `is_active`. Case-insensitive unique name among active rows.

**`customers`** — service recipients. `name`, `phone NOT NULL`, `alt_phone`, address fields, `latitude`/`longitude` (paired — `CHECK ((latitude IS NULL) = (longitude IS NULL))`), `notes`, optional `company_id`.

**[resolves]** `PLAN.md` does not say whether customers and companies are related. They are distinct parties: jobs are for customers, sales are to companies, and `customers.company_id` is a *context* link only (this site belongs to that corporate account). It creates no financial relationship, consistent with "no customer credit". If a corporate site later needs its jobs billed to the company account, that is a new feature, not a nullable column doing double duty.

**`products`** — `sku UNIQUE`, `name`, `category` (`ups | battery | inverter | accessory | spare`), `brand`, `model_number`, `capacity_label` (display-only: "850VA", "150Ah"), `unit`, `default_price`, `warranty_months`, `is_active`.

**`services`** — `code UNIQUE` (`INSTALL`, `AMC`, `BATT-SWAP`), `name`, `description`, `default_charge`, `is_active`. Referenced by `job_cards.service_id`.

### 3.3 Customer product stack

**`customer_products`** — what is physically installed at a site. `customer_id`, `product_id` (nullable), `free_text_name` (required when `product_id IS NULL`, for third-party kit), `serial_number`, `quantity`, `installed_on`, `warranty_expires_on`, `installed_by`, `source_job_id → job_cards`, `is_active`.

`CHECK (product_id IS NOT NULL OR free_text_name IS NOT NULL)`. Unique index on `lower(serial_number)` among active rows — a serial cannot be installed at two sites at once, and de-installation is `is_active = false`, which releases it.

Technicians write here after installing (`PLAN.md` §4). `source_job_id` is what makes that auditable: every stack change traces to the job that caused it.

### 3.4 Jobs — the structural core

**`job_cards` has no money columns.** This is the load-bearing decision. Columns: `job_number UNIQUE`, `customer_id`, `service_id`, `title`, `description`, `priority`, `status`, `assigned_to`, `assigned_by`, `assigned_at`, `scheduled_for`, `scheduled_date` (generated from `scheduled_for`), `contact_name`, `contact_phone`, `created_by`, `closed_at`.

Two coherence constraints do real work:

```sql
CONSTRAINT job_assignment_coherent CHECK (
  (status = 'unassigned' AND assigned_to IS NULL) OR
  (status <> 'unassigned' AND assigned_to IS NOT NULL)
),
CONSTRAINT job_closed_coherent CHECK (
  (status IN ('completed','cancelled')) = (closed_at IS NOT NULL)
)
```

Status enum: `unassigned → assigned → en_route → in_progress → completed`, with `cancelled` reachable from any non-terminal state. `PLAN.md` §9 names colours for four of these; `unassigned` renders as the neutral slate, which is correct — it is the absence of a state, not a state.

**`job_completions`** — 1:1, PK is `job_card_id`. `completed_by`, `completed_at`, `business_date` (generated), `work_summary NOT NULL`, `cost`, `discount_amount`, `discount_reason`, `amount_collected`, `collection_mode`, `payment_reference`, `customer_signed`, `latitude`/`longitude`.

**[resolves] the open question in `PLAN.md` §4.** With no credit system, a job where `amount_collected < cost` has nowhere for the difference to go. The resolution: **make `amount_collected` a generated column and record the gap as a justified discount.**

```sql
cost              numeric(12,2) NOT NULL CHECK (cost >= 0),
discount_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
discount_reason   text,
amount_collected  numeric(12,2) GENERATED ALWAYS AS (cost - discount_amount) STORED,
collection_mode   collection_mode NOT NULL,

CONSTRAINT completion_discount_bounded    CHECK (discount_amount <= cost),
CONSTRAINT completion_discount_justified  CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
CONSTRAINT completion_mode_coherent       CHECK ((cost - discount_amount) = 0 OR collection_mode <> 'none')
```

This takes `PLAN.md`'s second option ("the two fields collapse into one") without losing the first ("ask why"). The technician enters one amount. If he discounts, the form opens a reason field and the database refuses the row without one. A warranty job is `cost 0, discount 0, mode none` and passes. A shortfall with no explanation is now unrepresentable, which is the point — the alternative is a silent gap between what was owed and what arrived at the cash handover, appearing weeks later as an unexplained variance in `v_cash_reconciliation_queue`.

**`job_cancellations`** — 1:1. `cancelled_by`, `cancelled_at`, `reason_code` (enum), `reason_note`, `reschedule_to`. `CHECK (reason_code <> 'other' OR reason_note IS NOT NULL)`.

Separate from `job_completions` rather than a nullable block on `job_cards`, so the two terminal outcomes cannot both be present and neither pollutes the dispatcher's row.

**`job_events`** — append-only, never updated, never deleted. `bigint` identity PK, `job_card_id`, `event_type`, `actor_id` (NULL for system), `occurred_at`, `recorded_at`, `from_status`, `to_status`, `source` (`mobile | web | system`), `idempotency_key`, `payload jsonb`.

`occurred_at` vs `recorded_at` is the offline seam: a technician who completes a job underground at 14:10 and syncs at 16:40 gets `occurred_at = 14:10, recorded_at = 16:40`. Reports use `occurred_at`; sync debugging uses the gap.

### 3.5 Sales and payments

**`sales_cards`** — `sale_number UNIQUE`, `company_id`, `sales_rep_id`, `sale_date`, `status` (`draft | confirmed | void`), `notes`, `confirmed_at`, `voided_at`/`voided_by`/`void_reason`.

Void rather than delete, and a void needs a reason. Dues are derived, so a void is the *only* correct way to reverse a sale — deleting the row would silently move a company's balance with no trace.

**`sales_card_items`** — `sales_card_id`, `line_no` (unique within card), `product_id` nullable, and then the snapshots: `product_name NOT NULL`, `product_sku`, `quantity`, `unit_price`, `line_total` generated as `round(quantity * unit_price, 2)`, `serial_numbers text[]`.

The snapshot columns are why a product rename or repricing next quarter does not rewrite last quarter's sale. `product_id` is kept for reporting joins but is never read for display.

**`payments`** — `payment_number UNIQUE`, `company_id`, `sales_card_id` nullable (NULL = on-account), `amount > 0`, `mode`, `reference_no`, `received_by`, `received_at`, `business_date` generated, `status` (`collected | void`), void fields, `notes`.

**[resolves]** `PLAN.md` §8 gives the sales rep a Payment screen with *Pending* and *Collected* tabs. There is no `pending` payment status. **Pending is a view of dues, not a row.** The Pending tab reads `v_company_balances WHERE balance > 0`; the Collected tab reads `payments`. Modelling a pending payment as a row would create exactly the stored-counter drift the plan rejects — an intention to collect ₹40,000 is not money, and it must not be able to fall out of step with `SUM(sales) − SUM(payments)`.

### 3.6 Attachments

**`attachments`** — polymorphic: `owner_type` (`job_completion | payment | sales_card | customer | employee`), `owner_id uuid`, `kind` (`photo | signature | document`), `storage_key UNIQUE`, `mime_type`, `size_bytes` (capped 15 MB), `width`/`height`, `checksum_sha256`, `caption`, `uploaded_by`, `captured_at`, `uploaded_at`.

No FK on `owner_id` — deliberate. The alternative is five nullable FK columns with a "exactly one is set" constraint, which is worse to query and no safer in practice. Orphan cleanup is a nightly job, not a constraint.

`captured_at` is the device clock at capture, distinct from `uploaded_at`, for the same reason `job_events` splits its two timestamps.

### 3.7 Cash handover

**`cash_reconciliations`** — `technician_id`, `business_date`, `UNIQUE (technician_id, business_date)`, `declared_amount`, `declared_at`, `technician_note`, `status` (`submitted | confirmed | disputed`), `confirmed_amount`, `confirmed_by`, `confirmed_at`, `owner_note`.

`CHECK ((status = 'submitted') = (confirmed_at IS NULL))` and `CHECK (status <> 'disputed' OR owner_note IS NOT NULL)`.

Only the declaration is stored. What he *should* have hand over is derived — see §4.

### 3.8 Location

**`location_pings`** — `bigint` identity, `employee_id`, `device_id`, `recorded_at` (device clock), `received_at` (server clock), `business_date` generated from `recorded_at`, `latitude`/`longitude` with range checks, `accuracy_m`, `altitude_m`, `speed_mps`, `heading_deg`, `battery_pct`, `is_moving`, `source` (`scheduled | on_demand | live | manual`).

**`UNIQUE (employee_id, recorded_at)`** is the important line. Buffered batches retry after partial failure; without this, a technician surfacing from a basement double-writes his trail.

`battery_pct` on every ping is the evidence base for the OEM investigation in Phase 5 — a trail that stops at 34% on a Xiaomi tells a different story than one that stops at 90%.

**Sizing.** 10 tracked staff × ~40 pings/day × 6 days ≈ 2,400 rows/week, ~125k/year. **Do not partition.** Do not add PostGIS. A btree on `(employee_id, recorded_at DESC)` covers every query this app makes, and the owner's map draws a day's trail for one person — at most a few hundred points. Retention: prune beyond 180 days in the nightly job.

**`location_requests`** — `requested_by`, `target_employee_id`, `mode` (`fix | live`), `requested_at`, `expires_at`, `pushed_at`, `fulfilled_at`, `fulfilled_ping_id`, `failure_reason`.

Persisting the request rather than firing a push and forgetting is what lets the owner's console say "requested 40s ago, device has not answered" instead of spinning. `failure_reason` records the FCM-level outcome; a request that expires unfulfilled is itself a tracking-health signal.

### 3.9 Sync plumbing

**`idempotency_keys`** — PK `(employee_id, key)`. `endpoint`, `request_hash` (sha256 of canonical body), `response_status`, `response_body jsonb`, `locked_at`, `created_at`, `expires_at` (default +30 days).

Scoped by employee so a client-generated UUID collision across devices cannot cross-contaminate. `request_hash` catches the genuinely dangerous case: the same key replayed with a *different* body, which is a client bug and must be a 422, not a silent replay of the old response. `locked_at` guards a concurrent duplicate that arrives while the first is still in flight — that gets 409 and a retry-after.

**`sequences`** — `scope text PK` (`job:2627`, `sale:2627`, `payment:2627`), `current_value bigint`, `updated_at`.

```sql
CREATE FUNCTION next_in_sequence(p_scope text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO sequences AS s (scope, current_value) VALUES (p_scope, 1)
  ON CONFLICT (scope) DO UPDATE
    SET current_value = s.current_value + 1, updated_at = now()
  RETURNING current_value;
$$;
```

One atomic statement, no explicit lock, no gap-free guarantee needed (rollbacks are rare and a gap in job numbers harms nothing). Format: `JC-2627-00042` where `2627` is FY 2026–27. Not a Postgres `SEQUENCE`, because the per-fiscal-year reset and prefix live in the scope key.

---

## 4. Derived views — the money layer

Five views carry business rules that must never drift. They are plain views, not materialized: the largest of them aggregates a few thousand rows.

**`v_sales_card_totals`** — per card, `SUM(line_total)` with `status` carried through. Every other total in the system reads this, so "what is a sale worth" is defined once.

**`v_company_balances`** — `SUM(confirmed sales) − SUM(collected payments)` per company, plus `last_sale_date` and `last_payment_at`. Drafts and voids excluded on both sides. This is the number that rises the moment a sale is confirmed.

**`v_technician_expected_cash`** — `SUM(amount_collected)` grouped by `completed_by, business_date`, filtered to `collection_mode = 'cash'`. UPI and card land in the company account and never pass through anyone's hands.

Note it groups by `completed_by`, not `job_cards.assigned_to`. If a job is reassigned mid-day, the cash is with whoever closed it.

**`v_cash_reconciliation_queue`** — `FULL OUTER JOIN` between expected and declared, then `JOIN employees` for the name. Emits `variance` and a `flag`:

| flag | meaning |
|---|---|
| `missing_submission` | collected cash, no declaration — **the row the feature exists for** |
| `no_expected_cash` | declared money the system did not expect |
| `variance` | declared ≠ expected |
| `match` | reconciled |

**`v_technician_load`** — `open_today`, `done_today`, `open_total`, `active_since` per active technician. Powers the assignment picker ("Ravi · 3 today") from `PLAN.md` §8. Computing it in a view rather than the UI means the dispatcher's picker and the owner's dashboard cannot disagree about who is busy.

**`v_employee_tracking_health`** — last ping via `LATERAL`, minutes since, joined to the most recent Android device's permission diagnostics, resolving to a single `health` value:

| health | condition |
|---|---|
| `not_tracked` | role is owner or dispatcher |
| `permission_missing` | device permission is not `background` |
| `never_reported` | no ping ever |
| `stale` | last ping older than 45 minutes |
| `active` | otherwise |

45 minutes is three missed 15-minute cadences, which absorbs the OS jitter `PLAN.md` §7 says to expect without absorbing an actual failure. **This threshold should be revisited after Phase 5 field data** — it is the one number here chosen from reasoning rather than measurement.

**`v_job_cards_dispatcher`** — an explicit money-free projection of `job_cards`, plus `cancellation_reason` and a boolean `is_completed`. Dispatcher endpoints select from this view, never from `job_cards`. The schema already makes revenue absent; this makes the *query surface* one reviewable object instead of every future `SELECT`.

---

## 5. Index plan

Indexes are listed with the query each exists for. Anything not on this list should not be added without a query to justify it.

| Table | Index | Serves |
|---|---|---|
| `job_cards` | `(assigned_to, scheduled_date)` partial on open statuses | technician's Jobs tabs |
| | `(status, scheduled_date DESC)` | dispatcher Job Logs filter |
| | `(customer_id, created_at DESC)` | customer history |
| | `(updated_at)` | delta sync cursor |
| `job_completions` | `(completed_by, business_date)` partial `collection_mode='cash'` | expected-cash view |
| | `(business_date DESC)` | owner revenue dashboard |
| `job_events` | `(job_card_id, occurred_at DESC)` | job timeline |
| `location_pings` | `(employee_id, recorded_at DESC)` | trail + last-ping |
| | `(business_date, employee_id)` | day view across staff |
| `payments` | `(company_id, received_at DESC)` | company ledger |
| | `(received_by, business_date DESC)` | rep's collected tab |
| `sales_cards` | `(company_id, sale_date DESC)`, `(sales_rep_id, sale_date DESC)`, `(updated_at)` | ledger, rep list, sync |
| `customer_products` | `(customer_id)` partial active | site stack |
| | unique `lower(serial_number)` partial active | serial cannot be in two places |
| `customers` | `(phone)`, GIN on `to_tsvector(name)` | dispatcher search |
| `idempotency_keys` | `(expires_at)` | nightly prune |

---

## 6. Delta sync contract

The offline mirror (`PLAN.md` §6) pulls by `updated_at` cursor. Three requirements the schema must meet, all satisfied above:

1. Every syncable table has an indexed `updated_at` maintained by trigger, not by application code.
2. Soft delete (`is_active = false`) rather than `DELETE`, so a tombstone reaches the client through the same cursor. Hard deletes would require a separate deletions log.
3. `version` increments on every update, so the client can send `If-Match: version` and the server can reject a stale write with 409 rather than last-write-wins.

Descriptive fields resolve last-write-wins; status transitions are validated server-side. That validation is application logic (`docs/PLAN-BACKEND.md` §6), not a database constraint — the database cannot know that "completed" is illegal *because the office cancelled it while the technician was underground*, only that both are valid enum values.

---

## 7. Hardening: make the dispatcher guarantee a grant

Optional, Phase 5. The API connects as `servgrid_app`. If dispatcher requests additionally run under `SET LOCAL ROLE servgrid_dispatcher`, a stray join to `job_completions` fails at the database rather than leaking.

```sql
CREATE ROLE servgrid_dispatcher NOLOGIN;
GRANT USAGE ON SCHEMA public TO servgrid_dispatcher;
GRANT SELECT, INSERT, UPDATE ON job_cards, customers, job_events TO servgrid_dispatcher;
GRANT SELECT ON v_job_cards_dispatcher, v_technician_load TO servgrid_dispatcher;
REVOKE ALL ON job_completions, payments, sales_cards, sales_card_items,
              cash_reconciliations, v_company_balances FROM servgrid_dispatcher;
```

Worth doing because it converts the system's central privacy promise from a code-review habit into a database error. Deferred to Phase 5 because `SET LOCAL ROLE` interacts with connection pooling and is not worth debugging while the app is still being written.

---

## 8. Seed and fixture data

| Set | Contents | Used by |
|---|---|---|
| `seed/001_owner.sql` | One owner account, temp password, `must_change_password` | first boot |
| `seed/002_services.sql` | `INSTALL`, `AMC`, `BATT-SWAP`, `SITE-SURVEY`, `REPAIR` | all envs |
| `seed/003_products.sql` | ~20 representative UPS/battery SKUs | dev, staging |
| `fixtures/demo.sql` | 14 employees matching the real roster shape, 60 customers, 400 jobs across 90 days, 30 companies with balances, 3 months of location pings | dev, demo, load sanity |

The demo fixture must include, deliberately: a job completed with a discount; a technician-day with cash collected and no submission (`missing_submission`); a company with a negative balance from an overpayment; a location trail with a two-hour basement gap. These are the four states the UI is most likely to render wrong.

---

## 9. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Parts consumed on a job (`job_completion_parts`) are not modelled. `PLAN.md` does not mention them; a battery swap arguably needs them for stock. | Medium — adding later is additive, no rewrite | Decide before Phase 3 |
| 2 | 45-minute staleness threshold in `v_employee_tracking_health` is reasoned, not measured | Low — one constant | Revisit after Phase 5 field data |
| 3 | No stock/inventory model at all. Sales snapshot prices but do not decrement anything. | Medium — a real feature if the owner wants it | Confirm out of scope with owner |
| 4 | Attachment retention. Photos accumulate; 15 MB cap × ~8 techs × daily is real storage within a year. | Low now, real by month 12 | Phase 5 |
| 5 | Fiscal-year rollover for `sequences` scopes has no automated step — first job of the new FY creates the scope row implicitly, which is correct but untested | Low | Add a test in Phase 1 |
