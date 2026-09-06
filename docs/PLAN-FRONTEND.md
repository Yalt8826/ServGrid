# Frontend — Implementation Plan

Companion to `PLAN.md` §1, §3, §6, §8, §9. Covers `apps/mobile` — Expo Router, Android for all four roles plus a desktop web build for the owner.

The framing that keeps this app honest, from `PLAN.md` §1: **offline need is independent of platform**, and **the owner is the only role needing two layouts**. Everything below is arranged so those two facts stay separate in the code, because they are the ones most likely to get conflated once files exist.

---

## 1. Build order

| Phase | Deliverable | Proves |
|---|---|---|
| 0 | App shell, fonts, design tokens, session store, secure storage, login, consent screen, API client with refresh-on-401 | the seams |
| 1 | **Technician app** — dashboard, job tabs, job detail, complete/cancel sheets, profile; SQLite mirror; outbox; location task + permission ladder; tracking health chip | offline and location while scope is small |
| 2 | **Dispatcher app** — dashboard, dispatch form, phone-native Job Logs, load-aware assignment picker, customer CRUD; online-only with explicit error states | the one screen where phone-first costs something |
| 3 | **Sales Rep app** — sales cards, company balances, payment capture with proof photo; reuses the Phase 1 outbox unchanged | the outbox generalises |
| 4 | **Owner app** — Android five-group nav, desktop left rail, DataTable, location console with map, cash reconciliation queue | one route tree, two presentations |
| 5 | Hardening — OEM matrix testing on the real handsets, sunlight legibility check, glove-and-vehicle tap testing | the risks in `PLAN.md` §11 |

Phase 1 builds the outbox and the location service for one role. Phase 3 must reuse them without modification; if it cannot, the Phase 1 abstraction was wrong and that is the moment to find out — while there is still one consumer.

---

## 2. Route tree

One tree. Roles differ in which routes are reachable, not in which files exist.

```
app/
  _layout.tsx                  providers, font gate, session bootstrap, splash hold
  index.tsx                    role → redirect to that role's landing route
  (auth)/
    _layout.tsx
    login.tsx
    consent.tsx                tracking consent — technician + sales rep, first login
    change-password.tsx        forced when mustChangePassword
  (app)/
    _layout.tsx                NavShell — tabs on Android, left rail on web
    dashboard.tsx              role-aware content, one route
    jobs/
      index.tsx                technician tabs | dispatcher logs | owner table
      new.tsx                  Dispatch Job — dispatcher, owner
      [id]/
        index.tsx              job detail
        complete.tsx           modal sheet
        cancel.tsx             modal sheet
        events.tsx             timeline — dispatcher, owner
    customers/
      index.tsx  new.tsx
      [id]/index.tsx  [id]/stack.tsx
    sales/
      index.tsx  new.tsx  [id].tsx
    payments/
      index.tsx                Pending | Collected tabs
      new.tsx                  amount, mode, proof photo
    companies/
      index.tsx  [id].tsx      ledger with running balance
    products/  index.tsx  [id].tsx
    services/  index.tsx
    employees/ index.tsx  new.tsx  [id].tsx
    location/
      index.tsx                owner console — map + roster
      [employeeId].tsx         one person's day trail
    cash/
      index.tsx                owner reconciliation queue
      handover.tsx             technician declaration
    profile/
      index.tsx  tracking.tsx  settings.tsx
```

**Route guarding** is a single `<RoleGate>` in `(app)/_layout.tsx` reading the shared permission matrix. A route the role cannot reach redirects to that role's landing route rather than rendering an error — a technician deep-linked to `/companies` should land on his jobs, not on a wall.

The guard uses the **same `permit()` function the API uses**. This is the whole point of `packages/shared`: the UI decides what to render from the same source the server decides what to allow, so a screen cannot exist that the API will 403.

---

## 3. NavShell — one route tree, two presentations

Eleven owner destinations do not fit a phone tab bar. `PLAN.md` §8 groups them into five.

```ts
const GROUPS = {
  dashboard:  ['/dashboard'],
  operations: ['/jobs', '/jobs/new', '/customers'],
  sales:      ['/sales', '/payments', '/companies'],
  people:     ['/employees', '/location', '/cash'],
  profile:    ['/profile'],
};
```

- **Android, any role** — bottom tabs showing only the groups that role can reach. Technician gets three (Dashboard, Jobs, Profile), owner gets five. One component, filtered.
- **Web, owner** — the same groups become sections in a persistent left rail, each expanded to its individual routes.

