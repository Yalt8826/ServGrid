/**
 * O1 Dashboard tests (T4.8, UI/plan-2/07-OWNER.md §O1) — the five the
 * spec names, plus the state distinctions §O1 demands:
 *
 * - **Four figures, tabular, `en-IN` grouped** — `₹1,00,000`, never
 *   `₹100,000`; the money is the one formatter's output and the figures
 *   carry `tabular-nums` so columns of weeks align.
 * - **Empty attention renders the explicit line** — "Nothing needs
 *   attention." — and the empty line is a DIFFERENT element from a
 *   failed read (error + Retry) and from a loading read (nothing yet):
 *   the owner can tell "no problems" from "not loaded".
 * - **Exactly one accented element per chart** — the current day's bar,
 *   the current week's dot; the grid is slate.200, the data slate.900.
 * - **Desktop renders a 4-up row; phone renders stacked cards, never a
 *   card grid on desktop** — density from context, the same data.
 * - **New deployment: each figure shows `0` with a caption naming what
 *   would populate it.**
 *
 * The desk layout is exercised through the DensityProvider seam (the
 * NavShell branch sets it once in the app); the attention table's web
 * implementation renders through the FlashList stub exactly as the
 * DataTable suite does.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { COLORS, SEMANTIC } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson, type Node } from '../../components/ui/testing';
import { DensityProvider } from '../../components/ui/DensityProvider';
import { lineGeometry } from './charts';
// The desk table is exercised through its explicit .web module, exactly
// as the DataTable suite renders the web-only primitive under the stub.
import { AttentionTable as AttentionTableWeb } from './AttentionTable.web';
import {
  NOTHING_NEEDS_ATTENTION,
  OFFLINE_BANNER_MESSAGE,
  OwnerDashboardScreen,
  welcomeGreeting,
  type OwnerDashboardDeps,
} from './dashboard';
import type { AttentionItem, AttentionRowVm, JobsPerDayPoint, RevenuePerWeekPoint } from './model';
import { attentionRowsOf } from './model';

// ── fixtures ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-07T18:40:00+05:30'); // Sunday evening — the worst moment, §O1

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** 30 days ending today (2026-09-07), jobs deterministic, max 10. */
function jobsPerDayFixture(): JobsPerDayPoint[] {
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 9) + i * DAY_MS).toISOString().slice(0, 10),
    jobs: (i * 3) % 11,
  }));
}

/** 12 ISO weeks ending the current one; revenue ramps to 55,000. */
function revenuePerWeekFixture(): RevenuePerWeekPoint[] {
  return Array.from({ length: 12 }, (_, i) => ({
    weekStart: new Date(Date.UTC(2026, 5, 22) + i * WEEK_MS).toISOString().slice(0, 10),
    revenue: String(i * 5000),
  }));
}

const figuresFixture = [
  { key: 'openJobs', label: 'open jobs today', value: '11', caption: '2 unassigned · 5 assigned · 1 en route · 3 in progress' },
  { key: 'cashAwaiting', label: 'cash awaiting confirmation', value: '₹1,00,000', caption: 'cash collected, not yet confirmed' },
  { key: 'monthToDate', label: 'month-to-date revenue', value: '₹12,34,567.50', caption: 'completion revenue this month' },
  { key: 'companyDues', label: 'outstanding company dues', value: '₹0', caption: 'what companies still owe' },
] as const;

function baseDeps(overrides: Partial<OwnerDashboardDeps> = {}): OwnerDashboardDeps {
  return {
    now: NOW,
    ownerName: 'Yashas',
    offline: false,
    figures: figuresFixture.map((f) => ({ ...f })),
    jobsPerDay: jobsPerDayFixture(),
    revenuePerWeek: revenuePerWeekFixture(),
    dashboardError: null,
    attention: [
      {
        key: 'missing_submission-0',
        category: 'missing_submission',
        severity: 'danger',
        title: 'Ravi — no declaration',
        meta: 'Collected ₹12,000 on 3 Sep',
        note: 'missing submission',
        target: '/cash',
      },
    ],
    attentionError: null,
    onRetry: vi.fn(),
    onOpenRow: vi.fn(),
    ...overrides,
  };
}

function renderScreen(deps: OwnerDashboardDeps, density: 'field' | 'desk' = 'field') {
  return create(
    <DensityProvider density={density}>
      <OwnerDashboardScreen {...deps} />
    </DensityProvider>,
  );
}

