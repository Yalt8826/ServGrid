/**
 * New customer route (UI/plan-2/05-DISPATCHER.md §D4, T2.10) — the form
 * half of D4, reached from the D3 search-or-create field and from the
 * D4 list's no-match offer. The seam wires the pure CustomerFormScreen
 * to `useCustomerForm` (no id: create); `dispatch.console` keeps the
 * screen dark until the server turns it on (PLAN-EXECUTION.md §3).
 *
 * The route carries the `/customers/new` guard (`customer` × `create`)
 * from ROUTE_GUARDS. There is no company field: the form does not offer
 * one, and the dispatcher's create schema strips one regardless
 * (PLAN.md §5 rule 3).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerFormScreen } from '../../../src/screens/dispatcher/customer';
import { useCustomerForm } from '../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const deps = useCustomerForm();

  if (!flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>New customer</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CustomerFormScreen {...deps} />
    </SafeAreaView>
  );
}
