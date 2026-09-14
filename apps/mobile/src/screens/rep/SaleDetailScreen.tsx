/**
 * Sale detail (§S2 read side, field feedback 2026-09-14): everything the
 * rep sold on one card — the line items with their discounted unit
 * prices, the serials, the notes, and where the money stands (draft,
 * confirmed, void with its reason). Pure over injected data; the route
 * owns the reads, like the rest of the rep module.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SaleRecord } from '@servgrid/shared';
import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { formatDateEnIN } from '../../components/ui';

export const SALE_DETAIL_STATUS: Record<SaleRecord['status'], { label: string; color: string }> = {
  draft: { label: 'Draft', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

export interface SaleDetailScreenProps {
  sale: SaleRecord | null;
  companyName: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  testID?: string;
}

export function SaleDetailScreen(props: SaleDetailScreenProps): React.ReactNode {
  if (props.loading) {
    return (
      <View style={styles.center} testID="sale-detail-loading">
        <Text style={styles.secondary}>Loading…</Text>
      </View>
    );
  }
  if (props.error !== null || props.sale === null) {
    return (
      <View style={styles.center} testID="sale-detail-missing">
        <Text style={styles.secondary}>
          {props.error ?? "We couldn't find that sale — it may be on another rep's accounts."}
        </Text>
      </View>
    );
  }

  const sale = props.sale;
  const pill = SALE_DETAIL_STATUS[sale.status];

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'sale-detail'}>
      <Text style={styles.heading} testID="sale-detail-title">
        {sale.saleNumber ?? 'Draft sale'}
      </Text>
      <Text style={[styles.statusPill, { color: pill.color }]} testID="sale-detail-status">
        {pill.label}
      </Text>

      <View style={styles.block}>
        <Text style={styles.fieldLabel}>Company</Text>
        <Text style={styles.primary}>{props.companyName ?? '—'}</Text>
        <Text style={styles.secondary}>{`Sale date ${formatDateEnIN(sale.saleDate, new Date().getFullYear())}`}</Text>
        {sale.confirmedAt !== null ? <Text style={styles.secondary}>Confirmed on record</Text> : null}
        {sale.voidReason !== null ? (
          <Text style={[styles.secondary, { color: SEMANTIC.feedback.danger }]}>{`Voided — ${sale.voidReason}`}</Text>
        ) : null}
      </View>

      <Text style={styles.sectionLabel}>ITEMS</Text>
      {sale.items.map((item) => (
        <View key={item.lineNo} style={styles.line} testID={`sale-detail-line-${item.lineNo}`}>
          <View style={styles.lineHead}>
            <Text style={styles.primary}>{item.productName}</Text>
            <Text style={styles.amount}>{`₹${formatMoneyEnIN(item.lineTotal)}`}</Text>
          </View>
          <Text style={styles.secondary}>
            {`${item.productSku ? `${item.productSku} · ` : ''}${item.quantity} × ₹${formatMoneyEnIN(item.unitPrice)}`}
          </Text>
          {item.serialNumbers.length > 0 ? (
            <Text style={styles.secondary}>{`Serials: ${item.serialNumbers.join(', ')}`}</Text>
          ) : null}
        </View>
      ))}

      <View style={styles.totalRow} testID="sale-detail-total">
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{`₹${formatMoneyEnIN(sale.total)}`}</Text>
      </View>

      {sale.notes !== null ? (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>Notes</Text>
          <Text style={styles.secondary}>{sale.notes}</Text>
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
  sectionLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginTop: SPACE[2] },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 2 },
  primary: { ...textStyle('body'), color: SEMANTIC.text.primary },
  secondary: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  amount: { ...textStyle('body'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  block: { gap: 2 },
  line: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 8,
    padding: SPACE[3],
    gap: 2,
  },
  lineHead: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACE[3] },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    paddingTop: SPACE[3],
  },
  totalLabel: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  totalValue: { ...textStyle('h2'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
});