// ── readers ──────────────────────────────────────────────────────────────

function styleOfNode(node: Node): Record<string, unknown> {
  const raw = node.props.style;
  if (Array.isArray(raw)) return Object.assign({}, ...raw) as Record<string, unknown>;
  return (raw ?? {}) as Record<string, unknown>;
}

function styleOf(renderer: ReactTestRenderer, testID: string): Record<string, unknown> {
  const node = findByTestID(toJson(renderer), testID);
  expect(node).toBeDefined();
  return styleOfNode(node!);
}

function textOf(renderer: ReactTestRenderer, testID: string): string | undefined {
  const node = findByTestID(toJson(renderer), testID);
  if (node === undefined) return undefined;
  return (node.children ?? []).filter((c): c is string => typeof c === 'string').join('');
}

/** The `index`th child of `node`, which the tree keeps as a host node. */
function childAt(node: Node, index: number): Node {
  const child = node.children?.[index];
  expect(typeof child).toBe('object');
  return child as Node;
}

/** Every node in `root` whose merged style paints `COLORS.accent`. */
function accentNodes(root: Node): Node[] {
  return findAll(root, (n) => styleOfNode(n).backgroundColor === COLORS.accent);
}

// ── the tests ────────────────────────────────────────────────────────────

describe('OwnerDashboardScreen (§O1) — the welcome', () => {
  it('greets the owner by name, above the title, on both densities', async () => {
    for (const density of ['field', 'desk'] as const) {
      const renderer = await renderScreen(baseDeps({ ownerName: 'Yashas' }), density);
      expect(textOf(renderer, 'owner-greeting')).toBe('Welcome back, Yashas');
      // The page's identity is still the title beneath it — the greeting
      // names the person, not the screen.
      expect(textOf(renderer, 'owner-title')).toBe('Dashboard');
    }
  });

  it('degrades to the username before the name resolves, and never greets nobody', async () => {
    // The route passes the session's username until `/auth/me` lands, so
    // the greeting reads a real name from the first frame.
    const viaUsername = await renderScreen(baseDeps({ ownerName: 'owner' }));
    expect(textOf(viaUsername, 'owner-greeting')).toBe('Welcome back, owner');

    // An unresolved EMPTY name renders no greeting line at all — the
    // header must not reserve a line and then fill it, and "Welcome
    // back, " over nothing reads as a broken screen.
    const blank = await renderScreen(baseDeps({ ownerName: '   ' }));
    expect(findByTestID(toJson(blank), 'owner-greeting')).toBeUndefined();
    expect(textOf(blank, 'owner-title')).toBe('Dashboard');
  });

  it('says "Welcome back" whatever the hour — the owner opens this when his day ends', () => {
    expect(welcomeGreeting('Yashas')).toBe('Welcome back, Yashas');
    expect(welcomeGreeting('')).toBe('');
    expect(welcomeGreeting('  ')).toBe('');
  });
});

