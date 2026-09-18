# Owner web console — full walk, 2026-09-19

A screen-by-screen, control-by-control pass over the owner's web console
(`apps/mobile` web build, `http://localhost:8081`, owner `owner` /
`ui-walk-2026`), taken against the live dev stack (API `:8787`, Postgres
`:5433`, MinIO `:9000`, 16 jobs / 12 customers / 14 employees). Follows
the OW.0–OW.7 rounds; everything OW.0–OW.7 shipped is in `main` and was
treated as settled, not re-litigated.

Every rail row was visited. Every button, tab, dropdown, dialog, filter,
sort header, sheet and deep link reachable by the owner was pressed,
except the deliberate omissions listed at the end. Where a write was
needed to make a screen walkable, it was made through the UI itself, so
the write path got exercised too.

Server-side: no `5xx` in the whole session. `401` — 1666 (overwhelmingly a
stale browser tab predating this walk, per the runbook's diagnosis), `403`
— 1 (correct: the owner's cash declaration), `404` — 3 (see P1-3).

---

## P0 — the console is wrong, or the owner cannot do the thing

### 1. The owner's Jobs page is a dead end on any quiet day

`/jobs` defaults to Day = **Today**, and when the result set is empty the
**filter bar is not rendered at all** — it lives inside the
`sorted.length > 0` branch (`src/screens/owner/JobsScreen.tsx:253-290`).
So on a day with no work the owner sees:

    Jobs
    0 jobs
    No jobs yet.

…with no Day / Technician / Status controls and therefore **no way to
reach his 16 jobs**. The message is also false: jobs exist, just not
today. `filteredEmpty` (`:239`) is only true when the filters differ from
default, so the "No jobs match these filters. → Clear filters" path
(`owner-jobs-empty-filtered`) can never appear on first landing.

Hit this for real: after dispatching a job the screen still read
`0 jobs` (see P1-1), and only switching Day to **All days** exposed the
list. The Day filter does offer Today / Tomorrow / This week / All days —
the owner just can't get to it.

**Fix direction:** render the filter bar whenever the screen is in its
desk layout, empty or not; make the empty copy distinguish "no jobs on
this day" from "no jobs at all"; consider a wider default for the owner
(the owner reads history; the dispatcher's Job Logs is the screen that
means "today").

### 2. Cash queue — the row actions don't fit their rows

Rows are 40pt; the action cell holds three buttons (`Confirm` /
`Dispute` / `View the day`, `src/screens/owner/cash-queue.tsx:532-548`)
in a two-line, 76pt box clipped by the row's `overflow: hidden`.

Measured on the live page:

| | top | bottom | height |
|---|---|---|---|
| `cash-confirm-…` button | 158 | 194 | 36 |
| its row `data-row-…` | 176 | 216 | 40 |
| visible part of the button | 176 | 194 | **18** |

Consequences, all visible in a screenshot: the button labels are cut in
half horizontally; row 1's third button (`View the day`) paints inside row
2's band; Playwright refuses a normal click ("no click point") and a real
pointer click only lands in the 18pt sliver. On the screen Phase 4 exists
for, the primary actions are barely targets.

**Fix direction:** give the cash row an overflow affordance (one primary
action + a `⋯` menu), or make the row height fit its content. Three
money-affecting buttons in a 40pt row will not work at any zoom.

### 3. Cash queue — both filter dropdowns are painted under the table

`Range` and `Flags` open, but every option is **covered by the table**.
Hit-tested at each option's centre:

| option | element actually hit |
|---|---|
| Range → Last 14 days | a plain `DIV` in the row band |
| Range → **Today** | `data-row-123c1d6c-…` (the table row) |
| Flags → All flags | `cash-queue-table` |
| Flags → Missing submission | `data-row-123c1d6c-…` |
| Flags → No expected cash | `cash-queue-table` |
| Flags → Variance / Match | `cash-queue-table` |

A real click at "Today"'s coordinates does nothing: the menu stays open,
the trigger still reads "Last 14 days". The menu is `absolute; z-index:20`
inside `cash-range` (`z-index:50`), which loses to the table.

Worse, the open popover's full-page backdrop (`cash-range-backdrop`,
4126×4036) sits above the rest of the filter bar, so while one dropdown is
open the other cannot be clicked either, and clicking the table area does
not dismiss it — only clicking outside the table does.

This is the same class the dashboard fixed in OW.5 ("the open field rises
with its bar"); the cash queue never got that treatment. **The same
dropdowns on Jobs (`job-logs-filter-*`) and Companies
(`owner-companies-filter-*`) are NOT affected** — verified unobstructed —
so the fix is scoped, not systemic.

### 4. Every job timestamp is rendered as UTC, not IST

The API sends `Z` timestamps; the owner's jobs formatting assumes an
IST-offset string and slices the wall clock out of it.

- `src/screens/owner/jobsModel.ts:66` — *"`2026-09-02T14:30:00+05:30` →
  `2 Sep · 14:30` (the IST wall clock the api sends)"* then slices
  `[11,16)`. The API sends `2026-09-19T04:30:00.000Z`.
- `src/screens/owner/JobDetailBody.tsx:217` — same slice for event times.
- `src/screens/owner/customersModel.ts:58-61` and
  `CustomerDetailBody.tsx:100` — same slice for the "Last job" date.
- `src/screens/owner/locationModel.ts:212-221` does it **correctly**
  (`IST_OFFSET_MS`), which is why the location console and the Calls tab
  are right and the jobs/customers surfaces are wrong.

Verified against the database:

| what | stored | IST truth | UI shows |
|---|---|---|---|
| job I scheduled at 10:00 | `2026-09-19 04:30Z` | 10:00 | **04:30** |
| `JC-2627-0909` (Calls says 9 Mar) | `2026-03-08 19:38Z` | 9 Mar 01:08 | Customers says **8 Mar** |
| `JC-2627-00223` | `2026-09-18 07:30Z` | 13:00 | **07:30** |

**10 of the 16 jobs in the dev DB have a UTC date that differs from their
IST date**, so the owner's Jobs table shows the wrong day for most of his
history. The bug is now self-contradicting on-screen:

- Contract detail: "Last service **19 Sep 2026**" above "JC-2627-00227 ·
  **18 Sep** · Tech One" — the same visit, two dates, one screen.
- The Calls tab says "Last service **9 Mar**" where the Customers list
  says "**8 Mar**" for the same job.
- Sorting and the day filter are string-based, so they inherit the skew.

**Fix direction:** pick one contract and hold it — either the API
serialises IST-offset ISO strings (what `jobsModel` documents), or the
client applies an IST offset everywhere (what `locationModel` does).
Given `locationModel` already has the helper and the DB already carries
`AT TIME ZONE 'Asia/Kolkata'` helpers, one shared formatter in
`src/lib/` used by every owner surface is the smaller change.

### 5. "New sale" and "Record payment" are blank pages

The company ledger's two primary actions
(`CompanyDetailScreen.tsx:72-73`) push `/sales/new?company=…` and
`/payments/new?company=…`, which render a bare centred word — "New sale"
/ "Record payment" — for the owner (`sales/new.tsx:111-116`,
`payments/new.tsx:66-71`). No form, no message naming the reason, no back
control. The owner has no way to record a sale or a payment anywhere in
the console.

**Fix direction:** either build the owner's capture (he is `all` on
`sales.*` and `payments.*` in the permission matrix), or remove/disable
the buttons with a line of copy. A dead end that looks like a broken page
is the worst of the three options.

---

## P1 — wrong, misleading, or unsafe to trust

### 1. Writes don't refresh the screen they land on (inconsistently)

- Dispatch a job → lands on `/jobs` showing **`0 jobs`**; the API log shows
  **no re-fetch** after the create; a manual reload shows `1 job`.
- Save a customer edit → lands on the customer page **without the company
  row**; the DB has the new `company_id`; a reload shows "Pooja Power /
  Ledger →" correctly.
- But creating an employee *does* refresh the roster (14 people
  immediately), and deactivating refreshes the detail. So it is per-screen,
  not universal — the Jobs list and the customer detail cache, the roster
  doesn't.

### 2. The Location console's map is blank

The MapTiler style, `tiles.json`, sprite JSON and sprite PNG all return
**200**, and a manual fetch of a vector tile
(`…/tiles/v3/12/2900/1880.pbf`) returns **200** — but MapLibre makes
**zero vector-tile requests**. The canvas renders only the style's
background colour, with the marker dot and the attribution on top. The
tile template is `https://api.maptiler.com/tiles/v3/{z}/{x}/{y}.pbf?key=…`.

So the one screen whose whole point is "where is everyone" is a blank
card. The roster, the locate panel and the trail caption still answer the
question, and the "no map style" placeholder is not the active path.

*Not diagnosed further:* style parsing succeeds and the background layer
paints, so WebGL works; the suspicion is the tile-fetch/worker path under
the Metro web bundle, but that needs its own investigation.

### 3. `Locate now` can never be answered — push registration 404s

The client POSTs to `/v1/devices/push-token` (`src/push/push.ts:19`) —
**the API has no such route** (only `GET /v1/devices/me`,
`src/modules/devices/routes.ts:46`). Three `404`s in the log during this
walk. Pressing Locate now therefore always lands on:

    Requested less than a minute ago — device has not answered
    Why: Push failed — the request never reached the device.

Credit where due: the panel **does not spin** and does state the reason
honestly, exactly as §O3 requires. But the capability behind it is
unreachable until the route (and a sender) exist.

### 4. A dead session leaves the app lying instead of routing to login

Opened with an expired stored session: the shell rendered, `/dashboard`
showed the owner's name (falling back to the username), and the raw 401
text appeared **three times on one screen** —

> "Your session could not be verified and may have expired. Nothing you
> queued was lost — the app will refresh your sign-in automatically."

— above two separate "Retry" buttons, with an empty Performance panel and
an empty Needs-attention panel. The token was cleared from storage in the
process, but no route change to `/login` happened; a manual reload was the
only recovery. This is the open behaviour recorded in the project notes;
the walk reproduced it end to end.

### 5. The tracking-health column cannot be trusted

- Every **active** account reads "Problem" — including `owner` and the
  other owner accounts, which are never tracked, and including an account
  created during this walk that has **never logged in** (last login
  "Never"). Only the deactivated one reads "Not tracked". At 11 pings in
  the whole database, "Problem" is technically true but useless: the
  column trains the owner to ignore it.
- The same state is **worded differently** on two screens for the same
  person: `/employees` says "Problem", the `/location` roster says
  "No permit", the employee page says "Background permission missing",
  and a never-seen device says "Tracking is not set up on this phone".
  Four phrasings of one fact.
- The employee page's chip is `role="button"`, `tabindex="0"`, reads
  "… — **fix**", and clicking it **does nothing** (`onHealthFix` is never
  passed by `employees/[id].tsx`). A focusable button that no-ops is an
  accessibility lie, not just a dead control.

### 6. Placeholder routes the owner can reach, one of which leaks internals

Visited directly (all render a title and nothing else):

| route | what the owner sees |
|---|---|
| `/jobs/<id>/events` | "Job events timeline **(T0.13)**" |
| `/jobs/<id>/complete` | "Complete sheet" |
| `/jobs/<id>/cancel` | "Cancel sheet" |
| `/customers/<id>/stack` | "Customer equipment stack **(T0.13)**" |
| `/products/<id>` | "Product detail **(T0.13)**" |
| `/sales/<id>` | "Sale detail" |
| `/payments/<id>` | "Payment detail" |
| `/companies/new` | "New account" |
| `/profile/tracking` | "Tracking health **(T0.13)**" |
| `/profile/settings` | "Settings **(T0.13)**" |
| `/jobs/logs` | "Job Logs" (flag off) |
| `/cash/handover` | **a working "Declare the cash you are handing over" form** |

Two things to fix here: an internal task code (`T0.13`) is user-visible
copy on five screens; and `/cash/handover` is a field-role screen with no
owner gate — the owner is `none` on `cash.declare`, so submitting it
returns 403 ("Cash is declared by the employee who collected it." — which
the screen shows in a banner, and the server is correct to refuse). It
should not be reachable for him at all.

### 7. Confirmation and undo gaps

- **Products and Services deactivate with no confirmation and no undo**
  (`ProductsScreen.tsx:126-132` — a ghost `Button` straight to
  `onDeactivate`). The row then renders "Deactivated" with no way back.
  The employee equivalent *does* have a dialog that explains the
  consequences — that is the standard to copy.
- **Employees cannot be reactivated.** The detail screen offers only
  "Deactivate", including on an already-deactivated account. An accidental
  deactivation is a database errand.
- `Void` on a sale and on a payment renders as **plain black text** with no
  button affordance, in a row where `Confirm` elsewhere is a yellow pill —
  the most destructive action in the table looks the least like a control.

### 8. Premature validation in the money dialogs

Both the amend dialog (`AmendSheet`) and the void dialog (`VoidReasonSheet`)
open with **"A reason is required."** already on screen, before the owner
has touched the field. The error clears once a reason is typed and the
submit enables correctly — but the first thing the owner sees is an error
he has not earned.

### 9. The void dialog prints raw money

`Void` shows the sale as **`7200.00`** — no `₹`, no `e-IN` grouping —
while the table behind it reads `₹7,200`. Same defect class the money-leak
rules exist to prevent.

### 10. Desk dialogs centre on the window, not the content pane

Every dialog (amend, void, day sheet, confirm, push-back) sits at the
window's centre (x 400–1040 in a 1440 viewport) while the content pane
starts at 240 — so they hang left of the table they belong to, overlapping
the rail's edge and the table's first columns.

### 11. Smaller but real

- **Companies, blank Balance cell.** `GET /v1/companies/balances` returns
  only companies with ledger activity (1 of 2), and the client renders
  nothing for the missing one — "Power Teah" has an empty cell where `₹0`
  belongs. The totals bar is correct.
- **Companies, wrong empty state.** Filter → "House accounts" → `0 of 2
  accounts` then **"No accounts yet."** — accounts exist; none match. The
  AMC screen has the right copy ("No AMC matches."); the customers screen
  too.
- **AMC renders "Clear search" twice** when the search finds nothing — an
  `EmptyState` action and a second `Button`, same label, same handler
  (`AmcScreen.tsx:211-217`).
- **Duplicate test ids from FlashList's sticky header.** Every desk table
  carries its sort headers **twice** — one in the flow, one in the
  absolutely-positioned sticky clone (`DataTable.web.tsx:308`,
  `stickyHeaderIndices={[0]}`). Visually overlapping, so it looks fine, but
  both are focusable buttons with the same `aria-label`, so a screen
  reader and the tab order see each sort control twice, and it breaks
  strict-mode UI automation (`getByRole('button', {name:'Sort by Flag'})`
  resolves to 2 elements).
- **Hidden screens stay mounted.** After `/dashboard` → `/cash`, the
  dashboard's 18 attention rows are still in the DOM (`display:none` +
  `aria-hidden`, so not interactive — the mitigation is correct) with the
  same `data-row-*` test ids as the live screen. Harmless today; it is why
  cross-route test ids collide.
