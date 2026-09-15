# Data Model — Implementation Plan

Companion to `PLAN.md`. This turns §4 into a buildable specification: every table, every constraint that carries a business rule, every derived view, and the order the migrations land in.

Nothing here overrides `PLAN.md`. Where `PLAN.md` left something open, this document proposes a resolution and marks it **[resolves]** so it can be argued with.

**Conventions**
- Postgres 15+. Money is `NUMERIC(12,2)`, line totals `NUMERIC(14,2)`.
- All timestamps `timestamptz`. Business dates are the Asia/Kolkata calendar day.
- Primary keys are `uuid` (`gen_random_uuid()`) except append-only logs, which use `bigint` identity.
- Every mutable table carries `version integer`, `created_at`, `updated_at`. `version` drives optimistic concurrency (`If-Match`).
- Soft delete via `is_active boolean`, never `DELETE`.

---

## 1. Migration order

Migrations are numbered and forward-only. This ordering respects FK dependencies and matches the build phases in `PLAN.md` §10.

| # | Migration | Contents | Phase |
|---|---|---|---|
| 001 | `extensions_and_helpers` | `pgcrypto`, `citext`, `business_date()`, `touch_updated_at()` | 0 |
| 002 | `enums` | All 18 enum types up front — cheap, and avoids scattering them. Catalogued in §2.1; migration 015 adds three more. | 0 |
| 003 | `identity` | `employees`, `refresh_tokens`, `devices`, `consents` | 0 |
| 004 | `sync_plumbing` | `idempotency_keys`, `sequences`, `next_in_sequence()` | 0 |
| 005 | `reference_data` | `companies`, `customers`, `products`, `services` | 0 |
| 005z | `audit_log` | The generic security trail (§3.1) | 0 |
| 006 | `customer_products` | Product stack at each site | 1 |
| 007 | `jobs` | `job_cards`, `job_completions`, `job_completion_parts`, `job_cancellations`, `job_events` | 1 |
| 008 | `attachments` | Polymorphic attachment table | 1 |
| 009 | `location` | `location_pings`, `location_requests`, **`v_employee_tracking_health`** | 1 |
| 010 | `cash` | `cash_reconciliations` | 1 |
| 011 | `assignment_notifications` | `devices.failure_reason`, `held_notifications` (§3.1) | 2 |
| 012 | — | unused; numbers are never reused (see below) | — |
| 013 | `views_ops` | `v_job_cards_dispatcher`, `v_technician_load` | 2 |
| 014 | `grants_hardening` | Optional `servgrid_dispatcher` role (§7) | 5 |
| 015 | `contracts` | `service_contracts`, `contract_visits`, `v_contracts_expiring`, `v_contract_visits_dispatcher` | 2B |
| 016 | `flag_overrides` | `employee_flag_overrides` (§3.1) | 1 |
| 017 | `sales` | `sales_cards`, `sales_card_items`, `payments` | 3 |
| 018 | `views_money` | `v_sales_card_totals`, `v_company_balances`, `v_employee_expected_cash`, `v_cash_reconciliation_queue` | 3 |
| 019 | `sale_discounts` | `sales_card_items.list_price`, `discount_pct` and the CHECK that the discount explains `unit_price` | ON |

Migrations 006–010 land in Phase 1 even though only the technician app consumes them, because the technician app is the thing that exercises idempotent writes and location while scope is still small.

**`v_employee_tracking_health` ships with 009, in Phase 1, not with the other ops views.** It was originally grouped with `v_job_cards_dispatcher` and `v_technician_load` under a migration marked “Phase 2–4”, which is wrong by a whole phase: the tracking-health chip is a Phase 1 deliverable on the technician's own profile (`PLAN-FRONTEND.md` §6), and Phase 1's exit criteria require it to have shown a **true red** in the field. A chip whose view does not exist until Phase 2 cannot do that, and the failure would surface as a missing relation on the first day of Phase 1 rather than as a design question. It depends only on `employees`, `devices` (003) and `location_pings` (009), so it can be created the moment 009 runs.

013 is correspondingly a clean Phase 2 migration — the two dispatcher views — rather than one spanning three phases.

Migration 015 is out of numeric order relative to its phase — it lands after 011–014 were numbered, but ships in Phase 2B, before them. That is correct and worth leaving alone: **numbers record the order migrations were written, phases record when they run.** Renumbering to make the two agree would mean editing a file whose number some environment has already recorded.

**Renumbered during Phase 2 (13 Sep 2026).** Two migrations were written outside this table: `016_flag_overrides` in Phase 1, for the per-employee flag overrides the parallel run needed, and `011_assignment_notifications` in Phase 2 (T2.5), which took the number this table had reserved for `sales`. Both were already applied in the dev database, so under the rule above they keep their numbers. Phase 3's `sales` and `views_money` move to **017 and 018**. 012 is left empty rather than reused.

**The runner has to allow out-of-order runs.** node-pg-migrate refuses by default to run a migration numbered below one already applied. That broke the dev database once Phase 2 merged: 016 had already run, so 011 and 013 were refused (`Not run migration 011_… is preceding already run migration 016_…`). Phase 2B's 015 would have hit the same error. `apps/api/src/db/migrate.ts` sets `checkOrder: false`, and `test/integration/migrations.test.ts` checks that a lower number still applies after a higher one. The rule that replaces the order check: **a migration may depend only on migrations that shipped before it**, not merely on lower numbers.

**Amendments made before anything shipped.** A number of corrections below are edits to migrations 001–014 *in place*, not new migrations:

- `cash_reconciliations` keyed on `employee_id` rather than `technician_id`, and its expense columns removed
- `companies.owner_rep_id`
- `job_cards.customer_product_id` and `job_cards.contract_visit_id`
- `job_completion_parts` added to 007
- two new `attachment_owner_type` values
- `job_cancellations.replacement_job_id`, replacing a `reschedule_to` date nothing read

They are free only because nothing has run yet; the same corrections after Phase 1 are expand/contract cycles with backfills, and one of them — the `cash_reconciliations` rename — would have needed a dual-write across two releases. `PLAN-GAPS.md` records what changed and why.

**Tooling.** `node-pg-migrate`, plain SQL files, run from `apps/api` on boot in dev and as a separate release step in prod. No ORM migrations — the schema carries too many `CHECK` constraints and generated columns for an ORM's DSL to express honestly.

