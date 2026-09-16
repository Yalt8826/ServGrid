/**
 * `ActiveJobPanel` (mobile UI overhaul, 2026-09-16). The job he is on is
 * the dashboard's one actionable object, so this file holds the three
 * things that make it trustworthy rather than the layout:
 *
 * - it shows what he needs *before* the visit — who, where, what, when,
 *   who to ask for — and dials the number it shows;
 * - *Call* disables itself with a reason on a job with no number, which
 *   is the house rule for every disabled control;
 * - the rail/inset treatment is `JobCard`'s, unchanged and for the same
 *   reason (a refused write never repaints the real status rail).
 */
import { describe, expect, it, vi } from 'vitest';

import { SEMANTIC, STATUS } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson, type Node } from '../ui/testing';
import { ActiveJobPanel } from './ActiveJobPanel';
import type { JobView } from '../../screens/technician/jobView';

function viewOf(extra: Partial<JobView> = {}, job: Partial<JobView['job']> = {}): JobView {
  return {
    job: {
      id: '01890a5e-1000-7000-8000-00000000000a',
      jobNumber: 'JC-2627-00033',
      title: 'Breakdown — no output',
      status: 'in_progress',
      priority: 'normal',
      scheduledFor: '2026-09-16T15:30:00+05:30',
      customerId: 'c1',
      contactName: 'Jayan',
      contactPhone: '+919812345678',
      description: 'New unit to be commissioned at reception.',
      contract: null,
      version: 3,
      ...job,
    },
    customerName: 'HSR Food Court',
    area: 'Indiranagar',
    coordinates: { latitude: 12.97, longitude: 77.64 },
    pending: false,
    rejectedMessage: null,
    ...extra,
  };
}

function panel(overrides: Partial<Parameters<typeof ActiveJobPanel>[0]> = {}): Parameters<typeof ActiveJobPanel>[0] {
  return {
    view: viewOf(),
    onPress: vi.fn(),
    onCall: vi.fn(),
    onNavigate: vi.fn(),
    primary: { label: 'Complete job', onPress: vi.fn() },
    testID: 'active',
    ...overrides,
  };
}

const flat = (node: Node): Record<string, unknown> =>
  Object.assign({}, ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style]));

describe('ActiveJobPanel — the job he is on', () => {
  it('carries the details he needs before the visit', async () => {
    const tree = toJson(await create(<ActiveJobPanel {...panel()} />));
    const words = allText(tree).join(' ');
    expect(words).toContain('ACTIVE JOB');
    expect(words).toContain('HSR Food Court · Indiranagar');
    expect(words).toContain('Breakdown — no output');
    expect(words).toContain('JC-2627-00033');
    expect(words).toContain('15:30');
    expect(words).toContain('Jayan');
    expect(words).toContain('New unit to be commissioned at reception.');
    expect(findByTestID(tree, 'active-status')).toBeDefined();
  });

  it('says the day only when the job is not today', async () => {
    const today = toJson(await create(<ActiveJobPanel {...panel()} />));
    expect(allText(today).join(' ')).not.toContain('Tomorrow');

    const carried = toJson(await create(<ActiveJobPanel {...panel({ view: viewOf(), dayLabel: 'Tomorrow' })} />));
    expect(allText(carried).join(' ')).toContain('Tomorrow');
  });

  it('wires Call, Navigate and the one primary', async () => {
    const onCall = vi.fn();
    const onNavigate = vi.fn();
    const onPrimary = vi.fn();
    const renderer = await create(
      <ActiveJobPanel {...panel({ onCall, onNavigate, primary: { label: 'Complete job', onPress: onPrimary } })} />,
    );
    const tree = toJson(renderer);
    const press = async (id: string) => {
      const node = findAll(findByTestID(tree, id)!, (n) => n.props.accessibilityRole === 'button')[0]!;
      await Promise.resolve((node.props.onPress as () => void)());
    };
    await press('active-call');
    await press('active-navigate');
    await press('active-primary');
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(allText(findByTestID(tree, 'active-primary')!).join(' ')).toBe('Complete job');
  });

  it('disables Call with a reason when the job has no number', async () => {
    const tree = toJson(await create(<ActiveJobPanel {...panel({ view: viewOf({}, { contactPhone: null }) })} />));
    const call = findByTestID(tree, 'active-call')!;
    const pressable = findAll(call, (n) => n.props.accessibilityRole === 'button')[0]!;
    expect((pressable.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
    expect(allText(call).join(' ')).toContain('No number on this job.');
  });

  it('keeps the real rail under a refused write, with the server’s sentence beside it', async () => {
    const refused = viewOf({ rejectedMessage: 'This job was completed by the office at 09:12.' });
    const tree = toJson(await create(<ActiveJobPanel {...panel({ view: refused })} />));
    // `in_progress` is the accent — the rail is NOT repainted red.
    expect(flat(findByTestID(tree, 'active-rail')!).backgroundColor).toBe(STATUS.in_progress);
    expect(flat(findByTestID(tree, 'active-rail')!).backgroundColor).not.toBe(STATUS.cancelled);
    const inset = findByTestID(tree, 'active-inset')!;
    expect(flat(inset).borderLeftColor).toBe(SEMANTIC.feedback.danger);
    expect(allText(findByTestID(tree, 'active-rejected')!).join(' ')).toBe(
      'This job was completed by the office at 09:12.',
    );
  });

  it('offers no primary when the caller has none to offer', async () => {
    const tree = toJson(await create(<ActiveJobPanel {...panel({ primary: null })} />));
    expect(findByTestID(tree, 'active-primary')).toBeUndefined();
    // The two ways to reach the customer are still there.
    expect(findByTestID(tree, 'active-call')).toBeDefined();
    expect(findByTestID(tree, 'active-navigate')).toBeDefined();
  });
});
