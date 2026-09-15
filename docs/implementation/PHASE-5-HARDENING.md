# Phase 5 — Hardening

**Size M · ~4 weeks, gated by calendar not headcount · Risk: this is where you find out**

Every other phase built something. This one **measures what was built against the physical world** — the handsets staff actually carry, the sun they actually work in, and a backup that has to restore on the worst day rather than a scheduled one.

**Entry** — Phases 1–4 cut over. **All staff handsets available for at least one working day each.** That is a scheduling problem, not an engineering one, and it is why this phase is gated by calendar time.

**Read before starting:** `PLAN-EXECUTION.md` Phase 5 and Part III (risk register) · `PLAN-DATA-MODEL.md` §7 (DB role), open items 2 and 4 · `UI/plan-2/02-MOTION.md` §9.

---

## What makes this phase different

**Hardening changes are the ones most likely to break things quietly**, which makes them the most important to flag individually. Every item below ships behind its own flag and is individually revertible, and **none of them are shipped together.**

The temptation in a final phase is to batch. Resist it: a batch of five quiet changes that produces one symptom is five bisections.

---

## Task graph

```
T5.1 tracking-health sweep ─┐
T5.2 retention jobs ────────┤
T5.3 migration 014 db role ─┼── each independently flagged, shipped separately
T5.4 backup restore drill ──┤
T5.8 load sanity ───────────┘

T5.5 OEM matrix ────┐
T5.6 perf matrix ───┼── the deliverable. Gated by handset access.
T5.7 field tests ───┘

T5.9 flag cleanup   ← last, after everything is GA
```

---

### T5.1 — Tracking-health sweep and owner alerting

**Reads:** `PLAN-BACKEND.md` §12 (`tracking-health-sweep`), §13 (alerting) · `PLAN.md` §7 ("make failure loud")
**Depends on:** Phase 4
**Tier:** T2 · **Flag:** `ops.healthsweep`

**Build**

`tracking-health-sweep` — **every 15 minutes, inside the work window only.** Finds employees whose `v_employee_tracking_health` is `stale` or `permission_missing`, and pushes to the owner **at most once per employee per day.**

**This is the job that earns its place in the whole background-jobs table.** `PLAN.md` §7's *"make failure loud"* is **not satisfied by a chip nobody is looking at.** The chip is on the technician's profile and in the owner's console; neither is a screen anyone opens unprompted on a Tuesday afternoon.

The once-per-day cap is the difference between an alert and noise. A technician whose device is dead all week generates five notifications, not four hundred and eighty.

**Inside the work window only** — a device that stops reporting at 19:30 has stopped reporting because the window closed, and alerting on that is alerting on correct behaviour.

**Tests**

`apps/api/test/integration/health-sweep.test.ts`
- Alerts the owner **at most once per employee per day**, proven by running the sweep 40 times across a simulated day
- Does not alert outside 09:00–19:00 IST
- Does not alert for owner or dispatcher rows (`not_tracked`)
- **Does not alert for a deactivated employee** — he left the view in Phase 4, and this asserts it end to end
- A device that recovers mid-day does not generate a second alert

**Done when**
- [ ] Once-per-day cap proven across 40 sweep runs
- [ ] **Fired for a real stale device and the owner saw it** — the field half of this test, and the only one that counts

**If it fails**
If the sweep is noisy, the cap is wrong, not the threshold. Do not raise the 45-minute staleness threshold to reduce alert volume — that is T5.5's decision and it is made from measured jitter, not from inbox comfort.

**Commits**
`chore(start): T5.1 health sweep` → `feat(api): tracking-health sweep with once-per-day owner alerting`

---

### T5.2 — Retention jobs

**Reads:** `PLAN-BACKEND.md` §12 · `PLAN-DATA-MODEL.md` §3.8 (sizing), open item 4 · `UI/plan-2/08-SHARED-SCREENS.md` §X3 (the 180-day promise)
**Depends on:** Phase 4
**Parallel with:** T5.1, T5.3
**Tier:** T2 · **Flag:** `ops.retention`

**Build**

| Job | Cadence | Work |
|---|---|---|
| `prune-idempotency` | hourly | delete `expires_at < now()` |
| `prune-location-pings` | nightly 02:30 IST | delete `recorded_at < now() - 180 days` |
| `orphan-attachments` | weekly | rows whose `owner_id` no longer exists → **delete object then row** |
| `prune-refresh-tokens` | nightly | expired, or revoked more than 30 days ago |

