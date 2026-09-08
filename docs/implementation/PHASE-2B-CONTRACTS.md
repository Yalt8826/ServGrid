# Phase 2B — Service Contracts

**Size M · ~4 weeks · Risk: low technically, medium commercially**

The only phase added after the original plan. `services` carried an `AMC` code and nothing behind it — no agreement, no schedule, no expiry, no renewal — so annual maintenance was a job type with a suggestive name.

It sits here because **generated visits need a dispatcher to assign them**, and because **renewals are something a rep sells.**

**Entry** — Phase 2 exit met. The three commercial questions that used to gate this phase are answered and already built into the model:

1. **One site, one AMC.** A nine-site corporate account holds nine contracts. Enforced by a partial unique index, and it is why a rep is scoped by `sold_by` rather than through account ownership.
2. **A visit not carried out is spent**, unless the technician reschedules it on the spot. No roll-over, no refund. The reschedule lives on the cancel sheet, not in the office.
3. **Parts are recorded; stock is not tracked.** `job_completion_parts` shipped in Phase 1, so contracts inherit it rather than needing it.

**Read before starting:** `PLAN-DATA-MODEL.md` §3.10, §4 (`v_contracts_expiring`, `v_contract_visits_dispatcher`) · `PLAN-BACKEND.md` §11.1, §12 · `PLAN.md` §4 (Service contracts).

---

## The property that makes this phase cheap to undo

**A contract visit becomes an ordinary job card.** From the moment the generator raises it, nothing downstream knows a contract caused it: the same picker assigns it, the same sheet closes it, the same events record it.

That is what makes the T0 rollback real — turn the generator off and the system is exactly what it was in Phase 2, plus some jobs that were going to be raised by hand anyway.

**Protect that property.** `PLAN-EXECUTION.md`'s risk register names it explicitly: *the first change that gives contract jobs special handling downstream is the change that makes this rollback expensive.* Any code path branching on "is this a contract visit" beyond a display chip and the two conditional fields on the complete and cancel sheets is a review rejection.

---

## Task graph

```
T2B.1 migration 015 ── T2B.2 contract CRUD + activation ── T2B.3 generator cron
                              │                                  │
                              ├── T2B.4 contract reads by role ──┤
                              └── T2B.5 cancel-with-reschedule ──┘
                                            │
                              T2B.6 contract screens ── T2B.7 chips and sheets ── T2B.8 field run
```

---

### T2B.1 — Migration 015: contracts

**Reads:** `PLAN-DATA-MODEL.md` §3.10 in full, §4, §5
**Depends on:** Phase 2
**Tier:** free until deploy

> **Serial task.** Migration 015 is out of numeric order relative to its phase — it lands after 011–014 were numbered but ships before them. **That is correct and worth leaving alone: numbers record the order migrations were written, phases record when they run.** Renumbering means editing a file whose number some environment has already recorded.

**Build**

**`service_contracts`** — with three constraints that each stop a real failure:

```sql
contract_number text UNIQUE,   -- NULL while draft
CHECK ((status = 'draft') = (contract_number IS NULL)),
CHECK (end_date > start_date),
CHECK (visits_included > 0),

CONSTRAINT contract_schedule_fits_term CHECK (
  start_date + ((visits_included - 1) * visit_interval_days) <= end_date
);

CREATE UNIQUE INDEX service_contracts_one_active_per_site
  ON service_contracts (customer_id) WHERE status = 'active';
```

**`contract_number` is nullable and that is load-bearing.** The number is allocated at activation, so a draft has none — and a `NOT NULL`, which is what the column list invites, makes drafts impossible. Same shape as `sales_cards.sale_number`.

**`contract_schedule_fits_term` catches a form nobody would notice.** Four visits at 120-day intervals do not fit a twelve-month term; the last falls past `end_date`, and since `rescheduleTo` is bounded by `end_date`, that visit can be neither carried out nor moved. The failure appears months later as a contract stuck one visit short of complete, and by then the fix is data surgery rather than a rejected form.

