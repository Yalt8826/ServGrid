# Gap Register — Amendments to the Plan

Found by reading `PLAN.md`, `PLAN-DATA-MODEL.md`, `PLAN-BACKEND.md`, `PLAN-FRONTEND.md` and `PLAN-EXECUTION.md` against each other and against the working day they describe.

**Timing matters here.** Nothing has been built. Every amendment below is a free edit to a migration that has not run and an endpoint that does not exist. The same corrections after Phase 1 ships are expand/contract cycles, data backfills and a second APK. That is the entire argument for doing this pass now.

Each gap states what is missing, what it costs, and the resolution. Resolutions marked **[owner]** were decided by the business; the rest are defaults chosen here and open to argument, in the same spirit as the `[resolves]` markers in `PLAN-DATA-MODEL.md`.

> **Status: applied.** All twenty-one resolutions have been written into `PLAN.md`, `PLAN-DATA-MODEL.md`, `PLAN-BACKEND.md`, `PLAN-FRONTEND.md` and `PLAN-EXECUTION.md`. Those documents are now the specification; this one is the record of *why* each thing changed and what the plan looked like before. Where a gap description below says a thing is missing, read it as "was missing" — the amendment table in Part III says where each one now lives.
>
> One resolution was corrected while being applied: G1's contracts module would have granted dispatchers `SELECT` on `service_contracts`, leaking `contract_value` — the same revenue leak the whole schema is built to prevent, reintroduced in a new table. Dispatchers read `v_contract_visits_dispatcher` instead, which has no value column, and the permission matrix gained a `contract.money` resource alongside `job.money`.

---

## Part I — Gaps the owner has now closed

### G1. Annual maintenance contracts are not modelled **[owner]**

`services` carries an `AMC` code and `PLAN-DATA-MODEL.md` §8 seeds it, but nothing in any document models a contract: no agreement record, no visit schedule, no expiry, no renewal. AMC was, in effect, a job type with a suggestive name.

**The owner's answer: AMCs are real contracts with scheduled visits.** That makes this the largest gap in the set — a missing module, not a missing column.

**New migration 015 `contracts`:**

```
service_contracts
  id, contract_number UNIQUE, customer_id → customers, service_id → services,
  start_date, end_date, visits_included smallint, visit_interval_days smallint,
  contract_value numeric(12,2),
  billing   contract_billing  ('upfront' | 'per_visit'),
  status    contract_status   ('draft' | 'active' | 'expired' | 'cancelled'),
  sold_by → employees, notes, cancelled_at / cancelled_by / cancel_reason
  CHECK (end_date > start_date), CHECK (visits_included > 0)

contract_visits
  id, contract_id → service_contracts, seq_no smallint,
  due_date date,
  status    visit_status ('scheduled' | 'job_created' | 'completed' | 'skipped'),
  job_card_id → job_cards UNIQUE, skipped_reason
  UNIQUE (contract_id, seq_no)
```

The link lives on `contract_visits`, not on `job_cards`. That keeps the jobs table narrow — the same instinct that keeps money off it — and one visit maps to exactly one job by the unique constraint.

**Visit generation** is a nightly background job at 03:00 IST: for every `active` contract, raise an `unassigned` job card for each `scheduled` visit due within 7 days and flip the visit to `job_created`. Generated jobs are ordinary jobs from that point on — the dispatcher assigns them with the same picker, the technician closes them with the same sheet. Nothing downstream needs to know a contract caused them. Idempotency comes free from the unique `job_card_id`.

**Billing interacts with the completion constraint, and holds.** An `upfront` contract's visit is prepaid, so its completion is `cost 0, discount 0, collection_mode none` — which already passes `completion_mode_coherent` without amendment. A `per_visit` contract charges normally. The technician's job payload gains `contract: { number, billing, visitsRemaining } | null` so the complete sheet can suppress the amount field entirely on a prepaid visit rather than relying on the technician to enter zero.

**Renewal** is a view, `v_contracts_expiring`: active contracts with `end_date <= today + 60 days`, carrying visits used and remaining. It surfaces on the owner's dashboard and on the selling rep's.

**Schedule.** This is a new **Phase 2B**, ~4 weeks, placed after the dispatcher exists (generated jobs need somewhere to be assigned) and before the sales rep. It takes the programme from ~28 to ~32 weeks.

**Rollback: T0.** Flag `contracts.generate`. Disabling stops the generator; jobs already raised are indistinguishable from manual ones and survive untouched. This is the cleanest rollback in the plan, and it is a consequence of generating ordinary job cards rather than a parallel visit-execution path.