**The 180-day ping retention is a promise made to staff on the consent screen**, in those words: *"Kept for 180 days, then deleted."* That makes this job a commitment rather than housekeeping, and a boundary bug here is a broken promise rather than a storage cost.

**Order matters for orphan attachments:** delete the storage object **first**, then the row. The reverse leaves an object nothing points at and nothing will ever find again.

**Attachment retention itself is still open** (`PLAN-DATA-MODEL.md` open item 4). Photos accumulate at 15 MB × 8 technicians × daily, plus a signed agreement per contract. **Measure the actual growth this phase and take the decision** rather than inheriting it into year two.

**Tests**

`apps/api/test/integration/retention.test.ts`
- **The 180-day boundary is tested at 179, 180 and 181 days.** Deletes nothing newer
- Orphan cleanup deletes the object before the row, proven by asserting no row survives a storage failure
- Idempotency prune leaves unexpired keys alone
- Token prune leaves a revoked-yesterday token alone

**Done when**
- [ ] Retention boundary tested on both sides
- [ ] **Attachment storage growth measured and a retention decision recorded** — a number, then a decision

**If it fails**
T0: `ops.retention` off. A retention job that deletes too much is unrecoverable without a restore, so **run every prune against staging with a production-shaped clone first**, and check the row count it intends to delete before letting it delete anything. A `SELECT count(*)` dry-run mode on each job is cheap and is worth having permanently.

**Commits**
`chore(start): T5.2 retention` → `feat(api): retention jobs honouring the 180-day consent promise`

---

### T5.3 — Migration 014: the dispatcher database role

**Reads:** `PLAN-DATA-MODEL.md` §7
**Depends on:** Phase 4
**Parallel with:** T5.1, T5.2
**Tier:** T2 · **Flag:** `ops.dbrole`
**Status: explicitly optional — the first thing to cut**

**Build**

```sql
CREATE ROLE servgrid_dispatcher NOLOGIN;
GRANT USAGE ON SCHEMA public TO servgrid_dispatcher;
GRANT SELECT, INSERT, UPDATE ON job_cards, customers, job_events TO servgrid_dispatcher;
GRANT SELECT ON v_job_cards_dispatcher, v_technician_load TO servgrid_dispatcher;
GRANT SELECT ON v_contract_visits_dispatcher TO servgrid_dispatcher;
GRANT SELECT ON v_employee_tracking_health TO servgrid_dispatcher;
REVOKE ALL ON job_completions, payments, sales_cards, sales_card_items,
              cash_reconciliations, service_contracts, v_company_balances,
              v_employee_expected_cash, v_contracts_expiring FROM servgrid_dispatcher;
REVOKE ALL ON location_pings, location_requests FROM servgrid_dispatcher;
```

Dispatcher requests additionally run under `SET LOCAL ROLE servgrid_dispatcher`, so **a stray join to `job_completions` fails at the database rather than leaking.**

**Worth doing because it converts the system's central privacy promise from a code-review habit into a database error.** The two location lines apply the same guarantee to a different kind of privacy: health is granted, pings are revoked outright, so a stray join that would put eight people on a desk map fails too.

**Deferred to Phase 5 because `SET LOCAL ROLE` interacts with connection pooling** and is not worth debugging while the app is still being written. That interaction is exactly what this task must prove.

**Tests**

`apps/api/test/integration/db-role.test.ts`
- **A stray `job_completions` join inside a dispatcher request errors**, and the error surfaces as a 500 with a `requestId` rather than leaking rows
- **The role does not leak across pooled connections** — run 50 interleaved dispatcher and owner requests through the same pool and assert the owner's never sees a permission denial
- `SET LOCAL` is released at transaction end, proven by the next checkout

**Done when**
- [ ] Pool interaction proven clean across 50 interleaved requests
- [ ] **Or the item is cut.** That is a legitimate outcome, and it is why this is flagged separately

**If it fails**
**Cut it.** The application-layer guarantees — separate repo files, the custom lint rules, the recursive money-leak CI assertion, per-role response schemas — already carry the promise. This is a belt over braces, and a belt that fights the connection pool is worse than no belt.

**Commits**
`chore(start): T5.3 dispatcher db role` → `feat(db): migration 014 — optional dispatcher role with revoked money and location`

---

### T5.4 — Backup restore drill

**Reads:** `PLAN-BACKEND.md` §13 · `PLAN-EXECUTION.md` Phase 5 exit
**Depends on:** Phase 4
**Parallel with:** everything
**Tier:** —