---

## 2. Two helpers everything else leans on

**`business_date(timestamptz) → date`** returns `(ts AT TIME ZONE 'Asia/Kolkata')::date`.

Declared `IMMUTABLE` so it can appear in generated columns and index expressions. This is technically a lie — the tz database can change — but Asia/Kolkata has had no transition since 1945 and none is proposed. The alternative is storing a redundant `business_date` column the application must remember to set, which is the class of bug this whole model is trying to avoid. **Document the assumption in the migration comment.**

**`touch_updated_at()`** trigger sets `updated_at = now()` and increments `version` on every `UPDATE` where the caller did not already change it. Attached to every mutable table. `updated_at` is indexed on the tables whose lists sort or filter by recency. (It was also the delta-sync cursor until the online-only decision of 2026-09-15 removed delta sync.)

### 2.1 Enum catalogue

Migration 002 creates all of these before any table exists. They are listed here in one place because they are referenced by name throughout §3, and because several of them encode business rules that are otherwise only visible in the prose around them.

| Type | Values | Notes |
|---|---|---|
| `employee_role` | `owner`, `dispatcher`, `technician`, `sales_rep` | The whole permission matrix keys off this |
| `job_status` | `unassigned`, `assigned`, `en_route`, `in_progress`, `completed`, `cancelled` | Transitions in `PLAN-BACKEND.md` §6.1. `en_route` is skippable |
| `job_priority` | `low`, `normal`, `high`, `urgent` | `urgent` is the only value that overrides the notification work-window suppression |
| `cancellation_reason` | `customer_unavailable`, `customer_cancelled`, `duplicate`, `wrong_details`, `no_access`, `parts_unavailable`, `rescheduled_by_office`, `contract_cancelled`, `other` | `other` requires `reason_note` |
| `job_event_type` | `created`, `assigned`, `reassigned`, `status_changed`, `rescheduled`, `completed`, `completion_amended`, `cancelled`, `attachment_added`, `stack_updated` | Append-only; new values are additive and safe |
| `event_source` | `mobile`, `web`, `system` | `system` covers the contract-visit generator |
| `collection_mode` | `cash`, `upi`, `card`, `bank_transfer`, `none` | **Only `cash` reaches `v_employee_expected_cash`.** Everything else lands in the company account and never passes through anyone's hands |
| `payment_mode` | `cash`, `upi`, `card`, `cheque`, `bank_transfer` | Same cash rule. No `none` — a payment of nothing is not a payment |
| `payment_status` | `collected`, `void` | |
| `sales_card_status` | `draft`, `confirmed`, `void` | Only `confirmed` moves a balance |
| `product_category` | `ups`, `battery`, `inverter`, `accessory`, `spare` | |
| `attachment_owner_type` | `job_card`, `job_completion`, `payment`, `sales_card`, `customer`, `employee`, `service_contract` | |
| `attachment_kind` | `photo`, `signature`, `document` | `signature` is a photo of a paper docket — see §3.6 |
| `reconciliation_status` | `submitted`, `confirmed`, `disputed` | `confirmed` blocks completion amendment until reopened |
| `ping_source` | `scheduled`, `on_demand`, `live`, `manual` | `manual` is the descope path's check-in |
| `location_request_mode` | `fix`, `live` | |
| `device_location_permission` | `none`, `foreground`, `background` | Anything but `background` resolves the health chip to `permission_missing` |
| `consent_kind` | `location_tracking` | Single-valued today; the type exists so a second consent does not need a migration on a text column |
| `contract_billing` | `upfront`, `per_visit` | `upfront` forces a zero-cost completion |
| `contract_status` | `draft`, `active`, `expired`, `cancelled` | Only `active` generates visits |
| `visit_status` | `scheduled`, `job_created`, `completed`, `skipped` | `skipped` requires a reason |

Twenty-one types: eighteen in migration 002, three more in 015. **Adding a value to any of these is a safe expand step; removing one is a contract step** (`PLAN-EXECUTION.md` Part I §1), which is why `cancellation_reason` is generous up front — guessing a reason code wrong costs a release cycle, and an unused value costs nothing.

Two of these are load-bearing rather than descriptive. `collection_mode` and `payment_mode` both decide whether money enters the cash reconciliation at all: the expected-cash view filters on the literal `'cash'` in both. **If either enum gains a value that represents physical currency, the view must change with it** — that coupling is the one place in this schema where adding an enum value is not automatically safe.

---

## 3. Table-by-table specification

### 3.1 Identity

**`employees`** — `id`, `username citext UNIQUE` (shape-checked `^[a-z0-9._-]{3,32}$`), `password_hash` (argon2id), `full_name`, `phone`, `role employee_role`, `is_active`, `must_change_password`, `created_by → employees`, `last_login_at`.

Owner-created only. No self-registration, no email, no password reset flow — 14 people, the owner resets it. `must_change_password` defaults true so the owner can hand over a temporary credential.

**`refresh_tokens`** — `token_hash UNIQUE` (sha256 of the opaque token), `employee_id`, `device_id`, `issued_at`, `expires_at`, `revoked_at`, `replaced_by → refresh_tokens`, `user_agent`.

Rotation on every use: the old row gets `revoked_at` and `replaced_by`. Reuse of a revoked token revokes the whole chain — cheap detection of a stolen token on a shared handset.

**`devices`** — one row per install, `UNIQUE (employee_id, install_id)`. Carries `fcm_token` for *Locate now*, and the diagnostics that make OEM background-kill debuggable: `manufacturer`, `model`, `os_version`, `app_version`, `location_permission`, `battery_opt_exempt`, `autostart_confirmed`, `notifications_enabled`, `last_seen_at`, and `failure_reason` (migration 011). `failure_reason` is the last FCM failure (`UNREGISTERED`, `SENDER_ID_MISMATCH`); the stale `fcm_token` is cleared at the same time, and the next successful push sets it back to NULL (`PLAN-BACKEND.md` §12.1).

Those four boolean/enum diagnostics are not decoration. `PLAN.md` §11 names OEM task-killing as the dominant risk; without a per-handset record of which mitigations were actually completed, a "tracking stopped" report is unfalsifiable.

