# Phase 4 — Owner

**Size L · ~6 weeks · Risk: medium — two layouts and a fork in the road**

One user. Online-only: no mirror, no outbox. At a desk with a laptop most of the time, on a phone the rest. **Not rushed. Wants to *verify* rather than operate** — the recurring question is "is this right, and if not, who do I ask?"

**Entry — one blocking item, one already cleared:**

1. **Map tile source decided** (`PLAN-FRONTEND.md` open item 2) — self-hosted raster vs. a free tier with attribution obligations.
2. FCM was the second blocker. It is proven since Phase 0 and in production use since Phase 2, so *Locate now* inherits a channel that has been carrying assignment notifications for two phases. **That is the straightforward gain from moving it early: the riskiest part of on-demand location is no longer new.**

**And one assessment on day 3, not in week 4:** does React Native Web carry the `DataTable` and the rail acceptably? T4.1.

**Read before starting:** `UI/plan-2/07-OWNER.md` in full · `PLAN-BACKEND.md` §6.2b, §8, §10, §4.1 · `PLAN-DATA-MODEL.md` §4.

---

## The rule that governs every screen in this phase

**The same job is a card on a phone and a table row on desktop.** Not a card grid. Scanning 200 jobs needs rows, sortable columns and a scannable left edge, and forcing phone cards onto a desktop is the commonest way a React Native Web build ends up feeling like a phone app in a browser window.

**This is a review checkpoint on every screen below, not a preference.**

---

## Task graph

```
T4.1 RNW spike  ← day 3, blocking
     │
     ├── T4.2 cash queue api ── T4.3 amendment + reopen
     ├── T4.4 location console api
     ├── T4.5 employee admin + deactivation
     └── T4.6 dashboards api
              │
     T4.7 desktop rail + DataTable
              │
     ├── T4.8 O1 dashboard      ├── T4.11 O4/O4b jobs, dispatch, customers
     ├── T4.9 O2 cash queue     └── T4.12 O5-O9
     └── T4.10 O3 location console
                                     │
                               T4.13 field run
```

---

### T4.1 — React Native Web spike

**Reads:** `PLAN-FRONTEND.md` open item 5 · `PLAN-EXECUTION.md` Phase 4 entry
**Depends on:** Phase 3
**Tier:** throwaway
**Timebox:** **three days. Not a week.**

**Build** a throwaway: `DataTable` with 500 rows, sortable, sticky header, virtualised; the 240px left rail; both at 1280px and 1920px.

**The question:** does RNW carry these acceptably, or does it fight them?

**Tests** — a spike's test is a measurement and a written verdict, not a suite:

- 500 rows, sort by three different columns, frame timing captured in Chrome and Firefox
- Sticky header under virtualised scroll at 1280px and 1920px
- The rail rendered against the real token set, not a placeholder — half the RNW pain is in fonts and borders, not layout

**Done when**
- [ ] A verdict is written down, with the specific failures if any
- [ ] 500 rows scroll at 60fps in Chrome and Firefox
- [ ] Sticky header survives virtualisation

**If it fails**
**Fork a thin React web app sharing `packages/shared`**, and budget **+2 weeks**. Deciding this on day 3 is cheap; discovering it in week 4 is not.

The fork is not a disaster — `packages/shared` already carries the types, schemas, permission matrix and status machine, which is most of what a second client needs. What it costs is a second component set, and that is exactly why the decision is made before the components are written rather than after.

**Commits**
`chore(start): T4.1 RNW spike` → `chore(spike): RNW DataTable and rail verdict recorded`

---

### T4.2 — Cash reconciliation queue API

**Reads:** `PLAN-BACKEND.md` §10 · `PLAN-DATA-MODEL.md` §4 (`v_cash_reconciliation_queue`)
**Depends on:** T4.1
**Parallel with:** T4.4, T4.5, T4.6
**Tier:** T2 · **Flag:** `owner.cash`

**Build**

`GET /v1/cash/queue` — owner, reading `v_cash_reconciliation_queue`, filters `from`, `to`, `flag[]`, `role`.