- **Two employees are both named "Ravi Kumar"** (`ravi`, technician;
  `rep1`, sales rep). The dashboard's technician filter, sales-rep filter
  and all four chart legends identify people by name alone, so the owner
  cannot tell them apart — while the Reassign sheet already solves exactly
  this by showing "Ravi Kumar / rep1".
- **Date format inconsistency on the customer page.** Job history shows
  `JC-…0223 · Tech One · 2026-09-18` (raw ISO) where the rest of the
  console says "18 Sep".
- **Profile lists the owner as another owner.** "Also holds owner access:
  Y (dev_owner1), ServGrid Owner (owner), …" — the current account is in
  its own list.
- **A day-sheet header prints `Ravi Kumar — 2026-09-18`** (ISO) while the
  table behind it prints "18 Sep".
- **Cash dropdown option heights differ** (44pt vs 82pt) when a label
  wraps ("Missing submission"), so the menu is visually ragged.
- **Saving a deep-linked edit form** (opened by URL, no history) leaves the
  owner on the form instead of returning — `router.back()` with nothing to
  pop. Low impact, but it is the shape of "I clicked Save and nothing
  happened".
- **`.env.example` traps** (pre-existing, not UI): its `DATABASE_URL`
  points at 5432 with no `SERVGRID_DB_PORT` and it has no `PORT` line, so
  copying it verbatim gives a different DB and the API on `:3000`.

