# Field Service App — Settled Design & Architecture

UPS and battery sales, installation and servicing. 14 users: 1 owner, 3 dispatchers, 8 technicians, 2 sales reps.

This supersedes the earlier plan. Decisions below are closed unless marked otherwise.

Companion documents: `PLAN-DATA-MODEL.md`, `PLAN-BACKEND.md` and `PLAN-FRONTEND.md` specify how each layer is built; `UI/plan-2/` carries the design philosophy, the motion system and a screen-by-screen specification for every role; `PLAN-EXECUTION.md` carries the phases, tests, exit criteria and rollback; `PLAN-GAPS.md` records the gaps found by two passes — the first reading all five against each other, the second reading them against the work of building and running the app — and the decisions taken to close them. Where those decisions changed something here, this document has been amended and the gap register says why. `implementation/` turns all of it into a build: eight files, one per phase plus a protocol, **89 tasks** each naming the doc sections to read, the files to create, the tests to write, the criteria that decide whether it worked, and the rollback for when it did not.

---

## 1. Platform

Android is the primary surface for all four roles. The owner additionally gets a desktop web build.

| Role | Phone layout | Desktop layout | Web sign-in | Sends location |
|---|---|---|---|---|
| Technician | yes | — | no | yes |
| Dispatcher | yes | — | yes | no |
| Sales Rep | yes | — | no | yes |
| Owner | yes | yes | yes | no |

Two consequences worth holding onto:

**Every role works online, and where a role may sign in is a separate rule.** Since 2026-09-15 no role keeps business data on a device (§6, `docs/decisions/2026-09-15-online-only.md`); the old split — an outbox for technicians and reps, error states for dispatchers — is gone. Technicians and sales reps use the Android app only, and a web sign-in by either is refused after authentication. Dispatchers and the owner may also use the web build. These two facts will want to get conflated once code is being written; they shouldn't be.

**The owner is the only role needing two layouts.** So the work is "phone layouts for everything, plus desktop layouts for fourteen owner screens" — two nearly disjoint sets, not a responsive matrix across every screen.

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

**Offline storage** — gone for every role (§6). The login token (Keystore on Android, `localStorage` on web) and the Android GPS ping buffer are the only things written to a device; `expo-sqlite` survives for that buffer alone. The IndexedDB path is gone.

**Maps** — the technician's "Navigate" action deep-links to Google Maps, which has traffic, voice guidance and offline tiles nothing in-app would match. That leaves the owner's location console as the only map in the system, and it's on web. `react-native-maps` drops out entirely; one web map library remains.

---

## 4. Data model

Money is `NUMERIC(12,2)`. Timestamps are `timestamptz`, business dates come from the Asia/Kolkata clock.

**Core** — `employees` (username + argon2 password, created by the owner), `customers`, `customer_products`, `companies`, `products`, `services`.

**Jobs** — `job_cards`, plus `job_completions` and `job_cancellations` as separate 1:1 tables, plus append-only `job_events`.

**Contracts** — `service_contracts`, with jobs linked by `job_cards.contract_id`. An AMC is a 12-month agreement for a site, recorded by the dispatcher; the app reminds him four months after the site's last completed job.

**Sales** — `sales_cards` with `sales_card_items` (unit price snapshotted at sale time), `payments`, `attachments`.

**Cash handover** — `cash_reconciliations`, one row per **employee** per day. Technicians collect cash at completion and sales reps occasionally collect it from companies; both hand it over, so the table is keyed on the employee rather than the role.

**Location** — `location_pings` and `location_requests` (an on-demand fix is a persisted request, not a fire-and-forget push). **Write plumbing** — `idempotency_keys`, `sequences`.

### Four structural decisions

**Completion figures live in `job_completions`, not on `job_cards`.** This makes "dispatchers cannot see revenue" a property of the schema rather than a promise about every future `SELECT`. Their queries read `job_cards` and never join the completion table, so there is no money column to leak by accident.

**Company dues are a view, not a column.** `SUM(sales) − SUM(payments)` per company. You wanted the due amount to rise the moment a sale is logged; a derived view does that and cannot drift, where a stored counter is correct until the first edit, void or retried request.

