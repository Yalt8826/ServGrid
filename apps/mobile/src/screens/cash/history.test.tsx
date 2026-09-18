/**
 * The declarations history (2026-09-18, Yashas: "the sales rep can have a
 * history of cash declarations" — "by month, with the month's total",
 * "also the office's answer", and "the sales rep gets the full history
 * whereas the technician gets only the last 7 days history").
 *
 * Two halves, asserted separately: the pure grouping (`cashMonthSections`,
 * `officeAnswerOf`) and the tab as it renders. The second half is what
 * pins the two things a restyle could quietly break — that the office's
 * answer reaches the row, and that the technician's tab shows a week and
 * says so.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import type { CashHandover } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { CashHistoryScreen } from './CashHistoryScreen';
import { cashMonthSections, monthLabelFor, monthOf, withinHistoryWindow } from './cashHistory';
import { differenceOf, officeAnswerOf, shiftBusinessDate } from './handoverModel';
import { CashScreen } from './CashScreen';

const TODAY = '2026-09-18';

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

describe('the history, grouped', () => {
  it('one section per month, newest first, each carrying what he declared in it', () => {
    const rows = [
      row({ id: 'a', businessDate: '2026-09-18', declaredAmount: '4500' }),
      row({ id: 'b', businessDate: '2026-09-17', declaredAmount: '12000.00' }),
      row({ id: 'c', businessDate: '2026-08-31', declaredAmount: '900' }),
      row({ id: 'd', businessDate: '2026-08-30', declaredAmount: '2000' }),
    ];
    const sections = cashMonthSections(rows, TODAY);
    expect(sections.map((s) => s.month)).toEqual(['2026-09', '2026-08']);
    expect(sections.map((s) => s.label)).toEqual(['September 2026', 'August 2026']);
    // The figure he reconciles against: every rupee declared in the month.
    expect(sections[0]!.total).toBe('16500');
    expect(sections[1]!.total).toBe('2900');
    // Days inside a section read newest first, whatever order they arrived in.
    expect(sections[0]!.rows.map((r) => r.businessDate)).toEqual(['2026-09-18', '2026-09-17']);
  });

  it('the month label is the app’s own — never ICU’s “Sept”', () => {
    // The trap `rep/model.ts` records: `Intl` renders September as "Sept",
    // which reads as a different application beside a row's "18 Sep".
    expect(monthLabelFor('2026-09')).toBe('September 2026');
    expect(monthLabelFor('2026-09')).toContain('Sep');
    expect(monthLabelFor('2026-09')).not.toContain('Sept ');
    expect(monthLabelFor('2026-01')).toBe('January 2026');
    expect(monthLabelFor('2026-12')).toBe('December 2026');
    expect(monthOf('2026-09-18')).toBe('2026-09');
  });

  it('the window keeps the days it should and drops the rest', () => {
    const rows = [
      row({ id: 'a', businessDate: '2026-09-18' }),
      row({ id: 'b', businessDate: shiftBusinessDate(TODAY, -7) }),
      row({ id: 'c', businessDate: shiftBusinessDate(TODAY, -8) }),
      row({ id: 'd', businessDate: shiftBusinessDate(TODAY, -30) }),
    ];
    // No window: the rep reads the whole record.
    expect(withinHistoryWindow(rows, TODAY)).toHaveLength(4);
    // Seven days: the floor is inclusive, and nothing older survives.
    const week = withinHistoryWindow(rows, TODAY, 7).map((r) => r.id);
    expect(week).toEqual(['a', 'b']);
    // A window that straddles a month boundary makes two sections, which is
    // correct rather than a rounding artefact.
    const sections = cashMonthSections(
      [row({ id: 'x', businessDate: '2026-09-02' }), row({ id: 'y', businessDate: '2026-08-29' })],
      '2026-09-05',
      7,
    );
    expect(sections.map((s) => s.month)).toEqual(['2026-09', '2026-08']);
  });
});

describe('the office’s answer', () => {
  it('nothing to say while the day is still open', () => {
    expect(officeAnswerOf(row({ status: 'submitted' }))).toBeNull();
    // Confirmed with no figure recorded is a row we cannot answer for, and
    // inventing a zero would be worse than silence.
    expect(officeAnswerOf(row({ status: 'confirmed', confirmedAmount: null }))).toBeNull();
  });

  it('a confirmed day states the accepted figure, and the difference from the declared one', () => {
    expect(officeAnswerOf(row({ status: 'confirmed', confirmedAmount: '4500' }))).toBe(
      'Office confirmed ₹4,500.',
    );
    expect(officeAnswerOf(row({ status: 'confirmed', confirmedAmount: '4200' }))).toBe(
      'Office confirmed ₹4,200 — ₹300 less than declared.',
    );
    expect(officeAnswerOf(row({ status: 'confirmed', confirmedAmount: '4600' }))).toBe(
      'Office confirmed ₹4,600 — ₹100 more than declared.',
    );
    // The difference is `declared − confirmed`, signed, and never against
    // the system's expectation — that subtraction is the leak.
    expect(differenceOf('4500', '4200')).toBe('300');
    expect(differenceOf('4500', '4600')).toBe('-100');
    expect(differenceOf('4500.00', '4500')).toBe('0');
  });

  it('a disputed day says the figure was not accepted — and the reason is carried beside it', () => {
    expect(officeAnswerOf(row({ status: 'disputed', confirmedAmount: null }))).toBe(
      'The office did not accept this figure.',
    );
  });
});

describe('CashHistoryScreen', () => {
  async function press(renderer: Awaited<ReturnType<typeof create>>, testID: string): Promise<void> {
    await act(async () => {
      findByTestID(toJson(renderer), testID)!.props.onPress?.();
    });
  }

  it('renders the month, its total, and the office’s answer on the day', async () => {
    const r = await create(
      <CashHistoryScreen
        rows={[
          row({
            id: 'a',
            businessDate: '2026-09-16',
            declaredAmount: '900',
            status: 'disputed',
            ownerNote: 'Only ₹600 reached the desk.',
          }),
          row({ id: 'b', businessDate: '2026-09-17', declaredAmount: '12000', status: 'confirmed', confirmedAmount: '12000' }),
        ]}
        today={TODAY}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'cash-history')).toBeDefined();
    // The month section leads with the month and its total. The label is
    // title-case in the model and `SectionHeader` uppercases it on the way
    // out — the house marker convention, so the assertion is on the render.
    const heading = findByTestID(tree, 'cash-history-heading-2026-09')!;
    expect(allText(heading)).toContain('SEPTEMBER 2026');
    expect(allText(findByTestID(tree, 'cash-history-month-2026-09')!)).toContain('₹12,900');
    // A day carries its own amount and state.
    expect(allText(findByTestID(tree, 'cash-history-amount-b')!)).toEqual(['₹12,000']);
    expect(allText(findByTestID(tree, 'cash-history-status-b')!)).toEqual(['Confirmed']);
    // The office's answer, both halves: the reasoning and the note.
    const answered = allText(findByTestID(tree, 'cash-history-answer-a')!).join(' ');
    expect(answered).toContain('The office did not accept this figure.');
    expect(answered).toContain('Only ₹600 reached the desk.');
    // A day nobody has answered says so rather than showing a blank.
    expect(findByTestID(tree, 'cash-history-answer-b')).toBeDefined();
  });

  it('an unanswered day says it is waiting, and an empty record says there is nothing yet', async () => {
    const waiting = await create(<CashHistoryScreen rows={[row({ id: 'c' })]} today={TODAY} />);
    expect(allText(findByTestID(toJson(waiting), 'cash-history-waiting-c')!)).toEqual([
      'Waiting on the office.',
    ]);

    const none = await create(<CashHistoryScreen rows={[]} today={TODAY} />);
    expect(findByTestID(toJson(none), 'cash-history-empty')).toBeDefined();

    // A windowed reader is told which window was empty, not just "nothing".
    const week = await create(<CashHistoryScreen rows={[]} today={TODAY} windowDays={7} />);
    expect(allText(findByTestID(toJson(week), 'cash-history-empty')!).join(' ')).toContain(
      'Nothing declared in the last 7 days.',
    );

    // A read that failed is a banner, not an empty list — an empty list here
    // would be a claim about his record.
    const failed = await create(
      <CashHistoryScreen rows={[]} today={TODAY} error="The office is unreachable." onRetry={vi.fn()} />,
    );
    expect(findByTestID(toJson(failed), 'cash-history-error')).toBeDefined();
    await press(failed, 'cash-history-error');
  });
});

describe('the tabs', () => {
  function fake(history: CashHandover[]) {
    return {
      today: TODAY,
      loadHistory: vi.fn(async () => history),
      declare: vi.fn(async () => row({})),
      amend: vi.fn(async () => row({})),
    };
  }

  it('opens on Declare, and the History tab shows the list the declare view hides', async () => {
    const deps = fake([row({ id: 'a' }), row({ id: 'b', businessDate: shiftBusinessDate(TODAY, -1) })]);
    const r = await create(<CashScreen {...deps} />);
    expect(findByTestID(toJson(r), 'cash-history')).toBeUndefined();

    await act(async () => {
      findByTestID(toJson(r), 'cash-tab-history')!.props.onPress?.();
    });
    const tree = toJson(r);
    expect(findByTestID(tree, 'cash-history')).toBeDefined();
    expect(findByTestID(tree, 'cash-history-row-a')).toBeDefined();
    expect(findByTestID(tree, 'cash-history-row-b')).toBeDefined();
    // The caption follows the tab, so the header never describes the other one.
    expect(allText(findByTestID(tree, 'cash-caption')!)).toEqual([
      'Every declaration, and what the office made of it.',
    ]);
    // …and back: the form is still there, with the day it was left on.
    await act(async () => {
      findByTestID(toJson(r), 'cash-tab-declare')!.props.onPress?.();
    });
    expect(findByTestID(toJson(r), 'cash-history')).toBeUndefined();
    expect(findByTestID(toJson(r), 'handover-panel')).toBeDefined();
  });

  it('counts the days the tab would show, in the reader’s window', async () => {
    const rows = [
      row({ id: 'a', businessDate: TODAY }),
      row({ id: 'b', businessDate: shiftBusinessDate(TODAY, -30) }),
    ];
    const full = await create(<CashScreen {...fake(rows)} />);
    expect(allText(findByTestID(toJson(full), 'cash-tab-history')!)).toEqual(['History · 2']);

    // The technician: the count is his week's, and so is what the tab opens on.
    const week = await create(<CashScreen {...fake(rows)} historyWindowDays={7} />);
    expect(allText(findByTestID(toJson(week), 'cash-tab-history')!)).toEqual(['History · 1']);
    await act(async () => {
      findByTestID(toJson(week), 'cash-tab-history')!.props.onPress?.();
    });
    expect(findByTestID(toJson(week), 'cash-history-row-a')).toBeDefined();
    expect(findByTestID(toJson(week), 'cash-history-row-b')).toBeUndefined();
    expect(allText(findByTestID(toJson(week), 'cash-caption')!)).toEqual([
      'The last 7 days, and what the office made of them.',
    ]);
  });

  it('a declare folds into the list without a second read', async () => {
    const deps = fake([]);
    const r = await create(<CashScreen {...deps} />);
    expect(deps.loadHistory).toHaveBeenCalledTimes(1);

    const amount = findAll(findByTestID(toJson(r), 'handover-amount')!, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      amount.props.onChangeText?.('45000');
    });
    await act(async () => {
      findAll(findByTestID(toJson(r), 'handover-submit')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deps.declare).toHaveBeenCalledWith({ businessDate: TODAY, declaredAmount: '45000' });
    // No reload: the row the POST returned is the row the tab shows.
    expect(deps.loadHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      findByTestID(toJson(r), 'cash-tab-history')!.props.onPress?.();
    });
    expect(allText(findByTestID(toJson(r), 'cash-tab-history')!)).toEqual(['History · 1']);
  });

  it('a failed read is said out loud, and the panel keeps its own manners', async () => {
    const failing = {
      today: TODAY,
      loadHistory: vi.fn(async () => {
        throw new Error('You are offline.');
      }),
      declare: vi.fn(async () => row({})),
      amend: vi.fn(async () => row({})),
    };
    const r = await create(<CashScreen {...failing} />);
    // The form is unaffected — it does not need the history to declare.
    expect(findByTestID(toJson(r), 'handover-submit')).toBeDefined();
    await act(async () => {
      findByTestID(toJson(r), 'cash-tab-history')!.props.onPress?.();
    });
    const tree = toJson(r);
    expect(findByTestID(tree, 'cash-history-error')).toBeDefined();
    expect(allText(tree)).toContain('You are offline.');
    expect(findByTestID(tree, 'cash-history-empty')).toBeUndefined();
  });
});
