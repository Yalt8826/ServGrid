# Phase 3 — Sales Rep

> **Superseded in part by the online-only decision (2026-09-15, `docs/decisions/2026-09-15-online-only.md`).** This is a historical record. Its offline mirror, outbox, `tech.offline` flag, pending-sync UI and sync endpoints were removed in Phase ON (`docs/implementation/PHASE-ON-ONLINE.md`); where it disagrees with the `PLAN*.md` documents, the plans win.

**Size M · ~4 weeks · Risk: medium — it is money**

Two users, offline-first, **reusing the Phase 1 outbox unchanged.**

**The role's condition:** in a customer's office or reception, phone in hand, often mid-conversation about money. Signal is usually fine but not guaranteed. Unlike the technician he is not rushed and not gloved — but he is **being watched by the person whose balance is on the screen**, which is its own constraint.

**The design consequence:** every screen a rep opens in front of a customer must be legible at arm's length and must never show something embarrassing — a stale figure presented as current, a spinner, or another rep's account.

**Entry** — Phase 1 exit met (the outbox must be proven before a second consumer). Decisions taken before starting:

1. **Is stock/inventory genuinely out of scope?** (`PLAN-DATA-MODEL.md` open item 3.) Sales snapshot prices but decrement nothing. If the owner expects stock levels, that is a new module, not a column — **and this is the last phase where it can be added without reworking the sales model.**
2. **Which companies belong to which rep, as a starting allocation.** Ownership is now a column and the reps have to agree the split before the phase goes live. House accounts — `owner_rep_id IS NULL` — are the answer for anything genuinely shared, and are also how leave gets covered.
3. Does any sales operation need a multi-parent `dependsOn`? Currently single-parent, no known case; a payment with a proof photo is still a single chain.

**Read before starting:** `PLAN-DATA-MODEL.md` §3.2 (companies), §3.5, §4 (money views) · `PLAN-BACKEND.md` §11, §10 · `UI/plan-2/06-SALES-REP.md` in full.

---

## The structural gate

**Phase 3 must reuse the Phase 1 outbox without modification.** If it cannot, the Phase 1 abstraction was wrong and this is the moment to find out — while there is still one consumer.

T3.8 makes that a test rather than a hope: the Phase 1 outbox suite must pass **unchanged**, with **no new code paths added to the drain**. If a change is genuinely needed, record what and why, because the same leak will reappear in Phase 4.

---

## Task graph

```
T3.1 migrations 017-018 ── T3.2 companies + ownership ── T3.3 sales cards
                                    │                          │
                                    ├── T3.4 payments ─────────┤
                                    ├── T3.5 ledger + balances │
                                    └── T3.6 rep cash handover │
                                                               │
T3.7 screens S1-S7 ── T3.8 outbox regression gate ── T3.9 month-end run
```

---

### T3.1 — Migrations 017–018: sales and the money views

**Reads:** `PLAN-DATA-MODEL.md` §3.5, §4 (`v_sales_card_totals`, `v_company_balances`, `v_employee_expected_cash`, `v_cash_reconciliation_queue`), §5
**Depends on:** Phase 2
**Tier:** free until deploy

> **Serial task.** One agent owns the migration sequence.
>
> **The numbers are 017 and 018, not 011 and 012.** Phase 2 used 011 (`assignment_notifications`) and Phase 1 used 016 (`flag_overrides`), and both are already applied, so they keep their numbers. 012 stays empty. See `PLAN-DATA-MODEL.md` §1. `sales` must not depend on anything numbered above 018 that has not shipped.

**Build**

**Migration 017 `sales`** — `sales_cards`, `sales_card_items`, `payments`.

```sql
-- sales_cards
sale_number text UNIQUE,   -- NULL while draft
CONSTRAINT sale_number_when_confirmed
  CHECK ((status = 'draft') = (sale_number IS NULL))
```

**Nullable and load-bearing.** The number is allocated at confirm, so a draft has none, and a `NOT NULL` makes drafts impossible.

