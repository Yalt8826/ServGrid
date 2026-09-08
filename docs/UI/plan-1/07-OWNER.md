# 07 — Owner screens

**The role's condition.** The only role with two layouts: phone all day (five nav groups),
desktop at the desk (left rail, tables). Good light, good signal, online-only. His emotional
state is audit-shaped: he is looking for the anomaly — the broken promise (overdue), the
unexplained variance, the missing declaration, the gap in a trail. The UI's job is to surface
anomalies first and never make him scroll past decorated normals to find them. His worst
moment: month-end cash reconciliation — a tech declared ₹2,000 short, expenses record ₹2,000
of parts, and the screen must show both truths (reconciled *and* money left the business)
without netting one into the other.

**Density:** `console` phone / `desk` web · **Offline:** no — online-only; figures are served
truths and error states say when they aren't · **Sees everything** — money included ·
**Signature moment:** none of his own; MO-1 belongs to the field. His craft is the scan:
rows, sort, left-edge colour.

## Preamble — the dual-layout rule (every screen below)

**The same job is a card on a phone and a table row on desktop.** Not a card grid. Scanning
200 jobs needs rows, sortable columns and a scannable left edge — review checkpoint on every
screen in this file (`PLAN.md` §9, `PLAN-FRONTEND.md` §7). The left rail mirrors the phone's
five groups as sections; same route tree, two presentations, one product.

## OWN-01. Dashboard

**Purpose.** Is the business normal — and if not, where do I look?

**Worst moment.** 10:00, five minutes between meetings; "anything wrong?" must be answered
at a glance.

### Anatomy (desktop)
```
┌──────────────────────────────────────────────┐
│ Dashboard                     updated 2 min  │  AgeStamp
│ ┌Overdue 3┐ ┌Open 12┐ ┌Cash ₹6,850┐ ┌Dues     │  4-up stat row,
│ │ broken  │ │ jobs  │ │ awaiting  │ │ ₹1,42,00│  Condensed figures
│ └─────────┘ └───────┘ └confirm───┘ └─────────┘
│ ┌ Jobs/day · 30d ────────┐ ┌ Revenue/wk · 12w ─────┐│  two charts
│ │ (lines, not decoration) │ │ (same)               ││
│ └─────────────────────────┘ └──────────────────────┘│
└──────────────────────────────────────────────┘
```
Phone: stacked stat cards — **overdue first** — then charts.

### Content
Exactly the locked four stats and two charts (`PLAN.md` §8): open jobs by status today, cash
awaiting confirmation, month-to-date completion revenue, total outstanding company dues;
jobs/day 30d, revenue/week 12w. Every figure reads an existing view — stating them here is
what stops Phase 4 reopening a design conversation.

### States
Stale (AgeStamp), loading (skeletons with chart-shaped geometry), empty (a quiet Sunday:
zeros with "No jobs today"), error per panel.

### Motion
None beyond interaction echo. Count-up not budgeted — the scan is served by tabular figures,
not theatre.

### Not on this screen
No map, no alerts feed, no approval actions (queue owns actions), no fourth chart ("two
charts" is the decision; the third is how erosion starts).

## OWN-02. Jobs

**Purpose.** All work, all techs — sorted, filtered, scannable.

**Worst moment.** A customer disputes a service date from last month.

### Anatomy
Phone: JobCard list. Desktop: **DataTable of `JobRow`s** — columns: status colour edge, number,
customer, unit, tech, schedule, status pill; sortable; sticky header; virtualised. Filters:
tech / status / date range / overdue-only. Row → job detail (completion figures visible — he is
the only role whose job detail shows amounts).

### States
Filter-empty, error, loading skeletons at volume.

### Motion
None.

### Not on this screen
No inline edit (amendment lives on the completion record, owner-only, with a reason); no
delete (jobs are records); no card grid on desktop — ever.

## OWN-03. Job detail (owner view)

**Purpose.** The complete auditable story — including the money and the amendment path.

**Worst moment.** "Your tech was there four minutes and charged for a full service." The
events timeline with timestamps is the answer.

### Anatomy
TEC-03's docket grid **plus owner-only rows and powers**: completion record (amount,
discount + reason, collection mode, parts), photos, full events timeline, and [Amend
completion] — reason required; if that day's handover is confirmed the API refuses and the
UI offers the reopen-reconciliation path as the deliberate second step
(`PLAN-FRONTEND.md` §9). Reassign/cancel actions with consequence-naming confirms.