`POST /:id/confirm` — `{ confirmedAmount }`.
`POST /:id/dispute` — `{ ownerNote }`, **note required**.
`POST /:id/reopen` — `{ reason }`, **required**, returns the row to `submitted`.

**The default range must include days with no submission.** `missing_submission` is the row the whole feature exists to catch, and a default filter of "submitted handovers" would hide exactly it.

**Default: the last 14 days ending *yesterday*, all flags, `missing_submission` sorted first regardless of date.**

**Ending yesterday, because today's figures are not final.** `job_completions.business_date` is generated from the technician's clamped device time, so cash collected in a basement on Monday lands on **Monday**, whenever it syncs. A technician who declares at 19:10 and syncs on the drive in next morning produces, for a few hours, a Monday row with a declaration and no expected cash — flagged `no_expected_cash`, which reads exactly like a problem it is not.

Today stays reachable, one tap away, captioned *"still syncing"*. **An owner who learns the flags lie on the current day learns to discount the flags**, and that costs more than a one-day delay ever will.

**Reopen exists because a completion cannot be amended once its day is confirmed** (T4.3). Owner only, reason required, audited, and **deliberately a second action rather than a flag on the amend call**: confirmation is where money stops being provisional, and reversing it should feel like a decision.

**Tests**

`apps/api/test/integration/cash-queue.test.ts`
- The default range **ends yesterday**; today is reachable via an explicit filter
- `missing_submission` sorts first regardless of date, across a 30-day fixture
- Dispute without a note → 422
- Reopen returns `submitted` and writes an audit row carrying the reason
- Confirm with an amount differing from declared is **allowed** and stores both
- A rep-day and a technician-day both appear, filterable by `role`

**Done when**
- [ ] Default range proven to include a `missing_submission` day
- [ ] Today's caption path proven

**If it fails**
If the default range hides a `missing_submission` day, the filter is defaulting to rows that exist rather than to a date span. The query drives off the **date range**, and the `FULL OUTER JOIN` supplies the rows — inverting that is how the feature quietly stops catching the thing it was built for.

**Commits**
`chore(start): T4.2 cash queue` → `feat(api): reconciliation queue with confirm, dispute, reopen`

---

### T4.3 — Completion amendment

**Reads:** `PLAN-BACKEND.md` §6.2b · `PLAN-DATA-MODEL.md` §3.4 (Amendment)
**Depends on:** T4.2
**Tier:** T2 · **Flag:** `owner.amend`

**Build**

`POST /v1/jobs/:id/completion/amend` — **owner only**, `reason` required.

1. Lock the completion row; apply the new `cost` / `discount_amount` / `discount_reason`. **The same database constraints apply** — a discount still needs a reason
2. Write `job_events` type `completion_amended` with **before and after** values in `payload`. **No history columns on the table** — the append-only event log is where trails belong here, and `version` already moves under the trigger
3. **Refuse with `409 RECONCILIATION_CONFIRMED` if the covering `cash_reconciliations` row for that employee-day is `confirmed`.** The `details` name the reconciliation, so the client can offer to reopen it

**Why this exists.** Until now `job_completions` had a 1:1 primary key and no correction path at all. A technician who typed ₹50,000 for ₹5,000 poisoned `v_employee_expected_cash` and reached the owner as a ₹45,000 variance with no explanation and no way to fix it — while sales and payments could already be voided with a reason. **Completions were the one money-bearing record in the system that could not be corrected.**

**Tests**

`apps/api/test/integration/amendment.test.ts`
- Amend **before** confirm succeeds and the queue reflects the new figure
- Amend **after** confirm → 409 **naming the reconciliation** in `details`
- **Reopen, then amend → succeeds.** The full cycle
- The event trail carries **both** before and after values
- A discount introduced by an amendment still requires a reason
- Nobody but the owner can amend — all three other roles get 403

**Done when**
- [ ] The four-step cycle proven: amend → confirm → amend refused → reopen → amend
- [ ] Before/after both present in the event payload

**If it fails**
T0: `owner.amend` off. That restores the pre-Phase-4 condition — a mistyped amount cannot be corrected at all — so it is a stopgap, not a resting state. If the reconciliation check is the broken part, refuse *all* amendments rather than allowing them past a confirmed day; a figure moving under a signed-off reconciliation is the one outcome this endpoint exists to prevent.

