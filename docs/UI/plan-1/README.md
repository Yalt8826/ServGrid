# ServiceGrid UI Design Plan

> **Superseded in part by the online-only decision (2026-09-15, `docs/decisions/2026-09-15-online-only.md`).** This is a historical record. Its offline mirror, outbox, `tech.offline` flag, pending-sync UI and sync endpoints were removed in Phase ON (`docs/implementation/PHASE-ON-ONLINE.md`); where it disagrees with the `PLAN*.md` documents, the plans win.

**The position in one paragraph.** This app is a work instrument for a UPS/battery servicing
business: every screen answers "what is true about the work right now" — what is synced, how old
a figure is, what a press will do with no signal, whether a tap spends the customer's money.
The settled visual language lives in `PLAN.md` §9 and `PLAN-FRONTEND.md` §7 (safety yellow,
slate, IBM Plex); this plan does not re-skin it — it completes it into a buildable system:
measured contrast floors, a state model that includes the offline and rejection states, the
locked motion budget made falsifiable, and per-role screen specifications derived from each
role's physical conditions.

Companion to [PLAN.md](../../PLAN.md), [PLAN-FRONTEND.md](../../PLAN-FRONTEND.md),
[PLAN-DATA-MODEL.md](../../PLAN-DATA-MODEL.md), [PLAN-BACKEND.md](../../PLAN-BACKEND.md) and
[PLAN-EXECUTION.md](../../PLAN-EXECUTION.md); plan-wide gaps live in
[PLAN-GAPS.md](../../PLAN-GAPS.md). Where those documents settle a decision, the tables below
cite them; where this plan adds a value they left unspecified, it is marked **[resolves]**.

## Hard constraints (nothing here overrides them)

1. **Platform**: monorepo — `apps/mobile` (Expo Router, Android primary for all roles, web build
   for the owner), `apps/api` (Fastify + Postgres), `packages/shared` (types, zod, permission
   matrix). → `PLAN.md` §2
2. **One route tree, role-gated**: routes differ by reachability, guarded by the same `permit()`
   the API uses — a screen the API would 403 cannot exist. → `PLAN-FRONTEND.md` §2
3. **Offline outbox is a technician and sales-rep feature.** Dispatcher and owner are
   online-only with explicit error states — offline need is independent of platform, and the two
   facts must not conflate. → `PLAN.md` §1, `PLAN-FRONTEND.md` §4
4. **Nothing blocks on the network; no path silently discards queued work.** Optimistic writes,
   persistent pending badge, rejection banners with the server's message verbatim, logout
   blocked while rows are queued, rejected rows survive logout keyed to the employee.
   → `PLAN.md` §6, `PLAN-FRONTEND.md` §5
5. **Server-assigned numbers**: a card shows "Pending sync" where the number goes until sync
   returns one — never a fake local number. → `PLAN-FRONTEND.md` §5
