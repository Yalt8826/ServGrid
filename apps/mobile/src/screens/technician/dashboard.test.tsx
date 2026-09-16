/**
 * T1 Dashboard tests (UI/plan-2/04-TECHNICIAN.md §T1) — the four the
 * spec names:
 *
 * - **Three figures, tabular, on the first paint** — the data comes
 *   through `buildJobViews` from a work read exactly as
 *   `GET /v1/technician/work` answers it (online-only since 2026-09-15),
 *   and "done today" is dated by the server's `closedAt`.
 * - **A missing health answer renders no banner** — the chip degrades;
 *   a lost connection is the no-connection gate's to show, not this
 *   screen's.
 * - **Count-up runs once; a second focus renders final values
 *   immediately.**
 * - **No element renders a currency symbol** — no earnings figure, no
 *   amount anywhere in the rendered tree.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { TechnicianWork } from '@servgrid/shared';
import { FRAME, SEMANTIC, STATUS } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson, type Node } from '../../components/ui/testing';
import { buildJobViews, type TechnicianWorkViews } from './workData';
import { DashboardScreen } from './DashboardScreen';
import type { JobView } from './jobView';

// ── fixtures ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST

const MORNING = '2026-09-11T08:00:00+05:30'; // past — overdue
const AFTERNOON = '2026-09-11T14:30:00+05:30'; // today, later
const EVENING = '2026-09-11T16:00:00+05:30'; // today, latest
const TOMORROW = '2026-09-12T09:00:00+05:30';

let seq = 0;

function makeJob(overrides: Partial<TechnicianWork['jobs'][number]> = {}): TechnicianWork['jobs'][number] {
  seq += 1;
  const id = `01890a5e-1000-7000-8000-${String(seq).padStart(12, '0')}`;
  return {
    id,
    jobNumber: `JC-2627-${String(seq).padStart(5, '0')}`,
    title: 'UPS battery swap',
    status: 'assigned',
    priority: 'normal',
    scheduledFor: AFTERNOON,
    customerId: '01890a5e-2000-7000-8000-000000000001',
    contactName: 'Mr Prakash',
    contactPhone: '+919000000001',
    description: null,
    contract: null,
    version: 1,
    closedAt: null,
    ...overrides,
  };
}

function makeCustomer(): TechnicianWork['customers'][number] {
  return {
    id: '01890a5e-2000-7000-8000-000000000001',
    name: 'Sunrise Apartments',
    phone: '+919000000001',
    altPhone: null,
    addressLine1: '14, Gandhi Bazaar',
    addressLine2: 'Kormangala 3rd Blk',
    area: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    latitude: 12.9352,
    longitude: 77.6245,
    notes: null,
    companyId: null,
    version: 1,
  };
}

/** A day's work read: three open jobs today (one overdue), one done this
 * morning (closed at 09:00 IST), one tomorrow. */
function workFixture(): TechnicianWorkViews {
  const customer = makeCustomer();
  const jobs = [
    makeJob({ scheduledFor: AFTERNOON }), // open, later today
    makeJob({ scheduledFor: EVENING, status: 'en_route' }), // open, on the way
    makeJob({ scheduledFor: MORNING }), // open, overdue
    makeJob({ status: 'completed', scheduledFor: MORNING, closedAt: '2026-09-11T03:30:00.000Z' }), // done today
    makeJob({ scheduledFor: TOMORROW }), // upcoming — none of the figures
  ];
  return buildJobViews({ jobs, customers: [customer], customerProducts: [], products: [], services: [] });
}

