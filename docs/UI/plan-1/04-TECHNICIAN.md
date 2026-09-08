# 04 — Technician screens

**The role's condition.** One man, one phone, one thumb. He is standing in a customer's doorway
or beside a UPS rack at 12:40 in June: hard light at the threshold, near-dark by the unit, one
hand on a multimeter, the other holding the phone. Signal dies indoors. He is rushed and
watched. His worst moment: he completes a job in a basement with zero signal, gets a call, and
the app dies — the completion must survive that without a thought from him. The second-worst:
the office cancels the job while he was underground, and his finished work comes back as a
rejection.

**Density:** `field` · **Offline:** full — mirror + outbox, everything works with zero signal ·
**Tracked:** yes (health chip lives here) · **Signature moment:** MO-1 (stepper + sheet).

## TEC-01. Dashboard

**Purpose.** What are my jobs today, and what needs me first?

**Worst moment.** Van doorway, one thumb, direct sun, 09:58, three jobs and a long drive.

### Anatomy
```
┌──────────────────────────────┐
│ Dashboard        ● 2 queued  │  PendingBadge in header
│ [Offline — showing saved…]   │  Banner only when offline
│ Tracking ● active · 6 min    │  TrackingHealthChip (compact)
│                              │
│ Today · 3 jobs               │
│ ┌──────────────────────────┐ │
│ │▐ Sunrise Traders, E1     │ │  JobCard: rail (yellow=in progress)
│ │▐ Kormangala · 12:00      │ │
│ │▐ APC 3kVA · SN 4482      │ │  the specific unit
│ │▐ JC-2627-00041  ●In prog │ │
│ └──────────────────────────┘ │
│ ┌ ▹ Overdue ▹ …┐             │  overdue sorts first, always
│ (bottom bar: none — list IS the screen)
└──────────────────────────────┘
```

### Content
Today's assigned jobs (mirror, `jobs` tables), pending count, tracking health compact state.
Overdue first — a broken promise outranks a queue. Cards show the unit, not the site alone.

### States
Empty ("No jobs yet — new assignments appear here, even offline"), stale (AgeStamp in section
header), pending-sync per card, rejected banner per row. Loading states **do not exist** —
the mirror renders instantly; a skeleton here would lie about a 0ms read.

### Motion
None on mount. MO-1 lives on the detail screen, not here.

### Not on this screen
No revenue figure anywhere (his completions are his record, not reports — `PLAN.md` §5); no
map (Navigate lives on detail); no company/dues data; no customer creation.

## TEC-02. Jobs (tabs)

**Purpose.** My work across time: Today / Upcoming / Completed.

**Worst moment.** Friday evening: a customer claims a visit happened that didn't; he needs the
completed record in front of them.

### Anatomy
Segmented tabs above a JobCard list; Completed entries keep their job number, completion
summary (work + collection mode — **not amounts**, per the open decision in
`PLAN-FRONTEND.md` §11-3) and sync state.

### States
Per-tab empty ("Nothing upcoming — contract visits land here when they come due"), stale,
pending-sync, rejected. No loading.

### Motion
None.

### Not on this screen
No amount in his own completion history until the owner answers §11-3 (proposed: no); no
edit-after-complete (append-only events; amendments are owner actions); no bulk anything.

## TEC-03. Job detail

**Purpose.** Everything known about JC-2627-00041, and the one right next action.

**Worst moment.** Thumb-held in a dark UPS room; the next action must be findable without
reading.

### Anatomy
```
┌──────────────────────────────┐
│ ← JC-2627-00041  ●In prog    │  JobNumber + StatusPill
│ ────────────────────────────│
│ Customer   Sunrise Traders   │  KeyValue docket grid
│ Site       E1, 3rd floor     │
│ Unit       APC 3kVA · SN 4482│  the specific unit
│ Warranty   In warranty · to  │  WarrantyChip (info, not alarm)
│            14 Mar 2027       │
│ Contract   AMC-2627-0031 ·   │  ContractChip — "prepaid" is
│            visit 3 of 4 ·    │  load-bearing here
│            prepaid           │
│ Scheduled  Today · 12:00     │
│ ────────────────────────────│
│ [Call]  [Navigate]           │  secondary pair, thumb-adjacent
│                              │
│ (bottom action bar)          │
│ [ Start job ]                │  state-dependent primary
└──────────────────────────────┘
```

