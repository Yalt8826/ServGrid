# T1.22 — Job Logs prototype: timings and the dispatcher trial protocol

**Status: prototype built and unit-measured. The human stopwatch trials
are OUTSTANDING — they are the actual gate and cannot be run by the
agent that built this.** Everything below is the record of what the unit
environment could measure honestly, plus the exact protocol for the
human half (`PHASE-1-TECHNICIAN.md` §T1.22; `UI/plan-2/05-DISPATCHER.md`
§D2; `PLAN-EXECUTION.md` Phase 2 entry).

The test it must pass, verbatim: *a dispatcher answers "who has the
Kormangala jobs today" in under five seconds, on a phone, against 200+
jobs* — two real dispatchers, their own handsets, five trials each,
stopwatch, median under 5s. **This has NOT been measured yet.** Phase 2
must not start until it has (or the descope below is taken).

---

## 1. What was built (all throwaway)

- `mockJobs.ts` — **220 seeded, real-shaped jobs** (not six): job
  numbers `JC-2627-00NNN`, Bengaluru areas (Kormangala blocks
  over-represented), 6 technicians, plausible customers and `+91`
  phones, IST slots 08:30–18:30 across 13 days around "today"
  (18 last week → 48 today → 26 tomorrow → future queue). Status mix
  per day: past = completed/cancelled; today = live dispatch day;
  future = assigned/unassigned. Yesterday leaks 4 open carry-overs.
- `jobLogsFilter.ts` — pure filter/sort: three chips (date, technician,
  status) + **Overdue as a filter option that sorts first** (never a
  status colour), D2 search surface (job number, customer, phone, area).
- `JobLogsRow.tsx` — the **56pt two-line row** (`console` density,
  `DENSITY.console.rowHeight`): line 1 job number + area, line 2
  technician · slot + status dot; 3dp status-coloured left rail;
  outlined danger `Overdue` chip inline (never a rail). Memoised, with
  a throwaway render counter for the memo proof.
- `FilterBar.tsx` — the three-chip bar, **sticky by layout** (renders
  as a sibling above the FlashList, so it cannot scroll away), chips at
  the console 44pt floor with hitSlop 8, each opening an inline sheet
  of 44pt rows (the Phase 2 bottom sheet, approximated), ✕ clear.
- `JobLogsScreen.tsx` — D2 anatomy: header ⌕ → separate full search
  mode; result count line always visible (`48 jobs · 3 overdue`);
  FlashList with hoisted `renderItem`, memoised rows, overdue computed
  once per change; empty-filtered keeps the bar and offers *Clear
  filters*; empty-unfiltered reads "No jobs yet."
- `app/spike/job-logs.tsx` — route `/spike/job-logs`, deliberately at
  the route-tree ROOT so no shared `navmap.ts`/RoleGate edit is needed.
  Delete the whole directory + route file when the trial is scored.

