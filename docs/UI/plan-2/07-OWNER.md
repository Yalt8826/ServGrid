# Owner — Screen Specifications

**Two layouts.** Density `field` on Android (five tab groups), `desk` on web (left rail). One route tree, two presentations — `NavShell` branches once, on `Platform.OS === 'web' && width >= 1024`.

One user, Phase 4. Online-only, like every role.

**The role's condition:** at a desk with a laptop most of the time, on a phone the rest. Not rushed. Wants to *verify* rather than operate — the recurring question is "is this right, and if not, who do I ask?"

**The rule that governs every screen here:** *the same job is a card on a phone and a table row on desktop.* Not a card grid. Scanning 200 jobs needs rows, sortable columns and a scannable left edge, and forcing phone cards onto a desktop is the commonest way a React Native Web build ends up feeling like a phone app in a browser window (`PLAN.md` §9). **This is a review checkpoint on every screen below, not a preference.**

---

## O1. Dashboard

**Purpose.** Is the business running, and is anything wrong with the money?

**Worst moment.** Sunday evening, reviewing the week, wanting the answer without opening four screens.

### The content, fixed here so Phase 4 does not open with a design conversation

**Four figures:**

| Figure | Source |
|---|---|
| Open jobs by status today | `v_job_cards_dispatcher` |
| Cash awaiting confirmation | `v_cash_reconciliation_queue` |
| Month-to-date completion revenue | `job_completions` |
| Total outstanding company dues | `v_company_balances` |

**Two charts:** jobs per day over 30 days, revenue per week over 12 weeks.

Every one reads an existing view. Nothing here needs a new query.

### Anatomy

**Phone:** four stat cards stacked, `display` 32 Condensed, one per row with its label beneath. Charts below, full width, 180 tall. Then *Needs attention*.

**Desktop:** 4-up stat row, `displayLg` 44. Charts side by side at 320 tall. *Needs attention* as a table to the right.

### Needs attention — the section that earns the screen

Ordered by consequence, not recency:

1. `missing_submission` cash rows — collected cash, no declaration
2. Cash variances
3. Overdue jobs
4. Tracking health: stale or permission-missing
5. Contracts expiring inside 30 days

Each row links straight to the thing. **If this section is empty, say so explicitly** — *"Nothing needs attention."* An empty section that renders as blank space reads as a broken screen, and the owner needs to know the difference between "no problems" and "not loaded".

### Charts

Two only. Bars for jobs per day, line for revenue per week. `slate.900` for the data, `slate.200` for the grid, **accent only on the current period's bar** — one accented thing per chart, consistent with the two-uses rule.

No pie charts. No donuts. No gradient fills. No animated draw-in on every visit — the chart appears with its data, and only a *changed* value cross-fades.

### States

- **Loading:** skeletons at exact geometry, 200ms delay.
- **Offline:** the full-screen *No connection* gate, web and Android.
- **Empty (new deployment):** each figure shows `0` with a caption naming what would populate it.

---

## O2. Cash reconciliation queue

**The reason Phase 4 exists.** Not descopable.

**Purpose.** Confirm what came in, catch what did not.

**Worst moment.** A technician collected ₹12,000 in cash three days ago and never declared it.

### Anatomy — desktop

```
┌──────────────────────────────────────────────────────────┐
│ Cash reconciliation      [Last 14 days ▾] [All flags ▾]  │
├────┬──────────┬────────┬──────────┬──────────┬───────────┤
│▌   │ Employee │ Date   │ Expected │ Declared │ Variance  │
├────┼──────────┼────────┼──────────┼──────────┼───────────┤
│▌🔴 │ Ravi     │ 3 Sep  │  ₹12,000 │        — │ ₹12,000   │  missing_submission
│▌🟠 │ Suresh   │ 5 Sep  │   ₹8,400 │   ₹8,000 │    ₹400   │  variance
│▌🟢 │ Anitha   │ 5 Sep  │   ₹6,200 │   ₹6,200 │       —   │  match
└────┴──────────┴────────┴──────────┴──────────┴───────────┘
```

**Phone:** the same rows as cards, `missing_submission` first, expected/declared/variance stacked as a three-column mini-grid inside each card.

### The two non-negotiables

**The default date range includes days with no submission.** `missing_submission` is the row the entire feature exists to catch, and a default filter of "submitted handovers" would hide exactly it. Default: **the last 14 days ending yesterday**, all flags, `missing_submission` sorted first regardless of date.

