# Phase 2 — Dispatcher

**Size M · ~4 weeks · Risk: medium, concentrated in one screen**

Three users, online-only, seated at a desk on office wifi, **working from a phone**. The failure mode is an explicit error state — never a queue, never a spinner that resolves into nothing.

**Entry — two hard gates:**

1. **The Job Logs prototype from T1.22 passed**: a dispatcher answers *"who has the Kormangala jobs today"* in under five seconds, on a phone, against 200+ jobs, median. If it did not, take the descope **before the phase starts** (`PLAN-EXECUTION.md` Phase 2).
2. **FCM proven end to end in Phase 0.** Assignment notifications are the reason it moved forward two phases; without the channel, a dispatcher can assign urgent work the technician will not see until he next opens the app.

**Also decided before starting:** what the local notification says when work is *taken away* by a reassign (`PLAN-BACKEND.md` open item 5), and whether a technician is pushed for a job assigned outside 09:00–19:00 (open item 6 — proposed: suppress until the window opens, except `urgent`). The second is a staff-relations question as much as a technical one, and it is cheaper to answer than to retract.

**Read before starting:** `UI/plan-2/05-DISPATCHER.md` in full · `PLAN-DATA-MODEL.md` §4 (`v_job_cards_dispatcher`, `v_technician_load`) · `PLAN-BACKEND.md` §5, §6.3, §6.4, §12.1.

**The promise this phase must not break.** No dispatcher payload ever contains a `job_completions` field. The CI assertion in T2.2 is what protects it; a code-review habit is not.

---

## Task graph

```
T2.1 migration 013 ── T2.2 dispatcher reads + leak assertion ── T2.3 assign
                              │                                     │
                              ├── T2.4 customers + stack            │
                              └── T2.5 assignment push ── T2.6 client push handling
                                                              │
T2.7 dashboard ── T2.8 job logs ── T2.9 dispatch form ── T2.10 customer + profile
                                                              │
                                                        T2.11 field run
```

---

### T2.1 — Migration 013: ops views

**Reads:** `PLAN-DATA-MODEL.md` §1 (migration order), §4 (`v_job_cards_dispatcher`, `v_technician_load`), §5
**Depends on:** Phase 1
**Tier:** free until deploy

> **Serial task.** One agent owns the migration sequence.

**Build**

**`v_job_cards_dispatcher`** — an explicit **money-free projection** of `job_cards`, plus `cancellation_reason`, `is_completed`, `is_contract_visit` (the column exists from 007; the view can carry it now), and:

```sql
is_overdue AS (status NOT IN ('completed','cancelled')
               AND scheduled_date < business_date(now()))
```

**Dispatcher endpoints select from this view, never from `job_cards`.** The schema already makes revenue absent; the view makes the *query surface* one reviewable object instead of every future `SELECT`.

`is_overdue` is computed here rather than in the client so the list, the dashboard count and any future report **cannot disagree about what overdue means**. Same argument that puts technician load in a view.

The view must also carry `assigned_to_name`, joined from `employees` — the dispatcher's row shows a technician, and a client-side lookup would need a roster endpoint the matrix does not grant.

**`v_technician_load`** — `open_today`, `done_today`, `open_total`, `active_since` per **active** technician. Powers the picker's inline load. Computing it in a view rather than the UI means the dispatcher's picker and the owner's dashboard cannot disagree about who is busy.

`v_employee_tracking_health` already exists from migration 009. Nothing to add.

**Tests**

`apps/api/test/integration/views-ops.test.ts`
- **`is_overdue` against a hand-counted fixture across a date boundary in IST** — a job scheduled 14 Mar at 23:00 IST is not overdue at 15 Mar 00:30 IST if its `scheduled_date` is the 15th; construct the fixture from UTC instants so the conversion is proven
- A completed job past its date is **not** overdue
- `v_technician_load` matches a hand-counted fixture exactly
- A deactivated technician does not appear in `v_technician_load`
- **The view's column list contains no money column** — assert from `information_schema.columns`, not by reading the DDL

**Done when**
- [ ] `is_overdue` exact against a hand-counted fixture on both sides of an IST midnight
- [ ] Column-list assertion green

**If it fails**
If `is_overdue` disagrees with a hand count, the cause is nearly always comparing a `timestamptz` against `current_date` instead of comparing `scheduled_date` against `business_date(now())`. Fix it in the view, never in the client — the whole point of computing it here is that three surfaces cannot disagree about what overdue means.

