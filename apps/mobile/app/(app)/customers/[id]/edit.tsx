/**
 * Edit customer route (UI/plan-2/05-DISPATCHER.md §D4, T2.10) — the
 * correcting half of D4 ("correct their details"). The seam wires the
 * pure CustomerFormScreen to `useCustomerForm(id)`, which PATCHes with
 * the `If-Match` version the read returned; `dispatch.console` keeps
 * the screen dark until the server turns it on (PLAN-EXECUTION.md §3).
 *
 * No navmap entry of its own: it inherits the `/customers` guard
 * (`customer` × `update`, dispatcher + owner) through the
 * nearest-ancestor walk. There is no company field here either — the
 * dispatcher's patch schema strips one regardless (PLAN.md §5 rule 3).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerFormScreen } from '../../../../src/screens/dispatcher/customer';
import { useCustomerForm } from '../../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../../src/screens/dispatcher/useJobLogs';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const customerId = Array.isArray(params.id) ? params.id[0] : params.id;
  const flags = useDispatchJobLogsFlags();
  const deps = useCustomerForm(customerId);

  if (!flags.consoleOn || customerId === undefined) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Edit customer</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CustomerFormScreen {...deps} />
    </SafeAreaView>
  );
}
