# T4.1 — React Native Web spike: verdict

**Verdict: React Native Web carries the DataTable and the rail. Do not fork.**
T4.7 proceeds on RNW (`NavShell` desk branch + `.web.tsx` `DataTable`) as planned;
`PLAN-FRONTEND.md` open item 5 closes with no fork and no +2 weeks.

Measured 2026-09-14 on athena (Arch Linux, Node v26.8.2, pnpm 11.20.0), in **headed,
real Chrome 153.0.8010.36 and Firefox 155.0.1** (system binaries — Chrome over CDP,
stock Firefox over WebDriver BiDi), at **1280×800 and 1920×1080**, against the
**production web export** (`expo export --platform web`, Metro, single output) of the
full app including the spike route. Sort presses were **trusted input events**
(`page.mouse.click`), not synthetic DOM events. The monitor is 144 Hz — frame
budgets below are read against 6.94 ms, which is *harder* than the 60 fps gate.

The raw JSON of every run and the screenshots are in `measure/results/`
(`{chromium,firefox}-{1280,1920}.json`, `-top.png`, `-bottom.png`). The harness is
`measure/page-harness.js` + `measure/run.cjs` (throwaway).

---

## Done when

- **[x] A verdict is written down, with the specific failures if any** — this
  document; failures/traps in §3.
- **[x] 500 rows scroll at 60fps in Chrome and Firefox** — zero dropped frames in
  the steady sweep in both browsers at both widths, at 144 Hz (§2).
- **[x] Sticky header survives virtualisation** — FlashList's own
  `stickyHeaderIndices` machinery holds in 4/4 runs to the very bottom of the
  scroll (scrollTop ≈ 19,000px); measured clone position y=56 = container top in
  every run, and visible in every `-bottom.png` (§2.3).

---

## 1. What was built (all throwaway)

- `mockJobs.ts` — **500 seeded, real-shaped jobs** (owner's table shape, §O4:
  number · customer · service · technician · scheduled · status · **amount**),
  Bengaluru areas, 8 technicians, IST slots over ±10 days, realistic status mix.
- `DataTable.tsx` — the T4.7 component at measurement fidelity: FlashList v2
  2.0.2 virtualised, **`stickyHeaderIndices={[0]}`** (header as item 0 — the
  hard path; a layout-pinned sibling cannot fail and so proves nothing),
  sortable by 4 columns, `desk` density (40pt rows, 14px body, 36pt targets),
  zebra stripes in slate.100, **status colour on the 3px left edge of every
  row**, tabular figures (`mono` = Plex Sans 400 + `tabular-nums`), `en-IN`
  money grouping from `packages/shared`.
- `DeskRail.tsx` — the 240px rail to spec: five sections expanded to the
  owner's individual routes, `slate.900` ground, `surface` text, `onDarkSecondary`
  group headings, **2px accent bar on the active route**, right border in
  `line.strong`, **no collapse control**.
- `DeskShell.tsx` — rail + table composition plus the in-page measurement API
  (`window.__rnwspike`, `spike:*` performance marks, render counters).
- `app/spike/rnw-desktop.tsx` — root route `/spike/rnw-desktop`, outside the
  `(app)` group (same pattern as the T1.22 spike; no shared-file edits).

Rendered against the **real token set** (`packages/shared/src/theme/tokens.ts`)
and the **real Plex faces** through the app's own `FontGate` — no placeholders.

## 2. The measurements

### 2.1 Frame timing — 500-row scroll sweeps (rAF-locked)

Steady sweep = one row (40px) per frame, top to bottom through all 500 rows
(~480 frames). Stress sweep = 400px per frame (10 rows recycled per frame).
A frame is "dropped" at >32ms (≥2 missed at 60Hz; the text uses the 144 Hz
budget of 6.94ms as the harder reference).

| Run | Steady median | Steady p95 | Steady max | Steady dropped | Steady fps | Stress median | Stress max | Stress dropped |
|---|---|---|---|---|---|---|---|---|
| Chrome 1280 | 6.90 | 7.0 | 13.9 | **0** | 143.4 | 13.9 | 27.8 | **0** |
| Chrome 1920 | 6.90 | 7.0 | 14.0 | **0** | 142.2 | 13.9 | 55.5 | 2 |
| Firefox 1280 | 7.0 | 7.0 | 14.0 | **0** | 141.1 | 14.0 | 21.0 | **0** |
| Firefox 1920 | 7.0 | 14.0 | 21.0 | **0** | 131.8 | 14.0 | 21.0 | **0** |

Reading: the median frame is ~7ms — **half the 16.7ms 60 fps budget** — in both
browsers, at both widths, while recycling rows continuously through the full
500. The worst single frame observed in any steady sweep was 21ms. The stress
sweep (a flick that recycles ten rows per frame — far beyond the reading
pattern the table exists for) stayed at 0–2 dropped frames per full sweep.

### 2.2 Sort — three different columns, trusted clicks

Sort state lives in the shell; a press sorts all 500 rows (full `Array.sort` —
deliberately the honest cost) and FlashList re-renders its window.
`appliedMs` = handler start → commit mark, both in-page (excludes driver
relay). Rows-rendered is the throwaway render counter: rows that actually
re-rendered out of the 500 mounted.