**`consents`** — `employee_id`, `kind` (`location_tracking`), `version` (a date string), `accepted_at`, `device_id`, `ip_address`. `UNIQUE (employee_id, kind, version)`.

Versioned so a reworded consent screen requires re-acceptance. This is the DPDP Act evidence trail from `PLAN.md` §7.

**`audit_log`** — append-only. `bigint` identity PK, `at`, `action` (a dotted verb, e.g. `password.reset.break_glass`), `employee_id → employees` (nullable, for actions whose subject is not an employee), `actor` (who did it), `details jsonb`. Index `(employee_id, at DESC)` — *what happened to this account, and when* is the only query it has.

This is the **generic** trail; `job_events` (migration 007) is the *job* trail and neither substitutes for the other. Nothing updates a row, so it carries no `version`, no `touch_updated_at` trigger and no soft delete — the same append-only rule as `consents`. `PLAN-BACKEND.md` §2 anticipates a `plugins/audit.ts` writing here; today the break-glass password reset (§4) is the only writer, recording the token-revocation count in `details`.

**It ships as migration `005z`, and the letter is deliberate.** Numbers 006–010 are pinned to Phase 1 tables by this document and read off it by later tasks, so a Phase 0 append cannot take 006 without moving everything readers expect. `005z` and not `005a`: node-pg-migrate orders filenames with a punctuation-ignoring compare, under which `005a` sorts *before* `005_reference_data` and would refuse to run against a database that had already applied it.

**`held_notifications`** (migration 011, Phase 2): `employee_id → employees` (cascade), `job_card_id → job_cards` (nullable, set null), `trigger_kind` (`assigned | reassigned | cancelled | priority_escalated`, a `text` + `CHECK` rather than an enum), `priority` as it was at hold time, `held_at`, `released_at`. Partial index on `held_at WHERE released_at IS NULL`.

This implements decision B1 in `docs/decisions/2026-09-12-phase-2-entry-decisions.md`: **hold, don't drop.** A wake triggered outside the 09:00–19:00 IST work window for a job that is not `urgent` gets a row here, and the window-open release sends one collapsed wake per technician and stamps `released_at`. Urgent jobs and in-window changes push straight away and write no row. The row holds no job content, because the push carries none: the push only wakes the app, and the app refetches the technician's work read.

**`employee_flag_overrides`** (migration 016, Phase 1): `(employee_id, flag)` primary key, `enabled`, `updated_by → employees`, `updated_at`. The table holds **only per-person overrides**. Role defaults live in code (`packages/shared` flags, all off), and `GET /v1/auth/me` returns the evaluated result. This is what makes the T0 rollback tier a data change ("turn `tech.jobs` off for that person") rather than a rebuild. `flag` has no `CHECK`: the service validates names against the shared registry, and evaluation ignores unknown names, so adding a flag needs no migration. Written through `PUT /v1/employees/:id/flags` (`PLAN-BACKEND.md` §4.1).

### 3.2 Reference data

**`companies`** — B2B accounts the sales reps sell to. Dues accrue here. `name`, `contact_person`, `phone`, `email`, address fields, `gstin`, `notes`, `owner_rep_id → employees` (nullable), `is_active`. Case-insensitive unique name among active rows.

**[resolves]** `PLAN.md` §5 gave sales reps read/create/update on companies without a scope, and `PLAN-BACKEND.md` §7's bootstrap referred to "his companies" — a phrase with no referent in the schema. **Each rep owns his accounts.** `owner_rep_id` is that ownership; **NULL means a house account visible to every rep**, and is where a company created by the owner lands. The rbac scope `own` on `company` becomes the predicate `owner_rep_id = :actor OR owner_rep_id IS NULL`.

The nullable case is doing real work. Without it the model is brittle — an account has to belong to someone the moment it exists, and there is no shape for "both reps handle this one". Only the owner can change `owner_rep_id`, which is also how leave is handled: he reassigns or nulls a rep's accounts for the duration, and the change leaves a trail.

`payments.received_by` still records whoever actually took the money, even if that is not the account's owning rep. This follows the precedent already set by `job_completions.completed_by` recording who closed the job rather than who was assigned it.

**`customers`** — service recipients. `name`, `phone NOT NULL`, `alt_phone`, address fields, `latitude`/`longitude` (paired — `CHECK ((latitude IS NULL) = (longitude IS NULL))`), `notes`, optional `company_id`.

**[resolves]** `PLAN.md` does not say whether customers and companies are related. They are distinct parties: jobs are for customers, sales are to companies, and `customers.company_id` is a *context* link only (this site belongs to that corporate account). It creates no financial relationship, consistent with "no customer credit". If a corporate site later needs its jobs billed to the company account, that is a new feature, not a nullable column doing double duty.

**`products`** — `sku UNIQUE`, `name`, `category` (`ups | battery | inverter | accessory | spare`), `brand`, `model_number`, `capacity_label` (display-only: "850VA", "150Ah"), `unit`, `default_price`, `warranty_months`, `is_active`.

**`services`** — `code UNIQUE` (`INSTALL`, `AMC`, `BATT-SWAP`), `name`, `description`, `default_charge`, `is_active`. Referenced by `job_cards.service_id`.

### 3.3 Customer product stack

**`customer_products`** — what is physically installed at a site. `customer_id`, `product_id` (nullable), `free_text_name` (required when `product_id IS NULL`, for third-party kit), `serial_number`, `quantity`, `installed_on`, `warranty_expires_on`, `installed_by`, `source_job_id → job_cards`, `is_active`.

`CHECK (product_id IS NOT NULL OR free_text_name IS NOT NULL)`. Unique index on `lower(serial_number)` among active rows — a serial cannot be installed at two sites at once, and de-installation is `is_active = false`, which releases it.

Technicians write here after installing (`PLAN.md` §4). `source_job_id` is what makes that auditable: every stack change traces to the job that caused it.

### 3.4 Jobs — the structural core

**`job_cards` has no money columns.** This is the load-bearing decision. Columns: `job_number UNIQUE`, `customer_id`, `service_id`, `customer_product_id` (nullable), `contract_visit_id` (nullable, → `contract_visits`), `title`, `description`, `priority`, `status`, `assigned_to`, `assigned_by`, `assigned_at`, `scheduled_for`, `scheduled_date` (generated from `scheduled_for`), `contact_name`, `contact_phone`, `created_by`, `closed_at`.