**Expected cash is derived the same way.** The employee declares what he's handing over; what he *should* have comes from his cash-mode completions and cash-mode payments that day. Cash only — UPI, card and bank transfer land in the company account and never pass through anyone's hands. The owner's queue uses a `FULL OUTER JOIN` so a day with collections but no submission still appears; that's the row the whole feature exists to catch.

A completion can be amended afterwards, by the owner only and with a reason, because a mistyped amount otherwise reaches the owner as an unexplainable variance with no way to fix it. Amendment is refused once that day's handover is confirmed — the owner reopens the reconciliation first, so a figure he has already signed off cannot move underneath him.

**Every mutation carries an idempotency key.** Without it, one flaky reconnect on a technician's phone creates duplicate jobs and double-counted payments.

### Service contracts

An AMC is a customer site's 12-month maintenance agreement. `services` already carried an `AMC` code, but a code is not a contract: without one there is nothing to remind anyone about and nothing to renew. **Decided by the owner on 2026-09-15** (`docs/decisions/2026-09-15-amc-contracts.md`), replacing a first design with fixed visits and a nightly job generator.

**The dispatcher records the AMC**, against the customer, with its start, end and price. The owner can too; sales reps have no part in it. **One site, one AMC at a time**: the database refuses two AMCs whose dates overlap at the same site, so a renewal starting the day after the current one ends can be recorded early.

**AMC work is dispatched by hand, and the app reminds.** An AMC has no fixed number of visits. The dispatcher's *AMC* tab lists every AMC customer whose last completed job — any job — was four months ago or more and who has nothing booked, and every AMC ending within seven days. Picking such a customer on the dispatch form offers the AMC option already ticked, and the job is linked to the AMC.

**A job linked to an AMC is an ordinary job.** The same picker assigns it, the same sheet closes it, the same flow cancels and reschedules it. On the complete sheet the technician starts on *Free under AMC* and can switch to *Charge* for extra work — which the completion rules already permit without amendment.

**State comes from dates.** An AMC is upcoming, active or expired by its dates, or cancelled; nothing is stored that a missed night could leave stale.

### Closed scope decisions

No customer credit — jobs never create receivables. Sales cards are internal records, not invoices, so no GST breakup or printable format. Technicians update a customer's product stack after installing, since they're the ones who know what got fitted.

**Parts fitted on a job are recorded; stock is not tracked.** A completion can list what was consumed, because a fixed-price AMC whose visits eat two filters each time has a cost the renewal quote should reflect and nothing else would reveal it. But nothing is decremented, there are no stock levels, and **parts never affect the amount charged** — the technician still enters one figure. Anyone later deriving the amount from a parts total is rebuilding invoicing, which the line above rules out.

**Technicians do not spend from collected cash.** Confirmed with the owner, and it is why the cash handover is one number and a note, and why every variance in the owner's queue is a real discrepancy rather than something to explain away.

**Companies are managed by owner and sales reps only, and each rep owns his accounts.** `companies.owner_rep_id` decides what a rep sees; a NULL owner means a house account visible to every rep, which is where a company created by the owner lands. Only the owner can reassign an account, which is also how leave and handover work — he reassigns or nulls a rep's accounts for the duration. A payment recorded by a rep who does not own the account is legal and records who actually took the money, exactly as a completion records who actually closed the job.

The technician completion form's shortfall question — where the difference goes when collected is less than cost, with no credit system — is resolved in `PLAN-DATA-MODEL.md` §3.4: the technician enters one amount, and a shortfall must be entered as a discount with a reason. A gap with no explanation is unrepresentable.

---

## 5. Permissions

Defined once in `packages/shared`, enforced server-side, used by the UI to decide what to render.

| | Technician | Dispatcher | Sales Rep | Owner |
|---|---|---|---|---|
| Own jobs | read, status, complete, cancel | — | — | full |
| All jobs | — | CRUD + assign | — | full |
| Job money | writes own at completion | **none** | — | full, amends with a reason |
| Customers | read (assigned only) | create, read, update | — | full |
| Customer product stack | update | — | — | full |
| Companies | — | **none** | own accounts + house accounts | full |
| Service contracts | sees the AMC behind his job, never its price; **chooses Free or Charge** on an AMC job | **records, edits, renews and cancels AMCs, with the price** | — | full |
| Sales / payments | — | — | own | full |
| Cash handover | declares own | — | declares own | confirms all, reopens |
| Employees | self | self | self | full |
| Location | sends | **device health only, no position** | sends | reads all |