**Commits**
`chore(start): T2.1 ops views` → `feat(db): migration 013 — money-free dispatcher view with is_overdue, technician load`

---

### T2.2 — Dispatcher reads and the money-leak assertion

**Reads:** `PLAN-BACKEND.md` §5 (the three rules), §6.3 · `PLAN.md` §5
**Depends on:** T2.1
**Tier:** T2 · **Flag:** `dispatch.console`

**Build**

`modules/jobs/repo.dispatcher.ts` — **a separate repository file, and that is the point.** The lint rules from T0.1 fire on this path specifically: no `job_completions`, no `service_contracts`, no `location_pings`, no `location_requests`.

`GET /v1/jobs` for a dispatcher selects from `v_job_cards_dispatcher` with filters `status[]`, `technicianId`, `customerId`, `from`, `to`, `overdue`, `q`, cursor-paginated.

**Overdue is a filter, not a state.** `?overdue=true` reads `is_overdue` from the view. Nothing advances a date automatically — an open job stays on the day it was promised for, because moving it silently hides the missed commitment the dispatcher exists to see.

Response shape is `JobCardDispatcher`, a **separate zod schema**, never a shared one with optional fields.

**The CI assertion is the deliverable.** `apps/api/test/authz/money-leak.test.ts` walks **every dispatcher-reachable endpoint**, calls it as a dispatcher against the demo fixture, and asserts that no response body — at any depth, including inside arrays — contains any of: `cost`, `discount_amount`, `discount_reason`, `amount_collected`, `collection_mode`, `payment_reference`, `contract_value`, `unit_price`, `line_total`, `declared_amount`, `confirmed_amount`, `balance`.

It walks the parsed JSON recursively by key name. A test that only checks the top level is a test that passes while a nested completion leaks.

**Tests**

`apps/api/test/authz/money-leak.test.ts` — as above. **This suite is never allowed to shrink**, and every later phase adds its new endpoints to it.

`apps/api/test/integration/jobs-dispatcher.test.ts`
- `?overdue=true` returns exactly the fixture's overdue jobs
- A dispatcher query joining `job_completions` fails the lint rule — proven by a fixture file expected to fail
- `q` searches job number, customer name and phone

**Done when**
- [ ] Money-leak assertion green across **every** dispatcher endpoint, recursing into nested objects and arrays
- [ ] Lint rule proven to fire on a `job_completions` reference in `repo.dispatcher.ts`

**If it fails**
A leak found here is a design failure, not a bug to patch at the serialiser. Find why the query reached the table at all — the answer is usually that someone reused the owner's repo.

**Commits**
`chore(start): T2.2 dispatcher reads` → `feat(api): dispatcher job reads from the view, recursive money-leak assertion`

---

### T2.3 — Assignment and bulk reassign

**Reads:** `PLAN-BACKEND.md` §6.1 (reassignment rules), §6.3 (`If-Match` on assign)
**Depends on:** T2.2
**Tier:** T2 · **Flag:** `dispatch.console` / `dispatch.bulk`

**Build**

`POST /v1/jobs/:id/assign` — `{ technicianId }`, **`If-Match: version` required.**

**`If-Match` on assign is not optional.** Three dispatchers work the same unassigned queue every morning; two of them opening the same job and picking a technician is a routine Tuesday, not a race condition worth ignoring. A lost race returns `409 VERSION_CONFLICT` **naming the current assignee** — *"Ravi was assigned this 20 seconds ago"* is actionable; "version conflict" is not.

**Reassignment is legal from `assigned` and `en_route`, refused from `in_progress`.** Redirecting someone who is driving is the dispatcher's job. Moving a card away from someone who has *started work* means the person who did the work cannot close it and the person who can was never there. Refusal is `409 ILLEGAL_TRANSITION` naming who is on site; the dispatcher's real options are to ring him or cancel with a reason.

Reassigning from `en_route` **resets the status to `assigned`** — the new technician has not set off — and emits `reassigned`.

`POST /v1/jobs/bulk-assign` — `{ jobIds[], technicianId }`, one transaction, **partial results**, per-job `If-Match`. Same rule per job, so a multi-select spanning a started job returns partial results naming it.