**Build** nothing. **Do the drill**, with real production data, on a normal working day.

Restore **last night's backup** into a scratch database and verify **yesterday's job count matches exactly.**

This was already done once in Phase 0 against an empty database. Doing it again here is the point: the Phase 0 drill proved the mechanism, and this one proves it against a year's shape of real data, real attachment volume and a real MinIO bucket.

**Tests**

Manual, recorded, with the numbers written down:

- Restore completes without manual intervention
- **Yesterday's job count matches exactly**
- A completion, a payment and a location trail spot-checked against production
- Attachment objects resolve from the replicated bucket

**Done when**
- [ ] **Restored into a scratch database and verified.** An untested backup is a belief, not a backup
- [ ] Restore duration recorded — this is the number that matters when it is needed for real

**If it fails**
This is the highest-consequence failure in the phase and it is not a task to defer. Stop and fix the backup path before anything else in Phase 5.

**Commits**
`chore(start): T5.4 restore drill` → `docs(ops): production restore drill verified, duration recorded`

---

### T5.5 — The OEM matrix

**Reads:** `PLAN.md` §11 (dominant risk) · `PLAN-EXECUTION.md` Phase 5, risk register · `PLAN-DATA-MODEL.md` open item 2
**Depends on:** Phase 4 cutover
**Tier:** —

> **The matrix is the deliverable, not a test of one.** `PLAN.md` §11: this cannot be simulated. **It is the one test plan that must not be compressed**, and it is why the phase is gated by calendar time.

**Build**

One row per **actual handset in the roster** — not per model in the abstract, per device someone carries:

| Handset | Android | Bg perm | Batt exempt | Autostart | 12h survival | 72h survival | Battery/day | 200-row scroll |
|---|---|---|---|---|---|---|---|---|
| *(one row per real device)* | | | | | | | | |

Each cell filled **by observation**, not by inference from another device of the same model.

**The evidence base is already collected.** `battery_pct` on every ping (`PLAN-DATA-MODEL.md` §3.8) is what makes a per-vendor investigation possible: **a trail that stops at 34% on a Xiaomi tells a different story than one that stops at 90%.** The first is battery management, the second is task-killing. `devices`' four diagnostics say which mitigations were actually completed on that handset, so a "tracking stopped" report is falsifiable.

**Tests** — the observation protocol, run per handset:

1. Full ladder completed and each step's state posted to `/v1/devices`
2. Device left overnight, unplugged, app backgrounded → **12h survival** recorded as pings received vs. expected
3. Repeated across a weekend for **72h survival**
4. `battery_pct` at first and last ping of a working day → **battery/day**
5. Job Logs 200-row scroll, dropped frames (T5.6)

Each cell is filled from what happened on that device. **A cell inferred from another device of the same model is not filled.**

**Also settle open item 2 here:** the 45-minute staleness threshold in `v_employee_tracking_health` was chosen from reasoning rather than measurement. **Revisit it against real jitter data and adjust or confirm.** It is the one constant in the schema picked without evidence, and this is the phase that has the evidence.

**Done when**
- [ ] **Every handset model in the roster has a filled matrix row**, each either passing or carrying a **documented mitigation with the staff member informed**
- [ ] Ping delivery measured per handset over a full working day
- [ ] **The 45-minute threshold revisited against measured jitter and adjusted or confirmed**

**If it fails**
Per-vendor investigation using `battery_pct` at last ping. **If tracking is unfixable on the majority of handsets after genuine mitigation effort, the Phase 1 descope is still available**: on-demand *Locate now* plus a manual "I'm on site" check-in, and continuous tracking becomes a spike.

That is a real option, not a consolation. **Jobs, completion, cash handover and the product stack are the majority of the app's value, and none of them depend on a ping every 15 minutes.** Deciding this in advance is what stopped tracking holding the other 80% hostage.

**Commits**
`chore(start): T5.5 OEM matrix` → `docs(ops): OEM matrix filled per roster handset, staleness threshold settled`

---

### T5.6 — Performance matrix

**Reads:** `UI/plan-2/02-MOTION.md` §9 (the budget) · `UI/plan-2/01-FOUNDATIONS.md` §7
**Depends on:** T5.5 (same handsets, same borrowing window)
**Tier:** —

**Build**

The last column of T5.5's matrix: **200-row Job Logs scroll, dropped frames, on the roster's slowest handset.**