**Commits**
`chore(start): T4.3 completion amendment` → `feat(api): owner-only completion amendment gated on reconciliation status`

---

### T4.4 — Location console API

**Reads:** `PLAN-BACKEND.md` §8 · `PLAN-DATA-MODEL.md` §3.8
**Depends on:** T4.1
**Parallel with:** T4.2, T4.5, T4.6
**Tier:** T2 · **Flag:** `owner.location`

**Build**

`POST /v1/location/requests` — owner only, `{ employeeId, mode: 'fix' | 'live' }`. **Inserts a `location_requests` row, then** sends a data-only FCM push. `fix` expires in 2 minutes; `live` in 5 and instructs the device to switch to ~10s intervals then revert.

**Persisting the request rather than firing a push and forgetting is what lets the console be honest.** It can say *"requested 40s ago, device has not answered"* instead of spinning. `GET /v1/location/requests/:id` is polled by the UI.

FCM failures clear the stale `fcm_token` and set `failure_reason` — **a device that cannot be reached is itself a tracking-health finding.**

`GET /v1/location/employees` — latest position + health per tracked employee.
`GET /v1/location/employees/:id/trail?date=` — a day's ordered pings.

**Both owner-only.** The dispatcher's `location.health` read (Phase 2) carries health and last-ping age and **no coordinates**; these carry coordinates and are a `location.read`.

Client side: the `live` push flips the device to ~10s intervals for five minutes, **then reverts**. The revert is not optional — a device left at 10s intervals is a battery complaint the next morning.

**Tests**

`apps/api/test/integration/locate-now.test.ts`
- A request persists a row **before** the push is attempted, so a push failure still leaves a queryable request
- An unanswered request past `expires_at` is closed by `expire-location-requests` with a `failure_reason`
- **Stale FCM token → `UNREGISTERED` → token cleared, `failure_reason` set**
- A dispatcher calling any of these → 403
- The trail endpoint returns pings ordered by `recorded_at` and nothing outside the requested business date

`apps/mobile/src/location/live-window.test.ts`
- A `live` push raises the interval to ~10s and **reverts after five minutes**, proven with fake timers

**Done when**
- [ ] The unanswered path proven — this is the one the UI depends on to avoid a spinner
- [ ] Live window reverts

**If it fails**
T0: `owner.location` off. If requests are persisting but never fulfilling, that is not necessarily a bug — it may be a genuine finding about a handset, which is what the `failure_reason` column is for. Check the device before the code.

**Commits**
`chore(start): T4.4 location console api` → `feat(api): persisted locate-now requests, trail and roster reads`

---

### T4.5 — Employee admin and deactivation preconditions

**Reads:** `PLAN-BACKEND.md` §4.1 (deactivation) · `PLAN.md` §5
**Depends on:** T4.1
**Parallel with:** T4.2, T4.4, T4.6
**Tier:** T2

**Build**

Complete the stub from T0.8. `PATCH /v1/employees/:id { isActive: false }` refused with **409 `EMPLOYEE_HAS_OPEN_WORK`** if any of three things is true, **with the blocking rows in `details`**:

1. **Open jobs assigned to him.** A technician silently deactivated mid-week leaves six jobs assigned to someone who can no longer log in, and nothing in the dispatcher's views would say why they stopped moving
2. **Companies he owns.** Otherwise a rep's accounts become invisible to both reps at once
3. **Cash reconciliations still `submitted` or `disputed`.** The one that is easy to omit and worst to omit — the first two are visible on screens the owner already looks at; an unconfirmed handover is a row in a queue he may not have reached. **Deactivating the person is how a real discrepancy becomes an unanswerable one**

**A role change is gated the same way**, plus a fourth condition: a technician promoted to dispatcher loses offline capability at his next login, so **his outbox must be empty.**

On success: revoke every refresh token, mark his devices inactive, and **exclude him from `v_employee_tracking_health`** so a deactivated account does not sit permanently amber in the owner's console. Completions, payments and pings are untouched — `is_active` was never a delete.

**Tests**