### G2. A sales rep collecting cash has no reconciliation path **[owner]**

`cash_reconciliations` is keyed on `technician_id`. `v_technician_expected_cash` reads `job_completions`. Neither knows payments exist. A rep who accepts cash from a company is holding money the system will never ask him about.

**The owner's answer: cash from companies is rare — mostly bank transfer, UPI and cheque.** Rare is not never, and rare is worse than common for this failure: an unreconciled path nobody exercises is one nobody notices is broken.

Resolution, deliberately small:

- **Migration 010 changes before it ships.** `cash_reconciliations.technician_id` becomes `employee_id`. Because 010 has not run, this is a text edit, not the column rename plus dual-write plus contract step it becomes after Phase 1.
- `v_technician_expected_cash` becomes `v_employee_expected_cash`: cash-mode `job_completions` grouped by `completed_by`, **unioned with** cash-mode `payments` grouped by `received_by`. Same shape, one more source.
- The handover screen becomes role-agnostic. No new UI — the rep's version is the technician's screen with a different heading.
- `v_cash_reconciliation_queue` picks reps up automatically, since it joins expected against declared and neither side is now technician-only.

Because the volume is low, the owner's queue also gets a standing filter for cash payments recorded by a rep, so a rare event is visible rather than averaged into a day's totals.

### G3. Which companies a rep can see was never defined **[owner]**

`PLAN.md` §5 gives sales reps read/create/update on companies but no scope. `PLAN-BACKEND.md` §7's bootstrap says "his companies" — a phrase with no referent in the schema. With two reps, every company query was ambiguous.

**The owner's answer: each rep owns his accounts.**

- `companies.owner_rep_id → employees`, nullable. **NULL means a house account, visible to every rep** — this is the escape valve that stops the model from being brittle, and it is where a company created by the owner lands by default.
- `permit('sales_rep', 'company', 'read') = 'own'`, which the rbac plugin turns into the predicate `owner_rep_id = :actor OR owner_rep_id IS NULL`. Same predicate for update. Creating a company sets `owner_rep_id` to the creator.
- A rep cannot reassign an account, his own or anyone's. Only the owner can, which is also **the answer to leave and handover**: a rep goes on leave, the owner reassigns or nulls his accounts for the duration. Cheap, and it leaves a trail.
- `v_company_balances` is unrestricted at the view level and scoped at the query, so the owner always sees every balance and no view has to be duplicated per role.
- **A payment recorded by a rep who does not own the account is legal.** `payments.received_by` records who actually took the money, exactly as `job_completions.completed_by` records who actually closed the job rather than who was assigned. The precedent already exists in the plan; this follows it.

### G4. Language was never stated **[owner]**

Nothing in five documents mentions what language the app is in. **The owner's answer: English only.** Recorded so it is a decision rather than an omission, and noted here because the cost is asymmetric: if that changes after Phase 1, every screen is touched. The `MoneyField` still needs Indian digit grouping (`1,00,000`, not `100,000`) — `PLAN-FRONTEND.md` §8 calls this "IST-locale grouping", which is a timezone doing a locale's job. Read it as `en-IN`.

---

## Part II — Gaps filled with a default

### Jobs and the working day

**G5. Nothing tells a technician he has been assigned a job.**

FCM appears in the plan exactly once, for the owner's *Locate now*. There is no notification on assignment. A dispatcher assigns an urgent job; the technician's app is backgrounded; `PLAN-FRONTEND.md` §5 drains and syncs on reconnect, on foreground and on a 60-second timer **while active**. Backgrounded, none of those fire. He finds out when he next opens the app, which could be an hour.

For a dispatch application this is close to a defect. Resolution:

- Data-only FCM push on assign, reassign, cancellation of an assigned job, and priority escalation. It carries no content — it wakes the app, which runs a delta sync and raises a **local** notification from the synced row. The payload never contains job data, so a push cannot be stale and cannot leak to a logged-out device.
- **The system must remain correct with every push dropped.** Push is a latency improvement over the existing sync triggers, never the transport. A technician who never receives one still gets the job on next foreground. That framing is what keeps FCM off the correctness path.
- No new table: `devices.fcm_token` already exists for *Locate now*.

**Schedule consequence, and it is the sharpest one in this document.** `PLAN-BACKEND.md` open item 4 lists the FCM Google project as *blocking for Phase 4*. Assignment notifications are needed the moment dispatchers exist. **FCM becomes a Phase 2 blocker**, two phases earlier than budgeted. The Google project should be confirmed during Phase 0.

