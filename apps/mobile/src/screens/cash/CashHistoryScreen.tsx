/**
 * The declarations history (2026-09-18, Yashas: "the sales rep can have a
 * history of cash declarations … by month, with the month's total" and
 * "also the office's answer").
 *
 * One section per month, newest first, headed with the month and what he
 * declared in it — the figure he reconciles against — then one row per
 * day: the amount, the status as a tinted chip, his own note, and the
 * office's answer.
 *
 * **The row is the point.** Until now a disputed day read as the bare
 * word *Disputed*: the employee was told he had been questioned and not
 * what about, on the one screen whose whole job is to tell him what
 * became of his money. `officeAnswerOf` is where that ends. The withheld
 * figure stays withheld — see `handoverModel.officeAnswerOf` for why the
 * difference shown is `declared − confirmed` and never against the
 * system's expectation.
 *
 * The rail and the chip are the house idiom: the rail carries the status
 * as a 4pt stripe, the chip says it in a word with a tinted ground. Both
 * exist because colour alone is not a signal (§ foundations).
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CashHandover } from '@servgrid/shared';
import { alpha, ICON, RADII, SEMANTIC, SPACE, TINT } from '@servgrid/shared';
import { Banner, EmptyState, SectionHeader } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { cashMonthSections, type CashMonthSection } from './cashHistory';
import { dateOptionLabel, officeAnswerOf, rupees, STATUS_PILL } from './handoverModel';

export interface CashHistoryScreenProps {
  /** His own declarations, any order. `null` while the read is in flight. */
  rows: CashHandover[] | null;
  /** Today's IST business date — the label for `Today` and the window's anchor. */
  today: string;
  /** The window in days, or undefined for the whole record (see `withinHistoryWindow`). */
  windowDays?: number;
  /** A read that failed, said in the server's own words when it has them. */
  error?: string | null;
  onRetry?: () => void;
  testID?: string;
}

/** One month's block: the marker, then its days. */
function MonthSection({ section, today }: { section: CashMonthSection; today: string }): React.ReactNode {
  return (
    <View style={styles.section} testID={`cash-history-month-${section.month}`}>
      <SectionHeader
        label={section.label}
        icon="wallet"
        count={section.rows.length}
        action={<Text style={styles.monthTotal}>{rupees(section.total)}</Text>}
        testID={`cash-history-heading-${section.month}`}
      />
      {section.rows.map((row) => (
        <DayRow key={row.id} row={row} today={today} />
      ))}
    </View>
  );
}

/**
 * One declaration as a card, zoned the way `JobCard` is (2026-09-18):
 * **what he declared** in the upper band — the day and the figure, the
 * status chip, his own note — then a hairline seam, then **what the
 * office said** below it.
 *
 * The zones are not decoration. The two voices on this card are different
 * speakers, and run together as one paragraph the office's answer read as
 * more of the employee's own note. The seam is the same one the job card
 * draws between "which job" and "when it stands".
 */
