# Execution Plan — Phases, Tests, Exit Criteria, Rollback

The master schedule. `PLAN.md` settles *what* is being built; `PLAN-DATA-MODEL.md`, `PLAN-BACKEND.md` and `PLAN-FRONTEND.md` specify *how* each layer works. This document says **in what order, how each phase proves itself, and how each one is undone.**

Every phase below has the same five sections: **Ships · Entry · Tests · Exit · Rollback**, plus a **Descope** path — what gets cut if the phase runs into trouble, decided in advance rather than under pressure.

**Estimates assume one full-time developer.** That assumption is almost certainly wrong for your situation; correct it and the durations scale roughly linearly except Phase 5, which is gated by handset access and calendar time, not headcount.

**Amended after the gap pass.** `PLAN-GAPS.md` records twenty-one gaps found by reading the plans against each other and against the working day they describe. One of them — annual maintenance contracts — was a missing business capability rather than a missing detail, and it is now **Phase 2B**, taking the programme from ~28 to ~32 weeks. Everything else absorbed into phases that already existed. Two schedule consequences worth knowing before reading further: **FCM moved from Phase 4 to Phase 0**, and **owner password recovery is now a Phase 0 exit criterion**.

---

## Part I — Ground rules

These apply to every phase. They exist so that "roll back Phase 3" is a procedure rather than a panic.

### 1. Database migrations are forward-only

**The production rollback mechanism is not a down-migration. It is: the previous version of the API must still work against the new schema.**

Down-migrations are written and tested in CI, because they are how a developer resets a local database. They are never run against production. Every migration is therefore additive or expand/contract:

| Step | Release | Action |
|---|---|---|
| Expand | N | Add the new column/table. Nullable or defaulted. Old code ignores it. |
| Migrate | N | New code dual-writes; backfill runs. |
| Contract | N+2 at the earliest | Drop the old column, once no deployed version reads it. |

Concretely: no `DROP COLUMN`, no `NOT NULL` on an existing column, no type narrowing, and no enum value removal in the same release that stops using it. Adding an enum value is safe; removing one is a contract step.

This is why phases 1–4 add tables and never modify Phase 0's. A rollback at any point leaves orphan tables, and orphan tables cost nothing. Phase 2B's contract tables follow the same rule: a rollback past them leaves an unwritten table and an unused nullable column.

**One exception, and it is only available now.** The gap pass changed several migrations that have not yet run — `cash_reconciliations` keyed on employee rather than technician, `companies.owner_rep_id`, `job_cards.customer_product_id`, two new attachment owner types. Those are text edits to files 001–014, not expand/contract cycles, because no environment has applied them. **This exception expires the moment Phase 0 deploys**; after that every one of them would have cost a dual-write and a contract step. It is the strongest practical argument for doing a gap pass before the first migration runs rather than after.

### 2. Rollback tiers

Know which tier a change is in *before* shipping it, because the tiers differ by three orders of magnitude in recovery time.

| Tier | Mechanism | Time to recover | Applies to |
|---|---|---|---|
| **T0** | Feature flag off, server-side | seconds | any user-facing surface |
| **T1** | EAS Update — republish previous JS bundle | ~5 min + app restart | all JS/TS, styles, screens, business logic in the app |
| **T2** | Redeploy previous API container image | ~2 min | everything in `apps/api` |
| **T3** | Reinstall previous APK | **hours to days** | `app.json` plugins, permissions, Expo SDK bump, `expo-location` config, any native module |
| **T4** | Compensating data correction | manual, hours | wrong money, wrong balances |

**Two rules follow from T3 being so expensive:**

- **Never ship a native change and a risky JS change in the same build.** If both go out together and something breaks, you cannot bisect without a second sideload round.
- Native changes are batched deliberately. Target one APK per phase, plus one contingency slot.

**T4 is never a `DELETE`.** Wrong money is corrected by voiding and re-entering, so the ledger shows what happened. `PLAN-DATA-MODEL.md` §3.5 makes void the only reversal path for exactly this reason.

### 3. Feature flags

Server-driven, returned in `GET /v1/auth/me`, evaluated per employee and per role. Every phase's user-facing surface ships behind its flag:

Each flag names exactly one surface, so "turn it off" is never ambiguous:

| Flag | Guards | Phase |
|---|---|---|
| `tech.jobs` | Technician job screens and completion | 1 |
| ~~`tech.offline`~~ | ~~SQLite mirror and outbox~~ — **removed 2026-09-15** with the outbox (online-only decision) | 1 |
| `tech.location` | Background tracking task and ping ingest | 1 |
| `tech.notifications` | Assignment pushes and local notifications | 2 |
| `dispatch.console` | Dispatcher dashboard, dispatch form, Job Logs | 2 |
| `dispatch.bulk` | Multi-select bulk reassign only | 2 |
| `dispatch.overdue` | Overdue filter and dashboard count | 2 |
| `contracts.manage` | AMC tab, AMC CRUD, the dispatch form's AMC option | 2B |
| ~~`contracts.generate`~~ | ~~The nightly visit generator~~ — **removed 2026-09-15** with the generator | 2B |
| `sales.cards` | Sales cards and line items | 3 |
| `sales.payments` | Payment capture and the Pending/Collected tabs | 3 |
| `sales.cash` | The sales rep's cash handover | 3 |
| `owner.web` | The desktop rail and `DataTable` | 4 |
| `owner.location` | Location console and map | 4 |
| `owner.cash` | Reconciliation queue, confirm, dispute, reopen | 4 |
| `owner.amend` | Completion amendment | 4 |

`dispatch.bulk` is deliberately separate from the console flag beside it: it is the risky half of an otherwise safe feature and needs to be switchable without taking the working half down. (`contracts.generate` was the same shape for an unattended cron, removed with the cron on 2026-09-15.)

