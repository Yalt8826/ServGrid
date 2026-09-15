# Implementation Plan — Protocol and Index

Eight files. This one carries the rules that apply to every task; the other seven are the phases.

**Who this is for.** Agents building ServGrid, one task at a time, possibly several in parallel. Every task is written so it can be picked up cold: it names the documents to read, the files to create, the tests to write, the criteria that decide whether it worked, and what to do when it did not.

**What this is not.** It is not a restatement of the design. `PLAN.md` and its four companions are the specification and they are not duplicated here — a task says *read `PLAN-DATA-MODEL.md` §3.4* rather than paraphrasing §3.4, because a paraphrase is a second source of truth that will drift. Where this plan states something the plan docs do not, it is an implementation decision and it is marked **[impl]**.

---

## 1. The documents

| Document | Carries | You read it when |
|---|---|---|
| `../PLAN.md` | The settled design. Roles, platform, permissions, scope decisions | Always, once, before Phase 0 |
| `../PLAN-DATA-MODEL.md` | Every table, constraint, view, index, migration order | Any task touching the schema |
| `../PLAN-BACKEND.md` | Modules, endpoints, plugins, sync protocol, background jobs | Any task in `apps/api` |
| `../PLAN-FRONTEND.md` | Routes, state layers, outbox, location client, components | Any task in `apps/mobile` |
| `../PLAN-EXECUTION.md` | Phase gates, exit criteria, rollback tiers, feature flags, risks | Phase start and phase end |
| `../PLAN-GAPS.md` | Why things are the way they are. Two gap passes, 47 resolutions | When a decision looks arbitrary |
| `../UI/plan-2/` | Design philosophy, tokens, motion, components, every screen | Any task rendering pixels |
| `../UI/COMPARISON.md` | Independent audit of the UI set, and what was adopted | Rarely. Contrast arguments |

**`UI/plan-1/` is superseded.** It is kept for the record. Build from `plan-2`.

---

## 2. Task anatomy

Every task in every phase file has the same eight parts. Nothing is optional.

```
### T<phase>.<n> — <name>

**Reads**            the doc sections that carry the reasoning
**Depends on**       task ids that must be merged first
**Parallel with**    task ids that touch no shared file
**Flag**             the feature flag this ships behind, or —
**Tier**             rollback tier (§4)

**Build**            files to create, and what goes in them
**Tests**            test file paths and the assertions they make
**Done when**        measurable criteria, checkbox form
**If it fails**      the specific recovery, not "revert"
```

**"Done when" is measured, never asserted.** A checkbox is ticked because a command was run and its output was read. `PLAN-EXECUTION.md` Part I §6 makes this a phase rule; here it is a task rule, because a phase whose tasks were each "probably fine" fails at the phase gate with no way to bisect.

---

## 3. Git protocol

**Branch per task.** `git checkout -b t/<task-id>-<slug>` off `main`. Example: `t/1.14-outbox-drain`.

**Two commits minimum per task, and the first is empty.**

```bash
# before any work
git commit --allow-empty -m "chore(start): T1.14 outbox drain manager"

# ... build, test ...

git add -A
git commit -m "feat(mobile): outbox drain with two transports

JSON operations batch to /v1/sync/batch; attachments upload
individually to /v1/attachments after their parent resolves.
Idempotency keys generated once at enqueue and reused across
every retry.

Task: T1.14
Refs: PLAN-FRONTEND.md §5, PLAN-BACKEND.md §7"
```

**Why the empty commit.** It stamps a known-good SHA at the exact moment the task started, so `git reset --hard <start-sha>` is a mechanical recovery rather than a judgement call about which files to unpick. It costs one line and turns "If it fails" into a command. Grep for them with `git log --grep='^chore(start)'`.

**The trap: `--allow-empty` does not mean "make an empty commit".** It *permits* one. If anything is staged, the marker silently swallows the whole task — you get one commit whose subject says "start" and whose diff is the entire task, and no rollback point at all.

**It happened seven times in Phase 0**, which makes it the most repeated mistake in the project so far. Three were caught while still local and split (T0.12, T0.13, T0.16). Four were already pushed by the time they were found, and rewriting published history costs more than it buys — so they stay, and their pre-task SHA is the marker's **parent**:

| Task | Marker | Roll back to |
|---|---|---|
| T0.2 database and migration runner | `068990e` | `fe035b0` |
| T0.5 `packages/shared` | `cfb6841` | `796995e` |
| T0.11 app shell | `eb0724a` | `21f6a12` |
| T0.15 distribution and push | `17da723` | `e28719b` |

Make the marker **before** you stage anything, and prove it landed empty:

```bash
git status --porcelain          # must be empty
git commit --allow-empty -m "chore(start): T1.14 outbox drain manager"
git show --stat HEAD | grep -c '|'   # must print 0
```

If you find one that already swallowed its work, split it — reset soft, clear the index, re-make the marker, then commit the work:

```bash
git reset --soft HEAD~1 && git reset
git commit --allow-empty -m "chore(start): …"
git add -A && git commit -m "feat(scope): …"
```

**Never do that to a commit that is already pushed.** Check first (`git branch -r --contains <sha>`); if it is published, leave it and note it in the task's runbook rather than rewriting shared history.

**Commit message rules.**

- Conventional prefix: `feat` `fix` `test` `chore` `docs` `refactor` `perf`.
- Scope is the workspace: `db` `api` `shared` `mobile` `ops`.
- Subject in the imperative, under 72 characters, no trailing period.
- Body says **why**, not what — the diff says what.
- Footer carries `Task:` and `Refs:` pointing at the doc sections. This is what makes a `git log` searchable against the plan two years later.

**Never squash a task into another task's commit.** One task, one reviewable unit, one revert.

**A task is merged when** its tests pass in CI, its "Done when" boxes are all ticked, and the phase's feature flag still defaults off.

---

## 4. Rollback tiers

From `PLAN-EXECUTION.md` Part I §2, restated because every task names one:

| Tier | Mechanism | Recovery | Applies to |
|---|---|---|---|
| **T0** | Feature flag off, server-side | seconds | any user-facing surface |
| **T1** | EAS Update — republish previous JS bundle | ~5 min | JS/TS, screens, business logic in the app |
| **T2** | Redeploy previous API image | ~2 min | everything in `apps/api` |
| **T3** | Reinstall previous APK | **hours to days** | `app.json`, permissions, native modules, SDK bumps |
| **T4** | Compensating data correction | manual, hours | wrong money, wrong balances |

**Two rules that constrain task sequencing:**

- **Never ship a native change and a risky JS change in the same build.** If both go out and something breaks, you cannot bisect without a second sideload round. Tasks marked **Tier T3** are batched — one APK per phase plus a contingency slot.
- **T4 is never a `DELETE`.** Wrong money is corrected by voiding and re-entering so the ledger shows what happened.

Before Phase 0 deploys, every tier collapses to "revert the branch and drop the database". `PLAN-EXECUTION.md` Part I §1 is explicit that this exception expires the moment Phase 0 ships, and it is the reason the schema corrections from both gap passes are free right now.

---

## 5. Test layout and commands

```
apps/api/
  src/**/*.test.ts            unit — pure functions, no I/O
  test/integration/**/*.ts    real Postgres via testcontainers
  test/authz/**/*.ts          every endpoint × every role
apps/mobile/
  src/**/*.test.tsx           components, hooks, RTL
  e2e/*.yaml                  Maestro flows
packages/shared/
  src/**/*.test.ts            matrix, status machine, canonicalisation
```

| Command | Runs |
|---|---|
| `pnpm test` | everything, workspace-wide |
| `pnpm -F api test:int` | integration against a throwaway Postgres container |
| `pnpm -F api test:authz` | the authorisation matrix suite |
| `pnpm -F mobile test` | jest-expo + RTL |
| `pnpm e2e` | Maestro against a connected device |

**No mocked database anywhere.** `PLAN-BACKEND.md` §14: the generated columns, partial indexes and `FULL OUTER JOIN` views are the parts most likely to be wrong, and a mock cannot be wrong about them.

