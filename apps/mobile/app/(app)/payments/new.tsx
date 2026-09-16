/**
 * Capture payment — the rep's route (UI/plan-2/06-SALES-REP.md §S3,
 * T3.7). The §S3 screen with the record-payment sheet open, the company
 * prefilled from `?company=` when the deep link carries one. Same flag
 * and same seams as /payments — the two routes are one screen with the
 * sheet's starting state different.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { PaymentsScreen } from '../../../src/screens/rep/PaymentsScreen';
import { useOnline, useRecordPayment, useRepFlags, useRepPayments } from '../../../src/screens/rep/useRepData';
import { takePhoto } from '../../../src/lib/photo';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepRecordPaymentRoute(): React.ReactNode {
  const router = useRouter();
  const params = useLocalSearchParams<{ company?: string | string[] }>();
  const flags = useRepFlags();
  const payments = useRepPayments();
  const { pendingRecord, record } = useRecordPayment();
  const online = useOnline();
  const companyParam = Array.isArray(params.company) ? params.company[0] : params.company;

  if (!flags.ready || !flags.payments) {
    return (
      <View style={styles.root}>
        <Text>Record payment</Text>
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
        captureProof={takePhoto}
        applyOptimisticPayment={payments.applyOptimisticPayment}
        onRetry={payments.reload}
        sheetCompanyId={companyParam ?? null}
        startWithSheetOpen
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepRecordPaymentRoute />;
  return (
    <View style={styles.root}>
      <Text>Record payment</Text>
    </View>
  );
}
