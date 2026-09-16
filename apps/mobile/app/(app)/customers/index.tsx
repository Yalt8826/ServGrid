/**
 * Customers — route. Two screens behind one path:
 *
 * - **Dispatcher** (D4, T2.10): search over name and phone, two-line
 *   rows, because his worst moment is the phone ringing while a
 *   technician is already on site. `dispatch.console` gates it.
 * - **Owner** (§O4b, T4.11): the whole customer base as a table — name ·
 *   area · phone · company · units · open jobs · last job — with the side
 *   detail and a door to create one. That screen and its hook were built
 *   in Phase 4 and never mounted: the route rendered the dispatcher's
 *   search for every role, which is why the owner's Customers page looked
 *   empty until he typed something (OW.5, 2026-09-16).
 *
 * The owner does not answer to `dispatch.console` — that flag is the
 * dispatcher console's rollback, never a gate on the person covering it.
 */
import { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { Button, DeskListShell } from '../../../src/components/ui';
import { CustomerSearchScreen } from '../../../src/screens/dispatcher/customer';
import { useCustomerSearch } from '../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { OwnerCustomersScreen } from '../../../src/screens/owner/CustomersScreen';
import { useOwnerCustomerDetail, useOwnerCustomers } from '../../../src/screens/owner/useOwnerCustomers';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerCustomersRoute(): React.ReactNode {
  const router = useRouter();
  const list = useOwnerCustomers();
  // The desk's side detail follows the selected row; the phone pushes a
  // screen instead, so nothing is selected there.
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const detail = useOwnerCustomerDetail(selectedCustomerId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DeskListShell
        title="Customers"
        subtitle={`${list.rows.length} ${list.rows.length === 1 ? 'site' : 'sites'}`}
        actions={<Button label="+ New customer" onPress={() => router.push('/customers/new')} testID="owner-customers-new" />}
        testID="owner-customers-page"
      >
        <OwnerCustomersScreen
          offline={list.offline}
          error={list.error}
          loading={list.loading}
          rows={list.rows}
          onRetryList={list.reload}
          onOpenCustomer={(customerId) => router.push(`/customers/${customerId}`)}
          selectedCustomerId={selectedCustomerId}
          onSelectCustomer={setSelectedCustomerId}
          detail={detail.detail}
          detailError={detail.detailError}
          companyName={detail.companyName}
          stack={detail.stack}
          history={detail.history}
          historyError={detail.historyError}
          editing={detail.editing}
          savingStack={detail.savingStack}
          stackError={detail.stackError}
          onEditStackItemOpen={detail.onEditStackItemOpen}
          onCloseSheet={detail.onCloseSheet}
          onSaveStackItem={detail.onSaveStackItem}
          onRemoveStackItem={detail.onRemoveStackItem}
          onCall={detail.onCall}
          onOpenJob={detail.onOpenJob}
          onEdit={() => {
            const id = detail.detail?.id;
            if (id !== undefined) router.push(`/customers/${id}/edit`);
          }}
          onOpenCompany={() => {
            const companyId = detail.detail?.companyId ?? null;
            if (companyId !== null) router.push(`/companies/${companyId}`);
          }}
          onRetry={detail.reload}
        />
      </DeskListShell>
    </SafeAreaView>
  );
}

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const actor = useSessionStore((s) => s.actor);
  const deps = useCustomerSearch();

  if (actor?.role === 'owner') return <OwnerCustomersRoute />;

  if (!flags.consoleOn) {
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
