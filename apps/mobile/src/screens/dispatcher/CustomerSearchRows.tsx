/**
 * The dispatch form's two-line customer result rows (§D3), extracted at
 * T2B.4 so the AMC form's customer search (§D5) renders the SAME rows —
 * one component, one muscle memory: name on the strong line, phone ·
 * area under it. The AMC form passes its own testID prefix; the dispatch
 * form's prefix keeps its `dispatch-customer-result-*` testIDs verbatim.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import type { DispatchCustomerOption } from './dispatchForm';

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

export interface CustomerSearchRowsProps {
  results: readonly DispatchCustomerOption[];
  onSelect(customer: DispatchCustomerOption): void;
  /** The rows' testIDs are `${testIDPrefix}-${customerId}`. */
  testIDPrefix: string;
  /** Set while a submit is in flight — the rows go dead, not missing. */
  disabled?: boolean;
}

export function CustomerSearchRows({ results, onSelect, testIDPrefix, disabled }: CustomerSearchRowsProps): React.ReactNode {
  return (
    <View style={styles.results}>
      {results.map((customer) => (
        <Pressable
          key={customer.id}
          testID={`${testIDPrefix}-${customer.id}`}
          accessibilityRole="button"
          disabled={disabled}
          hitSlop={hitSlop}
          onPress={() => {
            haptic('pickerSelect');
            onSelect(customer);
          }}
          style={styles.resultRow}
        >
          <Text numberOfLines={1} style={styles.resultName}>
            {customer.name}
          </Text>
          <Text numberOfLines={1} style={styles.resultMeta}>
            {customer.phone}
            {customer.addressLabel === null ? '' : ` · ${customer.addressLabel}`}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  results: { marginTop: SPACE[1], borderWidth: 1, borderColor: SEMANTIC.line.default, borderRadius: 4 },
  resultRow: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
  resultName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  resultMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
});