**The partial unique index makes a second active contract at the same site impossible rather than discouraged**, because the failure mode is silent: two active contracts generate two sets of visits, the customer is serviced twice and the owner bills once. Draft, expired and cancelled are excluded, so a renewal can be drafted while the current term runs.

**`contract_visits`** — `contract_id`, `seq_no`, `due_date`, `status`, `skipped_reason`. `UNIQUE (contract_id, seq_no)`. **No `job_card_id` column** — the link lives on `job_cards.contract_visit_id`, and the reversal is recorded in §3.4 because a visit may have several job cards over its life, one per attempt.

**Add the FK and the partial unique index that Phase 1 deferred:**

```sql
ALTER TABLE job_cards ADD CONSTRAINT job_cards_contract_visit_fk
  FOREIGN KEY (contract_visit_id) REFERENCES contract_visits(id);

CREATE UNIQUE INDEX job_cards_one_live_per_visit
  ON job_cards (contract_visit_id)
  WHERE contract_visit_id IS NOT NULL AND status <> 'cancelled';
```

**At most one *live* job per visit, not one job per visit.** Cancelled cards accumulate under the visit as the record of what was tried. **The index *is* the generator's idempotency key** — a generator that runs twice, or resumes after a crash, cannot double-raise, and no key needs threading through a job with no HTTP request behind it.

The index is partial precisely so a rescheduled visit works: its cancelled first attempt stays as history, and the generator is free to raise a second card.

**Two views:**

**`v_contracts_expiring`** — active contracts with `end_date <= current_date + 60`, carrying `visits_used`, `visits_remaining`, `days_to_expiry`, `contract_value`, and the selling rep. A view rather than a reminders table for the same reason dues are a view: a contract cancelled in March would leave a renewal prompt sitting in April.

**`v_contract_visits_dispatcher`** — a **money-free** projection keyed on `contract_visit_id`: `contract_number`, `seq_no`, `visits_included`, `visits_remaining`, `due_date`, `billing`, `attempt_count`. **No `contract_value`.**

`attempt_count` is the number of cancelled job cards under the visit. **A visit on its third attempt is a site the dispatcher should probably ring before sending anyone again**, and that is invisible unless a view counts it.

`billing` is included deliberately: a prepaid visit behaves differently on site, and the dispatcher fielding the customer's call about money should be able to say "that one's covered" without seeing an amount.

**Tests**

`apps/api/test/integration/schema-contracts.test.ts`
- Second `active` contract at the same `customer_id` → unique violation; a `draft` alongside an `active` → allowed
- 4 visits × 120 days in a 365-day term → **check violation**; 4 × 90 → accepted
- `draft` with a `contract_number` → violation; `active` without one → violation
- Two live job cards under one visit → unique violation; one live plus two cancelled → **allowed**
- `v_contract_visits_dispatcher` column list contains **no `contract_value`** — assert from `information_schema.columns`
- `v_contracts_expiring` against a hand-counted fixture **including a cancelled contract, which must not appear**

**Done when**
- [ ] Every constraint proven by a failing insert
- [ ] The partial unique index proven to permit cancelled attempts alongside one live card
- [ ] Dispatcher view proven money-free at the column level

**If it fails**
Free window for 015 itself, but **not** for the `ALTER TABLE` on `job_cards` — that table has been live since Phase 1. Adding a nullable FK and a partial index to an existing table is still an expand step and is safe; **do not** be tempted to add `NOT NULL` or backfill anything on it.

**Commits**
`chore(start): T2B.1 contracts schema` → `feat(db): migration 015 — contracts, visits, money-free dispatcher view`

---

### T2B.2 — Contract CRUD and activation

**Reads:** `PLAN-BACKEND.md` §11.1 · `PLAN-DATA-MODEL.md` §3.10
**Depends on:** T2B.1
**Tier:** T2 · **Flag:** `contracts.manage`

