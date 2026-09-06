# Field Service App — Settled Design & Architecture

UPS and battery sales, installation and servicing. 14 users: 1 owner, 3 dispatchers, 8 technicians, 2 sales reps.

This supersedes the earlier plan. Decisions below are closed unless marked otherwise.

---

## 1. Platform

Android is the primary surface for all four roles. The owner additionally gets a desktop web build.

| Role | Phone layout | Desktop layout | Offline outbox | Sends location |
|---|---|---|---|---|
| Technician | yes | — | yes | yes |
| Dispatcher | yes | — | no | no |
| Sales Rep | yes | — | yes | yes |
| Owner | yes | yes | no | no |

Two consequences worth holding onto:

**Offline need is independent of platform.** Dispatchers are on Android but sit at a desk on office wifi, so they get online-only behaviour with clear error states. The outbox is a technician and sales-rep feature. These two facts will want to get conflated once code is being written; they shouldn't be.

**The owner is the only role needing two layouts.** So the work is "phone layouts for everything, plus desktop layouts for eleven owner screens" — two nearly disjoint sets, not a responsive matrix across every screen.

---

## 2. Stack

    apps/mobile      Expo Router — Android for all roles, web for the owner
    apps/api         Node (Fastify) + Postgres
    packages/shared  Domain types, zod schemas, permission matrix

**Expo rather than bare React Native.** This is load-bearing, not a preference. `expo-location` and `expo-task-manager` provide the Android foreground service that makes background tracking survive, and EAS Build produces the signed APK you're sideloading. On bare RN, background location means a paid third-party library or writing the Android service by hand.

**Node sits between React Native and Postgres.** The app never talks to the database directly — role scoping, the derived balance views, sequence allocation and idempotency all live server-side, where they can be trusted.

**Distribution: EAS internal distribution APK.** No Play Store means no background-location policy review, which is a real saving.

`packages/shared` is the highest-leverage piece: one definition of every entity and every permission rule, imported by both sides, so role logic cannot drift between the UI and the API.

---

## 3. What actually differs between Android and web

One seam. Background location cannot run in a browser — no browser can do it, so the owner's web session simply doesn't send pings, which is correct since owners aren't tracked anyway.

Two seams from the earlier plan have dissolved:

**Offline storage** — the only web user is the owner, who doesn't need an outbox. `expo-sqlite` on Android, nothing on web. The IndexedDB path is gone.

**Maps** — the technician's "Navigate" action deep-links to Google Maps, which has traffic, voice guidance and offline tiles nothing in-app would match. That leaves the owner's location console as the only map in the system, and it's on web. `react-native-maps` drops out entirely; one web map library remains.

---

## 4. Data model

Money is `NUMERIC(12,2)`. Timestamps are `timestamptz`, business dates come from the Asia/Kolkata clock.

**Core** — `employees` (username + argon2 password, created by the owner), `customers`, `customer_products`, `companies`, `products`, `services`.

**Jobs** — `job_cards`, plus `job_completions` and `job_cancellations` as separate 1:1 tables, plus append-only `job_events`.

**Sales** — `sales_cards` with `sales_card_items` (unit price snapshotted at sale time), `payments`, `attachments`.

**Cash handover** — `cash_reconciliations`, one row per technician per day.

**Location** — `location_pings`. **Sync** — `idempotency_keys`, `sequences`.

### Four structural decisions

**Completion figures live in `job_completions`, not on `job_cards`.** This makes "dispatchers cannot see revenue" a property of the schema rather than a promise about every future `SELECT`. Their queries read `job_cards` and never join the completion table, so there is no money column to leak by accident.

**Company dues are a view, not a column.** `SUM(sales) − SUM(payments)` per company. You wanted the due amount to rise the moment a sale is logged; a derived view does that and cannot drift, where a stored counter is correct until the first edit, void or retried request.