Three things the table alone doesn't carry:

**Dispatchers can create a customer but not attach it to a company.** They have no company permission at all, so `customers.company_id` is absent from their form and stripped from their payloads server-side. It is an owner and rep field.

**A technician's `job.money` is write-once at completion.** He submits the amount; the job detail he sees afterwards shows the work summary and collection mode, not a revenue figure. The completion he wrote is his own record, not a report.

**Deactivating an employee is refused while he still holds open jobs, owns companies, or has cash the owner has not confirmed**, with the blocking rows named so the owner can reassign and retry. On success every refresh token is revoked, his devices are marked inactive and he leaves the tracking-health view. History is untouched — `is_active` was never a delete.

The cash precondition is the one that is easy to leave out and expensive to leave out. Open jobs and owned companies are visible; an unconfirmed handover is a row in a queue the owner may not have reached yet, and deactivating the person is how a real discrepancy becomes an unanswerable one — the only person who could explain it can no longer log in and is probably no longer employed. **Changing an employee's role is gated the same way**, for the same reason. (A fourth condition — an undrained outbox — went with the outbox on 2026-09-15; the new role applies at the next sign-in.)

**A dispatcher sees tracking health but never a position.** He is the person who will notice a technician has stopped reporting and the person who will ring him, so his dashboard carries the warning inline. Where someone actually *is* — coordinates, the day's trail, the map — remains the owner's alone. `PLAN-BACKEND.md` §5 splits these as `location.health` and `location.read`; without the split the choice was between handing the desk a live map of eight people or leaving the dispatcher's warning reading data the matrix forbids.

---

## 6. Online-only — every role

**Decided 2026-09-15** (`docs/decisions/2026-09-15-online-only.md`). Every role works online against the API, and **no business data is stored on a device**. This replaces the original design, which gave technicians and sales reps an offline SQLite mirror and an outbox.

**What stays on a phone:** the login token, in secure storage, so people stay logged in; and unsent GPS pings in a small buffer (§7), so a technician in a basement still surfaces with his real trail. Nothing else — no copy of jobs, no queue of pending work, no cached lists on disk.

**When the connection drops**, the app shows a full *"No connection"* screen over whatever was open, for every role. It is a cover, not a navigation: a half-typed completion or payment underneath is exactly as it was when the connection returns. That input lives in memory only; closing the app loses it, which the owner accepted.

**No submit silently loses work.** A submit that fails keeps everything typed, says what happened in plain words, and can be retried. Every submit carries an idempotency key minted once for that intent and reused on every retry, so a request that timed out after the server saved it replays the saved result instead of creating a second payment.

Status transitions are still validated server-side — you cannot complete a job the office cancelled — but the refusal now arrives at the moment of submit, in front of the person, instead of on a later sync. Job and sale numbers come back in the submit's response.

**Assignment notifications.** The server sends a data-only FCM message on assignment, reassignment, cancellation of an assigned job, and priority escalation. It carries no job content: it wakes the app, which refetches and raises a local notification from the rows it just fetched.

**The system stays correct with every push dropped.** Push only makes a new job show up sooner; the next open or foreground refetches anyway. Keeping FCM off the correctness path is what makes it safe to depend on a delivery channel nobody controls.

**Field staff use the Android app only.** Background GPS exists only there. The web build is for the owner and dispatchers; a technician or rep who signs in on web is told to use the phone app.

---

## 7. Location service

Android only, and still the highest-risk part of the build.

**Collection.** `expo-location` background updates running as a foreground service with a persistent notification — the only configuration that survives on Android 8+. `Accuracy.Balanced` is ample for "where is this technician" and far cheaper on battery than `High`, which is reserved for on-demand fixes.

**Cadence.** 15-minute target with a 100m distance interval and deferred updates so Android can batch. Expect jitter; the OS will not honour it precisely and fighting that costs battery for nothing.

**Work window.** 09:00–19:00, Monday to Saturday, Asia/Kolkata. Filter, don't schedule — the task stays alive, the device discards out-of-window pings to save battery, and the server rejects them too, because a rule governing staff shouldn't trust the device clock.

