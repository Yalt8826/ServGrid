# 01 — Foundations

Makes `PLAN.md` §9 + `PLAN-FRONTEND.md` §7 concrete and measurable. Raw hex lives only in the
token source (`packages/shared/theme` / `apps/mobile/theme`); screens reference semantic names —
the ESLint rule forbidding literal `#F2C200` outside the theme is already decided, and §1.3
extends the same discipline to every status colour. All ratios computed with the WCAG 2.x
relative-luminance formula on 2026-09-06.

## 1. Colour — semantic aliases and measured floors

### 1.1 The settled palette, as aliases

| Alias | Value | Use |
|---|---|---|
| `text.primary` | slate `#16202B` | body and heading ink |
| `text.secondary` | muted `#5A6B7C` | secondary text, icons, unassigned status |
| `bg.surface` | warm white `#FDFDFB` | app background |
| `bg.dense` | `#F2F4F7` | dense desktop zones, table stripes |
| `line.default` | `#DDE2E8` | borders |
| `accent` | safety yellow `#F2C200` | **two uses only**: primary action, active state |
| `text.onAccent` | slate on yellow | never white on yellow (1.68:1 ❌) |
| `status.completed` | `#0F8A5F` | green |
| `status.enRoute` | `#D98A00` | amber |
| `status.inProgress` | `#F2C200` | same yellow as accent — by design; never adjacent to a primary button |
| `status.cancelled` | `#B3261E` | red |
| `status.unassigned` | muted | absence of a state, not a state |

### 1.2 Measured text floors

| # | Pair | Ratio | Verdict |
|---|---|---|---|
| TXT-1 | `text.primary` on surface / dense | 16.16 / 14.94:1 | ✅ |
| TXT-2 | `text.secondary` on surface / dense | 5.39 / 4.98:1 | ✅ passes body AA outright — no correction needed, recorded to stop future "lighten the grey" PRs |
| TXT-3 | `text.onAccent` (slate on yellow) | **9.79:1** | ✅ validates "never white on yellow" (white = 1.68:1) |
| TXT-4 | Green `#0F8A5F` as text ≥18px bold / ≥24px | 4.28:1 surface, 3.95:1 dense | ✅ large-text only; **never body-size green text** |
| TXT-5 | Amber `#D98A00` as text | 2.72:1 surface | ❌ **never as text at any size on light surfaces** — amber state rides the rail + pill text in `text.primary`, or filled amber with slate ink (FIL-2) |
| TXT-6 | Yellow as text | 1.65:1 | ❌ never text — yellow is a surface, not an ink |
| TXT-7 | Red `#B3261E` as text | 6.42:1 | ✅ body-safe — the one status colour that may carry body text |

### 1.3 Non-text floors (WCAG 1.4.11, 3:1 against adjacent)

| # | Element | Ratio | Rule |
|---|---|---|---|
| NTX-1 | Yellow rail on surface / dense | 1.65 / 1.53:1 | ❌ below floor on both — **rails are never the sole carrier of state** (DQ-2): the StatusPill text is the signal, the rail is reinforcement |
| NTX-2 | Green rail | 4.28:1 | ✅ passes alone |
| NTX-3 | Amber rail on surface / dense | 2.72 / 2.51:1 | ❌ below floor — same paired-or-nothing rule as yellow (DQ-2) |
| NTX-4 | Red rail | 6.42:1 | ✅ passes alone |
| NTX-5 | `line.default` borders | 1.28:1 | borders are structure, never signal |
| NTX-6 | Focus ring | 2dp `text.primary` + 2dp surface gap | survives any surface |

### 1.4 Filled status surfaces (StatusPill fills)

| # | Ink on fill | Ratio | Rule |
|---|---|---|---|
| FIL-1 | White on red | 6.54:1 | ✅ the only white-on-colour fill |
| FIL-2 | **Slate on amber** | 5.95:1 | ✅ amber pills are slate-ink, never white (2.77:1 ❌) |
| FIL-3 | White on green | 4.36:1 | ❌ marginal fail — green pills use a soft fill (green at 12% on surface) with `text.primary`, or FIL-4 |
| FIL-4 | Slate on green | 3.78:1 | ✅ acceptable for large/bold pill text; prefer the soft-fill treatment |
| FIL-5 | Slate on yellow (in-progress pill) | 9.79:1 | ✅ |
| FIL-6 | Muted pill (unassigned) | muted on `bg.dense` 4.98:1 | ✅ |

### 1.5 Flag families (chips: soft fill + dark ink, never decorated)

