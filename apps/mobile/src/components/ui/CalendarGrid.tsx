/**
 * `CalendarGrid` (2026-09-17) — a month calendar for choosing a day.
 *
 * The app's day pickers were lists of the next fortnight, which is the
 * right shape for "today or soon" and the wrong one for "move this visit
 * to the 3rd of next month": a list cannot say *where in the month* a day
 * sits, and it cannot reach past its own window. Yashas asked for the
 * calendar instead, and it is the app's own vocabulary — a grid of tap
 * targets, the chosen day in the accent, today marked, days before the
 * floor greyed and unpickable.
 *
 * Dates are plain IST calendar days (`YYYY-MM-DD`), never instants: the
 * caller hands in `todayIso` and the floor is that same string, so a
 * month never shifts under a timezone. Weeks run Sunday-first (the
 * Indian convention), and the grid is padded with empty cells so a month
 * starts under its own weekday rather than being re-flowed.
 *
 * The month can be walked forward without limit and backward only as far
 * as the floor's own month — a day before `minIso` is unselectable, so
 * there is nothing to see there.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { alpha, COLORS, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Icon } from './icons';

const CELL = 40;
/** Sunday-first, as Indian calendars print it. */
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export interface MonthCursor {
  year: number;
  /** 1–12. */
  month: number;
}

/** The month a `YYYY-MM-DD` day belongs to. */
export function monthCursorOf(iso: string): MonthCursor {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/** `September 2026`. */
export function monthLabelOf(cursor: MonthCursor): string {
  return `${MONTH_NAMES[cursor.month - 1] ?? ''} ${cursor.year}`;
}

/** Steps a month forward or back, rolling the year. */
export function addMonths(cursor: MonthCursor, delta: number): MonthCursor {
  const zeroBased = cursor.month - 1 + delta;
  const year = cursor.year + Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return { year, month };
}

/** Comparison on `YYYY-MM-DD` strings — lexical order is chronological. */
export function isBefore(iso: string, floorIso: string): boolean {
  return iso < floorIso;
}

/**
 * The month's cells, seven per row, Sunday-first: `null` for the blanks
 * before the month starts, then every day as `YYYY-MM-DD`.
 *
 * The weekday of the 1st comes from `Date.UTC` — a date-only value read
 * in UTC has no timezone to be wrong in, the same trick the app's other
 * day arithmetic uses.
 */
export function monthGridOf(cursor: MonthCursor): (string | null)[] {
  const first = new Date(Date.UTC(cursor.year, cursor.month - 1, 1));
  const leading = first.getUTCDay(); // 0 = Sunday, matching WEEKDAYS
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let blank = 0; blank < leading; blank += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const iso = `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push(iso);
  }
  return cells;
}

/**
 * The grid cut into rows of exactly seven, the last row padded with
 * blanks.
 *
 * The rows are explicit because a wrapping container of seven cells at
 * `14.2857%` each is a hair over 100% and Yoga drops the seventh cell onto
 * the next line — which is what the handset showed on 2026-09-17: 1 Sep
 * under T, then 5 Sep starting the row below, and the last weekday letter
 * gone. Seven equal `flex` cells inside a fixed row cannot wrap.
 */
export function weeksOf(grid: (string | null)[]): (string | null)[][] {
  const weeks: (string | null)[][] = [];
  for (let start = 0; start < grid.length; start += 7) {
    const week = grid.slice(start, start + 7);
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

export interface CalendarGridProps {
  /** The chosen day, `YYYY-MM-DD`, or null when nothing is chosen yet. */
  value: string | null;
  /** Today in IST — marked, and the floor when no `minIso` is given. */
  todayIso: string;
  /** The earliest selectable day. Defaults to today. */
  minIso?: string;
  onSelect: (iso: string) => void;
  testID?: string;
}

export function CalendarGrid({ value, todayIso, minIso, onSelect, testID }: CalendarGridProps): React.ReactNode {
  const floor = minIso ?? todayIso;
  // Open on the chosen day's month, or on today's when there is none.
  const [cursor, setCursor] = useState<MonthCursor>(() => monthCursorOf(value ?? todayIso));
  const floorMonth = monthCursorOf(floor);
  const canGoBack =
    cursor.year > floorMonth.year || (cursor.year === floorMonth.year && cursor.month > floorMonth.month);

  return (
    <View testID={testID} style={styles.grid}>
      <View style={styles.head}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          accessibilityState={{ disabled: !canGoBack }}
          disabled={!canGoBack}
          hitSlop={TAP.hitSlop}
          onPress={() => setCursor(addMonths(cursor, -1))}
          style={[styles.arrow, canGoBack ? null : styles.arrowOff]}
          testID={testID ? `${testID}-prev` : undefined}
        >
          <Icon name="back" size={18} color={canGoBack ? SEMANTIC.text.primary : SEMANTIC.text.disabled} />
        </Pressable>
        <Text testID={testID ? `${testID}-month` : undefined} style={styles.month}>
          {monthLabelOf(cursor)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          hitSlop={TAP.hitSlop}
          onPress={() => setCursor(addMonths(cursor, 1))}
          style={styles.arrow}
          testID={testID ? `${testID}-next` : undefined}
        >
          <Icon name="chevronRight" size={18} color={SEMANTIC.text.primary} />
        </Pressable>
      </View>

      <View style={styles.week}>
        {WEEKDAYS.map((letter, index) => (
          <Text key={`${letter}-${index}`} style={styles.weekday}>
            {letter}
          </Text>
        ))}
      </View>

      {weeksOf(monthGridOf(cursor)).map((week, weekIndex) => (
        <View key={`week-${weekIndex}`} style={styles.weekRow}>
          {week.map((iso, dayIndex) => {
            if (iso === null) return <View key={`blank-${dayIndex}`} style={styles.cell} />;
            const chosen = iso === value;
            const isToday = iso === todayIso;
            const blocked = isBefore(iso, floor);
            return (
              <Pressable
                key={iso}
                accessibilityRole="button"
                accessibilityLabel={iso}
                accessibilityState={{ selected: chosen, disabled: blocked }}
                disabled={blocked}
                onPress={() => onSelect(iso)}
                style={[
                  styles.cell,
                  isToday && !chosen ? styles.cellToday : null,
                  // A day behind the floor is never offered, so it never
                  // wears the accent — the fill means "this is the one",
                  // and a greyed number under an accent fill says both.
                  chosen && !blocked ? styles.cellChosen : null,
                ]}
                testID={testID ? `${testID}-day-${iso}` : undefined}
              >
                <Text
                  style={[
                    styles.day,
                    blocked ? styles.dayBlocked : null,
                    chosen && !blocked ? styles.dayChosen : null,
                  ]}
                >
                  {Number(iso.slice(8, 10))}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingVertical: SPACE[2],
    paddingHorizontal: SPACE[1],
    gap: SPACE[1],
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE[2],
  },
  arrow: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowOff: { opacity: 1 },
  month: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  week: { flexDirection: 'row' },
  weekday: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    flex: 1,
    textAlign: 'center',
  },
  weekRow: { flexDirection: 'row' },
  cell: {
    flex: 1,
    height: CELL,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: TAP.hitSlop,
  },
  /** Today wears a ring, so it is findable before anything is chosen. */
  cellToday: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.strong,
  },
  cellChosen: {
    borderWidth: 1,
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  day: { ...textStyle('body'), color: SEMANTIC.text.primary },
  dayChosen: { fontWeight: '600' },
  dayBlocked: { color: SEMANTIC.text.disabled },
});