`apps/api/test/integration/deactivation.test.ts`
- Open jobs → 409 **listing them**; after reassignment → succeeds
- Owned companies → 409 listing them; after reassignment to NULL → succeeds
- **An unconfirmed cash reconciliation → 409**; after confirming → succeeds
- A role change with a non-empty outbox → 409
- On success: tokens revoked, devices inactive, **absent from the health view**
- His historical completions and payments **still exist and still attribute to him**

**Done when**
- [ ] All four blocking conditions proven independently
- [ ] History proven intact after deactivation

**If it fails**
If the preconditions are too aggressive and block a legitimate deactivation, **loosen the order of operations, not the rule**: give the owner the reassignment links first so the blocking rows can be cleared in a minute. Removing a condition — especially the cash one — reintroduces exactly the unanswerable discrepancy it exists to prevent.

**Commits**
`chore(start): T4.5 deactivation preconditions` → `feat(api): three-way deactivation gate including unconfirmed cash`

---

### T4.6 — Dashboard queries

**Reads:** `PLAN.md` §8 (the four figures) · `UI/plan-2/07-OWNER.md` §O1
**Depends on:** T4.1
**Parallel with:** T4.2, T4.4, T4.5
**Tier:** T2

**Build**

`GET /v1/dashboard/owner`. **Four figures, and every one reads a view that already exists** — nothing here needs a new query:

| Figure | Source |
|---|---|
| Open jobs by status today | `v_job_cards_dispatcher` |
| Cash awaiting confirmation | `v_cash_reconciliation_queue` |
| Month-to-date completion revenue | `job_completions` |
| Total outstanding company dues | `v_company_balances` |

**Two charts:** jobs per day over 30 days, revenue per week over 12 weeks.

**Stating them here is what stops the dashboard becoming a design conversation at the start of Phase 4** — which is the failure this endpoint exists to prevent, and the reason `PLAN.md` §8 pins the contents rather than the layout.

`GET /v1/dashboard/owner/attention` — ordered **by consequence, not recency**: `missing_submission` rows, cash variances, overdue jobs, tracking health problems, contracts expiring inside 30 days.

**Tests**

`apps/api/test/integration/dashboard.test.ts`
- Each figure matches a hand-counted fixture
- "Today" uses the **IST** business date, proven across a UTC midnight
- Attention rows come back in consequence order, not by timestamp
- Every query reads a view; **assert none of them selects from `job_cards` directly**

**Done when**
- [ ] All four figures exact against fixtures
- [ ] IST boundary proven

**If it fails**
If a figure disagrees with a hand count, suspect the IST business date before the aggregation. "Today" on this dashboard means the Asia/Kolkata calendar day, and a `current_date` in UTC is wrong for five and a half hours out of every twenty-four.

**Commits**
`chore(start): T4.6 owner dashboard queries` → `feat(api): owner dashboard figures, charts and attention feed`

---

### T4.7 — Desktop rail and DataTable

**Reads:** `UI/plan-2/07-OWNER.md` (The desktop rail) · `PLAN-FRONTEND.md` §3, §8 · `UI/plan-2/01-FOUNDATIONS.md` §3.3
**Depends on:** T4.1
**Tier:** T1 · **Flag:** `owner.web`

> **Serial task.** `NavShell` is one of the three files where a merge conflict is silent.

**Build**

`NavShell` grows its `desk` branch — the **single** platform check, already written in T0.13, now producing a 240px left rail instead of tabs. **Five sections matching the phone's five groups exactly:**

```
Dashboard
Operations   Jobs · Dispatch · Customers · Contracts
Sales        Sales · Payments · Companies · Renewals
People       Employees · Location · Cash queue
Profile      Profile · Products · Services
```

`slate.900` ground, `surface` text, **2px accent bar on the active route** — the same active-state language as the phone's tab underline, **which is what makes the two layouts read as one product.**

**The rail does not collapse.** There is one user, on one laptop, and a collapse control would be a preference nobody asked for.

`DataTable` — `.web.tsx` only, **never bundled into the APK**. Sortable, sticky header, virtualised via FlashList, zebra stripes in `slate.100`, **status colour on the left edge of every row** — that shared edge is what makes the card and the row read as one object at two densities.

