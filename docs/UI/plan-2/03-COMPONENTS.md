# Component Design

Extends the inventory in `PLAN-FRONTEND.md` §8. Each component is specified as **anatomy → states → motion → never**.

## The seven states

Most interfaces look dead because only the default state was drawn. Every interactive component in this app is specified in all seven, and the last two are the ones design systems usually omit and this app needs everywhere.

| State | Meaning |
|---|---|
| `default` | Resting |
| `pressed` | Finger down |
| `focused` | Keyboard/pointer focus (desk) |
| `disabled` | Cannot act, and it is obvious why |
| `loading` | Acting, not yet resolved |
| `empty` | No content, with a next action |
| `error` | Failed, with what to do |

An eighth state, **`stale`** — local data the server had not confirmed, drawn as a dashed inset plus *Pending sync* — existed while technicians and reps worked offline. It was retired on 2026-09-15 (`docs/decisions/2026-09-15-online-only.md`): nothing is ever pending now.

**The 2px `slate.400` dashed inset survives with one meaning only — a write on its way.** `JobCard` and the job detail header carry it, with *Sending…*, while a submit is in flight.

---

## Primitives

### `Button`

**Anatomy.** Label (`label`, 15/18, weight 600) · optional leading icon 20 · height 52 `field` / 44 `console` / 36 `desk` · radius 4 · full-width in the thumb bar, hugging elsewhere.

**Variants**

| Variant | Fill | Text | Use |
|---|---|---|---|
| `primary` | `accent` | `slate.900` | **The one accented action per screen** |
| `secondary` | transparent, 1px `line.strong` | `text.primary` | Alternative action |
| `ghost` | none | `text.secondary` | Tertiary, in headers |
| `danger` | transparent, 1px `feedback.danger` | `feedback.danger` | Destructive. Never filled |

**States.** `pressed`: scale 0.97, `spring.press`, on touch-*down*. `disabled`: `slate.100` fill, `text.disabled`, no press response — and **always paired with a `caption` saying why**. `loading`: label stays, a 16px indeterminate bar draws under it; width never changes.

**Never.** Never disable the primary action for a network reason (`PLAN-FRONTEND.md` §9). Never more than one `primary` on screen. Never a filled danger button — a red slab invites the tap it is warning about.

### `TextField` / `MoneyField`

**Anatomy.** Label above (`label`, `text.secondary`) · input 52 tall, 1px `line.default`, radius 4 · helper or error below (`caption`).

**`MoneyField`** — `mono` tabular, `en-IN` grouping applied on blur and stripped while typing, no `₹` inside the input (the prefix sits outside, `text.secondary`), numeric keypad, no spinner controls.

**States.** `focused`: border → `line.focus` 2px, `quick` 140ms, no glow. `error`: border `feedback.danger`, message replaces helper, **shake is banned** — the message is the signal. `disabled`: `slate.050` fill.

**Never.** No floating labels — they shrink to 11px and vanish in sunlight. No placeholder-as-label. No inline validation while typing; validate on blur and on submit.

### `Sheet`

**Anatomy.** Grab handle 32×4 `slate.400` · optional title row · scrollable content · fixed bottom action bar (72) that never scrolls away.

**Motion.** Rises from its trigger, `considered` 300ms `spring.sheet`. Drag to dismiss with `spring.snap`; velocity-aware so a flick dismisses early. Scrim `rgba(22,32,43,0.45)`, 220ms.

**Never.** Never full-screen. Leave **at least 64pt** of the screen behind visible — and on the job detail, enough to keep the header and the `StatusStepper` above the sheet, which is roughly 140pt. “Leave 64pt” and “the stepper stays visible” (`02-MOTION.md` §5.2) are not the same number, and the second is the one that matters: the point of the context strip is that the technician can see *which job he is completing*, and a strip showing the top of a screen title does not do that. Never nested. Never dismiss on scrim tap when the sheet holds unsaved input; ask.

### `Banner`

**Anatomy.** Full-bleed, 4px leading rail in the semantic colour · icon 20 · message (`body`) · up to two text actions · optional dismiss.

Used for a refused submit (`PLAN.md` §6) and a failed read. Message text is the **server's `message` verbatim** — the API writes it for the technician holding the phone (`PLAN-BACKEND.md` §3.1).

