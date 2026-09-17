/**
 * `CalendarGrid` (2026-09-17) — the month calendar the console's day
 * pickers use. The pure half is what can go wrong in ways a screenshot
 * will not show: which weekday a month starts under, whether stepping a
 * month rolls the year, and how far back the floor lets you reach.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import { allText, create, findByTestID, toJson, type Node } from './testing';
import { CalendarGrid, addMonths, monthCursorOf, monthGridOf, monthLabelOf, weeksOf } from './CalendarGrid';

const day = (tree: Node, iso: string): Node => findByTestID(tree, `cal-day-${iso}`)!;
/** A day declares both halves; the forward arrow only ever declares its enabled half. */
const state = (node: Node): { selected?: boolean; disabled?: boolean } =>
  (node.props.accessibilityState ?? {}) as { selected?: boolean; disabled?: boolean };
/** The style a node actually wears, with its array folded away. */
const flat = (node: Node): Record<string, unknown> =>
  Object.assign({}, ...(Array.isArray(node.props.style) ? node.props.style : [node.props.style]));
const press = async (node: Node): Promise<void> => {
  await act(async () => {
    node.props.onPress?.();
  });
};

describe('the calendar’s month arithmetic', () => {
  it('reads the month out of a day', () => {
    expect(monthCursorOf('2026-09-17')).toEqual({ year: 2026, month: 9 });
  });

  it('names the month', () => {
    expect(monthLabelOf({ year: 2026, month: 9 })).toBe('September 2026');
  });

  it('steps a month and rolls the year both ways', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 6 }, 7)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 6 }, -7)).toEqual({ year: 2025, month: 11 });
  });

  it('pads the month so its first day sits under its own weekday', () => {
    // 1 September 2026 is a Tuesday: Sunday-first, so two blanks.
    const september = monthGridOf({ year: 2026, month: 9 });
    expect(september.slice(0, 2)).toEqual([null, null]);
    expect(september[2]).toBe('2026-09-01');
    expect(september).toHaveLength(2 + 30);

    // 1 March 2026 is a Sunday: no blanks at all.
    const march = monthGridOf({ year: 2026, month: 3 });
    expect(march[0]).toBe('2026-03-01');
    expect(march).toHaveLength(31);
  });

  it('knows a leap February', () => {
    const days = (grid: (string | null)[]): number => grid.filter((cell) => cell !== null).length;
    expect(days(monthGridOf({ year: 2028, month: 2 }))).toBe(29);
    expect(days(monthGridOf({ year: 2026, month: 2 }))).toBe(28);
  });

  it('cuts the month into rows of exactly seven, padding the last', () => {
    // The rows are explicit because seven wrapped cells at 14.2857% each
    // are a hair over 100% and the seventh drops to the next line — which
    // is what the handset did (1 Sep under T, 5 Sep starting the row
    // below). Seven per row is the whole point of the layout.
    const weeks = weeksOf(monthGridOf({ year: 2026, month: 9 }));
    expect(weeks).toHaveLength(5); // 2 blanks + 30 days = 32 cells
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]).toEqual([
      null,
      null,
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
    expect(weeks[4]).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', null, null, null]);
  });
});

describe('CalendarGrid — the surface', () => {
  it('opens on the chosen day’s month, marks today, and greys the past', async () => {
    const renderer = await create(
      <CalendarGrid value="2026-09-17" todayIso="2026-09-17" onSelect={() => {}} testID="cal" />,
    );
    const tree = toJson(renderer);

    expect(allText(findByTestID(tree, 'cal-month')!)).toEqual(['September 2026']);
    // 1 September is in the month (so it can be seen) but before the floor.
    expect(state(day(tree, '2026-09-01')).disabled).toBe(true);
    expect(state(day(tree, '2026-09-16')).disabled).toBe(true);
    expect(state(day(tree, '2026-09-17')).disabled).toBe(false);
    expect(state(day(tree, '2026-09-17')).selected).toBe(true);
    // September is the floor's own month: nothing before it to walk to.
    expect(state(findByTestID(tree, 'cal-prev')!).disabled).toBe(true);
    expect(findByTestID(tree, 'cal-next')!.props.disabled).toBeFalsy();
  });

  it('reports the day that was tapped', async () => {
    const picked: string[] = [];
    const renderer = await create(
      <CalendarGrid value={null} todayIso="2026-09-17" onSelect={(iso) => picked.push(iso)} testID="cal" />,
    );
    await press(day(toJson(renderer), '2026-09-20'));
    expect(picked).toEqual(['2026-09-20']);
  });

  it('fills the chosen day in the accent — but never a day behind the floor', async () => {
    // The visit currently sits on the 11th while today is the 17th: the
    // cell is where the job is, and it is not offered, so it stays grey.
    const renderer = await create(
      <CalendarGrid value="2026-09-11" todayIso="2026-09-17" onSelect={() => {}} testID="cal" />,
    );
    const tree = toJson(renderer);
    expect(flat(day(tree, '2026-09-11')).backgroundColor).toBeUndefined();
    expect(flat(day(tree, '2026-09-11')).borderColor).toBeUndefined();
    // A day after the floor takes the fill, and is the only one that does.
    expect(flat(day(tree, '2026-09-17')).borderColor).toBeTruthy();
    const filled = (iso: string): boolean => flat(day(tree, iso)).backgroundColor !== undefined;
    expect(filled('2026-09-18')).toBe(false);

    const chosen = await create(
      <CalendarGrid value="2026-09-18" todayIso="2026-09-17" onSelect={() => {}} testID="cal" />,
    );
    expect(flat(day(toJson(chosen), '2026-09-18')).backgroundColor).toBeTruthy();
  });

  it('walks months forward and back, stopping at the floor’s month', async () => {
    const renderer = await create(
      <CalendarGrid value="2026-11-04" todayIso="2026-09-17" onSelect={() => {}} testID="cal" />,
    );
    // It opens on the chosen day's month, not today's.
    expect(allText(findByTestID(toJson(renderer), 'cal-month')!)).toEqual(['November 2026']);

    await press(findByTestID(toJson(renderer), 'cal-prev')!);
    expect(allText(findByTestID(toJson(renderer), 'cal-month')!)).toEqual(['October 2026']);

    await press(findByTestID(toJson(renderer), 'cal-prev')!);
    const tree = toJson(renderer);
    expect(allText(findByTestID(tree, 'cal-month')!)).toEqual(['September 2026']);
    expect(state(findByTestID(tree, 'cal-prev')!).disabled).toBe(true);

    await press(findByTestID(tree, 'cal-next')!);
    expect(allText(findByTestID(toJson(renderer), 'cal-month')!)).toEqual(['October 2026']);
  });
});
