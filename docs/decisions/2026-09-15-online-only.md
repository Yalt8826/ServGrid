# Online-only — decisions taken after the Phase 4 check

Date: 2026-09-15 · Status: **DECIDED by the owner, 2026-09-15**

The Phase 4 check (`main` @ `df30072`) found three things the plan did not describe:
Phase 2B (contracts) was never built; sales reps were already online-only in practice
(their writes never touched the outbox, contrary to the T3.8 commit message); and sale
discounts reached the server only as a reduced unit price. The owner answered every open
question in one sitting. This file is the record; where a plan document disagrees with
it, **this file wins** until the plan documents are swept (task TON.7).

---

## 1. The decisions

| # | Question | Decision |
|---|---|---|
| 1 | Offline support | **The app is fully online for every role. No business data is stored on devices.** The SQLite mirror and the outbox are removed for technicians and sales reps. |
| 2 | GPS pings with no signal | **Kept in a small on-device buffer** until sent. The one deliberate exception to decision 1. |
| 3 | Staying logged in | **Yes.** The login token stays in the phone's secure storage (web: `localStorage`). No business data rides with it. |
| 4 | Connection drops mid-form | **The typed input is kept in memory** and submit works again once the connection returns. Closing the app loses it. |
| 5 | What screens show offline | **A full "No connection" screen**, for every role, over whatever was open. |
| 6 | Phase 2B contracts | **Built after the online conversion**, on the online design. |
| 7 | Sale line discounts | **Store list price, discount % and final price** on every line. No reason required. |
| 8 | Payment evidence | **Photo only.** The reference-number field stays removed (the owner's field change). |
| 9 | Owner's location map | **Hosted OpenStreetMap tiles (MapTiler free tier).** The owner creates the account and supplies the key. |
| 10 | Web for field staff | **No.** Technicians and sales reps use the Android app only; web stays for the owner and dispatchers. |
| 11 | Rep tab count | **Five tabs** (Companies added during field testing) — the plan documents follow the app. |
| 12 | How the work is done | **Claude builds directly**: plan documents first, then task by task with the branch + empty start-marker protocol, every gate green before each merge. |
| 13 | Pending field runs (T1.23, T2.11, T3.9, T4.13) | **Left pending** for the owner to run with staff; their checklists are rewritten for the online design. |

## 2. What this changes

**Removed**

- `apps/mobile/src/db/` (the mirror) and `apps/mobile/src/sync/` (outbox, drain manager, mirror provider, logout gate, drain triggers).
- `GET /v1/sync/delta`, `POST /v1/sync/batch` and the `tech.offline` flag.
- Every "Pending sync" chip, pending-count badge, stale inset and *Discard my copy* / *View the office version* rejection banner.
- `@react-native-async-storage/async-storage` — its three uses (permission-ladder flags, parked FCM token) move to the server or to memory.

**Stays**

- The idempotency plugin and `idempotency_keys` table. A key is now minted **once per submit intent** and reused for every retry of that intent, so a timeout followed by a retry replays instead of creating a second payment.
- Server-side status validation, `If-Match` versions, `DUPLICATE_ENTITY` — they now answer at the moment of submit, in front of the user.
- The GPS ping buffer (`location/bufferStore.native.ts`, SQLite) — decision 2.
- Data-only FCM wakes. A wake now refetches; the local notification is composed from the rows just fetched.

**Added**

- `GET /v1/technician/work` — the technician's working set in one online read (replaces `/v1/sync/bootstrap`).
- `GET /v1/jobs/:id/events` for a technician's own jobs, without money.
- A full-screen `NoConnectionGate` for every role.
- A lint rule, `no-device-storage`, so nothing new quietly starts writing to the phone.
- `sales_card_items.list_price` and `discount_pct` (migration 019).

## 3. Consequences worth reading twice

**A real bug found while planning this.** The technician's Complete sheet queued its request to `POST /v1/jobs/:id/completions`. The server route is `/v1/jobs/:id/complete`; there is no `/completions`. The sync batch replays each queued request against its path, so **every job completion sent from the Android app would have been refused with a 404.** The online conversion calls `/complete` directly, and a test pins the path.

**Anything still queued on a handset today is discarded** when the new build first starts (it deletes the old mirror database and AsyncStorage keys, per decision 1). Given the bug above, queued completions were never going to be accepted anyway. Before installing the new APK, check the job on the office side for anything a technician says he completed in the app.

**This is a native change (rollback tier T3).** Removing a native storage module means a new APK. It ships as one build for the whole conversion, never bundled with an unrelated risky JS change (`docs/implementation/README.md` §4).

**The T3.8 "outbox regression gate" claim was wrong.** Its commit says Phase 3's sales, payments and companies "ride the Phase 1 outbox" and that "reps keep offline support". They never did; the outbox passed "unchanged" because nothing was added to it. This record is the correction; the commit is published history and stays as it is.

**Owner action needed:** create a MapTiler account and send the style URL/key for `EXPO_PUBLIC_MAP_STYLE_URL`. Until then the location console stays the roster pane without tiles.

## 4. Where the work is planned

`docs/implementation/PHASE-ON-ONLINE.md` — tasks TON.0 to TON.8. Phase 2B is rewritten for the online design once the conversion lands.
