/**
 * Service calls (§D7, 2026-09-17) — the pure screen and the one piece of
 * maths in it. What matters: the six-month reminder reads as a debt or a
 * promise, the row's three doors do what they say (dial, assign, push
 * back), and the push-back sheet records the outcome with the date the
 * reminder moves to — or closes the cycle when the customer is not
 * interested.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { ServiceCall } from '@servgrid/shared';
import { openedUrls } from '../../test-stubs/react-native';
import { allText, create, findAll, findByTestID, firstDescendantOfType, toJson, type Node } from '../../components/ui/testing';
import { ServiceCallsScreen, dayLabel, dueWords, snoozeDay, type ServiceCallsScreenProps } from './serviceCalls';

const TODAY = '2026-09-17';
const CUST_A = '01890a5e-2000-7000-8000-00000000000a';
const CUST_B = '01890a5e-2000-7000-8000-00000000000b';

function call(overrides: Partial<ServiceCall> & { customerId: string }): ServiceCall {
  return {
    customerName: 'Sunrise Apartments',
    phone: '9845012345',
    area: 'Whitefield',
    lastServiceOn: '2026-03-03',
    lastJobNumber: 'JC-2627-00044',
    lastJobTitle: 'Battery swap',
    dueOn: '2026-09-03',
    remindOn: '2026-09-03',
    pushedTo: null,
    daysDue: 14,
    openJobs: 0,
    lastOutcome: null,
    lastNote: null,
    lastCalledBy: null,
    ...overrides,
  };
}

/** The two lists as the server answers them: due oldest-debt first. */
const DUE = [call({ customerId: CUST_A })];
const PUSHED = [
  call({
    customerId: CUST_B,
    customerName: 'Nandi Motors',
    phone: '9847098765',
    area: null,
    pushedTo: '2026-12-15',
    remindOn: '2026-12-15',
    daysDue: -89,
    lastOutcome: 'called',
    lastNote: 'Asked for December',
    lastCalledBy: 'Dispatcher Test',
  }),
];

function baseProps(overrides: Partial<ServiceCallsScreenProps> = {}): ServiceCallsScreenProps {
  return {
    offline: false,
    loading: false,
    error: null,
    due: DUE,
    pushed: PUSHED,
    saving: false,
    saveError: null,
    onRetry: vi.fn(),
    onRecord: vi.fn(async () => {}),
    onDismissError: vi.fn(),
    onAssign: vi.fn(),
    todayIso: TODAY,
    ...overrides,
  };
}

// ── harness helpers (the ui testing module's own idiom) ──────────────────

function findID(renderer: ReactTestRenderer, testID: string): Node | undefined {
  return findByTestID(toJson(renderer), testID);
}

function textOf(renderer: ReactTestRenderer, testID: string): string {
  const node = findID(renderer, testID);
  expect(node, `no node ${testID}`).toBeDefined();
  return allText(node!).join(' ');
}

/** Press the node that owns `onPress` at or under the testID. */
function pressableOf(node: Node): Node {
  if (typeof node.props.onPress === 'function') return node;
  const inner = findAll(node, (n) => typeof n.props.onPress === 'function')[0];
  expect(inner).toBeDefined();
  return inner!;
}

async function press(node: Node): Promise<void> {
  await act(async () => {
    pressableOf(node).props.onPress?.();
  });
}

beforeEach(() => {
  openedUrls.length = 0;
});

// ── the pure half ────────────────────────────────────────────────────────

describe('the cycle’s own arithmetic', () => {
  it('reads a reminder as a debt, a promise or today', () => {
    expect(dueWords(0)).toBe('due today');
    expect(dueWords(1)).toBe('1 day overdue');
    expect(dueWords(14)).toBe('14 days overdue');
    expect(dueWords(-3)).toBe('in 3 days');
  });

  it('proposes three months out, clamping to the month’s end', () => {
    expect(snoozeDay('2026-09-17')).toBe('2026-12-17');
    // 31 Jan + 3 months: February has no 31st, so the offer is its last day.
    expect(snoozeDay('2026-01-31')).toBe('2026-04-30');
    // …and it rolls the year.
    expect(snoozeDay('2026-11-30')).toBe('2027-02-28');
  });

  it('writes a day the way the phone does', () => {
    expect(dayLabel('2026-03-03')).toBe('3 Mar 2026');
    expect(dayLabel('2026-12-15')).toBe('15 Dec 2026');
  });
});

// ── the screen ───────────────────────────────────────────────────────────