**G6. A submitted completion cannot be corrected.**

`job_completions` has a 1:1 primary key and no amend endpoint anywhere in `PLAN-BACKEND.md` §6. A technician who types ₹50,000 for ₹5,000 has poisoned `v_employee_expected_cash`, and the error arrives at the owner as a ₹45,000 variance with no explanation and no way to fix it. Sales and payments can be voided with a reason; completions cannot be touched at all.

- `POST /v1/jobs/:id/completion/amend`, **owner only**, `reason` required. Mirrors the void-with-reason pattern already established for sales.
- The before/after values go into `job_events` as `completion_amended`. `job_completions` needs no history columns — every mutable table already carries `version`, and the append-only event log is where trails belong.
- **Blocked once the covering `cash_reconciliations` row is `confirmed`** for that employee-day. Amending a confirmed day would silently move a figure the owner has already signed off. To fix one, the owner reopens it first: `POST /v1/cash/handovers/:id/reopen`, audited, which returns the row to `submitted`.

**G7. There is no reschedule, and no concept of an overdue job.**

`job_cancellations.reschedule_to` exists and nothing reads it. Separately, nothing anywhere says what becomes of a job still `assigned` at seven in the evening.

- **Rescheduling is a `PATCH` of `scheduled_for`** by dispatcher or owner, under `If-Match`, emitting a `rescheduled` event. It does not reset status. This already worked; it was simply never stated, and an unstated capability gets rebuilt as a special case.
- `job_cancellations.reschedule_to` is renamed **`replacement_job_id`** and means what it should: this job was cancelled and a successor was raised. The cancel flow can create that successor in the same transaction.
- **An open job past its scheduled date does not roll forward.** It appears in the dispatcher's dashboard and in Job Logs as **Overdue**, sorted first. Auto-advancing the date would hide a missed commitment, which is precisely the thing a dispatcher is employed to see.

**G8. Attachments cannot hang off a job card.**

`attachments.owner_type` is `job_completion | payment | sales_card | customer | employee`. A dispatcher taking a fault report by phone cannot attach the photo the customer sent; a technician cannot take a "before" shot. Only the completion accepts images — the wrong end of the job.

Add `job_card` to the enum, and `service_contract` alongside it for G1. Adding an enum value is a safe expand step, and before-photos on the card versus after-photos on the completion is a distinction worth having in the timeline.

**G9. A job does not say which unit it is about.**

`job_cards` links to a customer and a service. A site with five UPS units and three battery banks produces a job card that says "battery swap" and leaves the technician to work out which one on arrival.

`job_cards.customer_product_id`, nullable FK to `customer_products`. Nullable because a site survey or a first installation has no existing unit to point at. The technician's job detail already renders the product stack; this marks one entry.

**G10. Warranty data is stored and never read.**

`products.warranty_months` and `customer_products.warranty_expires_on` are both in the schema. Nothing consults them. A technician charges for work that should be free, or a warranty claim is missed — and with G9 in place, the check is now one join away.

When `customer_product_id` is set, the job detail and the complete sheet show an **in-warranty** chip with the expiry date. Cost is **not** auto-zeroed: out-of-scope work on an in-warranty unit is legitimately chargeable, and a rule that decides otherwise will be wrong on site. Instead, an in-warranty unit completed with `cost > 0` raises a soft confirm — *"This unit is under warranty until 14 Mar 2027. Charge anyway?"* A prompt, not a constraint.

**G11. Two dispatchers can assign the same job.**

`PATCH /v1/jobs/:id` takes `If-Match: version`. `POST /v1/jobs/:id/assign` is listed without it. With three dispatchers working the same unassigned queue each morning, the race is not hypothetical.

`/assign` and `/bulk-assign` take `If-Match`. A lost race returns `409 VERSION_CONFLICT` **naming the current assignee**, because "someone else just gave this to Ravi" is actionable and "version conflict" is not.

### The field client

**G12. Logging out with a full outbox is undefined.**

`PLAN-FRONTEND.md` §4 gives the local mirror a lifetime of "until logout" and the outbox "until drained". On a shared handset at the end of a shift, those two rules disagree about a day's work.

- **Logout is blocked while any row is `queued` or `inflight`.** The button reports "3 items not yet synced" and offers *Retry now*.
- If only `rejected` or `failed` rows remain, logout proceeds and those rows are **preserved**, not wiped.
- This requires `employee_id` on the local `outbox` table — an addition to the schema in `PLAN-FRONTEND.md` §5. The mirror is cleared on user switch; the outbox is filtered, so a preserved rejection reappears for the right person when they log back in on that install.

