/**
 * Payments — the rep's route (UI/plan-2/06-SALES-REP.md §S3, T3.7). The
 * §S3 screen over `useRepPayments`: the Owed tab (a view of dues) and the
 * Collected tab, with the record-payment sheet's optimistic balance move.
 * Gated on `sales.payments` — the same flag the balances and payments
 * endpoints answer to, so the screen and the server go dark together.
 * Other roles keep the placeholder (the owner's payments screens are
 * Phase 4's task).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { PaymentsScreen } from '../../../src/screens/rep/PaymentsScreen';
import { useOnline, useRecordPayment, useRepFlags, useRepPayments } from '../../../src/screens/rep/useRepData';
import { captureProofPhoto } from '../../../src/lib/captureProof';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepPaymentsRoute(): React.ReactNode {
  const router = useRouter();
  const flags = useRepFlags();
  const payments = useRepPayments();
  const { pendingRecord, record } = useRecordPayment();
  const online = useOnline();

  if (!flags.ready || !flags.payments) {
    // The T0 rollback, rendered: sales.payments off is a dark screen.
    return (
      <View style={styles.root}>
        <Text>Payments</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <PaymentsScreen
        owed={payments.owed}
        collected={payments.collected}
        companies={payments.companies.map((c) => ({ id: c.id, name: c.name }))}
        openSales={payments.openSales}
        error={payments.error}
        loading={payments.loading}
        pendingRecord={pendingRecord}
        online={online}
        record={record}
        onOpenPayment={(paymentId) => router.push(`/payments/${paymentId}`)}
        captureProof={captureProofPhoto}
        applyOptimisticPayment={payments.applyOptimisticPayment}
        onRetry={payments.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepPaymentsRoute />;
  return (
    <View style={styles.root}>
      <Text>Payments</Text>
    </View>
  );
}