This buys **dark launch**: turn a phase on for one named person for a week before the role. It also makes T0 rollback possible, which is the only tier fast enough to matter during a working day.

Flags are deleted one phase after the feature reaches GA. Flag debt is real debt, and an unremoved flag is an untested code path.

### 4. Parallel run and cutover

No role is cut over on the strength of a passing test suite. Each role phase runs **alongside the existing process** — whatever the office does today — for a defined window, with a named person authorised to call it off.

| Phase | Parallel-run window | Caller |
|---|---|---|
| 1 Technician | 2 weeks, 2 technicians, then 1 week all 8 | Owner |
| 2 Dispatcher | 1 week, 1 dispatcher, then 1 week all 3 | Owner |
| 3 Sales Rep | 1 full month-end cycle | Owner |
| 4 Owner | 2 weeks | Owner |

During parallel run, the old process remains the record of truth. Cutover is a separate, announced decision.

### 5. Environments

| Env | Where | Data | Mobile channel |
|---|---|---|---|
| local | docker compose | `fixtures/demo.sql` | Expo Go / dev client |
| staging | same VPS, separate DB + bucket | `fixtures/demo.sql` only | EAS `staging` |
| production | VPS | real | EAS `production` |

**Production data is never copied to staging.** Location trails are personal data about identifiable employees under the DPDP Act, and a staging database is not a place where consent extends. Staging is seeded from the demo fixture, which `PLAN-DATA-MODEL.md` §8 already requires to contain the four awkward states.

### 6. Definition of done — every phase

A phase is not done until all of these are true. This list is the same every time, deliberately.

- [ ] CI green: lint, typecheck, unit, integration against a real Postgres (testcontainers)
- [ ] Migrations run clean on a **production-shaped clone**, not an empty database
- [ ] Previous API image verified working against the new schema (the actual rollback rehearsal, done once per phase)
- [ ] Authorization suite covers **every new endpoint × every role** — 403/404 asserted, not assumed
- [ ] Every new failure path returns the standard error envelope with a code from the shared union
- [ ] Feature flags in place and defaulted off
- [ ] Runbook entry written: how to turn it off, how to tell if it is broken
- [ ] Exit criteria **measured**, with the numbers written down — not asserted
- [ ] Open items for the phase closed or explicitly deferred with an owner

---

## Part II — The phases

### Phase 0 — Foundation

**Size: M · ~3 weeks · Risk: low, except distribution**

The only phase with a free rollback, because nothing is live yet. Use that.

**Ships**

| Layer | Deliverable |
|---|---|
| Repo | Monorepo (`apps/mobile`, `apps/api`, `packages/shared`), CI, docker compose |
| Data | Migrations 001–005: helpers, enums, identity, sync plumbing, reference data |
| Shared | Permission matrix, zod schemas, job status machine, error-code union, sequence format |
| API | Fastify skeleton, config-at-boot validation, error envelope, request context, auth (login / refresh / rotation / reuse detection / password change), **consent endpoints** (`GET /v1/consents/required`, `POST /v1/consents` — the screen ships this phase and had no endpoint behind it), **employee CRUD** — the fourteen accounts must exist before anyone can log in, and seeding them by hand into production is how a password reaches a shell history |
| App | App shell, IBM Plex font gate, design tokens, session store + secure storage, API client with refresh-on-401, login, forced password change, consent screen |
| Ops | Staging + production VPS, Postgres, MinIO, Caddy, backups configured, **EAS build producing a signed APK that installs by sideload**, CI pipeline (typecheck, lint incl. the three custom rules, nav-map/matrix cross-check, integration against testcontainers Postgres, migration up/down/up), external uptime check on `/healthz` |
| Admin | **Second owner-role account** created and handed to a trusted second person; break-glass password-reset CLI written and exercised once |
| Push | **FCM Google project confirmed and one data-only push delivered to a real handset end to end** |

**Entry** — nothing. This is the start.

**Two additions that were previously scoped later, and belong here.**

**FCM moves from Phase 4 to Phase 0.** It was budgeted for the owner's *Locate now*. Assignment notifications need it in Phase 2, so the project must exist now — and the thing to prove is not that an account exists but that a data-only message reaches a handset, since that is the step that fails. Confirming it here costs an afternoon; discovering in Phase 2 that no Google account exists costs the phase.

**The owner has no password recovery.** Accounts are owner-created, there is no email and no reset flow, and there is one owner. A second owner-role account is the real answer and costs nothing; the break-glass CLI is the answer when that is lost too. Both must be *exercised* in Phase 0, not merely written — an untested recovery path is the same class of belief as an untested backup, and this phase already refuses that one.

**Tests**

| Level | What | Gate |
|---|---|---|
| Unit | Permission matrix, table-driven across every `role × resource × action` | 100% of the matrix enumerated |
| Integration | Login, refresh rotation, **revoked-token reuse revokes the chain**, password change revokes all tokens | all pass against real Postgres |
| Migration | 001–005 up, down, up again on a clone | clean, no manual intervention |
| Config | Boot with each required env var missing in turn | fails loudly at boot, never at runtime |
| Manual | Sideload the APK on one physical Android handset, log in; log in on desktop web | both succeed |

**Exit criteria**

- [ ] An owner account logs in on a physical Android device **and** on desktop web
- [ ] Migrations rehearsed forward and backward on a clone
- [ ] `pg_dump` backup taken and **restored into a scratch database successfully** — not just scheduled
- [ ] Secrets in place: `JWT_SECRET`, S3 credentials, TLS, `FCM_SERVICE_ACCOUNT`
- [ ] APK distribution path proven end-to-end: EAS build → download link → install on a handset that has never had the app
- [ ] **A data-only FCM push delivered to that handset and handled by the app**
- [ ] **Second owner account created; break-glass reset run once against staging and the audit row verified**
- [ ] CI blocks a merge on a failing test, a lint violation of **any of the three custom rules**, a nav-map/permission-matrix disagreement, and a failing down-migration — each proven by deliberately breaking it once
- [ ] Uptime check alerts a phone when the API is stopped