Density `desk`: 40pt rows, 36pt targets, 14px body, `displayLg` 44 for hero figures.

**Tests**

`apps/mobile/src/navigation/NavShell.web.test.tsx`
- Rail renders five sections in order at ≥1024px; tabs render below it
- Active route shows the 2px accent bar, never a filled pill
- No collapse control exists

`apps/mobile/src/components/domain/DataTable.test.tsx`
- 500 rows sort without a full re-render — assert render counts
- Sticky header survives virtualised scroll
- Every row carries the status colour on its left edge
- **`DataTable` is absent from the native bundle** — assert via a Metro resolution test that `.web.tsx` has no native counterpart

**Done when**
- [ ] 500 rows at 60fps in two browsers
- [ ] `DataTable` proven absent from the APK

**If it fails**
T0: `owner.web` off, which leaves the owner on the phone layouts — usable, and the phone build is unaffected. If `DataTable` is the specific problem rather than the rail, this is the moment the T4.1 verdict gets revisited; a thin React web app sharing `packages/shared` is still on the table and costs +2 weeks.

**Commits**
`chore(start): T4.7 desktop rail and table` → `feat(mobile): 240px owner rail, web-only virtualised DataTable`

---

### T4.8 — O1 Dashboard

**Reads:** `UI/plan-2/07-OWNER.md` §O1
**Depends on:** T4.6, T4.7
**Tier:** T1

**Build**

**Phone:** four stat cards stacked, `display` 32 Condensed, label beneath. Charts below, full width, 180 tall. Then *Needs attention*.
**Desktop:** 4-up stat row at `displayLg` 44. Charts side by side at 320 tall. *Needs attention* as a table to the right.

**Charts: two only.** Bars for jobs per day, line for revenue per week. `slate.900` for the data, `slate.200` for the grid, **accent only on the current period's bar** — one accented thing per chart, consistent with the two-uses rule.

**No pie charts. No donuts. No gradient fills. No animated draw-in on every visit** — the chart appears with its data, and only a *changed* value cross-fades.

**Needs attention earns the screen.** If it is empty, **say so explicitly**: *"Nothing needs attention."* An empty section rendering as blank space reads as a broken screen, and the owner needs to know the difference between "no problems" and "not loaded".

Each row links straight to the thing.

**Tests**

`apps/mobile/src/screens/owner/dashboard.test.tsx`
- Four figures, tabular, `en-IN` grouped — `₹1,00,000`, not `₹100,000`
- Empty attention renders the explicit line, not an empty container
- Exactly one accented element per chart
- Desktop renders a 4-up row; **phone renders stacked cards, never a card grid on desktop**
- New deployment: each figure shows `0` with a caption naming what would populate it

**Done when**
- [ ] The card-vs-row rule verified at 360dp, 412dp, 1280px and 1920px
- [ ] Empty state proven distinguishable from a loading failure

**If it fails**
Descope in the documented order: charts go first, figures stay. A dashboard of four correct numbers is useful; a dashboard of two charts and no numbers is decoration.

**Commits**
`chore(start): T4.8 owner dashboard` → `feat(mobile): owner dashboard, four figures, two charts, attention feed`

---

### T4.9 — O2 Cash reconciliation queue

**Reads:** `UI/plan-2/07-OWNER.md` §O2 · `PLAN-BACKEND.md` §10
**Depends on:** T4.2, T4.3, T4.7
**Tier:** T1 · **Flag:** `owner.cash`

> **The reason Phase 4 exists. Not descopable.**

**Build**

**Desktop:** a table — flag · employee · date · expected · declared · variance. **Phone:** the same rows as cards, `missing_submission` first, with expected/declared/variance stacked as a three-column mini-grid inside each card.

**The two non-negotiables:**

**The default range includes days with no submission**, ends yesterday, all flags, `missing_submission` first regardless of date. Today is one tap away and captioned *"Today — still syncing. Figures settle overnight."*

**Every variance is real.** There is **no expenses column**, because technicians do not spend from collections. **Nothing on this screen lets a shortfall be explained away** — the only actions are confirm, dispute, or go and look.

