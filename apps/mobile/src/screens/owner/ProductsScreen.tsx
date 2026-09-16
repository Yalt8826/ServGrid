/**
 * O8 Products — settings, not work (UI/plan-2/07-OWNER.md §O8). A simple
 * table: SKU · name · category · brand · default price · warranty months
 * · active. **Deactivate rather than delete** — the action is a PATCH of
 * `isActive: false` under `If-Match`, never a removal; the API's read
 * returns active rows (the pickers share it), so a deactivated SKU
 * leaves the table and its records keep citing it.
 *
 * Pure UI over injected data; the route owns the PATCH.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, DeskListShell, EmptyState, Panel, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import { PRODUCT_CATEGORY_LABELS } from './model';
import type { OwnerProductRow } from './model';

export interface OwnerProductsScreenProps {
  rows: OwnerProductRow[];
  error: string | null;
  loading: boolean;
  onDeactivate: (productId: string) => void;
  deactivateBusyId: string | null;
  onRetry: () => void;
  testID?: string;
}

export function OwnerProductsScreen(props: OwnerProductsScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const density = useDensity();
  const desk = density === 'desk';
  const rows = props.rows;

  return (
    <DeskListShell title="Products" subtitle={desk ? `${rows.length} in the catalogue` : undefined} testID={props.testID ?? 'owner-products'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-products-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No products in the catalogue yet." testID="owner-products-empty" />
      ) : desk ? (
        <Panel padded={false} grow>
          <DeskTable
          data={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          scrollTestID="owner-products-table"
          columns={[
            {
              key: 'sku',
              label: 'SKU',
              width: 120,
              render: (r) => (
                <Text style={styles.monoCell} testID={`product-sku-${r.id}`}>
                  {r.sku}
                </Text>
              ),
              sortValue: (r) => r.sku,
            },
            {
              key: 'name',
              label: 'Name',
              width: null,
              render: (r) => <Text style={styles.cell}>{r.name}</Text>,
              sortValue: (r) => r.name,
            },
            {
              key: 'category',
              label: 'Category',
              width: 96,
              render: (r) => <Text style={styles.cell}>{PRODUCT_CATEGORY_LABELS[r.category]}</Text>,
              sortValue: (r) => r.category,
            },
            {
              key: 'brand',
              label: 'Brand',
              width: 110,
              render: (r) => <Text style={styles.cell}>{r.brand ?? '—'}</Text>,
              sortValue: (r) => r.brand ?? '',
            },
            {
              key: 'defaultPrice',
              label: 'Default price',
              width: 110,
              align: 'right',
              render: (r) => <Text style={styles.monoCell}>{r.defaultPrice === null ? '—' : `₹${formatMoneyEnIN(r.defaultPrice)}`}</Text>,
              sortValue: (r) => (r.defaultPrice === null ? -1 : Number(r.defaultPrice)),
            },
            {
              key: 'warrantyMonths',
              label: 'Warranty',
              width: 88,
              align: 'right',
              render: (r) => <Text style={styles.monoCell}>{r.warrantyMonths === null ? '—' : `${r.warrantyMonths} mo`}</Text>,
              sortValue: (r) => (r.warrantyMonths === null ? -1 : r.warrantyMonths),
            },
            {
              key: 'isActive',
              label: 'Active',
              width: 70,
              render: (r) => (
                <Text style={[styles.cell, { color: r.isActive ? SEMANTIC.text.primary : SEMANTIC.text.secondary }]} testID={`product-active-${r.id}`}>
                  {r.isActive ? 'Yes' : 'No'}
                </Text>
              ),
              sortValue: (r) => (r.isActive ? 1 : 0),
            },
            {
              key: 'actions',
              label: '',
              width: 110,
              render: (r) =>
                r.isActive ? (
                  <Button
                    label="Deactivate"
                    variant="ghost"
                    disabled={props.deactivateBusyId === r.id}
                    onPress={() => props.onDeactivate(r.id)}
                    testID={`product-deactivate-${r.id}`}
                  />
                ) : null,
            },
          ]}
        />
        </Panel>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {rows.map((row) => (
            <View key={row.id} style={styles.row} testID={`product-row-${row.id}`}>
              <View style={styles.rowMain}>
                <Text style={styles.cellStrong} testID={`product-sku-${row.id}`}>
                  {row.sku}
                </Text>
                <Text style={styles.cell}>
                  {`${row.name} · ${PRODUCT_CATEGORY_LABELS[row.category]}`}
                  {row.brand === null ? '' : ` · ${row.brand}`}
                </Text>
                <Text style={styles.secondary}>
                  {`${row.defaultPrice === null ? 'No default price' : `₹${formatMoneyEnIN(row.defaultPrice)}`}${
                    row.warrantyMonths === null ? '' : ` · ${row.warrantyMonths} mo warranty`
                  }`}
                </Text>
              </View>
              {row.isActive ? (
                <Button
                  label="Deactivate"
                  variant="ghost"
                  disabled={props.deactivateBusyId === row.id}
                  onPress={() => props.onDeactivate(row.id)}
                  testID={`product-deactivate-${row.id}`}
                />
              ) : (
                <Text style={styles.inactive} testID={`product-active-${row.id}`}>
                  Deactivated
                </Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </DeskListShell>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  rowMain: { flex: 1, gap: 2 },
  cell: {
    ...textStyle('body', 'desk'),
    color: SEMANTIC.text.primary,
  },
  cellStrong: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  monoCell: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  secondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  inactive: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
});