6. **Tracking**: technicians and sales reps, Mon–Sat 09:00–19:00 IST (filter, don't schedule),
   consent screen at first login, foreground-service notification, permission ladder
   (foreground → background → battery → OEM autostart), four-state TrackingHealthChip, job
   alerts as the chip's fourth state. → `PLAN.md` §7, `PLAN-FRONTEND.md` §6
7. **Dispatchers never see money** — schema-separated (`job_completions`), API-refused,
   `MoneyGate`-rendered. Sales rep contract views never show contract value.
   → `PLAN.md` §4/§5, `PLAN-FRONTEND.md` §8
8. **Money interactions**: one amount field at completion; discount is a disclosure with a
   mandatory reason; prepaid contract visits hide the amount field entirely; in-warranty charge
   raises exactly one confirmation; parts never affect the amount and never show a subtotal;
   cash handover is one declaration per employee per day; variances are caught by the owner's
   queue with `missing_submission` first. → `PLAN.md` §4, `PLAN-FRONTEND.md` §9
9. **Settled visual language** (`PLAN.md` §9, `PLAN-FRONTEND.md` §7): safety yellow `#F2C200` on
   exactly two things (primary action, active state); status colours read off UPS front panels;
   IBM Plex Sans + Condensed; 4pt scale; 52px targets; radii 0 (job cards) / 4 (inputs, sheets);
   4px square status rail on the leading edge; light mode only.
10. **Motion** (`PLAN-FRONTEND.md` §7): one orchestrated moment — the job status stepper filling
    with the completion sheet rising over it. Skeletons, never spinners. No entrance animation
    on cards or lists. Reanimated; reduced motion respected.
11. **Dual-layout rule**: the same job is a card on a phone and a table row on desktop — never a
    card grid; review checkpoint on every owner screen. → `PLAN.md` §8, `PLAN-FRONTEND.md` §7
12. **English only, en-IN numbers** — both recorded decisions. → `PLAN.md` §9
13. **Dispatcher Job Logs on a phone is a prototype gate** — decide with real volume before
    Phase 2. → `PLAN.md` §11, `PLAN-FRONTEND.md` §11-1
14. **This plan's own numbers** — every contrast ratio in `01-FOUNDATIONS.md` was computed with
    the WCAG 2.x relative-luminance formula on 2026-09-06 against the settled palette.

## Phase alignment

| Design deliverable | Lands with build phase (`PLAN-EXECUTION.md`) |
|---|---|
| Tokens + contrast floors (extends `PLAN-FRONTEND.md` §7) | Phase 0 — app shell, fonts, design tokens |
| Shared screens (login, consent, change password) | Phase 0 |
| Technician screens, outbox UX, health chip, permission ladder | Phase 1 |
| Dispatcher screens + Job Logs prototype verdict | Phase 2 (prototype in Phase 1 spare) |
| Contract screens (chips, prepaid copy, cancel-sheet warning) | Phase 2B |
| Sales rep screens (sales, payments, companies, renewals) | Phase 3 |
| Owner phone + desktop, location console, cash queue | Phase 4 |
| Sunlight / glove / device-matrix verification | Phase 5 |

## Documents

| File | Contains |
|---|---|
| [00-PHILOSOPHY.md](00-PHILOSOPHY.md) | Position, reference objects, non-adoption list, resolved tensions, the test |
| [01-FOUNDATIONS.md](01-FOUNDATIONS.md) | Measured contrast floors, type ramp, spacing/targets, density, icons, formats |
| [02-MOTION.md](02-MOTION.md) | The locked orchestrated moment, interaction-echo budget, skeleton spec, perf budget |
| [03-COMPONENTS.md](03-COMPONENTS.md) | State matrix, primitives + domain components (merges `PLAN-FRONTEND.md` §8), never-lists |
| [04-TECHNICIAN.md](04-TECHNICIAN.md) | TEC-01…07 — dashboard, jobs, detail, complete/cancel sheets, handover, profile |
| [05-DISPATCHER.md](05-DISPATCHER.md) | DIS-01…06 — dashboard, dispatch form, job logs, customer, contracts, profile |
| [06-SALES.md](06-SALES.md) | SAL-01…07 — dashboard, sales, payments, companies, contracts, handover, profile |
| [07-OWNER.md](07-OWNER.md) | OWN-01…14 — both layouts, location console, cash reconciliation queue |
| [08-SHARED-SCREENS.md](08-SHARED-SCREENS.md) | Auth, consent, rejection/logout UX, permission ladder, nav shell, a11y |

## Open questions (design-specific; plan-wide gaps live in `PLAN-GAPS.md`)

| # | Question | Impact | Needed by |
|---|---|---|---|
| DQ-1 | Icon set: none is named in the parent plans. Propose `@expo/vector-icons` MaterialCommunityIcons (JS-only) at 24/20/16 with the never-icon-only rule (`01-FOUNDATIONS.md` §7). | Tab bar, chips, buttons | Phase 0 |
| DQ-2 | Status rail contrast: the yellow rail (1.65:1) and amber rail (2.72:1) sit below the 3:1 non-text floor (`01-FOUNDATIONS.md` §1.3). Proposal: rails always paired with a StatusPill, never the sole carrier; alternative is darkening the two colours, which touches the settled palette. | JobCard/JobRow, WCAG 1.4.11 | Phase 1 |
| DQ-3 | Filled status pills: white ink passes only on red (6.54:1); on green it is 4.36:1 (marginal fail) and on amber 2.77:1. Proposal: slate ink on yellow/amber fills, white only on red, green pills move to soft-fill + dark ink. | StatusPill, badges | Phase 1 |
| DQ-4 | Photo thumbnails offline: completed jobs queue photo URIs locally; confirm thumbnails render from local files while queued (vs a placeholder) so the completion review never lies about what was attached. | Complete sheet review | Phase 1 |