describe('OwnerDashboardScreen (§O1)', () => {
  it('renders the four figures in order, tabular, en-IN grouped — ₹1,00,000, not ₹100,000', async () => {
    const renderer = await renderScreen(baseDeps());

    // Order is the plan's table: open jobs, cash awaiting, MTD, dues.
    const values = findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && /-value$/.test(n.props.testID));
    expect(values.map((n) => n.props.testID)).toEqual([
      'owner-figure-openJobs-value',
      'owner-figure-cashAwaiting-value',
      'owner-figure-monthToDate-value',
      'owner-figure-companyDues-value',
    ]);
    expect(values.map((n) => (n.children ?? []).join(''))).toEqual(['11', '₹1,00,000', '₹12,34,567.50', '₹0']);

    // Indian grouping, explicitly not western: the cash figure reads
    // ₹1,00,000 (3-then-2s), and no figure anywhere shows ₹100,000.
    expect(textOf(renderer, 'owner-figure-cashAwaiting-value')).toBe('₹1,00,000');
    expect(textOf(renderer, 'owner-figure-cashAwaiting-value')).not.toBe('₹100,000');
    expect(textOf(renderer, 'owner-figure-monthToDate-value')).toBe('₹12,34,567.50');

    // Tabular figures on every value (§2.1), `display` 32 Condensed on the phone.
    for (const key of ['openJobs', 'cashAwaiting', 'monthToDate', 'companyDues'] as const) {
      const style = styleOf(renderer, `owner-figure-${key}-value`);
      expect(style.fontVariant).toEqual(['tabular-nums']);
      expect(style.fontSize).toBe(32);
      expect(style.color).toBe(SEMANTIC.text.primary);
      // Label beneath (phone anatomy), then the caption naming the source.
      expect(textOf(renderer, `owner-figure-${key}-label`)).toBeDefined();
      expect(textOf(renderer, `owner-figure-${key}-caption`)).toBeDefined();
    }
  });

  it('empty attention renders the explicit line — distinguishable from error and from loading', async () => {
    // Empty feed: the words, verbatim, on their own element — not blank space.
    const empty = await renderScreen(baseDeps({ attention: [] }));
    const emptyNode = findByTestID(toJson(empty), 'owner-attention-empty');
    expect(emptyNode).toBeDefined();
    expect(allText(emptyNode!).join(' ')).toBe(NOTHING_NEEDS_ATTENTION);
    expect(findByTestID(toJson(empty), 'owner-attention-row-0')).toBeUndefined();

    // A FAILED read is not "no problems": the error element, with Retry,
    // and NOT the empty line — the owner can tell them apart.
    const deps = baseDeps({ attention: null, attentionError: 'The queue could not be read.' });
    const failed = await renderScreen(deps);
    expect(findByTestID(toJson(failed), 'owner-attention-empty')).toBeUndefined();
    const errorNode = findByTestID(toJson(failed), 'owner-attention-error');
    expect(errorNode).toBeDefined();
    expect(allText(errorNode!).join(' ')).toContain('The queue could not be read.');
    const retry = findAll(errorNode!, (n) => typeof n.props.onPress === 'function')[0];
    expect(retry).toBeDefined();
    await act(async () => {
      (retry!.props.onPress as () => void)();
    });
    expect(deps.onRetry).toHaveBeenCalled();

    // A LOADING read renders neither line — no false "no problems".
    const loading = await renderScreen(
      baseDeps({ figures: null, jobsPerDay: null, revenuePerWeek: null, attention: null }),
    );
    expect(findByTestID(toJson(loading), 'owner-attention-empty')).toBeUndefined();
    expect(findByTestID(toJson(loading), 'owner-attention-error')).toBeUndefined();
  });

  it('exactly one accented element per chart — the current period; grid and data stay slate', async () => {
    const renderer = await renderScreen(baseDeps());
    const tree = toJson(renderer);

    // Bars: 30 bars, accent on the LAST (today) alone.
    const jobs = findByTestID(tree, 'owner-chart-jobs');
    expect(jobs).toBeDefined();
    const bars = findAll(jobs!, (n) => typeof n.props.testID === 'string' && /-bar-\d+$/.test(n.props.testID));
    expect(bars).toHaveLength(30);
    const jobsAccents = accentNodes(jobs!);
    expect(jobsAccents).toHaveLength(1);
    expect(jobsAccents[0]!.props.testID).toBe('owner-chart-jobs-bar-29');
    for (const bar of bars) {
      if (bar.props.testID !== 'owner-chart-jobs-bar-29') {
        expect(styleOfNode(bar).backgroundColor).toBe(SEMANTIC.bg.dark); // slate.900
      }
    }
    // The grid is slate.200 and never accent: 3 interior lines.
    const grids = findAll(jobs!, (n) => typeof n.props.testID === 'string' && /-grid-\d+$/.test(n.props.testID));
    expect(grids).toHaveLength(3);
    for (const grid of grids) expect(styleOfNode(grid).backgroundColor).toBe(SEMANTIC.line.default);

    // Line: 12 dots, accent on the LAST (this week) alone; chords slate.900.
    const revenue = findByTestID(tree, 'owner-chart-revenue');
    expect(revenue).toBeDefined();
    const dots = findAll(revenue!, (n) => typeof n.props.testID === 'string' && /-dot-\d+$/.test(n.props.testID));
    expect(dots).toHaveLength(12);
    const revenueAccents = accentNodes(revenue!);
    expect(revenueAccents).toHaveLength(1);
    expect(revenueAccents[0]!.props.testID).toBe('owner-chart-revenue-dot-11');

    // The whole screen carries exactly two accent paints — one per chart.
    expect(accentNodes(tree)).toHaveLength(2);
  });

  it('the revenue line draws its chords once measured, and the geometry is the value’s shape', async () => {
    const renderer = await renderScreen(baseDeps());
    const revenue = findByTestID(toJson(renderer), 'owner-chart-revenue')!;

    // Pre-measure: dots are already on screen (percentage-positioned);
    // chords need px and wait for the layout pass.
    expect(findAll(revenue, (n) => typeof n.props.testID === 'string' && /-seg-\d+$/.test(n.props.testID))).toHaveLength(0);
    const measurable = findAll(revenue, (n) => typeof n.props.onLayout === 'function')[0];
    expect(measurable).toBeDefined();

    await act(async () => {
      (measurable!.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width: 640, height: 320 } } });
    });

    const measured = findByTestID(toJson(renderer), 'owner-chart-revenue')!;
    const segments = findAll(measured, (n) => typeof n.props.testID === 'string' && /-seg-\d+$/.test(n.props.testID));
    expect(segments).toHaveLength(11); // 12 weeks, 11 chords
    // And the measure changed nothing about the accent rule.
    expect(accentNodes(measured)).toHaveLength(1);

    // Pure geometry, asserted directly: two points, flat-top ramp.
    const geo = lineGeometry([0, 10], 180, 640);
    expect(geo.dots[0]).toEqual({ x: 160, y: 172 });
    expect(geo.dots[1]).toEqual({ x: 480, y: 8 });
    expect(geo.segments[0]!.angle).toBeLessThan(0); // rising into the future
    expect(geo.segments[0]!.width).toBeCloseTo(Math.hypot(320, 164), 5);
  });

  it('desktop renders a 4-up row at displayLg 44; phone renders stacked cards — never a card grid on desktop', async () => {
    // PHONE: cards stacked one per row — raised ground, hairline border,
    // square corners; charts full width, 180 tall.
    const phone = await renderScreen(baseDeps(), 'field');
    const phoneFigures = findByTestID(toJson(phone), 'owner-figures')!;
    expect(phoneFigures.children).toHaveLength(4);
    expect(styleOfNode(phoneFigures).flexDirection).not.toBe('row');
    const phoneCard = styleOf(phone, 'owner-figure-openJobs');
    expect(phoneCard.borderWidth).toBe(1);
    expect(phoneCard.alignSelf).toBe('stretch');
    const phoneChartBlock = childAt(findByTestID(toJson(phone), 'owner-chart-jobs')!, 0);
    expect((phoneChartBlock.props.style as Record<string, unknown>).height).toBe(180);

    // DESK: one 4-up stat ROW — no card chrome, `displayLg` 44; charts
    // side by side at 320.
    const desk = await renderScreen(baseDeps(), 'desk');
    const deskFigures = findByTestID(toJson(desk), 'owner-figures')!;
    expect(styleOfNode(deskFigures).flexDirection).toBe('row');
    expect(deskFigures.children).toHaveLength(4);
    for (const key of ['openJobs', 'cashAwaiting', 'monthToDate', 'companyDues'] as const) {
      const cell = styleOf(desk, `owner-figure-${key}`);
      expect(cell.borderWidth).toBeUndefined(); // a row of figures, not a card grid
      expect(cell.flex).toBe(1);
      expect(styleOf(desk, `owner-figure-${key}-value`).fontSize).toBe(44);
    }
    const deskCharts = findByTestID(toJson(desk), 'owner-charts')!;
    expect(styleOfNode(deskCharts).flexDirection).toBe('row');
    const deskChartBlock = childAt(findByTestID(toJson(desk), 'owner-chart-jobs')!, 0);
    expect((deskChartBlock.props.style as Record<string, unknown>).height).toBe(320);

    // The card-vs-row rule holds with NO fixed widths anywhere in the
    // figures: the layout resolves identically at 360dp and 412dp (the
    // cards stretch), and the desk row fills 1280 and 1920 the same way.
    for (const figure of findAll(toJson(phone), (n) => typeof n.props.testID === 'string' && /^owner-figure-(openJobs|cashAwaiting|monthToDate|companyDues)$/.test(n.props.testID))) {
      expect(styleOfNode(figure).width).toBeUndefined();
    }
  });

  it('a new deployment shows each figure as 0 with a caption naming what would populate it', async () => {
    const renderer = await renderScreen(
      baseDeps({
        figures: [
          { key: 'openJobs', label: 'open jobs today', value: '0', caption: '0 unassigned · 0 assigned · 0 en route · 0 in progress' },
          { key: 'cashAwaiting', label: 'cash awaiting confirmation', value: '₹0', caption: 'cash collected, not yet confirmed' },
          { key: 'monthToDate', label: 'month-to-date revenue', value: '₹0', caption: 'completion revenue this month' },
          { key: 'companyDues', label: 'outstanding company dues', value: '₹0', caption: 'what companies still owe' },
        ],
      }),
    );

    // Zero is rendered, not absent — and every zero sits on its caption.
    expect(textOf(renderer, 'owner-figure-openJobs-value')).toBe('0');
    for (const key of ['cashAwaiting', 'monthToDate', 'companyDues'] as const) {
      expect(textOf(renderer, `owner-figure-${key}-value`)).toBe('₹0');
    }
    expect(textOf(renderer, 'owner-figure-openJobs-caption')).toBe('0 unassigned · 0 assigned · 0 en route · 0 in progress');
    expect(textOf(renderer, 'owner-figure-cashAwaiting-caption')).toBe('cash collected, not yet confirmed');
    expect(textOf(renderer, 'owner-figure-monthToDate-caption')).toBe('completion revenue this month');
    expect(textOf(renderer, 'owner-figure-companyDues-caption')).toBe('what companies still owe');
  });

  it('offline renders the danger banner and greys the figures to text.disabled', async () => {
    const renderer = await renderScreen(baseDeps({ offline: true }));
    const banner = findByTestID(toJson(renderer), 'owner-offline-banner');
    expect(banner).toBeDefined();
    expect(allText(banner!).join(' ')).toBe(OFFLINE_BANNER_MESSAGE);
    for (const key of ['openJobs', 'cashAwaiting', 'monthToDate', 'companyDues'] as const) {
      expect(styleOf(renderer, `owner-figure-${key}-value`).color).toBe(SEMANTIC.text.disabled);
    }
  });

  it('each attention row links straight to the thing', async () => {
    const rows: AttentionRowVm[] = [
      { key: 'missing_submission-0', category: 'missing_submission', severity: 'danger', title: 'Ravi — no declaration', meta: 'Collected ₹12,000 on 3 Sep', note: 'missing submission', target: '/cash' },
      { key: 'overdue_job-1', category: 'overdue_job', severity: 'danger', title: 'JC-2627-00031 · UPS battery swap', meta: 'Sunrise Apartments · was due 1 Sep', note: 'overdue', target: '/jobs/01890a5e-4000-7000-8000-000000000031' },
      { key: 'tracking_health-2', category: 'tracking_health', severity: 'danger', title: 'Anitha — location permission missing', meta: 'last ping 2h 30m ago', note: 'permission_missing', target: '/location' },
    ];
    const onOpenRow = vi.fn();
    const renderer = await renderScreen(baseDeps({ attention: rows, onOpenRow }));

    for (const [index, row] of rows.entries()) {
      const node = findByTestID(toJson(renderer), `owner-attention-row-${index}`);
      expect(node).toBeDefined();
      expect(allText(node!).join(' ')).toContain(row.title);
    }
    const presses = findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && /^owner-attention-row-\d+$/.test(n.props.testID));
    expect(presses).toHaveLength(3);
    await act(async () => {
      (presses[0]!.props.onPress as () => void)();
      (presses[2]!.props.onPress as () => void)();
    });
    expect(onOpenRow).toHaveBeenNthCalledWith(1, '/cash');
    expect(onOpenRow).toHaveBeenNthCalledWith(2, '/location');
  });

  it('the desk attention feed is a table — DataTable rows with the severity on the leading edge', async () => {
    const onOpen = vi.fn();
    const rows: AttentionRowVm[] = [
      { key: 'missing_submission-0', category: 'missing_submission', severity: 'danger', title: 'Ravi — no declaration', meta: 'Collected ₹12,000 on 3 Sep', note: 'missing submission', target: '/cash' },
      { key: 'cash_variance-1', category: 'cash_variance', severity: 'warning', title: 'Suresh — ₹400 short', meta: 'Expected ₹8,400 · declared ₹8,000 on 5 Sep', note: 'variance', target: '/cash' },
    ];
    const renderer = await create(
      <DensityProvider density="desk">
        <AttentionTableWeb rows={rows} onOpen={onOpen} />
      </DensityProvider>,
    );
    const tree = toJson(renderer);

    // The table furniture: header and one row per feed item.
    expect(findByTestID(tree, 'table-header')).toBeDefined();
    expect(findByTestID(tree, 'data-row-missing_submission-0')).toBeDefined();
    expect(findByTestID(tree, 'data-row-cash_variance-1')).toBeDefined();

    // The severity rides the 4px leading edge — the same rail the phone
    // row wears, which is what makes the row and the card one object.
    const rail = childAt(findByTestID(tree, 'data-row-missing_submission-0')!, 0);
    expect(styleOfNode(rail).width).toBe(4);
    expect(styleOfNode(rail).backgroundColor).toBe(SEMANTIC.feedback.danger);

    // And the row pushes the thing.
    const row = findByTestID(tree, 'data-row-missing_submission-0')!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });
    expect(onOpen).toHaveBeenCalledWith('/cash');
  });
});

