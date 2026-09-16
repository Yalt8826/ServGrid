/**
 * DataTable (T4.7, PLAN-FRONTEND.md §8, UI/plan-2/07-OWNER.md §O4) — the
 * owner's desktop list. **Web only by file**: Metro resolves this module
 * for the web platform alone; `DataTable.test.tsx` proves through Metro's
 * platform-resolution order that no native counterpart exists, so the
 * component is never bundled into the APK (PLAN-FRONTEND.md §8 —
 * "`DataTable` and the map have no native counterpart").
 *
 * The rule the component exists for (PLAN-FRONTEND.md §7, 07-OWNER.md):
 * *the same job is a card on a phone and a table row on desktop* — rows,
 * sortable columns and a scannable left edge, not a card grid. Every row
 * carries the status colour on its 4px leading edge, the same rail the
 * phone's JobCard wears, which is what makes the card and the row read as
 * one object at two densities. Per 01-FOUNDATIONS.md §1.6 the two rails
 * below the 3:1 non-text floor (`in_progress`, `en_route`) carry a 1px
 * `slate.900` outer edge on the leading side at desk density — at 40pt
 * rows the rail is the only thing separating two pale yellows in a long
 * list — and §1.6's other rule stands: a rail never appears without its
 * word, so the consumer's columns render the status word beside it.
 *
 * Density is `desk` by construction (NavShell sets it for the whole
 * shell): 40pt rows, 36pt targets, 14px body. Cell text styles are the
 * consumer's — columns render through `textStyle` themselves; money and
 * numbers use the `mono` token so `tabular-nums` keeps the columns
 * aligned (01-FOUNDATIONS.md §2.1).
 *
 * Virtualisation is FlashList's own, with the header as item 0 riding
 * `stickyHeaderIndices` — the exact arrangement the T4.1 spike measured
 * holding a pinned header to scrollTop ≈ 19,000px at 0 dropped frames in
 * Chrome and Firefox (`spikes/rnw-desktop/VERDICT.md` §2) — whose
 * verdict, "RNW carries the DataTable and the rail", this component lands.
 *
 * The row component is memoised and keyed by the row object, and the
 * zebra stripe is applied by a host wrapper OUTSIDE that memo: a sort
 * reorders rows without mutating them, so the reconciler moves the
 * mounted rows and re-renders only what its parity flipped (on the real
 * list, only the virtualised window — 40–51 of 500 in the spike's
 * measurement). A sort never re-renders the world.
 */
import { memo, useCallback, useMemo } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, Text, View } from 'react-native';

import { DENSITY, SEMANTIC, STATUS } from '@servgrid/shared';
import { resolveFontFamily, textStyle } from '../../fonts/textStyle';

export interface SortState {
  /** The sorted column's `key`. */
  key: string;
  dir: 'asc' | 'desc';
}

export interface DataTableColumn<T> {
  /** Stable identifier; also the key a sort state names. */
  key: string;
  label: string;
  /** Fixed dp width, or null to take the remaining space (one per table). */
  width: number | null;
  align?: 'left' | 'right';
  /** The cell. Numbers render through the `mono` token — tabular figures. */
  render: (row: T) => React.ReactNode;
  /** Presence makes the column sortable; supplies the compared value. */
  sortValue?: (row: T) => string | number;
}

export interface DataTableProps<T> {
  data: readonly T[];
  columns: readonly DataTableColumn<T>[];
  /** Stable row identity — the list key and the row's testID. */
  rowKey: (row: T) => string;
  sort: SortState;
  onSort: (next: SortState) => void;
  /**
   * The leading-edge rail colour — the shared STATUS map, never an ad-hoc
   * hex. `null` renders an uncoloured edge so rows without a status stay
   * aligned; omit the prop entirely for tables that carry no rail.
   */
  edgeColor?: (row: T) => string | null;
  onRowPress?: (row: T) => void;
  rowAccessibilityLabel?: (row: T) => string;
  scrollTestID?: string;
  /**
   * Bound the list's height so a long table scrolls INSIDE its card
   * instead of stretching the page (the dashboard's attention feed ran
   * ~80 rows tall and left the charts column a blank half-page). Short
   * tables hug their content — the bound only bites when the rows pass
   * it, which is also what keeps FlashList's windowing honest.
   */
  maxHeight?: number;
}