No path silently discards a technician's work. That rule already governs the 401 case in `PLAN-BACKEND.md` §4; logout is the same rule at a different door.

**G13. `customer_signed` has no capture UI.**

A boolean on `job_completions`, a `signature` value in the attachment kinds, and no component in `PLAN-FRONTEND.md` §8 that draws one.

Resolved as a **checkbox, not a signature pad**: "Customer confirmed the work". A signature drawn with a gloved finger on a phone in a stairwell is a scribble with no evidential value, and it costs a component on the highest-stakes screen in the product. Where evidence is genuinely wanted, it is a photo of the signed paper docket — `PhotoCapture` already handles it and the `signature` attachment kind already labels it.

**G14. An offline duplicate company has no defined outcome.**

Two reps create the same company offline; the case-insensitive unique name rejects the second on sync. With G3 this is now rare, but the failure is ugly: the rep's queued sale points at a company that does not exist.

A unique violation on an offline create returns `rejected` with a message naming the existing row, and the banner offers **Use the existing company** — which rewrites the dependent outbox rows to the server's id rather than making the rep re-enter the sale.

### Identity and administration

**G15. Deactivating an employee is unspecified.**

Setting a technician `is_active = false` while he holds six open jobs is not described anywhere. Nor is what happens to his sessions, his device, or the pings the health view still expects.

`PATCH /v1/employees/:id { isActive: false }` returns **409 with the blocking rows listed in `details`** if the employee holds open jobs or, per G3, owns companies. The owner reassigns, then retries. On success: revoke every refresh token, mark devices inactive, and exclude the employee from `v_employee_tracking_health` so a deactivated account does not sit permanently amber. History — completions, payments, pings — is untouched. `is_active` was never a delete.

**G16. If the owner forgets his password, the system is unrecoverable.**

Accounts are owner-created. There is no email, no reset flow, and one owner. `PLAN-DATA-MODEL.md` §3.1 states this as a simplification; it does not follow it to its conclusion.

Two answers, both cheap, both in the Phase 0 runbook:

1. **A second owner-role account** created at go-live and held by one other trusted person. This is the real answer — an administrative control, not a feature.
2. **A break-glass CLI** in `apps/api` (`npm run admin:reset-password -- --username <u>`), runnable only with shell access to the VPS, writing an audit row on use. This is the answer when the second account is also lost.

**G17. Dispatchers can set a field they cannot see.**

Dispatchers create customers, and `customers.company_id` exists. Dispatchers have no company permission at all. The create form and the API would happily accept a foreign key into a table the actor cannot read.

`company_id` is absent from the dispatcher's form and stripped from dispatcher payloads server-side. Owner and rep only.

### Operations

**G18. The CI pipeline is not defined.**

`PLAN-BACKEND.md` §14 and `PLAN-FRONTEND.md` §10 specify test *content* thoroughly and never say what runs where, or what blocks a merge.

GitHub Actions. **On pull request:** typecheck, lint — including the two custom rules that carry real guarantees, no literal `#F2C200` outside `theme.ts` and no `job_completions` reference inside the dispatcher repository module — then unit and integration suites against a testcontainers Postgres, then a migration `up → down → up` cycle. All required to merge. **On merge to main:** build and push the API image, migrate staging, deploy staging. **EAS builds stay manual**, one per phase plus the contingency slot — `PLAN-EXECUTION.md`'s T3 tier costs hours to days, so an APK should be a decision, never a side effect of a merge.

**G19. Nothing says who finds out when the API is down.**

`PLAN-BACKEND.md` §13 defines `/healthz` and lists metrics "that actually get looked at", but names no destination and no recipient. There is no on-call rota at 14 users and there should not be one, but a silent outage on a Tuesday morning stops the business.

An external uptime checker polls `/healthz` every five minutes and alerts the developer and the owner by phone. That, plus the existing `tracking-health-sweep` push, is the whole alerting story — and stating it as sufficient is the point, so Phase 5 does not discover a gap and over-build in response.

**G20. The owner's dashboard has a layout but no content.**

"4-up stat row + charts" (`PLAN-FRONTEND.md` §9) with no metric definitions, which is enough to stall Phase 4 on a design conversation that should happen now.

