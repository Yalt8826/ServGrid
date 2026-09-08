# 03 — Components

Merges and extends `PLAN-FRONTEND.md` §8: the primitives and domain components become full specs
with a state matrix and never-lists. Anatomy → variants → states → motion → **never** per
component. Interfaces look dead because only the default state was drawn; the matrix comes first.

## 0. The state matrix — every interactive component implements all of these

`default · pressed · focused · disabled · loading · empty · error · stale · pending-sync ·
rejected · overdue`

**The domain states** (offline roles: technician, sales rep):

| State | Meaning | Global treatment |
|---|---|---|
| `stale` | local mirror older than the server | content renders from cache with an AgeStamp ("2 min ago"); never a blocking spinner |
| `pending-sync` | written locally, not acknowledged | amber "Pending sync" chip where the number/ack goes; nothing blocks |
| `rejected` | server refused (4xx outcome) | red banner, **server's message verbatim**, local record kept; actions: Discard my copy / View the office version |

**Online roles** (dispatcher, owner) have no `pending-sync`/`stale` treatments — their failure
mode is an explicit error state that names what failed, never a spinner that resolves into
nothing. `overdue` is a data state any list row can carry (OverdueChip, sorts first).

## 1. Primitives (`components/ui/`)

### Button
Variants: `primary` (yellow fill, slate ink — the only path to an accent background, per the
ESLint fence) · `secondary` (surface, border, primary ink) · `ghost` (no fill, secondary ink) ·
`destructiveGhost` (red text; filled red is ConfirmDialog-only). Sizes: 52px field/console,
44px desk. States: default / pressed (scrim 90ms) / focused (NTX-6 ring) / disabled (45%
opacity, still announced) / busy (spinner **only on the one legitimately network-bound submit:
login** — everywhere else the write is optimistic and the button never waits).
**Never:** disabled for a network reason; two primaries on one screen; filled red inline;
a destructive action in the bottom 40% of a field screen.

### TextField / MoneyField / Select / DatePicker
Field states: default / focused (ring + stronger border) / filled / error (label + message name
the fix; never colour alone). **MoneyField**: numeric keypad, tabular figures, en-IN grouping,
**no currency symbol in the input**, and no computed total ever rendered by the field itself.
**Never:** placeholder as the only label; a MoneyField that sums anything (parts rule).

### Sheet
Bottom sheet — context stays visible; never full-screen. Anatomy: title naming the action,
body with the concrete facts, actions. Motion: rises 300ms, finger-thrown settles carry real
velocity. The complete/cancel sheets are Sheets, not routes that feel like pages.
**Never:** "Are you sure?" without the facts; a sheet inside a sheet.

### Banner
Persistent strip below the header: `attention` (amber — offline notice, pending count) /
`blocker` (red — **rejections: server message verbatim** + Discard my copy / View the office
version) / `info` (muted). Blockers are not dismissible — they resolve by being resolved.
**Never:** a toast for a rejection; a banner that auto-hides; a banner with no action when an
action exists.

### Skeleton
Shaped exactly like its content; static; delayed 200ms; min 400ms (`02-MOTION.md` §3).
**Never:** shimmer; a skeleton on a cached read; a skeleton as a write state.

### Chip
Reads a tone from the foundations map; **never takes a raw colour** (locked rule, now a lint
target). The three fence chips: OverdueChip (red outlined), WarrantyChip / ContractChip
(muted) — none yellow. **Never:** icon-only chips that carry state; a fourth yellow chip.

### EmptyState
Title + one-line cause hint + optional action. "No jobs today — new assignments appear here,
even offline." **Never:** illustration; blaming language; an empty state that could be an
error (say which it is).

### DataTable (`.web.tsx`, desk only)
Sortable, sticky header, virtualised, tabular figures right-aligned, status colour on the left
edge (JobRow). **Never:** on phone; horizontal scroll; a card grid posing as density.

### ConfirmDialog
For irreversible or money-moving actions. Names the consequence with concrete facts. The
in-warranty charge confirmation and the contract-visit "spends a visit" warning live here —
each is **the only** confirmation on its sheet, so it stays meaningful.
**Never:** stacked confirms; a confirm whose body has no numbers.

