/**
 * T2 Jobs tests (UI/plan-2/04-TECHNICIAN.md §T2) — the three the spec
 * names:
 *
 * - **Search absent at 12 jobs, present at 13** — a technician with six
 *   does not need search, and the threshold is per active tab.
 * - **Overdue sorts first within Today** — then `scheduled_for`
 *   ascending.
 * - **A rejected job keeps its status rail colour and gains the danger
 *   inset** — the rail is NOT repainted red; the server's reason shows
 *   verbatim.
 *
 * The list runs under the FlashList seam: real row components, real
 * sort and filter logic, host-typed surface.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { SEMANTIC, STATUS } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { JobsScreen } from './JobsScreen';
import type { JobView } from './jobView';

const NOW = new Date('2026-09-11T10:00:00+05:30'); // Friday, 10:00 IST

const OVERDUE_EARLY = '2026-09-11T08:00:00+05:30';
const OVERDUE_LATE = '2026-09-11T09:15:00+05:30';
const LATER = '2026-09-11T14:30:00+05:30';
const EVENING = '2026-09-11T16:00:00+05:30';

let seq = 0;

function viewOf(overrides: Partial<JobView['job']> & { scheduledFor: string }, extra: Partial<JobView> = {}): JobView {
  seq += 1;
  const id = overrides.id ?? `01890a5e-1000-7000-8000-${String(seq).padStart(12, '0')}`;
  return {
    job: {
      id,
      jobNumber: `JC-2627-${String(seq).padStart(5, '0')}`,
      title: 'UPS battery swap',
      status: 'assigned',
      priority: 'normal',
      customerId: 'c1',
      contactName: null,
      contactPhone: null,
      description: null,
      contract: null,
      version: 1,
      ...overrides,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: null,
    pending: false,
    rejectedMessage: null,
    ...extra,
  };
}

function baseDeps(overrides: Partial<Parameters<typeof JobsScreen>[0]> = {}): Parameters<typeof JobsScreen>[0] {
  return {
    jobs: [],
    completedAtById: {},
    now: NOW,
    onOpenJob: vi.fn(),
    ...overrides,
  };
}

/** The rendered card testIDs, in list order — card roots only, never
 * their `-rail`/`-time`/`-status` descendants. */
const CARD_ROOT = /^jobs-card-[0-9a-f-]+$/;

function cardOrder(renderer: ReactTestRenderer): string[] {
  const tree = toJson(renderer);
  return findAll(tree, (n) => typeof n.props.testID === 'string' && CARD_ROOT.test(n.props.testID)).map(
    (n) => n.props.testID as string,
  );
}

async function pressTab(renderer: ReactTestRenderer, tab: 'today' | 'upcoming' | 'completed'): Promise<void> {
  await act(async () => {
    findByTestID(toJson(renderer), `jobs-tab-${tab}`)!.props.onPress?.();
    await Promise.resolve();
  });
}

describe('JobsScreen (§T2)', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('shows search from 13 jobs, not at 12', async () => {
    const twelve = Array.from({ length: 12 }, () => viewOf({ scheduledFor: LATER }));
    const renderer = await create(<JobsScreen {...baseDeps({ jobs: twelve })} />);
    expect(findByTestID(toJson(renderer), 'jobs-search')).toBeUndefined();

    const thirteen = [...twelve, viewOf({ scheduledFor: EVENING })];
    await act(async () => {
      renderer.update(<JobsScreen {...baseDeps({ jobs: thirteen })} />);
    });
    expect(findByTestID(toJson(renderer), 'jobs-search')).toBeDefined();

    // The threshold is judged on the ACTIVE tab only — on Completed,
    // where the same thirteen jobs do not sit, the field is gone again.
    await pressTab(renderer, 'completed');
    expect(findByTestID(toJson(renderer), 'jobs-search')).toBeUndefined();
  });

  it('sorts Today overdue first, then by scheduled_for ascending', async () => {
    const jobs = [
      viewOf({ id: '01890a5e-1000-7000-8000-000000000003', scheduledFor: LATER, jobNumber: 'JC-2627-00030' }),
      viewOf({ id: '01890a5e-1000-7000-8000-000000000002', scheduledFor: OVERDUE_LATE, jobNumber: 'JC-2627-00010' }),
      viewOf({ id: '01890a5e-1000-7000-8000-000000000004', scheduledFor: EVENING, jobNumber: 'JC-2627-00040' }),
      viewOf({ id: '01890a5e-1000-7000-8000-000000000001', scheduledFor: OVERDUE_EARLY, jobNumber: 'JC-2627-00020' }),
    ];
    const renderer = await create(<JobsScreen {...baseDeps({ jobs })} />);
    // 08:00 and 09:15 are past 10:00 — the overdue pair leads, in time
    // order; the afternoon pair follows, in time order.
    expect(cardOrder(renderer)).toEqual([
      'jobs-card-01890a5e-1000-7000-8000-000000000001',
      'jobs-card-01890a5e-1000-7000-8000-000000000002',
      'jobs-card-01890a5e-1000-7000-8000-000000000003',
      'jobs-card-01890a5e-1000-7000-8000-000000000004',
    ]);
  });

  it('a rejected job keeps its status rail colour and gains the danger inset', async () => {
    // The practical rejection: he cancelled, the server refused — the
    // job is still open, its rail still `assigned` slate. A repainted
    // red rail would read as an office cancellation (§T2).
    const jobs = [
      viewOf(
        { scheduledFor: LATER, status: 'assigned', jobNumber: 'JC-2627-00007' },
        { rejectedMessage: 'Cancellation refused: the crew is already on site.' },
      ),
      viewOf({ scheduledFor: LATER, status: 'assigned', jobNumber: 'JC-2627-00008' }),
    ];
    const renderer = await create(<JobsScreen {...baseDeps({ jobs })} />);
    const tree = toJson(renderer);

    const rail = findByTestID(tree, 'jobs-card-01890a5e-1000-7000-8000-000000000001-rail');
    expect(rail).toBeDefined();
    expect((rail!.props.style as { backgroundColor: string }).backgroundColor).toBe(STATUS.unassigned);
    // And the rail is NOT the danger red, though the card is rejected.
    expect((rail!.props.style as { backgroundColor: string }).backgroundColor).not.toBe(STATUS.cancelled);

    const inset = findByTestID(tree, 'jobs-card-01890a5e-1000-7000-8000-000000000001-inset');
    expect(inset).toBeDefined();
    expect((inset!.props.style as { borderLeftColor: string }).borderLeftColor).toBe(SEMANTIC.feedback.danger);

    // The server's one-line reason, verbatim.
    const reason = findByTestID(tree, 'jobs-card-01890a5e-1000-7000-8000-000000000001-rejected');
    expect(reason).toBeDefined();
    expect(reason!.children ?? []).toContain('Cancellation refused: the crew is already on site.');

    // And the untouched neighbour has neither inset nor reason.
    expect(findByTestID(tree, 'jobs-card-01890a5e-1000-7000-8000-000000000002-inset')).toBeUndefined();
  });

  it('empty Today offers Check upcoming; Completed carries its own copy', async () => {
    const renderer = await create(<JobsScreen {...baseDeps({ jobs: [] })} />);
    const empty = findByTestID(toJson(renderer), 'jobs-empty-today');
    expect(empty).toBeDefined();
    expect(allText(empty!).join(' ')).toContain('Nothing scheduled today.');

    await pressTab(renderer, 'completed');
    expect(allText(findByTestID(toJson(renderer), 'jobs-empty-completed')!).join(' ')).toContain(
      'Nothing completed yet today.',
    );
  });
});
