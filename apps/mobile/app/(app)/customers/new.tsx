/**
 * New customer route (UI/plan-2/05-DISPATCHER.md §D4, T2.10; the
 * owner's copy §O4b, T4.11) — the form half of D4, reached from the D3
 * search-or-create field and from the list's no-match offer. Role
 * split:
 *
 * - **Dispatcher branch:** `useCustomerForm` behind `dispatch.console`.
 *   No company field — the form does not offer one, and the
 *   dispatcher's create schema strips one regardless (PLAN.md §5
 *   rule 3).
 * - **Owner branch (T4.11):** the SAME form with the company capability
 *   passed — the one field his dispatch copy gains (§O4b), written
 *   through the owner create schema (no strip).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerFormScreen } from '../../../src/screens/dispatcher/customer';
import { useCustomerForm } from '../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { useOwnerCustomerForm } from '../../../src/screens/owner/useOwnerCustomers';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const flags = useDispatchJobLogsFlags();
  const deps = useCustomerForm();
  const ownerDeps = useOwnerCustomerForm();

  if (actor !== null && actor.role === 'owner') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
        <CustomerFormScreen {...ownerDeps} company={ownerDeps.company} />
      </SafeAreaView>
    );
  }

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
