/**
 * DeskTable — the NATIVE counterpart of the desk seam (deskTable.web.tsx
 * is the one Metro resolves on web). The owner's phone presentation is
 * cards (07-OWNER.md: "the same job is a card on a phone and a table row
 * on desktop"), so desk density never occurs on the handset — NavShell
 * sets `desk` only on the web build ≥1024px. This file exists so the
 * module graph on native carries no web table (PLAN-FRONTEND.md §8:
 * `DataTable` never bundles into the APK) while keeping the seam's
 * contract honest off the web too: a small View-based table with the
 * same sortable headers, no virtualisation — a list the owner's phone
 * would only hit in a context that does not exist today.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface DeskTableColumn<T> {
  key: string;
  label: string;
  /** Fixed dp width, or null to take the remaining space (one per table). */
  width: number | null;
  align?: 'left' | 'right';
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
}

export interface DeskTableProps<T> {
  data: readonly T[];
  columns: readonly DeskTableColumn<T>[];
  rowKey: (row: T) => string;
  sort: SortState;
  onSort: (next: SortState) => void;
  edgeColor?: (row: T) => string | null;
  onRowPress?: (row: T) => void;
  scrollTestID?: string;
}

export function DeskTable<T>({ data, columns, rowKey, sort, onSort, edgeColor, onRowPress, scrollTestID }: DeskTableProps<T>): React.ReactNode {
  const column = columns.find((c) => c.key === sort.key);
  const value = column?.sortValue;
  const sorted =
    value === undefined
      ? [...data]
      : [...data].sort((a, b) => {
          const va = value(a);
          const vb = value(b);
          const primary =
            typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
          return sort.dir === 'asc' ? primary : -primary;
        });
  return (
    <ScrollView testID={scrollTestID} style={styles.ground}>
      <View style={styles.header} testID="table-header">
        {columns.map((c) => {
          const active = c.sortValue !== undefined && sort.key === c.key;
          const label = (
            <Text
              style={[
                styles.headerLabel,
                c.align === 'right' && { textAlign: 'right' as const },
                active && styles.headerLabelActive,
              ]}
            >
              {c.label}
              {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </Text>
          );
          const shell = c.width === null ? styles.flexCell : fixedCell(c.width);
          if (c.sortValue === undefined) return <View key={c.key} style={shell}>{label}</View>;
          return (
            <Pressable
              key={c.key}
              testID={`header-sort-${c.key}`}
              accessibilityRole="button"
              accessibilityLabel={`Sort by ${c.label}`}
              onPress={() =>
                onSort(
                  sort.key === c.key
                    ? { key: c.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
                    : { key: c.key, dir: 'asc' },
                )
              }
              style={shell}
            >
              {label}
            </Pressable>
          );
        })}
      </View>
      {sorted.map((row, index) => {
        const edge = edgeColor?.(row) ?? null;
        return (
          <Pressable
            key={rowKey(row)}
            testID={`data-row-${rowKey(row)}`}
            accessibilityRole={onRowPress !== undefined ? 'button' : undefined}
            onPress={onRowPress !== undefined ? () => onRowPress(row) : undefined}
            style={[styles.row, index % 2 === 1 && styles.zebra]}
          >
            {edgeColor !== undefined ? (
              <View style={{ width: 4, height: 40, backgroundColor: edge ?? 'transparent' }} />
            ) : null}
            {columns.map((c, i) => (
              <View
                key={c.key}
                style={[
                  styles.cell,
                  c.align === 'right' && { alignItems: 'flex-end' as const },
                  c.width === null ? styles.flexCell : fixedCell(c.width),
                  edgeColor !== undefined && i === 0 && styles.firstWithEdge,
                ]}
              >
                {c.render(row)}
              </View>
            ))}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  ground: { backgroundColor: SEMANTIC.bg.raised },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  headerLabel: { ...textStyle('bodyStrong', 'desk'), color: SEMANTIC.text.secondary },
  headerLabelActive: { color: SEMANTIC.text.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
  },
  zebra: { backgroundColor: SEMANTIC.bg.dense },
  cell: { paddingHorizontal: 12, justifyContent: 'center' },
  firstWithEdge: { paddingLeft: 8 },
  flexCell: { flex: 1 },
});

/** Fixed-width cell — a plain helper, not a StyleSheet entry: styles are
 * objects, and a function value in `StyleSheet.create` is invalid. */
const fixedCell = (width: number): { width: number } => ({ width });
