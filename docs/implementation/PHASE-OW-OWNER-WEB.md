# Phase OW — Owner web: fixes, the look, and the charts

**Size M · Risk: low — web only.** Decided with the owner on 2026-09-16, after he called the console "really bad… dull", found four pages broken and the filters dead.

**Scope: the owner's desktop web console only.** The technician, dispatcher and sales-rep phone screens are untouched, so nothing here needs a new APK or a field retest. The whole-app pass comes later, and this phase is where its design language is worked out.

## The owner's decisions (2026-09-16)

| # | Decision |
|---|---|
| 1 | **Richer industrial**, not a new identity: keep safety yellow and slate, fix the dullness — a real spacing rhythm, layered surfaces, a sidebar with grouped sections and live hover/active states, colour used for meaning |
| 2 | **Web only for now**; the phone apps follow in a later phase |
| 3 | **Recharts in `.web.tsx`** for the charts — the `maplibre-gl` precedent: a web-only import never reaches the Android bundle |
| 4 | **Order: bugs → look → charts** |
| 5 | Technician revenue means **cash collected** (`job_completions.amount_collected` by business date) — the definition the dashboard figures already use |
| 6 | **One range switcher drives every chart**: this week (Mon–Sun) by default, plus 30 and 90 days |
| 7 | With nobody selected, charts are **stacked bars per day**, one segment per person; hover shows each person and the day's total; choosing a person shows theirs alone |
| 8 | The two existing charts **stay, below the new four**, restyled |
| 9 | The owner **ignores `dispatch.console`** — his Dispatch and Customers pages work even when the dispatcher console is switched off |

## What was actually broken (measured against the running dev API, 2026-09-16)

| Symptom | Cause |
|---|---|
| Dispatch and Customers blank | Both routes gate on `dispatch.console`, a dispatcher flag the owner does not hold. The same flag gates `/v1/jobs/summary`, `/v1/jobs` (create), `/v1/jobs/:id/assign`, `/v1/technicians/load` and `/v1/location/health` server-side, so the owner is refused there too |
| Companies, Employees, Products, Services error | `listOf()` in `owner/useOwnerData.ts` reads `envelope.items`, but `/v1/employees`, `/v1/products` and `/v1/services` answer with a **bare array** — `undefined.map` throws. Companies fails with them because it loads `/v1/employees` for the rep column |
| Every filter dead | `components/ui/Select.tsx` is still the Phase 0 stub: its press handler re-selects the current value and no menu ever opens |

---

### OW.1 — The four bugs

**Tier:** T2 (api) + T1 (web) · **Flag:** —

- `flags/gates.ts` — `dispatchConsoleEnabled` exempts the **owner**: the flag is the dispatcher console's T0 rollback, and switching it off must not disarm the person who covers for them. Every other flag still gates the owner, including his own (`owner.cash`, `owner.amend`, `owner.location`).
- `app/(app)/jobs/new.tsx`, `app/(app)/customers/index.tsx` — the owner branch renders the screen without consulting `consoleOn`; the dispatcher branch keeps it.
- `owner/useOwnerData.ts` — `listOf()` accepts both shapes: an envelope `{ items }` or a bare array. Both are live contracts (the dispatch form already reads the catalogue as arrays), and a reader that only knows one of them is the bug.
- `components/ui/Select.tsx` — a real dropdown. A popover menu on web (click to open, click-away and Escape to close, arrow keys and Enter, the selected option marked) and the existing `Sheet` on native, behind the same props so no caller changes.

**Tests** — api: an owner with `dispatch.console` dark still reads `/v1/jobs/summary`, `/v1/technicians/load` and `/v1/location/health`, while a dispatcher without it is still refused. Web: `listOf` normalises both shapes; the four pages render rows from a bare array; `Select` opens, filters, closes on click-away and Escape, and reports the chosen value.

### OW.2 — The look

**Tier:** T1 · Web only, `desk` density.

Tokens first, screens second: a spacing rhythm and surface elevations in `packages/shared/theme`, then the rail (grouped sections, hover, the active row carrying the accent), page headers, cards, tables (zebra, sticky header, aligned money), empty and error states. Every colour keeps its meaning — the accent stays on one primary action per screen.

### OW.3 — The four charts

**Tier:** T2 (api) + T1 (web).

New owner reads for: revenue collected per technician per day, jobs completed per technician per day, sales confirmed per rep per day (value), and sales count per rep per day — each over the chosen range, grouped so the client never derives money. Then the four stacked-bar charts with hover, a person filter, and the shared range switcher; the two existing charts restyled beneath them.

### OW.4 — The owner's own pass

The owner walks the console and says what still looks wrong. Nothing ships to the phones in this phase.
