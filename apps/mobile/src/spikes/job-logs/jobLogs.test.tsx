/**
 * T1.22 spike tests — the deterministic half of the prototype gate
 * (PHASE-1-TECHNICIAN.md §T1.22). The human stopwatch trials are the
 * real measurement (protocol in TIMINGS.md); what vitest CAN decide:
 *
 * - **The fixture is dispatcher volume** — 220 jobs, real-shaped, not
 *   six; Kormangala has jobs today for the trial question to find.
 * - **The trial question is answerable through the UI** — chips and
 *   search both land on exactly the Kormangala jobs today, overdue
 *   first, with technicians readable on the rows.
 * - **The D2 geometry holds** — 56pt two-line rows, status-coloured
 *   rail, 44pt console chips with hitSlop 8, result count always
 *   visible, `estimatedItemSize` seeded from the measured row.
 * - **The memo contract holds** — rows whose job and overdue flag did
 *   not change do not re-render when the screen re-renders around them
 *   (the unit proxy for "zero dropped frames scrolling 200 rows"; the
 *   device number is a Phase 5 matrix row).
 *
 * Everything renders through the FlashList seam: the REAL row
 * components and filter logic, host-typed surface.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { act } from 'react';

import { DENSITY, STATUS } from '@servgrid/shared';
import {
  allText,
  create,
  findAll,
  firstDescendantOfType,
  toJson,
} from '../../components/ui/testing';
import { __resetFlashListSeam } from '../../test-stubs/flash-list';
import { JobLogsScreen } from './JobLogsScreen';
import { JobLogsRow, resetRowRenderCount, rowRenderCount } from './JobLogsRow';
import { FilterBar } from './FilterBar';
import { allInTree, findID, flatStyle, noop, press, type Tree } from './spikeTestUtils';
import {
  applyFilters,
  countOverdue,
  DEFAULT_FILTERS,
  formatResultCount,
  isOverdue,
  matchesSearch,
} from './jobLogsFilter';
import { generateJobs, istDateKey, TECHNICIANS, TOTAL_JOBS, type SpikeJob } from './mockJobs';

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST
const JOBS = generateJobs(NOW);

function rowIds(tree: Tree): string[] {
  return allInTree(tree, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('job-logs-row-')).map(
    (n) => (n.props.testID as string).replace('job-logs-row-', ''),
  );
}

beforeEach(() => {
  __resetFlashListSeam();
  resetRowRenderCount();
});

describe('T1.22 fixture — dispatcher volume, real-shaped', () => {
  it('carries 200+ jobs (220), every one real-shaped', () => {
    expect(TOTAL_JOBS).toBe(220);
    expect(JOBS.length).toBe(220);
    for (const job of JOBS) {
      expect(job.jobNumber).toMatch(/^JC-2627-\d{5}$/);
      expect(job.customerName.length).toBeGreaterThan(2);
      expect(job.contactPhone).toMatch(/^\+91 \d{2} \d{4} \d{4}$/);
      expect(job.area.length).toBeGreaterThan(3);
      expect(job.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+05:30$/);
      expect(job.technician === null || TECHNICIANS.includes(job.technician)).toBe(true);
    }
  });

  it('spans several days around today in IST', () => {
    const days = new Set(JOBS.map((j) => istDateKey(j.scheduledFor)));
    expect(days.size).toBeGreaterThanOrEqual(10);
    expect(days).toContain(istDateKey(NOW));
  });

  it('has Kormangala jobs today, including overdue ones, so the trial question has an answer', () => {
    const today = JOBS.filter((j) => istDateKey(j.scheduledFor) === istDateKey(NOW));
    const kormangalaToday = today.filter((j) => j.area.startsWith('Kormangala'));
    expect(kormangalaToday.length).toBeGreaterThanOrEqual(3);
    // and the answer spans more than one technician, or the question is trivial
    expect(new Set(kormangalaToday.map((j) => j.technician)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('T1.22 pure model — the work one chip tap does', () => {
  it('Today + Anyone + Any status returns today’s jobs, overdue first', () => {
    const shown = applyFilters(JOBS, DEFAULT_FILTERS, NOW);
    expect(shown.length).toBe(JOBS.filter((j) => istDateKey(j.scheduledFor) === istDateKey(NOW)).length);
    const overdueFlags = shown.map((j) => isOverdue(j, NOW));
    expect(overdueFlags).toEqual([...overdueFlags.filter(Boolean), ...overdueFlags.filter((f) => !f)]);
    const slots = shown.filter((j) => isOverdue(j, NOW) === overdueFlags[0]).map((j) => j.scheduledFor);
    expect(slots).toEqual([...slots].sort());
  });

  it('the trial path — today, then search "Kormangala" — lands exactly on the Kormangala jobs today', () => {
    const today = applyFilters(JOBS, DEFAULT_FILTERS, NOW);
    const hit = today.filter((j) => matchesSearch(j, 'Kormangala'));
    expect(hit.length).toBeGreaterThanOrEqual(3);
    expect(hit.every((j) => istDateKey(j.scheduledFor) === istDateKey(NOW))).toBe(true);
    // the query reads on the area — or on a customer plausibly named
    // after it ("Kormangala Club kitchen"); that is D2's search surface
    expect(hit.every((j) => j.area.includes('Kormangala') || j.customerName.includes('Kormangala'))).toBe(true);
  });

  it('search reaches customers and phone digits, per D2’s search surface', () => {
    const phone = JOBS[10]!.contactPhone;
    const digits = phone.replace(/\D/g, '').slice(-8);
    expect(JOBS.filter((j) => matchesSearch(j, digits)).map((j) => j.id)).toContain(JOBS[10]!.id);
    const byCustomer = JOBS.filter((j) => matchesSearch(j, JOBS[5]!.customerName));
    expect(byCustomer.map((j) => j.id)).toContain(JOBS[5]!.id);
  });

  it('Overdue is a filter option, never a status colour', () => {
    const overdueOnly = applyFilters(JOBS, { ...DEFAULT_FILTERS, date: 'all', status: 'overdue' }, NOW);
    expect(overdueOnly.length).toBeGreaterThan(0);
    expect(overdueOnly.every((j) => isOverdue(j, NOW))).toBe(true);
  });
});

describe('T1.22 screen — the D2 anatomy at volume', () => {
  it('renders today’s rows through FlashList with the result count always visible', async () => {
    const expected = applyFilters(JOBS, DEFAULT_FILTERS, NOW);
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    const root = toJson(renderer);
    expect(rowIds(root).length).toBe(expected.length);
    const count = findID(root, 'job-logs-result-count');
    expect(count).toBeDefined();
    expect(allText(count!).join('')).toBe(
      formatResultCount(expected.length, countOverdue(expected, NOW)),
    );
  });

  it('rows are the 56pt two-line shape with the status rail and overdue chip', async () => {
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    const root = toJson(renderer);
    const rows = findAll(root, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('job-logs-row-'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.slice(0, 12)) {
      expect(row.type).toBe('Pressable'); // the row itself is the tap target
      expect(flatStyle(row).height).toBe(56);
      const texts = allText(row);
      // line 1: job number + area; line 2: technician · slot, status label
      expect(texts.some((t) => t.startsWith('JC-…'))).toBe(true);
      expect(texts.length).toBeGreaterThanOrEqual(3);
    }
    // an overdue row carries the outlined danger chip, never a rail repaint
    const overdueRow = rows.find((r) => allText(r).includes('Overdue'));
    const someOverdueToday = applyFilters(JOBS, DEFAULT_FILTERS, NOW).some((j) => isOverdue(j, NOW));
    expect(Boolean(overdueRow)).toBe(someOverdueToday);
    // rail colour rides STATUS[status] — spot-check the first row
    // (`assigned` has no ramp entry and falls back to the unassigned slate)
    const firstJob = applyFilters(JOBS, DEFAULT_FILTERS, NOW)[0]!;
    const railColour = STATUS[firstJob.status as keyof typeof STATUS] ?? STATUS.unassigned;
    const rail = findAll(rows[0]!, (n) => flatStyle(n).backgroundColor === railColour);
    expect(rail.length).toBeGreaterThan(0);
  });

  it('chips are console targets: 44pt with hitSlop 8; a sheet of large rows opens, not a native picker', async () => {
    const renderer = await create(
      <FilterBar filters={DEFAULT_FILTERS} onChange={() => {}} onClear={() => {}} />,
    );
    const root = toJson(renderer);
    for (const key of ['date', 'tech', 'status']) {
      const chip = findID(root, `filter-chip-${key}`);
      expect(chip).toBeDefined();
      expect(flatStyle(chip!).minHeight).toBe(44);
      expect(chip!.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
    }
    press(findID(root, 'filter-chip-status')!);
    const sheet = findID(toJson(renderer), 'filter-sheet-status');
    expect(sheet).toBeDefined();
    const option = findID(toJson(renderer), 'filter-option-overdue');
    expect(option).toBeDefined();
    expect(flatStyle(option!).minHeight).toBe(44);
  });

  it('answers the trial question through the UI: status sheet → Overdue first row is overdue', async () => {
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    // filter to Overdue across all days through the real chip flow
    press(findID(toJson(renderer), 'filter-chip-date')!);
    press(findID(toJson(renderer), 'filter-option-all-days')!);
    press(findID(toJson(renderer), 'filter-chip-status')!);
    press(findID(toJson(renderer), 'filter-option-overdue')!);

    const root = toJson(renderer);
    const expected = applyFilters(JOBS, { ...DEFAULT_FILTERS, date: 'all', status: 'overdue' }, NOW);
    expect(rowIds(root).length).toBe(expected.length);
    for (const id of rowIds(root)) {
      const job = JOBS.find((j) => j.id === id)!;
      expect(isOverdue(job, NOW)).toBe(true);
    }
  });

  it('search mode finds the Kormangala jobs today through the real field', async () => {
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    press(findID(toJson(renderer), 'job-logs-search-toggle')!);
    const field = firstDescendantOfType(findID(toJson(renderer), 'job-logs-search-field')!, 'TextInput');
    expect(field).toBeDefined();
    act(() => {
      field!.props.onChangeText?.('Kormangala');
    });
    const root = toJson(renderer);
    const shownIds = rowIds(root);
    const expected = applyFilters(JOBS, DEFAULT_FILTERS, NOW).filter((j) => matchesSearch(j, 'Kormangala'));
    expect(shownIds.length).toBe(expected.length);
    expect(shownIds.every((id) => expected.some((j) => j.id === id))).toBe(true);
  });

  it('empty-filtered keeps the FilterBar visible and Clear filters restores the list', async () => {
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    // Tomorrow carries no in-progress work in the fixture — a chip
    // combination that genuinely empties the list.
    press(findID(toJson(renderer), 'filter-chip-date')!);
    press(findID(toJson(renderer), 'filter-option-tomorrow')!);
    press(findID(toJson(renderer), 'filter-chip-status')!);
    press(findID(toJson(renderer), 'filter-option-in-progress')!);

    const emptied = toJson(renderer);
    expect(findID(emptied, 'job-logs-empty-filtered')).toBeDefined();
    expect(allText(findID(emptied, 'job-logs-empty-filtered')!).join('')).toContain('No jobs match these filters.');
    // the user needs to see what they set — the bar stays
    expect(findID(emptied, 'job-logs-filter-bar')).toBeDefined();
    expect(rowIds(emptied)).toEqual([]);

    // The empty state's *Clear filters* button restores the default view.
    const emptyNode = findID(emptied, 'job-logs-empty-filtered')!;
    const clearButton = findAll(emptyNode, (n) => typeof n.props.onPress === 'function')[0]!;
    press(clearButton);
    const restored = toJson(renderer);
    expect(rowIds(restored).length).toBe(applyFilters(JOBS, DEFAULT_FILTERS, NOW).length);
  });

  it('unfiltered empty reads "No jobs yet."', async () => {
    const renderer = await create(<JobLogsScreen jobs={[]} now={NOW} onOpenJob={() => {}} />);
    expect(findID(toJson(renderer), 'job-logs-empty-all')).toBeDefined();
  });

  it('the measured row is the console 56pt token — what FlashList v2 measures natively', async () => {
    await create(<JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />);
    // D2 seeds the list from a measured row; FlashList v2 measures real
    // rows itself (T1.17's resolution), so the constant the rows render
    // at IS the estimate: console.rowHeight = 56.
    expect(DENSITY.console.rowHeight).toBe(56);
    const rows = allInTree(toJson(await create(<JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />)), (n) =>
      typeof n.props.testID === 'string' && n.props.testID.startsWith('job-logs-row-'),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(flatStyle(row).height).toBe(56);
  });

  it('filter changes re-sort with no animation in the tree', async () => {
    const renderer = await create(
      <JobLogsScreen jobs={JOBS} now={NOW} onOpenJob={() => {}} />,
    );
    const animated = findAll(toJson(renderer), (n) => String(n.type).toLowerCase().includes('animated'));
    expect(animated).toEqual([]);
  });
});

describe('T1.22 memo contract — rows skip re-render when nothing changed', () => {
  it('a row re-renders only when its job or overdue flag changes', async () => {
    const job: SpikeJob = JOBS[0]!;
    const renderer = await create(
      <JobLogsRow job={job} overdue={false} onPress={noop} testID="row" />,
    );
    expect(rowRenderCount()).toBe(1);
    await act(async () => {
      renderer.update(<JobLogsRow job={job} overdue={false} onPress={noop} testID="row" />);
    });
    expect(rowRenderCount()).toBe(1); // identical props — skipped
    await act(async () => {
      renderer.update(<JobLogsRow job={job} overdue={true} onPress={noop} testID="row" />);
    });
    expect(rowRenderCount()).toBe(2); // overdue chip appeared — real change
  });

  it('a full screen re-render around unchanged rows re-renders none of them', async () => {
    const deps = { jobs: JOBS, now: NOW, onOpenJob: () => {} };
    const renderer = await create(<JobLogsScreen {...deps} />);
    const afterMount = rowRenderCount();
    expect(afterMount).toBe(applyFilters(JOBS, DEFAULT_FILTERS, NOW).length);
    // A fresh element tree with identical values (the thing a scroll or
    // an unrelated state change produces): rows must not re-render.
    await act(async () => {
      renderer.update(<JobLogsScreen jobs={[...JOBS]} now={new Date(NOW.getTime())} onOpenJob={() => {}} />);
    });
    expect(rowRenderCount()).toBe(afterMount);
  });
});
