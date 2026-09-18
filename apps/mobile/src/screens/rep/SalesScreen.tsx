/**
 * S2 Sales — the list (UI/plan-2/06-SALES-REP.md §S2). Rows: sale number
 * (mono) · company · date · total (mono, right) · status pill.
 *
 * **Drafts sort first** (`sortSalesRows`) and carry a `Draft` chip — an
 * unconfirmed sale burns no number and moves no balance, so it needs to
 * be visibly unfinished; a draft row shows `Draft` where the number would
 * be, never a fake local number (PLAN-DATA-MODEL.md §3.5: confirm
 * allocates the number).
 *
 * Create lives in `SaleFormScreen` (the route `/sales/new`); the list's
 * *New sale* action navigates there. Pure UI over injected data.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { alpha, formatMoneyEnIN, FRAME, ICON, RADII, SEMANTIC, SPACE, TINT } from '@servgrid/shared';
import { Banner, Button, CalendarGrid, EmptyState, SectionHeader, Sheet } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { dayLabelFor, filterSalesByDay, salesDaySections, type SaleRow } from './model';

export interface SalesScreenProps {
  rows: SaleRow[];
  error: string | null;
  loading: boolean;
  /** Today in IST — the day sections' `Today`/`Yesterday` and the day
   * filter's floor. */
  todayIso: string;
  onNewSale: () => void;
  onOpenSale: (saleId: string) => void;
  onRetry: () => void;
  testID?: string;
}

/** The status pill's label and colour (§S2: Draft / Confirmed / Void). */
/** How far back the day filter reaches. A constant, not today: the whole
 * point of the filter is looking at days already sold. */
export const SALES_HISTORY_FLOOR = '2020-01-01';