**Buffering.** Pings write to SQLite and upload in batches, so a technician in a basement for two hours surfaces with the real trail rather than a gap.

**On-demand.** The owner taps *Locate now*, the server sends a data-only FCM push, the device wakes and posts a high-accuracy fix. For live watching, the push flips the device to ~10s intervals for five minutes, then reverts.

**Onboarding, in this order.** Foreground permission, then background permission — which on Android 11+ cannot be requested in-flow, so it's a deep-link into settings with an explanation — then battery optimisation exemption, then the OEM autostart page on Xiaomi, Realme, Vivo, Oppo and OnePlus. Those vendors kill background tasks regardless of what Android permits, and they are most of the handset market here.

**Notification permission comes after the ladder, not inside it.** Android 13+ requires a runtime prompt for notifications, and it is needed for assignment alerts (§6) rather than for tracking. Asking mid-ladder means a refusal strands someone between two location permissions; asking after means a refusal costs alerts and nothing else. The persistent foreground-service notification is exempt, so tracking survives a refusal — but the technician stops being told about new jobs, which is silent degradation, and this app treats that as the enemy everywhere else. The health chip has to say so.

**Make failure loud.** A health chip on the technician's profile showing "Tracking active · last ping 6 min ago", visible to the owner too. Silent failure is the enemy.

**Consent.** A one-time screen at first login, plus the persistent notification. Under the DPDP Act you want that documented, and it stops the app being experienced as something done to staff rather than with them.

---

## 8. Screens

**Technician** — Dashboard, Jobs (tabs, job detail, complete sheet, cancel sheet), Cash handover, Profile.

A job detail names the specific unit the job is about, not just the site — a customer with five UPS units and three battery banks otherwise produces a docket that says "battery swap" and leaves the technician to work it out on arrival. When that unit is still under warranty the detail says so with the expiry date, and completing it with a charge raises a confirmation rather than a refusal, because out-of-scope work on an in-warranty unit is legitimately chargeable.

**Dispatcher** — Dashboard, Dispatch Job, Job Logs, Customer, Profile. An open job past its scheduled date shows as **Overdue** and sorts first; the date never rolls forward on its own, because silently moving it hides exactly the missed commitment a dispatcher is employed to see. Two of these need designing for a phone rather than shrinking:

*Job Logs* was a sortable table with a sticky header. On a phone it becomes a filtered list with a persistent filter bar — technician, status, date — and bulk reassign becomes a multi-select mode rather than checkboxes in a table.

*Assignment* shouldn't be a dropdown of eight names. The picker shows load inline — "Ravi · 3 today", "Anitha · 6 today" — because choosing who to send is the actual decision and a name alone doesn't support it.

**Sales Rep** — Dashboard, Sales, Payment (Pending / Collected tabs, proof photo), Company, Cash handover, Profile.

**Owner** — Dashboard, Jobs, Dispatch Job, Customers, Contracts, Sales, Payments, Companies, Products, Services, Employees, Location, Cash reconciliation queue, Profile.

Fourteen destinations don't fit a phone tab bar, so on Android they group into five:

| Group | Routes |
|---|---|
| Dashboard | dashboard |
| Operations | jobs, dispatch job, customers, contracts |
| Sales | sales, payments, companies |
| People | employees, location, cash queue |
| Profile | profile, products, services |

On desktop the same routes expand into a left rail with those groups as sections. Same route tree, two presentations. Products and services sit under Profile because they are settings the owner touches a few times a year, not work — putting them in Operations would give a daily group two entries nobody opens.

**The grouping is per role, not one owner-shaped map with rows hidden.** That distinction is easy to miss and expensive to discover: the table above is the *owner's* grouping, and simply filtering it by permission strands screens. Cash sits under People, which a technician cannot reach — so his handover would have no home.

| Role | Tabs | Contents |
|---|---|---|
| Technician | 4 | Dashboard · Jobs · **Cash** · Profile |
| Dispatcher | 4 | Dashboard · **Operations** (jobs, dispatch, customers) · **AMC** · Profile |
| Sales Rep | 5 | Dashboard · **Sales** (sales, payments) · **Companies** · **Cash** · Profile |
| Owner | 5 | Dashboard · Operations · Sales · People · Profile |

