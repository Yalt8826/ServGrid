# Frontend — Implementation Plan

Companion to `PLAN.md` §1, §3, §6, §8, §9. Covers `apps/mobile` — Expo Router, Android for all four roles plus a desktop web build for the owner.

Visual and interaction design — philosophy, tokens, motion, components, and a screen-by-screen specification for all four roles — lives in `UI/plan-2/`. (`UI/plan-1/` is a superseded alternative kept for the record; `UI/COMPARISON.md` says why plan-2 was taken. Build from plan-2.) This document stays the architectural one: routes, state, connection handling, and the platform seams.

The framing that keeps this app honest, from `PLAN.md` §1: **every role works online, but only the owner and dispatchers may sign in on web**, and **the owner is the only role needing two layouts**. Everything below is arranged so those two facts stay separate in the code, because they are the ones most likely to get conflated once files exist.

---

## 1. Build order

| Phase | Deliverable | Proves |
|---|---|---|
| 0 | App shell, fonts, design tokens, session store, secure storage, login, consent screen, API client with refresh-on-401 | the seams |
| 1 | **Technician app** — dashboard, job tabs, job detail, complete/cancel sheets, profile; online reads and intent-keyed writes; location task + permission ladder; tracking health chip | idempotency and location while scope is small |
| 2 | **Dispatcher app** — dashboard, dispatch form, phone-native Job Logs with Overdue, load-aware assignment picker, customer CRUD; online-only with explicit error states | the one screen where phone-first costs something |
| 2B | **AMC** — the dispatcher's AMC tab (due for a visit, ending soon, all), AMC form, the dispatch form's AMC option; the technician's Free/Charge choice | a module that adds no new client machinery |
| 3 | **Sales Rep app** — sales cards with list price and discount per line, company balances, payment capture with proof photo, cash handover | money on a phone, in front of the customer |
| 4 | **Owner app** — Android five-group nav, desktop left rail, DataTable, location console with map, cash reconciliation queue | one route tree, two presentations |
| 5 | Hardening — OEM matrix testing on the real handsets, sunlight legibility check, glove-and-vehicle tap testing | the risks in `PLAN.md` §11 |

Phase 1 was built with an offline SQLite mirror and outbox, and Phase 3 reused them. Both were removed by the online-only decision of 2026-09-15 (`implementation/PHASE-ON-ONLINE.md`); the rows above describe the app as it now stands.

Phase 2B is a deliberately quiet phase on this side. Contracts introduce screens but no new client machinery: no new state layer, no new write path, no platform seam. An AMC job is an ordinary job card, so the technician's app needs one extra chip and one choice on the complete sheet. If contracts turn out to need a technician read beyond the contract object inline on his work read, something has been modelled wrong on the server.

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
    contracts/
      index.tsx                AMC tab: due for a visit, ending soon, all
      new.tsx                  customer, start, end, price, notes (also renew)
      [id].tsx                 detail + linked jobs
    products/  index.tsx  [id].tsx
    services/  index.tsx
    employees/ index.tsx  new.tsx  [id].tsx
    location/
      index.tsx                owner console — map + roster
      [employeeId].tsx         one person's day trail
    cash/
      index.tsx                owner reconciliation queue
      handover.tsx             technician or rep declaration
    profile/
      index.tsx  tracking.tsx  settings.tsx