**Void rather than delete, and a void needs a reason.** Dues are derived, so **a void is the only correct way to reverse a sale** — deleting the row would silently move a company's balance with no trace.

**`sales_card_items`** — `product_id` nullable, and then the **snapshots**: `product_name NOT NULL`, `product_sku`, `quantity`, `unit_price`, `line_total` generated as `round(quantity * unit_price, 2)`, `serial_numbers text[]`.

The snapshot columns are why a product rename or repricing next quarter does not rewrite last quarter's sale. `product_id` is kept for reporting joins but **is never read for display**.

**`payments`** — `payment_number UNIQUE` (allocated at create; payments are not drafted), `sales_card_id` **nullable** (NULL = on-account), `amount > 0`, `business_date` generated, `status` (`collected | void`).

**There is no `pending` payment status, deliberately.** *Pending is a view of dues, not a row.* Modelling an intention to collect ₹40,000 as a row would create exactly the stored-counter drift the plan rejects.

**Migration 018 `views_money`** — four views:

**`v_sales_card_totals`** — per card, `SUM(line_total)` with `status` carried through. **Every other total in the system reads this**, so "what is a sale worth" is defined once.

**`v_company_balances`** — `SUM(confirmed sales) − SUM(collected payments)` per company, plus `last_sale_date` and `last_payment_at`. Drafts and voids excluded on both sides. **This is the number that rises the moment a sale is confirmed** — and it cannot drift, where a stored counter is correct until the first edit, void or retried request.

**`v_employee_expected_cash`** — cash that passed through a person's hands on a day, from **both** sources:

- `SUM(amount_collected)` from `job_completions` grouped by `completed_by, business_date`, filtered `collection_mode = 'cash'`
- `UNION ALL` `SUM(amount)` from `payments` grouped by `received_by, business_date`, filtered `mode = 'cash'` **and** `status = 'collected'`

then summed per `(employee_id, business_date)`.

**Note the grouping keys.** Completions group by `completed_by`, **not** `job_cards.assigned_to` — if a job is reassigned mid-day the cash is with whoever closed it. Payments follow the same principle with `received_by`, which is why a rep may legitimately hold cash for an account he does not own.

**`v_cash_reconciliation_queue`** — a **`FULL OUTER JOIN`** between expected and declared, then `JOIN employees` for the name. Variance is `declared_amount − expected`. Four flags:

| flag | meaning |
|---|---|
| `missing_submission` | collected cash, no declaration — **the row the feature exists for** |
| `no_expected_cash` | declared money the system did not expect |
| `variance` | declared ≠ expected |
| `match` | reconciled |

**`FULL OUTER JOIN` and not `LEFT JOIN`.** `missing_submission` is the only flag whose row does not exist on one side of the join, so it is the only one a `LEFT JOIN` would silently drop — and it is the row the entire feature exists to catch.

**No expenses term**, because employees do not spend from collections. Every variance is therefore a real one, which is what makes the flag worth reading.

**Tests**

`apps/api/test/integration/views-money.test.ts`
- `v_company_balances` excludes drafts and voids on both sides
- **An overpayment produces a negative balance** and the view does not clamp it
- `v_employee_expected_cash` sums a completion **and** a payment for the same employee-day into one row
- Cash attributed to `completed_by`, not `assigned_to`, on a job reassigned mid-day
- Non-cash modes contribute **nothing**
- `v_cash_reconciliation_queue` emits `missing_submission` for a day with collections and no declaration — **the fixture that proves the FULL OUTER JOIN**
- The other three flags, each from a hand-counted fixture
- **A rep-day with a cash payment and no declaration also flags `missing_submission`** — the payments side is exercised, not just completions

`apps/api/test/integration/schema-sales.test.ts`
- Draft with a `sale_number` → violation; confirmed without → violation
- `line_total` generated, not writable
- Payment with `amount = 0` → violation

