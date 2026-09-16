/**
 * Customers route (UI/plan-2/05-DISPATCHER.md §D4, T2.10). The seam
 * where the pure CustomerSearchScreen meets the api — `useCustomerSearch`
 * owns the debounced search, and `dispatch.console` keeps the
 * DISPATCHER's screen dark until the server turns it on
 * (PLAN-EXECUTION.md §3). **The owner is exempt** (OW.1, 2026-09-16) —
 * the flag is the dispatcher console's rollback, never a gate on the
 * person who covers for them.
 *
 * The route carries the `/customers` guard (`customer` × `read`) from
 * ROUTE_GUARDS; the dispatcher's Operations tab lands here.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerSearchScreen } from '../../../src/screens/dispatcher/customer';
import { useCustomerSearch } from '../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const actor = useSessionStore((s) => s.actor);
  const deps = useCustomerSearch();

  if (actor?.role !== 'owner' && !flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Customers</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CustomerSearchScreen {...deps} />
    </SafeAreaView>
  );
}
