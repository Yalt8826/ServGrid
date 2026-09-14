/**
 * T4.1 spike DataTable (THROWAWAY) — the T4.7 component, prototyped at
 * measurement fidelity: 500 rows, sortable, sticky header, virtualised
 * via FlashList, `desk` density (40pt rows, 14px body, tabular money),
 * zebra stripes in slate.100 and the status colour on the left edge of
 * every row — the shared edge that makes the card and the row read as
 * one object at two densities (`UI/plan-2/07-OWNER.md`, `07-OWNER.md`
 * §O4).
 *
 * What the spike deliberately exercises, because it is what RNW must
 * carry: FlashList's OWN sticky-header machinery (`stickyHeaderIndices`)
 * running on react-native-web — not a layout-pinned sibling, which
 * cannot fail. If this works, T4.7 builds on it; if not, the pinned
 * sibling is the recorded fallback.
 *
 * THROWAWAY INSTRUMENTATION: the module-level render counter and the
 * `spike:*` performance marks exist only for the browser harness. This
 * pattern must not outlive the spike.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, Text, View } from 'react-native';

import { DENSITY, SEMANTIC, STATUS, groupEnIN } from '@servgrid/shared';
import { resolveFontFamily, textStyle } from '../../fonts/textStyle';
import type { DeskJob } from './mockJobs';

export type SortKey = 'jobNumber' | 'customer' | 'scheduledForMs' | 'amount';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export const SORT_KEYS: SortKey[] = ['jobNumber', 'customer', 'scheduledForMs', 'amount'];

const ROW_HEIGHT = DENSITY.desk.rowHeight; // 40
const HEADER_HEIGHT = 40;
const EDGE_WIDTH = 3;

/** `assigned` rides the muted slate, as the technician JobCard does. */
function statusColor(status: DeskJob['status']): string {
  return STATUS[status as keyof typeof STATUS] ?? STATUS.unassigned;
}

