/**
 * Edit customer route (UI/plan-2/05-DISPATCHER.md §D4, T2.10; the
 * owner's copy §O4b, T4.11) — the correcting half of D4. Role split:
 *
 * - **Dispatcher branch:** `useCustomerForm(id)` PATCHes with the
 *   `If-Match` version the read returned; no company field anywhere.
 * - **Owner branch (T4.11):** the SAME form with the company capability
 *   — present on edit, `null` detaching the site — written through the
 *   owner patch schema (PLAN.md §5: an owner and rep field).
 *
 * No navmap entry of its own: it inherits the `/customers` guard
 * (`customer` × `update`, dispatcher + owner) through the
 * nearest-ancestor walk.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerFormScreen } from '../../../../src/screens/dispatcher/customer';
import { useCustomerForm } from '../../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../../src/screens/dispatcher/useJobLogs';
import { useOwnerCustomerForm } from '../../../../src/screens/owner/useOwnerCustomers';
import { useSessionStore } from '../../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const customerId = Array.isArray(params.id) ? params.id[0] : params.id;
  const actor = useSessionStore((s) => s.actor);
  const flags = useDispatchJobLogsFlags();
  const deps = useCustomerForm(customerId);
  const ownerDeps = useOwnerCustomerForm(customerId);

  if (actor !== null && actor.role === 'owner' && customerId !== undefined) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
        <CustomerFormScreen {...ownerDeps} company={ownerDeps.company} />
      </SafeAreaView>
    );
  }

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