| Run | customer | amount | scheduled | worst frame during any sort commit |
|---|---|---|---|---|
| Chrome 1280 | 32.1ms | 26.1ms | 28.9ms | 41.6ms |
| Chrome 1920 | 40.8ms | 31.5ms | 42.0ms | 55.5ms |
| Firefox 1280 | 31.0ms | 47.0ms | 46.0ms | 48.0ms |
| Firefox 1920 | 43.0ms | 53.0ms | 45.0ms | 55.0ms |

- **Applied in 26–53ms** for a full 500-row sort — a click's worth of time,
  well inside one perceptual step. `jobNumber` (4th, measured for symmetry)
  matched: 28.8–43ms.
- **Rows re-rendered per sort: 40–51 of 500.** The virtualised window plus the
  memoised row carry the sort; a sort does not re-render the world. (T4.7's
  "500 rows sort without a full re-render — assert render counts" is directly
  achievable with this counter.)
- Cost shows up as **one frame of 35–55ms on the sort commit** in most runs —
  one dropped frame at 60 Hz on a discrete press. Perceptible only if you are
  looking for it; acceptable. If T4.7 wants it gone, the known lever is
  sorting inside a transition/startTransition, not a different list.

### 2.3 Sticky header under virtualised scroll

After both sweeps, scrollTop parked at the very bottom (~19,000px), then
measured:

| Run | Header clones found | Clone top | Container top | Held |
|---|---|---|---|---|
| Chrome 1280 | 2 | **56** | 56 | ✅ |
| Chrome 1920 | 2 | **56** | 56 | ✅ |
| Firefox 1280 | 2 | **56** | 56 | ✅ |
| Firefox 1920 | 2 | **56** | 56 | ✅ |

FlashList v2 renders a **clone** of the sticky item in an absolutely-positioned
overlay and drives it from scroll events — it works on RNW, in both browsers,
at both widths, with the real 500-row window recycling underneath. Every
`-bottom.png` shows the header pinned over rows ~575–599.

### 2.4 The rail against the real token set

All four Plex faces verified loaded via `document.fonts.check` in **both**
browsers (`Plex-Sans`, `-Medium`, `-SemiBold`, `-Condensed`) — `expo-font`'s
web path works with the existing splash-gated loader. 1px borders render
crisp in both. The rail (240px, five sections, accent bar on the active
route) and the table are visually identical across browsers — see
`chromium-1920-top.png` vs `firefox-1920-top.png`. **The anticipated RNW pain
in fonts and borders did not materialise.**

Mount (`spike:ready` mark, includes the whole Expo web runtime boot):
415–447ms — a spike number, not a gate, but no red flag for a desk surface.

### 2.5 Toolchain

`expo export --platform web` succeeds on the **full app** (spike route
included) with the existing Metro config; `expo-sqlite`'s wasm rides in its
lazy chunk as designed. `react-native-web` 0.21.2 + React 19.1 + FlashList
2.0.2 is a working web stack for this codebase. Web entry JS ≈ 2.7MB
uncompressed (single output, whole route tree) — T4.7 may want code splitting;
not a spike gate.

## 3. Specific failures and traps found (all workable, all recorded)

1. **FlashList v2 positions rows with transforms, not DOM order.** A sort
   moves rows by updating transforms; the DOM order of row elements does not
   change. Consequence for T4.7: component tests that assert row *order* via
   `queryAllBy*`/DOM traversal will misread. Order assertions must be
   position-aware (read the rect). The spike's first measurement pass got
   exactly this wrong (`orderChanged` false for a sort that visibly fired).
2. **The sticky header is a clone — `[data-testid]` matches twice.** Any test
   or harness that takes the first header element measures the scrolled-away
   real item, not the pinned one (again: the spike's first pass). Tests must
   disambiguate by position.
3. **Untrusted (synthetic) events can double-fire RNW `Pressable`.** A
   hand-rolled `pointerdown`+`pointerup`+`click` sequence produced two
   `onPress` calls (the toggle reversed itself). Real input does not do this,
   but it is a live trap for tests and for any `dispatchEvent`-based
   tooling: press via the platform's input path, or dispatch exactly one
   press-completing event.
4. **Classic (non-overlay) scrollbars on Linux Chromium carve a track gap**
   beside/below the sticky header's right edge (visible in `-top.png`). Purely
   cosmetic; Firefox overlay scrollbars don't show it. T4.7 can style
   `::-webkit-scrollbar` or accept it — a design decision, not a defect.
5. Nothing else fought back. No stylesheet-injection artifacts, no font
   fallbacks, no border hairline bugs, no sticky drift.

## 4. Not measured (out of spike scope, recorded honestly)

- Physical wheel/trackpad inertia scrolling (the sweep is rAF-locked
  programmatic scroll — the honest way to compare runs, but compositor-side
  smoothness of real wheel input is not captured by these numbers).
- Phone-width web (the owner's phone uses the native layouts; web branch at
  <1024px is untested), window resize mid-session, browser zoom / HiDPI
  scaling, keyboard scrolling.
- Anything about the *map* (T4.10's concern) or `NavShell`'s production
  branching — the spike renders the desk layout directly.

## 5. Disposition

The fork is **not** taken: `packages/shared` keeps one client, and the second
component set is not built. This spike directory and its route file are
throwaway — **delete both when T4.7 lands the real `NavShell` desk branch and
`DataTable`** (same protocol as the T1.22 spike). T4.7 should carry three
lessons from §3: position-aware order assertions, the sticky-clone
disambiguation, and trusted-input testing.
