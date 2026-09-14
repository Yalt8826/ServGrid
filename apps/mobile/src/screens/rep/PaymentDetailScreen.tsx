/**
 * Payment detail (§S3 read side, field feedback 2026-09-14): the way the
 * money moved — number, company, amount, mode, the day and moment it was
 * collected, which sale it settled (or on-account), status and notes.
 * Pure over injected data; the route owns the reads.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PaymentRecord } from '@servgrid/shared';
import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { formatDateEnIN } from '../../components/ui';

export const PAYMENT_DETAIL_MODE_LABEL: Record<PaymentRecord['mode'], string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
};

export const PAYMENT_DETAIL_STATUS: Record<PaymentRecord['status'], { label: string; color: string }> = {
  collected: { label: 'Collected', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

export interface PaymentDetailScreenProps {
  payment: PaymentRecord | null;
  companyName: string | null;
  /** The settled sale's number, resolved by the route; null = on account. */
  againstSaleNumber: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  testID?: string;
}

function Row({ label, value, testID }: { label: string; value: string; testID?: string }): React.ReactNode {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function PaymentDetailScreen(props: PaymentDetailScreenProps): React.ReactNode {
  if (props.loading) {
    return (
      <View style={styles.center} testID="payment-detail-loading">
        <Text style={styles.secondary}>Loading…</Text>
      </View>
    );
  }
  if (props.error !== null || props.payment === null) {
    return (
      <View style={styles.center} testID="payment-detail-missing">
        <Text style={styles.secondary}>
          {props.error ?? "We couldn't find that payment — it may be on another rep's accounts."}
        </Text>
      </View>
    );
  }

  const payment = props.payment;
  const status = PAYMENT_DETAIL_STATUS[payment.status];

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'payment-detail'}>
      <Text style={styles.heading} testID="payment-detail-title">
        {payment.paymentNumber}
      </Text>
      <Text style={[styles.statusPill, { color: status.color }]} testID="payment-detail-status">
        {status.label}
      </Text>

      <View style={styles.amountCard} testID="payment-detail-amount-card">
        <Text style={styles.amountValue}>{`₹${formatMoneyEnIN(payment.amount)}`}</Text>
        <Text style={styles.amountMeta}>
          {`${PAYMENT_DETAIL_MODE_LABEL[payment.mode]} · ${formatDateEnIN(payment.businessDate, new Date().getFullYear())}`}
        </Text>
      </View>

      <View style={styles.block}>
        <Row label="Company" value={props.companyName ?? '—'} testID="payment-detail-company" />
        <Row
          label="Against"
          value={props.againstSaleNumber ?? 'On account'}
          testID="payment-detail-against"
        />
        <Row label="Collected at" value={new Date(payment.receivedAt).toLocaleString('en-IN')} testID="payment-detail-collected-at" />
        {payment.referenceNo !== null ? <Row label="Reference" value={payment.referenceNo} /> : null}
      </View>

      {payment.notes !== null ? (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>Notes</Text>
          <Text style={styles.secondary}>{payment.notes}</Text>
        </View>
      ) : null}

      {payment.voidReason !== null ? (
        <View style={styles.block}>
          <Text style={[styles.fieldLabel, { color: SEMANTIC.feedback.danger }]}>Voided</Text>
          <Text style={styles.secondary}>{payment.voidReason}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: SEMANTIC.bg.app },
  content: { padding: SPACE[4], gap: SPACE[3], backgroundColor: SEMANTIC.bg.app },
  heading: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  statusPill: { ...textStyle('label'), alignSelf: 'flex-start' },
  amountCard: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 12,
    padding: SPACE[4],
    gap: 2,
  },
  amountValue: { ...textStyle('h1'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  amountMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  block: { gap: SPACE[2] },
  row: { gap: 1 },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  rowValue: { ...textStyle('body'), color: SEMANTIC.text.primary },
  secondary: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
});
