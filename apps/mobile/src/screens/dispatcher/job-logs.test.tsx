/**
 * D2 Job Logs tests (T2.8, UI/plan-2/05-DISPATCHER.md §D2) — the six
 * the spec names:
 *
 * - **Filter state round-trips through the URL and survives a
 *   remount** — the codec is pure (`jobLogsFiltersToParams` /
 *   `jobLogsFiltersFromParams`), the URL is the only owner, and a
 *   filtered view re-opens exactly as it was left.
 * - **Result count updates with the filter and includes the overdue
 *   sub-count** — "24 jobs · 3 overdue" before the dispatcher scrolls;
 *   overdue-ness is the CARD's server-judged flag, never a client clock.
 * - **Long-press at 400ms fires the haptic BEFORE release and enters
 *   selection mode** — `Selection` at the threshold, the row scales to
 *   0.97, the header cross-fades to "N selected"; a checkbox never
 *   appears.
 * - **Partial bulk failure renders the named job in the message** —
 *   "5 reassigned, 1 failed — JC-…0044 …", the server's own sentence
 *   next to the job it refused.
 * - **Offline disables the filter chips, not just the list** — a filter
 *   applied to stale data produces a confident wrong answer.
 * - **No entrance or exit animation on filter change** — after a filter
 *   change the list subtree carries no animated style on any row: the
 *   list simply IS the new rows. The only animated style a row ever
 *   carries is the §5.4 pick-up, and only while it is selected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react';

// The haptic stub direct — the same module instance the vitest alias
// feeds `haptic()` through, with the `__fired` assertion surface.
import * as Haptics from '../../test-stubs/expo-haptics';
import type { ReactTestRenderer } from 'react-test-renderer';

import { DENSITY, SEMANTIC } from '@servgrid/shared';
import {
  allText,
  create,
  findAll,
  findByTestID,
  firstDescendantOfType,
  toJson,
  type Node,
} from '../../components/ui/testing';
import { JobLogsScreen, JOB_LOGS_OFFLINE_MESSAGE, formatBulkOutcome, type JobLogsDeps } from './job-logs';
import {
  DEFAULT_JOB_LOGS_FILTERS,
  jobLogsFiltersFromParams,
  jobLogsFiltersToParams,
  jobLogsParamsPatch,
  type JobLogsFilters,
  type JobLogsJob,
} from './jobLogsFilters';

// ── fixtures ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST

const TECH_A = '01890a5e-3000-7000-8000-000000000001';
const TECH_B = '01890a5e-3000-7000-8000-000000000002';

function job(overrides: Partial<JobLogsJob> & { id: string }): JobLogsJob {
  return {
    jobNumber: 'JC-2627-00042',
    title: 'UPS battery swap',
    customerName: 'Sri Venkateshwara Apartments',
    status: 'assigned',
    overdue: false,
    scheduledFor: '2026-09-11T14:30:00+05:30',
    technicianName: 'Ravi Kumar',
    ...overrides,
  };
}

const JOBS: JobLogsJob[] = [
  job({ id: 'j1', overdue: true, status: 'in_progress', scheduledFor: '2026-09-11T09:00:00+05:30' }),
  job({ id: 'j2', jobNumber: 'JC-2627-00043', scheduledFor: '2026-09-11T15:00:00+05:30' }),
  job({ id: 'j3', jobNumber: 'JC-2627-00031', overdue: true, status: 'assigned', scheduledFor: '2026-09-10T09:15:00+05:30' }),
];

function baseDeps(overrides: Partial<JobLogsDeps> = {}): JobLogsDeps {
  return {
    now: NOW,
    offline: false,
    loading: false,
    jobs: JOBS,
    error: null,
    technicians: [
      { employeeId: TECH_A, name: 'Ravi Kumar', openTotal: 3 },
      { employeeId: TECH_B, name: 'Anitha Prasad', openTotal: 6 },
    ],
    filters: DEFAULT_JOB_LOGS_FILTERS,
    query: '',
    bulkFlagOn: true,
    bulkBusy: false,
    bulkOutcome: null,
    bulkError: null,
    onFiltersChange: vi.fn(),
    onQueryChange: vi.fn(),
    onOpenJob: vi.fn(),
    onReassign: vi.fn(),
    onDismissBulk: vi.fn(),
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides,
  };
}

// ── harness helpers ──────────────────────────────────────────────────────

function findID(renderer: ReactTestRenderer, testID: string): Node | undefined {
  return findByTestID(toJson(renderer), testID);
}

function press(node: Node): void {
  expect(typeof node.props.onPress).toBe('function');
  act(() => {
    node.props.onPress?.();
  });
}

/** The long-press, fired at its threshold — the release never comes. */
function longPress(node: Node): void {
  const handler = node.props.onLongPress as (() => void) | undefined;
  expect(typeof handler).toBe('function');
  act(() => {
    handler?.();
  });
}

