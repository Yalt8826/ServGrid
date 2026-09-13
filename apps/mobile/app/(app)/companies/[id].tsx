/**
 * Company detail — the rep's route (UI/plan-2/06-SALES-REP.md §S4,
 * T3.7). The §S4 ledger screen over `useRepCompanyLedger`, with the
 * record-payment sheet (the same `useRecordPayment` seam /payments uses)
 * and *New sale* prefilled with the company. Scoping is the server's: a
 * company that is not his answers OUT_OF_SCOPE, rendered as the banner.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { CompanyLedgerScreen } from '../../../src/screens/rep/CompanyLedgerScreen';
import { useRecordPayment, useRepCompanyLedger, useRepPayments } from '../../../src/screens/rep/useRepData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepCompanyLedgerRoute({ companyId }: { companyId: string }): React.ReactNode {
  const router = useRouter();
  const ledger = useRepCompanyLedger(companyId);
  const payments = useRepPayments();
  const { pendingRecord, record } = useRecordPayment();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CompanyLedgerScreen
        company={ledger.company}
        ledger={ledger.ledger}
        error={ledger.error}
        loading={ledger.loading}
        openSales={payments.openSales.filter((s) => s.companyId === companyId)}
        pendingRecord={pendingRecord}
        record={record}
        onRecorded={() => {
          ledger.reload();
          payments.reload();
        }}
        onNewSale={(id) => router.push(`/sales/new?company=${id}`)}
        onCallPhone={(phone) => void Linking.openURL(`tel:${phone}`)}
        onRetry={ledger.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const companyId = Array.isArray(params.id) ? params.id[0] : params.id;
  if (actor === null || companyId === undefined) return null;
  if (actor.role === 'sales_rep') return <RepCompanyLedgerRoute companyId={companyId} />;
  return (
    <View style={styles.root}>
      <Text>Company</Text>
    </View>
  );
}