### States
Error, loading; amendment blocked state names the confirmed reconciliation date.

### Motion
None.

### Not on this screen
No silent figure changes (two deliberate steps), no deletion of events, no editing
technician work summaries (amendment appends, never overwrites).

## OWN-04. Dispatch Job

**Purpose.** = DIS-02, owner-powered: same form, plus company attach on customer-create.

**Worst moment.** = DIS-02.

### Anatomy / States / Motion
= DIS-02 with one addition: he may attach a new customer to a company (the field dispatchers
never see). Reassign-from-here uses the same consequence-naming sheet.

### Not on this screen
= DIS-02's exclusions; ownership doesn't add money to a job that has none yet.

## OWN-05. Customers

**Purpose.** Every customer, their sites, their product stacks — and the company link.

**Worst moment.** "Which of our five units is the one at their E1 office?" — search must
answer by unit serial too.

### Anatomy
Phone: search + list + detail (identity, sites, product stack). Desktop: table + side
detail. Owner adds: [Attach company] (owner/rep-only power), [New customer] with company
field present, stack edits allowed (owner mirrors the technician's field power).

### States
Search-empty, error, loading.

### Motion
None.

### Not on this screen
Nothing RBAC-exotic — owner sees all; exclusions are scope: no dues here (companies own
balances), no job creation from the customer card (dispatch flow owns it).

## OWN-06. Contracts

**Purpose.** Every contract, its visits used/remaining, its renewals — the commercial
pipeline and its evidence.

**Worst moment.** Quoting a renewal: "what is this contract actually worth with three visits
already spent?"

### Anatomy
Phone: cards with visits used. Desktop: table + visit schedule side-detail. Renewals view
(active contracts ending ≤60 days, visits used/remaining). [New contract], [Renew]. Contract
values visible — owner-only surface.

### States
Empty ("No contracts expiring in 60 days"), stale, error.

### Motion
None.

### Not on this screen
No reminder/notification settings (renewal is a view), no billing/invoicing (sales cards are
internal records), no auto-renewal — renewal is a human conversation.

## OWN-07. Sales & Payments

**Purpose.** All reps' sales and payments, with proof.

**Worst moment.** "Who took this payment?" — attribution is the point: entries record who
actually took the money.

### Anatomy
Phone cards / desktop tables: sales (company, total, rep, number) and payments (company,
amount, mode, reference, proof-photo thumbnail, rep, date). Filters: rep, company, date,
mode.

### States
Filter-empty, error, loading. Proof photos render server-side here (the owner's surface is
online).

### Motion
None.

### Not on this screen
No cash-handover rows (OWN-09's queue), no job completions (OWN-02/03), no rep leaderboards
(sales is a record, not a contest).

## OWN-08. Companies

**Purpose.** Every company, its balance, its ledger, its owner-rep — and reassignment.

**Worst moment.** A rep goes on leave; accounts must move without losing a rupee of history.

### Anatomy
Desktop table (company, balance, owner-rep, last payment) + side ledger (running balance).
Phone: cards + ledger detail. [Reassign accounts] (leave/cover flow), [New company], house
accounts marked. Balance is the derived view — the UI renders it, never recomputes it.

### States
Filter-empty, stale, error.

### Motion
None.

### Not on this screen
Credit settings, GST fields, customer-level data (OWN-05), any balance the UI computed
itself.

## OWN-09. Cash reconciliation queue

**Purpose.** Catch the day the money doesn't add up — including the day nobody declared.

**Worst moment.** The ₹2,000 question above: reconciled *and* money left the business — two
truths, both visible.

### Anatomy (desktop)
```
┌──────────────────────────────────────────────┐
│ Cash queue   [date range: includes days      │  default range includes
│               with no submission]            │  missing-submission days
│ ┌──────────────────────────────────────────┐ │
│ │ ⚠ MISSING · Ravi · 05 Sep · collected    │ │  sorts first — the row
│ │ ₹3,100 · nothing declared                │ │  the feature exists for
│ │ [Record declaration] [Flag]              │ │
│ ├──────────────────────────────────────────┤ │
│ │ Ramesh · 06 Sep                          │ │
│ │ expected ₹4,450 · declared ₹2,450        │ │
│ │ expenses ₹2,000 (battery terminal)       │ │  its own column — never
│ │ variance ₹2,000 UNEXPLAINED ⚠            │ │  netted into variance
│ │ [Record correction]                      │ │
│ └──────────────────────────────────────────┘ │
│ Phone: flagged cards, missing first          │
└──────────────────────────────────────────────┘
```

### Content
Per employee per day: expected (derived view), declared, expenses as **its own column**,
variance, flag. `missing_submission` first — a day with collections but no declaration is
the catch. Confirm/reopen actions; reopening a confirmed day is deliberate and audited.

### States
Empty ("Every day reconciled"), loading, error. No offline states (online role).

### Motion
None.

### Not on this screen
No netting of expenses into variance (that hides a spend inside a match — the exact failure
this screen exists to prevent), no editing history (corrections are new audited entries), no
per-job cash linkage.

## OWN-10. Employees

**Purpose.** Provision, deactivate, and see the fleet's tracking health in one table.

**Worst moment.** A phone is lost at 18:00 — deactivate must revoke everything, now, with the
blockers named if it can't.

### Anatomy
Desktop table / phone list: employee, role, active, tracking-health chip (for tracked roles),
last ping. Detail: provision (username + temp password shown once), forced password change,
**[Deactivate]** — refused while he holds open jobs or owns companies, with the blocking
rows **named** so the owner can reassign and retry; on success tokens revoked, devices
marked inactive, history untouched.

### States
Validation, blocked-deactivation state (named rows), error.

### Motion
None.

### Not on this screen
Self-service registration (owner provisions), role invention (four roles), delete (history
is never deleted), reading anyone's queued outbox (that's the badge's job, not the owner's
surfing).

## OWN-11. Location console (web-only — the only map in the system)

**Purpose.** Where is everyone, how fresh is that, and what happened today?

**Worst moment.** "Has anyone left for the Jayanagar job?" — presence + freshness in one
glance, or an honest "he hasn't reported".

### Anatomy
```
┌──────────────────────────────────────────────┐
│ Location                        (web ≥1024)  │
│ ┌ Map (MapLibre, raster) ─┐ ┌ Roster ────── │
│ │  positions + day trail  │ │ Ravi ● 6 min  │
│ │  of selected employee   │ │ Anitha ⚠ 2h   │
│ │  with time labels       │ │ [Locate now]  │
│ │                         │ │ → trail view  │
│ └─────────────────────────┘ └─────────────── │
└──────────────────────────────────────────────┘
```

### Content
Current positions, selected employee's day trail with time labels, roster with
TrackingHealthChip states (green/amber/red + the job-alerts amber), [Locate now] → polls the
request showing "requested 40s ago, device has not answered" — a state, not a spinner.

### States
Locate pending/fulfilled/timeout (named, ≤60s); roster-empty; map tiles failure ("map
unavailable — roster still answers the question"). No phone layout pretence: on the phone
app this surface reduces to the roster (the map stays web-only).

### Motion
None on markers. Polling states are text states.

### Not on this screen
Live-watch escalation controls beyond the ~10s/5-min flip the push already does, history
playback beyond one day trail, geofences, anything that smells like surveillance dashboards
— the window, the consent, and the visible notification are the policy; this console is ops.

## OWN-12. Products

**Purpose.** The catalogue reps sell from — price changes snap forward, never backward.

**Worst moment.** A price changes; the new sale must snap it, the old sale must keep its
snapshot — the screen makes that visible (price history inline).

### Anatomy
List + edit (name, price) + price history (dated rows, tabular). Desktop table + side edit.

### States
Validation, error, empty ("No products yet").

### Motion
None.

### Not on this screen
Inventory/stock (parts are recorded on completions, never decremented), pricing rules
engine, cost/margin fields.

## OWN-13. Services

**Purpose.** The service codes jobs and contracts are cut against.

**Worst moment.** A contract references a service someone renamed — history must read as it
was written.

### Anatomy
List + edit (name, code incl. AMC) + usage count (jobs referencing it). Desktop table +
side edit.

### States
Validation, error, empty ("No services yet").

### Motion
None.

### Not on this screen
Deletion of referenced codes (deactivate instead), category taxonomies, pricing.

## OWN-14. Profile (owner)

**Purpose.** Identity, password, logout.

**Worst moment.** Mundane by design — the owner's risk lives in every other screen.

### Anatomy
Identity block, [Change password], logout. No health chip, no ladder — the owner is not
tracked and has no outbox.

### States
Standard field states; change-password flow = SHR-02 minus the forced flag.

### Motion
None.

### Not on this screen
Account self-provisioning, role editing (OWN-10), any tracking surface (untracked role).
