/**
 * The job list, both roles' shapes, one component (T4.11,
 * UI/plan-2/07-OWNER.md §O4). The rule the screen exists to prove:
 * **the same job is a card on a phone and a table row on desktop** —
 * and the owner's table is the ONLY job table in the product with an
 * amount column, because the amount arrives on a different RESPONSE
 * SCHEMA (`JobCardOwner`), not as an optional field on a shared one.
 * So the column set is derived here from the cards' shape
 * (`carriesAmount`): hand this component a dispatcher's page
 * (`JobCardDispatcher[]`) and there is no amount column to render —
 * no flag, no prop, nothing to forget.
 *
 * - **Desktop** (`desk` density — the rail, ≥1024px web): `DeskTable` —
 *   rail · number · customer · service · technician · scheduled ·
 *   status · **amount**, sortable, the status colour on the left edge.
 *   A row click opens the **side detail** (`OwnerJobDetailBody`) — the
 *   amend action lives in there.
 * - **Phone** (field density): cards with **the dispatcher's filter
 *   bar** — the exported `FilterBar` from Job Logs, the same chips and
 *   the same URL-owned filter state. A card tap pushes the detail
 *   screen; the route owns that navigation.
 *
 * Pure UI over injected data; `useOwnerJobs` is the wiring and the
 * route file is the mount point.
 */