`GET /v1/technicians/load` — `v_technician_load` for the picker. This is also how the dispatcher gets technician *names*; `GET /v1/employees` is owner-only.

**`dispatch.bulk` is a separate flag from `dispatch.console`** deliberately — a bulk operation is the risky half of an otherwise safe feature and needs to be switchable without taking the working half down.

**Tests**

`apps/api/test/integration/assign.test.ts`
- **Two genuinely simultaneous assigns of one job**: one wins, the loser gets 409 **naming the current assignee in `details`**. Run as two concurrent clients
- Reassign from `assigned` → succeeds; from `en_route` → succeeds and status resets to `assigned`; from `in_progress` → 409 naming who is on site
- Bulk assign with one `in_progress` job in the set → partial results, the valid ones applied, the invalid one named
- Assign without `If-Match` → 428 or 400, never a silent success
- `GET /v1/technicians/load` as a dispatcher returns load and names, and **no** `job_completions` field

**Done when**
- [ ] Concurrent-assign test is genuinely concurrent and deterministic
- [ ] The 409 body names the assignee — assert on the string a user would read

**If it fails**
If the concurrent-assign test is flaky rather than deterministic, the lock is being taken after the read. `SELECT … FOR UPDATE` the job row before comparing versions. A flaky assign test is a real race in production three dispatchers will find on their first Monday.

**Commits**
`chore(start): T2.3 assignment` → `feat(api): assign and bulk reassign under If-Match, in-progress refusal`

---

### T2.4 — Customers and the product stack

**Reads:** `PLAN-BACKEND.md` §6.4 · `PLAN.md` §5 (dispatchers and `company_id`)
**Depends on:** T2.2
**Parallel with:** T2.3, T2.5
**Tier:** T2 · **Flag:** `dispatch.console`

**Build**

The nine endpoints in §6.4. Two rules carry real weight:

**Dispatchers cannot set `customers.company_id`.** It is stripped from dispatcher payloads **server-side**, not merely omitted from their form. A field a role cannot read is a field it must not be able to write — otherwise a dispatcher attaches a customer to an account he cannot see, and the first symptom is a company ledger with a site nobody put there.

**A technician's scope on the stack is `assigned`, not `all`.** He can edit the stack at a site he has or has had a job for. Widening this to `all` would let any technician rewrite any site's equipment record, and the audit trail would say it was legitimate.

**Stack changes have two doors, deliberately.** The completion payload (T1.6) is the path that matters, because it is the one actually used, and `source_job_id` makes it auditable. These standalone endpoints are the **correction case**: a wrong serial noticed the next day, a unit removed without a job. They stamp **no `source_job_id`**, and that absence is itself the signal that a change did not come from work done.

Products and services: read by everyone, written only by the owner. Small, slow-moving tables — no pagination, no search beyond a client-side filter.

**Tests**

`apps/api/test/integration/customers.test.ts`
- **A dispatcher create-customer payload carrying `company_id` has it stripped, not honoured** — assert the stored row, not the response
- Search `q` hits name and phone; the GIN index is used (assert via `EXPLAIN` that it is not a sequential scan on the fixture size)
- A technician `PATCH`es the stack at a site he has a closed job at → allowed; at a site he never had → `403 OUT_OF_SCOPE`
- A standalone stack change stamps **no** `source_job_id`
- Soft-deleting a stack item **releases the serial** for another site

**Done when**
- [ ] `company_id` stripping proven at the row, not the response
- [ ] Serial release proven by inserting the same serial at a second site after deactivation

**If it fails**
If `company_id` reaches the row, stripping is happening in the route handler rather than in the payload schema. Strip it in the zod transform for the dispatcher schema, so the field cannot survive any future handler someone adds.

**Commits**
`chore(start): T2.4 customers and stack` → `feat(api): customer CRUD with company_id stripping, standalone stack corrections`

---

### T2.5 — Assignment notifications

**Reads:** `PLAN-BACKEND.md` §12.1 · `PLAN.md` §6 · `PLAN-FRONTEND.md` §6
**Depends on:** T2.3
**Parallel with:** T2.4
**Tier:** T2 · **Flag:** `tech.notifications`

**Build**

**Not a cron row** — triggered by a mutation. On **assign, reassign, cancellation of an assigned job, and priority escalation**, send a **data-only** FCM message to the assigned technician's devices.