`NavShell` branches once on `Platform.OS === 'web' && width >= 1024`. **That branch appears exactly once in the codebase.** Screens never ask what platform they are on; they ask for a layout hint from context if they need one (§8).

---

## 4. State architecture

Five layers, deliberately distinct:

| Layer | Tool | Holds | Lifetime |
|---|---|---|---|
| Session | Zustand + `expo-secure-store` | tokens, actor, role, consent state | until logout |
| Server cache | TanStack Query v5 | every API read | memory + SQLite persister |
| Local mirror | `expo-sqlite` | the role's working set | until logout |
| Outbox | `expo-sqlite` table + drain manager | pending mutations | until drained |
| UI | component state / route params | filters, sheet state, drafts | screen |

**Dispatchers and owners get layers 1, 2 and 5 only.** No SQLite, no outbox, no persister. They are on office wifi; their failure mode is a clear error state, not a queue. This is enforced by a capability flag on the role — `roleCapabilities[role].offline` — checked once at provider setup, so the SQLite module is never even initialised for them.

**TanStack Query configuration.** `staleTime` 30s for lists, 0 for a job detail being actively worked. Offline roles use `networkMode: 'offlineFirst'` with the SQLite persister; online roles use `'online'` so a failed fetch surfaces immediately instead of hanging on a hopeful retry.

---

## 5. Offline outbox

Local table:

```
outbox(
  id, created_at, seq,
  method, path, body_json,
  idempotency_key,              -- generated at enqueue, never regenerated
  entity_type, entity_local_id,
  depends_on,                   -- outbox.id
  status,                       -- queued | inflight | done | rejected | failed
  attempts, next_attempt_at,
  error_code, error_message
)
```

**Enqueue is synchronous with the optimistic write.** The user acts → the local mirror updates → the row enqueues → the UI already shows the new state. Nothing in the UI blocks on the network, per `PLAN.md` §6.

`idempotency_key` is generated **once, at enqueue**, and reused across every retry. Regenerating on retry would defeat the entire server-side guard, and it is the single easiest mistake to make here.

**Drain triggers** — reconnect (`expo-network` / NetInfo), app foreground (`AppState`), a 60-second timer while active, and manual pull-to-refresh. The drain posts up to 50 ordered operations to `/v1/sync/batch`, then immediately calls `/v1/sync/delta` with the returned cursor so server-assigned job numbers land in the same cycle.

**Per-outcome handling:**

| Server outcome | Client action |
|---|---|
| `applied` | mark `done`, reconcile the local row from the response |
| `duplicate` | mark `done` — a replay is a success |
| `skipped` | leave `queued`; its parent was rejected, resolve that first |
| `rejected` (4xx) | mark `rejected`, **keep the local record**, raise a banner |
| network error | `attempts++`, exponential backoff `2^n` capped at 5 min, stay `queued` |
| `401` | refresh once, retry once; if refresh fails, pause the drain and prompt re-login — **never discard queued items** |

**Rejection UX.** A plain banner using the server's `message` verbatim: *"This job was cancelled by the office at 14:32."* Two actions — **Discard my copy** and **View the office version**. No silent overwrite in either direction, no auto-merge, no dialog the technician has to decode while standing in someone's basement.

**Pending badge.** A persistent count in the header, visible on every screen for offline roles. `PLAN.md` §6 asks for it so the technician can see work is queued rather than lost, and it is also the fastest field diagnostic there is: a badge that only goes up is a sync failure, visible without anyone opening a log.

**Server-assigned numbers.** Until sync returns one, the card shows a "Pending sync" chip where the job number goes. Never a fake local number — a technician reading out "JC-2627-00042" that does not exist is worse than having no number to read.

**Photos** queue as local file URIs. The file stays in the app's document directory until the attachment upload succeeds, then is released. The outbox row for a photo `dependsOn` its parent completion, so an attachment never arrives for a job the server rejected.

---

## 6. Location client

Android only. The backend's share of this is small; nearly all of the risk is here.

**Task registration** — `expo-task-manager` task registered at module scope (a requirement, not a style choice: it must be registered before the OS can revive the app into it). `expo-location` background updates with:

```
accuracy: Accuracy.Balanced          // ample for "where is this technician", far cheaper than High
timeInterval: 15 * 60 * 1000
distanceInterval: 100
deferredUpdatesInterval: 15 * 60 * 1000
foregroundService: { notificationTitle, notificationBody, notificationColor }
pausesUpdatesAutomatically: false
```

The foreground service with its persistent notification is the only configuration that survives on Android 8+. `High` accuracy is reserved for on-demand fixes.

