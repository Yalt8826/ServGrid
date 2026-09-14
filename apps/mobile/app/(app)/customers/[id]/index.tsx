/**
 * Customer detail route (UI/plan-2/05-DISPATCHER.md §D4, T2.10; the
 * owner's copy §O4b, T4.11). Role split:
 *
 * - **Dispatcher branch:** the §D4 detail behind `dispatch.console` —
 *   stack read-only, no company anywhere.
 * - **Owner branch (T4.11):** the same detail with the scope opened up —
 *   the ledger link on the company row, and the EDITABLE stack (the
 *   owner is the correction path when a serial was typed wrong). This
 *   is the pushed frame of the same body the desk table opens as a side
 *   detail.
 *
 * The route needs no navmap entry of its own: it inherits the
 * `/customers` guard (`customer` × `read`) through the
 * nearest-ancestor walk, the same path every detail route takes.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { CustomerDetailScreen } from '../../../../src/screens/dispatcher/customer';
import { useCustomerDetail } from '../../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../../src/screens/dispatcher/useJobLogs';
import { OwnerCustomerDetailBody } from '../../../../src/screens/owner/CustomerDetailBody';
import { useOwnerCustomerDetail } from '../../../../src/screens/owner/useOwnerCustomers';
import { useSessionStore } from '../../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerCustomerDetailRoute({ customerId }: { customerId: string }): React.ReactNode {
  const router = useRouter();
  const deps = useOwnerCustomerDetail(customerId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerCustomerDetailBody
        detail={deps.detail}
        loading={deps.loading}
        detailError={deps.detailError}
        companyName={deps.companyName}
        stack={deps.stack}
        history={deps.history}
        historyError={deps.historyError}
        editing={deps.editing}
        savingStack={deps.savingStack}
        stackError={deps.stackError}
        onEditStackItemOpen={deps.onEditStackItemOpen}
        onCloseSheet={deps.onCloseSheet}
        onSaveStackItem={deps.onSaveStackItem}
        onRemoveStackItem={deps.onRemoveStackItem}
        onCall={deps.onCall}
        onEdit={() => {
          const id = deps.detail?.id;
          if (id !== undefined) router.push(`/customers/${id}/edit`);
        }}
        onOpenJob={deps.onOpenJob}
        onOpenCompany={() => {
          const companyId = deps.detail?.companyId ?? null;
          if (companyId !== null) router.push(`/companies/${companyId}`);
        }}
        onRetry={deps.reload}
        testID="owner-customer-detail-screen"
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const customerId = Array.isArray(params.id) ? params.id[0] : params.id;
  const actor = useSessionStore((s) => s.actor);
  const flags = useDispatchJobLogsFlags();
  const deps = useCustomerDetail(customerId ?? '');

  if (actor !== null && actor.role === 'owner' && customerId !== undefined) {
    return <OwnerCustomerDetailRoute customerId={customerId} />;
  }

  if (!flags.consoleOn || customerId === undefined) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Customer</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CustomerDetailScreen {...deps} />
    </SafeAreaView>
  );
}
