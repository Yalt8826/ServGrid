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

import { act } from 'react';
import type { JobCardDispatcher, JobTimelineEvent } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson, type Node, type ReactTestRenderer } from '../../components/ui/testing';
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
    candidates: [{ employeeId: TECH_ID, name: 'Tech One', openTotal: 3 }],
    actionBusy: false,
    actionError: null,
    onReassign: vi.fn(),
    onReschedule: vi.fn(),
    onCancelJob: vi.fn(),
    events: [eventOf()],
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    onCall: vi.fn(),
    onNavigate: vi.fn(),
    now: NOW,
    todayIso: '2026-09-17',
    ...overrides,
  };
}

async function press(tree: Node | string | null, testID: string): Promise<void> {
  const node = findByTestID(tree, testID);
  if (node === undefined) throw new Error(`Nothing rendered for ${testID}`);
  const hit = findAll(node, (candidate) => typeof candidate.props.onPress === 'function')[0];
  if (hit === undefined) throw new Error(`No pressable under ${testID}`);
  await act(async () => {
    hit.props.onPress?.();
  });
}

async function typeInto(tree: Node | string | null, testID: string, text: string): Promise<void> {
  const field = findByTestID(tree, testID);
  const input = findAll(field ?? null, (candidate) => typeof candidate.props.onChangeText === 'function')[0];
  if (input === undefined) throw new Error(`No input under ${testID}`);
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

void (null as unknown as ReactTestRenderer);

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

/**
 * The three doors (2026-09-17, Yashas: "a reassign icon … and also a
 * reschedule button, cancel button at the end"). Each is a sheet with one
 * question; what is held here is that each asks its question, refuses to
 * send an incomplete answer, and hands the answer to its own dep — never
 * to a neighbour's.
 */
describe('DispatcherJobDetailScreen — reassign, reschedule, cancel', () => {
  it('reassign picks a technician and never offers the one already on it', async () => {
    const onReassign = vi.fn();
    const OTHER = '01890a5e-3000-7000-8000-000000000002';
    const renderer = await create(
      <DispatcherJobDetailScreen
        {...baseDeps({
          onReassign,
          candidates: [
            { employeeId: TECH_ID, name: 'Tech One', openTotal: 3 },
            { employeeId: OTHER, name: 'Ravi Kumar', openTotal: 9 },
          ],
        })}
      />,
    );
    let tree = toJson(renderer);
    expect(findByTestID(tree, 'dispatch-reassign-sheet')).toBeUndefined(); // closed until asked

    await press(tree, 'dispatch-job-reassign');
    tree = toJson(renderer);
    // The current holder is marked and cannot be re-picked.
    expect(allText(findByTestID(tree, `dispatch-reassign-${TECH_ID}-current`)!).join(' ')).toBe('On it');
    const current = findAll(findByTestID(tree, `dispatch-reassign-${TECH_ID}`)!, (n) => typeof n.props.onPress === 'function')[0]!;
    expect((current.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled ?? false).toBeTruthy();

    await press(tree, `dispatch-reassign-${OTHER}`);
    expect(onReassign).toHaveBeenCalledWith(OTHER);
  });

  it('seeds the sheet in IST, never in the UTC the API sends', async () => {
    // 2026-09-17T19:30+05:30 arrives as 2026-09-17T14:00:00.000Z; slicing
    // the string would seed the sheet with 14:00, and with the wrong day
    // for an early-morning slot. The sheet reads them in IST.
    const renderer = await create(
      <DispatcherJobDetailScreen {...baseDeps({ card: cardOf({ scheduledFor: '2026-09-17T14:00:00.000Z' }) })} />,
    );
    await press(toJson(renderer), 'dispatch-job-reschedule');
    const tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'dispatch-reschedule-line')!).join(' ')).toBe('Visit moves to 2026-09-17 · 19:30');
  });

  it('reschedule asks for a day and a time, and sends the IST instant', async () => {
    const onReschedule = vi.fn();
    const renderer = await create(<DispatcherJobDetailScreen {...baseDeps({ onReschedule })} />);
    let tree = toJson(renderer);

    await press(tree, 'dispatch-job-reschedule');
    tree = toJson(renderer);
    // Seeded from the slot the job already carries: 2026-09-17 · 16:30.
    expect(allText(findByTestID(tree, 'dispatch-reschedule-line')!).join(' ')).toBe('Visit moves to 2026-09-17 · 16:30');

    await press(tree, 'dispatch-reschedule-confirm');
    expect(onReschedule).toHaveBeenCalledWith('2026-09-17T16:30:00+05:30');
  });

  it('cancel refuses an incomplete answer — a reason, and a note when it is Other', async () => {
    const onCancelJob = vi.fn();
    const renderer = await create(<DispatcherJobDetailScreen {...baseDeps({ onCancelJob })} />);
    let tree = toJson(renderer);

    await press(tree, 'dispatch-job-cancel');
    tree = toJson(renderer);
    const confirm = () => findAll(findByTestID(toJson(renderer), 'dispatch-cancel-confirm')!, (n) => n.props.accessibilityRole === 'button')[0]!;
    expect(allText(findByTestID(tree, 'dispatch-cancel-confirm')!).join(' ')).toContain('Pick the reason');

    await press(tree, 'dispatch-cancel-reason-other');
    tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'dispatch-cancel-confirm')!).join(' ')).toContain('Other needs a note');
    expect((confirm().props.accessibilityState as { disabled: boolean }).disabled).toBe(true);

    await typeInto(tree, 'dispatch-cancel-note', 'The customer called it off.');
    tree = toJson(renderer);
    expect((confirm().props.accessibilityState as { disabled: boolean }).disabled).toBe(false);
    await press(tree, 'dispatch-cancel-confirm');
    expect(onCancelJob).toHaveBeenCalledWith({ reasonCode: 'other', reasonNote: 'The customer called it off.' });
  });

  it('a plain reason needs no note, and carries only what was chosen', async () => {
    const onCancelJob = vi.fn();
    const renderer = await create(<DispatcherJobDetailScreen {...baseDeps({ onCancelJob })} />);
    await press(toJson(renderer), 'dispatch-job-cancel');
    await press(toJson(renderer), 'dispatch-cancel-reason-no_access');
    await press(toJson(renderer), 'dispatch-cancel-confirm');
    expect(onCancelJob).toHaveBeenCalledWith({ reasonCode: 'no_access' });
  });

  it('a refused write keeps the sheet open and says what the server said', async () => {
    const renderer = await create(
      <DispatcherJobDetailScreen
        {...baseDeps({ actionError: 'This job was reassigned by the office a moment ago.' })}
      />,
    );
    await press(toJson(renderer), 'dispatch-job-reassign');
    const tree = toJson(renderer);
    expect(findByTestID(tree, 'dispatch-reassign-sheet')).toBeDefined();
    expect(allText(findByTestID(tree, 'dispatch-reassign-error')!).join(' ')).toBe(
      'This job was reassigned by the office a moment ago.',
    );
  });
});

