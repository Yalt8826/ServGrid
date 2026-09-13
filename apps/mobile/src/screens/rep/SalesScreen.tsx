/**
 * S2 Sales — the list (UI/plan-2/06-SALES-REP.md §S2). Rows: sale number
 * (mono) · company · date · total (mono, right) · status pill.
 *
 * **Drafts sort first** (`sortSalesRows`) and carry a `Draft` chip — an
 * unconfirmed sale burns no number and moves no balance, so it needs to
 * be visibly unfinished; a draft row shows `Draft` where the number would
 * be, never a fake local number (PLAN-DATA-MODEL.md §3.5: confirm
 * allocates the number).
 *
 * Create lives in `SaleFormScreen` (the route `/sales/new`); the list's
 * *New sale* action navigates there. Pure UI over injected data.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, EmptyState } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import type { SaleRow } from './model';

export interface SalesScreenProps {
  rows: SaleRow[];
  error: string | null;
  loading: boolean;
  onNewSale: () => void;
  onOpenSale: (saleId: string) => void;
  onRetry: () => void;
  testID?: string;
}

/** The status pill's label and colour (§S2: Draft / Confirmed / Void). */
export const SALE_STATUS_PILL: Record<SaleRow['status'], { label: string; color: string }> = {
  draft: { label: 'Draft', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

/**
 * The static `Draft` chip — a label, not the pressable `Chip` primitive:
 * a chip that answers a press it will not act on is a lie.
 */
export function DraftChip({ testID }: { testID?: string }): React.ReactNode {
  return (
    <View style={draftChipStyles.shell} testID={testID}>
      <Text style={draftChipStyles.label}>Draft</Text>
    </View>
  );
}

const draftChipStyles = StyleSheet.create({
  shell: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.feedback.warning,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  label: {
    ...textStyle('label'),
    color: SEMANTIC.feedback.warning,
  },
});

export function SalesScreen(props: SalesScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();
  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'rep-sales'}>
      <Button label="+ New sale" onPress={props.onNewSale} testID="sales-new" />

      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="sales-error" />
      ) : null}

      {!props.loading && props.error === null && props.rows.length === 0 ? (
        <EmptyState
          message="No sales yet."
          actionLabel="New sale"
          onAction={props.onNewSale}
          testID="sales-empty"
        />
      ) : (
        props.rows.map((row) => {
          const pill = SALE_STATUS_PILL[row.status];
          return (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              onPress={() => props.onOpenSale(row.id)}
              style={styles.row}
              testID={`sale-row-${row.id}`}
            >
              <View style={styles.main}>
                <View style={styles.numberRow}>
                  <Text style={styles.number} testID={`sale-number-${row.id}`}>
                    {row.saleNumber ?? 'Draft'}
                  </Text>
                  {row.status === 'draft' ? <DraftChip testID={`sale-draft-chip-${row.id}`} /> : null}
                </View>
                <Text style={styles.secondary}>{`${row.companyName} · ${formatDateEnIN(row.saleDate, nowYear)}`}</Text>
              </View>
              <Text style={styles.total}>{`₹${formatMoneyEnIN(row.total)}`}</Text>
              <Text style={[styles.pill, { color: pill.color }]} testID={`sale-status-${row.id}`}>
                {pill.label}
              </Text>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  main: {
    flex: 1,
    gap: 2,
  },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  number: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  secondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  total: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  pill: {
    ...textStyle('label'),
  },
});