**Ending yesterday, because today's figures are not final.** Cash is stamped with the day it was collected, not the day it reached the server (`PLAN-BACKEND.md` §10), so a declaration made before the day's last completion was submitted produces, for a few hours, a row with a declaration and no expected cash — flagged `no_expected_cash`, which reads exactly like a problem it is not. Today is still reachable, one tap away, and carries a caption: *“Today — still syncing. Figures settle overnight.”* An owner who learns the flags lie on the current day learns to discount the flags, and that costs more than a one-day delay ever will.

**Every variance is real.** There is no expenses column, because technicians do not spend from collections. Nothing on this screen lets a shortfall be explained away — the only actions are confirm, dispute, or go look.

### Actions per row

*Confirm* (primary, opens with the declared amount prefilled and editable) · *Dispute* (requires a note) · *View the day* — the completions and payments behind the expected figure, so the owner can see which jobs produced the cash.

**Reopen** appears only on confirmed rows, requires a reason, and is the prerequisite for amending a completion on a signed-off day. It is deliberately a second action rather than a shortcut on the amend screen: confirmation is where money stops being provisional, and reversing it should feel like a decision.

### Motion

Confirming: row collapses with a 220ms height animation and the flag pill cross-fades to `match`. `NotificationSuccess`. The row does not disappear — it stays, resolved, so the owner can see his own work. Filtering it out would make a confirmed day indistinguishable from one that never existed.

---

## O3. Location console — web only

**Purpose.** Where is everyone, and is tracking actually working?

**Worst moment.** A customer says nobody arrived, and the technician says he was there.

### Anatomy — desktop, three panes

```
┌──────────────┬───────────────────────────────────────┐
│ ROSTER       │                                       │
│ ● Ravi       │              MAP                      │
│   6 min ago  │        (MapLibre GL, raster)          │
│ ⚠ Suresh     │                                       │
│   2h ago     │   ● current positions                 │
│ 🔴 Anitha    │   ─ selected employee's day trail     │
│   no permit  │                                       │
├──────────────┤                                       │
│ [Locate now] │                                       │
└──────────────┴───────────────────────────────────────┘
```

**Roster** sorted by health severity, not alphabetically — the person with a problem is at the top. Each row: name, health chip, last-seen relative time.

**Map** is the only map in the system. MapLibre GL JS with a raster tile source. Current positions as dots; a selected employee's day trail as a line with time labels at direction changes, not at every point.

**Phone:** roster only, no map. Health and last-seen is the part that matters, and it is the part that survives descoping (`PLAN-EXECUTION.md` Phase 4).

### *Locate now* — the interaction that must not lie

Persisted as a `location_requests` row rather than a fire-and-forget push, so the UI can be honest:

| State | UI |
|---|---|
| Sent | *"Requested — waiting for the device"* + elapsed seconds, counting |
| Fulfilled | Dot moves to the new fix, trail extends, `Success` haptic on web where supported |
| Expired | *"Requested 2 min ago — device has not answered"* + why (permission missing / no recent ping / push failed) |

**Never a spinner.** A spinner implies the answer is coming. The whole point of persisting the request is to be able to say it is not.

Exit criterion: *Locate now* succeeds within 60 seconds on ≥80% of attempts, and the failures show "device has not answered" rather than spinning.

### The one permitted continuous animation

During a five-minute `live` window, the selected employee's dot carries a slow pulse. It runs **only while this screen is focused** and stops when the window closes. It is the single exception to "no continuous animation" in the product, and it is justified because a live window is a bounded, deliberately-entered state that the owner needs to see is active.

### Motion

Roster health changes cross-fade 140ms. The trail draws once on selection, 400ms `enter`, left to right — it is a path through time and drawing it in time order is information, not decoration.

---

## O4. Jobs

**Phone:** `JobCard` list with the dispatcher's filter bar.
**Desktop:** `DataTable` — rail · number · customer · service · technician · scheduled · status · **amount**.

The owner is the only role whose job table has an amount column, and it comes from a different response schema (`JobCardOwner`), not from an optional field on a shared one.

Row click opens a side detail on desktop, a pushed screen on phone. Detail includes the full `job_events` timeline, the completion with its figures, parts fitted, and the **amend** action.

### Amend

Owner only, reason required. If the day's handover is confirmed, the API refuses with the reconciliation named, and the UI offers to reopen it — two deliberate steps.

The amend form shows the current values, the new values, and the difference, because the owner is correcting a number and needs to see the size of the correction before committing it.

---

## O4b. Dispatch and Customers — the owner's copies