function flatStyle(node: Node): Record<string, unknown> {
  const style = node.props.style as Record<string, unknown> | Record<string, unknown>[];
  if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean));
  return (style as Record<string, unknown>) ?? {};
}

function textOf(renderer: ReactTestRenderer, testID: string): string {
  const node = findID(renderer, testID);
  expect(node).toBeDefined();
  return normText(allText(node!).join(' '));
}

/** JSX splits `{n} selected` across text nodes; compare on words. */
function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The pressable a primitive owns — Button hangs its testID on the
 * outer View and its onPress on the Pressable inside. */
function pressableOf(node: Node): Node {
  if (typeof node.props.onPress === 'function') return node;
  const inner = findAll(node, (n) => typeof n.props.onPress === 'function')[0];
  expect(inner).toBeDefined();
  return inner!;
}

function rowIds(renderer: ReactTestRenderer): string[] {
  return findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('job-logs-row-')).map(
    (n) => (n.props.testID as string).replace('job-logs-row-', ''),
  );
}

/** Animated nodes inside the list subtree — the rows' animated styles. */
function animatedInList(renderer: ReactTestRenderer): Node[] {
  const list = findID(renderer, 'job-logs-list');
  expect(list).toBeDefined();
  return findAll(list!, (n) => String(n.type).toLowerCase().includes('animated'));
}

beforeEach(() => {
  Haptics.__reset();
});

// ── the six ──────────────────────────────────────────────────────────────