**Done when**
- [ ] All four flags proven from fixtures, `missing_submission` on **both** sides
- [ ] Negative balance renders through the view intact

**If it fails**
If `missing_submission` never appears, the join is a `LEFT JOIN`. That is the single most likely defect in this migration and it is invisible: every other flag still works, and the one row the feature exists to catch is silently absent. **Check the join type before checking the flag logic.**

**Commits**
`chore(start): T3.1 sales schema and money views` → `feat(db): migrations 017-018 — sales, payments, derived balances, reconciliation queue`

---

### T3.2 — Companies with rep ownership

**Reads:** `PLAN-DATA-MODEL.md` §3.2 · `PLAN-BACKEND.md` §5 (`own` on company), §11
**Depends on:** T3.1
**Tier:** T2 · **Flag:** `sales.cards`

**Build**

**`own` on `company` means `owner_rep_id = :actor OR owner_rep_id IS NULL`.** Each rep owns his accounts; **a NULL owner is a house account visible to both**, and is where a company created by the owner lands.

**The nullable case does real work.** Without it the model is brittle — an account has to belong to someone the moment it exists, and there is no shape for "both reps handle this one".

**Only the owner can change `owner_rep_id`** (`PATCH /v1/companies/:id/owner`, owner only). A rep cannot claim another rep's account or hand one off. **That is also how leave is covered:** the owner reassigns or nulls a rep's accounts for the duration, and the change leaves a trail.

A rep who **creates** a company becomes its owner.

**`payments.received_by` records whoever actually took the money**, even if that is not the account's owning rep. This follows the precedent `job_completions.completed_by` already set: the record says who did the thing, not who was supposed to.

**Tests**

`apps/api/test/authz/companies.test.ts`
- **A rep sees his accounts plus house accounts, and not the other rep's — every company endpoint, both reps.** Assert on returned rows, not on a count
- A rep cannot reassign an account, **his own included**
- The owner can reassign, including to `NULL`
- A rep creating a company becomes `owner_rep_id`
- A payment recorded by a non-owning rep is **accepted** and records him in `received_by`

`apps/api/test/integration/companies.test.ts`
- Case-insensitive unique name among active rows; an inactive duplicate is allowed
- **Two reps create the same company offline** → the second is `rejected` with `DUPLICATE_ENTITY` and `details.existing` carrying the server's row

**Done when**
- [ ] Rep isolation proven on every company endpoint, both directions
- [ ] House accounts visible to both reps

**If it fails**
If a rep can see the other rep's accounts, the scope is being applied after the query. `own` on company must become the SQL predicate `owner_rep_id = :actor OR owner_rep_id IS NULL` inside the `WHERE`, never a filter over the result set — the two behave identically until someone adds pagination, and then the second one starts returning short pages of nothing.

**Commits**
`chore(start): T3.2 company ownership` → `feat(api): rep account ownership with house accounts, owner-only reassignment`

---

### T3.3 — Sales cards

**Reads:** `PLAN-BACKEND.md` §11 · `PLAN-DATA-MODEL.md` §3.5
**Depends on:** T3.2
**Tier:** T2 · **Flag:** `sales.cards`

**Build**

`GET/POST /v1/sales`, `PATCH` (own, **draft only**), `POST /:id/confirm`, `POST /:id/void` (**owner only**).

**Sale numbers are allocated at confirm, not at create.** A draft that never confirms should not burn a number, and the rep's device shows "Draft" until then — consistent with the rule that the device never shows a fake local number.

**Reps create and confirm; only the owner voids.** A rep who needs a sale reversed asks. That is the correct amount of friction for the operation that moves a company's balance.

Items are nested in the create payload. Every line snapshots `product_name`, `product_sku` and `unit_price` **at add time**.

**Tests**