**Rollback** — T2 for the API. For everything else: revert the branch and drop the database. There is no production data and no installed app. This is the last time that is true.

**Descope** — nothing here is optional. Every item is load-bearing.

**The one thing that can genuinely block** — if the signed APK will not sideload on the staff handsets (MDM restrictions, "install unknown apps" locked by an OEM, or Play Protect refusing), the distribution decision in `PLAN.md` §2 collapses and there is no budgeted fallback. **Test this in week 1, on a real staff handset, before writing anything else.** Discovering it in Phase 5 is a project-level failure.

---

### Phase 1 — Technician

**Size: XL · ~7 weeks · Risk: high**

The largest phase and the one that decides the project. Idempotency, the sync protocol and the location service are all painful to retrofit, and this is the only phase where the surface is small enough to get them right.

**Ships**

| Layer | Deliverable |
|---|---|
| Data | Migrations 006–010: `customer_products`, jobs (cards, completions, parts, cancellations, events), attachments, location **incl. `v_employee_tracking_health`**, cash |
| API | Jobs module + status machine, completion (with the discount constraint), cancellation, `job_events`, **idempotency plugin**, technician work read (built as sync bootstrap/delta/batch; replaced 2026-09-15), location ingest with work-window validation, attachments, cash handover declaration |
| App | Technician dashboard, job tabs, job detail, complete sheet, cancel sheet, cash handover, profile; online reads and intent-keyed writes (built as a SQLite mirror and outbox; removed 2026-09-15), **location task + permission ladder**, tracking health chip |
| Side quest | **Dispatcher Job Logs prototype at real volume** (see Phase 2 entry) |

**Entry** — Phase 0 exit met. At least one handset from each OEM in the staff roster physically available, **and borrowed long enough to capture the autostart walkthrough screenshots** — those cannot be written from documentation, and they block the last step of the permission ladder (`PLAN-FRONTEND.md` open item 4). Owner has answered: does a technician see amounts in his own completion history? (`PLAN-BACKEND.md` open item 2 — proposed: no.)

**Tests**

| Level | What | Gate |
|---|---|---|
| Unit | Intent writer; **idempotency key stability across retries** | key never regenerated — this is the single easiest mistake and it defeats the whole server guard |
| Integration | Status machine, every legal and illegal transition | all enumerated |
| Integration | Discount constraint: shortfall without reason rejected; warranty job (`cost 0, mode none`) accepted | both |
| Integration | `next_in_sequence` under 50 concurrent allocations | zero duplicates |
| Integration | Fiscal-year rollover creates a new sequence scope implicitly (`PLAN-DATA-MODEL.md` open item 5) | passes |
| Integration | Idempotency: replay returns identical response; differing body → 422; concurrent in-flight → 409 | all three |
| Integration | Expired access token on submit → refresh once, retry once with the same key, **nothing typed discarded** | form intact |
| Integration | Technician work read: own jobs only, contract inline, flag gate | all |
| Integration | Ping ingest: out-of-window rejected with HTTP 200; duplicate `(employee, recorded_at)` absorbed | both |
| Integration | Completion amendment: before confirm succeeds; after confirm → 409 naming the reconciliation; reopen then amend succeeds; event trail carries before and after | all four |
| Integration | Cash handover keyed on `employee_id`, unique per `(employee, date)`; `businessDate` refused in the future and beyond 7 days back | passes |
| Integration | Declaration amended while `submitted` succeeds; after `confirmed` or `disputed` → 409 | both |
| Integration | **Scope exit**: a job reassigned away from a technician is absent from his next work read | passes |
| Integration | `v_employee_tracking_health` exists after migration 009 and `GET /v1/location/health/me` returns the actor's own row and nobody else's | passes |
| E2E | **Cold start with the radio off**: stored session, expired access token → the *No connection* screen, nobody is logged out, the app resumes when signal returns | green on device |
| E2E | Completion with two photos → completion accepted, then each photo uploads with its own key; a refused completion sends no photos | green |
| Integration | Parts recorded on a completion **do not alter `cost`**; a completion with parts and one without produce identical money rows | passes |
| Unit | Complete sheet: in-warranty charge raises exactly one confirmation; discount discloses a mandatory reason | both |
| E2E (Maestro) | Airplane mode mid-sheet → *No connection* screen → reconnect → the sheet is intact and submits once | green on device |
| E2E | Submit a completion for a job the office cancelled → `JOB_ALREADY_CLOSED` sentence on the sheet, typed input retained | green |
| E2E | **Logout is immediate** — nothing is queued — and the next person to sign in on the handset sees only his own work | green on device |
| Device | Overnight background survival, ≥1 handset per OEM in the roster | recorded in the matrix |
| Soak | 72h continuous tracking, 2 devices | ping delivery + battery cost measured |
| Field | 2 technicians, 2 weeks, real jobs, parallel run | see exit criteria |

**Exit criteria** — measured over the final parallel-run week, numbers written down:

