/**
 * The dispatcher's job detail (2026-09-17). The console's first
 * job-shaped screen, and the one every other screen's tap was asking
 * for: what this job is, who has it, and what has happened to it.
 *
 * What is held here, in the order it matters:
 *
 * - **No money reaches the dispatcher.** The card's type carries no
 *   money column, and the tree is walked for a currency symbol and for
 *   the words — a redaction regression fails loudly.
 * - **The assignee reads as a name**, resolved from the roster, or
 *   "Unassigned" when nobody holds it.
 * - **The trail is the dispatcher's shape**: event, actor, stamp; a
 *   text entry (no status move) keeps the neutral dot.
 */
import { describe, expect, it, vi } from 'vitest';

import type { JobCardDispatcher, JobTimelineEvent } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { DispatcherJobDetailScreen, type DispatcherJobDetailDeps } from './jobDetail';
import {
  assigneeNameOf,
  eventLabelOf,
  priorityLabelOf,
  slotLabelOf,
  statusToneOf,
} from './jobDetailModel';

const NOW = new Date('2026-09-17T10:00:00+05:30'); // Thursday, 10:00 IST
const TECH_ID = '01890a5e-3000-7000-8000-000000000001';

function cardOf(overrides: Partial<JobCardDispatcher> = {}): JobCardDispatcher {
  return {
    id: '01890a5e-1000-7000-8000-000000000001',
    jobNumber: 'JC-2627-00037',
    title: 'Preventive service',
    status: 'assigned',
    priority: 'normal',
    scheduledFor: '2026-09-17T16:30:00+05:30',
    customerId: '01890a5e-2000-7000-8000-000000000001',
    customerName: 'Lotus Paying Guest',
    assignedTo: TECH_ID,
    isOverdue: false,
    isContractVisit: false,
    version: 3,
    ...overrides,
  };
}