Stats: open jobs by status today · cash awaiting confirmation · month-to-date completion revenue · total outstanding company dues. Charts: jobs per day over 30 days, revenue per week over 12 weeks. Every one reads an existing view.

**G21. Cash spent from collections produces a false variance.**

`PLAN-DATA-MODEL.md` open items 1 and 3 raise parts and inventory. There is a sharper form: if a technician buys a part or fuel out of collected cash, his handover is short **by design**, and `v_cash_reconciliation_queue` flags a `variance` that is not one. Repeated, this trains the owner to ignore the flag, which destroys the feature.

Proposed fix at the time: `cash_reconciliations` gains `expenses_amount` and `expenses_note`, with the queue's variance becoming `declared + expenses − expected`.

**Superseded — the owner has confirmed technicians do not spend from collections.** The columns were removed rather than left dormant, and variance is back to `declared − expected`. That is the better outcome: every variance the owner sees is now a real discrepancy, and the field that would have let a shortfall be explained away does not exist.

`PLAN-DATA-MODEL.md` §3.7 records the symptom to watch if this ever turns out wrong — a small, recurring shortfall for **one** employee, never large, never across the team. That shape means the practice has started, and the answer is these two columns rather than an investigation.

**The related question landed differently.** Parts consumed on a job *are* now modelled — `job_completion_parts`, migration 007, Phase 1 — not for cash reconciliation but because a fixed-price AMC's consumables decide whether it is profitable. Parts never touch the amount charged.

---

## Part III — What this changes

### Documents to amend

| Gap | Document | Change |
|---|---|---|
| G1 | data model, backend, frontend, execution | Migration 015, contracts module, Phase 2B |
| G2 | data model §3.7, §4 | Migration 010: `technician_id` → `employee_id`; expected-cash view unions payments |
| G3 | data model §3.2, backend §5 | `companies.owner_rep_id`; `company` read/update scope is `own` |
| G4 | frontend §7 | English only; `en-IN` number formatting |
| G5 | backend §12, execution Phase 2 | Event-driven FCM; **FCM confirmed in Phase 0** |
| G6 | backend §6, §10 | Completion amend + handover reopen, both owner-only and audited |
| G7 | data model §3.4, backend §6 | `replacement_job_id`; Overdue state |
| G8 | data model §3.6 | `job_card` and `service_contract` in `owner_type` |
| G9, G10 | data model §3.4, frontend §9 | `job_cards.customer_product_id`; warranty chip and soft confirm |
| G11 | backend §6.3 | `If-Match` on assign and bulk-assign |
| G12 | frontend §4, §5 | Logout gate; `employee_id` on the outbox table |
| G13 | frontend §9 | Checkbox, not a signature pad |
| G14 | backend §7 | Unique-violation outcome and id rewrite |
| G15 | backend §4 | Deactivation preconditions |
| G16 | execution Phase 0 | Second owner account; break-glass CLI |
| G17 | backend §5 | Strip `company_id` for dispatchers |
| G18–G20 | backend §13, frontend §9 | CI pipeline, alerting, dashboard metrics |
| G21 | data model §3.7 | **Superseded — no expense columns.** The owner confirmed technicians do not spend from collections, so the proposal below was reversed and every variance in the queue is a real one |

### Schedule

| | Before | After |
|---|---|---|
| Phases | 0–5 | 0, 1, 2, **2B**, 3, 4, 5 |
| Duration | ~28 weeks | **~32 weeks** |
| FCM Google project | Phase 4 blocker | **Phase 0 confirm, Phase 2 blocker** |
| New migrations | 001–014 | 001–014 amended in place, **015 contracts** |

Everything except G1 is absorbed into existing phases. Only the contracts module is new work, and it is new work because it is a part of the business the plan did not know about.

### Still open after the first pass

| # | Item | Status |
|---|---|---|
| 1 | ~~Do technicians spend from collected cash?~~ | **Closed [owner]: no.** Expense columns removed everywhere |
| 2 | Parts and inventory. | **Half closed.** Parts are recorded (`job_completion_parts`, Phase 1); stock levels remain out of scope by decision |
| 3 | ~~Site or company account?~~ | **Closed [owner]: one site, one AMC**, partial unique index |
| 4 | ~~Visit never carried out — expire, roll over, refund?~~ | **Closed [owner]: spent**, unless the technician reschedules it on the spot |

---

## Part IV — The second pass

The first pass read the five plans **against each other**. This one read them **against building and running the app**: walking the migrations in order, walking each role through a working day, and asking at each step what an implementing agent would find missing or find contradictory. It ran after `UI/plan-2/` existed, so it also read the screen specs against the API and the schema.

