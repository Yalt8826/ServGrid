/**
 * T1.22 spike measurements — the programmatically measurable half of
 * the prototype gate. The REAL gate is human (two dispatchers, five
 * trials each, stopwatch — protocol in TIMINGS.md); this harness
 * records what the unit environment CAN say honestly:
 *
 * 1. **Filter cost at volume** — every raw time for the exact work a
 *    chip tap or a search keystroke triggers at 220 jobs (25 runs, all
 *    reported — a median hiding outliers is exactly what the spec
 *    warns about, and that discipline starts here).
 * 2. **Mount and filter-change render cost** — the stub renders EVERY
 *    row, so a mount here is the whole-list cost: the worst case the
 *    real recycled list would spread across frames.
 * 3. **Scroll proxy** — successive 12-row window mounts (one phone
 *    screen of rows), worst window against a 16.7ms frame budget.
 *    Node is not a phone: this is a CPU-shaped proxy, and the device
 *    number ("zero dropped frames scrolling 200 rows") stays a Phase 5
 *    matrix row.
 * 4. **Memo effectiveness** — rows re-rendered by a Today→All-days
 *    chip change, driven through the real chip press handlers.
 *
 * Output lines are prefixed `[T1.22 PERF]` so a run can be pasted into
 * TIMINGS.md verbatim. Assertions only pin determinism (volume, hit
 * counts); every timing is recorded, none is gated — gating a throwaway
 * spike on Node wall-clock would be theatre.
 */
import { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { JobLogsRow, resetRowRenderCount, rowRenderCount } from './JobLogsRow';
import { JobLogsScreen } from './JobLogsScreen';
import { applyFilters, DEFAULT_FILTERS, isOverdue, matchesSearch } from './jobLogsFilter';
import { generateJobs, istDateKey, TOTAL_JOBS } from './mockJobs';
import { create, toJson } from '../../components/ui/testing';
import { findID, press } from './spikeTestUtils';

const NOW = new Date('2026-09-11T10:00:00+05:30');
const JOBS = generateJobs(NOW);
const FRAME_BUDGET_MS = 1000 / 60;
const ROWS_PER_SCREEN = 12; // eight visible at 56pt on a small phone; 12 rounds up a gesture

function ms(): number {
  return performance.now();
}

function raw(label: string, times: number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `[T1.22 PERF] ${label}: n=${times.length} all=[${times.map((t) => t.toFixed(2)).join(', ')}] ` +
      `median=${median.toFixed(2)}ms min=${sorted[0]?.toFixed(2)}ms max=${sorted[sorted.length - 1]?.toFixed(2)}ms`,
  );
}

function once(label: string, value: number): void {
  console.log(`[T1.22 PERF] ${label}: ${value.toFixed(2)}ms`);
}

function pressAt(renderer: TestRenderer.ReactTestRenderer, testID: string): void {
  press(findID(toJson(renderer), testID)!);
}