### Content
Docket grid from the job + customer + customer_product tables: customer, site, **the specific
unit**, product stack, warranty expiry (WarrantyChip when covered), contract context + billing
mode, schedule. Events timeline accessible (read-only history). Actions: Call (tel:),
**Navigate** (deep-link to Google Maps — there is no in-app map for this role). Primary button
context-senses: assigned → "Start job"; en route → "Complete"; the sheet opens as MO-1's
surface. Cancel lives as a secondary destructiveGhost, top-zone — never in the thumb bar.

### States
Stale/pending-sync/rejected per matrix; prepaid handling on the sheet, not here; error
(job missing from mirror — "Connect once to fetch this job").

### Motion
MO-1 fires from here on submit.

### Not on this screen
No amount on the detail after completion (collection mode + summary only); no reassign
(dispatcher's power); no contract value (technicians read the contract behind the visit, never
its price); no editing customer/product records beyond the completion's stack update.

## TEC-04. Complete sheet (MO-1's home — the highest-stakes screen in the product)

**Purpose.** Close the job: what was done, what was collected, what was used — one-handed, in
poor light, possibly gloved, by someone who wants to leave.

**Worst moment.** 18:55, customer waiting to lock up, keyboard eating half the screen, GPS
already gone indoors.

### Anatomy
```
┌──────────────────────────────┐
│ Complete · JC-2627-00041     │
│ Work summary *               │  multiline, required — what was done
│ [__________________________] │
│ Collection mode              │
│ ┌──────┬──────┬───────┐      │  three large segmented buttons,
│ │ CASH │ UPI  │ NONE  │      │  never a dropdown
│ └──────┴──────┴───────┘      │
│ Amount collected             │  ONE amount field (mono, ₹, en-IN)
│ [ 2,450 ]                    │  — absent entirely on prepaid visits
│ + Add discount               │  disclosure → amount + mandatory reason
│ ▸ Parts used (PartsList)     │  collapsed; below the amount, never above;
│                              │  product · qty · serial rows, no subtotal
│ ▸ Customer products updated  │  collapsed — stack changes post-install
│ 📷 Photos (PhotoCapture, 2   │  local URIs; thumbnails render from the
│    queued)                   │  local file while queued (DQ-4)
│                              │
│ [ Complete job ]             │  thumb zone, never network-disabled
└──────────────────────────────┘
```

### Content
Exactly the completion contract (`PLAN-FRONTEND.md` §9): work summary (required), collection
mode segmented, one amount, discount as a disclosure with mandatory reason, parts list
(recorded, no subtotal), stack changes, photos. Conditional rules that are load-bearing:
**prepaid visit → the amount field is absent** (not zero, not disabled — absent, with the
ContractChip reading "prepaid" in its place); **in-warranty unit + non-zero charge → exactly
one ConfirmDialog**: "This unit is under warranty until 14 Mar 2027. Charge anyway?" — the
only confirm on this sheet, which is what keeps it meaningful.

### States
Required-empty (submit inert with the hint, a local criterion — never network); submit =
optimistic: sheet dismisses into MO-1, mirror row updated, outbox row enqueued, badge
increments; offline identical to online; rejection returns as the row banner with the
server's message.

### Motion
MO-1. Nothing else — the keyboard is animation enough.

### Not on this screen
No signature, no customer survey, no second confirm on submit itself, no parts subtotal, no
"save draft" button (the outbox IS the draft), no expense field (technicians don't spend from
collections — owner-confirmed), no GST/invoice framing (sales cards are internal records).