describe('JobLogsScreen (§D2)', () => {
  it('filter state round-trips through the URL and survives a remount', async () => {
    // The route plays URL owner here, exactly as `router.setParams`
    // would: every screen change request is applied back through props,
    // so the next render reads what the URL would say.
    let applied: JobLogsFilters = DEFAULT_JOB_LOGS_FILTERS;
    const onFiltersChange = vi.fn((next: JobLogsFilters) => {
      applied = next;
      act(() => {
        renderer.update(<JobLogsScreen {...baseDeps({ filters: applied, onFiltersChange })} />);
      });
    });
    const renderer = await create(<JobLogsScreen {...baseDeps({ filters: applied, onFiltersChange })} />);

    // The dispatcher scopes through the chips; every change is offered
    // to the URL owner, never held in the screen.
    press(findID(renderer, 'job-logs-chip-date')!);
    press(findID(renderer, 'filter-option-all-days')!);
    expect(onFiltersChange).toHaveBeenCalledWith({ ...DEFAULT_JOB_LOGS_FILTERS, date: 'all' });

    press(findID(renderer, 'job-logs-chip-status')!);
    press(findID(renderer, 'filter-option-overdue')!);
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_JOB_LOGS_FILTERS, date: 'all', status: 'overdue' });

    // URL round-trip: encode what the dispatcher set, read it back the
    // way a reload or a shared link does — the codec is lossless, and
    // defaults stay out of the URL entirely.
    const set: JobLogsFilters = { ...DEFAULT_JOB_LOGS_FILTERS, date: 'week', status: 'overdue', tech: { kind: 'tech', technicianId: TECH_A, name: 'Ravi Kumar' } };
    const params = jobLogsFiltersToParams(set, 'JC-2627-00042');
    expect(params).toEqual({ date: 'week', status: 'overdue', tech: TECH_A, q: 'JC-2627-00042' });
    const decoded = jobLogsFiltersFromParams(params);
    expect(jobLogsFiltersToParams(decoded.filters, decoded.query)).toEqual(params);

    // What the hook WRITES is the delta with every omitted key named
    // `undefined`: `setParams` merges, so a key left out kept its old
    // value in the URL and Clear was a dead button (2026-09-17). Naming
    // the defaults is what makes the merge delete them.
    expect(jobLogsParamsPatch(set, 'JC-2627-00042')).toEqual({
      date: 'week',
      tech: TECH_A,
      status: 'overdue',
      q: 'JC-2627-00042',
    });
    expect(jobLogsParamsPatch(DEFAULT_JOB_LOGS_FILTERS, '')).toEqual({
      date: undefined,
      tech: undefined,
      status: undefined,
      q: undefined,
    });

    // A remount with only the URL in hand re-opens the exact view:
    // search mode answers the link's own question, and the chips read
    // back once search is closed — the roster resolves the name.
    const remounted = await create(
      <JobLogsScreen {...baseDeps({ filters: decoded.filters, query: decoded.query })} />,
    );
    const input = firstDescendantOfType(findID(remounted, 'job-logs-search-field')!, 'TextInput');
    expect(input).toBeDefined();
    expect(input!.props.value).toBe('JC-2627-00042');
    press(pressableOf(findID(remounted, 'job-logs-search-toggle')!));
    expect(textOf(remounted, 'job-logs-chip-date')).toContain('This week');
    expect(textOf(remounted, 'job-logs-chip-status')).toContain('Overdue');
    expect(textOf(remounted, 'job-logs-chip-tech')).toContain('Ravi Kumar');
  });

  it('“Unassigned” is a choice under the person filter, and the two views of it cannot contradict', async () => {
    // Yashas, 2026-09-17: "add unassigned to the filter". It was only
    // under Status; the person chip — where a dispatcher looks for "nobody
    // holds it" — now offers it too. Both write the ONE fact the api has
    // (`status=unassigned`), so the chips can never disagree.
    const onFiltersChange = vi.fn();
    const renderer = await create(<JobLogsScreen {...baseDeps({ onFiltersChange })} />);
    press(findID(renderer, 'job-logs-chip-tech')!);
    press(findID(renderer, 'filter-option-unassigned')!);
    expect(onFiltersChange).toHaveBeenCalledWith({ ...DEFAULT_JOB_LOGS_FILTERS, status: 'unassigned' });

    // With the status applied, the person chip reads the same word.
    const unassignedFilters: JobLogsFilters = { ...DEFAULT_JOB_LOGS_FILTERS, status: 'unassigned' };
    const unassigned = await create(<JobLogsScreen {...baseDeps({ filters: unassignedFilters })} />);
    expect(textOf(unassigned, 'job-logs-chip-tech')).toContain('Unassigned');

    // …and naming a technician — who by definition does hold it — takes
    // the unassigned status back off rather than leaving the two chips
    // asserting different things.
    const onPick = vi.fn();
    const holding = await create(
      <JobLogsScreen {...baseDeps({ filters: unassignedFilters, onFiltersChange: onPick })} />,
    );
    press(findID(holding, 'job-logs-chip-tech')!);
    press(findID(holding, 'filter-option-ravi-kumar')!);
    expect(onPick).toHaveBeenCalledWith({
      ...DEFAULT_JOB_LOGS_FILTERS,
      tech: { kind: 'tech', technicianId: TECH_A, name: 'Ravi Kumar' },
    });
  });

  it('result count updates with the filter and includes the overdue sub-count', async () => {
    const renderer = await create(<JobLogsScreen {...baseDeps()} />);

    // Always visible, above the list: three rows on, two of them broken
    // promises — the dispatcher knows the filter worked before scrolling.
    expect(textOf(renderer, 'job-logs-result-count')).toBe('3 jobs · 2 overdue');

    // The server answered a narrower filter: the count IS the view.
    await act(async () => {
      renderer.update(<JobLogsScreen {...baseDeps({ jobs: [JOBS[1]!] })} />);
    });
    expect(textOf(renderer, 'job-logs-result-count')).toBe('1 job');

    // The type lives in the URL round-trip above; here the count is the
    // thing: the server answered a narrower filter and the count IS the
    // view, one pass, no client clock.
    const serverFlags = [
      job({ id: 's1', overdue: false, scheduledFor: '2026-09-01T09:00:00+05:30' }),
      job({ id: 's2', jobNumber: 'JC-2627-00009', overdue: true, scheduledFor: null }),
    ];
    await act(async () => {
      renderer.update(<JobLogsScreen {...baseDeps({ jobs: serverFlags })} />);
    });
    expect(textOf(renderer, 'job-logs-result-count')).toBe('2 jobs · 1 overdue');
  });

  it('long-press at 400ms fires the haptic before release and enters selection mode', async () => {
    const deps = baseDeps();
    const renderer = await create(<JobLogsScreen {...deps} />);

    // The threshold is the contract: 400ms, the haptic fires at it —
    // before the finger lifts — and no open-job press ever ran.
    const row = findID(renderer, 'job-logs-row-j1')!;
    expect(row.props.delayLongPress).toBe(400);
    expect(row.props.onPress).toBeTypeOf('function');
    longPress(row);

    expect(Haptics.__fired()).toContain('selection'); // `Selection` at the threshold
    expect(deps.onOpenJob).not.toHaveBeenCalled(); // the finger has not lifted

    // Selection mode: the header cross-fades to the count with Reassign
    // and Cancel; no checkbox ever renders — the row itself is armed.
    expect(textOf(renderer, 'job-logs-selection-count')).toBe('1 selected');
    expect(flatStyle(findID(renderer, 'job-logs-selection-header')!).opacity).toBe(1);
    expect(flatStyle(findID(renderer, 'job-logs-header')!).opacity).toBe(0);
    expect(findID(renderer, 'job-logs-reassign')).toBeDefined();
    expect(findID(renderer, 'job-logs-selection-cancel')).toBeDefined();
    expect(findID(renderer, 'job-logs-row-j1')!.props.accessibilityState).toMatchObject({ selected: true });
    // §5.4 pick-up: scale 0.97 over a strengthened border, on that row alone
    expect(flatStyle(findID(renderer, 'job-logs-row-j1')!).borderColor).toBe(SEMANTIC.line.focus);
    const j2 = findID(renderer, 'job-logs-row-j2')!;
    expect(j2.props.accessibilityState).toMatchObject({ selected: false });

    // The release, when it comes on a selected row, toggles — it does
    // not open the job.
    press(findID(renderer, 'job-logs-row-j1')!);
    expect(deps.onOpenJob).not.toHaveBeenCalled();
    expect(textOf(renderer, 'job-logs-selection-count')).toBe('0 selected');
    expect(flatStyle(findID(renderer, 'job-logs-selection-header')!).opacity).toBe(0);
    expect(flatStyle(findID(renderer, 'job-logs-header')!).opacity).toBe(1);
  });

  it('partial bulk failure renders the named job in the message', async () => {
    const deps = baseDeps();
    const renderer = await create(<JobLogsScreen {...deps} />);

    // Long-press arms, Reassign opens the picker, a technician is
    // chosen — the selection rides to the seam with the job ids, and
    // the mode ends the moment the reassign is in flight.
    longPress(findID(renderer, 'job-logs-row-j1')!);
    press(pressableOf(findID(renderer, 'job-logs-reassign')!));
    const option = findID(renderer, `job-logs-reassign-${TECH_A}`)!;
    expect(option).toBeDefined();
    press(option);
    expect(deps.onReassign).toHaveBeenCalledWith(['j1'], TECH_A);
    expect(textOf(renderer, 'job-logs-selection-count')).toBe('0 selected');

    // The server answered honestly: five applied, one refused — and the
    // dispatcher reads WHICH job, in the server's own words (§D2).
    const withOutcome = baseDeps({
      bulkOutcome: {
        reassigned: 5,
        failed: 1,
        failures: [
          { jobId: 'j9', jobNumber: 'JC-2627-00044', message: 'This job is already completed — that is final.' },
        ],
      },
    });
    await act(async () => {
      renderer.update(<JobLogsScreen {...withOutcome} />);
    });
    const banner = textOf(renderer, 'job-logs-bulk-outcome');
    expect(banner).toContain('5 reassigned, 1 failed');
    expect(banner).toContain('JC-…0044');
    expect(banner).toContain('This job is already completed — that is final.');

    // Dismissal is explicit; a clean sweep reads as success, not danger.
    press(findID(renderer, 'job-logs-bulk-outcome-dismiss')!);
    expect(withOutcome.onDismissBulk).toHaveBeenCalled();
    await act(async () => {
      renderer.update(
        <JobLogsScreen
          {...baseDeps({
            bulkOutcome: { reassigned: 3, failed: 0, failures: [] },
          })}
        />,
      );
    });
    expect(textOf(renderer, 'job-logs-bulk-outcome')).toContain('3 reassigned.');
    expect(formatBulkOutcome({ reassigned: 0, failed: 0, failures: [] })).toBe('0 reassigned.');

    // `dispatch.bulk` gates Reassign alone — without it the risky half
    // is unfindable even in selection mode.
    const bulkOff = await create(<JobLogsScreen {...baseDeps({ bulkFlagOn: false })} />);
    longPress(findID(bulkOff, 'job-logs-row-j1')!);
    expect(findID(bulkOff, 'job-logs-reassign')).toBeUndefined();
    expect(textOf(bulkOff, 'job-logs-selection-count')).toBe('1 selected');
  });

  it('offline disables the filter chips, not just the list', async () => {
    const deps = baseDeps({ offline: true });
    const renderer = await create(<JobLogsScreen {...deps} />);

    // The danger banner, words verbatim with D1's — the one role where
    // stale data is dangerous says so, out loud.
    expect(textOf(renderer, 'job-logs-offline-banner')).toBe(JOB_LOGS_OFFLINE_MESSAGE);

    // Every chip is DISABLED — not dimmed alone: the guard is on the
    // control, and a stale filter can never be applied.
    for (const key of ['date', 'tech', 'status']) {
      const chip = findID(renderer, `job-logs-chip-${key}`)!;
      expect(chip.props.disabled).toBe(true);
      expect(chip.props.accessibilityState).toMatchObject({ disabled: true });
    }
    press(findID(renderer, 'job-logs-chip-date')!);
    expect(findID(renderer, 'job-logs-sheet-date')).toBeUndefined(); // no sheet opens

    // The list dims to read-only; rows stay visible (a dispatcher may
    // still LOOK at what he has), but search is armed no more.
    const list = findID(renderer, 'job-logs-list')!;
    expect(list).toBeDefined();
    expect(findID(renderer, 'job-logs-search-toggle')!.props.disabled).toBe(true);
    const dimmed = findAll(toJson(renderer), (n) => flatStyle(n).opacity === 0.4);
    expect(dimmed.length).toBeGreaterThan(0);
  });

  it('no entrance or exit animation on filter change — no animated style is attached to rows', async () => {
    const deps = baseDeps();
    const renderer = await create(<JobLogsScreen {...deps} />);

    // Resting: the list subtree carries no animated node at all.
    expect(animatedInList(renderer)).toEqual([]);

    // §5.4 pick-up: the ONE animated style a row can carry — the
    // pick-up scale — joins only while that row is selected.
    longPress(findID(renderer, 'job-logs-row-j1')!);
    const armed = animatedInList(renderer);
    expect(armed.length).toBe(1);
    expect(armed[0]!.type).toBe('Animated.View');

    // A filter change re-scopes: the list simply IS the new rows — no
    // stagger, no re-entrance, no animated style anywhere on them.
    await act(async () => {
      renderer.update(<JobLogsScreen {...baseDeps({ ...deps, filters: { ...DEFAULT_JOB_LOGS_FILTERS, date: 'all' } })} />);
    });
    expect(animatedInList(renderer)).toEqual([]);
    // overdue first, then by slot: j3 (yesterday) leads, j1 (today's
    // broken slot) follows, j2 rides last.
    expect(rowIds(renderer)).toEqual(['j3', 'j1', 'j2']);

    // 56pt console rows, still — the geometry the motion budget buys.
    for (const id of rowIds(renderer)) {
      expect(flatStyle(findID(renderer, `job-logs-row-${id}`)!).height).toBe(DENSITY.console.rowHeight);
      expect(DENSITY.console.rowHeight).toBe(56);
    }
  });
});