**The message carries no job content.** It wakes the app, which runs a delta sync and raises a **local** notification from the row it just received. A push that carried the job would be stale the moment the office changed something, and would deliver job details to a handset that may since have been logged out.

**Why this exists at all:** the client drains and syncs on reconnect, on foreground, and on a 60-second timer *while the app is active*. **None of those fire when the app is backgrounded**, so without a push a technician learns about an urgent job when he next happens to open it. For a dispatch application that is close to a defect.

**The system must remain correct with every push dropped.** Push is a latency improvement over the existing sync triggers, never the transport. A technician who receives none still gets the job on next foreground. Keeping FCM off the correctness path is what makes it safe to depend on a delivery channel nobody controls — an expired token, a dead Google project or a silenced OEM degrades timeliness rather than losing work.

**Work-window suppression** per open item 6: suppress until 09:00 unless `priority = 'urgent'`. `urgent` is the only value that overrides it, which is why the dispatch form shows priority as four explicit segments rather than a dropdown.

FCM failures (`UNREGISTERED`, `SENDER_ID_MISMATCH`) clear the stale `fcm_token` and set `failure_reason` — a device that cannot be reached is itself a tracking-health finding.

`tech.notifications` is its own flag so pushes can be turned off without touching dispatch. **The two failure modes are unrelated**: a dispatcher screen being wrong and a push spamming a technician at 22:00 need different switches, and the second is the one that will be wanted in a hurry.

**Tests**

`apps/api/test/integration/notifications.test.ts`
- Assign fires exactly one push per registered device for that technician
- Reassign fires to **both** the new and the losing technician
- A job assigned at 21:00 with `priority: 'normal'` is **suppressed**; the same at `urgent` is **sent**
- An `UNREGISTERED` response clears `devices.fcm_token` and records `failure_reason`
- **The message payload contains no customer name, address, phone or job title** — assert on the serialised FCM body

**Done when**
- [ ] Payload proven to carry no job content
- [ ] Window suppression and the urgent exception both proven

**If it fails**
If push delivery is unreliable, that is expected and not a blocker — it is why the correctness path does not depend on it. What *is* a blocker is a push that carries job content, because that ships stale data to a logged-out handset.

**Commits**
`chore(start): T2.5 assignment notifications` → `feat(api): data-only assignment pushes with work-window suppression`

---

### T2.6 — Client push handling

**Reads:** `PLAN-FRONTEND.md` §6 (assignment notifications) · `UI/plan-2/02-MOTION.md` §8
**Depends on:** T2.5, T1.16
**Tier:** **T3** — batch with any other native change this phase
**Flag:** `tech.notifications`

**Build**

The same FCM channel that will carry *Locate now* in Phase 4 carries the assignment message now. **The handler does not render the push**: it triggers a delta sync and then raises a **local** notification from the row that arrived.

**Notification permission is asked after the location ladder, not inside it** (already built in T1.16). A refusal is a degraded experience, not a broken one — and the **fourth `TrackingHealthChip` state** reports it, amber: *"Job alerts off — you won't be told about new jobs."*

That state belongs on the existing chip rather than a second one. A technician who declined the Android 13+ prompt still tracks fine — the foreground-service notification is exempt — but he stops being told about assignments, and nothing else in the app would say so. **Silent degradation is the failure mode this project treats as the enemy**, and a separate chip would be a second thing nobody looks at rather than one thing already being looked at.

**Treat every push as optional.** The app must behave identically if none ever arrive, because OEM battery management will eat some and there is nothing the client can do about it.

**Haptics: never on passive arrival of data.** A local notification is the OS's job; the app does not buzz for a sync.

**Tests**

`apps/mobile/src/notifications/handler.test.ts`
- A data-only message triggers exactly one delta sync and one local notification
- The local notification's text comes from the **synced row**, not from the push payload
- A push for a job the delta did not return raises **nothing** — no notification for content the client cannot show
- With notifications denied, the app still syncs on foreground and the chip reads amber

`apps/mobile/e2e/push-assignment.yaml`
- App backgrounded → assign from another session → local notification within 30s
- **Same, with push suppressed at the OS level → the job still arrives on next foreground.** This is the test that proves push is not the transport

**Done when**
- [ ] Both E2E paths green on a real device
- [ ] Chip's fourth state populated from `devices.notifications_enabled`