**Expected cash is derived the same way.** The technician declares what he's handing over; what he *should* have comes from his cash-mode completions that day. Cash only — UPI and card land in the company account and never pass through anyone's hands. The owner's queue uses a `FULL OUTER JOIN` so a day with collections but no submission still appears; that's the row the whole feature exists to catch.

**Every mutation carries an idempotency key.** Without it, one flaky reconnect on a technician's phone creates duplicate jobs and double-counted payments.

### Closed scope decisions

No customer credit — jobs never create receivables. Sales cards are internal records, not invoices, so no GST breakup or printable format. Companies are managed by owner and sales reps only. Technicians update a customer's product stack after installing, since they're the ones who know what got fitted.

Worth noting for the technician completion form: with no credit system, a job where `amount_collected` is less than `cost` has nowhere for the difference to go. Either the form should ask why (an on-site discount), or the two fields should collapse into one. Still open.

---

## 5. Permissions

Defined once in `packages/shared`, enforced server-side, used by the UI to decide what to render.

| | Technician | Dispatcher | Sales Rep | Owner |
|---|---|---|---|---|
| Own jobs | read, status, complete, cancel | — | — | full |
| All jobs | — | CRUD + assign | — | full |
| Job money | writes own at completion | **none** | — | full |
| Customers | read (assigned only) | create, read, update | — | full |
| Customer product stack | update | — | — | full |
| Companies | — | **none** | read, create, update | full |
| Sales / payments | — | — | own | full |
| Cash handover | declares own | — | — | confirms all |
| Employees | self | self | self | full |
| Location | sends | — | sends | reads all |

---

## 6. Offline sync — technicians and sales reps only

SQLite mirror of what the role needs in the field, plus an `outbox` table. User acts, writes locally, enqueues, UI updates immediately. The queue drains on reconnect, on foreground and on a timer.

Conflicts resolve by last-write-wins on descriptive fields, but status transitions are validated server-side — you cannot complete a job the office cancelled while you were underground. On rejection the client keeps the local record and shows a plain banner explaining what happened. No silent overwrite in either direction.

Job and sale numbers are server-assigned; the device shows "Pending sync" until one arrives, never a fake local number. Photos queue as local file URIs and upload on reconnect. Nothing in the UI blocks on the network, and a pending-count badge stays visible so the technician can see work is queued rather than lost.

---

## 7. Location service

Android only, and still the highest-risk part of the build.

**Collection.** `expo-location` background updates running as a foreground service with a persistent notification — the only configuration that survives on Android 8+. `Accuracy.Balanced` is ample for "where is this technician" and far cheaper on battery than `High`, which is reserved for on-demand fixes.

**Cadence.** 15-minute target with a 100m distance interval and deferred updates so Android can batch. Expect jitter; the OS will not honour it precisely and fighting that costs battery for nothing.

**Work window.** 09:00–19:00, Monday to Saturday, Asia/Kolkata. Filter, don't schedule — the task stays alive, the device discards out-of-window pings to save battery, and the server rejects them too, because a rule governing staff shouldn't trust the device clock.

**Buffering.** Pings write to SQLite and upload in batches, so a technician in a basement for two hours surfaces with the real trail rather than a gap.

**On-demand.** The owner taps *Locate now*, the server sends a data-only FCM push, the device wakes and posts a high-accuracy fix. For live watching, the push flips the device to ~10s intervals for five minutes, then reverts.

**Onboarding, in this order.** Foreground permission, then background permission — which on Android 11+ cannot be requested in-flow, so it's a deep-link into settings with an explanation — then battery optimisation exemption, then the OEM autostart page on Xiaomi, Realme, Vivo, Oppo and OnePlus. Those vendors kill background tasks regardless of what Android permits, and they are most of the handset market here.

**Make failure loud.** A health chip on the technician's profile showing "Tracking active · last ping 6 min ago", visible to the owner too. Silent failure is the enemy.

**Consent.** A one-time screen at first login, plus the persistent notification. Under the DPDP Act you want that documented, and it stops the app being experienced as something done to staff rather than with them.

---

## 8. Screens