/**
 * The day is CHOSEN, not typed at a stub (2026-09-17). `DatePicker` is a
 * field with a trigger and no picking UI of its own — its tap sets a
 * placeholder date — so a screen that renders it bare cannot be used.
 * Yashas hit exactly that in the reschedule sheet; the day list below is
 * the fix, and the same fix went into the dispatch form's Day field.
 */
describe('the reschedule sheet’s day list', () => {
  it('offers today first and offers every day in the window', async () => {
    const renderer = await create(<DispatcherJobDetailScreen {...baseDeps()} />);
    await press(toJson(renderer), 'dispatch-job-reschedule');
    await press(toJson(renderer), 'dispatch-reschedule-days');
    const tree = toJson(renderer);

    const list = findByTestID(tree, 'dispatch-reschedule-day-list');
    expect(list).toBeDefined();
    expect(findByTestID(tree, 'dispatch-reschedule-day-2026-09-17')).toBeDefined(); // today
    expect(findByTestID(tree, 'dispatch-reschedule-day-2026-09-18')).toBeDefined(); // tomorrow
    expect(findByTestID(tree, 'dispatch-reschedule-day-2026-09-30')).toBeDefined(); // day 14
    expect(findByTestID(tree, 'dispatch-reschedule-day-2026-10-01')).toBeUndefined(); // past the window
  });

  it('choosing a day writes it into the sentence and into the instant', async () => {
    const onReschedule = vi.fn();
    const renderer = await create(<DispatcherJobDetailScreen {...baseDeps({ onReschedule })} />);
    await press(toJson(renderer), 'dispatch-job-reschedule');
    await press(toJson(renderer), 'dispatch-reschedule-days');
    await press(toJson(renderer), 'dispatch-reschedule-day-2026-09-19');

    const tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'dispatch-reschedule-line')!).join(' ')).toBe('Visit moves to 2026-09-19 · 16:30');

    await press(tree, 'dispatch-reschedule-confirm');
    expect(onReschedule).toHaveBeenCalledWith('2026-09-19T16:30:00+05:30');
  });

  it('a day with no time picked cannot be sent — both halves are required', async () => {
    const renderer = await create(
      <DispatcherJobDetailScreen {...baseDeps({ card: cardOf({ scheduledFor: null }) })} />,
    );
    await press(toJson(renderer), 'dispatch-job-reschedule');
    let tree = toJson(renderer);
    const confirm = () => findAll(findByTestID(toJson(renderer), 'dispatch-reschedule-confirm')!, (n) => n.props.accessibilityRole === 'button')[0]!;
    expect(allText(findByTestID(tree, 'dispatch-reschedule-line')!).join(' ')).toBe('Pick a day and a time.');
    expect((confirm().props.accessibilityState as { disabled: boolean }).disabled).toBe(true);

    await press(tree, 'dispatch-reschedule-days');
    await press(toJson(renderer), 'dispatch-reschedule-day-2026-09-20');
    tree = toJson(renderer);
    // A day without a time is still not a slot.
    expect((confirm().props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
    expect(allText(findByTestID(tree, 'dispatch-reschedule-line')!).join(' ')).toBe('Pick a day and a time.');
  });
});
