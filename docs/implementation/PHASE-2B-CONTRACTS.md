# Phase 2B — AMC contracts

**Size M · ~3 weeks · Risk: low technically, medium commercially**

Rebuilt on 2026-09-15 from the owner's description of how AMCs actually run (`../decisions/2026-09-15-amc-contracts.md`). The earlier design — reps selling a fixed number of visits, a nightly generator raising each one — is superseded; this file is the authority.

**An AMC is a 12-month agreement for a customer site, recorded by the dispatcher with its price.** Work under it is dispatched by hand: picking a customer with an AMC on the dispatch form offers an AMC option, already ticked. The app's job is to **remind the dispatcher** — four months after the customer's last completed job, and seven days before the AMC ends — on a dedicated **AMC** tab.

**Entry** — Phase ON merged. Nothing else: the commercial questions are answered in the decision record.

**Read before starting:** the decision record in full · `PLAN-DATA-MODEL.md` §3.10, §4 (`v_contracts`) · `PLAN-BACKEND.md` §6.3 (`POST /v1/jobs`), §11.1 · `UI/plan-2/05-DISPATCHER.md` §D5.

---

## The property to protect

**A job linked to an AMC is an ordinary job.** The same picker assigns it, the same sheet closes it, the same events record it, the same cancel flow reschedules it. The branches on "is this an AMC job" are exactly three: the chip, the dispatch form's AMC option, and the complete sheet's *Free under AMC / Charge* choice. Any fourth is a review rejection — it is what would make turning `contracts.manage` off stop being a clean rollback.

---

## Task graph

```
T2B.0 docs ── T2B.1 migration 015 ── T2B.2 contracts API ──┬── T2B.4 AMC tab + dispatch option
                                    └── T2B.3 job create ──┴── T2B.5 technician + owner ── T2B.6 field run
```

---

### T2B.0 — Decision record and plan

**Depends on:** — · **Tier:** free (docs)

**Build** — `docs/decisions/2026-09-15-amc-contracts.md`; this file; the contract passages of `PLAN.md`, `PLAN-DATA-MODEL.md`, `PLAN-BACKEND.md`, `PLAN-FRONTEND.md`, `PLAN-EXECUTION.md` and `UI/plan-2` rewritten to match.

**Commits** `chore(start): T2B.0 AMC decision and plan` → `docs: AMC contracts as the owner runs them — decision and phase plan`

---

### T2B.1 — Migration 015: contracts

**Reads:** `PLAN-DATA-MODEL.md` §3.10, §4 · **Depends on:** T2B.0 · **Tier:** T2