```

**Route guarding** is a single `<RoleGate>` in `(app)/_layout.tsx` reading the shared permission matrix. A route the role cannot reach redirects to that role's landing route rather than rendering an error — a technician deep-linked to `/companies` should land on his jobs, not on a wall.

The guard uses the **same `permit()` function the API uses**. This is the whole point of `packages/shared`: the UI decides what to render from the same source the server decides what to allow, so a screen cannot exist that the API will 403.

---

## 3. NavShell — one route tree, two presentations

Fourteen owner destinations do not fit a phone tab bar. `PLAN.md` §8 groups them into five.

```ts
const GROUPS: Record<Role, NavGroup[]> = {
  technician: [
    { key: 'dashboard', routes: ['/dashboard'] },
    { key: 'jobs',      routes: ['/jobs'] },
    { key: 'cash',      routes: ['/cash/handover'] },
    { key: 'profile',   routes: ['/profile'] },
  ],
  dispatcher: [
    { key: 'dashboard',  routes: ['/dashboard'] },
    { key: 'operations', routes: ['/jobs', '/jobs/new', '/customers'] },
    { key: 'amc',        routes: ['/contracts', '/contracts/new'] },
    { key: 'profile',    routes: ['/profile'] },
  ],
  sales_rep: [
    { key: 'dashboard', routes: ['/dashboard'] },
    { key: 'sales',     routes: ['/sales', '/payments'] },
    { key: 'companies', routes: ['/companies', '/companies/new'] },
    { key: 'cash',      routes: ['/cash/handover'] },
    { key: 'profile',   routes: ['/profile'] },
  ],
  owner: [
    { key: 'dashboard',  routes: ['/dashboard'] },
    { key: 'operations', routes: ['/jobs', '/jobs/new', '/customers', '/contracts'] },
    { key: 'sales',      routes: ['/sales', '/payments', '/companies'] },
    { key: 'people',     routes: ['/employees', '/location', '/cash'] },
    { key: 'profile',    routes: ['/profile', '/products', '/services'] },
  ],
};
```

**This is a map per role, not one owner-shaped map with rows hidden**, and the difference is not cosmetic. An earlier draft carried a single map — the owner's — and filtered it by permission. That silently strands screens: `/cash` sits under People, which a technician cannot reach, so his handover would have no home at all. The failure produces no error — only a route that exists, is permitted, and cannot be navigated to.

Two routes therefore change home by role rather than being hidden:

- **`/cash`** — the owner's reconciliation queue under People; the field roles' own declaration (`/cash/handover`) as its own tab. It gets a tab rather than a row inside Profile because it is touched once, at the end of a shift, by someone tired and wanting to leave. A screen two taps deep at that moment is a screen that gets skipped, and a skipped handover is exactly the `missing_submission` row the owner's queue exists to catch.
- **`/contracts`** — the dispatcher's own **AMC** tab, because the reminders are daily work for him; an Operations entry for the owner. Sales reps have no AMC routes (2026-09-15).

Products and services live under Profile because they are settings — the owner edits a price or adds an SKU a few times a year. Putting them in Operations would give the group the dispatcher uses hourly two entries nobody opens.

- **Android, any role** — bottom tabs from that role's map. **Technician 4, dispatcher 4, sales rep 5, owner 5.** One component, one map per role.
- **Web, owner** — the same groups become sections in a persistent left rail, each expanded to its individual routes.

`RoleGate` still guards every route from `permit()`; the map decides *reachability*, the matrix decides *permission*, and a route in a role's map that `permit()` refuses is a bug the Phase 0 test suite should catch by walking both.

`NavShell` branches once on `Platform.OS === 'web' && width >= 1024`. **That branch appears exactly once in the codebase.** Screens never ask what platform they are on; they ask for a layout hint from context if they need one (§8).

---

## 4. State architecture

**Online-only, every role** (decided 2026-09-15, `docs/decisions/2026-09-15-online-only.md`). Three layers:

| Layer | Tool | Holds | Lifetime |
|---|---|---|---|
| Session | Zustand + `expo-secure-store` (native) / `localStorage` (web) | tokens, actor, role, consent state | until logout |
| Server cache | TanStack Query v5, **memory only** | every API read | the app process — never persisted |
| UI | component state / route params | filters, sheet state, typed form input | screen |

**Secure storage has no web implementation.** `expo-secure-store` is native-only, and the owner's desktop build is the one surface that needs a token store without it. It is a `.native.ts` / `.web.ts` pair behind one `tokenStore` interface, exactly like the location module in §6 — Keychain/Keystore on Android, `localStorage` on web. This is a real seam, not a detail: an agent who writes `SecureStore.getItemAsync` in shared code gets a web build that silently cannot log in, and the symptom is a login that appears to succeed and then bounces back to the login screen on every reload. Web is the owner's laptop on a trusted machine, and a 15-minute access token with a rotating refresh token is the mitigation; if that is judged insufficient later, the fix is an httpOnly cookie and a session endpoint, which is a server change, not a client one.

**Nothing else is written to the device.** Two named exceptions: the session token above, and the GPS ping buffer (§6) — a small SQLite table of pings not yet sent. No mirror, no outbox, no query persister, no AsyncStorage. The `no-device-storage` lint rule fails the build when any other module imports a storage API.

**TanStack Query configuration.** `networkMode: 'online'` for every role, so a failed fetch surfaces immediately. `staleTime` 30s for lists, 0 for a job detail being actively worked. Queries refetch on app foreground and on a push wake. `gcTime` 30 minutes — in memory.

---

## 5. Connection loss

**No connection is a full screen, for every role.** `NoConnectionGate` wraps the authenticated stack. When NetInfo reports no connection it covers the app with *"No connection — ServGrid needs the internet. You'll be right back where you were."* It is an overlay rendered above the stack, never instead of it: the screens underneath stay mounted, so a half-typed completion, sale or payment is exactly as it was when the connection returns. A gate that unmounted its children would throw that input away.

**A submit never silently loses work.** Every mutation:

- carries an `Idempotency-Key` minted **once per submit intent** — when the sheet or form opens — reused for every retry of that intent, and cleared only on success. Regenerating it per request is the single easiest mistake here: three taps on a frozen frame become three payments (this happened on a handset in Phase 3);
- on failure keeps every typed field, shows the server's `message` verbatim or *"Couldn't reach the server — nothing was saved yet. Try again."*, and re-enables submit;
- on an ambiguous failure — a timeout after the request left — retries with the same key, so the server replays what it already saved instead of saving it twice.

The typed input lives in memory only. Closing the app discards it; the owner accepted that trade in exchange for nothing being stored on the device.

**Refusals arrive at submit time.** A completion on a job the office cancelled returns `409 JOB_ALREADY_CLOSED` while the technician is still looking at the sheet, and the sheet shows the sentence. A duplicate company returns `DUPLICATE_ENTITY` with the existing row, and the form offers to open it.

**Server-assigned numbers** arrive in the submit's response. There is no "Pending sync" chip, because nothing is ever pending.

**Photos** are captured to the camera's temporary file, uploaded immediately after their parent record is created (`POST /v1/attachments`, own idempotency key), and the temporary file is deleted once the upload succeeds. A failed upload keeps the photo on screen with *Retry*; retrying never re-creates the parent, because the parent's key already succeeded.

**A push wake refetches.** The data-only FCM message invalidates the role's job queries; the local notification is composed from the rows just fetched, never from the payload.

### 5.1 Cold start

- **Session bootstrap never blocks on the network.** The stored actor, role and refresh token are read from the token store and the app routes to the role's landing screen immediately.
- **With no connection the gate shows over the landing screen.** Nobody is logged out. An expired access token is refreshed lazily on the first request once the connection is back.
- **Only a `TOKEN_REUSED` or an explicit `401` on a *completed* refresh round trip logs anyone out.** A refresh that fails because there is no connection is a retry, not a rejection.
- **Fonts and tokens are bundled, not fetched.** The splash gate waits on `expo-font` loading local assets and nothing else.

**Field staff are Android only.** On web, a successful login as `technician` or `sales_rep` is refused with *"Use the ServGrid app on your Android phone."* and the session is cleared. The server's permissions are unchanged; this is a product boundary, not a security one.

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

**Health chip** — on the technician's profile and visible to the owner. Four states:

| State | Text | Source |
|---|---|---|
| Green | "Tracking active · last ping 6 min ago" | `v_employee_tracking_health` = `active` |
| Amber | "Last ping 2h ago" | `stale` — older than 45 minutes |
| Red | "Background permission missing — fix" | `permission_missing` or `never_reported`; links into the ladder at the failed step |
| Amber | "Job alerts off — you won't be told about new jobs" | `devices.notifications_enabled = false` |

The fourth state is the notification permission, and it belongs on this chip rather than on a second one. A technician who declined the Android 13+ prompt still tracks fine — the foreground-service notification is exempt — but he stops being told about assignments, and nothing else in the app would say so. **Silent degradation is the failure mode this project treats as the enemy**, and a separate chip for it would be a second thing nobody looks at rather than one thing that is already being looked at.

It is amber, not red: tracking is intact and the job still arrives on next foreground. It is not green, because something the technician chose has quietly reduced what the app can do for him.

A chip that only ever says "active" is decoration.

**Consent** — a one-time screen at first login for technicians and sales reps, versioned, posted to the server. It is also the right screen to state the work window plainly, because it stops the app being experienced as something done to staff rather than with them.

**Web** — none of this. `location/`'s background module is `.native.ts` only; the web bundle has no counterpart file and never imports one. Owners are not tracked, so there is nothing to degrade gracefully.

**Assignment notifications share this plumbing.** The same FCM channel that carries *Locate now* carries a data-only message on assign, reassign, cancellation of an assigned job, and priority escalation. The handler does not render the push: it refetches the technician's work read and then raises a **local** notification from the job that arrived. A push that carried the job text would be stale the moment the office changed something.

Without this, the refetch triggers — reconnect, foreground, screen focus — none of which run in the background, mean a technician learns about an urgent job when he next opens the app.

**Treat every push as optional.** The app must behave identically if none ever arrive, because OEM battery management will eat some and there is nothing the client can do about it. A missed push costs latency, never work — and a notification permission the technician declines is a degraded experience, not a broken one. The permission ask belongs *after* the location ladder, not inside it, so a refusal here cannot strand someone mid-ladder.

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

**Language — English only**, decided rather than defaulted: all fourteen staff read it comfortably. No i18n layer, strings inline. The cost of changing this later is every screen, so it is worth one more look before Phase 1 rather than after.

Numbers are `en-IN` regardless. `MoneyField` groups by the Indian convention — `1,00,000`, not `100,000` — because a rep reading a balance back to a company will misread a Western grouping, and the digits are the one thing on the screen that must not need a second look. (§8 previously called this "IST-locale grouping", which is a timezone doing a locale's job.)

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

Primitives (`components/ui/`) — `Button`, `TextField`, `MoneyField` (tabular, `en-IN` grouping, no currency symbol in the input), `Select`, `DatePicker`, `Sheet`, `Banner`, `Skeleton`, `Chip`, `EmptyState`, `ConfirmDialog`.

Domain (`components/domain/`):

| Component | Notes |
|---|---|
| `JobCard` | 4px status rail, customer, address, scheduled time, status pill, plus the Overdue / warranty / contract chips where they apply. Phone only. |
| `JobRow` | The same job as a desktop table row. Shares the status-colour left edge. |
| `StatusPill` | Reads from the status colour map; never takes a raw colour. |
| `OverdueChip` | Open job past its scheduled date. Reads `is_overdue` from the server, never recomputed from a device clock. |
| `WarrantyChip` | "In warranty · to 14 Mar 2027" on a job whose `customer_product_id` is still covered. |
| `ContractChip` | "AMC · until 14 Sep 2027". Tells the technician the job is under the customer's AMC; never a price. |
| `StatusStepper` | The one animated element. |
| `TechnicianPicker` | **Shows load inline** — "Ravi · 3 today", "Anitha · 6 today". Never a bare dropdown of eight names. |
| `FilterBar` | Persistent, horizontally scrollable chips; technician, status, date. Reflects state in the URL. |
| `MultiSelectList` | Long-press enters selection mode, header becomes a count + bulk action. Replaces table checkboxes. |
| `PhotoCapture` | Camera + gallery, local URI, thumbnail with upload state. Uploads right after its parent submit is accepted; the temp file is deleted once uploaded. |
| `PartsList` | Repeating row: product picker, quantity, optional serial. Collapsed by default. **Never shows a subtotal** — see §9. |
| `NoConnectionGate` | Full-screen *No connection* over the authenticated stack, every role. Rendered above the stack, never instead of it, so typed input survives. Replaced `SyncBanner` + `PendingBadge` (2026-09-15). |
| `TrackingHealthChip` | Four states (§6). Red and amber link back into the permission ladder at the failed step. |
| `DataTable` | Web only. Sortable, sticky header, virtualised. Lives in `.web.tsx`. |
| `MoneyGate` | Renders children only if `permit(role,'job.money','read') !== 'none'`. Belt-and-braces over the API's schema separation. |

**Three new chips is where an accent quietly dies.** §7 permits safety yellow on exactly two things — the primary action and the active state — and every chip added afterwards is a reasonable-seeming request for a bit of colour. So they are pinned here:

| Chip | Treatment |
|---|---|
| `OverdueChip` | Cancelled red `#B3261E`, outlined not filled. It is a warning, and it must not read as a status the job is *in*. |
| `WarrantyChip` | Muted `#5A6B7C` on `surfaceDense`. Information, not alarm — most in-warranty jobs are ordinary. |
| `ContractChip` | Muted, same treatment. |