**Motion.** Drops with weight, `spring.sheet`. `Warning` haptic. Does not auto-dismiss.

**Never.** Never a toast for an error. Toasts vanish; the technician was in a basement and did not see it.

### `Skeleton`, `Chip`, `EmptyState`, `ConfirmDialog`

- **`Skeleton`** — `slate.100`, static, 200ms delay, 400ms minimum, exact geometry of the real content.
- **`Chip`** — 32 tall (`field` 36), radius 4, `label`. Selected: `slate.900` fill, `surface` text — **not accent**; the accent is reserved. `Selection` haptic.
- **`EmptyState`** — one line of `body` stating the situation, one `secondary` button offering the next action. **No illustration.**
- **`ConfirmDialog`** — only for irreversible actions with no undo. Destructive action on the right, `danger` variant. If an undo is possible, ship the undo instead.

---

## Domain components

### `JobCard` — `field` density

The most-seen object in the product and the primary signature.

```
┌─┬──────────────────────────────────────┐
│▌│ Kormangala · 3rd Block      JC-…0042 │  ← rail 4px, customer h2, number mono
│▌│ Battery swap · UPS 850VA             │  ← service + unit, body
│▌│ 14:30    [In warranty] [AMC 3 of 4]  │  ← time mono, chips
│▌│ ● In progress                        │  ← status pill
└─┴──────────────────────────────────────┘
```

**Anatomy.** 4px square status rail, full height, leading edge · 88 tall minimum, grows for chips · 1px border, **no shadow** · radius 0.

**Chips it may carry:** `OverdueChip` (outlined `feedback.danger`), `WarrantyChip` (muted), `ContractChip` (muted). Colours pinned in `PLAN-FRONTEND.md` §8 — **none of them yellow**, because the rail may already be `in_progress` yellow and two yellows adjacent cancel out.

**States.** `pressed`: `bg.pressed`, 90ms, no scale. `sending`: dashed inset + *Sending…* while a status change or completion is in flight — **never a fabricated local number**; numbers arrive in the server's response (`PLAN.md` §6). `selected` (multi-select): scale 0.97, border `slate.900` 2px.

**Motion.** No entrance animation on load. Entrance only when a refetch delivers a new job: 140ms height + opacity. Status change: rail cross-fades over 520ms with the stepper.

### `JobRow` — `console` / `desk`

The same job, 56 tall (`console`) or 40 (`desk`). Keeps the 4px status rail as a left edge — that shared edge is what makes the card and the row read as one object at two densities, and it is why the owner's desktop table does not feel like a different product.

Columns (`desk`): rail · number · customer · service · technician · scheduled · status. Sortable, sticky header, virtualised via FlashList.

### `StatusStepper`

The hero (`02-MOTION.md` §5.1). Horizontal, four nodes: Assigned → En route → In progress → Completed. Complete segments in the status colour, pending in `slate.200`. Current node ringed.

`en_route` is skippable (`PLAN-BACKEND.md` §6.1) and the stepper renders it dimmed-but-present rather than removing it — a technician who went straight to work should see he skipped a step, not a stepper that silently changed shape.

**Cancelled is a fifth rendering, not a fifth node.** `cancelled` is reachable from any non-terminal state, so it is not a position on the line. The stepper freezes at the node the job reached, everything after it goes `slate.200`, and a `cancelled`-coloured terminal cap replaces the trailing segment with the word **Cancelled** beneath it. The frozen position is the information — *cancelled after arriving* and *cancelled before setting off* are different events, and a stepper that collapsed to a single red state would lose the difference. No animation: nothing was achieved, so nothing fills.

### `StatusPill`

**Anatomy.** A 8px dot in the status colour · the status **word** in `slate.900` · 1px `line.default` border · `surface` ground · radius 4. Reads from the status colour map; never takes a raw colour.

**There is no filled variant, and the arithmetic is why.** No single ink works across the five status fills:

| Fill | white ink | `slate.900` ink |
|---|---|---|
| `cancelled` `#B3261E` | **6.54:1** ✅ | 2.52:1 ❌ |
| `completed` `#0F8A5F` | 4.36:1 ❌ | 3.78:1 ❌ |
| `en_route` `#D98A00` | 2.77:1 ❌ | **5.95:1** ✅ |
| `in_progress` `#F2C200` | 1.68:1 ❌ | **9.79:1** ✅ |

