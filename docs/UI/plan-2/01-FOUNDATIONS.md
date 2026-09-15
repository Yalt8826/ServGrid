# Foundations — Tokens

Extends `PLAN.md` §9 and `PLAN-FRONTEND.md` §7. Nothing here overrides them; where this document adds a value, it is because the parent left it unspecified.

Single source: `packages/shared/theme`. Imported by both apps so the owner's web build and the technician's APK cannot drift.

---

## 1. Colour

### 1.1 Base

```ts
slate:        '#16202B'   // base text, dark surfaces
muted:        '#5A6B7C'   // secondary text, icons
surface:      '#FDFDFB'   // warm white — app background
surfaceDense: '#F2F4F7'   // dense zones, table stripes
border:       '#DDE2E8'
accent:       '#F2C200'   // safety yellow
onAccent:     '#16202B'   // yellow is light — text on it is slate, never white
```

### 1.2 The slate scale

`PLAN.md` gives two greys. Real interfaces need a ramp — for disabled text, dividers, skeletons and pressed states — and deriving it from the base keeps everything in one family rather than introducing stray greys.

| Token | Value | Use |
|---|---|---|
| `slate.900` | `#16202B` | Body text, headings |
| `slate.700` | `#2C3948` | Dark surfaces, pressed dark |
| `slate.500` | `#5A6B7C` | Secondary text, icons (= `muted`) |
| `slate.400` | `#7C8B9A` | **Placeholders, the stale dashed inset** — the lightest slate that clears 3:1 on both backgrounds |
| `slate.300` | `#9AA8B5` | Disabled text **only** |
| `slate.200` | `#DDE2E8` | Borders, dividers (= `border`) |
| `slate.100` | `#F2F4F7` | Dense zones, stripes (= `surfaceDense`) |
| `slate.050` | `#F8FAFB` | Pressed state on light surfaces |

**Skeletons use `slate.100`.** Static, no shimmer (see `02-MOTION.md` §7).

### 1.3 Status

From `PLAN.md` §9, plus the two the parent left implicit:

| Status | Colour | Note |
|---|---|---|
| `completed` | `#0F8A5F` | |
| `en_route` | `#D98A00` | |
| `in_progress` | `#F2C200` | **Same as accent — deliberate.** An in-progress job *is* the active state |
| `cancelled` | `#B3261E` | |
| `unassigned` | `#5A6B7C` | The absence of a state, not a state |

**`overdue` is deliberately not in this table.** It is a filter, not a status (`PLAN-DATA-MODEL.md` §3.4) — an overdue job is still `assigned` or `in_progress`, and it keeps that rail. Listing it beside the statuses is how it ends up in a `StatusPill`, and then a job reads as *Overdue* with no indication of whether anyone is on their way to it. It is a chip: `feedback.danger`, **outlined, never filled**, pinned with the other chips in `PLAN-FRONTEND.md` §8.

**The adjacency rule.** Because `in_progress` and `accent` are the same yellow, a status rail and a primary button must never sit adjacent without a spacing break of at least `space.4`. Two yellows touching makes both meaningless.

### 1.4 Semantic aliases

Screens reference these, never raw hex. This is what makes the accent lint rule enforceable.

```ts
text:        { primary: slate.900, secondary: slate.500, placeholder: slate.400,
               disabled: slate.300, onAccent: slate.900, onDark: surface }
bg:          { app: surface, raised: '#FFFFFF', dense: slate.100,
               pressed: slate['050'], dark: slate.900 }
line:        { default: slate.200, strong: slate.400, focus: slate.900,
               stale:   slate.400 }
feedback:    { success: '#0F8A5F', warning: '#D98A00',
               danger: '#B3261E', info: slate.500 }
```

### 1.5 Contrast floor

Sunlight legibility is the constraint, not WCAG minimums — WCAG AA is a *desk* standard.

**Every figure below is computed, not estimated.** An earlier draft carried approximations, and every one of them ran in the flattering direction — which is the specific way a contrast table becomes worse than no table, because it is consulted instead of a calculator.

| Content | Floor | Measured |
|---|---|---|
| Body text on `surface` | **7:1** | slate.900 on #FDFDFB — **16.16:1** |
| Secondary text on `surface` | 4.5:1 | slate.500 — **5.39:1** |
| Secondary text on `surfaceDense` | 4.5:1 | slate.500 — **4.98:1** |
| Placeholders, stale inset | 3:1 | slate.400 — **3.43:1** surface, **3.17:1** dense |
| Disabled text | — | slate.300 — **2.39:1**. Below 3:1, and that is a deliberate, bounded exception — see below |
| Text on accent | 7:1 | slate.900 on #F2C200 — **9.79:1** |
| Borders against surface | 3:1 | slate.200 — **1.28:1**. A divider, never an information carrier |

**`slate.300` is 2.39:1 and it is now used for one thing only.** The earlier draft reported ≈2.9:1 — half a point optimistic — and used the token for disabled text, placeholders *and* the stale dashed inset. Two of those three are load-bearing: a placeholder tells you what a field wants, and the dashed inset is how a technician sees a write still on its way. Neither survives direct sun at 2.39:1.