| Family | Treatment | Chips |
|---|---|---|
| blocker | red outline chip, red text (TXT-7 passes at body size) | OverdueChip (outlined, never filled — a warning must not read as a status the job is in), rejection banners |
| info | muted on `bg.dense` | WarrantyChip, ContractChip — never yellow (the §8 fence) |
| attention | amber soft fill + `text.primary` text | tracking-health amber states, "Pending sync" |

## 2. Type

IBM Plex Sans; IBM Plex Sans Condensed for dashboard figures. Loaded via `expo-font` behind the
splash gate — no text ever renders in a fallback face.

| Token | Size/line | Weight | Use |
|---|---|---|---|
| `display` | 32/36 | Condensed 600 | dashboard figures |
| `h1` | 22/28 | 600 | screen titles |
| `h2` | 18/24 | 600 | section heads, card titles |
| `body` | 16/22 | 400 | field text — **never below 16** (locked) |
| `label` | 14/18 | 500 | labels, chip text |
| `caption` | 13/16 | 400 muted | meta, ages |
| `mono` | 15/20 | 400 tabular | job numbers, amounts, times |

- **Tabular figures on every number that can change or align**: `fontVariant: ['tabular-nums']`
  on `mono` and `display` contexts — columns of money align, live figures don't jitter.
- **Body 16 minimum is a floor, not a suggestion** — the complete sheet is read one-handed in
  poor light by someone who wants to leave.
- Never de-emphasise a number by lightening it below TXT-2; de-emphasise with size or weight.

## 3. Spacing, targets, thumb zone

- **4pt scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- **Tap targets 52px minimum** — gloves and a moving vehicle (locked). Hit slop 8dp. The one
  documented exception path: the Job Logs fallback row at 44px if the prototype fails, because a
  dispatcher is seated and ungloved (`PLAN-FRONTEND.md` §9).
- **Thumb zone**: primary actions in a bottom action bar, never top-right (locked). Nothing
  destructive or irreversible in the bottom 40% of a field screen; the complete sheet's submit
  lives in the thumb zone and is never disabled for a network reason.
- Radii: `0` for job cards (the docket look), `4` for inputs and sheets — tight by identity;
  do not soften.

## 4. Density modes

| Mode | Where | Targets | List form |
|---|---|---|---|
| `field` | technician, sales rep on jobs | 52px | full cards |
| `console` | dispatcher (seated, ungloved), owner phone | 52px standard, 44px only via the documented fallback | cards + FilterBar |
| `desk` | owner web (≥1024px) | 44px | **DataTable rows — the same job is a row, never a card grid** (review checkpoint) |

The card-phone/row-desktop rule is enforced in review on every owner screen; `JobCard` and
`JobRow` share the status-colour left edge so the two presentations read as one object.

## 5. Elevation

Borders and surface shifts, not shadows: cards are surface + `line.default`; sheets and modals
add one soft shadow (`0 4 16 rgba(22,32,43,0.18)`) since they overlap content; `bg.dense`
marks dense zones. Shadows on list items are banned — invisible in sun, and the docket look
is flat ink on flat stock.

## 6. Icons

**[resolves]** — no icon set is named in the parent plans (DQ-1). Proposal: `@expo/vector-icons`
MaterialCommunityIcons — JS-only, MIT, no native module, ships inside Expo.

- Sizes: 24 (nav/tabs) · 20 (inline) · 16 (chip glyph). Filled set only — reads better at 24px
  on low-DPI LCDs than outlines.
- **Never icon-only for anything that changes data** — icon + label always (Multimeter rule:
  the mode is explicit on the LCD). Decorative icons may be icon-only.
- Tab bar: icon + 14px label, active = yellow accent + label, inactive = `text.secondary`.

## 7. Number, date, currency formats

- **English only, en-IN numbers** — both locked. ₹ with Indian grouping (`1,00,000`); `MoneyField`
  groups by Indian convention and carries **no currency symbol in the input**.
- Money figures: `mono` or `display`, tabular. The UI never computes a balance — dues, expected
  cash and variance are views the server owns.
- Dates: `DD Mon YYYY` in records; Asia/Kolkata clock for business dates. Times: 24h `HH:mm`.
  Relative time only in AgeStamps ("last ping 6 min ago"), absolute on tap or in detail.
- Durations: minutes under 60, then `H h M m`.
- Job numbers: server-assigned, `mono`, shown verbatim — a fabricated number is the one thing
  this system never renders ("Pending sync" until the real one arrives).