**If it fails**
T3 if the change is native. If pushes arrive but no notification appears, check the Android notification channel was created at first launch — a channel created late is silently ignored for the app's lifetime, which presents as "push works in dev, not in the build".

**Commits**
`chore(start): T2.6 push handling` → `feat(mobile): data-only push wakes a sync and raises a local notification`

---

### T2.7 — D1 Dashboard

**Reads:** `UI/plan-2/05-DISPATCHER.md` §D1 · `PLAN-FRONTEND.md` §9 (dispatcher)
**Depends on:** T2.2, T2.3, T0.13
**Tier:** T1 · **Flag:** `dispatch.console`

**Build**

Density `console`. Worst moment: 09:15 Monday, two technicians have called in, a customer on hold.

**Overdue leads**, in `feedback.danger`, **the largest figure on the screen**. It is the only number here that represents a promise already broken — unassigned work is a queue, overdue work is a customer who was told a day. Then unassigned, today, done.

**Technician load** as a live list with inline bars — the **same component as the assignment picker**, so the dispatcher reads one visual language for "who is busy" everywhere.

**A technician whose tracking is stale carries a warning inline.** The dispatcher is the person who will actually notice. This is a `location.health` read — health value and last-ping age, **no coordinates** — not `location.read` (`PLAN-BACKEND.md` §5).

**Needs attention:** overdue jobs, then unassigned, then **jobs still `assigned` past their scheduled time** — someone was due there and has not set off.

**Not** "jobs rejected from a technician's outbox". Outbox rejections live on the handset; the server keeps no queue of its own, so there is nothing for that section to read, and a section that renders empty because its data source does not exist is worse than one that was never designed.

**Empty is information.** Nothing overdue → the figure is `0` in `text.secondary`, **not hidden**.

**Offline is different here.** Full-width `feedback.danger` banner — *"No connection. This screen is not live."* — figures grey to `text.disabled`. **This is the one role where stale data is dangerous**, because dispatch decisions are made from it. The technician's screens do the opposite, and conflating the two is the mistake.

Motion: load bars draw on focus, staggered 30ms. **Figures do not count up** — a dispatcher returning here twenty times a day does not want a performance each time. They cross-fade 140ms on change.

**Not on this screen:** no revenue, no completion amounts, no cash figures.

**Tests**

`apps/mobile/src/screens/dispatcher/dashboard.test.tsx`
- Overdue renders first, largest, in danger colour
- Zero overdue renders `0`, not an absent element
- Offline renders the danger banner and dims the figures
- Figures cross-fade rather than count up on a value change
- The health warning renders from health + age and the tree contains **no latitude or longitude**

**Done when**
- [ ] Offline treatment proven opposite to the technician's
- [ ] No coordinates anywhere in the dispatcher tree

**If it fails**
If coordinates appear anywhere in the dispatcher tree, the client is calling `/v1/location/employees` rather than `/v1/location/health`. That is a permission boundary, not a convenience — fix the call, and add the endpoint to the money-leak suite's sibling check so it cannot come back.

**Commits**
`chore(start): T2.7 dispatcher dashboard` → `feat(mobile): dispatcher dashboard led by overdue, load bars, health warnings`

---

### T2.8 — D2 Job Logs

**Reads:** `UI/plan-2/05-DISPATCHER.md` §D2 · `UI/plan-2/01-FOUNDATIONS.md` §3 (console density) · `UI/plan-2/02-MOTION.md` §5.4, §9
**Depends on:** T2.7, T1.22
**Tier:** T1 · **Flag:** `dispatch.console` / `dispatch.bulk`

> **The screen where phone-first costs something.** Everything below exists to make five seconds achievable.

**Build**

**The filter bar is persistent and always visible** — sticky under the header, **never collapsing on scroll**. Three dropdown chips: date, technician, status. Each opens a **sheet of large rows**, not a native picker. **Filter state lives in the URL**, so a filtered view survives a reload and can be shared.

**Two-line rows at 56pt, not cards.** A `field`-density card list shows four jobs per screen; this shows eight, with the scannable left edge intact.

**The row itself is the tap target, at 56pt** — above the global 52. The 44pt `console` floor applies to the filter chips and header actions, each with 8pt hit slop. That distinction is what keeps the prototype gate meaningful: baseline is a 56pt row, the fallback is a 44pt row, the descope is the web build — three distinct steps.