**Cadence expectations.** The OS will not honour 15 minutes precisely. The client does not compensate, does not add a timer to "correct" the drift, and does not treat jitter as failure — fighting the batching costs battery for nothing. The 45-minute staleness threshold in the health view exists to absorb exactly this.

**Work-window filter.** 09:00–19:00 IST, Mon–Sat, applied on the device before buffering. Filter, don't schedule: the task stays alive, out-of-window fixes are discarded locally. The server checks again independently.

**Buffering.** Pings write to a local SQLite table and upload in batches of up to 200. A technician in a basement for two hours surfaces with the real trail rather than a gap. The buffer is pruned on server acknowledgement including rejections — an `OUT_OF_WINDOW` ping is done, not pending.

**Permission ladder**, in this order, each with its own screen and its own explanation:

1. Foreground location — in-flow prompt.
2. Background location — **on Android 11+ this cannot be requested in-flow.** A screen explains why it is needed, then deep-links to app settings via `Linking.openSettings()`. The app polls permission state on foreground return and advances only when granted.
3. Battery optimisation exemption — `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent.
4. OEM autostart — manufacturer-detected deep link for Xiaomi, Realme, Vivo, Oppo, OnePlus, with a screenshot-illustrated walkthrough per vendor, because the settings path differs and none of them are discoverable. A **"I've done this"** confirmation posts `autostart_confirmed` to `/v1/devices`.

Each completed step posts to `/v1/devices` immediately. The health chip can only be truthful if the server knows what was actually granted.

**Health chip** — on the technician's profile and visible to the owner: *"Tracking active · last ping 6 min ago"*, or amber *"Last ping 2h ago"*, or red *"Background permission missing — fix"* linking straight back into the ladder at the failed step. Silent failure is the enemy; a chip that only ever says "active" is decoration.

**Consent** — a one-time screen at first login for technicians and sales reps, versioned, posted to the server. It is also the right screen to state the work window plainly, because it stops the app being experienced as something done to staff rather than with them.

**Web** — none of this. `location/`'s background module is `.native.ts` only; the web bundle has no counterpart file and never imports one. Owners are not tracked, so there is nothing to degrade gracefully.

---

## 7. Design system

`PLAN.md` §9, made concrete. Light mode only.

**Tokens** (`packages/shared/theme` or `apps/mobile/theme`, single source):

```ts
color: {
  slate:        '#16202B',   // base text, primary surfaces on dark elements
  muted:        '#5A6B7C',   // secondary text, icons
  surface:      '#FDFDFB',   // warm white — app background
  surfaceDense: '#F2F4F7',   // dense desktop zones, table stripes
  border:       '#DDE2E8',
  accent:       '#F2C200',   // safety yellow
  onAccent:     '#16202B',   // yellow is light — text on it is slate, never white
  status: {
    completed:  '#0F8A5F',
    enRoute:    '#D98A00',
    inProgress: '#F2C200',
    cancelled:  '#B3261E',
    unassigned: '#5A6B7C',   // absence of a state, not a state
  },
}
```

**The accent rule is enforceable, so enforce it.** Safety yellow appears on exactly two things: the primary action and the active state. An ESLint rule forbidding literal `#F2C200` outside `theme.ts`, plus a `Button` API where `variant="primary"` is the only path to an accent background. The moment it decorates a third thing it stops meaning anything, and that erosion happens one reasonable-seeming PR at a time.

Note `inProgress` and `accent` are the same yellow. That is correct — an in-progress job *is* the active state — but it means a status rail and a primary button must never sit adjacent without a spacing break.

**Type** — IBM Plex Sans throughout, IBM Plex Sans Condensed for large dashboard figures. Loaded via `expo-font` behind a splash gate; no text renders in a fallback face. Tabular figures (`fontVariant: ['tabular-nums']`) on every job number, amount and time, so columns of money align and a changing figure does not jitter.

```
display  32 / 36  Condensed 600    dashboard figures
h1       22 / 28  Sans 600
h2       18 / 24  Sans 600
body     16 / 22  Sans 400         never below 16 for field text
label    14 / 18  Sans 500
caption  13 / 16  Sans 400 muted
mono     15 / 20  Sans 400 tabular job numbers, amounts
```

**Layout** — 4pt spacing scale. **Tap targets 52px minimum**, assuming gloves and a moving vehicle. Primary actions in the thumb zone: a bottom action bar, not a top-right button. Radii deliberately tight — `0` for job cards, `4` for inputs and sheets. Job cards carry a **4px status rail on the leading edge, square-cornered**; it reads like a physical work docket and is legible across a workshop.

