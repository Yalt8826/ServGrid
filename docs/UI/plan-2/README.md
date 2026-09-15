# ServGrid — UI Design Plan

Extends `docs/PLAN.md` §8 and §9 and `docs/PLAN-FRONTEND.md`. Nothing here overrides them; where this set adds a value, it is because the parent left it unspecified.

## The set

| File | What it settles |
|---|---|
| `00-PHILOSOPHY.md` | The design position, the reference points, the non-adoption list, and how components stay fresh |
| `01-FOUNDATIONS.md` | Colour scale, contrast floors, type ramp, spacing, density modes, elevation, icons, number formats |
| `02-MOTION.md` | Duration and easing tokens, three springs, the six signature moments, haptics, the performance budget |
| `03-COMPONENTS.md` | The seven states, every primitive and domain component, the five signature "tells" |
| `04-TECHNICIAN.md` | 7 screens — dashboard, jobs, detail, complete, cancel, handover, profile |
| `05-DISPATCHER.md` | 6 screens — including Job Logs, the screen phone-first actually costs something |
| `06-SALES-REP.md` | 6 screens — sales, payments, companies, handover |
| `07-OWNER.md` | 9 areas across two layouts — dashboard, cash queue, location console, jobs, employees |
| `08-SHARED-SCREENS.md` | Login, consent, permission ladder, the five universal states, nav shell, accessibility |

Read `00` and `02` first. They contain the arguments; the rest is application.

---

## The position, in one paragraph

**It should feel like well-made equipment, not like software.** The reference points are a Fluke multimeter, a UPS front panel and a carbon-copy job docket — instruments that are unambiguous in bad light, legible across a room, and satisfying the way a well-damped switch is satisfying. The central claim is that **smoothness is not animation; smoothness is the absence of waiting**, which the online architecture has to earn with an in-memory cache and honest busy states, and the UI's job is to make visible. So motion is never decoration: it answers *where did this come from*, *what changed*, or *is my finger still driving this*, and anything doing none of those is deleted.

---

## Seven principles

1. **Instant is the aesthetic** — every tap visibly changes something in under 100ms.
2. **Motion explains, or it doesn't run** — origin, state, or continuity.
3. **Physical believability** — springs when a finger is involved, curves when the system decided.
4. **Scarcity is the luxury** — yellow on two things, one hero moment per screen.
5. **Battery is a design material** — decorative GPU load is a functional bug on the device that also carries the tracking service.
6. **Designed for the worst moment** — every screen spec names its own.
7. **One component set, three densities** — `field`, `console`, `desk`.

---

## The six signature moments

Enough to feel crafted, few enough to stay honest.

1. **Status stepper fill** — the hero, 520ms, the only orchestrated moment
2. **Completion sheet rise** — from the button that opened it, stepper still visible above
3. **Sending → accepted** — the visible proof that work reached the server (replaced the pending-badge drain, 2026-09-15)
4. **Long-press pick-up** — haptic fires before the finger lifts
5. **Assignment picker load bars** — the only other stagger in the product
6. **Rejection banner drop** — the only assertive motion, because the alternative is a technician not noticing

---

## The five tells

Any screenshot should be identifiable from these alone:

- The **4px square status rail** on every job object, at every density
- **Tabular numerals** on every number
- The **docket header** — job number in mono, top right, always the same place
- **Active state as a 2px accent underline**, never a filled pill
- **Square corners** on job objects, 4pt on controls

None depends on a trend, so none can date.

---

## How this reconciles with `PLAN.md` §9

`PLAN.md` §9 restricts motion: *one orchestrated moment, skeletons rather than spinners, everything else answers a tap, no entrance animation on every card.* The brief for this set asked for something smooth, interactive and heavily animated.

Those are reconcilable. **`PLAN.md` restricts orchestration, not responsiveness.** One multi-element staged hero animation — the stepper — stands. But an app where every tap answers with a spring, where sheets carry momentum from the finger that threw them, where a refused submit lands with weight and a long-press physically picks a card up, is *more* animated than one with decorative fades everywhere, and every frame of it is doing work.

The full argument is in `00-PHILOSOPHY.md` §6.

---

## Hard constraints inherited from the parent plans

Non-negotiable, and each traceable to a decision already taken:

- Safety yellow `#F2C200` on **exactly two things** — the primary action and the active state. Enforced by lint.
- **Light mode only.** The contrast levels were chosen for sunlight; if dark mode ever arrives, it does not soften them.
- **IBM Plex Sans**, Condensed for large figures. Tabular figures everywhere numbers appear.
- **52pt tap targets** in `field` density. Gloves, moving vehicle.
- **The same job is a card on a phone and a table row on desktop.** A review checkpoint on every owner screen.
- **Dispatchers never see job money** — no completion figures. Verified by CI, not by memory. (The AMC price is theirs by decision, 2026-09-15.)
- **No blur, no shadows on Android list items, no shimmer, no continuous animation.**
- **English only**, `en-IN` number formatting.