**The left rail carries status colour**, so "what state is everything in" is available peripherally, without reading. Paired with the status word, always (`UI/plan-2/01-FOUNDATIONS.md` §1.6).

**Result count above the list, always** — *"24 jobs · 3 overdue"* — so the dispatcher knows whether the filter worked before scrolling.

**Search is a separate mode**, not a field competing with the filter bar. Full-screen, over job number, customer, phone and area, results in the same row component.

**FlashList**, `estimatedItemSize` from a measured row, `renderItem` hoisted and memoised — **no inline arrow functions.**

**Multi-select:** long-press enters selection mode — **not checkboxes**, which at this density would be a 24pt target next to a 56pt row. At the 400ms threshold: `Selection` haptic **before the finger lifts**, card scales to 0.97, border strengthens. Header cross-fades to *"3 selected"* with *Reassign* and *Cancel*.

Partial results are shown honestly: *"5 reassigned, 1 failed — JC-…0044 was completed while you were choosing."*

**Motion: filter change re-sorts without animation.** No stagger, no re-entrance. When 24 rows resolve to 6, the list simply **is** six rows — animating the transition costs 300ms of a five-second budget and tells the dispatcher nothing they did not just ask for. The only motion here is the chip fill (140ms) and the row press state (90ms).

**Offline:** danger banner, list dims, **filters disabled.** A filter applied to stale data produces a confident wrong answer.

**Tests**

`apps/mobile/src/screens/dispatcher/job-logs.test.tsx`
- Filter state round-trips through the URL and survives a remount
- Result count updates with the filter and includes the overdue sub-count
- Long-press at 400ms fires the haptic **before** release and enters selection mode
- Partial bulk failure renders the named job in the message
- Offline disables the filter chips, not just the list
- **No entrance or exit animation on filter change** — assert no animated style is attached to rows

**Done when**
- [ ] **Median under 5 seconds** on the filter task with two real dispatchers on their own handsets — re-measured on the real screen, not the prototype
- [ ] **Zero dropped frames scrolling 200 rows** on the roster's slowest handset

**If it fails**
Fall back to the 44pt row before reaching for the web descope. If that also fails, the descope is the desktop build with **+2 weeks** and the owner's sign-off, noted as a deviation from `PLAN.md` §1.

**Commits**
`chore(start): T2.8 job logs` → `feat(mobile): phone-native job logs with sticky filters and long-press multi-select`

---

### T2.9 — D3 Dispatch Job

**Reads:** `UI/plan-2/05-DISPATCHER.md` §D3 · `PLAN-BACKEND.md` §6.4
**Depends on:** T2.8, T2.4
**Tier:** T1 · **Flag:** `dispatch.console`

**Build**

**Single scroll, no wizard.** Worst moment: mid-call, customer reciting an address, needing a technician named before they hang up.

- **Customer search-or-create is one field**, not a choice between two flows. Typing searches; no match offers *+ New customer* inline
- **The unit picker reads that site's stack**, so a customer with five UPS units produces a job that names one. **Skippable** — a dispatcher taking a call may not know
- **Priority as four segments**, not a dropdown. `Urgent` is the only value that overrides notification suppression, and it is worth the dispatcher seeing that choice explicitly
- **The assignment picker is inline at the bottom**, sorted by **load ascending** so the answer is at the top, with *Leave unassigned* as an explicit last option — **never the silent default**
- **No company field.** Dispatchers have no company permission; the API strips it

`TechnicianPicker`: name, load count in mono, **inline load bar**, availability dot. Never a bare dropdown of eight names — choosing who to send is the actual decision and a name alone does not support it. Bars draw staggered 30ms, 260ms each — **the one place stagger is allowed outside the stepper**, and it earns it because the *comparison* is the decision.

Motion: selecting a customer collapses the search to one line and reveals the unit picker — 220ms, **the one progressive-disclosure moment** on this screen. Submit shows a toast carrying the number — *"JC-2627-0044 assigned to Ravi"* — because the dispatcher may need to read it back down the phone.

**Tests**

`apps/mobile/src/screens/dispatcher/dispatch.test.tsx`
- Typing searches; no result offers create inline without leaving the form
- The unit picker is populated from the selected customer's stack and is skippable
- Picker sorts by load ascending, never alphabetically
- *Leave unassigned* is an explicit option and is not preselected
- **No company field exists in the tree**
- Submit toast contains the allocated job number