**Deliberately not built** (out of the spike's Build list): long-press
multi-select and bulk reassign, URL filter state, offline state, the
bottom-sheet presentation of filter options.

## 2. Programmatically measured (vitest, Node, react-test-renderer)

Run: `pnpm -F mobile exec vitest run src/spikes/job-logs/jobLogs.perf.test.tsx`
Raw output of a run on the build machine (all raw times recorded, not
just medians, per the spec's own discipline):

```
[T1.22 PERF] generateJobs(220): n=5 all=[1.03, 0.67, 0.49, 0.49, 0.51] median=0.51ms min=0.49ms max=1.03ms
[T1.22 PERF] applyFilters Today/Anyone/Any (chip tap): n=25 all=[1.44, 1.00, 1.64, 0.79, 0.72, 0.72, 0.72, 0.69, 0.68, 0.68, 0.78, 0.74, 0.77, 0.75, 0.76, 0.75, 0.75, 0.86, 0.83, 0.76, 0.75, 0.74, 0.76, 0.74, 0.76] median=0.75ms min=0.68ms max=1.64ms
[T1.22 PERF] trial query "Kormangala" today: 11 rows; technicians on them: , Farhan Ali, Anitha Prasad, Ravi Kumar, Suresh Naik
[T1.22 PERF] search keystroke "Kormangala" over today (trial path): n=25 all=[0.22, 0.04, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.06, 0.06, 0.03, 0.03, 0.03, 0.04, 0.03, 0.03, 0.03, 0.03, 0.03, 0.04, 0.02, 0.02, 0.02, 0.02] median=0.03ms min=0.02ms max=0.22ms
[T1.22 PERF] applyFilters All days/Anyone/Any (heaviest chip): n=25 all=[1.21, 1.19, 1.29, 1.18, 1.13, 1.14, 1.14, 1.14, 4.52, 1.08, 0.93, 0.93, 0.92, 0.95, 0.93, 0.98, 0.94, 0.94, 0.95, 0.94, 0.94, 0.94, 0.94, 0.94, 0.94] median=0.95ms min=0.92ms max=4.52ms
[T1.22 PERF] screen mount, default filter (today-only rows, stub mounts all): n=5 all=[25.04, 16.93, 13.04, 11.91, 13.10] median=13.10ms min=11.91ms max=25.04ms
[T1.22 PERF] scroll proxy: 12-row window mounts: n=27 all=[3.25, 2.65, 2.46, 2.50, 2.44, 2.50, 2.39, 2.41, 2.48, 2.44, 2.37, 2.34, 2.36, 2.34, 2.36, 2.36, 2.33, 2.69, 2.85, 2.68, 2.80, 2.73, 2.71, 2.71, 2.72, 2.69, 2.71] median=2.50ms min=2.33ms max=3.25ms
[T1.22 PERF] scroll proxy verdict: worst window 3.25ms vs 16.7ms frame budget (0.2x budget in Node; the handset number is the Phase 5 matrix row)
[T1.22 PERF] Today→All days chip change (two presses, act-flushed): 48.83ms
[T1.22 PERF] memo check: change touched 172 rows (48 rendered on the previous pass; 220 now shown; carried-over rows with unchanged props skipped)
[T1.22 PERF] fixture context: 220 jobs, 48 today, 14 overdue overall, 52 Kormangala overall
```

**How to read these — honestly:**

- **Node is not a handset.** These are CPU-shaped proxies for the work
  a tap triggers, not UX times. The five-second number comes only from
  the human trials below. "Zero dropped frames scrolling 200 rows"
  remains a Phase 5 device-matrix row; the worst 12-row window here
  (3.25ms) says the row is light enough that the handset number is a
  rendering question, not a component-logic question.
- **The machine cost of the trial path is negligible:** one chip tap +
  the "Kormangala" search ≈ 1ms of logic at 220 jobs. Whatever the
  stopwatch says, it will be about perception, layout and affordances —
  not compute. That is exactly what this prototype is for.
- **The memo holds:** a Today→All-days change re-rendered exactly the
  172 new/changed rows and skipped all 48 carried-over rows. At volume,
  filter changes do not re-render the world.
- The one implementation lesson worth carrying into Phase 2: the first
  cut formatted each job's day with a freshly-constructed
  `Intl.DateTimeFormat` and the Today filter cost ~48ms at 220 rows;
  hoisting one formatter instance and precomputing the target day keys
  per pass dropped it to <1ms. Construct formatters once, not per row.

## 3. THE HUMAN TRIALS — protocol (OUTSTANDING, cannot be simulated)

**Participants.** The two (or all three, if available) real dispatchers
who will use the Phase 2 screen. Not engineers, not stand-ins.

**Hardware.** Each dispatcher's **own handset**, held as they normally
hold it. Not a test device; not a desk stand.

**Material.** This prototype at 220 jobs, on their handset, on the
trial day (`/spike/job-logs`). The fixture's "today" is the trial day,
so the Kormangala answer is live.

**Task (repeated verbatim each trial, no coaching):**

> "Who has the Kormangala jobs today?"

The dispatcher may answer by any route the screen offers — filter
chips, search, or scrolling. All routes are legal; which they choose is
data, not error.

**Trials.** Five per dispatcher, stopwatch started on the last word of
the task and stopped when they can **say the technicians' names aloud**
(finding, not opening). Between trials, reset the screen to the resting
state and let them look away (a few seconds of distraction is enough;
the point is not to test memory).

**Record, per trial (this table goes in the Phase 2 entry decision):**

| Dispatcher | Trial | Raw time (s) | Route taken (chips / search / scroll) | First reach (which chip or ⌕) |
|---|---|---|---|---|
| A | 1–5 | | | |
| B | 1–5 | | | |

**Record every raw time — not just the median.** A median of 4s hiding
two 9s outliers is a screen that fails on the calls that matter. Also
note *what they reached for first* and any wrong turn (opened a chip
and backed out, searched for a technician's name, etc.): that says
which affordance to enlarge if the number is close.

**Pass rule.** Median of all ten trials **under 5 seconds** AND no
dispatcher with a consistent pattern above it (if one dispatcher is
over on 4 of 5 trials, treat it as a fail even if the median passes —
the descope decision protects the slower dispatcher, not the average).

**If it fails** (take this BEFORE Phase 2 starts, not during):

1. Fallback within phone-first: compact two-line row at **44pt**, filter
   bar pinned — re-run the trials against the 44pt build.
2. If that still fails: descope to the **desktop web build**, pulling
   `NavShell`'s rail and `DataTable` forward by two phases. Budget
   **+2 weeks** and record it as a deviation from `PLAN.md` §1
   requiring the **owner's sign-off** (`PLAN-EXECUTION.md` Phase 2
   entry; risk table: "Job Logs 5-second test — Phase 2 start").

**Cost.** Under an hour of dispatcher time, one afternoon of an
engineer's. Do it in Phase 1's spare capacity, while the screen is
still throwaway.