---

## What held up under the walk

- **Rail** — 16 rows, 6 groups, live hover/active, active row 2px accent,
  collapse 240↔72pt and back (the spec's "the rail does not collapse" is
  stale; the behaviour is deliberate and works).
- **Dashboard** — 4 figures with captions, four Recharts panels + the two
  older charts, one range switcher driving all of them
  (week → `2026-08-21 to 2026-09-19`), per-person filters that correctly
  empty to "Nothing in this range.", an 18-row consequence-ordered
  attention table whose rows navigate to the right door (`/cash`,
  `/location`, `/contracts`), working header sorts, and the honesty rule
  that a departed employee still shows while the range holds their work.
- **Dispatch** — the whole form end to end: server-backed customer search
  ("Vega" → Vega Diagnostics), unit reveal, service sheet (5 services),
  4-way priority with the urgent note appearing on demand, month calendar
  with prev/next + "No day", half-hour time slots, contact/notes, the
  load-first assignee picker, and `Create and assign` → `POST /v1/jobs`
  200 → `POST /v1/jobs/:id/assign` 200 → job `JC-2627-00911` created and
  assigned. The form closes itself on success (DIS.8).
- **Customers** — name and phone search (both prefixes work), Clear, the
  desk table, detail page (phone/Call, address, location/Map →
  `google.com/maps/search/?api=1&query=lat,lng` in a new tab, stack empty
  state, job history), and the **owner-only Company picker** working as a
  round trip (pick → save → ledger link appears; revert → link gone).