`apps/api/test/integration/sales.test.ts`
- Draft burns no number; confirm allocates one and sets `confirmed_at`
- `PATCH` on a confirmed sale → refused
- **A void requires a reason and leaves the balance correct** — assert `v_company_balances` before and after
- Renaming and repricing a product afterwards **does not change** a confirmed sale's stored line
- A rep cannot void; the owner can

`apps/api/test/property/balances.test.ts` — **the property test, and it is the highest-value test in this phase:**

> For random sequences of `confirm` / `void` / `pay` / `void-payment`, `v_company_balances.balance` always equals `Σ confirmed sales − Σ collected payments`.

**1000 generated sequences, zero violations.**

**Done when**
- [ ] Property test green over 1000 sequences
- [ ] Snapshot immutability proven by mutating the product afterwards

**If it fails**
A property-test failure is not a flaky test. It means the view and the intent disagree, and the answer is in the view, not in the sequence that found it.

**Commits**
`chore(start): T3.3 sales cards` → `feat(api): sales cards with price snapshots, confirm-time numbering, owner-only void`

---

### T3.4 — Payments

**Reads:** `PLAN-BACKEND.md` §11 · `PLAN-DATA-MODEL.md` §3.5
**Depends on:** T3.3
**Tier:** T2 · **Flag:** `sales.payments`

**Build**

`GET/POST /v1/payments`, `POST /:id/void` (owner only). Proof photo via the attachments endpoint, `dependsOn` its parent payment in the outbox.

`sales_card_id` nullable — an **on-account** payment lands on the company balance without pointing at a specific sale, which is how most collections actually work.

**Tests**

`apps/api/test/integration/payments.test.ts`
- On-account payment (`sales_card_id` NULL) moves the company balance
- Void requires a reason and reverses the balance
- **A cash payment appears in `v_employee_expected_cash` for that rep's day**; a UPI payment does not
- A rep sees his own payments and not the other rep's, **including for a house account** — `own` on payment is `received_by`, which is stricter than `own` on company

`apps/api/e2e` (mobile, T3.7)
- Record a payment offline with a proof photo → reconnect → **photo uploads after its parent**

**Done when**
- [ ] Cash contribution to expected cash proven; non-cash proven not to contribute
- [ ] Photo ordering proven across the two drain passes

**If it fails**
If a cash payment does not reach `v_employee_expected_cash`, check the view filters `status = 'collected'` as well as `mode = 'cash'` — a voided cash payment must not create an expectation the rep can never satisfy, and that is a shortfall he will be asked about.

**Commits**
`chore(start): T3.4 payments` → `feat(api): payment capture with on-account support and proof attachments`

---

### T3.5 — Ledger and balances

**Reads:** `PLAN-BACKEND.md` §11 · `UI/plan-2/06-SALES-REP.md` §S4
**Depends on:** T3.4
**Parallel with:** T3.6
**Tier:** T2 · **Flag:** `sales.payments`

**Build**

`GET /v1/companies/:id/ledger` — interleaved sales and payments, newest first, **with a running balance**. Computed server-side so the rep's phone and the owner's desktop cannot disagree.

`GET /v1/companies/balances?minBalance=0.01` — **the Pending tab.** It reads `v_company_balances`, not a payments table, because *pending is a view of dues, not a row*.

**Tests**

`apps/api/test/integration/ledger.test.ts`
- Running balance at the newest row equals `v_company_balances.balance` **exactly**, to the paisa
- Voided rows appear in the ledger as voided **and do not move the running balance**
- Ledger is scoped: a rep cannot read another rep's account's ledger

**Done when**
- [ ] Ledger's newest running balance matches the view to the paisa across a 200-row fixture

**If it fails**
If the running balance drifts from the view, the ledger is computing forwards from zero rather than backwards from the current balance. Compute it the same way the view does or the two will disagree at exactly the moment a rep is showing it to a customer.

**Commits**
`chore(start): T3.5 ledger` → `feat(api): company ledger with running balance, dues query`

---

### T3.6 — Rep cash handover