const STATUS_LABEL: Record<DeskJob['status'], string> = {
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  en_route: 'En route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

type Column = {
  key: SortKey | null;
  label: string;
  width: number | null; // null = flex
  right?: boolean;
};

const COLUMNS: Column[] = [
  { key: 'jobNumber', label: 'Number', width: 140 },
  { key: 'customer', label: 'Customer', width: null },
  { key: null, label: 'Service', width: 128 },
  { key: null, label: 'Technician', width: 122 },
  { key: 'scheduledForMs', label: 'Scheduled', width: 128 },
  { key: null, label: 'Status', width: 116 },
  { key: 'amount', label: 'Amount', width: 100, right: true },
];

function compareJobs(a: DeskJob, b: DeskJob, key: SortKey): number {
  switch (key) {
    case 'amount':
      return a.amount - b.amount;
    case 'scheduledForMs':
      return a.scheduledForMs - b.scheduledForMs;
    case 'jobNumber':
      return a.jobNumber.localeCompare(b.jobNumber);
    case 'customer':
      return a.customer.localeCompare(b.customer);
  }
}

let rowRenders = 0;

/** Throwaway instrumentation — reset between measurement passes. */
export function resetRowRenderCount(): void {
  rowRenders = 0;
}

/** Throwaway instrumentation — how many times any row rendered. */
export function rowRenderCount(): number {
  return rowRenders;
}

const headerStyles = {
  row: {
    flexDirection: 'row' as const,
    height: HEADER_HEIGHT,
    alignItems: 'center' as const,
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  cellLabel: {
    ...textStyle('bodyStrong', 'desk'),
    color: SEMANTIC.text.secondary,
  },
};

function HeaderCell({
  column,
  sort,
  onToggle,
}: {
  column: Column;
  sort: SortState;
  onToggle: (key: SortKey) => void;
}): React.ReactNode {
  const active = column.key !== null && sort.key === column.key;
  const label = (
    <Text
      style={[
        headerStyles.cellLabel,
        column.right === true && { textAlign: 'right' as const },
        active && {
          color: SEMANTIC.text.primary,
          fontWeight: '600' as const,
          fontFamily: resolveFontFamily('sans', '600'),
        },
      ]}
    >
      {column.label}
      {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </Text>
  );
  if (column.key === null) {
    return <View style={{ width: column.width ?? 0 }}>{label}</View>;
  }
  return (
    <Pressable
      testID={`header-sort-${column.key}`}
      accessibilityRole="button"
      accessibilityLabel={`Sort by ${column.label}`}
      onPress={() => onToggle(column.key as SortKey)}
      style={({ pressed }) => [
        { justifyContent: 'center' },
        pressed && { backgroundColor: SEMANTIC.bg.pressed },
      ]}
    >
      {label}
    </Pressable>
  );
}

const rowStyles = {
  row: {
    flexDirection: 'row' as const,
    height: ROW_HEIGHT,
    alignItems: 'center' as const,
    backgroundColor: SEMANTIC.bg.raised,
  },
  zebra: { backgroundColor: SEMANTIC.bg.dense },
  edge: { width: EDGE_WIDTH, height: ROW_HEIGHT },
  cell: { paddingHorizontal: 12, justifyContent: 'center' as const },
  text: { ...textStyle('body', 'desk'), color: SEMANTIC.text.primary },
  secondary: { ...textStyle('body', 'desk'), color: SEMANTIC.text.secondary },
  number: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums' as const],
  },
  amount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums' as const],
    textAlign: 'right' as const,
  },
  status: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
};

/** Memoised: a sort reorders the array but does not mutate the row
 * objects, so carried-over rows must skip re-render entirely — the
 * virtualisation plus the memo is the whole 500-row story. */
const DeskRow = memo(function DeskRow({ job, zebra }: { job: DeskJob; zebra: boolean }): React.ReactNode {
  rowRenders += 1;
  return (
    <Pressable
      style={[rowStyles.row, zebra && rowStyles.zebra]}
      onPress={() => {}}
      accessibilityRole="button"
      accessibilityLabel={`${job.jobNumber} ${job.customer}`}
    >
      <View style={[rowStyles.edge, { backgroundColor: statusColor(job.status) }]} />
      <View style={[rowStyles.cell, { width: 140, paddingLeft: 9 }]}>
        <Text style={rowStyles.number} numberOfLines={1}>
          {job.jobNumber}
        </Text>
      </View>
      <View style={[rowStyles.cell, { flex: 1 }]}>
        <Text style={rowStyles.text} numberOfLines={1}>
          {job.customer}
        </Text>
      </View>
      <View style={[rowStyles.cell, { width: 128 }]}>
        <Text style={rowStyles.secondary} numberOfLines={1}>
          {job.service}
        </Text>
      </View>
      <View style={[rowStyles.cell, { width: 122 }]}>
        <Text style={rowStyles.secondary} numberOfLines={1}>
          {job.technician ?? 'Unassigned'}
        </Text>
      </View>
      <View style={[rowStyles.cell, { width: 128 }]}>
        <Text style={rowStyles.secondary} numberOfLines={1}>
          {job.scheduledLabel}
        </Text>
      </View>
      <View style={[rowStyles.cell, { width: 116 }]}>
        <View style={rowStyles.status}>
          <View style={[rowStyles.dot, { backgroundColor: statusColor(job.status) }]} />
          <Text style={rowStyles.secondary} numberOfLines={1}>
            {STATUS_LABEL[job.status]}
          </Text>
        </View>
      </View>
      <View style={[rowStyles.cell, { width: 100 }]}>
        <Text style={rowStyles.amount}>₹{groupEnIN(String(job.amount))}</Text>
      </View>
    </Pressable>
  );
});

type Item = { type: 'header' } | { type: 'row'; job: DeskJob; index: number };

function itemKey(item: Item): string {
  return item.type === 'header' ? 'header' : item.job.id.toString();
}

function itemType(item: Item): string {
  return item.type;
}

/**
 * Owns the sort state; renders the header item and the virtualised
 * rows. `onSortApplied` lets the shell record the mark (and keeps the
 * measurement out of the component's render path).
 */
export function DataTable({
  data,
  sort,
  onSort,
  scrollTestID,
}: {
  data: DeskJob[];
  sort: SortState;
  onSort: (next: SortState) => void;
  scrollTestID?: string;
}): React.ReactNode {
  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const primary = compareJobs(a, b, sort.key);
      return sort.dir === 'asc' ? primary : -primary;
    });
    return copy;
  }, [data, sort]);

  const items = useMemo<Item[]>(
    () => [{ type: 'header' }, ...sorted.map((job, index) => ({ type: 'row' as const, job, index }))],
    [sorted],
  );

  // Mark the commit that carried a sort's re-order, so the harness can
  // time "pressed → applied" and slice its frame log.
  const firstSort = useRef(true);
  useLayoutEffect(() => {
    if (firstSort.current) {
      firstSort.current = false;
      return;
    }
    performance.mark('spike:sort-applied');
  }, [sorted]);

  const onToggle = useCallback(
    (key: SortKey) => {
      performance.mark(`spike:sort-start:${key}`);
      onSort(
        sort.key === key
          ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'amount' ? 'desc' : 'asc' },
      );
    },
    [sort, onSort],
  );

  const renderItem = useCallback(({ item }: { item: Item }) => {
    if (item.type === 'header') {
      return (
        <View style={headerStyles.row} testID="table-header">
          {COLUMNS.map((column) => (
            <View key={column.label} style={column.width === null ? { flex: 1 } : { width: column.width }}>
              <HeaderCell column={column} sort={sort} onToggle={onToggle} />
            </View>
          ))}
        </View>
      );
    }
    return <DeskRow job={item.job} zebra={item.index % 2 === 1} />;
  }, [sort, onToggle]);

  return (
    <FlashList
      data={items}
      renderItem={renderItem}
      keyExtractor={itemKey}
      getItemType={itemType}
      stickyHeaderIndices={[0]}
      testID={scrollTestID}
    />
  );
}
