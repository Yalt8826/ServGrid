/**
 * The dispatch form's two-line customer result rows (§D3), extracted at
 * T2B.4 so the AMC form's customer search (§D5) renders the SAME rows —
 * one component, one muscle memory: name on the strong line, phone ·
 * area under it. The AMC form passes its own testID prefix; the dispatch
 * form's prefix keeps its `dispatch-customer-result-*` testIDs verbatim.
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { useDensity } from '../../components/ui';
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
  // The rows are shared with the AMC form; the type follows the density
  // they are rendered in (console 15, desk 14), like every primitive.
  const density = useDensity();
  const name = useMemo(() => [styles.resultName, textStyle('bodyStrong', density)], [density]);
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
          <Text numberOfLines={1} style={name}>
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
  results: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  resultRow: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  resultName: { color: SEMANTIC.text.primary },
  resultMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
});