None of them is yellow. A job card can already carry a status rail in `inProgress` yellow, and a second yellow element beside it would make the rail stop meaning anything — which is the erosion §7 describes, arriving one reasonable PR at a time.

**Platform splitting** uses Metro's `.native.tsx` / `.web.tsx` resolution, not runtime `Platform.OS` checks scattered through screens. `DataTable` and the map have no native counterpart and are never bundled into the APK.

---

## 9. Screens

### Technician — Phase 1

| Screen | Data | Actions | Reads / writes |
|---|---|---|---|
| Dashboard | today's assigned jobs, tracking health | open a job | `GET /v1/technician/work` |
| Jobs | tabs: Today / Upcoming / Completed | filter, open | `GET /v1/technician/work` |
| Job detail | job, customer, **the specific unit**, product stack, warranty and contract chips, events | call, **Navigate** (deep-link to Google Maps), status change | work read + `GET /v1/jobs/:id/events`; `POST /v1/jobs/:id/status` |
| Complete sheet | — | work summary, **one amount field**, optional discount + reason, collection mode, photos, stack changes, parts used | `POST /v1/jobs/:id/complete`, then photos |
| Cancel sheet | — | reason code, note, **optional reschedule date** | `POST /v1/jobs/:id/cancel` |
| Cash handover | his own declaration for today, plus his history | declare amount, note; **amend his own figure while it is still `submitted`** | cash handover endpoints |
| Profile | health chip, permission ladder state | re-run ladder steps, logout | `GET /v1/location/health/me`, `GET /v1/devices/me` |