**Build**

The ten endpoints in §11.1. Three behaviours carry weight:

**A rep is scoped by `sold_by`, not by account ownership.** Contracts hang off `customer_id` and rep ownership lives on `companies.owner_rep_id`, so there is no path between them — **a site is not an account.** A rep sees the contracts he sold. This is the one place rep scoping does *not* follow `owner_rep_id`, and it follows from one site holding one AMC.

**Visit rows are generated at activation, not on the fly.** Activating writes all `visits_included` rows with `due_date` stepped by `visit_interval_days`. Materialising the schedule up front means the owner can see it, a rep can point at it when the customer asks, and **a due date can be moved individually without recomputing an interval** — a customer who wants the March visit in April is a normal request, and an implied schedule cannot answer it.

The number is allocated at activation for the same reason a sale number is allocated at confirm: a draft that never activates should not burn one.

**Activation expires an outgoing predecessor in the same transaction.** The renewal case is the ordinary case, and without this it fails on the ordinary day: a contract ends 31 March, the rep signs the renewal on the 28th, and the partial unique index refuses because the old one stays `active` until `expire-contracts` runs at 03:00 on 1 April. The rep is told to come back in four days, for a reason nobody can explain to a customer.

So activate first expires any `active` contract at the same site whose `end_date < the new contract's start_date`, then activates. **A genuine overlap — two live agreements for the same site — still 409s and names the existing contract**, because that is a commercial mistake rather than a scheduling one and it needs a person.

**One active contract per site returns `409 DUPLICATE_ENTITY` naming the existing contract**, never a raw constraint 500. A rep drafting a renewal for a covered site is a normal thing to do, and he needs to be told which one.

**Cancelling a contract does not touch jobs already raised.** Unraised visits become `skipped` with the cancellation as the reason; visits that already produced a job card leave that job alone, because it may already be done.

**Tests**

`apps/api/test/integration/contracts.test.ts`
- Activation writes **exactly `visits_included` rows** at the right intervals — **including a term crossing a fiscal-year boundary**
- Activation allocates a number; a draft that is never activated burns none
- Renewal activated the day before the predecessor ends → predecessor expired in the same transaction, no 409
- A genuine overlap → 409 naming the existing contract
- Cancel skips unraised visits and **leaves raised jobs untouched** — assert both halves

`apps/api/test/authz/contracts.test.ts`
- Rep A sees contracts he sold and **not** rep B's, even for a company he owns
- A dispatcher reading a contract gets `v_contract_visits_dispatcher` with **no `contract_value`**
- Only the owner can cancel

**Done when**
- [ ] Renewal-before-expiry path proven — this is the ordinary case, not an edge case
- [ ] `sold_by` scoping proven to differ from `owner_rep_id` scoping in a fixture where they disagree

**If it fails**
If activation is failing on the one-active-per-site index during a renewal, the predecessor expiry is running outside the transaction or after the insert. Both must be in one statement order: expire, then activate, then allocate the number. A rep told to come back in four days will simply record the contract on paper.

**Commits**
`chore(start): T2B.2 contract crud` → `feat(api): contract CRUD, activation with materialised schedule and predecessor expiry`

---

### T2B.3 — The visit generator

**Reads:** `PLAN-BACKEND.md` §12 (background jobs, the generator paragraphs)
**Depends on:** T2B.2
**Tier:** T2 · **Flag:** `contracts.generate`

**Build**

`generate-contract-visits`, nightly **03:00 IST**, in-process `node-cron`. At this scale a queue would be infrastructure without a reason.

```sql
WHERE status = 'scheduled' AND due_date <= current_date + 7
```

**No lower bound, and that is deliberate.** A `scheduled` visit whose date is already past is exactly what the reschedule path produces — a technician who picks *today*, a generator that misses two nights, a customer who phones the office to move a visit to a date that then passes. With a lower bound those visits are **orphaned permanently**: `scheduled`, never raised, never expired, quietly stopping the contract from completing, and nothing errors.