- [ ] **Ping delivery ≥ 90%** of expected in-window pings on the two field handsets
- [ ] **Submit failure rate < 2%**, excluding legitimate conflicts (office cancellations)
- [ ] **Zero duplicate job cards** attributable to replay
- [ ] **Zero completions** recorded with an unexplained shortfall — the constraint held in the field, not just in tests
- [ ] Both technicians completed a full day's jobs **without falling back to the old process**
- [ ] Basement/dead-zone recovery observed at least once in the wild: a gap that filled in on reconnect rather than staying a gap
- [ ] Health chip showed a **true red** at least once and the technician acted on it — a chip that has only ever been green is untested
- [ ] **No submitted work was silently lost** during the parallel run — every failed submit was seen and retried or recorded, including across at least one deliberate end-of-shift handset handover
- [ ] Parts were recorded on at least some real completions, and **no technician asked why the amount did not change** — if anyone did, the sheet implies a bill it does not produce

**Rollback**

| Scenario | Tier | Action |
|---|---|---|
| A technician screen is wrong | T0 | flag `tech.jobs` off for that person |
| Submits failing in the field | T0 | `tech.jobs` off for that person; the old process resumes, and nothing is stored on the phone to recover |
| Location draining battery or spamming | T0 | flag `tech.location` off; server stops accepting, device stops the task on next foreground |
| Logic bug in the app | T1 | republish previous EAS update, ~5 min |
| API bug | T2 | previous image, ~2 min |
| `expo-location` config wrong | **T3** | new APK, staff must reinstall — batch it, do not ship it alone at 5pm on a Friday |
| Bad completion data | T4 | job data is append-only via `job_events`; correct by a compensating record, never an `UPDATE` that erases history |

Phase 1's tables are additive. A full rollback to Phase 0 leaves them in place, unwritten. Technician work already captured survives, and the office can export it to CSV.

**Descope — decided now, not later**

If OEM background-killing makes tracking unusable on the majority of staff handsets after genuine mitigation effort: **ship the technician app without continuous background tracking.** Keep on-demand *Locate now*, add a manual "I'm on site" check-in on the job detail screen, and move continuous tracking to a Phase 5 spike.

This is a real option, not a consolation. Jobs, completion, cash handover and the product stack are the majority of the app's value, and none of them depend on a ping every 15 minutes. Deciding this in advance stops tracking from holding the other 80% hostage.

---

### Phase 2 — Dispatcher

**Size: M · ~4 weeks · Risk: medium, concentrated in one screen**

**Ships**

| Layer | Deliverable |
|---|---|
| Data | Migration 013 (ops views): `v_job_cards_dispatcher` including `is_overdue`, `v_technician_load`. `v_employee_tracking_health` already exists from 009 |
| API | Dispatcher job queries **against the view, never the table**; assign and bulk reassign **under `If-Match`**; customer CRUD with `company_id` stripped; **assignment push notifications** |
| App | Dispatcher dashboard led by the overdue count, Dispatch Job form, **Job Logs** with an Overdue filter, `TechnicianPicker` with inline load, customer screens; online-only with explicit error states; technician-side push handling and local notifications |

**Entry — two hard gates.**

1. The Job Logs prototype from Phase 1 must have passed its test: **a dispatcher answers "who has the Kormangala jobs today" in under 5 seconds, on a phone, against 200+ jobs.** If it did not pass, take the descope path below *before* the phase starts.
2. **FCM proven end to end in Phase 0.** Assignment notifications are the reason this moved forward two phases; without the channel, a dispatcher can assign urgent work that the technician will not see until he next opens the app.

Also decided before starting: what the local notification says when work is *taken away* by a reassign (`PLAN-BACKEND.md` open item 5), and whether a technician is pushed for a job assigned outside the 09:00–19:00 window (open item 6 — proposed: suppress until the window opens, except urgent). The second is a staff-relations question as much as a technical one, and it is cheaper to answer than to retract.

**Tests**

| Level | What | Gate |
|---|---|---|
| **CI assertion** | **No dispatcher response payload contains any `job_completions` field.** Automated over every dispatcher endpoint, response-schema level | zero — this is the suite that protects the central privacy promise |
| Static | Lint rule: `job_completions` unreferenced in `modules/jobs/repo.dispatcher.ts` | passes |
| Integration | Every dispatcher endpoint as every role — 403/404 | full matrix |
| Integration | Bulk reassign with one invalid job in the set → partial results, valid ones applied | passes |
| Integration | Reassign from `assigned` and from `en_route` succeed (status resets to `assigned`); from `in_progress` → 409 naming who is on site | all three |
| Integration | A dispatcher payload carries tracking **health** and last-ping age but **no coordinates**, for every dispatcher endpoint | zero coordinates |
| Integration | **Two simultaneous assigns of one job** — one wins, the loser gets 409 naming the current assignee | deterministic |
| Integration | A dispatcher create-customer payload carrying `company_id` has it stripped, not honoured | passes |
| Integration | `v_technician_load` matches a hand-counted fixture | exact |
| Integration | `is_overdue` matches a hand-counted fixture across a date boundary in IST | exact |
| E2E | Assign a job while the technician's app is **backgrounded** → push wakes it → local notification within 30s | green on device |
| E2E | Same, with push suppressed at the OS level → job still arrives on next foreground | green — proves push is not the transport |
| Usability | 2 real dispatchers, 200+ jobs, timed tasks on a phone | median < 5s for the filter task |
| Field | 1 dispatcher, 1 week, then all 3, 1 week | see exit |

**Exit criteria**

- [ ] Dispatchers dispatched a **full day of real jobs** without the old process
- [ ] Job Logs filter task: **median under 5 seconds**, measured with real dispatchers on their own phones
- [ ] Money-leak CI assertion green across every dispatcher endpoint
- [ ] Bulk reassign used at least once on real data without a support call
- [ ] Error states verified by pulling the office wifi mid-task — a clear message, not a spinner
- [ ] **Assignment notifications delivered for ≥ 80% of real assignments within 60 seconds**, measured over the parallel-run week — and a technician confirms the app still worked on the day one was missed

