/**
 * Sale detail (§S2 read side, field feedback 2026-09-14): everything the
 * rep sold on one card — the line items with their discounted unit
 * prices, the serials, the notes, and where the money stands (draft,
 * confirmed, void with its reason). Pure over injected data; the route
 * owns the reads, like the rest of the rep module.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SaleRecord } from '@servgrid/shared';
import { alpha, formatMoneyEnIN, FRAME, RADII, SEMANTIC, SPACE, TINT } from '@servgrid/shared';
import { SectionHeader } from '../../components/ui';
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

/** " · list ₹8,400 · 10% off" when the line kept its discount (migration 019);
 * nothing for a typed price or a line recorded before discounts were kept. */
export function discountNoteOf(item: { listPrice: string | null; discountPct: string | null }): string {
  if (item.listPrice === null || item.discountPct === null || Number(item.discountPct) === 0) return '';
  return ` · list ₹${formatMoneyEnIN(item.listPrice)} · ${Number(item.discountPct)}% off`;
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'sale-detail'}>
      {/* The navy bar: the sale's own number, and its state as the chip the
          list uses (2026-09-18). */}
      <View style={styles.frame}>
        <View style={styles.frameBody}>
          <Text style={styles.frameTitle} testID="sale-detail-title">
            {sale.saleNumber ?? 'Draft sale'}
          </Text>
          <Text style={styles.frameCaption}>{`Sale date ${formatDateEnIN(sale.saleDate, new Date().getFullYear())}`}</Text>
        </View>
        <View style={[styles.statusChip, { borderColor: alpha(pill.color, TINT.chipLine), backgroundColor: FRAME.text }]}>
          <View style={[styles.statusDot, { backgroundColor: pill.color }]} />
          <Text style={styles.statusWord} testID="sale-detail-status">
            {pill.label}
          </Text>
        </View>
      </View>

      <View style={styles.sectionWrap}>
        <SectionHeader label="Company" icon="business" />
      </View>
      <View style={styles.panel} testID="sale-detail-company">
        <Text style={styles.primary}>{props.companyName ?? '—'}</Text>
        {sale.confirmedAt !== null ? <Text style={styles.secondary}>Confirmed on record</Text> : null}
        {sale.voidReason !== null ? (
          <Text style={[styles.secondary, { color: SEMANTIC.feedback.danger }]}>{`Voided — ${sale.voidReason}`}</Text>
        ) : null}
      </View>

      <View style={styles.sectionWrap}>
        <SectionHeader label="Items" icon="cube" count={sale.items.length} />
      </View>
      {sale.items.map((item) => (
        <View key={item.lineNo} style={styles.line} testID={`sale-detail-line-${item.lineNo}`}>
          <View style={styles.lineHead}>
            <Text style={styles.primary}>{item.productName}</Text>
            <Text style={styles.amount}>{`₹${formatMoneyEnIN(item.lineTotal)}`}</Text>
          </View>
          <Text style={styles.secondary}>
            {`${item.productSku ? `${item.productSku} · ` : ''}${item.quantity} × ₹${formatMoneyEnIN(item.unitPrice)}${discountNoteOf(item)}`}
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

      {sale.notes === null ? null : (
        <>
          <View style={styles.sectionWrap}>
            <SectionHeader label="Notes" icon="document" />
          </View>
          <View style={styles.panel}>
            <Text style={styles.secondary}>{sale.notes}</Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: SEMANTIC.bg.app },
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { backgroundColor: SEMANTIC.bg.app },
  content: { paddingBottom: SPACE[8] },
  /** The navy bar: the sale's number, the date, and the state chip. */
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[3],
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    marginBottom: SPACE[4],
  },
  frameBody: { flex: 1, gap: 2 },
  frameTitle: { ...textStyle('h2'), color: FRAME.text, fontVariant: ['tabular-nums'] },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** The chip on the frame takes the frame's solid light ground. */
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[2],
    paddingVertical: 3,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusWord: { ...textStyle('label'), color: SEMANTIC.text.primary },
  /** A section's panel, inside the page's gutters. */
  panel: {
    marginHorizontal: SPACE[4],
    marginTop: SPACE[3],
    padding: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    gap: 2,
  },
  /** Every marker sits inside the page's gutters, not on its edge. */
  sectionWrap: { paddingHorizontal: SPACE[4] },
  primary: { ...textStyle('body'), color: SEMANTIC.text.primary },
  secondary: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  amount: { ...textStyle('body'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  line: {
    marginHorizontal: SPACE[4],
    marginTop: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    padding: SPACE[3],
    gap: 2,
  },
  lineHead: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACE[3] },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: SPACE[4],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    marginTop: SPACE[4],
    paddingTop: SPACE[3],
  },
  totalLabel: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  totalValue: { ...textStyle('h2'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
});