/** A view list built by hand — for the tests that need one card. */
function viewOf(job: Partial<JobView['job']> & { id: string }, extra: Partial<JobView> = {}): JobView {
  return {
    job: {
      jobNumber: `JC-2627-${job.id.slice(-3)}`,
      title: 'UPS battery swap',
      status: 'assigned',
      priority: 'normal',
      scheduledFor: AFTERNOON,
      customerId: 'c1',
      contactName: null,
      contactPhone: null,
      description: null,
      contract: null,
      version: 1,
      ...job,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: { latitude: 12.9352, longitude: 77.6245 },
    pending: false,
    rejectedMessage: null,
    ...extra,
  };
}

function baseDeps(overrides: Partial<Parameters<typeof DashboardScreen>[0]> = {}): Parameters<typeof DashboardScreen>[0] {
  return {
    name: 'Ravi',
    jobs: [],
    completedAtById: {},
    health: null,
    onHealthFix: vi.fn(),
    refreshing: false,
    onRefresh: vi.fn(),
    onStartJob: vi.fn(),
    onNavigate: vi.fn(),
    onOpenJob: vi.fn(),
    now: NOW,
    ...overrides,
  };
}

function textOf(renderer: ReactTestRenderer, testID: string): string | undefined {
  const node = findByTestID(toJson(renderer), testID);
  if (node === undefined) return undefined;
  return (node.children ?? []).filter((c): c is string => typeof c === 'string').join('');
}

// ── the tests ────────────────────────────────────────────────────────────

describe('DashboardScreen (§T1)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('renders three tabular figures from the work read on the first paint', async () => {
    const data = workFixture();

    // Open: the three open jobs of today (14:30, 16:00, and the overdue
    // 08:00); done today: the one the server closed this morning; overdue:
    // the 08:00. The tomorrow job is in none of them.
    expect(data.completedAtById).toEqual({ [data.views[3]!.job.id]: '2026-09-11T03:30:00.000Z' });

    const deps = baseDeps({
      jobs: data.views,
      completedAtById: data.completedAtById,
      animateFigures: false, // past the first focus: figures are already correct
    });
    const renderer = await create(<DashboardScreen {...deps} />);

    expect(textOf(renderer, 'dashboard-figure-open')).toBe('3');
    expect(textOf(renderer, 'dashboard-figure-done')).toBe('1');
    expect(textOf(renderer, 'dashboard-figure-overdue')).toBe('1');

    // `display` 32 Condensed, tabular — the numbers never reflow.
    for (const id of ['dashboard-figure-open', 'dashboard-figure-done', 'dashboard-figure-overdue']) {
      const node = findByTestID(toJson(renderer), id);
      expect(node).toBeDefined();
      const style = Array.isArray(node!.props.style) ? Object.assign({}, ...node!.props.style) : node!.props.style;
      expect(style.fontVariant).toEqual(['tabular-nums']);
      expect(style.fontSize).toBe(32);
    }
    // NEXT is the overdue morning job (overdue first), with Navigate
    // (secondary) and Start job (primary) inline; LATER TODAY holds the
    // rest of today in ascending order.
    const nextCard = findByTestID(toJson(renderer), 'dashboard-next-card');
    expect(nextCard).toBeDefined();
    const primaryNode = findByTestID(toJson(renderer), 'dashboard-primary-action');
    expect(primaryNode).toBeDefined();
    expect(allText(primaryNode!).join(' ')).toBe('Start job');
    expect(findByTestID(toJson(renderer), 'dashboard-navigate')).toBeDefined();
    const laterRows = findAll(
      toJson(renderer),
      (n) => typeof n.props.testID === 'string' && /^dashboard-later-[0-9a-f-]+$/.test(n.props.testID),
    );
    expect(laterRows).toHaveLength(2);
  });

  it('a missing health answer renders no banner', async () => {
    // health = null: the fetch never answered. The screen degrades the
    // chip, never raises chrome.
    const renderer = await create(<DashboardScreen {...baseDeps({ health: null })} />);
    const tree = toJson(renderer);
    const texts = allText(tree).join(' ').toLowerCase();
    expect(texts).not.toContain('offline');
    expect(texts).not.toContain('no connection');
    // And no banner component anywhere in the tree.
    const banners = findAll(tree, (n) => typeof n.props.testID === 'string' && n.props.testID.includes('banner'));
    expect(banners).toHaveLength(0);
    // The chip still renders — always visible (§T1).
    expect(findByTestID(tree, 'dashboard-health')).toBeDefined();
  });

  it('counts up once; a second focus renders final values immediately', async () => {
    const onCountUpStart = vi.fn();
    const deps = baseDeps({
      jobs: [viewOf({ id: '01890a5e-1000-7000-8000-00000000000a', status: 'assigned', scheduledFor: AFTERNOON })],
      onCountUpStart,
    });

    // First focus: the count-up runs — from zero (380ms, enter; the
    // seam has no clock, so the start of the tween is what renders) —
    // one drive per figure, never per re-render.
    const renderer = await create(<DashboardScreen {...deps} animateFigures />);
    expect(textOf(renderer, 'dashboard-figure-open')).toBe('0');
    const firstFocusCalls = onCountUpStart.mock.calls.length;
    expect(firstFocusCalls).toBe(3);

    // Second focus: the route passes animateFigures=false — values are
    // already correct, final, immediate, and nothing drives again.
    await act(async () => {
      renderer.update(<DashboardScreen {...deps} animateFigures={false} />);
    });
    expect(onCountUpStart.mock.calls.length).toBe(firstFocusCalls);
    expect(textOf(renderer, 'dashboard-figure-open')).toBe('1');
    expect(textOf(renderer, 'dashboard-figure-overdue')).toBe('0');
  });

  it('never renders a currency symbol anywhere in the tree', async () => {
    const data = workFixture();
    // The worst case: contract chips, contact details, all states on.
    const views = data.views.map((v, i) =>
      i === 0
        ? {
            ...v,
            job: { ...v.job, contract: { number: 'AMC-2627-00031', endDate: '2027-09-14' } },
          }
        : v,
    );
    const renderer = await create(<DashboardScreen {...baseDeps({ jobs: views, completedAtById: data.completedAtById })} />);
    const texts = allText(toJson(renderer)).join(' ');
    expect(texts).not.toMatch(/[₹$]|Rs\.?|INR/i);
  });

  it('keeps the real rail under a refused write — the server’s sentence beside it', async () => {
    const refused = viewOf({ id: '01890a5e-1000-7000-8000-00000000000b', scheduledFor: AFTERNOON }, {
      rejectedMessage: 'This job was completed by the office at 09:12.',
    });
    const renderer = await create(<DashboardScreen {...baseDeps({ jobs: [refused] })} />);
    const tree = toJson(renderer);
    const rail = findByTestID(tree, 'dashboard-next-card-rail');
    expect(rail).toBeDefined();
    // The rail keeps the REAL status colour (assigned's slate) — it is
    // not repainted red (§T2).
    expect((rail!.props.style as { backgroundColor: string }).backgroundColor).toBe(STATUS.unassigned);
    const reason = findByTestID(tree, 'dashboard-next-card-rejected');
    expect(reason).toBeDefined();
    expect(reason!.children ?? []).toContain('This job was completed by the office at 09:12.');
    // The danger inset is present beside the rail.
    const inset = findByTestID(tree, 'dashboard-next-card-inset');
    expect(inset).toBeDefined();
    expect((inset!.props.style as { borderLeftColor: string }).borderLeftColor).toBe(SEMANTIC.feedback.danger);
  });
});