**Rollback** — the cheapest phase to undo. Dispatchers hold no device state — since 2026-09-15 no role does. T0 flag off, or T1/T2. Recovery is minutes and the old process resumes with the job data intact in the database.

Notifications get their own flag (`tech.notifications`) so they can be turned off without touching dispatch. That separation matters because the two failure modes are unrelated: a dispatcher screen being wrong and a push spamming a technician at 22:00 need different switches, and the second is the one that will be wanted in a hurry.

**Descope** — if Job Logs fails the 5-second test on a phone, **give dispatchers the desktop web build instead.**

`PLAN.md` §1 says dispatchers are Android-only, but it also says they sit at a desk on office wifi — which is exactly the condition under which a browser is the better surface. The cost is sequencing: the web shell is Phase 4 work, so taking this path means pulling the `NavShell` rail and `DataTable` forward by two phases. Budget **+2 weeks** and note it as a deviation from `PLAN.md` §1 requiring the owner's sign-off.

The fallback *within* phone-first, if the deviation is refused: a compact two-line row at 44px with the filter bar pinned, accepting a smaller tap target on this one screen because a dispatcher is seated and not wearing gloves.

---

### Phase 2B — AMC contracts

**Size: M · ~3 weeks · Risk: low technically, medium commercially**

Rebuilt on 2026-09-15 from the owner's description (`docs/decisions/2026-09-15-amc-contracts.md`). The dispatcher records a site's 12-month AMC with its price; AMC work is dispatched by hand through a ticked AMC option; the app reminds four months after the site's last completed job and seven days before the AMC ends. Task detail: `implementation/PHASE-2B-CONTRACTS.md`.

**Ships**

| Layer | Deliverable |
|---|---|
| Data | Migration 015: `service_contracts` (no overlapping AMCs per site), `job_cards.contract_id`, `v_contracts` |
| API | AMC CRUD and cancel, due and ending lists, **`POST /v1/jobs`** with the AMC link |
| App | Dispatcher **AMC** tab, AMC form, the dispatch form's AMC option; technician chip and Free/Charge; owner AMC screens |

**Entry** — Phase ON merged.

**Tests**

| Level | What | Gate |
|---|---|---|
| Integration | Overlapping AMCs at one site refused, naming the existing one; a renewal starting the day after the old end accepted; overlap with a cancelled AMC accepted | all three |
| Integration | Due list: a site four months past its last completed job (any job) appears; one with an open job does not | both |
| Integration | Ending list at 7 days, not 8 | exact |
| Integration | `POST /v1/jobs` links only an AMC of the same customer that covers the job's day | passes |
| Integration | Cancel-with-date on an AMC job → successor linked to the same AMC | passes |
| **CI assertion** | No dispatcher payload contains a completion figure; no technician payload contains `contract_value` | zero |
| Unit | AMC job complete sheet opens on Free with no amount field; Charge brings it back | both |
| Field | Every live AMC recorded; two weeks of reminders | see exit |

**Exit criteria**

- [ ] Every live AMC recorded by a dispatcher with its price, none overlapping
- [ ] The due list matched the office's own sense of who was due
- [ ] A reminder dispatched straight from the AMC tab with the option ticked
- [ ] An AMC job completed free and another charged, both agreed by the office
- [ ] An AMC renewed from the ending-soon list, starting the day after the old end

**Rollback**

| Scenario | Tier | Action |
|---|---|---|
| AMC screens or reminders wrong | T0 | `contracts.manage` off — linked jobs remain ordinary jobs |
| Job create wrong | T0 | `dispatch.console` off |
| API bug | T2 | previous image |
| A wrong AMC recorded | — | cancel it with a reason, record it again |

**That property is worth protecting**: the first change that gives AMC jobs special handling beyond the chip, the dispatch option and Free/Charge is the change that makes this rollback expensive.

---

### Phase 3 — Sales Rep

**Size: M · ~4 weeks · Risk: medium — it is money**

**Ships**

| Layer | Deliverable |
|---|---|
| Data | Migrations 017–018 (renumbered from 011–012; see `PLAN-DATA-MODEL.md` §1): `sales_cards`, `sales_card_items`, `payments`, money views including the payments side of `v_employee_expected_cash` |
| API | Companies **with rep ownership**, owner-only ownership reassignment, sales cards + items, payments, `v_company_balances`, company ledger |
| App | Sales dashboard, sales cards with line items, Pending/Collected payment tabs, proof photo, company list + ledger, **rep cash handover** |

**Entry** — Phase 1 exit met. Decisions taken:

1. Do parts consumed on a job need modelling? (`PLAN-DATA-MODEL.md` open item 1) — should already be answered at Phase 2B entry; confirm it did not change.
2. **Is stock/inventory genuinely out of scope?** (`PLAN-DATA-MODEL.md` open item 3) Sales snapshot prices but decrement nothing. If the owner expects stock levels, that is a new module, not a column — and this is the last phase where it can be added without reworking the sales model.
3. ~~Does any sales operation need a multi-parent `dependsOn` in the outbox?~~ Moot since 2026-09-15: a payment posts, then its proof photo uploads against the returned id.
4. **Which companies belong to which rep, as a starting allocation.** Account ownership is now a column, and the reps have to agree on the split before the phase goes live. House accounts — `owner_rep_id` NULL — are the answer for anything genuinely shared, and are also how leave gets covered.

**Tests**

