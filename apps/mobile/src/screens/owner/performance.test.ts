/**
 * The four charts' data rules (OW.3, 2026-09-16): stack everyone by
 * default, drop to one person on request, keep every day in the range
 * even when nobody worked it, and never add money up from parts the
 * server did not send.
 */
import { describe, expect, it } from 'vitest';

import {
  countPoints,
  dayLabel,
  isEmptySeries,
  moneyPoints,
  personOptions,
  rangeTotal,
  seriesPeople,
  stackRows,
} from './performance';

const DAYS = ['2026-09-14', '2026-09-15', '2026-09-16'];
const RAVI = { id: 'r', name: 'Ravi Kumar' };
const ANITHA = { id: 'a', name: 'Anitha' };
const PEOPLE = [RAVI, ANITHA];

describe('stackRows — one row per day, one segment per person', () => {
  it('keeps every day in the range, including the ones nobody worked', () => {
    const rows = stackRows(DAYS, [{ date: '2026-09-15', employeeId: 'r', value: 900 }], PEOPLE, null, 'week');
    expect(rows.map((r) => r.date)).toEqual(DAYS);
    expect(rows[0]!.total).toBe(0);
    expect(rows[1]!.total).toBe(900);
  });

  it('stacks each person under their own id, and totals the day', () => {
    const rows = stackRows(
      DAYS,
      [
        { date: '2026-09-15', employeeId: 'r', value: 900 },
        { date: '2026-09-15', employeeId: 'a', value: 350 },
      ],
      PEOPLE,
      null,
      'week',
    );
    expect(rows[1]!.values).toEqual({ r: 900, a: 350 });
    expect(rows[1]!.total).toBe(1250);
  });

  it('a chosen person keeps only their own bars, on the same days', () => {
    const rows = stackRows(
      DAYS,
      [
        { date: '2026-09-15', employeeId: 'r', value: 900 },
        { date: '2026-09-15', employeeId: 'a', value: 350 },
      ],
      PEOPLE,
      'a',
      'week',
    );
    expect(rows.map((r) => r.date)).toEqual(DAYS);
    expect(rows[1]!.values).toEqual({ a: 350 });
    expect(rows[1]!.total).toBe(350);
  });

  it('ignores a point outside the range the server drew', () => {
    const rows = stackRows(DAYS, [{ date: '2026-08-01', employeeId: 'r', value: 500 }], PEOPLE, null, 'week');
    expect(rangeTotal(rows)).toBe(0);
  });

  it('sums a person twice on one day rather than dropping one', () => {
    const rows = stackRows(
      ['2026-09-14'],
      [
        { date: '2026-09-14', employeeId: 'r', value: 100 },
        { date: '2026-09-14', employeeId: 'r', value: 50 },
      ],
      PEOPLE,
      null,
      'week',
    );
    expect(rows[0]!.values.r).toBe(150);
  });
});

describe('the wire shapes normalise once', () => {
  it('money arrives as a decimal string and becomes a number for drawing only', () => {
    expect(moneyPoints([{ date: '2026-09-14', employeeId: 'r', value: '1011.00' }])).toEqual([
      { date: '2026-09-14', employeeId: 'r', value: 1011 },
    ]);
  });

  it('counts arrive as numbers already', () => {
    expect(countPoints([{ date: '2026-09-14', employeeId: 'r', count: 3 }])).toEqual([
      { date: '2026-09-14', employeeId: 'r', value: 3 },
    ]);
  });
});

describe('day labels — the weekday inside a week, the month across months', () => {
  it('names the weekday over a week', () => {
    expect(dayLabel('2026-09-14', 'week')).toBe('Mon 14');
    expect(dayLabel('2026-09-20', 'week')).toBe('Sun 20');
  });

  it('names the month over 30 and 90 days, where the weekday is noise', () => {
    expect(dayLabel('2026-09-14', '30d')).toBe('14 Sep');
    expect(dayLabel('2026-12-01', '90d')).toBe('1 Dec');
  });

  it('never routes the date through a local timezone', () => {
    // 2026-01-01 is a Thursday in every timezone; a Date() parse of the
    // bare string would drift it a day west of UTC.
    expect(dayLabel('2026-01-01', 'week')).toBe('Thu 1');
  });
});

describe('the filter and the people a chart draws', () => {
  it('offers everyone first, then each person', () => {
    expect(personOptions(PEOPLE, 'All technicians')).toEqual([
      { value: '', label: 'All technicians' },
      { value: 'r', label: 'Ravi Kumar' },
      { value: 'a', label: 'Anitha' },
    ]);
  });

  it('draws everyone by default and one person when chosen', () => {
    expect(seriesPeople(PEOPLE, null)).toHaveLength(2);
    expect(seriesPeople(PEOPLE, 'a')).toEqual([ANITHA]);
  });

  it('an untouched range says so instead of drawing an axis over nothing', () => {
    expect(isEmptySeries(stackRows(DAYS, [], PEOPLE, null, 'week'))).toBe(true);
    expect(isEmptySeries(stackRows(DAYS, [{ date: DAYS[0]!, employeeId: 'r', value: 1 }], PEOPLE, null, 'week'))).toBe(
      false,
    );
  });
});