// ── the AMC ending row (T2B.5, rank 5 — decision 7) ──────────────────────

describe('OwnerDashboardScreen — an AMC ending within 7 days', () => {
  /** The wire item the endpoint returns for rank 5 — everything else null. */
  const endingItem: AttentionItem = {
    category: 'contract_ending',
    employeeId: null,
    employeeName: null,
    businessDate: null,
    expectedCash: null,
    declaredAmount: null,
    variance: null,
    jobId: null,
    jobNumber: null,
    jobTitle: null,
    jobStatus: null,
    scheduledDate: null,
    customerName: 'Sunrise Apartments',
    health: null,
    lastPingAt: null,
    contractId: 'c1',
    contractNumber: 'AMC-2627-00031',
    contractEndDate: '2027-09-14',
  };

  it('maps a contract_ending item to the AMC row — number · customer, ends WITH the year, the AMC itself', () => {
    expect(attentionRowsOf([endingItem], NOW)).toEqual([
      {
        key: 'contract_ending-0',
        category: 'contract_ending',
        severity: 'warning',
        title: 'AMC-2627-00031 · Sunrise Apartments',
        meta: 'ends 14 Sep 2027',
        note: 'AMC ending',
        target: '/contracts/c1',
      },
    ]);

    // The degradations are honest: no end date says "ends soon", no
    // contract id links the AMC list, a missing number still says AMC.
    const bare = attentionRowsOf([{ ...endingItem, contractId: null, contractNumber: null, contractEndDate: null }], NOW);
    expect(bare[0]).toMatchObject({ title: 'AMC · Sunrise Apartments', meta: 'ends soon', target: '/contracts' });
  });

  it('the feed keeps the endpoint’s consequence order — an ending AMC lands where the server put it, never re-sorted', () => {
    const tracking: AttentionItem = {
      category: 'tracking_health',
      employeeId: 'e1',
      employeeName: 'Anitha',
      businessDate: null,
      expectedCash: null,
      declaredAmount: null,
      variance: null,
      jobId: null,
      jobNumber: null,
      jobTitle: null,
      jobStatus: null,
      scheduledDate: null,
      customerName: null,
      health: 'stale',
      lastPingAt: '2026-09-07T14:10:00.000Z',
      contractId: null,
      contractNumber: null,
      contractEndDate: null,
    };
    const rows = attentionRowsOf([tracking, endingItem], NOW);
    expect(rows.map((r) => r.category)).toEqual(['tracking_health', 'contract_ending']);
    expect(rows[1]!.key).toBe('contract_ending-1');
  });

  it('the dashboard renders the row and opens the AMC from it', async () => {
    const onOpenRow = vi.fn();
    const renderer = await renderScreen(baseDeps({ attention: attentionRowsOf([endingItem], NOW), onOpenRow }));
    const tree = toJson(renderer);

    const node = findByTestID(tree, 'owner-attention-row-0');
    expect(node).toBeDefined();
    const text = allText(node!).join(' ');
    expect(text).toContain('AMC-2627-00031 · Sunrise Apartments');
    expect(text).toContain('ends 14 Sep 2027');
    expect(text).toContain('AMC ending');
    // Warning severity on the leading rail — a warning, not a danger.
    const rail = findByTestID(tree, 'owner-attention-row-0-rail');
    expect(styleOfNode(rail!).backgroundColor).toBe(SEMANTIC.feedback.warning);

    await act(async () => {
      (node!.props.onPress as () => void)();
    });
    expect(onOpenRow).toHaveBeenCalledWith('/contracts/c1');
  });
});