So they move to **`slate.400` `#7C8B9A`**, the lightest slate that clears 3:1 on both `surface` and `surfaceDense`. `slate.300` keeps disabled text alone, where WCAG explicitly exempts inactive controls and where low contrast is doing the communicating.

**Never place white text on the accent.** White on `#F2C200` is **1.68:1** and disappears entirely outdoors.

### 1.6 The status rail does not meet the non-text floor, and cannot

This is the awkward measurement, and burying it would be worse than stating it. WCAG 1.4.11 sets 3:1 for non-text content that carries information. Against `surface` / `surfaceDense`:

| Rail | Ratio | |
|---|---|---|
| `cancelled` `#B3261E` | 6.42 / 5.93:1 | ✅ |
| `completed` `#0F8A5F` | 4.28 / 3.95:1 | ✅ |
| `unassigned` `#5A6B7C` | 5.39 / 4.98:1 | ✅ |
| `en_route` `#D98A00` | **2.72 / 2.51:1** | ❌ |
| `in_progress` `#F2C200` | **1.65 / 1.53:1** | ❌ |

The 4px rail is this product's primary signature, on every job object at every density, and two of its five states are below the floor. The yellow is the worst and it is the *settled accent* — chosen in `PLAN.md` §9 for sunlight legibility as a **fill behind dark ink**, which it is excellent at (9.79:1), not as a mark on a white ground.

**The resolution is not to repaint a settled palette. It is that the rail is never the sole carrier of state.** Every job object pairs it with the status **word**, at `slate.900` on `surface` — 16.16:1, the highest contrast in the system. The rail is redundant reinforcement that makes state readable across a workshop when it is legible, and costs nothing when it is not. That is precisely the condition under which 1.4.11 does not apply.

Two rules follow, and they are not optional:

- **A rail never appears without its word.** Not on a card, not on a row, not in a table. If a layout is too tight for the word, it is too tight for the rail.
- **`in_progress` and `en_route` rails carry a 1px `slate.900` outer edge on the leading side** at `desk` density, where rows are 40 tall and the rail is the only thing separating two pale yellows in a long list.

---

## 2. Type

IBM Plex Sans; IBM Plex Sans Condensed for large figures. Loaded via `expo-font` behind the splash gate — no text renders in a fallback face.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `display` | 32 / 36 | Condensed 600 | Dashboard figures |
| `displayLg` | 44 / 46 | Condensed 600 | Owner desktop hero figures |
| `h1` | 22 / 28 | 600 | Screen titles |
| `h2` | 18 / 24 | 600 | Section headers, card titles |
| `body` | 16 / 22 | 400 | **Never below 16 for field text** |
| `bodyStrong` | 16 / 22 | 500 | Emphasis in body |
| `label` | 14 / 18 | 500 | Form labels, chips, tabs |
| `caption` | 13 / 16 | 400, `muted` | Timestamps, helper text |
| `mono` | 15 / 20 | 400, tabular | Job numbers, amounts, times |

### 2.1 Tabular figures are not optional

`fontVariant: ['tabular-nums']` on **every** number: job numbers, amounts, quantities, counts, times, durations, percentages.

Two reasons, both practical. Columns of money align, so a rep scanning a ledger sees magnitude by column position rather than by reading. And a live-updating figure — a pending badge counting down, a timer — does not jitter as digits change width. Proportional figures in a counter look broken in a way people notice without being able to say why.

### 2.2 Never

No text below 13px anywhere. No 300 weight. No letter-spacing on body text. No all-caps except in `label` on desktop table headers, where it is tracked +0.04em.

---

## 3. Space and size

4pt scale: `space.1` = 4 through `space.10` = 40, plus `space.12` = 48, `space.16` = 64.

| Token | Value | Rule |
|---|---|---|
| `tap.min` | **52** | `field` density. Gloves, moving vehicle |
| `tap.console` | 44 | `console` **secondary** controls only — see below |
| `tap.desk` | 36 | Pointer input |
| `hitSlop` | 8 | On every target under 52, always |
| `gutter.field` | 16 | Screen edge padding, phone |
| `gutter.desk` | 24 | |
| `thumbBar` | 72 | Height of the bottom action bar |

**`tap.console` is an amendment to `PLAN.md` §9's global 52px, and it should be read as one rather than absorbed.** §9 sets 52 for gloves and a moving vehicle; a dispatcher is seated, bare-handed, in good light, and scanning 200 rows, where bigger is genuinely slower. `PLAN-FRONTEND.md` §9 already permits 44 as a Job Logs fallback; generalising it to the role is the extension, and it is made here deliberately rather than silently.

The distinction that keeps it honest:

- **The primary target in `console` is the row itself, at 56pt** — comfortably above 52. Nothing about the dispatcher's main interaction is smaller than the field standard.
- **44 is the floor for secondary controls only** — filter chips, header actions, the multi-select toggle — each with 8pt hit slop, which puts the effective target back at 52.