## 2. Domain components (`components/domain/`)

### JobCard (phone) / JobRow (desktop)
The same object, two presentations (locked rule). Anatomy: 4px status rail (leading edge,
square) · customer + address · the specific unit (`h2`) · scheduled time · StatusPill · chips
as they apply (Overdue, Warranty, Contract) · job number (`mono`, or "Pending sync" chip).
States: full matrix incl. overdue (sorts first, never self-advances), pending-sync, rejected
banner attached to its row.
**Never:** a site-level docket that names no unit; a fabricated number; a flag buried in
detail; the rail as the only state signal on yellow/amber (DQ-2).

### StatusPill / StatusStepper
Pill reads the status map only. Stepper: assigned → en route → completed, **the one animated
element** (MO-1); reduced motion = instant fill + haptic. Cancelled renders as a terminal red
pill, not a stepper state.

### TechnicianPicker
Load inline — "Ravi · 3 today", "Anitha · 6 today" — never a bare dropdown of eight names.
Choosing who to send is the decision; the picker supports it.

### FilterBar / MultiSelectList
Persistent filter chips (technician, status, date), state reflected in the URL; long-press
enters multi-select with a header count + bulk action (replaces table checkboxes on phone).

### PhotoCapture
Camera + gallery, local URI, queued thumbnail with upload state; thumbnails render from the
local file while queued (DQ-4) so review never lies about what was attached. Photos depend on
their parent completion in the outbox and never arrive alone.

### PartsList
Collapsed by default; product picker + quantity + optional serial rows. **Never shows a
subtotal, never sits above the amount field, never alters the amount** — a parts subtotal
implies the app computes the bill, and the next thing is a discrepancy nobody can explain.

### SyncBanner + PendingBadge
One instance per screen header for offline roles. Badge: "N queued" — visible on every screen;
a badge that only goes up is a sync failure visible without opening a log. Banner states:
offline / draining / rejected-count (deep-links to the rejection). **Never:** hidden during
drain, red while merely queued.

### TrackingHealthChip
Four states exactly as `PLAN-FRONTEND.md` §6: green "Tracking active · last ping 6 min ago" ·
amber "Last ping 2h ago" · red "Background permission missing — Fix" (links into the ladder at
the failed step) · amber "Job alerts off — you won't be told about new jobs". On the
technician's and rep's profile; visible to the owner in the location console.
**Never:** a green-only chip ("a chip that only ever says active is decoration").

### MoneyGate
Renders children only if `permit(role,'job.money','read') !== 'none'` — belt and braces over
schema separation. **Never:** used as a substitute for the API refusing to send money; absent
on every dispatcher surface, including `contract_value`.

### AgeStamp
"6 min ago" (caption, tabular) → tap → absolute time. Mandatory wherever freshness matters:
last ping, dashboard figures, cached lists. **Never:** bare relative time without the absolute
reachable; on data that cannot change.

### StatusRail
The 4px leading edge. Colour = status map. **Never** the sole carrier on yellow/amber (DQ-2);
never rounded; never on the trailing edge (scan direction is left→right, and the rail is the
scannable left edge the desktop table shares).

### JobNumber
`mono`, server-assigned, verbatim; "Pending sync" chip until allocated. Tap-to-copy on detail.
**Never:** a locally invented number, in any state, ever.

## 3. Composition rules

- List screen: header (title + SyncBanner/PendingBadge) → FilterBar (if any) → cards/rows →
  EmptyState. Detail screen: KeyValue docket grid → primary action in the bottom action bar.
- Every button is a `Button` variant; every empty is an `EmptyState`; every rejection is a
  `Banner` with the server's words.
- Offline roles: optimistic write → pending-sync chip → badge increments; online roles:
  error state names the failure.
- Hierarchy comes from type tokens only — no new sizes, no colour-weight hacks.

## 4. Component ↔ screen bijection

Verified in Phase 10 against `04`–`08`. Orphans are scope nobody specified; ghosts are screens
promising components nobody defined.