- **Sales / Payments** — running-total bars, tables, row-preview sheets,
  and the payment **proof photo actually renders** from the presigned
  MinIO URL (1200×1600 natural) — no blank box on web.
- **Companies** — balances, owner rep, the Reassign sheet (whose option
  labels `Ravi Kumar / rep1` are the disambiguation model the dashboard
  needs), and a ledger whose running balance is arithmetically coherent
  across all 7 documents.
- **Employees** — roster with username beside the name, create with real
  validation (`Use 3-32 characters…`) and role gating, and a Deactivate
  dialog that explains *"Every session ends, the roster drops him, and his
  devices mark inactive. Open work blocks it"* — then refreshes in place.
- **Location** — roster with health rail and last-seen, the three sorted
  columns, map container + attribution + trail caption, and Locate now /
  Live 5 min showing **an honest non-spinning state with a reason**.
- **Catalogue** — both lists (6 products, 5 services) and both create
  forms, whose helper copy is genuinely good ("Short and shouted: AMC,
  INSTALL, BATT-SWAP.", "A service is never deleted; deactivate it and it
  leaves the pickers while its history stands.").
- **AMC** — three sections with counts, the all-table, detail with jobs
  under the contract, Edit (prefilled), Renew, and Cancel with a required
  reason.
- **Calls** — two tabs with counts (Due now 9 / Pushed back 1), cards with
  the due chip and last service, Call / Assign / Not now, and the full
  push-back sheet.
- **Profile** — second-owner reminder, catalogue links, app version,
  change-password, and **Log out**, which cleared storage and returned to
  `/login` cleanly.

---

## Deliberately not pressed

- **`Call`** buttons (`tel:`) — desktop has no telephony handler. `Map` was
  pressed and hands off correctly.
- **The stack-correction sheet** — `customer_products` has **zero** rows in
  the dev DB, so every site says "No units recorded at this site." and the
  edit/remove sheet cannot be reached.
- **The destructive confirms** — sale Void, payment Void, cash
  Confirm/Dispute/Reopen, AMC Cancel, product/service Deactivate: each was
  opened and read, then dismissed rather than confirmed, to leave the demo
  data intact.
- **`/profile/password` submit** — not submitted (would change the owner's
  password).
- **Location roster sorts** — pressed, but indistinguishable with this data
  (five of six rows are identical "No permit / Never reported").

## Data the walk changed

| change | state |
|---|---|
| Job `JC-2627-00911` created — Vega Diagnostics, Repair, Ravi Kumar, 19 Sep 10:00, urgent | **left in place** (it gives the demo a today-dated assigned job); removable on your word |
| Account `ow.walk1` — "Owner walk test (delete me)", dispatcher | created, then **deactivated**; no delete exists in the UI |
| Rajesh's company link | set to Pooja Power, then **reverted to No company** (net zero) |
| `location_requests` | one row added by Locate now (2 total) |
| Cash declaration attempt | **refused 403** — no row written |

## Suggested order for the overhaul

1. **The two cash-queue blockers** (P0-2, P0-3) — that screen is the reason
   the console exists.
2. **The Jobs dead end** (P0-1) plus the refresh gaps (P1-1) — the owner's
   basic "what happened" loop.
3. **One IST formatter everywhere** (P0-4) — it is one helper, and it is
   currently corrupting dates on five surfaces and contradicting itself on
   two.
4. **The blank-map and dead-push pair** (P1-2, P1-3) — decide whether the
   location console ships this round or gets parked honestly.
5. **The copy and confirmation pass** (P1-5…P1-11) — empty states, the
   duplicated Clear search, the `T0.13` leaks, the `fix` chip, the raw
   `7200.00`, the missing confirms, the dialog centring.
6. **Then the visual overhaul proper** — the look is broadly right
   (navy frame, yellow action, status edge, tabular figures, tables not
   card grids); what it needs is consistency, not a new identity.