**Navigate deep-links to Google Maps** (`google.navigation:q=lat,lng`) — traffic, voice guidance and offline tiles nothing in-app would match. There is no map in the technician app at all.

**The job says which unit.** A site with five UPS units and three battery banks otherwise produces a docket reading "battery swap" and leaves the technician to work it out on arrival. When that unit is still covered, a `WarrantyChip` carries the expiry date.

**The complete sheet is the highest-stakes screen in the product.** It is filled one-handed, in poor light, possibly wearing gloves, by someone who wants to leave. Design consequences: one amount field by default with "Add discount" as a secondary disclosure that opens amount + reason together; collection mode as three large segmented buttons, not a dropdown; the submit button in the thumb zone and never disabled for a network reason.

Two conditional behaviours, both about not asking for money that isn't owed:

- **An AMC job opens on *Free under AMC*.** The amount field and Paid-by are absent — not zero, not disabled — and the payload carries no charge. One tap on *Charge* brings the ordinary money fields back for extra work (`docs/decisions/2026-09-15-amc-contracts.md`).
- **An in-warranty unit completed with a charge raises a confirmation**, not a block: *"This unit is under warranty until 14 Mar 2027. Charge anyway?"* Out-of-scope work on a covered unit is legitimately chargeable, so this is a prompt. It is the only confirmation on this sheet, which is what keeps it meaningful — a technician who dismisses two dialogs a day will dismiss this one without reading it.