function DayRow({ row, today }: { row: CashHandover; today: string }): React.ReactNode {
  const pill = STATUS_PILL[row.status];
  const answer = officeAnswerOf(row);
  return (
    <View style={styles.card} testID={`cash-history-row-${row.id}`}>
      {/* The status as a rail: readable before a single word is. */}
      <View style={[styles.rail, { backgroundColor: pill.color }]} />

      <View style={styles.cardBody}>
        <View style={styles.declared}>
          <View style={styles.dayLine}>
            <Text style={styles.day} testID={`cash-history-day-${row.id}`}>
              {dateOptionLabel(row.businessDate, today)}
            </Text>
            <Text style={styles.amount} testID={`cash-history-amount-${row.id}`}>
              {rupees(row.declaredAmount)}
            </Text>
          </View>

          <View style={styles.statusLine}>
            <View
              testID={`cash-history-status-${row.id}`}
              style={[
                styles.pillChip,
                {
                  borderColor: alpha(pill.color, TINT.chipLine),
                  backgroundColor: alpha(pill.color, TINT.chip),
                },
              ]}
            >
              <View style={[styles.pillDot, { backgroundColor: pill.color }]} />
              <Text style={styles.pillText}>{pill.label}</Text>
            </View>
          </View>

          {row.note !== null ? (
            <Text style={styles.note} testID={`cash-history-note-${row.id}`}>
              {row.note}
            </Text>
          ) : null}
        </View>

        {/* The seam between the two speakers. */}
        <View style={styles.seam} />

        <View style={styles.answered}>
          {answer !== null ? (
            <View style={styles.answer} testID={`cash-history-answer-${row.id}`}>
              <Icon name="bell" size={ICON.sm} color={pill.color} />
              <Text style={styles.answerText}>
                {answer}
                {row.ownerNote !== null ? ` “${row.ownerNote}”` : ''}
              </Text>
            </View>
          ) : (
            <Text style={styles.waiting} testID={`cash-history-waiting-${row.id}`}>
              Waiting on the office.
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

export function CashHistoryScreen(props: CashHistoryScreenProps): React.ReactNode {
  const { rows, today, windowDays } = props;
  const sections = rows === null ? null : cashMonthSections(rows, today, windowDays);
  const failed = props.error != null;

  /**
   * What the tab says below the banner.
   *
   * A read that FAILED says only that. "No declarations yet" is a claim
   * about his record, and a broken read is in no position to make it — the
   * banner and the empty state must never appear together. The one case
   * worth showing both is a failed refresh that still holds rows: those
   * rows are real, they are just no longer known to be current.
   */
  function body(): React.ReactNode {
    if (sections === null) {
      // Nothing said yet, nothing spinning: the tab is a read that has not
      // answered, and a spinner would be a promise we cannot keep.
      return failed ? null : (
        <Text style={styles.loading} testID="cash-history-loading">
          Reading your declarations…
        </Text>
      );
    }
    if (sections.length === 0) {
      return failed ? null : (
        <EmptyState
          message={
            windowDays === undefined
              ? 'No declarations yet. The days you declare show up here.'
              : `Nothing declared in the last ${windowDays} days.`
          }
          icon="wallet"
          testID="cash-history-empty"
        />
      );
    }
    return sections.map((section) => <MonthSection key={section.month} section={section} today={today} />);
  }

  return (
    <View style={styles.screen} testID={props.testID ?? 'cash-history'}>
      {failed ? (
        <Banner
          tone="danger"
          message={props.error ?? ''}
          onDismiss={props.onRetry}
          testID="cash-history-error"
        />
      ) : null}

      {body()}

      {sections !== null && sections.length > 0 ? (
        <Pressable onPress={props.onRetry} accessibilityRole="button" testID="cash-history-reload" style={styles.reload}>
          <Icon name="refresh" size={ICON.sm} color={SEMANTIC.text.secondary} />
          <Text style={styles.reloadText}>Refresh</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { alignSelf: 'stretch' },
  /**
   * A month and its cards. The `gap` is `space.3` — the house distance
   * between full-bleed cards (`JobsScreen`), used here for the marker →
   * first card step too, so the whole column has one rhythm rather than a
   * header that crowds the card under it. `marginBottom` is what makes a
   * month boundary read as a boundary.
   */
  section: { alignSelf: 'stretch', gap: SPACE[3], marginBottom: SPACE[5] },
  /** Header-of-section money, on the marker's right — the sales list's shape. */
  monthTotal: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  /** The docket: 1px border, no shadow, radius 0 — `JobCard`'s exact frame. */
  card: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
  },
  rail: { width: 4, alignSelf: 'stretch' },
  cardBody: { flex: 1 },
  /** Zone 1 — what he declared. `space.3` all round, then `space.2` between
   * the figure, the chip and his note so they stack as one block. */
  declared: { padding: SPACE[3], gap: SPACE[2] },
  dayLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[2],
  },
  statusLine: { flexDirection: 'row', alignItems: 'center' },
  /** The seam between the two speakers on this card. */
  seam: { height: 1, backgroundColor: SEMANTIC.line.default },
  /** Zone 2 — what the office said. Shallower than zone 1: it is one line,
   * not a block, and matching zone 1's padding would leave it floating. */
  answered: { paddingHorizontal: SPACE[3], paddingVertical: SPACE[2] },
  day: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 },
  amount: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  pillChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[1],
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[2],
    paddingVertical: 2,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { ...textStyle('caption'), color: SEMANTIC.text.primary },
  note: { ...textStyle('body'), color: SEMANTIC.text.secondary },
  /** The office's reply: the bell carries its ink, the word the meaning. */
  answer: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[2] },
  answerText: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flex: 1 },
  waiting: { ...textStyle('caption'), color: SEMANTIC.text.placeholder },
  loading: { ...textStyle('caption'), color: SEMANTIC.text.secondary, paddingVertical: SPACE[4] },
  reload: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE[2],
    minHeight: 44,
    marginTop: SPACE[2],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
  },
  reloadText: { ...textStyle('label'), color: SEMANTIC.text.primary },
});