function eventOf(overrides: Partial<JobTimelineEvent> = {}): JobTimelineEvent {
  return {
    id: 1,
    eventType: 'assigned',
    actorId: '01890a5e-9000-7000-8000-000000000001',
    actorName: 'Dispatcher Test',
    occurredAt: '2026-09-17T09:12:00+05:30',
    fromStatus: null,
    toStatus: 'assigned',
    source: 'web',
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DispatcherJobDetailDeps> = {}): DispatcherJobDetailDeps {
  return {
    card: cardOf(),
    contact: { name: 'Lotus Paying Guest', phone: '9840000001', addressLabel: '14, Gandhi Bazaar, Bengaluru' },
    roster: [{ employeeId: TECH_ID, name: 'Tech One' }],
    events: [eventOf()],
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    onCall: vi.fn(),
    onNavigate: vi.fn(),
    now: NOW,
    ...overrides,
  };
}

describe('DispatcherJobDetailScreen — the console’s view of one job', () => {
  it('renders the job, its assignee and its trail', async () => {
    const tree = toJson(await create(<DispatcherJobDetailScreen {...baseDeps()} />));
    expect(allText(findByTestID(tree, 'dispatch-job-customer')!).join(' ')).toBe('Lotus Paying Guest');
    expect(allText(findByTestID(tree, 'dispatch-job-number')!).join(' ')).toBe('JC-2627-00037');
    expect(allText(findByTestID(tree, 'dispatch-job-status')!).join(' ')).toContain('Assigned');
    expect(allText(findByTestID(tree, 'dispatch-job-slot')!).join(' ')).toBe('today · 16:30');
    expect(allText(findByTestID(tree, 'dispatch-job-assignee')!).join(' ')).toBe('Tech One');
    expect(allText(findByTestID(tree, 'dispatch-job-contact')!).join(' ')).toBe('Lotus Paying Guest');
    expect(findAll(tree, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('dispatch-job-event-'))).toHaveLength(1);
  });

  it('renders no money anywhere in the tree — the card’s shape forbids it', async () => {
    const tree = toJson(
      await create(
        <DispatcherJobDetailScreen
          {...baseDeps({
            // The worst case the shape allows: every chip on, a contract visit.
            card: cardOf({ isOverdue: true, isContractVisit: true, priority: 'urgent' }),
          })}
        />,
      ),
    );
    const words = allText(tree).join(' ');
    expect(words).not.toMatch(/[₹$]|Rs\.?|INR/i);
    expect(words.toLowerCase()).not.toContain('cost');
    expect(words.toLowerCase()).not.toContain('collected');
    expect(words.toLowerCase()).not.toContain('amount');
  });

  it('says Unassigned when nobody holds the job', async () => {
    const tree = toJson(await create(<DispatcherJobDetailScreen {...baseDeps({ card: cardOf({ assignedTo: null }) })} />));
    expect(allText(findByTestID(tree, 'dispatch-job-assignee')!).join(' ')).toBe('Unassigned');
  });

  it('shows the chips the job has earned and no others', async () => {
    const plain = toJson(await create(<DispatcherJobDetailScreen {...baseDeps()} />));
    expect(findByTestID(plain, 'dispatch-job-overdue')).toBeUndefined();
    expect(findByTestID(plain, 'dispatch-job-priority')).toBeUndefined();
    expect(findByTestID(plain, 'dispatch-job-amc')).toBeUndefined();

    const loud = toJson(
      await create(
        <DispatcherJobDetailScreen {...baseDeps({ card: cardOf({ isOverdue: true, isContractVisit: true, priority: 'urgent' }) })} />,
      ),
    );
    expect(allText(findByTestID(loud, 'dispatch-job-overdue')!).join(' ')).toBe('Overdue');
    expect(allText(findByTestID(loud, 'dispatch-job-priority')!).join(' ')).toBe('Urgent');
    expect(allText(findByTestID(loud, 'dispatch-job-amc')!).join(' ')).toBe('AMC');
  });

  it('offers Call only when there is a number, with the reason when there is not', async () => {
    const withNumber = toJson(await create(<DispatcherJobDetailScreen {...baseDeps()} />));
    const call = findAll(findByTestID(withNumber, 'dispatch-job-call')!, (n) => n.props.accessibilityRole === 'button')[0]!;
    expect((call.props.accessibilityState as { disabled: boolean }).disabled).toBe(false);

    const noNumber = toJson(
      await create(<DispatcherJobDetailScreen {...baseDeps({ contact: { name: 'Lotus Paying Guest', phone: '', addressLabel: null } })} />),
    );
    const blocked = findAll(findByTestID(noNumber, 'dispatch-job-call')!, (n) => n.props.accessibilityRole === 'button')[0]!;
    expect((blocked.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
    expect(allText(findByTestID(noNumber, 'dispatch-job-call')!).join(' ')).toContain('No number on this site.');
  });

  it('an empty trail says so; a failed read offers Retry', async () => {
    const empty = toJson(await create(<DispatcherJobDetailScreen {...baseDeps({ events: [] })} />));
    expect(allText(findByTestID(empty, 'dispatch-job-timeline-empty')!).join(' ')).toContain('Nothing on the trail yet.');

    const failed = toJson(await create(<DispatcherJobDetailScreen {...baseDeps({ card: null, error: 'The job could not be read.' })} />));
    expect(allText(findByTestID(failed, 'dispatch-job-error')!).join(' ')).toContain('The job could not be read.');
    expect(findByTestID(failed, 'dispatch-job-loading')).toBeUndefined();
  });
});

describe('the job detail’s pure decisions', () => {
  it('names every status the way the console says it', () => {
    expect(statusToneOf('assigned').label).toBe('Assigned');
    expect(statusToneOf('unassigned').label).toBe('Assigned'); // the same slate: both are "waiting"
    expect(statusToneOf('en_route').label).toBe('En route');
    expect(statusToneOf('in_progress').label).toBe('In progress');
    expect(statusToneOf('completed').label).toBe('Completed');
    expect(statusToneOf('cancelled').label).toBe('Cancelled');
  });

  it('says nothing about a normal priority — a chip for the resting state is noise', () => {
    expect(priorityLabelOf('normal')).toBeNull();
    expect(priorityLabelOf('urgent')).toBe('Urgent');
    expect(priorityLabelOf('high')).toBe('High');
    expect(priorityLabelOf('low')).toBe('Low');
  });

  it('reads the slot in IST, and as a past promise when it is overdue', () => {
    expect(slotLabelOf(cardOf(), NOW)).toBe('today · 16:30');
    expect(slotLabelOf(cardOf({ isOverdue: true, scheduledFor: '2026-09-12T16:30:00+05:30' }), NOW)).toBe('was due 2026-09-12 · 16:30');
    expect(slotLabelOf(cardOf({ scheduledFor: null }), NOW)).toBe('No date set');
  });

  it('reads a status move as the move it made', () => {
    expect(eventLabelOf(eventOf({ eventType: 'status_changed', fromStatus: 'assigned', toStatus: 'en_route' }))).toBe(
      'Assigned → En route',
    );
    expect(eventLabelOf(eventOf({ eventType: 'created', toStatus: null }))).toBe('Raised');
    expect(eventLabelOf(eventOf({ eventType: 'reassigned' }))).toBe('Reassigned');
    expect(eventLabelOf(eventOf({ eventType: 'some_future_type', toStatus: null }))).toBe('Updated');
  });

  it('resolves the assignee from the roster, and never invents one', () => {
    expect(assigneeNameOf(TECH_ID, [{ employeeId: TECH_ID, name: 'Tech One' }])).toBe('Tech One');
    expect(assigneeNameOf(null, [])).toBeNull();
    expect(assigneeNameOf('01890a5e-3000-7000-8000-000000000099', [])).toBeNull();
  });
});