**Reads:** `PLAN-BACKEND.md` §10 · `PLAN-DATA-MODEL.md` §3.7 · `UI/plan-2/06-SALES-REP.md` §S6
**Depends on:** T3.1, T1.11
**Parallel with:** T3.5
**Tier:** T2 · **Flag:** `sales.cash`

**Build**

**No new endpoint and no new screen.** `cash_reconciliations` is keyed on `employee_id`, and `POST /v1/cash/handovers` already accepts technician or sales rep. This task is wiring, a flag, and a test — which is the point.

**Sales reps declare too, and the rarity is the argument for it, not against.** A rep who accepts cash from a company was previously holding money the system would never ask him about. Because rep cash is *rare*, that is more dangerous rather than less: **an unreconciled path nobody exercises is one nobody notices is broken.**

The rep's handover is the technician's screen with a different heading, and it sits **in the tab bar at the same level** — not behind a menu.

**Tests**

`apps/api/test/integration/rep-cash.test.ts`
- A rep declares; the row is keyed on his `employee_id`
- **A rep-day with a cash payment and no declaration flags `missing_submission`** — the same fixture as T3.1, asserted from the endpoint this time
- A rep's `GET /me` omits `expected_cash`
- Amend while `submitted`, refused after `confirmed` — the same rule as the technician's

**Done when**
- [ ] The rep path proven through the queue, not just through the table

**If it fails**
T0: `sales.cash` off. The rest of the rep's app is unaffected — but record it, because turning this off restores the exact condition the feature exists to remove: **a rep holding money the system never asks him about.**

**Commits**
`chore(start): T3.6 rep cash handover` → `feat(api): sales rep cash declaration behind sales.cash`

---

### T3.7 — Screens S1–S7

**Reads:** `UI/plan-2/06-SALES-REP.md` in full · `UI/plan-2/01-FOUNDATIONS.md` §6 (number formats)
**Depends on:** T3.2–T3.6, T0.13
**Tier:** T1 · **Flags:** `sales.cards`, `sales.payments`, `sales.cash`

**Build**

Density `field`. **Four tabs: Dashboard · Sales · Cash · Profile.** The Sales group carries sales, payments, companies, contracts and renewals.

**S1 Dashboard.** Worst moment: sitting with a company's accounts person who says *"we paid that last week."*

Two figures — sold this month, outstanding across his accounts — both `mono` tabular `en-IN`. **Owes the most**: top companies by balance descending; a rep's day is largely this list in order. **Renewing soon** from `v_contracts_expiring`, days remaining rather than a date because urgency is the point. Recent payments, for reassurance that they landed.

**Stale matters more here than anywhere.** The *figures* carry the dashed inset when the mirror has unsynced writes behind them. **A balance shown to a customer while a payment sits in the outbox is the single most embarrassing thing this app can do**, and the inset plus `Pending sync` is the honest answer.

Motion: figures **cross-fade** on change, 140ms. **No count-up** — a money figure animating in front of a customer looks like a slot machine.

**S2 Sales.** List rows: sale number, company, date, total right-aligned, status pill. **Drafts sort first** and carry a `Draft` chip — an unconfirmed sale burns no number and moves no balance, so it needs to be visibly unfinished.

Create: company search (his accounts + house), date, line items, notes. **The product picker snapshots name, SKU and price at add time**; the row shows the snapshot, not a live lookup. **The unit price is editable on the line**, because a negotiated price is normal, and the snapshot records what was actually agreed. Serial numbers optional per line, collapsed.

**Total is computed and displayed** — unlike the technician's parts list, here it *is* a bill and `v_sales_card_totals` defines it.

Two-button ending: *Save draft* (secondary) and *Confirm sale* (primary). Confirming moves a balance, so it gets the accent and a confirmation step — and only the owner can void afterwards.

**S3 Payments.** Two tabs, and **the first is labelled `Owed`, not `Pending`.**