| Level | What | Gate |
|---|---|---|
| Property | For random sequences of confirm/void/pay/void-payment, `v_company_balances.balance` always equals `Σ confirmed sales − Σ collected payments` | 1000 generated sequences, zero violations |
| Integration | Draft sale burns no `sale_number` — the column is NULL and the partial `CHECK` enforces it; number allocated at **confirm** | passes |
| Integration | Void requires a reason; voided sale leaves the balance correct | passes |
| Integration | On-account payment (`sales_card_id` NULL) lands on the company balance | passes |
| Integration | Overpayment produces a negative balance and the UI renders it | passes |
| ~~Regression~~ | ~~The Phase 1 outbox test suite passes unchanged~~ — retired with the outbox (2026-09-15); the intent-writer tests cover every rep write | — |
| Integration | A rep sees his accounts plus house accounts, and **not** the other rep's — every company endpoint, both reps | full matrix |
| Integration | A rep cannot reassign an account, his own or anyone's; the owner can, including to NULL | passes |
| Integration | A cash payment recorded by a rep appears in `v_employee_expected_cash` for **that rep's** day | passes |
| Integration | Duplicate company → `DUPLICATE_ENTITY` with the existing row named, shown on the form | passes |
| E2E | Record a payment with a proof photo → the payment is accepted, then the photo uploads against it; a dropped connection keeps the form and retries with the same key | green |
| Field | 1 full month-end cycle | see exit |

**Exit criteria**

- [ ] Month-end balances match the owner's manual figures **to the rupee**, across every company
- [ ] **No rep submit was silently lost** — every failed sale or payment was seen and retried or recorded. (Replaces "the outbox required zero modification", superseded 2026-09-15.)
- [ ] Both reps recorded a full month of sales and collections in-app
- [ ] At least one void exercised on real data, balance verified afterwards
- [ ] Neither rep saw the other's accounts, and neither reported the split getting in their way — if it did, house accounts are the release valve, not a code change
- [ ] **If any cash was collected by a rep, it appeared in the owner's reconciliation queue.** If none was, record that — a path with no traffic is untested, not proven

**Rollback** — T0/T1/T2 as usual. **T4 is the live risk here.** Wrong financial data is corrected by voiding and re-entering, never by `DELETE` or `UPDATE`, so the ledger keeps a record of the correction. Before cutover, confirm the owner understands that void-and-reenter is the correction path — it is the one place where the system deliberately refuses to let a mistake vanish.

Sales tables are additive; a rollback to Phase 2 leaves them unwritten.

**Descope** — ~~if the outbox does not generalise cleanly, ship sales reps online-only~~. Taken for every role on 2026-09-15 (`docs/decisions/2026-09-15-online-only.md`).

---

### Phase 4 — Owner

**Size: L · ~6 weeks · Risk: medium — two layouts and a fork in the road**

**Ships**