Sweeping everything overdue means a missed night self-heals on the next run, which is the property that makes a nightly cron acceptable at all.

**A visit raised late is raised for the day it was due**, not for today — `scheduled_for` comes from `due_date`, so the card arrives already **Overdue** in the dispatcher's list. That is correct: the commitment was missed, and a date never silently rolls forward.

It raises seven days ahead so the dispatcher has a week of visibility, and so a generator that fails for a night or two is invisible rather than urgent.

**No idempotency key.** The partial unique index permits at most one live card per visit, so the constraint *is* the guard — the same argument as `location_pings`' unique key, and cheaper than threading the idempotency plugin through a job with no HTTP request behind it.

`expire-contracts` — nightly, `active` past `end_date` → `expired`.

**`contracts.generate` is a separate flag from `contracts.manage`** deliberately. An unattended cron is the risky half of an otherwise safe feature and needs to be switchable without taking contract management down.

**Tests**

`apps/api/test/integration/generator.test.ts`
- **Run twice over the same window → each visit raised exactly once.** The index is the guard, not a key
- **Interrupted mid-batch and resumed → no duplicates, no gaps**
- **A visit due three days ago is raised** — the no-lower-bound case, and the one that would be missed
- The raised card's `scheduled_for` is the **due date**, not today, and the card reads `is_overdue`
- A visit whose live card exists is not re-raised; a visit whose only card is `cancelled` **is**
- Visits for a `draft` or `cancelled` contract are never raised
- `expire-contracts` flips only contracts past `end_date`

**Done when**
- [ ] Double-run and crash-resume both produce zero duplicates
- [ ] Past-due sweep proven

**If it fails**
If duplicates appear, the index is missing or was created non-partially. Do not add an idempotency key to compensate — that hides a constraint failure behind application logic.

**Commits**
`chore(start): T2B.3 visit generator` → `feat(api): nightly visit generator with no lower bound, contract expiry`

---

### T2B.4 — Contract reads by role

**Reads:** `PLAN-BACKEND.md` §11.1, §5 (`contract.money`) · `PLAN-DATA-MODEL.md` §4
**Depends on:** T2B.2
**Parallel with:** T2B.3
**Tier:** T2 · **Flag:** `contracts.manage`

**Build**

`GET /v1/jobs/:id/contract` — technician (own job), dispatcher, owner. **Three different payloads:**

| Role | Source | Carries |
|---|---|---|
| Technician | inline on the job | `{ number, billing, visitsRemaining }` |
| Dispatcher | `v_contract_visits_dispatcher` | number, seq, visits, due date, billing, `attempt_count`. **No value** |
| Owner | `service_contracts` | everything |

**Contracts are not a separate synced collection** for the technician. His jobs carry `contract: { number, billing, visitsRemaining } | null` **inline** in the sync bootstrap and delta — he needs the context of the visit in front of him, never the contract as an entity, and a table he cannot act on has no business in his mirror.

**`contract.money` exists for the same reason `job.money` does.** `contract_value` is revenue, and the dispatcher guarantee covers revenue **wherever it lives**, not only in `job_completions`. Granting `SELECT` on the contracts table would have reintroduced exactly the leak the schema exists to close — the same mistake in a new table.

`PATCH /v1/contracts/visits/:id` — **dispatcher and owner**, moves `due_date` without a site visit. The office-side reschedule, for when the customer phones ahead. A rep cannot: he sold the agreement, he does not run the schedule.

`POST /v1/contracts/visits/:id/skip` — dispatcher and owner, reason required.

**Tests**

`apps/api/test/authz/contract-reads.test.ts`
- **Extend the T2.2 money-leak suite to every new endpoint**, now also checking `contract_value`
- Technician's job payload carries the inline contract object and **no value**
- Dispatcher's payload carries `attempt_count` and **no value**
- A rep cannot `PATCH` a visit due date, his own contract's included