It found twenty-six items. None is a missing business capability — the AMC gap has no counterpart here, which is some evidence that Part III's worry about "a second capability the plan does not know about" was unfounded. What it found instead were **seams**: places where two documents were each internally right and disagreed at the join, and places where a rule was stated but nothing implemented it.

**The four that would have stopped a build.**

| | Found | Why it matters |
|---|---|---|
| **N1** | **Nav groups were owner-shaped and filtered by permission.** | A technician's cash handover and a rep's contract list are permitted, routed, specified — and unreachable. Neither errors. The map is now per role (`PLAN.md` §8) |
| **N2** | **`v_employee_tracking_health` sat in a Phase 2–4 migration.** | The health chip is a Phase 1 deliverable *and* a Phase 1 exit criterion. Moved to migration 009 with a `GET /v1/location/health/me` behind it |
| **N3** | **No consent endpoint existed anywhere.** | The table ships in 003, the screen ships in Phase 0, `PLAN-FRONTEND.md` says acceptance is posted to the server, and no document said where. Discovered on the last day of Phase 0 otherwise |
| **N4** | **`sale_number` and `contract_number` were listed `UNIQUE` with no nullability.** | Both are allocated late — at confirm and at activation. `NOT NULL`, which is what the column list invites, makes drafts impossible |

**The two that would have shipped and then misbehaved in the field.**

**Scope exit had no tombstone.** A job reassigned from Ravi to Anitha is not deleted and not inactive — it simply stops being Ravi's. A delta query that filters by scope returns nothing about it, so his mirror keeps it forever: on his dashboard, in his day's count, openable, with a *Start job* button that 403s in front of a customer. Nothing errors. Fixed with an `out_of_scope` tombstone reason, and the rule that a tombstone never deletes an outbox row.

**The contract-visit generator had a lower bound.** A visit due "within seven days" excludes one whose date has already passed — which is exactly what the on-site reschedule produces when a technician picks today, and what a generator that misses two nights produces on its own. Those visits are orphaned permanently: `scheduled`, never raised, never expired, quietly stopping the contract from completing. The window now sweeps everything overdue.

**The rest, by kind.**

- **Contradictions the expenses removal left behind** — five, in three documents, including a Phase 4 deliverable that still shipped an expenses column and a test asserting behaviour for a field that no longer exists.
- **Permission seams** — the dispatcher dashboard showed tracking health the matrix gave him no access to. Split as `location.health` (health and last-ping age, dispatcher + owner) versus `location.read` (position, owner only), with the DB grant following.
- **Dead ends** — an employee who mistyped his cash declaration had no correction path at all: unique per employee-day so he could not resubmit, and *reopen* only applies to a **confirmed** row. Now amendable while `submitted`, refused after — the same rule as completion amendment, at a different door.
- **Unspecified-but-required** — attachments cannot ride the JSON sync batch (two transports, one queue); `expo-secure-store` has no web implementation and the owner's build is the one that needs it; cold start with the radio off must not attempt a blocking refresh or a technician gets logged out in a basement with a full outbox.
- **Rules with no enforcement** — a contract's visit schedule could be drafted so the last visit falls past `end_date`, where it can be neither carried out nor moved; a renewal activated before its predecessor's nightly expiry hit the one-active-per-site index.
- **UI conflicts** — the rejected-job card repainted its rail `feedback.danger`, which is the `cancelled` colour, so a rejection read as an office cancellation; `MoneyGate` defaulting to `read` would have hidden the amount field from the technician filling it in; the dispatcher dashboard listed a section reading outbox rejections, which exist only on the handset.

**One genuine design change rather than a correction.** The complete sheet had *Parts used* and *Equipment fitted* as separate disclosures. From where the technician stands, a battery he just fitted is both, and two sections means entering it twice or guessing. They are now one list with a per-line **"Add to this site's equipment"** checkbox that defaults from the product category. The server contract is unchanged — one list still produces both payload arrays — because *consumed on this job* and *standing at that site* remain different facts. Collapsing them in the database would lose that; collapsing them in the UI is what stops one of them being forgotten.

### What this pass did not change

No phase moved, no estimate changed, and no migration was renumbered. Every fix is either a text edit to a migration that has not run, an endpoint added to a phase that was already building that module, or a screen specification made specific. The timing argument at the top of this document held a second time: **the same twenty-six items after Phase 1 would have cost a dual-write, two backfills and an APK.**