**`customer_product_id`** names the specific unit the job is about. Without it, a site with five UPS units and three battery banks produces a card reading "battery swap" and leaves the technician to work out which one on arrival. Nullable, because a site survey or a first installation has no existing unit to point at — and because a dispatcher taking a call may not know which unit it is either.

It also makes the stored warranty data readable for the first time. `products.warranty_months` and `customer_products.warranty_expires_on` are both in this schema and, until now, nothing consulted them; with this FK the check is one join. The rule is deliberately *not* a constraint — see §3.4's completion notes.

**`contract_visit_id`**, with a partial unique index:

```sql
CREATE UNIQUE INDEX job_cards_one_live_per_visit
  ON job_cards (contract_visit_id)
  WHERE contract_visit_id IS NOT NULL AND status <> 'cancelled';
```

**This reverses an earlier decision, and the reason is worth recording.** §3.10 originally put the link on `contract_visits.job_card_id` with a plain unique constraint, to keep `job_cards` narrow. That held only while a visit could produce exactly one job. It cannot: a technician who arrives and finds the site inaccessible cancels the job and may set a new date, and the visit then produces a *second* job card. A one-to-one link cannot represent an attempt that failed, and repointing it at the new card would erase the first attempt — which is precisely the history the reason code exists to capture.

So the link moved, and the constraint became *at most one live job per visit* rather than *one job per visit*. Cancelled cards accumulate under the visit as the record of what was tried. The generator's idempotency survives intact: it raises a card only when no live one exists, and the index enforces that rather than trusting the query.

`job_cards` gains a second nullable context FK, which is a real cost. It is the right trade: the alternative was a junction table for a two-column relationship, and `customer_product_id` already set the precedent that a nullable pointer to *what this job is about* belongs on the card.

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

**A prepaid contract visit passes these constraints unchanged.** An upfront-billed AMC visit is `cost 0, discount 0, mode none` — the same shape as a warranty job. The contracts module in §3.10 therefore needs no amendment to the completion rules, which is a useful confirmation that the money model was drawn at the right level.

**Warranty is a prompt, not a constraint.** With `job_cards.customer_product_id` set, the completion form knows whether the unit is in warranty. It does not force `cost` to zero, because out-of-scope work on an in-warranty unit is legitimately chargeable and a database rule that decided otherwise would be wrong on site. The client raises a confirmation instead. This is a deliberate exception to the pattern elsewhere in this document — most business rules belong in `CHECK` constraints precisely so they cannot be forgotten, but this one has a legitimate exception on every job it touches, and a constraint with a legitimate exception is a constraint people learn to route around.

**Amendment.** A completion can be corrected after submission, by the owner only and with a reason. There are no history columns on the table: every mutable table already carries `version`, and the before/after pair goes into `job_events` as `completion_amended`, which is where trails belong in this schema. The service refuses an amendment once the covering `cash_reconciliations` row for that employee-day is `confirmed` — otherwise a figure the owner has signed off moves underneath him. Reopening that row is a separate, audited action.

Without this, a technician who types ₹50,000 for ₹5,000 has poisoned `v_employee_expected_cash` and reaches the owner as a ₹45,000 variance with no explanation and no route to a fix. Sales and payments can already be voided with a reason; completions were the one money-bearing record with no correction path at all.

**`job_completion_parts`** — what was physically fitted or consumed. `job_card_id → job_completions`, `line_no` (unique within completion), `product_id` (nullable), `free_text_name` (required when `product_id IS NULL`), `quantity numeric(10,2) CHECK (quantity > 0)`, `unit_cost numeric(12,2)` (nullable), `serial_number`, `from_customer_stock boolean DEFAULT false`.

`CHECK (product_id IS NOT NULL OR free_text_name IS NOT NULL)` — the same shape as `customer_products`, and for the same reason: third-party kit has no SKU.

**Recording parts does not change how `cost` is computed.** This is the single most important thing to say about this table. `job_completions.cost` remains one figure the technician enters; parts are a *record of what was fitted*, not a bill assembled from line items. Sales cards are the only itemised documents in this system, and they are for companies. Anyone who later tries to derive `cost` from `SUM(quantity × unit_cost)` will be reimplementing invoicing, which `PLAN.md` §4 rules out.

What the table is actually for: knowing whether an AMC is profitable. A contract at a fixed price whose visits consume two filters and a terminal block each time has a cost the renewal quote should reflect, and nothing else in the schema can tell you that. `unit_cost` is nullable because a technician in a stairwell does not know what the part cost — the owner can fill it in later, or never.

**It is not an inventory model** (§9 open item 3, still open and still out of scope). Nothing is decremented. A part recorded here came from somewhere the system does not track, and `from_customer_stock` distinguishes the case where the customer supplied it — which matters because that part is not a cost to the business.

Ships in migration 007, Phase 1, not with contracts: a battery swap consumes parts whether or not a contract caused it, and adding it later would mean a second pass over the completion form — the one screen this plan works hardest to keep simple.

**`job_cancellations`** — 1:1. `cancelled_by`, `cancelled_at`, `reason_code` (enum), `reason_note`, `replacement_job_id → job_cards` (nullable). `CHECK (reason_code <> 'other' OR reason_note IS NOT NULL)`.

`replacement_job_id` was `reschedule_to`, a date that nothing read. Renamed to what it should have meant: *this job was cancelled and a successor was raised*, which the cancel flow can create in the same transaction. **Moving a job to a different day is not a cancellation** — it is a `PATCH` of `scheduled_for` under `If-Match`, emitting a `rescheduled` event and leaving status alone. That always worked; it was never written down, and an unstated capability gets rebuilt as a special case.

Nor does an open job past its scheduled date roll forward on its own. It surfaces as **Overdue** in the dispatcher's views. Auto-advancing the date would hide a missed commitment, which is the one thing the dispatcher screens exist to show.

Separate from `job_completions` rather than a nullable block on `job_cards`, so the two terminal outcomes cannot both be present and neither pollutes the dispatcher's row.

**`job_events`** — append-only, never updated, never deleted. `bigint` identity PK, `job_card_id`, `event_type`, `actor_id` (NULL for system), `occurred_at`, `recorded_at`, `from_status`, `to_status`, `source` (`mobile | web | system`), `idempotency_key`, `payload jsonb`.

