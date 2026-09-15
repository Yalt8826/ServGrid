# Phase ON — Online-only conversion

**Size M · ~2 weeks · Risk: medium, concentrated in the technician's screens.** Decided 2026-09-15 (`../decisions/2026-09-15-online-only.md`). Runs before Phase 2B.

Every role works online. Nothing is stored on a device except the login token and unsent GPS pings. The offline mirror and outbox built in Phase 1 are removed, the technician's screens read and write the API directly, and a full-screen "No connection" gate covers every role.

**Read before starting:** the decision record in full · `PLAN-FRONTEND.md` §4–§5 (already rewritten for this phase) · `PLAN-BACKEND.md` §3.2 (idempotency), §7 (rewritten) · `README.md` §9.

## Task graph

```
TON.0 docs ── TON.1 api reads ── TON.2 mobile foundation ── TON.3 technician screens ── TON.4 cleanup ── TON.7 docs sweep
                                                                                    └── TON.5 device storage ─┘
TON.6 sale discounts (independent — any time after TON.0)
TON.8 map tiles (blocked on the owner's MapTiler key)
```

**The four things that must stay true** (`README.md` §9, as amended by this phase): no dispatcher sees revenue; **no submit silently loses work**; derived money is never stored; every mutation's idempotency key is **generated once per submit intent**.

---

### TON.0 — Decision record and plan

**Reads:** the owner's answers, 2026-09-15
**Depends on:** —
**Tier:** free (docs)

**Build** — `docs/decisions/2026-09-15-online-only.md`; this file; `PLAN.md` §6, `PLAN-FRONTEND.md` §4–§5.1 and `PLAN-BACKEND.md` §7 rewritten; `README.md` phase index and §9.

**Done when**
- [ ] The decision record lists every answer, the bug found, and the device-data consequence
- [ ] The three rewritten sections contradict nothing in the decision record

**Commits** `chore(start): TON.0 online-only decision and conversion plan` → `docs: online-only decision, conversion plan, rewritten state and sync sections`

---

### TON.1 — API: the technician's online reads

**Reads:** `PLAN-BACKEND.md` §7 (rewritten), §5
**Depends on:** TON.0
**Parallel with:** TON.6
**Flag:** `tech.jobs` (existing) · deletes `tech.offline`
**Tier:** T2

**Build**
- `GET /v1/technician/work` — the working set `/v1/sync/bootstrap` built (jobs with `contract` inline, customers, active customer products, products, services), without a cursor. Technician only, gated `tech.jobs`.
- `GET /v1/jobs/:id/events` opens to the technician for **his own** jobs (`job:read own`), using the dispatcher's money-free response shape.
- Remove `/v1/sync/bootstrap`, `/v1/sync/delta`, `/v1/sync/batch`, the sync service's drain, their shared schemas, and `tech.offline` from the flag registry (stored override rows for it are ignored by evaluation already).

**Tests**
- `test/integration/technician-work.test.ts` — own open jobs present; another technician's job absent; **a job reassigned away is absent on the next read**; contract context inline; flag off → `FLAG_DISABLED`; dispatcher/rep/owner → 403
- `test/authz/money-leak.test.ts` — the technician's timeline read walked recursively: no `cost`, `discount_amount`, `amount_collected`, `contract_value`
- A technician reading another technician's job events → `OUT_OF_SCOPE`

**Done when**
- [ ] No route under `/v1/sync` remains and no test references one
- [ ] The technician's timeline carries no money key at any depth

**If it fails** — a technician timeline that leaks money is the dispatcher bug at a second door: reuse the dispatcher redaction in the service, never a hand-picked field list in the route.

**Commits** `chore(start): TON.1 technician online reads` → `feat(api): technician work read and own-job timeline; remove offline sync`

---

### TON.2 — Mobile foundation: online everywhere

**Reads:** `PLAN-FRONTEND.md` §4, §5, §5.1
**Depends on:** TON.1
**Flag:** —
**Tier:** **T3** (removes native storage modules — one APK for the whole phase)