describe('ServiceCallsScreen (§D7)', () => {
  it('shows who is due, how late they are, and who is coming back', async () => {
    const renderer = await create(<ServiceCallsScreen {...baseProps()} />);

    const due = textOf(renderer, `service-call-${CUST_A}`);
    expect(due).toContain('Sunrise Apartments');
    expect(due).toContain('9845012345');
    expect(due).toContain('Whitefield');
    expect(due).toContain('Last service 3 Mar 2026');
    expect(due).toContain('JC-2627-00044');
    expect(due).toContain('14 days overdue');

    const pushed = textOf(renderer, `service-call-pushed-${CUST_B}`);
    expect(pushed).toContain('Nandi Motors');
    expect(pushed).toContain('Back 15 Dec 2026');
    expect(pushed).toContain('Asked for December — Dispatcher Test');
    // A promise is not a debt: no overdue wording on a pushed row.
    expect(pushed).not.toContain('overdue');
  });

  it('states an empty list as good news, and says nothing is pushed when nothing is', async () => {
    const renderer = await create(<ServiceCallsScreen {...baseProps({ due: [], pushed: [] })} />);
    expect(textOf(renderer, 'service-calls-empty')).toBe('Nobody is due a service call.');
    expect(textOf(renderer, 'service-calls-pushed-empty')).toBe('Nobody has asked to be rung later.');
  });

  it('dials the customer, and hands the assignment to the dispatch form', async () => {
    const onAssign = vi.fn();
    const renderer = await create(<ServiceCallsScreen {...baseProps({ onAssign })} />);

    await press(findID(renderer, `service-call-${CUST_A}-call`)!);
    expect(openedUrls).toEqual(['tel:9845012345']);

    await press(findID(renderer, `service-call-${CUST_A}-assign`)!);
    expect(onAssign).toHaveBeenCalledWith(CUST_A);
  });

  it('refuses a call that says nothing, and saves the outcome with the date it moves to', async () => {
    const onRecord = vi.fn(async () => {});
    const renderer = await create(<ServiceCallsScreen {...baseProps({ onRecord })} />);

    await press(findID(renderer, `service-call-${CUST_A}-push`)!);
    expect(findID(renderer, 'service-call-push-sheet')).toBeDefined();

    // The offer is three months, already picked — and a note on its own
    // is also enough, so the save button stands down only when both are empty.
    expect(textOf(renderer, 'service-call-push-day')).toContain('17 Dec 2026');
    expect(textOf(renderer, 'service-call-push-save')).not.toContain('Pick a date');

    const noteInput = firstDescendantOfType(findID(renderer, 'service-call-push-note')!, 'TextInput')!;
    await act(async () => {
      noteInput.props.onChangeText?.('Wants to wait for the rains');
    });

    await press(findID(renderer, 'service-call-push-save')!);
    expect(onRecord).toHaveBeenCalledWith(CUST_A, {
      outcome: 'called',
      note: 'Wants to wait for the rains',
      nextCallOn: '2026-12-17',
    });
  });

  it('records "not interested" as an ending: the date comes off', async () => {
    const onRecord = vi.fn(async () => {});
    const renderer = await create(<ServiceCallsScreen {...baseProps({ onRecord })} />);
    await press(findID(renderer, `service-call-${CUST_A}-push`)!);

    await press(findID(renderer, 'service-call-outcome-not_interested')!);
    expect(textOf(renderer, 'service-call-push-day')).toContain('No date — the cycle closes');

    const noteInput = firstDescendantOfType(findID(renderer, 'service-call-push-note')!, 'TextInput')!;
    await act(async () => {
      noteInput.props.onChangeText?.('Bought elsewhere');
    });
    await press(findID(renderer, 'service-call-push-save')!);
    expect(onRecord).toHaveBeenCalledWith(CUST_A, { outcome: 'not_interested', note: 'Bought elsewhere', nextCallOn: null });
  });

  it('lets the date be moved, and the floor keeps a push-back forward', async () => {
    const onRecord = vi.fn(async () => {});
    const renderer = await create(<ServiceCallsScreen {...baseProps({ onRecord })} />);
    await press(findID(renderer, `service-call-${CUST_A}-push`)!);

    // The calendar rides under the day row, on the reminder's own month.
    await press(findID(renderer, 'service-call-push-day-toggle')!);
    expect(findID(renderer, 'service-call-push-calendar')).toBeDefined();
    expect(textOf(renderer, 'service-call-push-calendar-month')).toBe('December 2026');

    await press(findID(renderer, 'service-call-push-calendar-day-2026-12-20')!);
    expect(textOf(renderer, 'service-call-push-day')).toContain('20 Dec 2026');
    // Picking a day is not saving the call: the button in the footer is.
    expect(onRecord).not.toHaveBeenCalled();

    // Today is the floor, so September — three months back from the offer —
    // is where the walk stops, and the days before today are unpickable: a
    // reminder filed in the past would ring nobody.
    for (let step = 0; step < 3; step += 1) {
      await press(findID(renderer, 'service-call-push-calendar-prev')!);
    }
    expect(textOf(renderer, 'service-call-push-calendar-month')).toBe('September 2026');
    const past = findID(renderer, 'service-call-push-calendar-day-2026-09-16')!;
    expect(past).toBeDefined();
    expect((past.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
    const today = findID(renderer, 'service-call-push-calendar-day-2026-09-17')!;
    expect((today.props.accessibilityState as { disabled: boolean }).disabled).toBe(false);
  });

  it('carries the offline banner and a refused write’s sentence', async () => {
    const offline = await create(<ServiceCallsScreen {...baseProps({ offline: true })} />);
    expect(textOf(offline, 'service-calls-offline')).toBe('No connection. The call list is not live.');

    const refused = await create(
      <ServiceCallsScreen {...baseProps({ saveError: 'That call could not be saved. Try again.' })} />,
    );
    expect(textOf(refused, 'service-calls-error')).toContain('That call could not be saved.');
  });

  it('never mentions money anywhere on the page', async () => {
    const renderer = await create(<ServiceCallsScreen {...baseProps()} />);
    const json = JSON.stringify(toJson(renderer)).toLowerCase();
    for (const word of ['amount', 'revenue', 'contract_value', '₹']) {
      expect(json).not.toContain(word);
    }
  });
});