`apps/api/test/integration/sync-contracts.test.ts`
- Bootstrap for a technician contains **no contracts collection**; contract data is inline on jobs only

**Done when**
- [ ] Money-leak suite extended and green for `contract_value`
- [ ] No contracts collection in the technician's mirror

**If it fails**
If `contract_value` reaches a dispatcher, the endpoint is selecting from `service_contracts` rather than `v_contract_visits_dispatcher`. This is the exact leak the second gap pass caught in design — the same mistake in a new table — so treat it as a design regression and fix the query source, not the response shape.

**Commits**
`chore(start): T2B.4 contract reads` → `feat(api): per-role contract payloads, office-side visit reschedule`

---

### T2B.5 — Cancel-with-reschedule, the contract path

**Reads:** `PLAN-BACKEND.md` §6.3 (cancelling with a date) · `PLAN-DATA-MODEL.md` §3.10 (visit lifecycle)
**Depends on:** T2B.2, T1.7
**Tier:** T2 · **Flag:** `contracts.manage`

**Build**

Complete the branch left in T1.7. `POST /v1/jobs/:id/cancel` on a contract-visit job:

| Input | Effect |
|---|---|
| `rescheduleTo` given | The **visit** returns to `scheduled` with `due_date = rescheduleTo`. **No successor job is created** — creating one *and* leaving the visit scheduled would double-raise the work |
| No `rescheduleTo` | The visit becomes `skipped`, carrying the cancellation reason. **The customer has spent it** |

**The technician decides, on site, whether the visit is lost or moved.** He is the one standing at a locked gate; the office is not. Routing it through a dispatcher means the decision is made by someone who was not there, from a reason code, hours later.

`skipped` means *attempted or due, and not rescheduled*. **It does not roll over and it does not refund.** That is defensible because the reschedule was offered and the reason is recorded against the job — if a customer disputes it later, the cancellation says who was unavailable and when.

`visits_remaining` counts `scheduled` and `job_created` rows. **A `skipped` visit is spent, so it reduces what a renewal is worth** — which is exactly the behaviour the owner's renewal list needs to show him.

`rescheduleTo` is bounded: not in the past, and **not beyond `service_contracts.end_date`** — a visit pushed past the term is a visit that cannot happen, and accepting the date would produce a contract that never completes.

Also complete T1.6 step 7: a completion on a contract-visit job flips `contract_visits.status` to `completed` in the same transaction.

**Tests**

`apps/api/test/integration/contract-cancel.test.ts`
- Cancel **with** a date → visit back to `scheduled` with the new date, **no successor card**, and the generator raises a second card when it comes due — **both cards visible under the visit**
- Cancel **without** a date → visit `skipped`, `visits_remaining` drops by one, `v_contracts_expiring` reflects it
- `rescheduleTo` past `end_date` → **rejected**
- `rescheduleTo` in the past → rejected
- Completing a contract-visit job flips the visit to `completed` atomically
- **A prepaid visit completed with `cost > 0` → 422**; with `cost 0, mode none` → accepted by the existing Phase 1 constraints, **unmodified**

That last assertion matters beyond this phase: it confirms the money model was drawn at the right level in Phase 1, because the contracts module needed no amendment to the completion rules.

**Done when**
- [ ] The two-attempt path proven end to end: cancel with date → regenerate → complete
- [ ] Prepaid rejection proven server-side, not only hidden client-side

**If it fails**
If a reschedule produces **both** a successor card and a `scheduled` visit, the work will be double-raised. That is the failure mode to watch for above all others here, because it looks correct on the day and produces two technicians at one site a week later.

**Commits**
`chore(start): T2B.5 contract cancel path` → `feat(api): on-site reschedule returns the visit, skip spends it`

---

### T2B.6 — Contract screens