**Parts fitted** are a third disclosure on the sheet — "Parts used", collapsed by default, opening a short repeating row of product picker, quantity, optional serial. Most jobs fit nothing and never open it.

They are recorded because a fixed-price AMC whose visits consume two filters each time has a cost the renewal quote should reflect, and nothing else in the schema can tell the owner that. **Parts do not change the amount**, and the UI must not imply they do: the field sits *below* the amount, never above it, and no total is ever shown against the parts list. A technician who sees a parts subtotal will assume the app is computing the bill, and the next thing that happens is a discrepancy nobody can explain.

**Cash handover has no expenses field.** An earlier draft had one, for money spent from collections. The owner has confirmed technicians do not do that, so the screen stays at one number and a note — which is the right outcome for the second-most-delicate screen a technician touches.

**The cancel sheet asks whether it can still happen.** Reason code, optional note, and then *Reschedule to* — a date picker, skippable. This is where a wasted trip gets recorded: the technician standing at a locked gate is the only person who knows whether the customer said "come Thursday" or "don't bother", and routing that through the office means the decision is made hours later by someone who was not there.

An AMC job cancels exactly like any other: AMCs carry no visit count, so nothing is spent, and a new date raises a successor still linked to the AMC.

### Dispatcher — Phase 2

Online-only, with an explicit error state on every screen — never a spinner that resolves into nothing.

