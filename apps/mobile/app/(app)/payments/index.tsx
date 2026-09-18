/**
 * Payments — the rep's route (UI/plan-2/06-SALES-REP.md §S3, T3.7;
 * owner's copy §O5, T4.12). Role split:
 *
 * - **Rep branch:** the §S3 screens over `useRepPayments`: the Owed tab
 *   (a view of dues) and the Collected tab, with the record-payment
 *   sheet's optimistic balance move, gated on `sales.payments`.
 * - **Owner branch (T4.12):** the §O5 list — cards on a phone, a table
 *   with a running total on the desk — with the VOID action, reason
 *   required (void lives here and only here, with sales).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FRAME, SEMANTIC } from '@servgrid/shared';
import { DeskListShell } from '../../../src/components/ui';
import { PaymentsScreen } from '../../../src/screens/rep/PaymentsScreen';
import { useOnline, useRecordPayment, useRepFlags, useRepPayments } from '../../../src/screens/rep/useRepData';
import { OwnerPaymentsScreen } from '../../../src/screens/owner/PaymentsScreen';
import { fetchPaymentProof, useOwnerPayments, useVoidPayment } from '../../../src/screens/owner/useOwnerData';
import { takePhoto } from '../../../src/lib/photo';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useFlagsReady } from '../../../src/state/useFlagsReady';
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
    // The frame reaches the status bar; the bottom inset is the shell's.
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
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
        captureProof={takePhoto}
        applyOptimisticPayment={payments.applyOptimisticPayment}
        onRetry={payments.reload}
      />
    </SafeAreaView>
  );
}

function OwnerPaymentsRoute(): React.ReactNode {
  const payments = useOwnerPayments();
  const { voidBusy, voidError, voidPayment } = useVoidPayment(payments.reload);
  const flagsReady = useFlagsReady();

  if (!flagsReady || !isFlagOn('sales.payments')) {
    // Unknown flags read as off on a cold browser load — wait for the
    // /auth/me answer before rendering the honest dark placeholder.
    return (
      <View style={styles.root}>
        <Text>Payments</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DeskListShell title="Payments" testID="owner-payments-page">
        <OwnerPaymentsScreen
          rows={payments.rows}
          error={payments.error}
          loading={payments.loading}
          onVoid={(payment, reason) => {
            void voidPayment(payment.id, reason).catch(() => {});
          }}
          voidBusy={voidBusy}
          voidError={voidError}
          onRetry={payments.reload}
          onLoadPaymentProof={(paymentId) => fetchPaymentProof(paymentId)}
        />
      </DeskListShell>
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerPaymentsRoute />;
  if (actor.role === 'sales_rep') return <RepPaymentsRoute />;
  return (
    <View style={styles.root}>
      <Text>Payments</Text>
    </View>
  );
}