Actions per row: *Confirm* (primary, opens with the declared amount **prefilled and editable**) · *Dispute* (requires a note) · *View the day* — the completions and payments behind the expected figure, so the owner can see which jobs produced the cash.

**Reopen appears only on confirmed rows**, requires a reason, and is the prerequisite for amending a completion on a signed-off day. Deliberately a second action rather than a shortcut on the amend screen.

**Motion:** confirming collapses the row 220ms and cross-fades the flag pill to `match`, with a `Success` haptic. **The row does not disappear** — it stays, resolved, so the owner can see his own work. Filtering it out would make a confirmed day indistinguishable from one that never existed.

**Tests**

`apps/mobile/src/screens/owner/cash-queue.test.tsx`
- `missing_submission` rows sort first across a mixed 30-day fixture
- **No expenses column exists** in either layout
- Confirm prefills the declared amount and allows editing it
- Dispute blocks submit without a note
- **A confirmed row remains visible, marked resolved**
- Reopen is absent on `submitted` rows and present on `confirmed` ones
- Today's tab carries the still-syncing caption

**Done when**
- [ ] Sort order proven with real flag distribution
- [ ] Confirmed rows proven to persist

**If it fails**
T0: `owner.cash` off — but **this is the screen the phase exists for**, so treat that as an outage rather than a rollback, and the fallback is the owner reading `v_cash_reconciliation_queue` directly over psql until it is fixed. Write that query into the runbook as part of this task.

**Commits**
`chore(start): T4.9 cash queue` → `feat(mobile): reconciliation queue with confirm, dispute, reopen`

---

### T4.10 — O3 Location console

**Reads:** `UI/plan-2/07-OWNER.md` §O3 · `PLAN-FRONTEND.md` §9 (owner)
**Depends on:** T4.4, T4.7
**Tier:** T1 · **Flag:** `owner.location`

**Build**

**Web only, three panes.** Worst moment: a customer says nobody arrived, and the technician says he was there.

**Roster sorted by health severity, not alphabetically** — the person with a problem is at the top. Each row: name, health chip, last-seen relative time.

**Map** — the only map in the system. **MapLibre GL JS with a raster tile source**, avoiding a Mapbox token for a one-user surface. Current positions as dots; a selected employee's day trail as a line with **time labels at direction changes, not at every point**.

**Phone: roster only, no map.** Health and last-seen is the part that matters, and it is the part that survives descoping.

***Locate now* must not lie:**

| State | UI |
|---|---|
| Sent | *"Requested — waiting for the device"* + elapsed seconds, counting |
| Fulfilled | Dot moves, trail extends, `Success` haptic where supported |
| Expired | *"Requested 2 min ago — device has not answered"* + **why**: permission missing / no recent ping / push failed |

**Never a spinner.** A spinner implies the answer is coming. **The whole point of persisting the request is to be able to say it is not.**

**The one permitted continuous animation in the product:** during a five-minute `live` window, the selected employee's dot carries a slow pulse. It runs **only while this screen is focused** and stops when the window closes. It is justified because a live window is a bounded, deliberately-entered state the owner needs to see is active.

Motion: roster health cross-fades 140ms. **The trail draws once on selection, 400ms, left to right** — it is a path through time and drawing it in time order is information, not decoration.

**Tests**

`apps/mobile/src/screens/owner/location.web.test.tsx`
- Roster sorts by severity: `permission_missing` above `stale` above `active`
- **The expired state renders the reason, and no spinner exists anywhere in the tree**
- The live pulse stops when the screen blurs — assert the animation is cancelled on `useIsFocused` false
- Phone layout renders the roster and **no map component at all**

**Done when**
- [ ] The unanswered path proven end to end on a real handset, including a device with tracking off
- [ ] Pulse proven to stop on blur

**If it fails**
Descope to the roster with health and last-seen, no map (`owner.location` stays on, the map component does not render). **That still delivers the health signal, which is the part that matters** — the map is how you answer a dispute, the roster is how you notice a problem.

**Commits**
`chore(start): T4.10 location console` → `feat(mobile): web location console with honest locate-now states`

---

### T4.11 — O4 Jobs, O4b Dispatch and Customers

