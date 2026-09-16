/**
 * O5 Payments — the owner's list (UI/plan-2/07-OWNER.md §O5). Phone
 * cards, desktop table with a running total — number · company ·
 * collector · date · mode · amount · status. **Void lives here and only
 * here** (with sales): reason required, on confirmed payments; a voided
 * payment keeps its row, its Void pill and its reason in the record.
 *
 * Pure UI over injected data; `useOwnerData` owns the reads.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, EmptyState, useDensity } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import { PaymentProofSheet, type PreviewSubject } from './ledgerPreviews';
import { paymentsRunningTotalOf, sortOwnerPayments, type OwnerPaymentRow } from './model';
import type { PaymentProof } from './useOwnerData';
import { VoidReasonSheet } from './VoidReasonSheet';

export interface OwnerPaymentsScreenProps {
  rows: OwnerPaymentRow[];
  error: string | null;
  loading: boolean;
  onVoid: (payment: OwnerPaymentRow, reason: string) => void;
  voidBusy: boolean;
  voidError: string | null;
  onRetry: () => void;
  /** A row, pressed — resolves the collection's proof photo for the preview. */
  onLoadPaymentProof: (paymentId: string) => Promise<PaymentProof | null>;
  testID?: string;
}

export const PAYMENT_STATUS_PILL: Record<OwnerPaymentRow['status'], { label: string; color: string }> = {
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

export function OwnerPaymentsScreen(props: OwnerPaymentsScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'businessDate', dir: 'desc' });
  const [voidTarget, setVoidTarget] = useState<OwnerPaymentRow | null>(null);
  // One state: which row is previewing. The sheet owns its own read.
  const [preview, setPreview] = useState<PreviewSubject | null>(null);
  const density = useDensity();
  const desk = density === 'desk';
  const rows = sortOwnerPayments(props.rows);
  const nowYear = new Date().getFullYear();
  const running = paymentsRunningTotalOf(props.rows);

  const openVoid = (row: OwnerPaymentRow): void => setVoidTarget(row);

  return (
    <View style={styles.root} testID={props.testID ?? 'owner-payments'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-payments-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No payments yet." testID="owner-payments-empty" />
      ) : desk ? (
        <>
          <View style={styles.totalsBar} testID="owner-payments-running-total">
            <Text style={styles.totalsLabel}>Collected total</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(running)}`}</Text>
          </View>
          <DeskTable
            data={rows}
            rowKey={(r) => r.id}
            sort={sort}
            onSort={setSort}
            scrollTestID="owner-payments-table"
            // The row IS the door to its proof photo (owner, 2026-09-17),
            // the same preview the company ledger's payment rows open.
            onRowPress={(r) => setPreview({ id: r.id, number: r.paymentNumber })}
            columns={[
              {
                key: 'paymentNumber',
                label: 'Number',
                width: 140,
                render: (r) => (
                  <Text numberOfLines={1} style={styles.monoCell} testID={`payment-number-${r.id}`}>
                    {r.paymentNumber}
                  </Text>
                ),
                sortValue: (r) => r.paymentNumber,
              },
              {
                key: 'companyName',
                label: 'Company',
                width: null,
                render: (r) => <Text style={styles.cell} numberOfLines={1}>{r.companyName}</Text>,
                sortValue: (r) => r.companyName,
              },
              {
                key: 'repName',
                label: 'Collected by',
                width: 120,
                render: (r) => <Text numberOfLines={1} style={styles.cell}>{r.repName ?? '—'}</Text>,
                sortValue: (r) => r.repName ?? '',
              },
              {
                key: 'businessDate',
                label: 'Date',
                width: 96,
                render: (r) => <Text numberOfLines={1} style={styles.monoCell}>{formatDateEnIN(r.businessDate, nowYear)}</Text>,
                sortValue: (r) => r.businessDate,
              },
              {
                key: 'mode',
                label: 'Mode',
                width: 90,
                render: (r) => <Text numberOfLines={1} style={styles.cell}>{r.mode}</Text>,
                sortValue: (r) => r.mode,
              },
              {
                key: 'amount',
                label: 'Amount',
                width: 110,
                align: 'right',
                render: (r) => <Text numberOfLines={1} style={styles.monoCell}>{`₹${formatMoneyEnIN(r.amount)}`}</Text>,
                sortValue: (r) => Number(r.amount),
              },
              {
                key: 'status',
                label: 'Status',
                width: 96,
                render: (r) => (
                  <Text numberOfLines={1} style={[styles.pill, { color: PAYMENT_STATUS_PILL[r.status].color }]} testID={`payment-status-${r.id}`}>
                    {PAYMENT_STATUS_PILL[r.status].label}
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
                    <Button label="Void" variant="ghost" onPress={() => openVoid(r)} testID={`payment-void-${r.id}`} />
                  ) : null,
              },
            ]}
          />
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.totalsBar} testID="owner-payments-running-total">
            <Text style={styles.totalsLabel}>Collected total</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(running)}`}</Text>
          </View>
          {rows.map((row) => {
            const pill = PAYMENT_STATUS_PILL[row.status];
            return (
              <View key={row.id} style={styles.card} testID={`payment-row-${row.id}`}>
                <View style={styles.cardMain}>
                  <View style={styles.numberRow}>
                    <Text style={styles.monoCell} testID={`payment-number-${row.id}`}>
                      {row.paymentNumber}
                    </Text>
                    <Text style={[styles.pill, { color: pill.color }]} testID={`payment-status-${row.id}`}>
                      {pill.label}
                    </Text>
                  </View>
                  <Text style={styles.secondary}>{`${row.companyName}${row.repName === null ? '' : ` · ${row.repName}`}`}</Text>
                  <Text style={styles.secondary}>{`${formatDateEnIN(row.businessDate, nowYear)} · ${row.mode}`}</Text>
                </View>
                <View style={styles.cardSide}>
                  <Text style={styles.monoCell}>{`₹${formatMoneyEnIN(row.amount)}`}</Text>
                  {row.status === 'confirmed' ? (
                    <Button label="Void" variant="ghost" onPress={() => openVoid(row)} testID={`payment-void-${row.id}`} />
                  ) : null}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <PaymentProofSheet
        payment={preview}
        onLoad={props.onLoadPaymentProof}
        onDismiss={() => setPreview(null)}
        testID="owner-payments-proof-sheet"
      />

      <VoidReasonSheet
        visible={voidTarget !== null}
        subject={voidTarget === null ? '' : `Payment ${voidTarget.paymentNumber}`}
        amount={voidTarget === null ? null : voidTarget.amount}
        busy={props.voidBusy}
        error={props.voidError}
        onConfirm={(reason) => {
          if (voidTarget !== null) props.onVoid(voidTarget, reason);
        }}
        onDismiss={() => setVoidTarget(null)}
        testID="owner-payment-void-sheet"
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
