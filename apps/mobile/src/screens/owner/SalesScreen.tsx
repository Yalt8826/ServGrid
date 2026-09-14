/**
 * O5 Sales — the owner's list (UI/plan-2/07-OWNER.md §O5). **Phone:**
 * cards — number (mono) · company · rep · date · total · status pill.
 * **Desktop: a table with a running total** — number · company · rep ·
 * date · total · status, the total column `mono` tabular so it scans,
 * the confirmed sum in a totals bar above the table.
 *
 * **Void lives here and only here** — reason required (VoidReasonSheet),
 * owner-only server-side; the rep's screens carry no void surface and
 * these tests hold that line. A draft has nothing to void: the action
 * appears on confirmed cards only — voids already carry their reason.
 *
 * Pure UI over injected data; `useOwnerData` owns the reads.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, EmptyState } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from '../../components/ui';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import { salesRunningTotalOf, sortOwnerSales, type OwnerSaleRow } from './model';
import { VoidReasonSheet } from './VoidReasonSheet';

export interface OwnerSalesScreenProps {
  rows: OwnerSaleRow[];
  error: string | null;
  loading: boolean;
  /** Confirms the void with its reason — the route owns the POST. */
  onVoid: (sale: OwnerSaleRow, reason: string) => void;
  /** The running void: busy flag and error for the open sheet. */
  voidBusy: boolean;
  voidError: string | null;
  onRetry: () => void;
  testID?: string;
}

export const SALE_STATUS_PILL: Record<OwnerSaleRow['status'], { label: string; color: string }> = {
  draft: { label: 'Draft', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

export function OwnerSalesScreen(props: OwnerSalesScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'saleDate', dir: 'desc' });
  const [voidTarget, setVoidTarget] = useState<OwnerSaleRow | null>(null);
  const density = useDensity();
  const desk = density === 'desk';
  const rows = sortOwnerSales(props.rows);
  const nowYear = new Date().getFullYear();
  const running = salesRunningTotalOf(props.rows);

  const openVoid = (row: OwnerSaleRow): void => setVoidTarget(row);

  return (
    <View style={styles.root} testID={props.testID ?? 'owner-sales'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-sales-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No sales yet." testID="owner-sales-empty" />
      ) : desk ? (
        <>
          <View style={styles.totalsBar} testID="owner-sales-running-total">
            <Text style={styles.totalsLabel}>Confirmed total</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(running)}`}</Text>
          </View>
          <DeskTable
            data={rows}
            rowKey={(r) => r.id}
            sort={sort}
            onSort={setSort}
            scrollTestID="owner-sales-table"
            columns={[
              {
                key: 'saleNumber',
                label: 'Number',
                width: 140,
                render: (r) => (
                  <Text style={styles.monoCell} testID={`sale-number-${r.id}`}>
                    {r.saleNumber ?? 'Draft'}
                  </Text>
                ),
                sortValue: (r) => r.saleNumber ?? '',
              },
              {
                key: 'companyName',
                label: 'Company',
                width: null,
                render: (r) => <Text style={styles.cell}>{r.companyName}</Text>,
                sortValue: (r) => r.companyName,
              },
              {
                key: 'repName',
                label: 'Rep',
                width: 120,
                render: (r) => <Text style={styles.cell}>{r.repName ?? '—'}</Text>,
                sortValue: (r) => r.repName ?? '',
              },
              {
                key: 'saleDate',
                label: 'Date',
                width: 96,
                render: (r) => <Text style={styles.monoCell}>{formatDateEnIN(r.saleDate, nowYear)}</Text>,
                sortValue: (r) => r.saleDate,
              },
              {
                key: 'total',
                label: 'Total',
                width: 110,
                align: 'right',
                render: (r) => <Text style={styles.monoCell}>{`₹${formatMoneyEnIN(r.total)}`}</Text>,
                sortValue: (r) => Number(r.total),
              },
              {
                key: 'status',
                label: 'Status',
                width: 90,
                render: (r) => (
                  <Text style={[styles.pill, { color: SALE_STATUS_PILL[r.status].color }]} testID={`sale-status-${r.id}`}>
                    {SALE_STATUS_PILL[r.status].label}
                  </Text>
                ),
                sortValue: (r) => r.status,
              },
              {
                key: 'actions',
                label: '',
                width: 80,
                render: (r) =>
                  r.status === 'confirmed' ? (
                    <Button label="Void" variant="ghost" onPress={() => openVoid(r)} testID={`sale-void-${r.id}`} />
                  ) : null,
              },
            ]}
          />
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.totalsBar} testID="owner-sales-running-total">
            <Text style={styles.totalsLabel}>Confirmed total</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(running)}`}</Text>
          </View>
          {rows.map((row) => {
            const pill = SALE_STATUS_PILL[row.status];
            return (
              <View key={row.id} style={styles.card} testID={`sale-row-${row.id}`}>
                <View style={styles.cardMain}>
                  <View style={styles.numberRow}>
                    <Text style={styles.monoCell} testID={`sale-number-${row.id}`}>
                      {row.saleNumber ?? 'Draft'}
                    </Text>
                    <Text style={[styles.pill, { color: pill.color }]} testID={`sale-status-${row.id}`}>
                      {pill.label}
                    </Text>
                  </View>
                  <Text style={styles.secondary}>{`${row.companyName}${row.repName === null ? '' : ` · ${row.repName}`}`}</Text>
                  <Text style={styles.secondary}>{formatDateEnIN(row.saleDate, nowYear)}</Text>
                </View>
                <View style={styles.cardSide}>
                  <Text style={styles.monoCell}>{`₹${formatMoneyEnIN(row.total)}`}</Text>
                  {row.status === 'confirmed' ? (
                    <Button label="Void" variant="ghost" onPress={() => openVoid(row)} testID={`sale-void-${row.id}`} />
                  ) : null}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <VoidReasonSheet
        visible={voidTarget !== null}
        subject={voidTarget === null ? '' : `Sale ${voidTarget.saleNumber ?? 'Draft'}`}
        amount={voidTarget === null ? null : voidTarget.total}
        busy={props.voidBusy}
        error={props.voidError}
        onConfirm={(reason) => {
          if (voidTarget !== null) props.onVoid(voidTarget, reason);
        }}
        onDismiss={() => setVoidTarget(null)}
        testID="owner-sale-void-sheet"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  totalsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  totalsLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  totalsValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  cardMain: { flex: 1, gap: 2 },
  cardSide: { alignItems: 'flex-end', gap: SPACE[1] },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
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
  secondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  pill: {
    ...textStyle('label'),
  },
});