**Reads:** `UI/plan-2/06-SALES-REP.md` §S5 · `UI/plan-2/05-DISPATCHER.md` §D5 · `PLAN-FRONTEND.md` §2 (contracts routes), §3
**Depends on:** T2B.4, T0.13
**Tier:** T1 · **Flag:** `contracts.manage`

**Build**

Routes: `contracts/index.tsx`, `new.tsx`, `renewals.tsx`, `[id].tsx`.

**`/contracts` lives in the rep's Sales group and the dispatcher's and owner's Operations group.** It is commercial for one and operational for the other, which is why the nav map is per role rather than the owner's map filtered (`PLAN-FRONTEND.md` §3).

**Rep — create.** Customer site, service, start and end date, visits included, interval days, **billing as `Upfront` / `Per visit` segments**, contract value, notes.

Drafting for a site that already has an active contract returns 409, **and the UI says which contract exists with a link to it** — a rep drafting a renewal for a covered site is a normal thing to do, and he needs to be told, not blocked with an error code.

**Activate is the moment.** Draft → active allocates the number and generates the whole visit schedule, which then appears in the detail as a list of dates. **Showing the materialised schedule immediately is what makes the contract feel real**, and it is what the rep points at when the customer asks when they will be visited.

**Rep — renewals.** The commercially important screen. Contracts he sold, expiring within 60 days, days remaining rather than a date because urgency is the point.

**Visits used is shown**, because it is what the renewal is worth arguing about. A customer who took three of four visits is a different conversation from one who took all four — and a **spent** visit reduces the value the rep should quote.

**Dispatcher — read-only-ish.** List of active contracts by site: number (mono), customer, `visit 3 of 4`, next due date, **`attempt_count` when above 1**. Detail: the visit schedule as a vertical list with status per visit, and the job cards under each.

He can **move a visit's due date** and **skip a visit** the customer cancelled by phone. He cannot see `contract_value`, anywhere, ever.

**`attempt_count` above 1 is surfaced deliberately.** A visit on its third attempt is a site worth ringing before sending anyone again.

**Tests**

`apps/mobile/src/screens/contracts/*.test.tsx`
- 409 on create renders the existing contract's number **as a link**, not an error code
- Activation renders the full generated schedule immediately
- Renewal rows show days remaining and visits used
- **A dispatcher's contract tree contains no `contract_value` and no `₹`** at any depth
- `attempt_count` of 1 renders nothing; 2 renders the indicator

**Done when**
- [ ] Dispatcher contract screens proven money-free in the rendered tree, not just the payload
- [ ] Schedule visible immediately on activation

**If it fails**
T0: `contracts.manage` off. The screens are the descopable half — the generator and the schema can stay, with contracts captured by the owner directly, which is most of the descope path anyway.

**Commits**
`chore(start): T2B.6 contract screens` → `feat(mobile): contract list, create, activation schedule, renewals`

---

### T2B.7 — Chips and the two conditional sheets

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T3, §T4, §T5 · `PLAN-FRONTEND.md` §8 (chip colours)
**Depends on:** T2B.5, T1.19, T1.20
**Tier:** T1 · **Flag:** `contracts.manage`

**Build**

**`ContractChip`** — *"AMC-2627-0031 · visit 3 of 4 · prepaid"*. **The word `prepaid` is the load-bearing part** on a technician's screen.

**Muted `#5A6B7C` on `surfaceDense`, not yellow.** A job card can already carry a status rail in `in_progress` yellow, and a second yellow element beside it would make the rail stop meaning anything — the erosion that arrives one reasonable PR at a time.

**Complete sheet, prepaid branch** (the slot built in T1.19): the amount field and the Paid-by segments are **absent**. Not zero, not disabled. The `ContractChip` reading "prepaid" sits in their place. A field showing ₹0 invites a tap, and the server rejects a non-zero cost anyway — so showing the field can only produce a rejection the technician does not deserve.

**Cancel sheet, contract branch** (the slot built in T1.20). Above the date picker, in `body` not `caption`:

> **Skipping without a date spends one of this customer's 4 visits.**

