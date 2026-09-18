/**
 * T6 Cash handover tests (UI/plan-2/04-TECHNICIAN.md §T6). The three the
 * spec names:
 *
 * - **No `expected` figure anywhere in the tree** — the deliberate
 *   absence. He declares; the system's expectation is the check.
 * - **Amend visible while `submitted`, absent when `confirmed`**, with
 *   the explanatory copy present.
 * - **The date picker refuses 8 days back** — today, changeable back
 *   seven days, nothing further.
 *
 * The screen is pure UI over `CashScreenDeps`; tests drive it through
 * fakes exactly as the consent and ladder tests do. These renders open on
 * the DECLARE tab (the default), which is why the no-list invariant below
 * is asserted against the whole tree — the history is one tab away by
 * design, not on this view.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { CashHandover } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { CashScreen } from './CashScreen';
import {
  HANDOVER_WINDOW_DAYS,
  handoverError,
  handoverWindow,
  isWithinHandoverWindow,
  istBusinessDate,
  lockedCopy,
  shiftBusinessDate,
} from './handoverModel';

const TODAY = '2026-09-11'; // a Friday, in IST terms — the route's `today`
const EIGHT_BACK = shiftBusinessDate(TODAY, -8); // 2026-09-03

function row(overrides: Partial<CashHandover>): CashHandover {
  return {
    id: '0b6f1c2e-0000-4000-8000-000000000001',
    businessDate: TODAY,
    declaredAmount: '4500',
    note: null,
    status: 'submitted',
    declaredAt: `${TODAY}T13:30:00.000Z`,
    confirmedAmount: null,
    ownerNote: null,
    confirmedAt: null,
    version: 1,
    ...overrides,
  };
}

interface Fake {
  loadHistory: ReturnType<typeof vi.fn>;
  declare: ReturnType<typeof vi.fn>;
  amend: ReturnType<typeof vi.fn>;
  deps: {
    today: string;
    loadHistory: () => Promise<CashHandover[]>;
    declare: (input: { businessDate: string; declaredAmount: string; note?: string }) => Promise<CashHandover>;
    amend: (id: string, version: number, input: { declaredAmount?: string; note?: string }) => Promise<CashHandover>;
  };
}

function fake(history: CashHandover[] = []): Fake {
  const loadHistory = vi.fn(async () => history);
  const declare = vi.fn(async (input: { businessDate: string; declaredAmount: string }) =>
    row({ businessDate: input.businessDate, declaredAmount: input.declaredAmount, status: 'submitted' }),
  );
  const amend = vi.fn(async (_id: string, _version: number, input: { declaredAmount?: string }) =>
    row({ declaredAmount: input.declaredAmount ?? '4500' }),
  );
  return { loadHistory, declare, amend, deps: { today: TODAY, loadHistory, declare, amend } };
}

async function typeAmount(renderer: ReactTestRenderer, text: string, field = 'handover-amount'): Promise<void> {
  const node = findByTestID(toJson(renderer), field)!;
  const input = findAll(node, (n) => n.type === 'TextInput')[0]!;
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID)!;
  const pressable = node.type === 'Pressable' ? node : findAll(node, (n) => n.type === 'Pressable')[0]!;
  await act(async () => {
    pressable.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CashScreen — the declare tab (§T6)', () => {
  it('§ no `expected` figure anywhere in the tree', async () => {
    const { deps } = fake([
      row({ status: 'confirmed' }),
      row({ businessDate: shiftBusinessDate(TODAY, -1), status: 'disputed' }),
    ]);
    const r = await create(<CashScreen {...deps} />);
    const tree = toJson(r);
    // The word, in any case, in any string in the tree — copy, helper,
    // label, pill, history.
    expect(JSON.stringify(tree).toLowerCase()).not.toContain('expected');
    expect(allText(tree).join(' | ').toLowerCase()).not.toContain('expected');
    // Its silent twin is absent too: no expenses field on this screen.
    expect(allText(tree).join(' | ').toLowerCase()).not.toContain('expense');
  });

  it('§ Amend visible while `submitted`; absent when `confirmed`, with the explanatory copy present', async () => {
    const submitted = fake([row({ status: 'submitted', declaredAmount: '4500' })]);
    let r = await create(<CashScreen {...submitted.deps} />);
    expect(findByTestID(toJson(r), 'handover-amend')).toBeDefined();
    expect(findByTestID(toJson(r), 'handover-submit')).toBeUndefined();
    expect(allText(toJson(r))).toContain('₹ 4,500');

    // Amend opens the correction in place, prefilled, and saves with the
    // row's version — the optimistic-concurrency guard's client half.
    await press(r, 'handover-amend');
    expect(findByTestID(toJson(r), 'handover-amend-save')).toBeDefined();
    await typeAmount(r, '45000', 'handover-amend-amount');
    await press(r, 'handover-amend-save');
    expect(submitted.amend).toHaveBeenCalledWith(row({}).id, 1, { declaredAmount: '45000' });

    const confirmed = fake([row({ status: 'confirmed' })]);
    r = await create(<CashScreen {...confirmed.deps} />);
    expect(findByTestID(toJson(r), 'handover-amend')).toBeUndefined();
    expect(findByTestID(toJson(r), 'handover-locked-copy')).toBeDefined();
    expect(allText(toJson(r))).toContain('The office has confirmed this day. Ask the owner to reopen it.');

    // Disputed is read-only by the same rule, with copy that tells the truth.
    expect(lockedCopy('disputed')).toBe('The office has disputed this day. Ask the owner to reopen it.');
  });

  it('§ the date picker refuses 8 days back', async () => {
    // The guard the picker enforces: today − 8 is outside the window, in
    // both directions that matter (too old, and never the future).
    expect(isWithinHandoverWindow(shiftBusinessDate(TODAY, -7), TODAY)).toBe(true);
    expect(isWithinHandoverWindow(EIGHT_BACK, TODAY)).toBe(false);
    expect(isWithinHandoverWindow(shiftBusinessDate(TODAY, 1), TODAY)).toBe(false);

    // The window itself is exactly eight days, today first — there is no
    // ninth day to reach.
    expect(HANDOVER_WINDOW_DAYS).toBe(7);
    const window = handoverWindow(TODAY);
    expect(window).toEqual([
      TODAY,
      shiftBusinessDate(TODAY, -1),
      shiftBusinessDate(TODAY, -2),
      shiftBusinessDate(TODAY, -3),
      shiftBusinessDate(TODAY, -4),
      shiftBusinessDate(TODAY, -5),
      shiftBusinessDate(TODAY, -6),
      shiftBusinessDate(TODAY, -7),
    ]);

    // And the rendered picker offers only those eight.
    const { deps } = fake();
    const r = await create(<CashScreen {...deps} />);
    await press(r, 'handover-date-open');
    const sheet = findByTestID(toJson(r), 'handover-date-sheet');
    expect(sheet).toBeDefined();
    expect(findByTestID(toJson(r), `handover-date-option-${EIGHT_BACK}`)).toBeUndefined();
    for (const iso of window) {
      expect(findByTestID(toJson(r), `handover-date-option-${iso}`)).toBeDefined();
    }
    await press(r, 'handover-date-close');

    // Handing the picker an out-of-window day directly (the primitive's
    // onChange is the guard the trigger and any native picker both pass
    // through) is refused in place: the error says why, the date stays.
    const datePicker = r.root.findAll(
      (node) => node.props.testID === 'handover-date' && typeof node.props.onChange === 'function',
    )[0]!;
    await act(async () => {
      datePicker.props.onChange(EIGHT_BACK);
    });
    expect(findByTestID(toJson(r), 'handover-date-error')).toBeDefined();
    expect(allText(toJson(r))).toContain(`Handovers cover the last 7 days — pick a day from today back.`);
    // The chosen date is unchanged: the trigger still reads today.
    expect(findByTestID(toJson(r), 'handover-date-trigger')).toBeDefined();
    expect(allText(toJson(r))).toContain('11 Sep');
  });

  it('declare posts the day, the amount, and only a non-empty note', async () => {
    const f = fake();
    const r = await create(<CashScreen {...f.deps} />);
    await typeAmount(r, '45000');
    await press(r, 'handover-submit');
    expect(f.declare).toHaveBeenCalledWith({ businessDate: TODAY, declaredAmount: '45000' });

    // After the declaration the day flips to its `submitted` state.
    expect(findByTestID(toJson(r), 'handover-amend')).toBeDefined();

    const withNote = fake();
    const r2 = await create(<CashScreen {...withNote.deps} />);
    await typeAmount(r2, '4500');
    const note = findAll(findByTestID(toJson(r2), 'handover-note')!, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      note.props.onChangeText?.('  counter copy  ');
    });
    await press(r2, 'handover-submit');
    expect(withNote.declare).toHaveBeenCalledWith({ businessDate: TODAY, declaredAmount: '4500', note: 'counter copy' });
  });

  it('an empty amount cannot submit, and a failed declaration shows the server copy', async () => {
    const failing = fake();
    failing.declare.mockRejectedValueOnce(new Error('This day is already declared.'));
    const r = await create(<CashScreen {...failing.deps} />);
    // The pressable is disabled with its reason; nothing fires.
    await typeAmount(r, ''); // stays empty
    const submitPressable = findAll(findByTestID(toJson(r), 'handover-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submitPressable.props.accessibilityState).toMatchObject({ disabled: true });
    await press(r, 'handover-submit');
    expect(failing.declare).not.toHaveBeenCalled();

    await typeAmount(r, '4500');
    await press(r, 'handover-submit');
    expect(failing.declare).toHaveBeenCalledTimes(1);
    expect(findByTestID(toJson(r), 'handover-banner')).toBeDefined();
    expect(allText(toJson(r))).toContain('This day is already declared.');

    // A non-Error failure (network layer) gets the plain fallback.
    expect(handoverError(new Error('The office refused the figure.'))).toBe('The office refused the figure.');
    expect(handoverError('boom')).toBe('The declaration could not be saved. Try again.');
  });

  it('the declare view carries no list — the history is its own tab (2026-09-16, revised 2026-09-18)', async () => {
    // Three past days sit behind the screen; none of them renders HERE. The
    // selected day's own state (row for `date`) is the only read. Revised
    // when Yashas asked for the history back: it returned as a tab, not as
    // a block under the form, so the daily act stays exactly this short —
    // and the two assertions below still hold on this view.
    const { deps } = fake([
      row({ status: 'submitted' }),
      row({ businessDate: shiftBusinessDate(TODAY, -1), status: 'confirmed', declaredAmount: '12000' }),
      row({ businessDate: shiftBusinessDate(TODAY, -3), status: 'disputed', declaredAmount: '900' }),
    ]);
    const r = await create(<CashScreen {...deps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'cash-history-empty')).toBeUndefined();
    expect(findByTestID(tree, 'cash-history')).toBeUndefined();
    expect(
      findAll(tree, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('cash-history-row-')),
    ).toHaveLength(0);
    const texts = allText(tree);
    expect(texts).not.toContain('₹ 12,000');
    expect(texts).not.toContain('Your declarations'.toUpperCase());

    // …and it is one tap away rather than gone: the tab is on this view.
    expect(findByTestID(tree, 'cash-tab-history')).toBeDefined();
    expect(findByTestID(tree, 'cash-tab-declare')).toBeDefined();
  });

  it('istBusinessDate reads the IST calendar, not the device clock', () => {
    // 2026-09-11 18:30 UTC is 2026-09-12 00:00 in Kolkata — the business
    // day has turned over even though the device's UTC date has not.
    expect(istBusinessDate(new Date('2026-09-11T18:30:00.000Z'))).toBe('2026-09-12');
    expect(istBusinessDate(new Date('2026-09-11T17:29:00.000Z'))).toBe('2026-09-11');
  });
});