It sits in that table rather than a separate performance pass because **it is the same question as the others — what this app costs the device — and the same borrowed handsets answer it.** A frame budget verified on a flagship is not verified.

Verify the hard rules held in the shipped build:

- **Reanimated worklets on the UI thread.** No animation driven from JS
- **`transform` and `opacity` only.** Never `width`, `height`, `top`, `left`, `margin`, `padding`
- **FlashList** on Job Logs, owner tables, ledgers
- **No `expo-blur` in the Android bundle. At all**
- **No shadows on list items**
- **Nothing animates off-screen**
- **No continuous animation** except the owner console's live-window pulse

**Targets:**

| Metric | Target |
|---|---|
| Tap → visible change | **< 100ms**, always |
| Frame budget | 16.6ms; **zero dropped frames** scrolling 200 job rows |
| Sheet present → interactive | < 350ms |
| Cold start → login rendered | < 2.5s |
| Skeleton visible on a warm screen | **Never** |

**Tests**

- Bundle analysis: **assert `expo-blur` is absent from the Android bundle**, and `DataTable` and the map are absent too
- Grep the shipped source for animated `width`/`height`/`margin` and for `Animated` from React Native core on any gesture- or scroll-linked path
- Frame timing captured on device for the 200-row scroll and the stepper

**Done when**
- [ ] Zero dropped frames on the slowest roster handset, recorded per device
- [ ] Blur, `DataTable` and map proven absent from the APK
- [ ] Tap-to-change under 100ms on the technician's four most-used actions

**If it fails**
A frame budget missed on one handset is a finding, not a blocker — record it in the matrix row and note which screen. A budget missed on **every** handset means a systemic rule was broken, and the list in the Build section is the checklist: JS-thread animation, a non-transform property, a missing FlashList, or a shadow that crept onto a list item.

**Commits**
`chore(start): T5.6 performance matrix` → `docs(ops): frame budget verified per handset, bundle audited`

---

### T5.7 — Field tests: sunlight, gloves, one hand

**Reads:** `UI/plan-2/01-FOUNDATIONS.md` §1.5, §7 · `PLAN-FRONTEND.md` §10
**Depends on:** Phase 4 cutover
**Parallel with:** T5.5, T5.6
**Tier:** —

**Build** nothing. **Take the app outside**, with a technician, and run the conditions the whole design was drawn for.

| Condition | Test | Pass |
|---|---|---|
| Direct sun | Read a job card, a status pill and the complete sheet at arm's length | Every element legible without shading the screen |
| Gloves | Complete a job wearing work gloves | Every target hit first time |
| One hand | Fill the complete sheet one-handed, in a vehicle | Submit reachable without a grip change |
| Low battery | The app at 14% with tracking running | No visible degradation, no extra prompts |
| 200% type | The complete sheet at maximum dynamic type | **No clipping** — this is the screen that will break |

**The two status rails that fail the 3:1 non-text floor** — `in_progress` at 1.65:1 and `en_route` at 2.72:1 — are the specific thing to look at in sunlight. The resolution was that **the rail is never the sole carrier of state, always paired with the word.** This is where that gets confirmed by someone standing in a yard rather than asserted in a document.

**Tests** — the table above *is* the test protocol. Two rules make it worth running:

- **A technician runs it, not a developer.** Someone who has used the app for weeks will unconsciously compensate for a target that is too small, and compensation is the thing being measured.
- **Failures are recorded verbatim**, in the technician's words, before anyone proposes a fix. *"I can't tell which one is in progress"* points somewhere different from *"the yellow is hard to see"*.

**Done when**
- [ ] Sunlight and glove tests **passed, or the specific failures fixed and retested**
- [ ] Complete sheet proven at 200% type with no clipping
- [ ] **A technician, not a developer, ran the glove test**

**If it fails**
A contrast failure in the field is a token change, not a "we'll note it". `UI/plan-2/01-FOUNDATIONS.md` §1.5 carries the measured figures and the floors were chosen for exactly this condition — **do not soften a floor because a screen looks harsh on a monitor.**

**Commits**
`chore(start): T5.7 field tests` → `docs(ops): sunlight, glove and one-handed tests recorded`

---

### T5.8 — Load sanity

**Reads:** `PLAN-EXECUTION.md` Phase 5
**Depends on:** Phase 4
**Parallel with:** everything
**Tier:** —