describe('T1.22 measurements at 220 jobs', () => {
  it('records filter, render and scroll-proxy timings (logged, not gated)', async () => {
    expect(TOTAL_JOBS).toBe(220);
    expect(JOBS.length).toBe(220);

    // 1a. fixture generation — once per launch on the handset route
    const genTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = ms();
      generateJobs(NOW);
      genTimes.push(ms() - t0);
    }
    raw('generateJobs(220)', genTimes);

    // 1b. the resting screen: Today · Anyone · Any status
    const todayTimes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = ms();
      applyFilters(JOBS, DEFAULT_FILTERS, NOW);
      todayTimes.push(ms() - t0);
    }
    raw('applyFilters Today/Anyone/Any (chip tap)', todayTimes);

    // 1c. the trial path: chips land on today, then a search keystroke
    const today = applyFilters(JOBS, DEFAULT_FILTERS, NOW);
    const trialTimes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = ms();
      const shown = today.filter((j) => matchesSearch(j, 'Kormangala'));
      trialTimes.push(ms() - t0);
      if (i === 0) {
        expect(shown.length).toBeGreaterThanOrEqual(3);
        console.log(
          `[T1.22 PERF] trial query "Kormangala" today: ${shown.length} rows; ` +
            `technicians on them: ${[...new Set(shown.map((j) => j.technician))].join(', ')}`,
        );
      }
    }
    raw('search keystroke "Kormangala" over today (trial path)', trialTimes);

    // 1d. the heaviest chip change: open the list to all 220
    const allTimes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t0 = ms();
      applyFilters(JOBS, { ...DEFAULT_FILTERS, date: 'all' }, NOW);
      allTimes.push(ms() - t0);
    }
    raw('applyFilters All days/Anyone/Any (heaviest chip)', allTimes);

    // 2. screen mount with the default filter — the stub mounts EVERY
    // row, so this is the whole-list commit, not a recycled window.
    const mountTimes: number[] = [];
    let last: TestRenderer.ReactTestRenderer | null = null;
    for (let i = 0; i < 5; i += 1) {
      const t0 = ms();
      last = await create(<JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />);
      mountTimes.push(ms() - t0);
      if (i < 4) last.unmount();
    }
    raw('screen mount, default filter (today-only rows, stub mounts all)', mountTimes);

    // 3. scroll proxy — successive one-screen window mounts marching
    // through the full 220 in the All-days order a scroll would meet.
    const all = applyFilters(JOBS, { ...DEFAULT_FILTERS, date: 'all' }, NOW);
    const windowTimes: number[] = [];
    for (let w = 0; w + ROWS_PER_SCREEN <= all.length; w += ROWS_PER_SCREEN - 4) {
      const slice = all.slice(w, w + ROWS_PER_SCREEN);
      const t0 = ms();
      let r: TestRenderer.ReactTestRenderer | null = null;
      act(() => {
        r = TestRenderer.create(
          <>{slice.map((job) => (
            <JobLogsRow key={job.id} job={job} overdue={isOverdue(job, NOW)} onPress={() => {}} />
          ))}</>,
        );
      });
      windowTimes.push(ms() - t0);
      act(() => {
        r?.unmount();
      });
    }
    raw(`scroll proxy: ${ROWS_PER_SCREEN}-row window mounts`, windowTimes);
    const worst = Math.max(...windowTimes);
    console.log(
      `[T1.22 PERF] scroll proxy verdict: worst window ${worst.toFixed(2)}ms vs 16.7ms frame budget ` +
        `(${(worst / FRAME_BUDGET_MS).toFixed(1)}x budget in Node; the handset number is the Phase 5 matrix row)`,
    );

    // 4. memo effectiveness across a real Today→All-days chip change
    expect(last).not.toBeNull();
    const screen = last as TestRenderer.ReactTestRenderer;
    const todayRows = applyFilters(JOBS, DEFAULT_FILTERS, NOW).length;
    resetRowRenderCount();
    const t0 = ms();
    pressAt(screen, 'filter-chip-date');
    pressAt(screen, 'filter-option-all-days');
    const changeMs = ms() - t0;
    const reRendered = rowRenderCount();
    once('Today→All days chip change (two presses, act-flushed)', changeMs);
    console.log(
      `[T1.22 PERF] memo check: change touched ${reRendered} rows ` +
        `(${todayRows} rendered on the previous pass; ${all.length} now shown; ` +
        `carried-over rows with unchanged props skipped)`,
    );
    expect(reRendered).toBeGreaterThan(0);
    expect(reRendered).toBeLessThanOrEqual(all.length);
    screen.unmount();

    // context lines for TIMINGS.md
    const kormangala = all.filter((j) => j.area.startsWith('Kormangala'));
    console.log(
      `[T1.22 PERF] fixture context: ${JOBS.length} jobs, ` +
        `${JOBS.filter((j) => istDateKey(j.scheduledFor) === istDateKey(NOW)).length} today, ` +
        `${JOBS.filter((j) => isOverdue(j, NOW)).length} overdue overall, ${kormangala.length} Kormangala overall`,
    );
  });
});