Two routes move by role rather than being hidden: `/cash` is the owner's reconciliation queue under People and the field roles' own handover as its own tab, and `/contracts` is the dispatcher's own AMC tab and an Operations entry for the owner. Everything else is the same map with unreachable groups removed.

**Cash gets its own tab for the field roles rather than a row inside Profile.** It is touched once a day, at the end of a shift, by someone tired and wanting to leave; a screen behind two taps at that moment is a screen that gets skipped, and a skipped handover is precisely the `missing_submission` row the owner's queue exists to catch. The same argument applies with more force to the sales rep, whose cash is rare — a path nobody exercises is a path nobody notices is broken.

The owner's dashboard shows four figures — open jobs by status today, cash awaiting confirmation, month-to-date completion revenue, total outstanding company dues — and two charts, jobs per day over thirty days and revenue per week over twelve. Every one reads an existing view. Stating them here is what stops the dashboard becoming a design conversation at the start of Phase 4.

---

## 9. Design system

Light mode only for now. If dark mode is added later, the contrast levels below were chosen for sunlight legibility rather than aesthetics — softening the slate or lightening the muted greys because it looks harsh on a monitor would be applying the desk view to a decision made for the yard.

**Palette.** Slate `#16202B` base, `#5A6B7C` muted, warm white `#FDFDFB` surfaces, `#F2F4F7` for dense desktop zones.

The accent is safety yellow `#F2C200`, taken from the vernacular of the work — hard hats, lockout tags, cable markers — and it stays readable in direct sunlight where a mid-tone blue disappears. It appears on exactly two things: the primary action and the active state. The moment it decorates a third, it stops meaning anything.

Status colours are read off UPS front panels, so the card communicates state before anyone reads a word: `#0F8A5F` completed, `#D98A00` en route, `#F2C200` in progress, `#B3261E` cancelled.

**Language.** English only, and that is a decision rather than an omission — all fourteen staff read it comfortably. Numbers still format as `en-IN`, so a lakh renders `1,00,000` and not `100,000`. If the language ever changes the cost is every screen, so it is worth revisiting before Phase 1 rather than after.

**Type.** IBM Plex Sans throughout, Condensed for large dashboard figures. Drawn for engineering contexts, genuinely good tabular figures for job numbers and amounts, and not the family every app defaults to. Open licensed. One family, two widths.

**Layout.** Single column with actions in the thumb zone; tap targets at 52px, assuming gloves and a moving vehicle. Job cards carry a 4px status rail on the leading edge, square-cornered — it reads like a physical work docket and is legible across a workshop.

The one rule that matters for the owner's dual layout: **the same job is a card on a phone and a table row on desktop.** Not a card grid. Scanning 200 jobs needs rows, sortable columns and a scannable left edge. Forcing phone cards onto a desktop is the commonest way a React Native web build ends up feeling like a phone app in a browser window.

**Motion.** One orchestrated moment — the job status stepper filling as a job advances, with the completion sheet rising over it. Skeletons rather than spinners. Everything else answers a tap; no entrance animation on every card.

---

## 10. Build order

| Phase | What |
|---|---|
| 0 | Monorepo, schema, permission matrix, auth, tokens |
| 1 | Technician app — exercises idempotent writes and location while scope is small |
| 2 | Dispatcher — phone-native Job Logs and load-aware assignment |
| 2B | Service contracts — AMC agreements, visit generation, renewal view |
| 3 | Sales Rep — sales cards, balances, payments with proof upload |
| 4 | Owner — Android grouped nav, desktop rail, location console, cash queue |
| 5 | Hardening — OEM battery testing on the actual handsets staff carry |

Contracts sit after the dispatcher because generated visits need somewhere to be assigned, and before the sales rep because renewals are a thing a rep sells. `PLAN-EXECUTION.md` carries the schedule, the tests and the rollback for each.

---

## 11. What can still go wrong

**OEM background-task killing** is the dominant risk and cannot be simulated. It needs testing on the exact handset models your staff carry.

**Employee reaction to tracking** — managed by the consent screen, the visible notification and a fixed window rather than all-day surveillance, but it's a conversation with the company, not just a feature.

**Dispatcher Job Logs on a phone** is the one screen where the phone-first decision costs something real. Worth prototyping before building.