const ROW_HEIGHT = DENSITY.desk.rowHeight; // 40 — desk density (§3.3)
const HEADER_HEIGHT = ROW_HEIGHT;
const EDGE_WIDTH = 4; // the status rail — same width the phone's JobCard wears

/**
 * A column that flexes never disappears entirely: when the fixed columns
 * outgrow the container (a side detail squeezing the page, a narrow
 * panel), flexGrow alone collapses the flex cell to zero width and the
 * table reads as a row of clipped fragments — the "cut off" console the
 * owner walked us to. The floor keeps a sliver of the row identifiable;
 * `overflow: hidden` on the row contains whatever still spills.
 */
const FLEX_CELL_MIN_WIDTH = 48;


/** §1.6: the two rails below the 3:1 non-text floor against the light
 * grounds. They — and only they — get the 1px slate.900 outer edge. */
const RAILS_NEEDING_OUTER_EDGE = new Set<string>([STATUS.in_progress, STATUS.en_route]);

type Item<T> = { type: 'header' } | { type: 'row'; row: T; index: number };

interface RowProps<T> {
  row: T;
  columns: readonly DataTableColumn<T>[];
  edgeColor: ((row: T) => string | null) | undefined;
  onRowPress: ((row: T) => void) | undefined;
  rowKey: (row: T) => string;
  rowAccessibilityLabel: ((row: T) => string) | undefined;
}

const rowStyles = {
  row: {
    flexDirection: 'row' as const,
    height: ROW_HEIGHT,
    alignItems: 'center' as const,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden' as const,
  },
  edgeGround: {
    // §1.6 — the 1px slate.900 outer edge on the leading side, for the
    // rails that cannot carry the colour alone at this density.
    borderLeftWidth: 1,
    borderLeftColor: SEMANTIC.line.focus,
  },
  cell: { paddingHorizontal: 12, justifyContent: 'center' as const, overflow: 'hidden' as const },
  fixedCell: { flexShrink: 0 as const },
  flexCell: { flex: 1 as const, minWidth: FLEX_CELL_MIN_WIDTH },
  firstCellWithEdge: { paddingLeft: 8 }, // 12 minus the 4px rail
};

/** Memoised on the row object: a sort reorders the array without
 * mutating the rows, so carried-over rows skip re-render entirely —
 * the memo (with the virtualised window on the device) is the whole
 * 500-row story. The zebra wrapper lives OUTSIDE this component so a
 * parity flip repaints a host view, not the row. */
function RowInner<T>({ row, columns, edgeColor, onRowPress, rowKey, rowAccessibilityLabel }: RowProps<T>): React.ReactNode {
  const edge = edgeColor !== undefined ? edgeColor(row) : undefined;
  const cells = columns.map((column, index) => (
    <View
      key={column.key}
      style={[
        rowStyles.cell,
        column.width === null ? rowStyles.flexCell : { width: column.width, ...rowStyles.fixedCell },
        edge !== undefined && index === 0 && rowStyles.firstCellWithEdge,
      ]}
    >
      {column.render(row)}
    </View>
  ));
  const children =
    edge !== undefined ? (
      [
        <View
          key="edge"
          style={[
            { width: EDGE_WIDTH, height: ROW_HEIGHT, backgroundColor: edge ?? 'transparent' },
            edge !== null && RAILS_NEEDING_OUTER_EDGE.has(edge) ? rowStyles.edgeGround : null,
          ]}
        />,
        ...cells,
      ]
    ) : (
      cells
    );
  return (
    <Pressable
      testID={`data-row-${rowKey(row)}`}
      accessibilityRole={onRowPress !== undefined ? 'button' : undefined}
      accessibilityLabel={rowAccessibilityLabel !== undefined ? rowAccessibilityLabel(row) : undefined}
      onPress={onRowPress !== undefined ? () => onRowPress(row) : undefined}
      style={rowStyles.row}
    >
      {children}
    </Pressable>
  );
}

/** `memo` is not generic; the cast restores row-type inference at the
 * call site while keeping the shallow-props bail-out. */
const Row = memo(RowInner) as typeof RowInner;