**Motion** — one orchestrated moment: the job status stepper filling as a job advances, with the completion sheet rising over it. Skeletons, never spinners. No entrance animation on cards or lists. `react-native-reanimated`, and `prefers-reduced-motion` respected on web.

**The dual-layout rule that matters** — the same job is a **card on a phone and a table row on desktop**. Not a card grid. Scanning 200 jobs needs rows, sortable columns and a scannable left edge. This is the commonest way a React Native web build ends up feeling like a phone app in a browser window, so it is a review checkpoint on every owner screen, not a preference.

---

## 8. Component inventory

Primitives (`components/ui/`) — `Button`, `TextField`, `MoneyField` (tabular, IST-locale grouping, no currency symbol in the input), `Select`, `DatePicker`, `Sheet`, `Banner`, `Skeleton`, `Chip`, `EmptyState`, `ConfirmDialog`.

Domain (`components/domain/`):

| Component | Notes |
|---|---|
| `JobCard` | 4px status rail, customer, address, scheduled time, status pill. Phone only. |
| `JobRow` | The same job as a desktop table row. Shares the status-colour left edge. |
| `StatusPill` | Reads from the status colour map; never takes a raw colour. |
| `StatusStepper` | The one animated element. |
| `TechnicianPicker` | **Shows load inline** — "Ravi · 3 today", "Anitha · 6 today". Never a bare dropdown of eight names. |
| `FilterBar` | Persistent, horizontally scrollable chips; technician, status, date. Reflects state in the URL. |
| `MultiSelectList` | Long-press enters selection mode, header becomes a count + bulk action. Replaces table checkboxes. |
| `PhotoCapture` | Camera + gallery, local URI, queued thumbnail with upload state. |
| `SyncBanner` + `PendingBadge` | Outbox state, always visible for offline roles. |
| `TrackingHealthChip` | Three states, red one is a link back into the permission ladder. |
| `DataTable` | Web only. Sortable, sticky header, virtualised. Lives in `.web.tsx`. |
| `MoneyGate` | Renders children only if `permit(role,'job.money','read') !== 'none'`. Belt-and-braces over the API's schema separation. |

**Platform splitting** uses Metro's `.native.tsx` / `.web.tsx` resolution, not runtime `Platform.OS` checks scattered through screens. `DataTable` and the map have no native counterpart and are never bundled into the APK.

---

## 9. Screens

### Technician — Phase 1

| Screen | Data | Actions | Offline |
|---|---|---|---|
| Dashboard | today's assigned jobs, pending count, tracking health | open a job | full, from mirror |
| Jobs | tabs: Today / Upcoming / Completed | filter, open | full |
| Job detail | job, customer, product stack, events | call, **Navigate** (deep-link to Google Maps), status change | full |
| Complete sheet | — | work summary, **one amount field**, optional discount + reason, collection mode, photos, stack changes | queued |
| Cancel sheet | — | reason code, note | queued |
| Cash handover | his own declaration for today | declare amount, note | queued |
| Profile | health chip, permission ladder state, pending count | re-run ladder steps, logout | reads mirror |

**Navigate deep-links to Google Maps** (`google.navigation:q=lat,lng`) — traffic, voice guidance and offline tiles nothing in-app would match. There is no map in the technician app at all.

**The complete sheet is the highest-stakes screen in the product.** It is filled one-handed, in poor light, possibly wearing gloves, by someone who wants to leave. Design consequences: one amount field by default with "Add discount" as a secondary disclosure that opens amount + reason together; collection mode as three large segmented buttons, not a dropdown; the submit button in the thumb zone and never disabled for a network reason.

### Dispatcher — Phase 2

Online-only, with an explicit error state on every screen — never a spinner that resolves into nothing.

| Screen | Notes |
|---|---|
| Dashboard | unassigned count, per-technician load, today's status split |
| Dispatch Job | customer search-or-create, service, priority, schedule, `TechnicianPicker` |
| Job Logs | **the phone-first screen that costs something** |
| Customer | search, create, edit, view stack read-only |
| Profile | self only |

**Job Logs** was a sortable table with a sticky header. On a phone it becomes a filtered list with a persistent `FilterBar` — technician, status, date — and bulk reassign becomes a long-press multi-select mode rather than checkboxes in a table. Filter state lives in the URL so a filtered view survives a reload and can be shared.