import { useMemo, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DESK, STATUS, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, EmptyState, Skeleton, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { FilterBar, type JobLogsTechnician } from '../dispatcher/job-logs';
import { formatResultCount, jobLogsFiltersAreDefault, shortJobNumber, type JobLogsFilters } from '../dispatcher/jobLogsFilters';
import { DeskTable } from './deskTable';
import type { DeskTableColumn, SortState } from './deskTable';
import { OwnerJobDetailBody, type OwnerJobDetailDeps } from './JobDetailBody';
import {
  amountLabelOf,
  amountSortValueOf,
  carriesAmount,
  overdueCountOf,
  scheduledLabelOf,
  sortOwnerRows,
  statusWordOf,
  type JobRow,
} from './jobsModel';

const STATUS_EDGE: Record<string, string> = {
  unassigned: STATUS.unassigned,
  assigned: STATUS.unassigned,
  en_route: STATUS.en_route,
  in_progress: STATUS.in_progress,
  completed: STATUS.completed,
  cancelled: STATUS.cancelled,
};

export interface OwnerJobsDeps extends Omit<OwnerJobDetailDeps, 'card' | 'onClose'> {
  offline: boolean;
  loading: boolean;
  error: string | null;
  /** The current page's rows, server-filtered; null while loading. */
  rows: JobRow[] | null;
  /** The roster, for the filter bar's technician chip. */
  technicians: JobLogsTechnician[];
  filters: JobLogsFilters;
  query: string;
  onFiltersChange(next: JobLogsFilters): void;
  onQueryChange(query: string): void;
  /** Phone: the pushed detail screen. Desk: the side detail takes over. */
  onOpenJob(jobId: string): void;
  /** The list's own retry — the detail's `onRetry` rides the detail deps. */
  onRetryList(): void;
  onLoadMore(): void;
  /** Desk side detail — which row is open, null when none. */
  selectedJobId: string | null;
  onSelectJob(jobId: string | null): void;
}

// ── the phone card ───────────────────────────────────────────────────────

/**
 * The phone presentation of the row — the D2 card language (rail, two
 * lines, status word), with the amount riding the right edge WHEN the
 * schema carried one. A dispatcher's card has no amount line because
 * its schema has no amount field.
 */
function JobCardRow({ row, onPress, testID }: { row: JobRow; onPress: (id: string) => void; testID: string }): React.ReactNode {
  const card = row.card;
  const amount = amountLabelOf(card);
  const pressed = STATUS_EDGE[card.status] ?? STATUS.unassigned;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Job ${card.jobNumber}`}
      onPress={() => onPress(card.id)}
      style={styles.card}
    >
      <View style={[styles.cardRail, { backgroundColor: pressed }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardLine1}>
          <Text style={styles.cardNumber}>{shortJobNumber(card.jobNumber)}</Text>
          <Text numberOfLines={1} style={styles.cardTitle}>
            {card.title}
          </Text>
          {amount !== null ? (
            <Text style={styles.cardAmount} testID={`${testID}-amount`}>
              {amount}
            </Text>
          ) : null}
        </View>
        <View style={styles.cardLine2}>
          <Text numberOfLines={1} style={styles.cardMeta}>
            {`${card.customerName} · ${row.technicianName ?? 'Unassigned'}`}
          </Text>
          <View style={styles.cardSpacer} />
          <View style={styles.statusGroup}>
            <View style={[styles.dot, { backgroundColor: pressed }]} />
            <Text style={styles.statusText}>{statusWordOf(card.status)}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ── the desk table's columns, from the schema ────────────────────────────

function jobColumns(rows: readonly JobRow[], nowYear: number): DeskTableColumn<JobRow>[] {
  const columns: DeskTableColumn<JobRow>[] = [
    {
      key: 'jobNumber',
      label: 'Number',
      // 13 mono chars — the full number must read, never an ellipsis:
      // the suffix is the job's identity in every conversation about it.
      width: 140,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono} testID={`job-number-${r.card.id}`}>
          {r.card.jobNumber}
        </Text>
      ),
      sortValue: (r) => r.card.jobNumber,
    },
    {
      key: 'customer',
      label: 'Customer',
      width: null,
      render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.card.customerName}</Text>,
      sortValue: (r) => r.card.customerName,
    },
    {
      key: 'service',
      label: 'Service',
      width: 130,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1}>
          {r.card.title}
        </Text>
      ),
      sortValue: (r) => r.card.title,
    },
    {
      key: 'technician',
      label: 'Technician',
      width: 108,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cell}>
          {r.technicianName ?? 'Unassigned'}
        </Text>
      ),
      sortValue: (r) => r.technicianName ?? '',
    },
    {
      key: 'scheduled',
      label: 'Scheduled',
      // "16 Sep · 15:00" — the date and the time both read or the
      // column is decoration; ellipsising the hour hid the day's plan.
      width: 132,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono}>
          {scheduledLabelOf(r.card.scheduledFor, nowYear)}
        </Text>
      ),
      sortValue: (r) => r.card.scheduledFor ?? '',
    },
    {
      key: 'status',
      label: 'Status',
      width: 112,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cell}>
          {statusWordOf(r.card.status)}
        </Text>
      ),
      sortValue: (r) => statusWordOf(r.card.status),
    },
  ];
  // THE amount column — present exactly when the cards are the owner
  // schema. A dispatcher's page falls through with no column at all.
  if (carriesAmount(rows)) {
    columns.push({
      key: 'amount',
      label: 'Amount',
      width: 100,
      align: 'right',
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono} testID={`job-amount-${r.card.id}`}>
          {amountLabelOf(r.card) ?? '—'}
        </Text>
      ),
      sortValue: (r) => amountSortValueOf(r.card),
    });
  }
  return columns;
}

// ── the screen ───────────────────────────────────────────────────────────

const SKELETON_ROWS = 8;

export function OwnerJobsScreen(deps: OwnerJobsDeps): React.ReactNode {
  const density = useDensity();
  const desk = density === 'desk';
  const [sort, setSort] = useState<SortState>({ key: 'scheduled', dir: 'desc' });
  const nowYear = new Date().getFullYear();

  const loading = deps.rows === null && deps.error === null;
  const rows = deps.rows ?? [];
  const sorted = useMemo(() => sortOwnerRows(rows), [rows]);
  const overdue = useMemo(() => overdueCountOf(sorted), [sorted]);
  const filteredEmpty = rows.length === 0 && (!jobLogsFiltersAreDefault(deps.filters) || deps.query.trim() !== '');

  const selectedRow = desk ? (rows.find((r) => r.card.id === deps.selectedJobId) ?? null) : null;

  return (
    <View
      style={[styles.screen, desk && styles.screenDesk]}
      testID="owner-jobs-screen"
    >
      <View style={[styles.header, desk && styles.headerDesk]}>
        <Text style={styles.title}>Jobs</Text>
        <Text style={styles.count} testID="owner-jobs-count">
          {formatResultCount(sorted.length, overdue)}
        </Text>
      </View>

      {deps.offline ? <Banner tone="danger" message="No connection. This screen is not live." testID="owner-jobs-offline" /> : null}
      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetryList} testID="owner-jobs-error" />
      ) : loading ? (
        <View style={styles.loading} testID="owner-jobs-loading">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width="18%" height={13} />
              <Skeleton width="42%" height={13} />
              <Skeleton width="14%" height={13} />
            </View>
          ))}
        </View>
      ) : sorted.length === 0 ? (
        filteredEmpty ? (
          <EmptyState
            message="No jobs match these filters."
            actionLabel="Clear filters"
            onAction={() => {
              deps.onQueryChange('');
              deps.onFiltersChange({ date: 'today', tech: { kind: 'anyone' }, status: 'any' });
            }}
            testID="owner-jobs-empty-filtered"
          />
        ) : (
          <EmptyState message="No jobs yet." testID="owner-jobs-empty" />
        )
      ) : desk ? (
        <View style={styles.deskBody}>
          <View style={styles.tableWrap}>
            {/* The dispatcher's filter bar serves the desk table too —
            scanning 200 jobs is the same job at both densities. */}
            <FilterBar
              filters={deps.filters}
              technicians={deps.technicians}
              offline={deps.offline}
              onChange={deps.onFiltersChange}
              onClear={() => deps.onFiltersChange({ date: 'today', tech: { kind: 'anyone' }, status: 'any' })}
            />
            <DeskTable
              data={sorted}
              rowKey={(r) => r.card.id}
              sort={sort}
              onSort={setSort}
              scrollTestID="owner-jobs-table"
              edgeColor={(r) => STATUS_EDGE[r.card.status] ?? null}
              onRowPress={(r) => deps.onSelectJob(r.card.id)}
              columns={jobColumns(sorted, nowYear)}
            />
          </View>
          {deps.selectedJobId !== null ? (
            <View style={styles.sideDetail} testID="owner-jobs-side-detail">
              <OwnerJobDetailBody
                card={selectedRow?.card ?? null}
                detail={deps.detail}
                detailLoading={deps.detailLoading}
                detailError={deps.detailError}
                amendFlagOn={deps.amendFlagOn}
                amendBusy={deps.amendBusy}
                amendError={deps.amendError}
                reopenBusy={deps.reopenBusy}
                onAmend={deps.onAmend}
                onReopen={deps.onReopen}
                onRetry={deps.onRetry}
                onClose={() => deps.onSelectJob(null)}
                testID="owner-jobs-side-detail-body"
              />
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.phoneBody}>
          <FilterBar
            filters={deps.filters}
            technicians={deps.technicians}
            offline={deps.offline}
            onChange={deps.onFiltersChange}
            onClear={() => deps.onFiltersChange({ date: 'today', tech: { kind: 'anyone' }, status: 'any' })}
          />
          <FlashList
            testID="owner-jobs-list"
            data={sorted}
            renderItem={({ item }) => (
              <JobCardRow row={item} onPress={deps.onOpenJob} testID={`owner-job-card-${item.card.id}`} />
            )}
            keyExtractor={(item) => item.card.id}
            onEndReached={deps.onLoadMore}
            contentContainerStyle={{ paddingBottom: SPACE[8] }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  // The page furniture the DeskListShell gives the other console lists —
  // this screen owns its header, so it wears the same padding itself.
  screenDesk: {
    paddingHorizontal: DESK.page.padX,
    paddingTop: DESK.page.padY,
    paddingBottom: DESK.page.padY,
    maxWidth: DESK.page.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[1],
  },
  headerDesk: { paddingHorizontal: 0, paddingTop: 0 },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  count: { ...textStyle('caption'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  loading: { padding: SPACE[4], gap: SPACE[2] },
  skeletonRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  // No gap: the side detail's border-left is the separator, and the
  // 24px a gap costs is exactly what squeezes the table's last column
  // out of view when a row is open (2026-09-16 walk).
  deskBody: { flex: 1, flexDirection: 'row' },
  tableWrap: { flex: 1 },
  sideDetail: {
    width: 356,
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
  },
  phoneBody: { flex: 1 },
  card: {
    flexDirection: 'row',
    minHeight: 56,
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  cardRail: { width: 3 },
  cardBody: { flex: 1, paddingHorizontal: SPACE[3], justifyContent: 'center', gap: 2, paddingVertical: SPACE[2] },
  cardLine1: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  cardNumber: { ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  cardTitle: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flexShrink: 1 },
  cardAmount: { ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  cardLine2: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  cardMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flexShrink: 1 },
  cardSpacer: { flex: 1 },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  cell: { ...textStyle('body', 'desk'), color: SEMANTIC.text.primary },
  cellMono: { ...textStyle('mono', 'desk'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
});