const headerStyles = {
  row: {
    flexDirection: 'row' as const,
    height: HEADER_HEIGHT,
    alignItems: 'center' as const,
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    overflow: 'hidden' as const,
  },
  cell: { paddingHorizontal: 12, justifyContent: 'center' as const, overflow: 'hidden' as const },
  cellLabel: {
    ...textStyle('bodyStrong', 'desk'),
    color: SEMANTIC.text.secondary,
  },
  cellLabelActive: {
    color: SEMANTIC.text.primary,
    fontWeight: '600' as const,
    fontFamily: resolveFontFamily('sans', '600'),
  },
};

function HeaderCell<T>({
  column,
  sort,
  onSort,
}: {
  column: DataTableColumn<T>;
  sort: SortState;
  onSort: (next: SortState) => void;
}): React.ReactNode {
  const active = column.sortValue !== undefined && sort.key === column.key;
  const label = (
    <Text
      numberOfLines={1}
      style={[
        headerStyles.cellLabel,
        column.align === 'right' && { textAlign: 'right' as const },
        active && headerStyles.cellLabelActive,
      ]}
    >
      {column.label}
      {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </Text>
  );
  if (column.sortValue === undefined) {
    return (
      <View style={[headerStyles.cell, column.width === null ? rowStyles.flexCell : { width: column.width, ...rowStyles.fixedCell }]}>
        {label}
      </View>
    );
  }
  return (
    <Pressable
      testID={`header-sort-${column.key}`}
      accessibilityRole="button"
      accessibilityLabel={`Sort by ${column.label}`}
      onPress={() =>
        onSort(
          sort.key === column.key
            ? { key: column.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key: column.key, dir: 'asc' },
        )
      }
      style={({ pressed }) => [
        headerStyles.cell,
        { justifyContent: 'center' },
        column.width === null ? rowStyles.flexCell : { width: column.width, ...rowStyles.fixedCell },
        pressed && { backgroundColor: SEMANTIC.bg.pressed },
      ]}
    >
      {label}
    </Pressable>
  );
}

export function DataTable<T>({
  data,
  columns,
  rowKey,
  sort,
  onSort,
  edgeColor,
  onRowPress,
  rowAccessibilityLabel,
  scrollTestID,
  maxHeight,
}: DataTableProps<T>): React.ReactNode {
  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort.key);
    const value = column?.sortValue;
    if (value === undefined) return [...data];
    const copy = [...data];
    copy.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const primary =
        typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? primary : -primary;
    });
    return copy;
  }, [data, columns, sort]);

  const items = useMemo<Item<T>[]>(
    () => [{ type: 'header' }, ...sorted.map((row, index) => ({ type: 'row' as const, row, index }))],
    [sorted],
  );

  const keyExtractor = useCallback((item: Item<T>): string => (item.type === 'header' ? 'header' : rowKey(item.row)), [rowKey]);
  const itemType = useCallback((item: Item<T>): string => item.type, []);

  const renderItem = useCallback(
    ({ item }: { item: Item<T> }) => {
      if (item.type === 'header') {
        return (
          <View style={headerStyles.row} testID="table-header">
            {columns.map((column) => (
              <HeaderCell key={column.key} column={column} sort={sort} onSort={onSort} />
            ))}
          </View>
        );
      }
      // The zebra stripe (slate.100, §O4) is applied by this host
      // wrapper, deliberately outside the memoised Row: a sort flips
      // parity for roughly half the rows, and the flip must repaint a
      // host view — not re-run a single row body.
      const zebra = item.index % 2 === 1;
      return (
        <View style={zebra ? { backgroundColor: SEMANTIC.bg.dense } : null}>
          <Row
            row={item.row}
            columns={columns}
            edgeColor={edgeColor}
            onRowPress={onRowPress}
            rowKey={rowKey}
            rowAccessibilityLabel={rowAccessibilityLabel}
          />
        </View>
      );
    },
    [columns, sort, onSort, edgeColor, onRowPress, rowKey, rowAccessibilityLabel],
  );

  return (
    <FlashList
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemType={itemType}
      stickyHeaderIndices={[0]}
      testID={scrollTestID}
      style={maxHeight === undefined ? undefined : { maxHeight }}
    />
  );
}