export const SALE_STATUS_PILL: Record<SaleRow['status'], { label: string; color: string }> = {
  draft: { label: 'Draft', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

/**
 * The static `Draft` chip — a label, not the pressable `Chip` primitive:
 * a chip that answers a press it will not act on is a lie.
 */
export function DraftChip({ testID }: { testID?: string }): React.ReactNode {
  return (
    <View style={draftChipStyles.shell} testID={testID}>
      <Text style={draftChipStyles.label}>Draft</Text>
    </View>
  );
}

const draftChipStyles = StyleSheet.create({
  shell: {
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.warning, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.warning, TINT.chip),
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  label: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
  },
});

/**
 * The status as the app's chip: dot in the status ink, word in slate.900, on
 * a ground tinted from the colour. The word is the fact; the colour carries
 * it (2026-09-18 — it was a bare coloured word, which is the one thing the
 * vocabulary never does).
 */
function StatusChip({ status, testID }: { status: SaleRow['status']; testID: string }): React.ReactNode {
  const { label, color } = SALE_STATUS_PILL[status];
  return (
    <View
      style={[
        styles.statusChip,
        { borderColor: alpha(color, TINT.chipLine), backgroundColor: alpha(color, TINT.chip) },
      ]}
    >
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={styles.statusWord} testID={testID}>
        {label}
      </Text>
    </View>
  );
}

export function SalesScreen(props: SalesScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();
  // The day filter (2026-09-18): a rep's own list, so it is filtered on the
  // phone — the hub already holds every sale he raised.
  const [day, setDay] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const shown = filterSalesByDay(props.rows, day);
  const sections = salesDaySections(shown, props.todayIso);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'rep-sales'}>
      {/* The frame (2026-09-18): what this list is, how many are in it, and
          the one action — the other screens' shape. */}
      <View style={styles.frame}>
        <View style={styles.frameBody}>
          <Text style={styles.frameTitle}>Sales</Text>
          <Text style={styles.frameCaption}>
            {`${shown.length} ${shown.length === 1 ? 'sale' : 'sales'}`}
            {day === null ? '' : ` · ${dayLabelFor(day, props.todayIso)}`}
          </Text>
        </View>
        <Button label="New sale" icon="plus" variant="primary" onPress={props.onNewSale} testID="sales-new" />
      </View>

      {/* The day filter: one control, the calendar behind it, and a way back
          to every day. */}
      <View style={styles.filterBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: day !== null }}
          onPress={() => setPicking(true)}
          style={[styles.filterChip, day === null ? null : styles.filterChipOn]}
          testID="sales-filter-day"
        >
          <Icon name="calendar" size={ICON.sm} color={day === null ? SEMANTIC.text.secondary : FRAME.text} />
          <Text style={day === null ? styles.filterLabel : styles.filterLabelOn}>
            {day === null ? 'Any day' : dayLabelFor(day, props.todayIso)}
          </Text>
          <Icon name="chevronDown" size={ICON.sm} color={day === null ? SEMANTIC.text.secondary : FRAME.text} />
        </Pressable>
        {day === null ? null : (
          <Pressable
            accessibilityLabel="Clear the day filter"
            accessibilityRole="button"
            onPress={() => setDay(null)}
            style={styles.filterClear}
            testID="sales-filter-clear"
          >
            <Icon name="close" size={ICON.md} color={SEMANTIC.text.secondary} />
          </Pressable>
        )}
      </View>

      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="sales-error" />
      ) : null}

      {!props.loading && props.error === null && shown.length === 0 ? (
        day === null ? (
          <EmptyState message="No sales yet." actionLabel="New sale" onAction={props.onNewSale} testID="sales-empty" />
        ) : (
          <EmptyState
            message="No sales on that day."
            actionLabel="Show every day"
            onAction={() => setDay(null)}
            testID="sales-empty-day"
          />
        )
      ) : (
        sections.map((section) => (
          <View key={section.day} testID={`sales-day-${section.day}`}>
            {/* One section per day, newest first, each carrying what he sold
                that day and how many — the list's own two questions. */}
            <View style={styles.sectionHead}>
              <SectionHeader
                label={section.label}
                icon="calendar"
                count={section.rows.length}
                action={
                  <Text style={styles.sectionTotal} testID={`sales-day-total-${section.day}`}>
                    {`₹${formatMoneyEnIN(section.total)}`}
                  </Text>
                }
              />
            </View>
            {section.rows.map((row) => {
          const pill = SALE_STATUS_PILL[row.status];
          return (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              onPress={() => props.onOpenSale(row.id)}
              style={styles.card}
              testID={`sale-row-${row.id}`}
            >
              {/* The rail carries the row's state, the job card's own
                  language; the chip beside it says the same in words. */}
              <View style={[styles.rail, { backgroundColor: pill.color }]} />
              <View style={styles.main}>
                <View style={styles.numberRow}>
                  <Text style={styles.number} testID={`sale-number-${row.id}`}>
                    {row.saleNumber ?? 'Draft'}
                  </Text>
                  {row.status === 'draft' ? <DraftChip testID={`sale-draft-chip-${row.id}`} /> : null}
                </View>
                <Text style={styles.secondary}>{`${row.companyName} · ${formatDateEnIN(row.saleDate, nowYear)}`}</Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={styles.total}>{`₹${formatMoneyEnIN(row.total)}`}</Text>
                <StatusChip status={row.status} testID={`sale-status-${row.id}`} />
              </View>
              <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
            </Pressable>
          );
            })}
          </View>
        ))
      )}

      {picking ? (
        <Sheet
          visible
          title="Which day"
          onDismiss={() => setPicking(false)}
          testID="sales-day-sheet"
        >
          {/* The app's own month calendar, floored far back: this filter
              looks BACKWARDS at days already sold, so today must not be the
              floor (it greyed out every day he wanted — 2026-09-18). The
              future is simply not offered, because no sale can sit there. */}
          <CalendarGrid
            value={day ?? props.todayIso}
            todayIso={props.todayIso}
            minIso={SALES_HISTORY_FLOOR}
            onSelect={(iso) => {
              setDay(iso);
              setPicking(false);
            }}
            testID="sales-day-calendar"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: day === null }}
            onPress={() => {
              setDay(null);
              setPicking(false);
            }}
            style={styles.anyDayRow}
            testID="sales-day-any"
          >
            <Text style={styles.anyDayWord}>Any day</Text>
          </Pressable>
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
  },
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[3],
    backgroundColor: FRAME.bg,
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    marginBottom: SPACE[4],
  },
  frameBody: { gap: 2 },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** The filter bar, under the frame: one chip and its clear control. */
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    marginBottom: SPACE[2],
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[1],
    minHeight: 44,
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
  /** An applied filter fills navy — the app's one "this is on" fill. */
  filterChipOn: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  filterLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  filterLabelOn: { ...textStyle('label'), color: SEMANTIC.text.onDark },
  filterClear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  /** A day's heading sits in the page's gutter, the rule running to its edge. */
  sectionHead: { marginTop: SPACE[4] },
  sectionTotal: { ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  anyDayRow: {
    minHeight: 52,
    justifyContent: 'center',
    marginTop: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  anyDayWord: { ...textStyle('body'), color: SEMANTIC.text.primary },
  /** A row is a card: air between, hairline round, the rail leading. */
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    marginTop: SPACE[2],
    paddingRight: SPACE[3],
    paddingVertical: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rail: { alignSelf: 'stretch', width: 4 },
  rowEnd: { alignItems: 'flex-end', gap: SPACE[1] },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[2],
    paddingVertical: 2,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusWord: { ...textStyle('caption'), color: SEMANTIC.text.primary },
  main: {
    flex: 1,
    gap: 2,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  number: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  secondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  total: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
});