| Screen | Notes |
|---|---|
| Dashboard | **overdue count first**, then unassigned, per-technician load, today's status split |
| Dispatch Job | customer search-or-create, the unit at that site, service, priority, schedule, `TechnicianPicker`, and a ticked **AMC job** option when the customer has an AMC covering today |
| Job Logs | **the phone-first screen that costs something**; Overdue is a filter chip and sorts first |
| Customer | search, create, edit, view stack read-only. **No company field** — dispatchers have no company permission, so it is not on the form and the API strips it |
| AMC | from Phase 2B, its own tab: **due for a visit** (four months after the customer's last completed job), **ending within 7 days**, all AMCs. He records, edits, renews and cancels AMCs, with the price |
| Profile | self only |

**Overdue leads the dashboard** because it is the only number on it that represents a promise already broken. Unassigned work is a queue; overdue work is a customer who was told a day. Nothing advances a job's date on its own — that would make the number go away without anything being fixed.

**Job Logs** was a sortable table with a sticky header. On a phone it becomes a filtered list with a persistent `FilterBar` — technician, status, date — and bulk reassign becomes a long-press multi-select mode rather than checkboxes in a table. Filter state lives in the URL so a filtered view survives a reload and can be shared.

`PLAN.md` §11 says prototype this before building it. **Do that in Phase 1's spare capacity, with real volumes** — 200+ jobs, not six. The specific thing to test is whether a dispatcher can answer "who has the Kormangala jobs today" in under five seconds on a phone. If not, the fallback is a compact two-line row at 44px with the filter bar pinned, accepting a smaller tap target for this one screen because a dispatcher is seated and not wearing gloves.

Dispatcher screens never request or render money. The API will not send it; `MoneyGate` makes that visible in the code rather than implicit.

### Sales Rep — Phase 3

| Screen | Notes |
|---|---|
| Dashboard | month's sales, outstanding across his accounts, recent payments |
| Sales | list, create with line items — product picker snapshots name and price at add time; each line records **list price, discount % and the final price** |
| Payment | **Pending** = companies with `balance > 0` (a view, not rows); **Collected** = his payments. Capture: amount, mode, proof photo — **no reference field**; the photo is the evidence |
| Company | **his accounts plus house accounts**, with balances; detail with ledger and running balance |
| Cash handover | his own declaration, same screen as the technician's with a different heading |
| Profile | health chip — reps are tracked too |

**"His companies" now means something.** `owner_rep_id = him, or NULL`. A house account is visible to both reps and is where an owner-created company lands; only the owner can move an account between reps, which is also how a fortnight of leave gets covered. Before this, the rep's company list had no defined contents at all.

**The rep declares cash like a technician.** Company payments are usually bank transfer or UPI, but "usually" leaves a path where money passes through a rep's hands with nothing asking him about it — and a rare path is one nobody notices is broken. It is the same screen, not a new one.

The Pending tab distinction is worth stating in the UI copy: it lists **companies that owe money**, not scheduled collections. Labelling it "Pending payments" invites the reading that a row is a payment, which is exactly the stored-counter thinking the data model rejects.

Sales reps write straight to the API like every other role; a failed submit keeps the form and retries with the same idempotency key (§5).

### Owner — Phase 4

Both layouts. Fourteen routes in five Android groups; a left rail on web.

| Screen | Phone | Desktop |
|---|---|---|
| Dashboard | stacked stat cards, Condensed figures | 4-up stat row + charts |
| Jobs | `JobCard` list | `DataTable` — sortable, sticky header, status colour on the left edge |
| Sales / Payments | cards | tables with running totals |
| AMC | the dispatcher's AMC sections as cards | table with price, state and next due; linked jobs in the side detail |
| Location console | roster with health + last-seen | **map + roster + day trail** |
| Cash queue | flagged cards, `missing_submission` first | table: expected / declared / variance / flag |
| Employees, Products, Companies, Customers | list + detail | tables + side detail |

**The dashboard's contents, so Phase 4 does not open with a design conversation.** Four stats: open jobs by status today · cash awaiting confirmation · month-to-date completion revenue · total outstanding company dues. Two charts: jobs per day over thirty days, revenue per week over twelve. Every one reads a view that already exists. `PLAN-FRONTEND.md` previously specified the *layout* of this screen and none of its content, which is enough to stall a phase.

**The cash queue has no expenses column, and every variance on it is real.** An earlier draft carried expenses so a technician who bought a part out of collected cash would not raise a false shortfall; the owner has confirmed that does not happen (`PLAN.md` §4). Nothing on this screen offers a way to explain a shortfall away — the actions are confirm, dispute, or go and look. That is what makes the flag worth the owner's attention rather than something he learns to dismiss.

**Amending a completion** is an owner action reachable from the job detail: a reason is required, and if that day's handover is already confirmed the API refuses with the reconciliation named. The UI then offers to reopen it — two deliberate steps rather than one convenient one, because confirmation is where money stops being provisional.

**Location console** is the only map in the system and it is web-only. `react-native-maps` drops out entirely; one web map library remains — MapLibre GL JS with hosted OpenStreetMap tiles from MapTiler (decided 2026-09-15), avoiding a Mapbox token for a 1-user surface. The style URL is `EXPO_PUBLIC_MAP_STYLE_URL` (`apps/mobile/.env.example`). Shows current positions, a selected employee's day trail with time labels, and a *Locate now* action that posts a request and polls it, showing "requested 40s ago, device has not answered" rather than spinning.

**Cash queue must default to a range that includes days with no submission.** `missing_submission` sorts first. A default filter of "submitted handovers" would hide the exact row the feature exists to catch.

---

## 10. Testing

| Layer | Tool | Scope |
|---|---|---|
| Permission rendering | vitest + RTL | every screen under every role — asserts money is absent for dispatchers, **no completion figure on any dispatcher screen** |
| Intent writes | vitest | **key generated once per submit intent and reused across retries**; kept on a network error or 5xx, cleared on a definite 4xx or success; 401 refresh-and-retry; typed input survives every failure |
| Complete sheet | vitest + RTL | AMC job opens on Free with no amount field and Charge brings it back; in-warranty charge raises exactly one confirmation; discount discloses a mandatory reason; **parts list renders no subtotal and does not alter the amount** |
| Cancel sheet | vitest + RTL | a date raises a successor; a date in the past is refused |
| Connection loss | vitest + a device with airplane mode toggling | the *No connection* screen covers every role; a half-typed complete sheet is intact when it returns and submits once |
| Location | manual matrix, Phase 5 | per handset: overnight survival, basement gap recovery, battery cost over a work day |
| Visual | screenshots at 360dp, 412dp, 1280px, 1920px | the card-vs-row rule on every owner screen |
| Field | Phase 5 | sunlight legibility, gloved tap accuracy at 52px, one-handed complete sheet |

The location matrix is a table of `manufacturer × OS version × mitigation state` filled in from the actual handsets staff carry. `PLAN.md` §11: this cannot be simulated, and it is the one test plan that must not be compressed.

---

## 11. Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Dispatcher Job Logs on a phone — prototype at real volume before building | **High** — the one screen where phone-first has a real cost | Prototype in Phase 1, decide before Phase 2 |
| 2 | ~~Web map library — MapLibre + raster tiles proposed; needs a tile source decision~~ **Closed: MapLibre with hosted OpenStreetMap tiles from MapTiler**, attribution shown by the map's compact control; style URL in `EXPO_PUBLIC_MAP_STYLE_URL` | — | Done (2026-09-15, TON.8) |
| 3 | Whether a technician sees amounts in his own completion history. Proposed: no. Mirrors `PLAN-BACKEND.md` open item 2. | Low, but staff-visible | Phase 1, confirm with owner |
| 4 | OEM autostart walkthroughs need real screenshots per vendor — cannot be written from documentation | Medium — blocks the ladder's last step | Phase 1, needs the handsets |
| 5 | Owner desktop is a React Native Web build. If the `DataTable` and rail fight RNW hard enough, a separate thin React app sharing `packages/shared` is the escape hatch. | Medium — a real fork in the road | Assess at Phase 4 start |
| 6 | Dark mode deferred. `PLAN.md` §9 warns the contrast levels were chosen for sunlight, not monitors — if it is ever added, do not soften them. | Low | — |
| 7 | ~~Notification permission on Android 13+ has no visible failure state.~~ **Resolved:** it is the fourth `TrackingHealthChip` state (§6), amber, sourced from `devices.notifications_enabled`. Kept here because the chip is Phase 1 and the notification permission is Phase 2 — the state must be built with a source that is always `true` until Phase 2 fills it in. | — | Built Phase 1, populated Phase 2 |
| 8 | ~~Contracts appear in two nav groups (§3).~~ **Moot since 2026-09-15**: AMC is the dispatcher's own tab and an Operations entry for the owner; reps have none. | — | Done |
| 9 | English-only is now a recorded decision rather than an omission. Revisit once, with an actual technician, before Phase 1 — the cost after is every screen. | Medium if wrong | Before Phase 1 |