Red demands white; yellow and amber demand slate; **green passes with neither**. A filled pill set would therefore need per-status ink rules, one of which is illegible whichever way it goes — and the failure lands outdoors, on the screen a technician reads at arm's length in a yard.

The dot-and-word pill sidesteps all of it: the word is always `slate.900` on `surface` at **16.16:1**, and the dot is decoration beside a word rather than the carrier of the meaning. It also happens to look more like a docket than a filled badge does, which is the second time in this system the contrast-forced choice and the aesthetic choice agree (`01-FOUNDATIONS.md` §4).

**Never.** Never filled. Never colour without the word — the same rule as the rail (`01-FOUNDATIONS.md` §1.6). Never a raw hex.

### `TechnicianPicker`

**Anatomy.** Per row: name (`body`) · load count (`mono`) · **inline load bar** · availability dot.

`PLAN.md` §8: never a bare dropdown of eight names. The bar is the decision-support — relative load is legible before a number is read.

**Motion.** Bars draw in staggered 30ms, 260ms each (`02-MOTION.md` §5.5).

**Never.** Never sort alphabetically by default — sort by load ascending, so the answer is at the top.

### `PartsList`

Collapsed by default under "Parts used". Repeating row: product picker · quantity · optional serial.

**Never shows a subtotal.** Ever. A technician who sees a parts total will assume the app is computing the bill, and the amount he enters is unrelated (`PLAN-DATA-MODEL.md` §3.4). Sits **below** the amount field, never above.

### `NoConnectionGate`

Full-screen *No connection — ServGrid needs the internet. You'll be right back where you were.* over the authenticated stack, every role. **Rendered above the stack, never instead of it**, so a half-typed form is intact when the connection returns. Replaced `SyncBanner` + `PendingBadge` on 2026-09-15.

### `TrackingHealthChip`

Four states (`PLAN-FRONTEND.md` §6): green active · amber stale · red permission missing · amber notifications off. Red and amber are tappable and deep-link into the permission ladder at the failed step.

**Never** animate it. A pulsing red chip on the profile screen would run continuously on the device whose battery this app is trying to protect.

### `DataTable` — `desk` only, `.web.tsx`

Sortable, sticky header, virtualised, zebra stripes in `slate.100`, status colour on the left edge of every row. No native counterpart; never bundled into the APK.

### `MoneyGate`

Renders children only if `permit(role, 'job.money', <action>) !== 'none'`, and **the action is a required prop, not defaulted to `read`.**

That is the trap worth naming. A technician's `job.money` is *write-once at completion, no read afterwards* (`PLAN.md` §5), so `permit('technician', 'job.money', 'read')` is `none` — and a `MoneyGate` that assumes `read` would hide the amount field **on the complete sheet**, from the one person who has to fill it in. The component would be doing exactly what it was built to prevent, on the highest-stakes screen in the product, and it would look correct in review.

So: `<MoneyGate action="create">` around the complete sheet's amount and collection mode, `<MoneyGate action="read">` around anything that reads a figure back. Belt-and-braces over the API's schema separation — the server already will not send what it will not send — and this makes the absence visible in code review rather than implicit.

---

## Freshness: the five tells

Any screenshot of this app should be identifiable from these alone.

1. **The 4px square status rail** — on cards, rows, banners, at every density.
2. **Tabular numerals on every number.**
3. **The docket header** — job number in mono, top right, same place always.
4. **Active state as a 2px accent underline**, never a filled pill.
5. **Square corners on job objects**, 4pt on controls.

None depends on a trend, so none can date. Distinctiveness comes from consistency and precision rather than from an effect — which is the whole argument in `00-PHILOSOPHY.md` §5.

## The non-adoption list

Never, without a decision recorded in this file: blur or translucency · gradients · shadows on Android list items · shimmer · bouncy springs · filled destructive buttons · icon-only data-changing actions · floating labels · illustrated empty states · text under 13px · weight 300 · animated logos · pull-to-refresh platform spinners (tolerated until the UI overhaul).