**[impl] `apps/mobile` uses `jest-expo`, not vitest.** `PLAN-FRONTEND.md` §10 says vitest. Vitest does not carry Expo's transform pipeline for native modules, and every task in Phase 1 imports one. `jest-expo` + `@testing-library/react-native` is the supported path. `apps/api` and `packages/shared` stay on vitest as specified. **Confirm this deviation at Phase 0 start** — it is cheap now and a test-suite rewrite later.

---

## 6. Feature flags

Every user-facing surface ships behind the flag `PLAN-EXECUTION.md` Part I §3 assigns it, **defaulted off**, evaluated per employee and per role, returned in `GET /v1/auth/me`.

A task that builds a screen is not done until the flag exists and the screen is dark without it. This buys the dark launch (one named person for a week before the role) and it is the only rollback tier fast enough to matter during a working day.

Flags are deleted one phase after the feature reaches GA. An unremoved flag is an untested code path.

---

## 7. Running tasks in parallel

Each task names what it is **Parallel with**. The rule behind those lists:

- **Migrations are serial.** Two agents writing migration files at once produces two files claiming the same number. One agent owns the migration sequence per phase.
- **`packages/shared` is serial within a phase.** It is imported by both sides; concurrent edits to the permission matrix or the error union are merge conflicts in the one file that must not be wrong.
- **API modules are parallel across modules**, serial within one. `modules/jobs/` and `modules/location/` never touch the same file.
- **Screens are parallel once the primitives exist.** Which is why the Phase 0 component gallery is a gate rather than a nicety: without it, two agents invent `stale` twice.
- **Anything touching `NavShell`, `theme.ts` or the route tree is serial.** These are the three files where a conflict is silent rather than textual.

When two tasks must share a file, the later one depends on the earlier — that is what **Depends on** records.

---

## 8. Phase index

| Phase | File | Size | Est. | Gate before starting |
|---|---|---|---|---|
| 0 | `PHASE-0-FOUNDATION.md` | M | ~3 wks | none |
| 1 | `PHASE-1-TECHNICIAN.md` | XL | ~7 wks | Phase 0 exit met |
| 2 | `PHASE-2-DISPATCHER.md` | M | ~4 wks | Job Logs 5-second prototype passed; FCM proven |
| ON | `PHASE-ON-ONLINE.md` | M | ~2 wks | Owner decisions of 2026-09-15 (`../decisions/2026-09-15-online-only.md`) — **runs before 2B** |
| 2B | `PHASE-2B-CONTRACTS.md` | M | ~4 wks | Phase 2 exit met; **Phase ON merged** |
| 3 | `PHASE-3-SALES-REP.md` | M | ~4 wks | Phase 1 exit met; rep account split agreed |
| 4 | `PHASE-4-OWNER.md` | L | ~6 wks | Map tile source decided; RNW spike on day 3 |
| 5 | `PHASE-5-HARDENING.md` | M | ~4 wks | Phases 1–4 cut over; handsets available |

**~32 weeks for one full-time developer.** Correct the headcount assumption and everything except Phase 5 scales roughly linearly — Phase 5 is gated by handset access and calendar time.

The go/no-go gates in `PLAN-EXECUTION.md` Part III are not advisory. Two of them can end the project shape rather than a task: **the APK must sideload on a real staff handset** (Phase 0 week 1, no budgeted fallback), and **tracking must survive on the majority of roster handsets** (Phase 1 exit, descope path pre-decided).

---

## 9. The four things that must stay true

Every task is checked against these. They are the promises the architecture exists to keep, and each has a CI assertion behind it rather than a habit.

1. **No dispatcher ever sees a revenue figure** — not from `job_completions`, not from `service_contracts`. Response-schema assertions, a lint rule, and optionally a database grant.
2. **No submit silently loses work** — a failed submit keeps everything typed, says what happened, and can be retried; a lost connection covers the screen without unmounting it. (Online-only since 2026-09-15; this was "no path silently discards a technician's work" when there was an outbox.)
3. **Derived money is never stored** — company dues and expected cash are views. A stored counter is correct until the first edit, void or retried request.
4. **Every mutation carries an idempotency key, generated once per submit intent** — regenerating on retry defeats the entire server-side guard and is the single easiest mistake in this codebase.

A task that would weaken one of these is wrong even if it passes its own tests. Say so in review rather than shipping it behind a flag.