**Build** a seed script that inflates the demo fixture to a year of data — ~3,000 jobs, ~2,500 sales and payments, ~125,000 location pings, 12 months of reconciliations. It lives in `apps/api/test/fixtures/` and is reusable; every later performance question starts here.

**Tests — not load testing. Just confirm nothing is accidentally O(n²).**

14 concurrent users, a month of data. The specific things worth timing, because they are the ones that grow:

- `v_cash_reconciliation_queue` over 90 days — the `FULL OUTER JOIN` is the most expensive query in the system
- The dispatcher's Job Logs filter at 2,000 jobs
- A company ledger at 500 rows
- The technician's work read (`GET /v1/technician/work`) — it runs on every focus, foreground and push wake, and replaced delta sync late (2026-09-15), so it has the least production exposure
- A location trail for one employee for one day

**Done when**
- [ ] Every query above under 200ms at a year's data volume — the same threshold as the slow-query log
- [ ] No query plan shows a sequential scan on a table with an index that should serve it

**If it fails**
An index, not a cache. At this scale a cache would be hiding a missing index, and `PLAN-DATA-MODEL.md` §5 says anything not on the index list needs a query to justify it — **so add the query to the list along with the index.**

**Commits**
`chore(start): T5.8 load sanity` → `test(api): query timings at a year of data, plans verified`

---

### T5.9 — Flag cleanup

**Reads:** `PLAN-EXECUTION.md` Part I §3
**Depends on:** everything else in Phase 5
**Tier:** T0

**Build**

Delete every feature flag whose phase reached GA **one phase ago or more**. By the end of Phase 5 that is all of them except the four `ops.*` flags introduced here.

**Flag debt is real debt, and an unremoved flag is an untested code path.** A flag left on for a year is a branch nobody has exercised in the off position since the week it shipped, which means the rollback it exists to provide no longer works.

Delete the flag, delete the branch, delete the test that asserted the dark state.

**Tests**

- The full suite passes with every removed flag's code path gone
- `grep -r 'featureFlags\.' apps/` returns only the `ops.*` flags
- `GET /v1/auth/me` returns only the surviving flags

**Done when**
- [ ] Every phase flag removed, with its dark-state branch removed too
- [ ] No dead conditional remains behind a deleted flag

**If it fails**
If removing a flag breaks a test, the test was asserting the dark state and should be removed with it. If removing a flag breaks the *app*, the flag was load-bearing rather than a switch — which means it was never a rollback mechanism at all, and finding that out now is the point of doing this.

**Commits**
`chore(start): T5.9 flag cleanup` → `refactor: remove phase feature flags and their dark-state branches`

---

## Phase 5 exit

- [ ] **Every handset model in the roster has a filled matrix row**, each passing or carrying a documented mitigation **with the staff member informed**
- [ ] **Backup restored into a scratch database and verified**
- [ ] **Health sweep fired for a real stale device and the owner saw it**
- [ ] Sunlight and glove tests passed, or the failures fixed and retested
- [ ] **The 45-minute staleness threshold revisited against real jitter data** and adjusted or confirmed
- [ ] **Attachment storage growth measured and a retention decision taken**
- [ ] Zero dropped frames scrolling 200 rows on the slowest roster handset
- [ ] Flags cleaned up

**Rollback.** Each item shipped behind its own flag and is individually revertible. **`SET LOCAL ROLE` interacts with connection pooling and is the likeliest to misbehave** — it is also the one that is explicitly optional.

**Descope** — the DB role hardening (T5.3) is the first thing to cut. Everything else in this phase is either a risk the plan already named or a promise already made to staff.

---

## Project acceptance

The whole thing is done when, **for one full month:**

- All 14 staff use the app as the record of truth, with no parallel process
- The owner's cash reconciliation runs entirely in-app and **catches real variances**
- Company balances **match the books at month-end**
- Every roster handset holds a passing OEM matrix row
- A backup has been restored successfully at least once
- **No dispatcher has ever seen a revenue figure** — from `job_completions` or from `service_contracts` — **verifiable from the response-schema assertions in CI, not from anyone's recollection**
- AMC visits are raised, assigned and closed without anyone tracking them outside the app
- **No submitted field work has been silently lost:** not to a dropped connection, not to a shared handset, not to a refused submit, not to a scope change

That last line is the one to read again at the end. It is the promise the original offline architecture was built to keep — the online design keeps it by never discarding what someone typed until the server has it — and it is the only one on this list that cannot be recovered from after the fact.