**Build**

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE service_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number text NOT NULL UNIQUE,          -- AMC-2627-00031, allocated at create
  customer_id     uuid NOT NULL REFERENCES customers(id),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  contract_value  numeric(12,2) NOT NULL,
  notes           text,
  created_by      uuid NOT NULL REFERENCES employees(id),
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES employees(id),
  cancel_reason   text,
  created_at, updated_at, version …             -- touch_updated_at() trigger
  CHECK (end_date >= start_date),
  CHECK (contract_value >= 0),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)
     AND (cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CONSTRAINT service_contracts_no_overlap EXCLUDE USING gist
    (customer_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
    WHERE (cancelled_at IS NULL)
);

ALTER TABLE job_cards ADD COLUMN contract_id uuid REFERENCES service_contracts(id);
CREATE INDEX job_cards_contract_idx ON job_cards (contract_id) WHERE contract_id IS NOT NULL;
```

**One AMC per site at a time, as ranges that may not overlap.** A renewal starting the day after the current term ends is legal the moment it is recorded; a genuine overlap is refused by the database, and the API names the existing AMC. Cancelled rows are excluded, so a mistaken AMC can be cancelled and recorded again.

**`job_cards.contract_visit_id` is retired, not dropped.** Nothing ever wrote it, but the previous API image still selects it, so dropping it would break the T2 rollback. It is removed in Phase 5's cleanup as a contract step.

**Views**
- `v_job_cards_dispatcher` — `is_contract_visit` now reads `contract_id IS NOT NULL`; `contract_id` appended.
- **`v_contracts`** — one row per AMC with the derived facts every screen reads:
  - `state` — `cancelled` if `cancelled_at`, else `upcoming` / `active` / `expired` against `business_date(now())`
  - `last_service_date` — `business_date(closed_at)` of the customer's latest **completed** job, any job
  - `next_visit_due` — `GREATEST(start_date, last_service_date) + 4 months`
  - `open_job_id`, `open_job_number`, `open_job_scheduled_for` — the customer's earliest open job
  - `is_visit_due` — `active`, `next_visit_due <= today`, and **no open job** (a customer already booked is not a reminder)
  - `days_to_end`, `is_ending_soon` — `active` and `end_date - today` between 0 and 7

**Tests** — `test/integration/schema-contracts.test.ts`
- Overlapping ranges at one customer → exclusion violation; adjacent ranges (renewal) → accepted; an overlap with a **cancelled** AMC → accepted
- `end_date < start_date` → violation; negative value → violation; half-filled cancellation trio → violation
- `v_contracts.state` for upcoming / active / expired / cancelled fixtures
- `next_visit_due` from the start date with no jobs; from the latest completed job of **any** kind; a cancelled job does not count
- `is_visit_due` false while the customer has an open job
- `is_ending_soon` at 7 days, not at 8

**Commits** `chore(start): T2B.1 contracts schema` → `feat(db): migration 015 — service contracts, derived AMC state and reminders`

---

### T2B.2 — Contracts API

**Reads:** `PLAN-BACKEND.md` §11.1, §5 · **Depends on:** T2B.1 · **Tier:** T2 · **Flag:** `contracts.manage`

**Build** — `modules/contracts/`: dispatcher and owner only.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/contracts` | `?filter=all\|due\|ending`, `customerId`, `state`, `q`; due sorts most overdue first, ending by days left |
| GET | `/v1/contracts/:id` | the AMC plus every job linked to it |
| POST | `/v1/contracts` | idempotent; allocates `AMC-…`; overlap → **409 `DUPLICATE_ENTITY` naming the existing AMC** |
| PATCH | `/v1/contracts/:id` | `If-Match`; dates, value, notes; a cancelled AMC → 409 |
| POST | `/v1/contracts/:id/cancel` | idempotent; reason required |

- Contract schemas live in a new `packages/shared/src/contracts.ts` (so T2B.3 can edit `schemas.ts` in parallel without a conflict).
- Permission matrix: dispatcher `contract` and `contract.money` read/create/update/delete `all`; sales rep `none`; technician `contract` `assigned` read only, `contract.money` `none`.
- `contracts.generate` removed from the flag registry. The sequence prefix for `contract:` becomes `AMC`.
- `no-sql-money-tables` guards `job_completions` only; the money-leak suite stops forbidding `contract_value` for the dispatcher's contract reads and keeps forbidding every completion figure.

**Tests** — `test/integration/contracts.test.ts`, `test/authz/contracts.test.ts`
- Create allocates a number; the same key replayed returns the same AMC; an overlap is 409 with `details.existing`
- A renewal starting the day after the current AMC ends is accepted
- `filter=due` lists a customer four months after his last completed job and not one with an open job; `filter=ending` lists an AMC ending in 7 days and not in 8
- PATCH with a stale version → 409; PATCH or cancel of a cancelled AMC → 409
- Sales rep and technician → 403 on every route; flag off → `FLAG_DISABLED`

**Commits** `chore(start): T2B.2 contracts api` → `feat(api): AMC contracts — record, edit, cancel, due and ending lists`

---

### T2B.3 — Job create, with the AMC link

**Reads:** `PLAN-BACKEND.md` §6.3 · **Depends on:** T2B.1 · **Parallel with:** T2B.2 · **Tier:** T2 · **Flag:** `dispatch.console`

**Build**
- **`POST /v1/jobs`** — dispatcher and owner, idempotent. `{ customerId, serviceId, customerProductId?, priority, scheduledFor?, contactName?, contactPhone?, description?, contractId? }`. Allocates `JC-…`, title from the service, `unassigned`, emits `created`. Returns the role's card schema.
- `contractId` must belong to the customer, not be cancelled, and cover the job's day (its scheduled date, or today) — else a 422 in plain words.
- Cancel with `rescheduleTo`: the successor inherits `contract_id` when that AMC covers the new date. The Phase 1 contract-visit hooks (`onContractVisitCompleted` / `onContractVisitCancelled`) are deleted.
- The technician's card and work read carry `contract: { number, endDate } | null` — only for an uncancelled AMC. The owner's card keeps `isContractVisit`, now reading `contract_id`.
- **The technician app follows the new shape in this task** so `main` stays green: the chip reads *AMC · until 14 Sep 2027*, the prepaid branch of the complete sheet and the cancel sheet's "spends a visit" warning are removed. The Free/Charge choice itself is T2B.5.
- The owner's attention feed gains rank 5, **AMCs ending within 7 days**.

**Tests** — `test/integration/jobs-create.test.ts`
- Dispatcher creates a job → number allocated, `unassigned`, event written; replay returns the same card
- With a covering `contractId` → linked; another customer's AMC, a cancelled one, or one not covering the date → 422
- A technician or rep → 403; the dispatcher's response carries no money key (money-leak walk)
- Cancel-with-date on an AMC job → the successor is linked to the same AMC
- The technician's work read shows `contract.number` and never `contract_value`

**Commits** `chore(start): T2B.3 job create` → `feat(api): dispatcher job create with the AMC link`

---

### T2B.4 — The AMC tab and the dispatch option

**Reads:** `UI/plan-2/05-DISPATCHER.md` §D3, §D5 · **Depends on:** T2B.2, T2B.3 · **Tier:** T1 · **Flag:** `contracts.manage`

**Build**
- Nav map: dispatcher **4 tabs** — Dashboard · Operations (jobs, dispatch, customers) · **AMC** (`/contracts`, `/contracts/new`) · Profile. Rep loses `/contracts`; `/contracts/renewals` is removed for every role.
- **AMC screen** — three sections: *Due for a visit* (customer · last service · due since, with **Dispatch**, which opens the dispatch form on that customer) · *Ending within 7 days* (with **Renew**) · *All AMCs* (search).
- **AMC detail** — number, customer, dates, price, state, last service, next due, notes, every linked job; *Edit* · *Renew* · *Cancel* (reason).
- **AMC form** — customer search, start (today), end (start + 12 months − 1 day), price, notes. *Renew* prefills start = old end + 1 and the old price. An overlap shows the existing AMC's number as a link.
- **Dispatch form** — a customer with an AMC covering today shows *AMC job · AMC-2627-00031 · until 14 Sep 2027*, **ticked**; the submit carries `contractId` when ticked. `?customerId=` preselects the customer.
- Rep dashboard: *Renewing soon* removed.
- Owner: the old O6 contract screens are replaced by the same AMC screens — cards on a phone, the desk table on web.

**Tests** — `screens/contracts/*.test.tsx`, `dispatch.test.tsx`, `navmap.test.ts`
- Due rows render the due-since date and a Dispatch action routed with the customer; ending rows at 7 days
- The form defaults to 12 months; Renew prefills from the old AMC; 409 renders the existing number as a link
- The AMC option appears ticked for a customer with an AMC and is absent for one without; unticking sends no `contractId`
- Dispatcher has 4 tabs; the rep map has no `/contracts`

**Commits** `chore(start): T2B.4 amc tab` → `feat(mobile): AMC tab for dispatcher and owner, AMC form, dispatch AMC option`

---

### T2B.5 — Technician and owner

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T4, §T5 · `07-OWNER.md` §O6 · **Depends on:** T2B.3 · **Tier:** T1

**Build**
- **Complete sheet, AMC job** — two segments, *Free under AMC* (selected) and *Charge*. Free: the amount field and Paid-by are **absent** and the payload carries no cost and mode `none`. Charge: the ordinary money fields.
- Owner: the dashboard's attention feed renders the *AMC ending* row (rank 5, from T2B.3).

**Tests**
- AMC job: the sheet opens on Free with no amount field in the tree; switching to Charge shows it; Free submits `collectionMode: 'none'` and no `cost`
- The owner attention feed renders an *AMC ending* row linking to the AMC
- An ordinary job shows no segments
- The AMC chip resolves to the muted colour, not `#F2C200`

**Commits** `chore(start): T2B.5 technician and owner amc` → `feat(mobile): free-or-charge AMC completion, owner AMC attention row`

---

### T2B.6 — Field run and phase exit

**Depends on:** all of Phase 2B · **Tier:** T0 per flag

**Build** nothing. **Record the real AMCs and run two weeks.**

**Done when**
- [ ] Every live AMC is recorded in the app by a dispatcher, with its price, and none overlaps another at the same site
- [ ] **The due list matched the dispatcher's own sense of who was due** — a customer the office would have called is on it, and nobody on it had just been visited
- [ ] At least one reminder was dispatched straight from the AMC tab, with the AMC option ticked
- [ ] A technician completed an AMC job **free** and another **charged**, and the office agreed with both
- [ ] An AMC ending within 7 days was renewed from the tab, and the renewal began the day after the old one ended
- [ ] No sales rep saw an AMC; no technician saw an AMC price

**If it fails**

| Scenario | Tier | Action |
|---|---|---|
| AMC screens or reminders wrong | T0 | `contracts.manage` off — linked jobs stay ordinary jobs |
| Job create wrong | T0 | `dispatch.console` off |
| API bug | T2 | previous image |
| A wrong AMC recorded | — | cancel it with a reason and record it again |

**Commits** `chore(start): T2B.6 amc field run` → `docs(ops): phase 2B exit criteria measured and recorded`