This matters for more than tidiness: **it is what keeps the Job Logs prototype gate meaningful.** If "44pt console" were read as the row height, the documented fallback — a compact row at 44 — would be indistinguishable from the baseline, and the five-second test would have nothing to fall back *to*. Baseline is a two-line 56pt row; the fallback is a two-line 44pt row; the descope is the desktop build. Three distinct steps, in that order (`PLAN-EXECUTION.md` Phase 2).

### 3.1 The thumb zone

Primary actions live in the bottom 30% of the screen. The bottom action bar is a fixed 72pt surface with the primary action full-width inside it — reachable one-handed on a 6.7" handset held at the bottom.

**Nothing destructive lives in the thumb zone.** Cancel, void and delete live in the header or behind an overflow, because the thumb zone is where the hand rests and accidental contact is a real event in a moving van.

### 3.2 Radii

```
0  — job cards, status rails, table rows   (the docket)
4  — inputs, sheets, chips, buttons
8  — modal dialogs only
999 — avatars only
```

Square corners on job objects are a signature (`00-PHILOSOPHY.md` §5). Do not round them "to soften the look".

### 3.3 Density modes

One provider, read by every primitive:

```ts
type Density = 'field' | 'console' | 'desk';
```

| | `field` | `console` | `desk` |
|---|---|---|---|
| Row height | 88 (card) | 56 | 40 |
| Tap target | 52 | 44 | 36 |
| Body size | 16 | 15 | 14 |
| Gutter | 16 | 12 | 24 |
| Vertical rhythm | 12 | 8 | 6 |

Screens never set density. `NavShell` sets it from role and platform, exactly once — the same place `PLAN-FRONTEND.md` §3 puts the single platform branch.

---

## 4. Elevation

**Three levels, and on Android they are not shadows.**

| Level | Android / field | Web / desk |
|---|---|---|
| `flat` | 1px `line.default` border | Same |
| `raised` | Border + `bg.raised` | Border + `0 1px 2px rgba(22,32,43,0.06)` |
| `overlay` | Border + scrim `rgba(22,32,43,0.45)` | Same + `0 8px 24px rgba(22,32,43,0.12)` |

Android shadow rendering on lists is expensive and inconsistent across the OEMs in the roster, and `elevation` interacts badly with `overflow`. Borders are cheaper, sharper in sunlight, and read more like a printed docket — the performance-forced choice is also the better-looking one.

**Never more than one `overlay` at a time.** A sheet over a dialog over a menu is a bug.

---

## 5. Iconography

**Lucide**, via `lucide-react-native`. Open licence, consistent 2px stroke, wide coverage.

| Context | Size | Stroke |
|---|---|---|
| Inline with body | 20 | 2 |
| Standalone action | 24 | 2 |
| Thumb bar | 28 | 2.25 |
| Table row, desk | 16 | 1.75 |

**Rules:**

- **Never icon-only for anything that changes data.** Icon plus label. A gloved technician mis-tapping an unlabelled icon that cancels a job is a real cost; the eight pixels saved are not.
- Icon-only is allowed for: back, close, search, overflow, call. Universal and non-destructive.
- Icons inherit `text.secondary` unless they are inside a primary button.
- No two-tone or filled variants. One stroke weight throughout.
- **Status is never communicated by icon alone** — always the rail, the colour and the word.

---

## 6. Numbers, dates, currency

Locale `en-IN` throughout (`PLAN.md` §9).

| Kind | Format | Example |
|---|---|---|
| Money | `₹` + Indian grouping, 2dp only when non-zero paise | `₹1,00,000` · `₹4,250.50` |
| Money in input | No symbol, no grouping while typing; group on blur | |
| Job number | Mono, full | `JC-2627-00042` |
| Time | 24-hour | `14:32` |
| Date, this year | `D MMM` | `14 Mar` |
| Date, other year | `D MMM YYYY` | `14 Mar 2027` |
| Relative | Under 1h only, then absolute | `6 min ago`, then `14:32` |
| Duration | Compact | `2h 15m` |

**Relative time stops at one hour.** "3 hours ago" forces arithmetic; `11:20` does not. The health chip is the one exception — "last ping 6 min ago" is the whole point of it.

---

## 7. Field constraints, restated as rules

Every one of these is a design constraint with a physical cause.

| Condition | Rule |
|---|---|
| Gloves | 52pt targets, 8pt hit slop, no gestures requiring precision under 44pt |
| Direct sun | 7:1 body contrast, no low-contrast greys, no blur, no translucency |
| One hand | Primary actions bottom 30%, nothing critical in the top corners |
| Moving vehicle | No drag-to-confirm, no long-press for a primary action, generous targets |
| 2G / no signal | Optimistic writes, never a blocking spinner, pending badge always visible |
| 14% battery | No continuous animation, no blur, nothing animating off-screen |
| Customer waiting | The complete sheet is one screen, no wizard, no page two |

---

**Next:** `02-MOTION.md`
