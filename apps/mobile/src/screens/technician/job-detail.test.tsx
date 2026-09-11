/**
 * T3 Job detail tests (UI/plan-2/04-TECHNICIAN.md §T3, T1.18) — the four
 * the spec names:
 *
 * - **Stepper renders four nodes with `en_route` dimmed when skipped** —
 *   dimmed-but-present, never removed (03-COMPONENTS.md).
 * - **A cancelled job freezes at its reached node and renders the
 *   terminal cap with no fill animation** — cancelled is a fifth
 *   rendering, not a fifth node; `onAnimateStart` is the seam that
 *   proves nothing drove.
 * - **Post-completion, the tree contains no `cost`, `amount` or `₹`** —
 *   no money figure, ever, after completion (§T3).
 * - **Rejected state pins a banner under the header carrying the
 *   server's `message` verbatim**, with *Discard my copy* and *View the
 *   office version* (§T3 / PLAN-FRONTEND.md §5).
 *
 * Plus the §T3 anatomy the tests can see: the docket header (number in
 * mono, top right), the hero advance beat (once, colours move, haptics
 * fire), the closed thumb bar's single line, and the rail-with-its-word
 * rule on the header (01-FOUNDATIONS.md §1.6).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';
// The stub module DIRECTLY: same instance the vitest alias feeds
// `haptics.ts` under test, and the one with the `__fired` surface.
import * as Haptics from '../../test-stubs/expo-haptics';

import { SEMANTIC, STATUS } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson, type Node } from '../../components/ui/testing';
import { JobDetailScreen, type JobDetailDeps } from './JobDetailScreen';
import { statusPillOf, type JobView } from './jobView';
import type { JobStatus } from '@servgrid/shared';
import type { JobTimelineEntry } from './jobDetail';

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST
const SCHEDULED = '2026-09-11T14:30:00+05:30';

const NODE_KEYS = ['assigned', 'en_route', 'in_progress', 'completed'] as const;

let seq = 0;

function viewOf(overrides: Partial<JobView['job']> = {}, extra: Partial<JobView> = {}): JobView {
  seq += 1;
  return {
    job: {
      id: `01890a5e-7800-7000-8000-${String(seq).padStart(12, '0')}`,
      jobNumber: 'JC-2627-00042',
      title: 'Battery swap',
      status: 'assigned',
      priority: 'normal',
      scheduledFor: SCHEDULED,
      customerId: 'c1',
      contactName: 'Mr Prakash',
      contactPhone: '+919812345678',
      description: 'Inverter beeping since Monday; customer reports no charge.',
      contract: null,
      version: 3,
      ...overrides,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: { latitude: 12.9345, longitude: 77.6156 },
    pending: false,
    rejectedMessage: null,
    unit: {
      name: 'UPS 850VA',
      brand: 'Luminous',
      serialNumber: 'LM8842219',
      warrantyExpiresOn: '2027-03-14',
    },
    ...extra,
  };
}

let eventSeq = 0;

function entryOf(to: JobStatus, at: string): JobTimelineEntry {
  eventSeq += 1;
  return { id: `ev-${String(eventSeq).padStart(4, '0')}`, label: statusPillOf(to).label, at, to };
}

function baseDeps(overrides: Partial<JobDetailDeps> = {}): JobDetailDeps {
  return {
    view: viewOf(),
    events: [],
    completedAt: null,
    onBack: vi.fn(),
    onCall: vi.fn(),
    onNavigate: vi.fn(),
    onStartJob: vi.fn(),
    onComplete: vi.fn(),
    onCancel: vi.fn(),
    onDiscardMyCopy: vi.fn(),
    onViewOfficeVersion: vi.fn(),
    now: NOW,
    ...overrides,
  };
}

/** Merged style of a node — the tree's style props arrive as arrays. */
function styleOf(node: Node | undefined): Record<string, unknown> {
  const raw = node?.props.style;
  const parts = (Array.isArray(raw) ? raw : [raw]).filter(
    (part): part is Record<string, unknown> => part !== null && typeof part === 'object',
  );
  return Object.assign({}, ...parts);
}

function nodeOf(tree: Node | string | null, key: (typeof NODE_KEYS)[number]): Node | undefined {
  return findByTestID(tree, `detail-stepper-node-${key}`);
}

function dotOf(tree: Node | string | null, key: (typeof NODE_KEYS)[number]): Node | undefined {
  return findByTestID(tree, `detail-stepper-node-${key}-dot`);
}