The desktop rail lists *Operations — Jobs · Dispatch · Customers · Contracts*, and two of those had no specification here at all. They are short, because the honest answer is that they are the dispatcher's screens with the scope opened up — but "same as the dispatcher's" needs saying, or Phase 4 opens with someone designing a second dispatch form.

**Dispatch a job** (`/jobs/new`) is `05-DISPATCHER.md` §D3 unchanged, plus one field the dispatcher does not get: **company**, on the customer create path, because `customers.company_id` is an owner and rep field (`PLAN.md` §5) and the API strips it from dispatcher payloads. Same single scroll, same inline assignment picker sorted by load, same *Leave unassigned* as an explicit option. The owner dispatches rarely — covering a sick dispatcher, or a job he took on the phone himself — so this is a screen that must be *familiar*, not optimised.

**Customers** (`/customers`) is `05-DISPATCHER.md` §D4 with three differences:

- **The company field is present** — create and edit — and links through to the company ledger.
- **The product stack is editable.** Technicians own the stack because they are the ones who know what got fitted, and a dispatcher must not touch it from a phone call. The owner is the correction path when a serial was typed wrong and the technician has moved on. Edits here stamp **no `source_job_id`**, and that absence is the signal that the change did not come from work done (`PLAN-BACKEND.md` §6.4).
- **Desktop is a table** — name, area, phone, company, units, open jobs, last job — with a side detail. Not cards. Same rule as everywhere else on this role.

Job history on a customer uses `JobRow` at `desk` density and carries the amount column, because this is the owner.

---

## O5. Sales · Payments · Companies

**Phone:** cards. **Desktop:** tables with running totals.

**Companies** — every account, both reps', plus house accounts, with an **owner rep column** and the reassignment control that exists nowhere else in the product. Reassigning to *nobody* makes it a house account, which is how leave gets covered.

**Ledger** identical to the rep's (`06-SALES-REP.md` §S4) but unscoped.

**Void** lives here and only here — reason required, on both sales and payments. A rep who needs a sale reversed asks.

---

## O6. Contracts

**Phone:** cards with visits used. **Desktop:** table plus a visit schedule in the side detail.

Columns: number · site · billing · visits used/included · start · end · value · sold by.

**Renewals** is a filtered view, not a separate screen: expiring within 60 days, sorted by days remaining. Each row shows visits used, because a spent visit reduces what the renewal is worth.

The visit schedule in the detail shows every visit with its status and, where a visit produced multiple job cards, **all the attempts**. A visit on its third attempt is the thing the owner wants to see when a customer complains.

---

## O7. Employees

**Purpose.** Create accounts, reset passwords, deactivate people, see whether their devices are healthy.

### Anatomy

List: name · role · active · tracking health · last login.

Detail: identity, role, **device diagnostics** (manufacturer, model, OS, app version, location permission, battery-optimisation exemption, autostart confirmed, notifications enabled) and the tracking health chip.

Those diagnostics are not decoration. `PLAN.md` §11 names OEM task-killing as the dominant risk, and without a per-handset record of which mitigations were actually completed, a "tracking stopped" report is unfalsifiable. **This screen is the evidence base for the Phase 5 investigation** and should read like an equipment record, not a profile page.

### Deactivation

Refused while the employee holds open jobs or owns companies. The 409 renders as a **list of the blocking rows with links**, not an error message — the owner's next action is to reassign them, and the screen should hand him that work rather than describing it.

### Create

Username, name, phone, role, temporary password. `must_change_password` is set automatically and stated on the screen: *"Ravi will be asked to set his own password at first login."*

---

## O8. Products · Services

Settings, not work. Under **Profile** in the phone grouping, because the owner edits a price a few times a year and putting them in Operations would give a daily group two entries nobody opens.

Simple tables: SKU, name, category, brand, default price, warranty months, active. Deactivate rather than delete.

---

## O9. Profile

Name, username, *Change password*, *Log out*, app version, and the **second owner account reminder** — a line stating who else holds owner access, because the recovery story depends on that account existing and being remembered.

No tracking chip. Owners are not tracked.

---

## The desktop rail

Five sections, expanded to individual routes, matching the phone's five groups exactly:

```
Dashboard
Operations   Jobs · Dispatch · Customers · Contracts
Sales        Sales · Payments · Companies · Renewals
People       Employees · Location · Cash queue
Profile      Profile · Products · Services
```

240px, `slate.900` ground, `surface` text, **2px accent bar on the active route** — the same active-state language as the phone's tab underline, which is what makes the two layouts read as one product.

The rail does not collapse. There is one user, on one laptop, and a collapse control would be a preference nobody asked for.