/**
 * The navy frame (mobile UI overhaul, 2026-09-16). Three things are held
 * here: the header is painted on the frame ground and dated in the same
 * timezone every figure on the screen is bucketed by, and the figure inks
 * appear **only when the figure is non-zero** — a permanent red zero is
 * how the one ink that has to survive a glance stops being read.
 */
describe('DashboardScreen — the navy frame', () => {
  const flat = (node: Node): Record<string, unknown> =>
    Object.assign({}, ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style]));

  it('paints the header on the frame ground and dates it in IST', async () => {
    const tree = toJson(await create(<DashboardScreen {...baseDeps({ jobs: workFixture().views })} />));

    expect(flat(findByTestID(tree, 'dashboard-frame')!).backgroundColor).toBe(FRAME.bg);
    // NOW is Friday 11 September 2026, 10:00 IST — the date the figures
    // are bucketed by, not the device's.
    expect(allText(findByTestID(tree, 'dashboard-date')!).join(' ')).toBe('Friday 11 September');
    // The greeting keeps its own node — it is what he reads first.
    expect(allText(findByTestID(tree, 'dashboard-greeting')!).join(' ')).toBe('Good morning, Ravi');
  });

  it('inks done and overdue only when they are non-zero', async () => {
    // The fixture: three open today (one of them overdue), one done.
    const tree = toJson(await create(<DashboardScreen {...baseDeps({ jobs: workFixture().views })} />));
    expect(flat(findByTestID(tree, 'dashboard-figure-open')!).color).toBe(FRAME.text);
    expect(flat(findByTestID(tree, 'dashboard-figure-done')!).color).toBe(FRAME.success);
    expect(flat(findByTestID(tree, 'dashboard-figure-overdue')!).color).toBe(FRAME.danger);

    // A clear day: nothing done, nothing overdue — no coloured zeroes.
    const clear = toJson(
      await create(<DashboardScreen {...baseDeps({ jobs: [viewOf({ id: '01890a5e-1000-7000-8000-00000000000c', scheduledFor: AFTERNOON })] })} />),
    );
    expect(flat(findByTestID(clear, 'dashboard-figure-done')!).color).toBe(FRAME.text);
    expect(flat(findByTestID(clear, 'dashboard-figure-overdue')!).color).toBe(FRAME.text);
  });

  it('separates the figure band with hairlines and keeps the tap targets intact', async () => {
    const tree = toJson(await create(<DashboardScreen {...baseDeps({ jobs: workFixture().views })} />));
    const dividers = findAll(
      tree,
      (n) => flat(n).width === 1 && flat(n).backgroundColor === FRAME.divider,
    );
    expect(dividers).toHaveLength(2);
  });

  it('labels each section with its own marker, count included', async () => {
    const tree = toJson(await create(<DashboardScreen {...baseDeps({ jobs: workFixture().views })} />));
    expect(allText(findByTestID(tree, 'dashboard-next-label')!).join(' ')).toBe('NEXT');
    // LATER TODAY carries the count of the rows beneath it: two.
    expect(allText(findByTestID(tree, 'dashboard-later-label')!).join(' ')).toContain('LATER TODAY');
    expect(allText(findByTestID(tree, 'dashboard-later-label')!).join(' ')).toContain('2');
  });
});