**Reads:** `UI/plan-2/07-OWNER.md` §O4, §O4b · `UI/plan-2/05-DISPATCHER.md` §D3, §D4
**Depends on:** T4.3, T4.7
**Tier:** T1

**Build**

**O4 Jobs.** Phone: `JobCard` list with the dispatcher's filter bar. Desktop: `DataTable` — rail · number · customer · service · technician · scheduled · status · **amount**.

**The owner is the only role whose job table has an amount column**, and it comes from a different response schema (`JobCardOwner`), **not from an optional field on a shared one.**

Row click opens a side detail on desktop, a pushed screen on phone. Detail includes the full `job_events` timeline, the completion with its figures, parts fitted, and the **amend** action.

**Amend** — reason required. If the day's handover is confirmed, the API refuses with the reconciliation named and **the UI offers to reopen it** — two deliberate steps.

The amend form shows **current values, new values, and the difference**, because the owner is correcting a number and needs to see the size of the correction before committing it.

**O4b Dispatch and Customers — the owner's copies.** The rail lists them, so they must exist. They are the dispatcher's screens with the scope opened up, and saying so is the point — otherwise Phase 4 opens with someone designing a second dispatch form.

**Dispatch a job** is `UI/plan-2/05-DISPATCHER.md` §D3 unchanged **plus a company field** on the customer create path, because `customers.company_id` is an owner and rep field. The owner dispatches rarely — covering a sick dispatcher, or a job he took himself — so this screen must be **familiar, not optimised.**

**Customers** is §D4 with three differences:

- **The company field is present**, create and edit, linking through to the company ledger
- **The product stack is editable.** Technicians own the stack because they know what got fitted; the owner is the **correction path** when a serial was typed wrong and the technician has moved on. Edits here stamp **no `source_job_id`**, and that absence is the signal the change did not come from work done
- **Desktop is a table** — name, area, phone, company, units, open jobs, last job — with a side detail. Not cards

**Tests**

`apps/mobile/src/screens/owner/jobs.test.tsx`
- Desktop table carries an amount column; **the same component for a dispatcher renders none**
- Amend form shows current, new and the difference
- Amend on a confirmed day renders the reopen offer with the reconciliation named

`apps/mobile/src/screens/owner/customers.test.tsx`
- Company field present for the owner, absent for a dispatcher, from the same component
- Stack is editable; a save stamps no `source_job_id`
- Desktop renders a table, phone renders cards

**Done when**
- [ ] The same components proven to render differently by role, from schema not from flags
- [ ] Card-vs-row verified at all four widths

**If it fails**
If the owner's amount column is leaking into the dispatcher's table, the two are sharing a schema again. Split them. The money-leak CI suite should have caught it before review — if it did not, the new endpoint was not added to the suite, and that is the actual defect.

**Commits**
`chore(start): T4.11 owner jobs and operations` → `feat(mobile): owner job table with amounts, amend flow, owner dispatch and customers`

---

### T4.12 — O5–O9: Sales, Companies, Contracts, Employees, Products, Profile

**Reads:** `UI/plan-2/07-OWNER.md` §O5–§O9
**Depends on:** T4.5, T4.7
**Tier:** T1

**Build**

**O5 Sales · Payments · Companies.** Phone cards, desktop tables with running totals.

**Companies** — every account, both reps', plus house accounts, with an **owner rep column** and **the reassignment control that exists nowhere else in the product.** Reassigning to *nobody* makes it a house account, which is how leave gets covered.

**Void lives here and only here** — reason required, on both sales and payments. A rep who needs a sale reversed asks.

**O6 Contracts.** Columns: number · site · billing · visits used/included · start · end · **value** · sold by. **Renewals is a filtered view, not a separate screen.**

The visit schedule in the detail shows every visit with its status and, **where a visit produced multiple job cards, all the attempts.** A visit on its third attempt is the thing the owner wants to see when a customer complains.

**O7 Employees.** List: name · role · active · tracking health · last login.

Detail: identity, role, **device diagnostics** — manufacturer, model, OS, app version, location permission, battery-optimisation exemption, autostart confirmed, notifications enabled — and the health chip.