**Build**
- `src/lib/network.ts` — `useIsOnline()` moved here from the dispatcher dashboard hook; every caller imports it.
- `src/components/NoConnectionGate.tsx` — wraps the authenticated stack in `(app)/_layout.tsx`. Offline → a full-screen *"No connection — ServGrid needs the internet. You'll be right back where you were."* rendered **over** the stack, which stays mounted so typed input survives. Web included.
- `ROLE_CAPABILITIES` loses `offline`; every role's query client runs `networkMode: 'online'`, memory only.
- Delete `src/db/`, `src/sync/` and their tests; remove `MirrorProvider` from the layout and `PendingBadge` from `NavShell`.
- Login on **web** refuses `technician` and `sales_rep` after authentication succeeds: *"Use the ServGrid app on your Android phone."* and clears the session.
- First launch of the new build deletes the old mirror database file and every `servgrid.*` AsyncStorage key (one-time, idempotent).

**Tests**
- `NoConnectionGate.test.tsx` — offline renders the screen for each role; **a child's typed state survives offline → online** (the child component is the same instance)
- `login.test.tsx` — web + technician and web + sales_rep refused with the sentence; owner and dispatcher proceed
- `runtimeQueryClient` — every role `online`

**Done when**
- [ ] `grep -r "sync/outbox\|db/mirror\|MirrorProvider" apps/mobile` finds nothing
- [ ] A half-typed form survives a connection drop in the test, by instance identity, not by re-reading storage

**If it fails** — a gate that unmounts its children throws away the typed input the owner asked to keep; render the overlay as a sibling above the stack, never instead of it.

**Commits** `chore(start): TON.2 mobile online foundation` → `feat(mobile): no-connection gate, online query client, remove mirror and outbox`

---

### TON.3 — Technician screens online

**Reads:** `UI/plan-2/04-TECHNICIAN.md` §T1–§T5, `PLAN-FRONTEND.md` §5
**Depends on:** TON.2
**Flag:** `tech.jobs`
**Tier:** T1

**Build**
- `useTechnicianWork` replaces `useTechnicianMirror`: TanStack Query over `GET /v1/technician/work`, refetch on focus, foreground and push wake. `buildJobViews(work)` ports `jobData.ts`'s join (customer name, area, coordinates, the lone unit) as a pure function.
- *Start job* / *Arrive* — `POST /v1/jobs/:id/status` with an intent-pinned key; the button shows busy; refetch on success; the server's sentence on refusal.
- Complete — **`POST /v1/jobs/:id/complete`** (the path the queued version got wrong); photos upload right after, each with its own key, temp file deleted after upload.
- Cancel — `POST /v1/jobs/:id/cancel`.
- Detail timeline from `GET /v1/jobs/:id/events`.
- Remove the stale inset, *Pending sync* chip, rejection banner and the outbox-derived timeline from `jobView.ts` / `jobDetail.ts` / screens.

**Tests**
- `complete.test.tsx` — **the request goes to `/v1/jobs/:id/complete`**; a network failure keeps every typed field and re-enables submit; the retry carries **the same** `Idempotency-Key`; success clears the key
- Same shape for status and cancel
- `buildJobViews` — lone unit named, five units → none, missing coordinates → no *Navigate*

**Done when**
- [ ] A technician completes a job against the real API in an integration run (the 404 bug cannot recur)
- [ ] No technician screen imports anything from `sync/` or `db/`

**Commits** `chore(start): TON.3 technician screens online` → `feat(mobile): technician jobs read and write the API directly`

---

### TON.4 — Rep, dispatcher and owner cleanup

**Depends on:** TON.3 · **Tier:** T1

**Build** — remove every remaining pending/outbox reference: the rep dashboard's *Pending sync* inset, profile screens' pending rows, `PendingBadge` and `SyncBanner` from the component set and the dev gallery; the rep's already-direct writes drop their "rewire to the outbox later" seams and comments; `useRecordPayment`'s stale "capture not wired" comment.

**Done when**
- [ ] `grep -ri "outbox\|pending sync\|PendingBadge" apps/mobile/src apps/mobile/app` finds only the decision-record reference in a comment, or nothing

**Commits** `chore(start): TON.4 remove offline remnants` → `refactor(mobile): remove pending-sync UI and outbox seams`

---

### TON.5 — Device storage down to two exceptions