---

## Phase alignment

| Phase | UI deliverable |
|---|---|
| 0 | Tokens, primitives, the seven states, motion tokens, `NavShell`, **a rendered component gallery** |
| 1 | Technician — 7 screens, the stepper, the permission ladder (built with an outbox UI, removed 2026-09-15) |
| 2 | Dispatcher — 6 screens, Job Logs at `console` density, multi-select |
| 2B | AMC — the dispatcher's AMC tab and form, the dispatch AMC option, the technician's Free/Charge choice |
| 3 | Sales rep — 7 screens, online, with sale-line discounts and photo-only payment evidence |
| 4 | Owner — both layouts, `DataTable`, the map, the cash queue |
| 5 | Field validation — sunlight legibility, gloved tap accuracy, **dropped frames on the roster's slowest handset** |

The Phase 0 component gallery is what makes the rest enforceable. Without it, `loading` and `error` get reinvented per screen and the app is four different products by Phase 4.

---

## Open questions

| # | Question | Needed by |
|---|---|---|
| 1 | Job Logs at `console` density must pass the 5-second test on a real dispatcher's phone at 200+ jobs. The 44pt fallback and the web descope are already budgeted. | Phase 1 prototype |
| 2 | OEM autostart walkthroughs need **real screenshots per vendor** — they cannot be written from documentation, and they block the ladder's last step. | Phase 1, needs the handsets |
| 3 | Map tile source: self-hosted raster vs. a free tier with attribution obligations. | Before Phase 4 |
| 4 | Whether React Native Web carries `DataTable` and the rail acceptably. Spike on day 3 of Phase 4, not week 4. | Phase 4 day 3 |
| 5 | Consent screen copy should be read by an actual technician before it ships. It is the highest-stakes copy in the product and the one most likely to be written for a lawyer instead. | Before Phase 1 |


---

## Amended by the second gap pass

`PLAN-GAPS.md` Part IV read this set against the API and the schema rather than against itself. Nine things here changed; the position, the principles and the six moments did not. Worth knowing before reading the screen specs, because each is now specified differently from a first reading:

| Where | Change |
|---|---|
| `04-TECHNICIAN.md` | **Four tabs, not three** — Cash is its own tab. *Parts used* and *Equipment fitted* are **one list** with a per-line "add to this site's equipment" checkbox. A rejected card keeps its real status rail. The declaration is amendable while `submitted` |
| `05-DISPATCHER.md` | *Needs attention* no longer lists outbox rejections — they exist only on the handset and the server has nothing to serve |
| `06-SALES-REP.md` | Four tabs. Payment modes on **two rows**; five segments do not fit 360dp |
| `07-OWNER.md` | The cash queue defaults to a range **ending yesterday**; today's flags are not final until the field has synced |
| `08-SHARED-SCREENS.md` | Tab counts corrected to 4 / 3 / 4 / 5. Consent gates the **location task, not the app**. Density row heights are `minHeight` |
| `03-COMPONENTS.md` | `MoneyGate` takes a required `action` — defaulting to `read` would hide the amount field from the technician filling it in. The stepper has a `cancelled` rendering. Sheets leave the stepper visible, which is ~140pt, not 64 |
| `01-FOUNDATIONS.md` | `overdue` removed from the status colour table — it is a filter, not a state, and listing it there is how it becomes a `StatusPill`. **All contrast figures recomputed**; new `slate.400` for placeholders and the stale inset; §1.6 states the two status rails that fail the 3:1 non-text floor and resolves them. `console` 44pt restated as an amendment with the row as the 56pt target |

**Amended again by the online-only decision (2026-09-15).** No outbox, mirror, pending badge or `stale` state for any role; one full-screen *No connection* treatment everywhere; the sales rep has **five** tabs; payments are photo-only; sale lines carry list price and discount. The rows above predate that and are kept as the record of the gap pass.

`UI/COMPARISON.md`'s audit of this set was applied at the same time — the contrast figures, the missing owner Dispatch and Customers specs, the `none` collection mode, and the `console` density amendment. Its verdict is worth keeping in view: **the plan with the stricter stated standard was the one that had not checked.** The figures now say *measured*, and the two status rails that fail the non-text floor are named in §1.6 rather than smoothed over.

The one thing here that is a design change rather than a correction is the parts/equipment merge. The rest are joins — between this set and the parent plans, and between this set and its own numbers — that did not line up.