**These diagnostics are not decoration.** OEM task-killing is the project's dominant risk, and without a per-handset record of which mitigations were actually completed a "tracking stopped" report is unfalsifiable. **This screen is the evidence base for the Phase 5 investigation and should read like an equipment record, not a profile page.**

**Deactivation:** the 409 renders as **a list of the blocking rows with links**, not an error message. The owner's next action is to reassign them, and the screen should hand him that work rather than describing it.

**Create:** username, name, phone, role, temporary password. `must_change_password` is automatic and **stated on the screen**: *"Ravi will be asked to set his own password at first login."*

**O8 Products · Services.** Settings, not work — under Profile in the phone grouping. Simple tables. Deactivate rather than delete.

**O9 Profile.** Name, username, change password, logout, app version, and **the second owner account reminder** — a line stating who else holds owner access, because the recovery story depends on that account existing **and being remembered**.

No tracking chip. Owners are not tracked.

**Tests**

`apps/mobile/src/screens/owner/*.test.tsx`
- The reassignment control exists on the owner's company screen and **nowhere else** — assert by grepping the rep's screen tree
- Deactivation 409 renders **linked rows**, not a message string
- Employee detail renders all eight device diagnostics
- Contract detail renders every attempt under a multi-attempt visit
- Profile renders the second-owner line

**Done when**
- [ ] Blocking-rows-as-links proven for all three deactivation conditions
- [ ] Device diagnostics complete on the employee record

**If it fails**
These are the most descopable screens in the project. **Employee admin moves to direct SQL by the developer for a few weeks** — documented in the runbook — and products and services can wait entirely, since the owner touches them a few times a year.

**Commits**
`chore(start): T4.12 owner remaining screens` → `feat(mobile): owner sales, companies, contracts, employees, settings, profile`

---

### T4.13 — Parallel run and phase exit

**Reads:** `PLAN-EXECUTION.md` Phase 4 exit
**Depends on:** all of Phase 4
**Tier:** T0 per flag

**Build** nothing. **Give the owner the app for two weeks and watch what he does not use.**

**Two weeks, the owner.**

**Tests** — the field is the test, and this one has a specific shape: the owner runs a full week of cash reconciliation in-app while continuing to keep his own figures. The two are compared at the end of the week.

**Done when**

- [ ] Owner ran a **full week of cash reconciliation entirely in-app** and **caught at least one real variance or missing submission.** If the queue never flagged anything in a week, either the business is unusually tidy or the view is wrong — **investigate before believing it**
- [ ] ***Locate now* succeeds within 60 seconds on ≥80% of attempts** across the roster handsets, and the failures show *"device has not answered"* rather than spinning
- [ ] **No owner screen renders a card grid on desktop**
- [ ] Owner completed one employee admin task — create, deactivate, password reset — **unaided**
- [ ] **Web and Android show the same figures for the same day** — checked by hand once, deliberately
- [ ] **The owner amended at least one completion**, with the reason recorded, and the queue reflected it
- [ ] The dashboard shows the four defined stats and two charts, **and the owner can say what each one means without being told**

That last one is a design test, not a feature test. If he cannot, the labels are wrong.

**If it fails** — web is a separate bundle and rolls back independently of the APK, **which makes it the safest surface in the project.** Nothing here requires a sideload.

| Scenario | Tier | Action |
|---|---|---|
| A desktop layout is wrong | T0 | `owner.web` off — phone layouts unaffected |
| Map or tiles misbehaving | T0 | `owner.location` off; roster survives |
| Queue wrong | T0 | `owner.cash` off |
| Amendment wrong | T0 | `owner.amend` off |
| Web bug | T1 | previous web bundle, independent of the APK |
| API bug | T2 | previous image |

**Descope — cut in this order:** (1) dashboards reduce to counts, no charts; (2) the location console reduces to a roster list with last-seen and no map — **this still delivers the health signal, which is the part that matters**; (3) employee admin moves to direct SQL by the developer for a few weeks.

**The cash queue is not descopable. It is the reason the phase exists.**

**Commits**
`chore(start): T4.13 owner parallel run` → `docs(ops): phase 4 exit criteria measured and recorded`