`occurred_at` vs `recorded_at` keeps the two clocks apart: `occurred_at` is when the person did it (the device's clamped time, pinned when he pressed submit), `recorded_at` is when the server accepted it. Online, the gap is normally seconds — a submit retried after a dropped connection keeps its original `occurred_at`. Reports use `occurred_at`; a large gap is worth a look.

### 3.5 Sales and payments

**`sales_cards`** — `sale_number` (**nullable**, `UNIQUE`), `company_id`, `sales_rep_id`, `sale_date`, `status` (`draft | confirmed | void`), `notes`, `confirmed_at`, `voided_at`/`voided_by`/`void_reason`.

**`sale_number` is nullable and that is load-bearing, not laxity.** The number is allocated at *confirm*, not at create (`PLAN-BACKEND.md` §11), so a draft has none — and a `NOT NULL` here, which is what anyone writing this migration from the column list would reach for, makes drafts impossible. A partial constraint carries the real rule:

```sql
sale_number text UNIQUE,
CONSTRAINT sale_number_when_confirmed
  CHECK ((status = 'draft') = (sale_number IS NULL))
```

Draft means no number; anything else means a number. `service_contracts.contract_number` takes the same shape for the same reason — allocated at activation, `NULL` while `draft` (§3.10). `payments.payment_number` and `job_cards.job_number` are both allocated at create and stay `NOT NULL`; the difference is exactly the difference between a record that begins provisional and one that does not.

Void rather than delete, and a void needs a reason. Dues are derived, so a void is the *only* correct way to reverse a sale — deleting the row would silently move a company's balance with no trace.

**`sales_card_items`** — `sales_card_id`, `line_no` (unique within card), `product_id` nullable, and then the snapshots: `product_name NOT NULL`, `product_sku`, `quantity`, `unit_price`, `line_total` generated as `round(quantity * unit_price, 2)`, `serial_numbers text[]`.

The snapshot columns are why a product rename or repricing next quarter does not rewrite last quarter's sale. `product_id` is kept for reporting joins but is never read for display.

**`payments`** — `payment_number UNIQUE`, `company_id`, `sales_card_id` nullable (NULL = on-account), `amount > 0`, `mode`, `reference_no`, `received_by`, `received_at`, `business_date` generated, `status` (`collected | void`), void fields, `notes`.

**[resolves]** `PLAN.md` §8 gives the sales rep a Payment screen with *Pending* and *Collected* tabs. There is no `pending` payment status. **Pending is a view of dues, not a row.** The Pending tab reads `v_company_balances WHERE balance > 0`; the Collected tab reads `payments`. Modelling a pending payment as a row would create exactly the stored-counter drift the plan rejects — an intention to collect ₹40,000 is not money, and it must not be able to fall out of step with `SUM(sales) − SUM(payments)`.

### 3.6 Attachments

**`attachments`** — polymorphic: `owner_type` (`job_card | job_completion | payment | sales_card | customer | employee | service_contract`), `owner_id uuid`, `kind` (`photo | signature | document`), `storage_key UNIQUE`, `mime_type`, `size_bytes` (capped 15 MB), `width`/`height`, `checksum_sha256`, `caption`, `uploaded_by`, `captured_at`, `uploaded_at`.

`job_card` was missing and mattered: without it only the *completion* accepted images, so a dispatcher taking a fault report by phone could not attach the photo the customer sent, and a technician could not take a "before" shot. Before-photos now hang off the card and after-photos off the completion, which is a distinction worth having in the timeline. `service_contract` carries the signed agreement for §3.10.

**`signature` is a photograph, not a drawing.** `job_completions.customer_signed` is a boolean the technician ticks — "customer confirmed the work". A signature drawn with a gloved finger on a phone in a stairwell is a scribble with no evidential value, and it costs a component on the highest-stakes screen in the product. Where evidence is genuinely wanted it is a photo of the signed paper docket, which this `kind` labels.

No FK on `owner_id` — deliberate. The alternative is five nullable FK columns with a "exactly one is set" constraint, which is worse to query and no safer in practice. Orphan cleanup is a nightly job, not a constraint.

`captured_at` is the device clock at capture, distinct from `uploaded_at`, for the same reason `job_events` splits its two timestamps.

### 3.7 Cash handover

**`cash_reconciliations`** — `employee_id`, `business_date`, `UNIQUE (employee_id, business_date)`, `declared_amount`, `declared_at`, `employee_note`, `status` (`submitted | confirmed | disputed`), `confirmed_amount`, `confirmed_by`, `confirmed_at`, `owner_note`, `reopened_at`, `reopened_by`, `reopen_reason`.

`CHECK ((status = 'submitted') = (confirmed_at IS NULL))` and `CHECK (status <> 'disputed' OR owner_note IS NOT NULL)`.

Only the declaration is stored. What he *should* have handed over is derived — see §4.

**Keyed on `employee_id`, not `technician_id`.** Technicians collect cash at completion, and sales reps occasionally collect it from a company. `PLAN.md` §5 originally gave the handover to technicians alone, which left a rep holding money the system would never ask him about — and because rep cash is *rare*, that is worse rather than better: an unreconciled path nobody exercises is one nobody notices is broken. Since migration 010 has not run, this is a text edit; after Phase 1 it is a column rename plus dual-write plus a contract step.

**There are no expense columns, and that is a decision, not an oversight.** An earlier draft carried `expenses_amount` and `expenses_note` to cover an employee buying a part or fuel out of collected cash — which would make his handover short *by design* and raise a `variance` that is not one. **The owner has confirmed this does not happen: technicians do not spend from collections.** The columns were removed rather than left dormant, because an unused nullable column is a thing future readers must reason about every time they touch this table.

Recording the symptom in case that is ever wrong: it would appear as a **small, recurring shortfall for one particular employee**, never large, never for everyone. Repeated unexplained variances of that shape mean the practice has started, and the answer is these two columns, not an investigation.

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

**`sequences`** — `scope text PK` (`job:2627`, `sale:2627`, `payment:2627`, `contract:2627`), `current_value bigint`, `updated_at`.

```sql
CREATE FUNCTION next_in_sequence(p_scope text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO sequences AS s (scope, current_value) VALUES (p_scope, 1)
  ON CONFLICT (scope) DO UPDATE
    SET current_value = s.current_value + 1, updated_at = now()
  RETURNING current_value;
$$;
```

One atomic statement, no explicit lock, no gap-free guarantee needed (rollbacks are rare and a gap in job numbers harms nothing). Format: `JC-2627-00042` where `2627` is FY 2026–27 and the numeric part is zero-padded to **five digits** (the example is the spec — `00042` is a five-digit field). Not a Postgres `SEQUENCE`, because the per-fiscal-year reset and prefix live in the scope key.

---

### 3.10 Service contracts

`services` carried an `AMC` code from the start, and a code is not a contract. Nothing modelled the agreement, the visits it entitles, its expiry or its renewal — so an AMC was, in effect, a job type with a suggestive name. Migration 015, Phase 2B.

**`service_contracts`** — `contract_number` (**nullable while `draft`**, `UNIQUE`), `customer_id`, `service_id`, `start_date`, `end_date`, `visits_included smallint`, `visit_interval_days smallint`, `contract_value numeric(12,2)`, `billing` (`upfront | per_visit`), `status` (`draft | active | expired | cancelled`), `sold_by → employees`, `notes`, `cancelled_at`/`cancelled_by`/`cancel_reason`.

`CHECK (end_date > start_date)`, `CHECK (visits_included > 0)`, `CHECK ((status = 'draft') = (contract_number IS NULL))` — the number is allocated at activation, the same shape as `sales_cards.sale_number` in §3.5 — and one more that is easy to omit and produces a contract that can never complete:

```sql
CONSTRAINT contract_schedule_fits_term CHECK (
  start_date + ((visits_included - 1) * visit_interval_days) <= end_date
)
```

Four visits at 120-day intervals do not fit in a twelve-month term; the last one falls past `end_date`, and since `rescheduleTo` is bounded by `end_date` (`PLAN-BACKEND.md` §6.3) that visit can be neither carried out nor moved. The failure appears months later as a contract stuck one visit short of complete, and by then the fix is a data correction rather than a rejected form. Catching it at draft time costs one constraint and a validation message, and the numbers come from a rep typing into four fields on a phone.

And:

```sql
CREATE UNIQUE INDEX service_contracts_one_active_per_site
  ON service_contracts (customer_id)
  WHERE status = 'active';
```

**[resolves] one site, one AMC.** A contract covers a single customer location. A corporate account with nine sites holds nine contracts, one per site — the commercial agreement may be negotiated once, but it is administered and serviced per location, and that is the level the visits happen at. The partial unique index makes a second active contract at the same site impossible rather than merely discouraged, which matters because the failure mode is silent: two active contracts generate two sets of visits, and the customer gets serviced twice while the owner bills once.

Draft, expired and cancelled contracts are excluded from the index, so a renewal can be drafted while the current term runs and activated the moment it ends.

This also settles how a rep is scoped to contracts. Since contracts hang off `customer_id` and rep ownership lives on `companies.owner_rep_id`, there is no path between them — so **a rep sees the contracts he sold**: `sold_by = :actor`. Not the account's contracts, because an account has no contracts; a site does.

**`contract_visits`** — `contract_id`, `seq_no smallint`, `due_date`, `status` (`scheduled | job_created | completed | skipped`), `skipped_reason`. `UNIQUE (contract_id, seq_no)` and `CHECK (status <> 'skipped' OR skipped_reason IS NOT NULL)`.

The job link is `job_cards.contract_visit_id` (§3.4), not a column here — see the reversal recorded there. A visit may have several job cards over its life: one per attempt.

**A visit becomes an ordinary job card.** The generator raises an `unassigned` card for every `scheduled` visit due within seven days and flips the visit to `job_created`. From that point nothing downstream knows a contract caused it: the same picker assigns it, the same sheet closes it, the same events record it. That is what makes the module removable — disable the generator and the cards it already raised are indistinguishable from manual ones.

Idempotency is free: the partial unique index in §3.4 permits at most one live job card per visit, so a generator that runs twice, or resumes after a crash, cannot double-raise. No idempotency key is needed because the constraint *is* the key.

**Visit lifecycle, including the attempt that fails**

| From | Event | To |
|---|---|---|
| `scheduled` | generator raises a card | `job_created` |
| `job_created` | technician completes the job | `completed` |
| `job_created` | technician cancels **and gives a new date** | `scheduled`, `due_date` = the new date |
| `job_created` | technician cancels **with no new date** | `skipped`, reason carried from the cancellation |
| `scheduled` | contract cancelled | `skipped` |

**The technician decides, on site, whether the visit is lost or moved.** He is the one standing at a locked gate; the office is not. He cancels the job with a reason from `cancellation_reason` and either picks a date — which returns the visit to `scheduled` and lets the generator raise a fresh card when it comes due — or does not, which spends the visit.

`skipped` therefore means *attempted or due, and not rescheduled*: the customer has used up one of his entitled visits without receiving it. It does not roll over and it does not refund. That is the simple rule, and it is defensible because the technician was offered the reschedule and the reason is recorded against the job — if a customer disputes it later, the cancellation says who was unavailable and when.

`visits_remaining` counts `scheduled` and `job_created` rows. A `skipped` visit is spent, so it reduces what a renewal is worth, which is the behaviour the owner's renewal list needs to show him.

**Billing decides what happens on site.** `upfront` means the visit is prepaid and its completion is `cost 0, discount 0, mode none` — already legal under §3.4 without amendment. `per_visit` charges normally. The technician's job payload carries `{ number, billing, visitsRemaining }` so the complete sheet can drop the amount field entirely on a prepaid visit rather than relying on someone to type a zero into a field that defaults to blank.

**Renewal is `v_contracts_expiring`** (§4), not a reminders table. A reminder row would be a stored fact that can fall out of step with the contract it describes — the same reasoning that makes dues a view.

---

## 4. Derived views — the money layer

Nine views carry business rules that must never drift. They are plain views, not materialized: the largest of them aggregates a few thousand rows.

**`v_sales_card_totals`** — per card, `SUM(line_total)` with `status` carried through. Every other total in the system reads this, so "what is a sale worth" is defined once.

**`v_company_balances`** — `SUM(confirmed sales) − SUM(collected payments)` per company, plus `last_sale_date` and `last_payment_at`. Drafts and voids excluded on both sides. This is the number that rises the moment a sale is confirmed.

**`v_employee_expected_cash`** — cash that passed through a person's hands on a day, from both sources:

- `SUM(amount_collected)` from `job_completions` grouped by `completed_by, business_date`, filtered to `collection_mode = 'cash'`
- `UNION ALL` `SUM(amount)` from `payments` grouped by `received_by, business_date`, filtered to `mode = 'cash'` and `status = 'collected'`

then summed per `(employee_id, business_date)`. UPI, card, cheque and bank transfer land in the company account and never pass through anyone's hands.

It was `v_technician_expected_cash` and read completions only, which left a rep's cash collections invisible to reconciliation. Rep cash is rare — which makes the omission worse, not better, because a path nobody exercises is a path nobody notices is broken.

Note the completions side groups by `completed_by`, not `job_cards.assigned_to`. If a job is reassigned mid-day the cash is with whoever closed it; the payments side follows the same principle with `received_by`, which is why a rep may legitimately hold cash for an account he does not own.

**`v_cash_reconciliation_queue`** — `FULL OUTER JOIN` between expected and declared, then `JOIN employees` for the name. Variance is `declared_amount − expected`. Emits `variance` and a `flag`:

| flag | meaning |
|---|---|
| `missing_submission` | collected cash, no declaration — **the row the feature exists for** |
| `no_expected_cash` | declared money the system did not expect |
| `variance` | declared ≠ expected |
| `match` | reconciled |

There is no expenses term, because employees do not spend from collections (§3.7). Every variance is therefore a real one, which is what makes the flag worth reading.

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

The view also carries `notifications_enabled` and `last_ping_at` through from the device row. `notifications_enabled` is not folded into `health`, deliberately: a technician with notifications off is still tracking correctly, so collapsing it into the same enum would either hide it or misreport a healthy device as unhealthy. The client renders it as a separate chip state (`PLAN-FRONTEND.md` §6) reading the same row.

**`v_contracts_expiring`** — active contracts with `end_date <= current_date + 60`, carrying `visits_used`, `visits_remaining`, `days_to_expiry`, `contract_value` and the selling rep. Feeds the owner's dashboard and the rep's renewal list.

A view rather than a reminders table for the same reason dues are a view: a stored reminder is a fact that can fall out of step with the contract it describes — a contract cancelled in March leaves a renewal prompt sitting in April.

**`v_contract_visits_dispatcher`** — a money-free projection keyed on `contract_visit_id`: `contract_number`, `seq_no`, `visits_included`, `visits_remaining`, `due_date`, `billing`, `attempt_count`. No `contract_value`.

`attempt_count` is the number of cancelled job cards under the visit. A visit on its third attempt is a site the dispatcher should probably ring before sending anyone again, and that is exactly the kind of thing that is invisible unless a view counts it.

`service_contracts.contract_value` is revenue, and the dispatcher guarantee in `PLAN.md` §5 covers revenue wherever it lives, not only `job_completions`. A dispatcher needs to know a job is the third of four visits under contract AMC-2627-0031 so he can schedule it sensibly; he does not need to know what the customer paid for it. Granting `SELECT` on the contracts table itself would have reintroduced exactly the leak §7 exists to close — the same mistake in a new table, which is what makes it worth naming here rather than trusting the pattern to hold on its own.

`billing` is included deliberately: a prepaid visit behaves differently on site, and the dispatcher fielding the customer's call about money should be able to say "that one's covered" without seeing an amount.

**`v_job_cards_dispatcher`** — an explicit money-free projection of `job_cards`, plus `cancellation_reason`, a boolean `is_completed`, a boolean `is_contract_visit`, and `is_overdue` (`status` not terminal and `scheduled_date < business_date(now())`). Dispatcher endpoints select from this view, never from `job_cards`. The schema already makes revenue absent; this makes the *query surface* one reviewable object instead of every future `SELECT`.

`is_overdue` is computed here rather than in the client so the dispatcher's list, the dashboard count and any future report cannot disagree about what "overdue" means — the same argument that put technician load in a view.

---

## 5. Index plan

Indexes are listed with the query each exists for. Anything not on this list should not be added without a query to justify it.

| Table | Index | Serves |
|---|---|---|
| `job_cards` | `(assigned_to, scheduled_date)` partial on open statuses | technician's Jobs tabs |
| | `(status, scheduled_date DESC)` | dispatcher Job Logs filter, Overdue |
| | `(customer_id, created_at DESC)` | customer history |
| | `(customer_product_id)` partial not null | unit service history, warranty check |
| | `(updated_at)` | recency lists |
| `job_completions` | `(completed_by, business_date)` partial `collection_mode='cash'` | expected-cash view |
| | `(business_date DESC)` | owner revenue dashboard |
| `payments` | `(received_by, business_date)` partial `mode='cash'` | expected-cash view, payments side |
| `companies` | `(owner_rep_id)` partial active | a rep's account list |
| `service_contracts` | `(status, end_date)` partial `status='active'` | renewal view |
| | unique `(customer_id)` partial `status='active'` | one site, one live AMC |
| | `(sold_by, start_date DESC)` | a rep's contracts |
| `contract_visits` | `(status, due_date)` partial `status='scheduled'` | the nightly generator |
| `job_cards` | unique `(contract_visit_id)` partial `status <> 'cancelled'` | at most one live job per visit |
| | `(contract_visit_id)` | attempt history for a visit |
| `job_events` | `(job_card_id, occurred_at DESC)` | job timeline |
| `location_pings` | `(employee_id, recorded_at DESC)` | trail + last-ping |
| | `(business_date, employee_id)` | day view across staff |
| `payments` | `(company_id, received_at DESC)` | company ledger |
| | `(received_by, business_date DESC)` | rep's collected tab |
| `sales_cards` | `(company_id, sale_date DESC)`, `(sales_rep_id, sale_date DESC)`, `(updated_at)` | ledger, rep list |
| `customer_products` | `(customer_id)` partial active | site stack |
| | unique `lower(serial_number)` partial active | serial cannot be in two places |
| `customers` | `(phone)`, GIN on `to_tsvector(name)` | dispatcher search |
| `idempotency_keys` | `(expires_at)` | nightly prune |

---

## 6. Concurrency and soft-delete contract

Every role reads and writes the API online (`PLAN.md` §6). There is no client mirror and no delta sync — both were removed by the online-only decision (`docs/decisions/2026-09-15-online-only.md`). Three requirements the schema still meets, all satisfied above:

1. `version` increments on every update (`touch_updated_at()`), so a client can send `If-Match: version` and the server rejects a stale write with 409 rather than last-write-wins.
2. Soft delete (`is_active = false`) rather than `DELETE`, so history keeps its references and a deactivated row stays explainable.
3. `updated_at` is maintained by trigger, not by application code.

**Scope exit asks nothing of the schema any more.** A job reassigned from Ravi to Anitha is simply absent from Ravi's next read (`PLAN-BACKEND.md` §7). The delta protocol needed a tombstone for every row leaving a client's scope, because a mirror otherwise kept it forever; with no mirror there is nothing to forget.

Descriptive fields resolve last-write-wins; status transitions are validated server-side. That validation is application logic (`docs/PLAN-BACKEND.md` §6), not a database constraint — the database cannot know that "completed" is illegal *because the office cancelled it while the technician was underground*, only that both are valid enum values.

---

## 7. Hardening: make the dispatcher guarantee a grant

Optional, Phase 5. The API connects as `servgrid_app`. If dispatcher requests additionally run under `SET LOCAL ROLE servgrid_dispatcher`, a stray join to `job_completions` fails at the database rather than leaking.

```sql
CREATE ROLE servgrid_dispatcher NOLOGIN;
GRANT USAGE ON SCHEMA public TO servgrid_dispatcher;
GRANT SELECT, INSERT, UPDATE ON job_cards, customers, job_events TO servgrid_dispatcher;
GRANT SELECT ON v_job_cards_dispatcher, v_technician_load TO servgrid_dispatcher;
GRANT SELECT ON v_contract_visits_dispatcher TO servgrid_dispatcher;
GRANT SELECT ON v_employee_tracking_health TO servgrid_dispatcher;
REVOKE ALL ON job_completions, payments, sales_cards, sales_card_items,
              cash_reconciliations, service_contracts, v_company_balances,
              v_employee_expected_cash, v_contracts_expiring FROM servgrid_dispatcher;
REVOKE ALL ON location_pings, location_requests FROM servgrid_dispatcher;
```

The two location lines are the same shape of guarantee applied to a different kind of privacy. `v_employee_tracking_health` carries a health value and the *age* of the last ping and no coordinates at all, so a dispatcher can see that a device has gone quiet; `location_pings` is revoked outright, so a stray join that would put eight people on a desk map fails at the database. `PLAN-BACKEND.md` §5 makes the same split in the permission matrix as `location.health` versus `location.read`.

Worth doing because it converts the system's central privacy promise from a code-review habit into a database error. Deferred to Phase 5 because `SET LOCAL ROLE` interacts with connection pooling and is not worth debugging while the app is still being written.

---

## 8. Seed and fixture data

| Set | Contents | Used by |
|---|---|---|
| `seed/001_owner.sql` | One owner account, temp password, `must_change_password` | first boot |
| `seed/002_services.sql` | `INSTALL`, `AMC`, `BATT-SWAP`, `SITE-SURVEY`, `REPAIR` | all envs |
| `seed/003_products.sql` | ~20 representative UPS/battery SKUs | dev, staging |
| `fixtures/demo.sql` | 14 employees matching the real roster shape, 60 customers, 400 jobs across 90 days, 30 companies with balances split across both reps and some house accounts, 12 service contracts, 3 months of location pings | dev, demo, load sanity |

The demo fixture must include, deliberately:

- a job completed with a discount, and one amended afterwards by the owner
- a technician-day with cash collected and no submission (`missing_submission`)
- a sales-rep-day with a cash payment collected, so the payments side of `v_employee_expected_cash` is exercised at all
- a completion with parts fitted, including one `from_customer_stock` and one free-text third-party part
- a contract visit cancelled once and rescheduled, then completed on the second attempt — two job cards under one visit
- a company with a negative balance from an overpayment
- a house account with `owner_rep_id IS NULL`, and a company owned by each rep
- a location trail with a two-hour basement gap
- an upfront contract mid-term with visits raised and closed, a per-visit contract, one expiring inside 60 days, and one with a `skipped` visit
- an open job three days past its scheduled date (`is_overdue`)

These are the states the UI is most likely to render wrong, and several of them are states that only exist because of a rule written in this document — a fixture that omits them lets the rule go untested.

---

## 9. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | ~~Parts consumed on a job are not modelled.~~ **Closed:** `job_completion_parts` ships in migration 007, Phase 1 (§3.4). Not an inventory model — see item 3. | — | Done |
| 2 | 45-minute staleness threshold in `v_employee_tracking_health` is reasoned, not measured | Low — one constant | Revisit after Phase 5 field data |
| 3 | **No stock/inventory model. Confirmed out of scope.** Sales snapshot prices and completions record parts, but nothing is decremented and no stock level exists anywhere. | Medium if it changes — a real module, not a column | Open, deliberately |
| 4 | Attachment retention. Photos accumulate; 15 MB cap × ~8 techs × daily is real storage within a year. Contracts add a signed-agreement document per site. | Low now, real by month 12 | Phase 5 |
| 5 | Fiscal-year rollover for `sequences` scopes has no automated step — first job of the new FY creates the scope row implicitly, which is correct but untested. `contract:` joins `job:`, `sale:` and `payment:` as a scope. | Low | Add a test in Phase 1 |
| 6 | ~~Do employees spend from collected cash?~~ **Closed: no.** Expense columns removed (§3.7), which keeps every variance a real one. | — | Done |
| 7 | ~~Is a contract against a site or a company account?~~ **Closed: one site, one AMC**, enforced by a partial unique index (§3.10). A nine-site corporate account holds nine contracts. Reps are scoped by `sold_by`. | — | Done |
| 8 | ~~What happens to a visit that is never carried out?~~ **Closed:** the technician chooses on site — reschedule to a date he picks, or spend the visit. `skipped` does not roll over and does not refund (§3.10). | — | Done |
| 9 | A visit rescheduled repeatedly has no ceiling. `attempt_count` surfaces it to the dispatcher, but nothing stops a visit being pushed past the contract's `end_date`. | Low — probably a warning, not a constraint | Phase 2B |