**Done when**
- [ ] A job can be raised and assigned without leaving the screen
- [ ] Picker sort proven to be load-ascending

**If it fails**
If the form has grown a second step, cut a field rather than adding a page. This screen is filled mid-call and a page two is where a customer hangs up. The unit picker is the first thing to make optional, because it already is.

**Commits**
`chore(start): T2.9 dispatch form` → `feat(mobile): single-scroll dispatch form with load-aware assignment picker`

---

### T2.10 — D4 Customer, D6 Profile

**Reads:** `UI/plan-2/05-DISPATCHER.md` §D4, §D6
**Depends on:** T2.9
**Tier:** T1 · **Flag:** `dispatch.console`

**Build**

**D4 Customer.** Search over name and phone, two-line rows. Detail: name, phones (tappable to call), address, area, **the product stack read-only**, job history as `JobRow`s, notes.

**The two absences:**

- **No company field.** Not on the form, stripped server-side
- **The stack is read-only here.** Technicians own the stack because they are the ones who know what got fitted. A dispatcher editing it from a phone call is how a serial number becomes wrong

**D6 Profile.** Self only. Name, username, *Change password*, *Log out*, app version.

**No pending badge, no sync state, no tracking chip.** Dispatchers hold no device state and are not tracked; showing them a sync UI would imply an offline capability they do not have and should not rely on. **Logout is immediate** — there is nothing queued to lose.

**Tests**

`apps/mobile/src/screens/dispatcher/customer.test.tsx`
- Stack renders with no edit affordance for a dispatcher
- No company field in create or edit

`apps/mobile/src/screens/dispatcher/profile.test.tsx`
- No `PendingBadge`, no `TrackingHealthChip` in the tree
- Logout requires no confirmation and clears the session immediately

**Done when**
- [ ] Dispatcher tree proven free of sync and tracking UI

**If it fails**
Small screens; T1 republish. If the stack is editable for a dispatcher, the component is reading its own role rather than taking a prop — pass the capability down from the screen so the same component can serve the owner in Phase 4 without a second branch.

**Commits**
`chore(start): T2.10 customer and profile` → `feat(mobile): dispatcher customer screens and profile`

---

### T2.11 — Parallel run and phase exit

**Reads:** `PLAN-EXECUTION.md` Phase 2 exit
**Depends on:** all of Phase 2
**Tier:** T0 per flag

**Build** nothing. **Run it in the office and measure.**

**1 week, 1 dispatcher, then 1 week all 3.**

**Tests** — the field is the test. Collect: the filter-task timings on real handsets, push delivery latency per assignment, and every occasion a dispatcher rang a technician because the app did not tell him something.

**Done when**

- [ ] Dispatchers dispatched a **full day of real jobs** without the old process
- [ ] **Job Logs filter task: median under 5 seconds**, measured with real dispatchers on their own phones
- [ ] **Money-leak CI assertion green across every dispatcher endpoint**
- [ ] Bulk reassign used at least once on real data without a support call
- [ ] **Error states verified by pulling the office wifi mid-task** — a clear message, not a spinner
- [ ] **Assignment notifications delivered for ≥ 80% of real assignments within 60 seconds**, measured over the week — **and a technician confirms the app still worked on the day one was missed**

That last clause is the one worth insisting on. An 80% delivery rate is only acceptable because the other 20% costs latency rather than work, and the only way to know that is true is to ask someone it happened to.

**If it fails**

**This is the cheapest phase to undo.** Dispatchers hold no device state: no SQLite, no outbox. T0 flag off, or T1/T2. Recovery is minutes and the old process resumes with the job data intact in the database, which is the whole reason parallel run keeps the old process as the record of truth.

| Scenario | Tier | Action |
|---|---|---|
| A dispatcher screen is wrong | T0 | `dispatch.console` off |
| Bulk reassign misbehaving | T0 | `dispatch.bulk` off — the rest of the console stays up |
| Pushes spamming at 22:00 | T0 | `tech.notifications` off — dispatch unaffected |
| Overdue count wrong | T0 | `dispatch.overdue` off |
| API bug | T2 | previous image |

**Commits**
`chore(start): T2.11 parallel run` → `docs(ops): phase 2 exit criteria measured and recorded`