describe('JobDetailScreen (§T3)', () => {
  beforeEach(() => {
    seq = 0;
    eventSeq = 0;
    Haptics.__reset();
  });

  it('renders four nodes, with en_route dimmed-but-present when it was skipped', async () => {
    // Went straight to work: assigned → in_progress, no en_route ever
    // recorded. The node keeps its shape and its word, at 0.4 — a
    // stepper that silently changed shape would hide the skip.
    const view = viewOf({ status: 'in_progress' });
    const renderer = await create(
      <JobDetailScreen {...baseDeps({ view, events: [entryOf('in_progress', '2026-09-11T09:40:00+05:30')] })} />,
    );
    const tree = toJson(renderer);

    for (const key of NODE_KEYS) {
      expect(nodeOf(tree, key)).toBeDefined();
    }

    expect(styleOf(nodeOf(tree, 'en_route')).opacity).toBe(0.4);
    expect(styleOf(nodeOf(tree, 'assigned')).opacity).toBe(1);
    expect(styleOf(nodeOf(tree, 'in_progress')).opacity).toBe(1);
    expect(styleOf(nodeOf(tree, 'completed')).opacity).toBe(1);

    // The skipped step never filled; the reached ones did.
    expect(styleOf(dotOf(tree, 'en_route')).backgroundColor).toBe(SEMANTIC.line.default);
    expect(styleOf(dotOf(tree, 'in_progress')).backgroundColor).toBe(STATUS.in_progress);

    // A job that DID pass through en_route is not dimmed.
    const routed = viewOf({ status: 'in_progress' });
    const routedTree = toJson(
      await create(
        <JobDetailScreen
          {...baseDeps({
            view: routed,
            events: [entryOf('en_route', '2026-09-11T09:10:00+05:30'), entryOf('in_progress', '2026-09-11T09:40:00+05:30')],
          })}
        />,
      ),
    );
    expect(styleOf(nodeOf(routedTree, 'en_route')).opacity).toBe(1);
    expect(styleOf(dotOf(routedTree, 'en_route')).backgroundColor).toBe(STATUS.en_route);
  });

  it('runs the hero advance once per advance — fill, haptics, and the rail cross-fade', async () => {
    const onAnimateStart = vi.fn();
    const view = viewOf({ status: 'assigned' });
    const deps = baseDeps({ view, onAnimateStart });
    const renderer = await create(<JobDetailScreen {...deps} />);
    expect(onAnimateStart).not.toHaveBeenCalled(); // mount: no motion

    await act(async () => {
      renderer.update(
        <JobDetailScreen
          {...baseDeps({
            view: viewOf({ status: 'en_route' }),
            events: [entryOf('en_route', '2026-09-11T10:05:00+05:30')],
            onAnimateStart,
          })}
        />,
      );
    });

    expect(onAnimateStart).toHaveBeenCalledTimes(1);
    const tree = toJson(renderer);
    expect(styleOf(dotOf(tree, 'en_route')).backgroundColor).toBe(STATUS.en_route);
    // The docket rail cross-faded to the new status colour (§5.1).
    expect(styleOf(findByTestID(tree, 'detail-rail')).backgroundColor).toBe(STATUS.en_route);
    // Light on advance (02-MOTION.md §8).
    expect(Haptics.__fired()).toContain('impact:impactLight');
  });

  it('a cancelled job freezes at the node it reached and renders the terminal cap with no fill animation', async () => {
    const onAnimateStart = vi.fn();
    // He was on site — in progress — when the office killed the job.
    // THAT is the information: not "cancelled before setting off".
    const view = viewOf({ status: 'assigned' });
    const renderer = await create(<JobDetailScreen {...baseDeps({ view, onAnimateStart })} />);

    await act(async () => {
      renderer.update(
        <JobDetailScreen
          {...baseDeps({
            view: viewOf({ status: 'cancelled' }),
            events: [entryOf('in_progress', '2026-09-11T09:40:00+05:30')],
            onAnimateStart,
          })}
        />,
      );
    });

    const tree = toJson(renderer);

    // Frozen at In progress: reached and current, the later nodes slate.
    expect(styleOf(dotOf(tree, 'in_progress')).backgroundColor).toBe(STATUS.in_progress);
    expect(styleOf(dotOf(tree, 'completed')).backgroundColor).toBe(SEMANTIC.line.default);
    expect(styleOf(nodeOf(tree, 'en_route')).opacity).toBe(1); // not a skip — a freeze

    // The terminal cap carries the word.
    const cap = findByTestID(tree, 'detail-stepper-cap');
    expect(cap).toBeDefined();
    expect(allText(cap ?? null).join(' ')).toContain('Cancelled');

    // No animation — nothing was achieved, so nothing fills. The status
    // CHANGED under this mounted instance and the beat never drove.
    expect(onAnimateStart).not.toHaveBeenCalled();
    expect(Haptics.__fired()).toEqual([]);
  });

  it('a cancelled job with no local history freezes before setting off', async () => {
    const renderer = await create(
      <JobDetailScreen {...baseDeps({ view: viewOf({ status: 'cancelled' }) })} />,
    );
    const tree = toJson(renderer);
    expect(styleOf(dotOf(tree, 'assigned')).backgroundColor).toBe(STATUS.unassigned);
    expect(styleOf(dotOf(tree, 'en_route')).backgroundColor).toBe(SEMANTIC.line.default);
    expect(findByTestID(tree, 'detail-stepper-cap')).toBeDefined();
  });

  it('post-completion, the tree contains no cost, amount or rupee sign', async () => {
    const renderer = await create(
      <JobDetailScreen
        {...baseDeps({
          view: viewOf({ status: 'completed' }),
          events: [entryOf('completed', '2026-09-11T16:42:00+05:30')],
          completedAt: '2026-09-11T16:42:00+05:30',
        })}
      />,
    );
    const raw = JSON.stringify(toJson(renderer));
    expect(/cost|amount|₹/i.test(raw)).toBe(false);
  });

  it('the closed thumb bar collapses to a single Completed line', async () => {
    const renderer = await create(
      <JobDetailScreen
        {...baseDeps({
          view: viewOf({ status: 'completed' }),
          completedAt: '2026-09-11T16:42:00+05:30',
        })}
      />,
    );
    const tree = toJson(renderer);
    const bar = findByTestID(tree, 'detail-thumb-bar');
    expect(allText(bar ?? null).join(' ')).toContain('Completed 16:42');
    expect(findByTestID(tree, 'detail-primary')).toBeUndefined();
    expect(findByTestID(tree, 'detail-cancel')).toBeUndefined();
  });

  it('a rejected job pins the server message verbatim under the header, with the two actions', async () => {
    const MESSAGE = 'Completion refused: this job was already closed by the office at 14:32.';
    const onDiscardMyCopy = vi.fn();
    const renderer = await create(
      <JobDetailScreen
        {...baseDeps({
          view: viewOf({ status: 'in_progress' }, { rejectedMessage: MESSAGE }),
          onDiscardMyCopy,
        })}
      />,
    );
    const tree = toJson(renderer);

    // Pinned UNDER the header — render order is the anatomy's order.
    const order = findAll(tree, (n) => n.props.testID === 'detail-header' || n.props.testID === 'detail-rejected');
    expect(order.map((n) => n.props.testID)).toEqual(['detail-header', 'detail-rejected']);

    const banner = findByTestID(tree, 'detail-rejected');
    const text = allText(banner ?? null).join(' ');
    expect(text).toContain(MESSAGE); // verbatim

    // The two actions, wired.
    const actions = findAll(banner ?? null, (n) => typeof n.props.onPress === 'function');
    expect(actions.length).toBe(2);
    expect(text).toContain('Discard my copy');
    expect(text).toContain('View the office version');
    await act(async () => {
      actions[0]!.props.onPress?.();
    });
    expect(onDiscardMyCopy).toHaveBeenCalledTimes(1);

    // The header keeps its real status rail — the inset is the danger
    // layer, the rail is not repainted (§T2/§T3).
    expect(styleOf(findByTestID(tree, 'detail-inset')).borderLeftColor).toBe(SEMANTIC.feedback.danger);
    expect(styleOf(findByTestID(tree, 'detail-rail')).backgroundColor).toBe(STATUS.in_progress);
  });

  it('keeps the docket tells: number in mono at the top right, back leading, status word beside the rail', async () => {
    const renderer = await create(<JobDetailScreen {...baseDeps()} />);
    const tree = toJson(renderer);

    const header = findByTestID(tree, 'detail-header');
    const ids = findAll(header ?? null, (n) => typeof n.props.testID === 'string').map((n) => n.props.testID);
    expect(ids.indexOf('detail-back')).toBeLessThan(ids.indexOf('detail-number'));
    expect(ids.indexOf('detail-back')).toBeLessThan(ids.indexOf('detail-status'));

    expect(allText(findByTestID(tree, 'detail-number') ?? null).join(' ')).toBe('JC-2627-00042');
    expect(allText(findByTestID(tree, 'detail-status') ?? null).join(' ')).toContain('Assigned');
  });

  it('renders THE UNIT with its serial and the warranty chip carrying the expiry', async () => {
    const renderer = await create(<JobDetailScreen {...baseDeps()} />);
    const tree = toJson(renderer);

    expect(allText(findByTestID(tree, 'detail-unit') ?? null).join(' ')).toContain('SN LM8842219');
    const warranty = allText(findByTestID(tree, 'detail-warranty') ?? null).join(' ');
    expect(warranty).toBe('In warranty · to 14 Mar 2027');
  });

  it('names prepaid on an upfront contract visit', async () => {
    const renderer = await create(
      <JobDetailScreen
        {...baseDeps({
          view: viewOf({
            contract: { number: 'AMC-2627-0031', billing: 'upfront', visitsRemaining: 3 },
          }),
        })}
      />,
    );
    const tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'detail-contract') ?? null).join(' ')).toBe('AMC-2627-0031 · 3 visits left · prepaid');
  });
});
