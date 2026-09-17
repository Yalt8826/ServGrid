/**
 * The AMC tab (T2B.4, UI/plan-2/05-DISPATCHER.md §D5, 07-OWNER.md §O6).
 * Three sections, one scroll: DUE FOR A VISIT (the reminder — four months
 * since the customer's last completed job, any job), ENDING WITHIN 7
 * DAYS, ALL AMCs (searchable). Pure over injected props; `useContractSections`
 * (§D5's data seam) owns the reads and each section fails alone.
 *
 * The owner's phone renders the same three sections; his desk renders the
 * ALL section as the sortable table (07-OWNER.md: "the same job is a
 * table row on desktop") — due and ending stay as lists, because they are
 * work queues, not ledgers. No accent in the header: the one primary on
 * this screen is none — Dispatch and Renew are secondary, + New is
 * secondary, because the tab's job is looking, not pressing.
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { alpha, formatMoneyEnIN, FRAME, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import type { Contract } from '@servgrid/shared';
import { Banner, Button, EmptyState, SectionHeader, TextField, useDensity } from '../../components/ui';
import { Skeleton, useSkeleton } from '../../components/ui/Skeleton';
import { formatDateEnIN, formatDateWithYear } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable, type SortState } from '../owner/deskTable';
import { contractStateTone, dueLine, endingLine } from './model';

export interface AmcScreenProps {
  role: 'dispatcher' | 'owner';
  todayIso: string;
  query: string;
  onQueryChange(q: string): void;
  /** null = that section is still loading. */
  due: Contract[] | null;
  ending: Contract[] | null;
  all: Contract[] | null;
  dueError: string | null;
  endingError: string | null;
  allError: string | null;
  onRetry(section: 'due' | 'ending' | 'all'): void;
  onNew(): void;
  onOpen(contractId: string): void;
  onDispatch(customerId: string): void;
  onRenew(contractId: string): void;
  testID?: string;
}

/** The skeleton geometry stands in for three rows of the section's list. */
function SectionSkeleton({ testID }: { testID: string }): React.ReactNode {
  return (
    <View testID={testID} style={styles.skeletonWrap}>
      <Skeleton width="60%" height={16} />
      <Skeleton width="80%" height={13} />
      <Skeleton width="40%" height={13} />
    </View>
  );
}