`PLAN.md` §11 says prototype this before building it. **Do that in Phase 1's spare capacity, with real volumes** — 200+ jobs, not six. The specific thing to test is whether a dispatcher can answer "who has the Kormangala jobs today" in under five seconds on a phone. If not, the fallback is a compact two-line row at 44px with the filter bar pinned, accepting a smaller tap target for this one screen because a dispatcher is seated and not wearing gloves.

Dispatcher screens never request or render money. The API will not send it; `MoneyGate` makes that visible in the code rather than implicit.

### Sales Rep — Phase 3

| Screen | Notes |
|---|---|
| Dashboard | month's sales, outstanding across his companies, recent payments |
| Sales | list, create with line items — product picker snapshots name and price at add time |
| Payment | **Pending** = companies with `balance > 0` (a view, not rows); **Collected** = his payments. Capture: amount, mode, reference, proof photo |
| Company | list with balances, detail with ledger and running balance |
| Profile | health chip — reps are tracked too |

The Pending tab distinction is worth stating in the UI copy: it lists **companies that owe money**, not scheduled collections. Labelling it "Pending payments" invites the reading that a row is a payment, which is exactly the stored-counter thinking the data model rejects.

Sales reps reuse the Phase 1 outbox with no changes. If the API surface differs enough that the drain needs a special case, the Phase 1 abstraction leaked.

### Owner — Phase 4

Both layouts. Eleven routes in five Android groups; a left rail on web.

| Screen | Phone | Desktop |
|---|---|---|
| Dashboard | stacked stat cards, Condensed figures | 4-up stat row + charts |
| Jobs | `JobCard` list | `DataTable` — sortable, sticky header, status colour on the left edge |
| Sales / Payments | cards | tables with running totals |
| Location console | roster with health + last-seen | **map + roster + day trail** |
| Cash queue | flagged cards, `missing_submission` first | table: expected / declared / variance / flag |
| Employees, Products, Companies, Customers | list + detail | tables + side detail |

**Location console** is the only map in the system and it is web-only. `react-native-maps` drops out entirely; one web map library remains — MapLibre GL JS with a raster tile source, avoiding a Mapbox token for a 1-user surface. Shows current positions, a selected employee's day trail with time labels, and a *Locate now* action that posts a request and polls it, showing "requested 40s ago, device has not answered" rather than spinning.

**Cash queue must default to a range that includes days with no submission.** `missing_submission` sorts first. A default filter of "submitted handovers" would hide the exact row the feature exists to catch.

---

## 10. Testing

| Layer | Tool | Scope |
|---|---|---|
| Permission rendering | vitest + RTL | every screen under every role — asserts money is absent for dispatchers |
| Outbox | vitest, fake timers + MSW | enqueue, backoff, `dependsOn` skip, rejection banner, 401 refresh-and-retry, **key stability across retries** |
| Offline flows | Maestro on a device with airplane mode toggling | complete a job offline → reconnect → number arrives |
| Location | manual matrix, Phase 5 | per handset: overnight survival, basement gap recovery, battery cost over a work day |
| Visual | screenshots at 360dp, 412dp, 1280px, 1920px | the card-vs-row rule on every owner screen |
| Field | Phase 5 | sunlight legibility, gloved tap accuracy at 52px, one-handed complete sheet |

The location matrix is a table of `manufacturer × OS version × mitigation state` filled in from the actual handsets staff carry. `PLAN.md` §11: this cannot be simulated, and it is the one test plan that must not be compressed.

---

## 11. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Dispatcher Job Logs on a phone — prototype at real volume before building | **High** — the one screen where phone-first has a real cost | Prototype in Phase 1, decide before Phase 2 |
| 2 | Web map library — MapLibre + raster tiles proposed; needs a tile source decision (self-hosted vs. a free tier with an attribution requirement) | Medium | Before Phase 4 |
| 3 | Whether a technician sees amounts in his own completion history. Proposed: no. Mirrors `PLAN-BACKEND.md` open item 2. | Low, but staff-visible | Phase 1, confirm with owner |
| 4 | OEM autostart walkthroughs need real screenshots per vendor — cannot be written from documentation | Medium — blocks the ladder's last step | Phase 1, needs the handsets |
| 5 | Owner desktop is a React Native Web build. If the `DataTable` and rail fight RNW hard enough, a separate thin React app sharing `packages/shared` is the escape hatch. | Medium — a real fork in the road | Assess at Phase 4 start |
| 6 | Dark mode deferred. `PLAN.md` §9 warns the contrast levels were chosen for sunlight, not monitors — if it is ever added, do not soften them. | Low | — |