**Technician** — Dashboard, Jobs (tabs, job detail, complete sheet, cancel sheet), Profile.

**Dispatcher** — Dashboard, Dispatch Job, Job Logs, Customer, Profile. Two of these need designing for a phone rather than shrinking:

*Job Logs* was a sortable table with a sticky header. On a phone it becomes a filtered list with a persistent filter bar — technician, status, date — and bulk reassign becomes a multi-select mode rather than checkboxes in a table.

*Assignment* shouldn't be a dropdown of eight names. The picker shows load inline — "Ravi · 3 today", "Anitha · 6 today" — because choosing who to send is the actual decision and a name alone doesn't support it.

**Sales Rep** — Dashboard, Sales, Payment (Pending / Collected tabs, proof photo), Company, Profile.

**Owner** — Dashboard, Jobs, Sales, Dispatch Job, Payment, Product, Customer, Employees, Company, Location, Profile, plus the cash reconciliation queue.

Eleven destinations don't fit a phone tab bar, so on Android they group into five: Dashboard, Operations (jobs, dispatch, customers), Sales (sales, payments, companies), People (employees, location, cash), Profile. On desktop the same routes expand into a left rail with those groups as sections. Same route tree, two presentations.

---

## 9. Design system

Light mode only for now. If dark mode is added later, the contrast levels below were chosen for sunlight legibility rather than aesthetics — softening the slate or lightening the muted greys because it looks harsh on a monitor would be applying the desk view to a decision made for the yard.

**Palette.** Slate `#16202B` base, `#5A6B7C` muted, warm white `#FDFDFB` surfaces, `#F2F4F7` for dense desktop zones.

The accent is safety yellow `#F2C200`, taken from the vernacular of the work — hard hats, lockout tags, cable markers — and it stays readable in direct sunlight where a mid-tone blue disappears. It appears on exactly two things: the primary action and the active state. The moment it decorates a third, it stops meaning anything.

Status colours are read off UPS front panels, so the card communicates state before anyone reads a word: `#0F8A5F` completed, `#D98A00` en route, `#F2C200` in progress, `#B3261E` cancelled.

**Type.** IBM Plex Sans throughout, Condensed for large dashboard figures. Drawn for engineering contexts, genuinely good tabular figures for job numbers and amounts, and not the family every app defaults to. Open licensed. One family, two widths.

**Layout.** Single column with actions in the thumb zone; tap targets at 52px, assuming gloves and a moving vehicle. Job cards carry a 4px status rail on the leading edge, square-cornered — it reads like a physical work docket and is legible across a workshop.

The one rule that matters for the owner's dual layout: **the same job is a card on a phone and a table row on desktop.** Not a card grid. Scanning 200 jobs needs rows, sortable columns and a scannable left edge. Forcing phone cards onto a desktop is the commonest way a React Native web build ends up feeling like a phone app in a browser window.

**Motion.** One orchestrated moment — the job status stepper filling as a job advances, with the completion sheet rising over it. Skeletons rather than spinners. Everything else answers a tap; no entrance animation on every card.

---

## 10. Build order

| Phase | What |
|---|---|
| 0 done | Monorepo, schema, permission matrix, auth, tokens |
| 1 | Technician app — exercises offline and location while scope is small |
| 2 | Dispatcher — phone-native Job Logs and load-aware assignment |
| 3 | Sales Rep — sales cards, balances, payments with proof upload |
| 4 | Owner — Android grouped nav, desktop rail, location console, cash queue |
| 5 | Hardening — OEM battery testing on the actual handsets staff carry |

---

## 11. What can still go wrong

**OEM background-task killing** is the dominant risk and cannot be simulated. It needs testing on the exact handset models your staff carry.

**Employee reaction to tracking** — managed by the consent screen, the visible notification and a fixed window rather than all-day surveillance, but it's a conversation with the company, not just a feature.

**Dispatcher Job Logs on a phone** is the one screen where the phone-first decision costs something real. Worth prototyping before building.