Labelling it "Pending payments" invites the reading that a row is a payment, which is exactly the stored-counter thinking the data model rejects. So the UI says it plainly: rows read *"Sterling Industries · owes ₹85,000"* with a **Record payment** action — the verb makes clear the payment does not exist yet. Empty state: *"No company owes you anything."*

Record payment: company (prefilled from a row), amount, against (on-account or a specific sale), **mode**, reference, proof photo.

**Mode as segments on two rows** — `Cash` `UPI` `Cheque` / `Bank` `Card`, each 52 tall. Five across 360dp gives each about 64dp and "Bank transfer" truncates to something ambiguous. **This screen is filled in front of the person paying**; a mis-tap records the wrong mode on real money and puts a phantom entry in someone's cash reconciliation.

**Cash is first and visually identical to the others** — emphasising it would nudge behaviour in the one area the reconciliation exists to police. First because it is the one with a consequence.

Reference appears for non-cash modes only, required for cheque and bank. **Choosing Cash raises one line:** *"Cash goes on your handover today."* Not a warning — a reminder connecting two screens the rep would otherwise experience as unrelated.

Motion: recording a payment updates the company's balance on the previous screen **optimistically, before the sheet closes**. This is the clearest demonstration of the derived-balance model in the product, and it should feel instant — 140ms cross-fade as the sheet dismisses.

**S4 Companies.** Rows: company, balance right-aligned, last activity, sorted by balance descending. House accounts carry a small `Shared` chip.

**He sees his accounts plus house accounts. The UI never hints that other accounts exist** — no greyed rows, no "12 more".

Ledger: interleaved, newest first, **running balance column**, all `mono` tabular so the column aligns and a customer reading it upside down can follow it.

**A negative balance renders in `feedback.success` with the word `Credit`**, not as a minus sign in red. An overpayment is good news and the schema explicitly permits it.

**No reassign-owner control** — only the owner can move an account, and a disabled button here would only invite the question.

**S6 Cash handover** — identical to `UI/plan-2/04-TECHNICIAN.md` §T6 with a different heading. No expected figure, no expenses field, amend while `submitted`.

**S7 Profile** — name, role, `TrackingHealthChip` (**reps are tracked too**), permission ladder, pending count, logout gate.

**Not on S7:** no commission, no targets, **no comparison with the other rep.** Two people who work alongside each other do not need the app ranking them.

**Tests**

`apps/mobile/src/screens/rep/*.test.tsx`
- Dashboard figures carry the stale inset when the outbox is non-empty
- Figures cross-fade, never count up
- Payments tab is labelled **Owed**; the empty state names companies, not payments
- Mode segments render on two rows; each is ≥52 tall at 360dp
- Choosing Cash renders the handover reminder; choosing UPI reveals the reference field
- A negative balance renders `Credit` in success colour, with no minus sign
- Company list contains **no reference to the other rep's accounts** at any depth
- Drafts sort first and carry the Draft chip

**Done when**
- [ ] Stale figures proven — this is the screen where the state matters most
- [ ] Rep isolation proven in the rendered tree, not only the payload
- [ ] Payment sheet usable one-handed at 360dp with no truncated mode label

**If it fails**
T0 per flag, T1 for a republish. The failure that matters most on these screens is not a crash: it is a balance shown to a customer while a payment sits in the outbox. If the stale inset is not rendering on the figures, **turn `sales.payments` off rather than shipping it** — a wrong number in front of the person who paid is worse than a missing feature.

**Commits**
`chore(start): T3.7 rep screens` → `feat(mobile): sales, payments with Owed tab, companies with ledger, rep handover`

---

### T3.8 — The outbox regression gate

**Reads:** `PLAN-FRONTEND.md` §5, §9 (rep) · `PLAN-EXECUTION.md` Phase 3 exit
**Depends on:** T3.7
**Tier:** —

> **The phase's structural gate.** Run it as its own task so the answer is unambiguous.

**Build** nothing. **Prove** that:

- The **Phase 1 outbox test suite passes unchanged** — not adjusted, not extended, unchanged
- **No new code paths were added to the drain.** Assert by diffing `apps/mobile/src/sync/` against its Phase 1 state: new entity types and new endpoints in the queue are expected; new branches in the drain are not

**Tests** — the Phase 1 suite, run unmodified, plus a structural diff:

```bash
git stash && git checkout phase-1 -- apps/mobile/src/sync/__tests__ && pnpm -F mobile test sync
git diff phase-1..HEAD -- apps/mobile/src/sync/drain.ts
```

The first must be green with the Phase 1 tests exactly as they were. The second must show no new conditional branches — new entity types and new endpoints in the queue are expected; new branches in the drain are the thing being tested for.

**Done when**
- [ ] Phase 1 outbox suite green with zero edits
- [ ] The drain diff shows no new conditional branches

**If it fails**
**Record what changed and why**, because the same leak will reappear in Phase 4. Then take the descope if it is structural: **ship sales reps online-only**, like dispatchers, with clear error states. Reps are meaningfully less offline than technicians. Losing rep offline support costs some field convenience; **forking the outbox into two divergent implementations costs correctness in the part of the system that handles money.**

**Commits**
`chore(start): T3.8 outbox regression gate` → `test(mobile): phase 1 outbox suite green unchanged for a second consumer`

---

### T3.9 — Month-end parallel run and phase exit

**Reads:** `PLAN-EXECUTION.md` Phase 3 exit
**Depends on:** all of Phase 3
**Tier:** T0 per flag

*Checklist rewritten for the online-only app on 2026-09-15; the run is still pending.*

**Build** nothing. **Run a month of real selling and collecting.**

**One full month-end cycle.** Not two weeks — the thing being tested is whether the balances match the books, and that only happens at month end.

**Tests** — the books are the test. At month end, reconcile every company's balance against the owner's own figures, one at a time, and record each mismatch with its cause before fixing anything.

**Done when**

- [ ] **Month-end balances match the owner's manual figures to the rupee, across every company**
- [ ] **No rep submit silently lost** — every failed sale or payment was seen and retried or recorded
- [ ] At least one **discounted sale line** recorded on real data, and the sale detail showed list price, discount and final price the way the rep agreed it with the customer
- [ ] **Proof photos uploaded for real payments**, and the owner found them sufficient evidence without a reference number — if not, that is a decision to revisit, not a field to quietly re-add
- [ ] Both reps recorded a full month of sales and collections in-app
- [ ] At least one **void exercised on real data**, balance verified afterwards
- [ ] Neither rep saw the other's accounts, and neither reported the split getting in their way — **if it did, house accounts are the release valve, not a code change**
- [ ] **If any cash was collected by a rep, it appeared in the owner's reconciliation queue. If none was, record that** — a path with no traffic is untested, not proven

**If it fails**

**T4 is the live risk in this phase.** Wrong financial data is corrected by **voiding and re-entering, never by `DELETE` or `UPDATE`**, so the ledger keeps a record of the correction.

**Before cutover, confirm the owner understands that void-and-reenter is the correction path.** It is the one place where the system deliberately refuses to let a mistake vanish, and it will feel wrong the first time unless it was explained beforehand.

| Scenario | Tier | Action |
|---|---|---|
| A rep screen is wrong | T0 | `sales.cards` / `sales.payments` off |
| Rep handover misbehaving | T0 | `sales.cash` off — the rest of sales stays up |
| App logic bug | T1 | previous EAS update |
| API bug | T2 | previous image |
| **Wrong money** | **T4** | **void and re-enter, with a reason. Never a `DELETE`** |

Sales tables are additive; a rollback to Phase 2 leaves them unwritten.

**Descope** — ~~if the outbox does not generalise, ship reps online-only~~: taken for every role on 2026-09-15.

**Commits**
`chore(start): T3.9 month-end run` → `docs(ops): phase 3 exit criteria measured, balances reconciled to the rupee`