**Depends on:** TON.2 · **Parallel with:** TON.3 · **Tier:** T3 (batched with TON.2's APK)

**Build**
- Permission-ladder flags (`batteryExempt`, `autostartConfirmed`) are written to the server's device diagnostics (`POST /v1/devices`) and read back from the server; no local copy.
- The parked FCM token lives in memory until a session exists.
- Remove `@react-native-async-storage/async-storage`.
- `tools/eslint-plugin-servgrid-rules` gains **`no-device-storage`**: importing `expo-sqlite`, `expo-secure-store`, `@react-native-async-storage/async-storage`, or `localStorage` access, outside `src/lib/tokenStore.impl.*` and `src/location/bufferStore.native.ts`, is an error. Proven by a firing fixture and a clean fixture in `lint-proof.mjs`, like the other rules.

**Done when**
- [ ] `pnpm lint` proves the new rule fires exactly once on its fixture
- [ ] The ladder resumes at the right step after a reinstall, from the server's answer

**Commits** `chore(start): TON.5 device storage exceptions only` → `feat(mobile): ladder state on the server, no-device-storage lint rule`

---

### TON.6 — Sale discounts recorded

**Reads:** `PLAN-DATA-MODEL.md` §3.5 · decision 7
**Depends on:** TON.0 · **Parallel with:** TON.1–TON.5
**Flag:** `sales.cards` · **Tier:** T2 + T1

**Build**
- Migration **019 `sale_discounts`** — `sales_card_items.list_price numeric(12,2)` and `discount_pct numeric(5,2)`, both nullable for lines recorded before today. `CHECK ((list_price IS NULL) = (discount_pct IS NULL))`, `CHECK (discount_pct >= 0 AND discount_pct <= 100)`, and when present `CHECK (unit_price = round(list_price * (100 - discount_pct) / 100, 2))`.
- The API accepts `listPrice` + `discountPct` and **computes `unitPrice` itself**; a client-sent `unitPrice` that disagrees is a 422.
- Rep and owner sale detail show *"List ₹12,000 · 10% off · ₹10,800"*; the owner's Sales table gains a discount column.

**Tests** — `schema-sales.test.ts` (the three CHECKs, legacy NULL rows valid); `sales.test.ts` (server-computed price, paise rounding, disagreeing `unitPrice` → 422); the balance property test still green.

**Done when**
- [ ] A 12.5% discount on ₹999.99 stores `874.99` on both sides of the wire

**Commits** `chore(start): TON.6 sale discounts` → `feat(db): migration 019 — list price and discount on sale lines`

---

### TON.7 — Documentation sweep

**Depends on:** TON.1–TON.6 · **Tier:** free

**Build** — every remaining offline description rewritten or marked superseded: `PLAN.md` (§5 role-change note), `PLAN-DATA-MODEL.md` §6, `PLAN-EXECUTION.md` (flags table, Phase 1 and 3 tests, exit criteria, rollback rows, risk register), `PLAN-GAPS.md` notes, `PLAN-FRONTEND.md` (nav map: rep **5** tabs; §9 screens), `UI/plan-2` (00, 02, 03 `SyncBanner`/`PendingBadge`, 04, 05, 06 — five tabs, photo-only payments, discounts — 07, 08 *Offline*), `PHASE-2B-CONTRACTS.md` (technician contract context via the work read), `PHASE-5-HARDENING.md`, and the field-run checklists T1.23, T2.11, T3.9, T4.13.

**Done when**
- [ ] `grep -ril "outbox\|offline-first\|mirror" docs/PLAN*.md docs/UI/plan-2 docs/implementation` returns only superseded notes and the decision record's references

**Commits** `chore(start): TON.7 docs sweep` → `docs: plan documents follow the online-only decision`

---

### TON.8 — Map tiles

**Blocked on:** the owner's MapTiler account. **Build** — `EXPO_PUBLIC_MAP_STYLE_URL` documented in `.env.example` and the T4.10 runbook; verify the console renders tiles on web and Android. **Done when** the owner sees his roster on a map.

---

## Phase exit

- [ ] Every role, every screen: pulling the network shows the full "No connection" screen, and a half-typed form is intact when it returns
- [ ] A technician completes a real job from the new APK and the office sees it immediately
- [ ] After a day's use, the handset's app storage holds only the token and the (usually empty) GPS buffer — checked with `adb shell run-as` on the Nothing phone
- [ ] All five CI gates green; the new lint rule proven