export function AmcScreen(props: AmcScreenProps): React.ReactNode {
  const density = useDensity();
  const desk = density === 'desk';
  // This screen is shared: console for the dispatcher, field for the owner's
  // phone, desk for the owner's web table. Its body type follows the density
  // it is actually rendered in (2026-09-17).
  const bodyText = useMemo(() => textStyle('body', density), [density]);
  const bodyStrongText = useMemo(() => textStyle('bodyStrong', density), [density]);
  const [sort, setSort] = useState<SortState>({ key: 'endDate', dir: 'asc' });
  const dueSkeleton = useSkeleton(props.due === null);
  const endingSkeleton = useSkeleton(props.ending === null);
  const allSkeleton = useSkeleton(props.all === null);
  const nowYear = new Date().getFullYear();

  const searchEmpty = props.query.trim() !== '';

  return (
    <View style={styles.screen} testID={props.testID ?? 'amc-screen'}>
      {/* The frame (2026-09-17): the tab's name and its one action, on the
          navy the route paints behind the status bar. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle}>AMC</Text>
        <Button label="New" icon="plus" variant="secondary" onPress={props.onNew} testID="amc-new" />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {/* ── DUE FOR A VISIT ─────────────────────────────────────────── */}
        <View testID="amc-due">
          <SectionHeader
            label="Due for a visit"
            icon="alert"
            {...(props.due === null ? {} : { count: props.due.length })}
          />
          {props.dueError !== null ? (
            <Banner
              tone="danger"
              message={props.dueError}
              actions={[{ label: 'Retry', onPress: () => props.onRetry('due') }]}
              testID="amc-due-error"
            />
          ) : props.due === null ? (
            dueSkeleton ? <SectionSkeleton testID="amc-due-skeleton" /> : null
          ) : props.due.length === 0 ? (
            <EmptyState message="No AMC customer is due for a visit." testID="amc-due-empty" />
          ) : (
            props.due.map((c) => (
              <View key={c.id} style={styles.row} testID={`amc-due-${c.id}`}>
                {/* The rail says "this one wants attention" before the line
                    under it is read — the console's row language. */}
                <View style={[styles.rail, { backgroundColor: SEMANTIC.feedback.warning }]} />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => props.onOpen(c.id)}
                  style={styles.rowBody}
                  testID={`amc-due-open-${c.id}`}
                >
                  <Text numberOfLines={1} style={[styles.rowTitle, bodyStrongText]}>
                    {c.customerName}
                  </Text>
                  <Text numberOfLines={1} style={[styles.rowMeta, bodyText]}>
                    {dueLine(c)}
                  </Text>
                </Pressable>
                <Button
                  label="Dispatch"
                  icon="send"
                  variant="secondary"
                  onPress={() => props.onDispatch(c.customerId)}
                  testID={`amc-dispatch-${c.id}`}
                />
              </View>
            ))
          )}
        </View>

        {/* ── ENDING WITHIN 7 DAYS ────────────────────────────────────── */}
        <View testID="amc-ending">
          <SectionHeader
            label="Ending within 7 days"
            icon="clock"
            {...(props.ending === null ? {} : { count: props.ending.length })}
          />
          {props.endingError !== null ? (
            <Banner
              tone="danger"
              message={props.endingError}
              actions={[{ label: 'Retry', onPress: () => props.onRetry('ending') }]}
              testID="amc-ending-error"
            />
          ) : props.ending === null ? (
            endingSkeleton ? <SectionSkeleton testID="amc-ending-skeleton" /> : null
          ) : props.ending.length === 0 ? (
            <EmptyState message="No AMC ends in the next 7 days." testID="amc-ending-empty" />
          ) : (
            props.ending.map((c) => (
              <View key={c.id} style={styles.row} testID={`amc-ending-${c.id}`}>
                <View style={[styles.rail, { backgroundColor: SEMANTIC.feedback.warning }]} />
                <Pressable
                  accessibilityRole="button"
                  onPress={() => props.onOpen(c.id)}
                  style={styles.rowBody}
                  testID={`amc-ending-open-${c.id}`}
                >
                  <Text numberOfLines={1} style={[styles.rowTitle, bodyStrongText]}>
                    {c.customerName}
                    <Text style={styles.mono}>{` · ${c.contractNumber}`}</Text>
                  </Text>
                  {/* Urgency and money on one line: the deadline in the
                      warning's own tint, the price in tabular mono. */}
                  <View style={styles.rowLine}>
                    <View style={styles.endingChip}>
                      <Text style={styles.endingChipWord}>{endingLine(c)}</Text>
                    </View>
                    <Text style={styles.money}>{`₹${formatMoneyEnIN(c.contractValue)}`}</Text>
                  </View>
                </Pressable>
                <Button
                  label="Renew"
                  icon="forward"
                  variant="secondary"
                  onPress={() => props.onRenew(c.id)}
                  testID={`amc-renew-${c.id}`}
                />
              </View>
            ))
          )}
        </View>

        {/* ── ALL AMCs ────────────────────────────────────────────────── */}
        <View testID="amc-all">
          <SectionHeader label="All AMCs" icon="list" />
          <View style={styles.searchWrap}>
            <TextField
              label="Search"
              value={props.query}
              onChangeText={props.onQueryChange}
              placeholder="Customer or AMC number"
              testID="amc-search"
            />
          </View>
          {props.allError !== null ? (
            <Banner
              tone="danger"
              message={props.allError}
              actions={[{ label: 'Retry', onPress: () => props.onRetry('all') }]}
              testID="amc-all-error"
            />
          ) : props.all === null ? (
            allSkeleton ? <SectionSkeleton testID="amc-all-skeleton" /> : null
          ) : props.all.length === 0 ? (
            searchEmpty ? (
              <View testID="amc-all-empty-search">
                {/* The action belongs to the empty state (the app's own
                    idiom), not to a button floating beside it. */}
                <EmptyState
                  message="No AMC matches."
                  actionLabel="Clear search"
                  onAction={() => props.onQueryChange('')}
                  testID="amc-all-empty"
                />
                <Button label="Clear search" variant="secondary" onPress={() => props.onQueryChange('')} testID="amc-clear-search" />
              </View>
            ) : (
              <EmptyState message="No AMCs recorded yet." testID="amc-all-empty" />
            )
          ) : desk ? (
            <DeskTable
              data={props.all}
              rowKey={(c) => c.id}
              sort={sort}
              onSort={setSort}
              scrollTestID="amc-all-table"
              onRowPress={(c) => props.onOpen(c.id)}
              maxHeight={640}
              columns={[
                {
                  key: 'contractNumber',
                  label: 'Number',
                  width: 156,
                  render: (c) => (
                    <Text numberOfLines={1} style={styles.monoCell} testID={`amc-number-${c.id}`}>
                      {c.contractNumber}
                    </Text>
                  ),
                  sortValue: (c) => c.contractNumber,
                },
                {
                  key: 'customer',
                  label: 'Customer',
                  width: null,
                  render: (c) => <Text numberOfLines={1} style={styles.cell}>{c.customerName}</Text>,
                  sortValue: (c) => c.customerName,
                },
                {
                  key: 'startDate',
                  label: 'Start',
                  width: 116,
                  render: (c) => <Text numberOfLines={1} style={styles.monoCell}>{formatDateEnIN(c.startDate, nowYear)}</Text>,
                  sortValue: (c) => c.startDate,
                },
                {
                  key: 'endDate',
                  label: 'End',
                  width: 116,
                  render: (c) => (
                    <Text numberOfLines={1} style={styles.monoCell} testID={`amc-end-${c.id}`}>
                      {formatDateWithYear(c.endDate)}
                    </Text>
                  ),
                  sortValue: (c) => c.endDate,
                },
                {
                  key: 'price',
                  label: 'Price',
                  width: 110,
                  align: 'right',
                  render: (c) => <Text numberOfLines={1} style={styles.monoCell}>{`₹${formatMoneyEnIN(c.contractValue)}`}</Text>,
                  sortValue: (c) => Number(c.contractValue),
                },
                {
                  key: 'state',
                  label: 'State',
                  width: 100,
                  render: (c) => (
                    <Text numberOfLines={1} style={styles.cell} testID={`amc-state-${c.id}`}>
                      {contractStateTone(c.state).label}
                    </Text>
                  ),
                  sortValue: (c) => contractStateTone(c.state).label,
                },
                {
                  key: 'nextVisitDue',
                  label: 'Next due',
                  width: 116,
                  render: (c) => (
                    <Text numberOfLines={1} style={styles.monoCell}>
                      {c.state === 'active' ? formatDateWithYear(c.nextVisitDue) : '—'}
                    </Text>
                  ),
                  sortValue: (c) => c.nextVisitDue,
                },
              ]}
            />
          ) : (
            props.all.map((c) => {
              const tone = contractStateTone(c.state);
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  onPress={() => props.onOpen(c.id)}
                  style={styles.allRow}
                  testID={`amc-all-${c.id}`}
                >
                  <View style={styles.allMain}>
                    <Text numberOfLines={1} style={[styles.rowTitle, bodyStrongText]}>
                      <Text style={styles.mono}>{c.contractNumber}</Text>
                      {` · ${c.customerName}`}
                    </Text>
                    <Text numberOfLines={1} style={[styles.rowMeta, bodyText]}>
                      {`until ${formatDateWithYear(c.endDate)}`}
                      {c.state === 'active' ? ` · next due ${formatDateWithYear(c.nextVisitDue)}` : ''}
                    </Text>
                  </View>
                  {/* The state as the app's chip: dot, word, ground tinted
                      from the state's own colour — the word is still the
                      fact, the colour only carries it. */}
                  <View style={styles.stateChip}>
                    <View style={[styles.stateDot, { backgroundColor: tone.color }]} />
                    <Text style={styles.stateWord}>{tone.label}</Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  /** The frame: what the tab is, and its one action (2026-09-17). */
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[3],
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8], paddingTop: SPACE[2] },
  /** A card per row: air between them, a hairline round, the rail on the left. */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    marginTop: SPACE[2],
    paddingRight: SPACE[3],
    paddingVertical: SPACE[2],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  /** The 4pt status rail, the same weight every console row carries. */
  rail: { alignSelf: 'stretch', width: 4 },
  /** Urgency and money share a line under the name. */
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  endingChip: {
    paddingHorizontal: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.warning, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.warning, TINT.chip),
  },
  endingChipWord: { ...textStyle('caption'), color: SEMANTIC.text.primary },
  /** The contract state, in the app's chip language. */
  stateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACE[2],
    paddingVertical: 3,
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
  },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateWord: { ...textStyle('label'), color: SEMANTIC.text.primary },
  allMain: { flex: 1, gap: 2 },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...textStyle('h2'), color: SEMANTIC.text.primary },
  rowMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  // The body/bodyStrong ink follows the density (console 15, field 16,
  // desk 14): a module-level StyleSheet cannot read the provider.
  bodyText: { color: SEMANTIC.text.secondary },
  bodyStrongText: { color: SEMANTIC.text.primary },
  money: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  mono: { ...textStyle('mono'), color: SEMANTIC.text.primary },
  // A search field is a sentence, not a paragraph — the full 1160px
  // measure read as an unstyled input on the desk (2026-09-16 walk).
  searchWrap: { marginTop: SPACE[1], maxWidth: 420 },
  allRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    marginTop: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  cell: {
    ...textStyle('body', 'desk'),
    color: SEMANTIC.text.primary,
  },
  monoCell: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  skeletonWrap: { gap: SPACE[2], paddingVertical: SPACE[2] },
});