| Layer | Deliverable |
|---|---|
| Data | No new migration. `v_cash_reconciliation_queue` shipped with 018 in Phase 3 and `v_employee_tracking_health` with 009 in Phase 1 — this phase builds the **screens and endpoints** over views that already exist |
| API | Cash queue + confirm/dispute/**reopen**, **completion amendment**, location console queries, on-demand FCM requests, employee admin **with deactivation preconditions**, dashboards |
| App | Android five-group nav; **desktop left rail**; `DataTable`; location console with map; cash reconciliation queue (expected / declared / variance / flag, **no expenses column**); amend-completion flow |

**Entry — one blocking item, one already cleared:**

1. ~~**Map tile source decided**~~ — **cleared 2026-09-15**: hosted OpenStreetMap tiles from MapTiler (`PLAN-FRONTEND.md` open item 2, TON.8).
2. FCM was the second blocker here. It is now proven in Phase 0 and in production use since Phase 2, so *Locate now* inherits a channel that has been carrying assignment notifications for two phases. That is a straightforward gain from moving it early: the riskiest part of on-demand location is no longer new.

And one assessment, made at phase start, not mid-phase: **does React Native Web carry the `DataTable` and rail acceptably?** Spike it in the first three days. If not, fork a thin React web app sharing `packages/shared` and budget **+2 weeks** (`PLAN-FRONTEND.md` open item 5). Deciding this on day 3 is cheap; discovering it in week 4 is not.

**Tests**

| Level | What | Gate |
|---|---|---|
| SQL fixture | `v_cash_reconciliation_queue` emits `missing_submission` for a technician-day with cash collected and no declaration | **the row the whole feature exists for** |
| SQL fixture | The other three flags: `no_expected_cash`, `variance`, `match` | all four |
| SQL fixture | A rep-day with a cash payment and no declaration also flags `missing_submission` | the payments side is exercised, not just completions |
| Integration | Reassigned job's cash attributes to `completed_by`, not `assigned_to` | passes |
| Integration | Deactivating an employee with open jobs → 409 listing them; after reassignment → succeeds, tokens revoked, devices inactive, out of the health view | all |
| Integration | Deactivation refused while he holds an unconfirmed or disputed cash reconciliation; a **role change** refused under the same conditions | both |
| SQL fixture | The queue's default range ends **yesterday**; today is reachable and captioned as still syncing | passes |
| Integration | Amend after confirm → 409; reopen → amend succeeds; queue reflects the new figure | full cycle |
| Integration | *Locate now* end-to-end on a real handset, including the **unanswered** path | both paths |
| Integration | Stale FCM token → `UNREGISTERED` → token cleared, `failure_reason` set | passes |
| Visual | Screenshots at 360dp, 412dp, 1280px, 1920px | **card on phone, row on desktop** verified on every owner screen |
| Review | The card-vs-row rule, checked per screen | explicit checkpoint, not a preference |
| Field | Owner, 2 weeks | see exit |

**Exit criteria**

- [ ] Owner ran a **full week of cash reconciliation entirely in-app** and **caught at least one real variance or missing submission**. If the queue never flagged anything in a week, either the business is unusually tidy or the view is wrong — investigate before believing it
- [ ] *Locate now* succeeds **within 60 seconds on ≥80%** of attempts across the roster handsets, and the failures show "device has not answered" rather than spinning
- [ ] No owner screen renders a card grid on desktop
- [ ] Owner completed one employee admin task (create, deactivate, password reset) unaided
- [ ] Web and Android show the same figures for the same day — checked by hand once, deliberately
- [ ] **The owner amended at least one completion**, with the reason recorded, and the reconciliation queue reflected it. Before this phase there was no way to correct a mistyped amount at all
- [ ] The dashboard shows the four defined stats and two charts, and the owner can say what each one means without being told

**Rollback** — web is a separate bundle and rolls back independently of the APK, which makes it the safest surface in the project. Map and tiles behind `owner.location`; cash queue behind `owner.cash`. T0 for each.

**Descope** — cut in this order: (1) owner dashboards reduce to counts, no charts; (2) location console reduces to a roster list with last-seen and no map — this still delivers the health signal, which is the part that matters; (3) employee admin moves to direct SQL by the developer for a few weeks. The cash queue is **not** descopable; it is the reason the phase exists.

---

### Phase 5 — Hardening

**Size: M · ~4 weeks, gated by calendar not headcount · Risk: this is where you find out**

**Ships**

| Layer | Deliverable |
|---|---|
| API | Tracking-health sweep + owner alerting, retention jobs (pings 180d, idempotency keys, orphan attachments, refresh tokens) |
| Data | Migration 014: optional `servgrid_dispatcher` DB role |
| Ops | Backup restore drill, load sanity, monitoring dashboards |
| Field | **OEM matrix testing on the exact handsets staff carry**; sunlight legibility; gloved tap accuracy |

**Entry** — Phases 1–4 cut over. All staff handsets available for at least one working day each.

**Tests**

The OEM matrix is the deliverable, not a test of one. A table of `manufacturer × OS version × mitigation state`, one row per **actual handset in the roster**, each filled by observation:

| Handset | Android | Bg perm | Batt exempt | Autostart | 12h survival | 72h survival | Battery/day | **200-row scroll** |
|---|---|---|---|---|---|---|---|---|
| *(one row per real device)* | | | | | | | | |

The last column is dropped frames scrolling 200 Job Logs rows (`UI/plan-2/02-MOTION.md` §9). It sits in this table rather than in a separate performance pass because it is the same question as the others — what this app costs the device — and the same borrowed handsets answer it. A frame budget verified on a flagship is not verified.

`PLAN.md` §11: this cannot be simulated. It is the one test plan that must not be compressed, and it is why this phase is gated by calendar time.

| Level | What | Gate |
|---|---|---|
| Drill | Restore last night's backup into a scratch DB and verify yesterday's job count | **matches exactly** |
| Integration | Health sweep alerts the owner at most once per employee per day | passes |
| Integration | Retention job deletes pings older than 180 days and nothing newer | boundary tested |
| Integration | `SET LOCAL ROLE servgrid_dispatcher` + connection pooling — a stray `job_completions` join errors | passes, or the item is cut |
| Load sanity | 14 concurrent users, a month of data | not load testing; just confirm nothing is accidentally O(n²) |
| Field | Sunlight legibility; 52px targets with work gloves; one-handed complete sheet in a vehicle | pass/fail per item, by a technician |

**Exit criteria**

- [ ] **Every handset model in the roster has a filled matrix row**, each either passing or carrying a documented mitigation with the staff member informed
- [ ] Backup restored into a scratch database and verified — an untested backup is a belief, not a backup
- [ ] Health sweep fired for a **real** stale device and the owner saw it
- [ ] Sunlight and glove tests passed, or the specific failures fixed and retested
- [ ] The 45-minute staleness threshold revisited against real jitter data and adjusted or confirmed (`PLAN-DATA-MODEL.md` open item 2)
- [ ] Attachment storage growth measured and a retention decision taken (`PLAN-DATA-MODEL.md` open item 4)

**Rollback** — hardening changes are the ones most likely to break things *quietly*, which makes them the most important to flag individually. `SET LOCAL ROLE` interacts with connection pooling and is the likeliest to misbehave. Each item ships behind its own flag and is individually revertible; none of them are shipped together.

**Descope** — the DB role hardening (migration 014) is explicitly optional and is the first thing to cut. Everything else in this phase is either a risk the plan already named or a promise already made to staff.

---

## Part III — Gates and risks

### Go/no-go summary

| Gate | Before | Blocking condition |
|---|---|---|
| **APK sideloads on a real staff handset** | Phase 0 week 2 | No fallback exists in `PLAN.md`. Project-level risk. |
| **FCM push delivered end to end** | **Phase 0 exit** | Moved forward two phases. Blocks assignment notifications in Phase 2, and *Locate now* in Phase 4 |
| Second owner account + break-glass reset exercised | Phase 0 exit | Otherwise a forgotten owner password is unrecoverable |
| Restore-from-backup verified | Phase 0 exit | |
| Job Logs 5-second test | **Phase 2 start** | Fails → take the web deviation, +2 weeks, owner sign-off |
| Tracking viable on majority handsets | Phase 1 exit | Fails → descope to on-demand + manual check-in |
| Contract shape | **Phase 2B start** | **Cleared 2026-09-15** — AMCs per site, dispatcher-recorded, reminders by time since the last job |
| Rep account allocation agreed | Phase 3 start | Ownership is a column; the split is a business decision |
| ~~Outbox generalises unchanged~~ | — | Moot: every role online since 2026-09-15 |
| Map tile source decided | Phase 4 start | **Cleared 2026-09-15** — MapTiler |
| RNW carries DataTable + rail | Phase 4 day 3 | Fails → fork thin React web, +2 weeks |
| Full OEM matrix filled | Phase 5 exit | |

### Risk register

Each risk has a **trigger** — the observable that says it has arrived — because a risk without a trigger is just a worry.

| Risk | Trigger | Action |
|---|---|---|
| **OEM background-task killing** (`PLAN.md` §11, dominant) | Ping delivery < 90% on any roster handset after all four mitigation steps | Per-vendor investigation using `battery_pct` at last ping; if unfixable on the majority, Phase 1 descope |
| **Dispatcher Job Logs on a phone** (`PLAN.md` §11) | Median filter task > 5s in the Phase 1 prototype | Phase 2 descope to web, +2 weeks |
| **Employee reaction to tracking** (`PLAN.md` §11) | Any technician disables permissions or raises it | Not a technical fix. Consent screen, visible notification and the fixed 09:00–19:00 window are the mitigations; the conversation is the owner's |
| APK distribution blocked | Sideload fails on a staff handset | **Stop and re-plan distribution.** No budgeted fallback |
| RNW fights the desktop layout | Spike inconclusive by Phase 4 day 3 | Fork thin React web, +2 weeks |
| Money figures disagree with the owner's books | Any mismatch at Phase 3 month-end | Do not cut over. The property test passing while reality disagrees means the model is wrong, not the code |
| Photo storage growth | Bucket > 50 GB | Retention policy, downscale more aggressively |
| Single-VPS failure | Any unplanned outage | Documented restore path; accepted risk at 14 users, revisit if it happens twice |
| **Contract scope was larger than the plan knew** | A second business capability turns out to be missing during Phase 2B | The AMC gap was found by reading the plans against the working day, not against each other. If one such gap existed, a second may. Re-run that reading before Phase 3 rather than after |
| Notification fatigue | Any technician silences the app, or asks to | The window rule and the urgent-only exception are the mitigations. A silenced app still refetches on foreground, so the failure is soft — but it is invisible, which is the pattern this project treats as the enemy |
| AMC jobs acquire special handling | Any code path branches on "is this an AMC job" beyond the chip, the dispatch option and the Free/Charge choice | Push back in review. The T0 rollback for Phase 2B depends on an AMC job being an ordinary job |

### Timeline

| Phase | Size | Est. | Cumulative |
|---|---|---|---|
| 0 Foundation | M | 3 wks | 3 |
| 1 Technician | XL | 7 wks | 10 |
| 2 Dispatcher | M | 4 wks | 14 |
| **2B Contracts** | **M** | **4 wks** | **18** |
| 3 Sales Rep | M | 4 wks | 22 |
| 4 Owner | L | 6 wks | 28 |
| 5 Hardening | M | 4 wks | 32 |

**~32 weeks / ~8 months for one full-time developer**, excluding parallel-run windows that overlap the following phase's build. Contingency for the two +2-week descope branches is **not** included; if both fire, add a month.

**The four added weeks are Phase 2B and nothing else.** Every other amendment from `PLAN-GAPS.md` — assignment notifications, completion amendment, the logout gate, rep cash handover, account ownership, warranty and unit links, the CI pipeline — absorbs into phases that were already scheduled, because each is a small addition to work already planned rather than new work. Contracts cost a phase because they are a part of the business the plan did not know about, not because the plan was built wrong.

Phase 2B was rebuilt smaller on 2026-09-15 (no generator, ~3 weeks), so the realistic range is **30–31 weeks** before the other contingencies.

### Project acceptance

The whole thing is done when, for one full month:

- All 14 staff use the app as the record of truth, with no parallel process
- The owner's cash reconciliation runs entirely in-app and catches real variances
- Company balances match the books at month-end
- Every roster handset holds a passing OEM matrix row
- A backup has been restored successfully at least once
- No dispatcher has ever seen a job revenue figure — **from `job_completions`**; the AMC price is his by decision (2026-09-15) — verifiable from the response-schema assertions in CI, not from anyone's recollection
- AMC visits are raised, assigned and closed without anyone tracking them outside the app
- No submitted field work has been silently lost: not to a dropped connection, not to a shared handset, not to a refused submit

---

## Open items

| # | Item | Impact | Needed by |
|---|---|---|---|
| 1 | Developer capacity is assumed to be one full-time person. Every estimate scales off that. | **All timelines** | Now |
| 2 | What the office does *today* is not documented, so "parallel run" and every rollback's human fallback are specified abstractly | High — a rollback plan that cannot name the fallback process is incomplete | Before Phase 1 cutover |
| 3 | Who besides the owner can authorise a rollback or call off a parallel run, if the owner is unreachable | Medium | Before Phase 1 cutover |
| 4 | Staff training and handover is not scoped as work anywhere. 14 people learning a new process is real effort. | Medium — probably 1 week spread across phases 1–4 | Before Phase 1 cutover |
| 5 | No staging handset budget. OEM matrix testing needs devices for a working day each, which means borrowing from working staff. | Medium — schedules Phase 5 | Before Phase 5 |
| 6 | ~~Phase 2B's commercial questions.~~ **Re-answered by the owner, 2026-09-15** (`docs/decisions/2026-09-15-amc-contracts.md`): one site one AMC at a time; dispatcher-recorded with price; no visit count; reminder four months after the last completed job; parts recorded, stock not tracked. | — | Done |
| 7 | ~~Whether technicians spend from collected cash.~~ **Closed: they do not.** Expense columns removed. | — | Done |
| 8 | The English-only decision deserves one confirmation with an actual technician rather than in the abstract. Cost of being wrong is every screen. | Medium if wrong | Before Phase 1 |
| 9 | Stock/inventory remains out of scope by decision, not by omission. Parts are now recorded per completion, which is the data an inventory model would need — so if the owner ever wants stock levels, the hard part is already being captured. | Medium if it changes | Revisit after a year of parts data |
