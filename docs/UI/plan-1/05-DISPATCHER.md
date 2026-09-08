# 05 — Dispatcher screens

**The role's condition.** Two jobs in one skull: run the board, then handle the customer who
walks in. Seated at a desk on good office wifi — phone, not PC. Both hands often, but the
board gets checked walking between rooms. Interrupted continuously. His worst moment: 09:05
Monday — four unassigned jobs, one tech just called in absent, and a customer already
rescheduled twice is on the line. Second-worst: he must find "who has the Koramangala jobs
today" in under five seconds on a phone, because that is the prototype gate the whole role's
UX is judged by.

**Density:** `console` · **Offline:** **no — online-only by design**, with an explicit error
state on every screen; never a spinner that resolves into nothing · **Sees money: never** —
not on jobs, not on contracts, enforced by the schema, the API, and `MoneyGate` ·
**Not tracked** · **Signature moment:** none — this is the triage role; speed is the craft.

## DIS-01. Dashboard

**Purpose.** What is broken, what is unassigned, who is carrying what?

**Worst moment.** The 09:05 Monday above.

### Anatomy
```
┌──────────────────────────────┐
│ Dashboard                    │
│ ⚠ OVERDUE · 3            →   │  first block, always — a promise
│                              │  already broken outranks a queue
│ Unassigned · 4           →   │
│ ┌──────────────────────────┐ │
│ │▐ Sunrise Traders · E1    │ │  JobCard, unassigned rail = muted
│ │▐ APC 3kVA · Today 12:00  │ │
│ │▐ [Assign to…]            │ │  the action lives on the card
│ └──────────────────────────┘ │
│ Today: ▓▓▓▓ 12 · ▓▓ 4 · ▓ 2  │  status split (assigned/ en route/done)
│ Load: Ravi 3 · Anitha 6 · …  │  per-tech count → feeds the picker
└──────────────────────────────┘
```

### Content
Overdue count (the only number representing a broken promise), unassigned queue, per-tech
load, today's status split. Everything reads server views; every figure fresh by definition
(online role) — an error state says so when the fetch fails, with [Retry].

### States
Empty ("No jobs yet — dispatched jobs appear here"), error (named failure + retry), overdue
chip states. Loading: skeleton only on first-ever load, never on refetch.

### Motion
None. Nothing on this screen may move that isn't a state change.

### Not on this screen
No revenue, no contract values, no cash figures, no map (owner console only), no attendance,
no customer money (dues are rep/owner).

## DIS-02. Dispatch Job (new)

**Purpose.** Put a job in front of the right tech with the right unit, date, and priority.

**Worst moment.** Phone call mid-entry: customer changes the unit; the form must absorb
editing, not restart.

### Anatomy
Single column: customer search-or-create → **the unit at that site** (customer_product picker
— a site with five UPS units must yield a specific one) → service → priority (normal/urgent —
escalation fires the assignment push) → schedule (date + time) → **TechnicianPicker** with
load inline ("Ravi · 3 today" / "Anitha · 6 today").

### States
Validation inline (customer required, unit required, date required); customer-create inline
(see DIS-05's no-company rule); error states per field; no offline mode — a dropped connection
mid-form surfaces as an error banner with the form intact (state in route params, not lost).

### Motion
None.

### Not on this screen
No money fields (a job has no amount until a technician completes it); no company field
(dispatchers have none — stripped server-side too); no contract creation (contracts create
visits, which generate their own cards).

## DIS-03. Job Logs (the prototype gate)

**Purpose.** Answer "who has the Koramangala jobs today" in under five seconds, at real
volume (200+ jobs).

**Worst moment.** Any moment a dispatcher scrolls instead of filters. The screen is judged by
`PLAN-FRONTEND.md` §11-1: prototype in Phase 1 spare capacity at real volume before Phase 2
commits; the documented fallback is a compact two-line 44px row with the FilterBar pinned.

### Anatomy (phone-first design)
```
┌──────────────────────────────┐
│ Job Logs                     │
│ [Tech ▾][Status ▾][Date ▾]   │  FilterBar: persistent, URL-backed
│ ┌──────────────────────────┐ │
│ │▐⚠ JC-…00038 · Anitha     │ │  overdue first, rail + chip
│ │▐  Raj & Sons · 09:00 1d  │ │
│ ├──────────────────────────┤ │
│ │▐ JC-…00041 · Ravi        │ │
│ │▐  Sunrise · 12:00        │ │
│ └──────────────────────────┘ │
│ (long-press → select mode)   │  MultiSelectList → bulk reassign
└──────────────────────────────┘
```

### Content
All jobs, all techs. Overdue is a filter chip **and** sorts first; bulk reassign as
multi-select mode. Each row: number, tech, customer+site, time, status rail + pill, unit on
the second line. No money columns — not hidden, absent (the API sends none).

### States
Filter-empty ("No jobs match — clear a filter"), error, loading skeletons at real volume only.

### Motion
None on scroll; selection mode's header count changes are state, not animation.

### Not on this screen
No map, no money, no contract values, no customer balances, no assignment history beyond the
job's own events (that's the detail screen's timeline).

## DIS-04. Job detail (dispatcher view)

**Purpose.** The job's full operational story: who, what unit, when, its events, its current
owner.

**Worst moment.** A technician says "I was never told" — the events timeline is the answer.

### Anatomy
KeyValue docket grid (customer, site, unit + serial, service, priority, schedule, assigned
tech) → events timeline (append-only: created, assigned, reassigned, started, completed,
cancelled — each with actor + timestamp) → actions: [Reassign] (opens the picker sheet),
[Cancel job] (ConfirmDialog naming the consequence for an assigned tech), priority escalation.

### States
Error, loading (skeleton), empty timeline impossible (creation is event 0).

### Motion
None.

### Not on this screen
No completion amounts (the timeline says "completed"; money is owner/rep surfaces), no
editing customer product stacks post-hoc, no contract value.

## DIS-05. Customer

**Purpose.** Find, create, or update a customer and see their product stack.

**Worst moment.** Mid-call: create the customer, dispatch the job, stay under twenty seconds.

### Anatomy
Search (name/phone/site) → list → detail: identity + sites + **product stack read-only**
(technicians update the stack from the field — they're the ones who know what got fitted) →
[New customer] → create form: name, phone, address, site — **no company field** (dispatchers
have no company permission; absent from the form and stripped from payloads server-side).

### States
Search-empty, validation, error, loading skeleton.

### Motion
None.

### Not on this screen
No company attach (owner/rep field), no dues (not dispatcher data), no job history beyond
links, no deletion (customers with jobs are records).

## DIS-06. Contracts (read-only) + Profile

**Purpose.** Context for the visits contracts generate — nothing more.

**Worst moment.** A generated visit confuses a tech; the dispatcher needs "it's AMC, visit 3
of 4" in ten seconds.

### Anatomy (contracts)
List + detail: ContractChip content only — which visit of how many, prepaid or not, due
dates, linked customer/site. **Never the contract value.** Moving a due date is allowed
(visit schedule), reading money is not possible.

### Anatomy (profile)
Self only: name, role, logout. No tracked-states chip — dispatchers are not tracked and get
no alerts config (assignment pushes are device-level, and the health chip belongs to tracked
roles).

### States
Error, loading, empty ("No contracts at your sites yet").

### Motion
None.

### Not on this screen
Contract value, renewal lists (rep/owner sales surfaces), cash, employees admin, consent or
tracking surfaces (untracked role), any offline behaviour (online-only role).