## TEC-05. Cancel sheet

**Purpose.** Record the wasted trip honestly — and let the man on site decide what happens
next, because he is the only one who was there.

**Worst moment.** Locked gate, 40km from the office, the customer not answering; the default
costs the customer something and he must know it.

### Anatomy
```
┌──────────────────────────────┐
│ Cancel · JC-2627-00041       │
│ Reason code             [▾]  │  closed list, not free text
│ Note (optional)              │
│ [Reschedule to …] (date)     │  skippable date picker
│ ⚠ Skipping without a date    │  on contract visits, in these
│ spends one of the customer's │  words, above the picker
│ entitled visits.             │
│ [Keep job]    [Cancel job]   │  destructiveGhost right, primary left
└──────────────────────────────┘
```

### Content
Reason code + optional note + optional reschedule date (returns the visit to the schedule;
the generator raises a fresh card when due). No date = spends an entitled visit — the sheet
says so in those words on contract jobs (`PLAN.md` §4). Cancellation by the office while he
works → his rejection banner says it verbatim.

### States
Offline full-function (queued), rejection paths, validation (reason required).

### Motion
Sheet rise 300ms; no stepper (nothing completed).

### Not on this screen
No office-chat thread, no photo requirement for cancellations, no approval flow — the
technician decides on site; the record carries who and why.

## TEC-06. Cash handover

**Purpose.** Declare what I'm handing over, so the day ends with one honest number.

**Worst moment.** 19:10, tired, notes in hand, patchy signal, no patience for a form.

### Anatomy
```
┌──────────────────────────────┐
│ Cash handover    ● 2 queued  │
│ Today · 06 Sep               │
│ You collected   ₹ 4,450      │  mono — from cash-mode completions
│ (what the office expects)    │  (server view, stated plainly)
│                              │
│ You are handing over *       │  ONE number + note — the whole screen
│ [ 4,450 ]                    │
│ Note (optional)              │
│                              │
│ [ Declare handover ]         │  thumb zone; optimistic
│ Declared today: —            │  or the declared figure once done
└──────────────────────────────┘
```

### Content
One declaration per employee per day. "What you collected" is the server-derived expectation —
shown for honesty, not for matching (a mismatch is exactly what the owner's queue exists to
catch; the UI presents both numbers and lets the variance be real). No expenses field — owner-
confirmed technicians never spend from collections.

### States
Empty ("Nothing collected today"), declared (quiet confirmation), offline (queued — a handover
declared underground syncs), rejection banner.

### Motion
None beyond interaction echo.

### Not on this screen
No per-job cash breakdown (handover is one number; the office reconciles), no other employees'
figures, no history beyond today (owner's queue owns history), no UPI entries — UPI/bank never
pass through hands.

## TEC-07. Profile

**Purpose.** Is my phone actually working for me — tracking, alerts, sync — and am I me?

**Worst moment.** He suspects tracking is broken (or his employer suspects it) and needs the
truth in one glance.

### Anatomy
Identity block (name, employee #) → **TrackingHealthChip (full four-state form)** with the
permission-ladder state under it: each step (foreground, background, battery, autostart) with
its state and a [Fix]/[Open setting] button that deep-links to the exact settings page →
job-alerts state (the chip's fourth state, amber when off) → pending count → [Logout].

### Content
Health from `v_employee_tracking_health`; ladder state from `/v1/devices` posts; logout obeys
the protection rule — blocked with "3 items not yet synced" + [Retry now] while rows are
queued; proceeds keeping only rejected rows, keyed to his employee id.

### States
Each ladder step: granted / denied / never-asked, each with its honest next action; the
notification-permission state renders amber, not red — tracking is intact, alerts are the
loss.

### Motion
None.

### Not on this screen
No "My tracking" map view for others, no pings trail on phone (owner console is web-only —
though his own health chip is always his), no settings beyond the ladder + logout, no account
editing (owner provisions).