Plain words, with the real remaining count. **This is the one place in the app where a technician is warned about a default** rather than trusted to know it, because the consequence is invisible and lands on the customer.

The date picker is bounded by the contract's `end_date`, client-side as well as server-side, so the technician sees the limit rather than a rejection.

**Tests**

`apps/mobile/src/screens/technician/complete-prepaid.test.tsx`
- Prepaid visit: amount field and Paid-by segments **absent from the tree**, not merely hidden
- The chip renders "prepaid" in their place
- Payload carries `cost: 0`, `collection_mode: 'none'`

`apps/mobile/src/screens/technician/cancel-contract.test.tsx`
- Contract visit with no date selected shows the **"spends a visit"** warning with the correct remaining count
- Selecting a date replaces the warning with *"Visit moves to 22 Mar."*
- A date past `end_date` is unselectable in the picker, not merely rejected on submit

`apps/mobile/src/components/domain/ContractChip.test.tsx`
- Renders muted, **never accent**; asserts the resolved colour is not `#F2C200`

**Done when**
- [ ] Prepaid branch proven by absence, not by disabled state
- [ ] The warning renders the real visit count from the payload

**If it fails**
If the prepaid branch shows a disabled ₹0 field instead of hiding it, that is not a cosmetic miss — a visible field invites a tap and the server will reject the result. Absence is the specification. T1 republish.

**Commits**
`chore(start): T2B.7 contract chips and sheets` → `feat(mobile): contract chip, prepaid completion, spends-a-visit warning`

---

### T2B.8 — Field run and phase exit

**Reads:** `PLAN-EXECUTION.md` Phase 2B exit
**Depends on:** all of Phase 2B
**Tier:** T0 per flag

**Build** nothing. **Run two real AMCs through the whole flow.**

**Two real contracts, two weeks.**

**Tests** — the field is the test. Watch specifically for a contract job acquiring special handling anywhere downstream; that is the property the rollback depends on and it erodes quietly.

**Done when**

- [ ] Two real AMC contracts activated, and their visits **raised, assigned and completed through the normal dispatcher and technician flow with no contract-specific handling**
- [ ] A technician completed a prepaid visit and **was never shown an amount field**
- [ ] The renewal list matched a manual count of what is expiring
- [ ] **Money-leak assertion green for `contract_value`** across every dispatcher endpoint
- [ ] **A real visit was rescheduled from the field and completed on the second attempt**, with both job cards visible under the visit
- [ ] **No technician skipped a visit without a date when the customer had in fact asked to reschedule.** If that happened, the cancel sheet's warning is not doing its job

That last one is a copy test disguised as a field test, and it is the only way to run it.

**Still open, watch it during the run:** a visit can be rescheduled indefinitely, and nothing stops it being pushed toward `end_date` beyond the API bound. `attempt_count` surfaces it to the dispatcher (`PLAN-DATA-MODEL.md` open item 9). Probably a warning, not a constraint.

**If it fails**

**The cleanest rollback in the plan.**

| Scenario | Tier | Action |
|---|---|---|
| Generator raising wrong or duplicate jobs | T0 | `contracts.generate` off. **Already-raised jobs are ordinary jobs and are unaffected** |
| Contract screens wrong | T0 | `contracts.manage` off |
| API bug | T2 | previous image |
| Wrongly generated jobs in production | T4 | **cancel them through the normal cancellation flow, with a reason.** No data surgery |

Cheap to undo precisely because a visit becomes an ordinary job card. There is no parallel execution path to unwind.

**Descope** — ship contracts as a **record without a generator**: the owner and reps capture agreements and see renewals, visits are dispatched manually as they always were. That keeps the commercial value — knowing what is owed and what is expiring — and drops the automation, which is the part with the operational risk. Roughly halves the phase.

**Commits**
`chore(start): T2B.8 contract field run` → `docs(ops): phase 2B exit criteria measured and recorded`
