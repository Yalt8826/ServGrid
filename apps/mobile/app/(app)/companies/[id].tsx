/**
 * Company detail — route (UI/plan-2/06-SALES-REP.md §S4, T3.7; owner's
 * copy §O5, T4.12). Role split:
 *
 * - **Rep branch:** the §S4 ledger screen over `useRepCompanyLedger`,
 *   with the record-payment sheet and *New sale* prefilled with the
 *   company. Scoping is the server's: a company that is not his answers
 *   OUT_OF_SCOPE, rendered as the banner.
 * - **Owner branch (T4.12):** the same ledger, unscoped, over a header
 *   that names the owner rep and carries the reassignment control —
 *   voided documents keep their rows with their reasons.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Linking } from 'react-native';

import { FRAME, SEMANTIC } from '@servgrid/shared';
import { CompanyLedgerScreen } from '../../../src/screens/rep/CompanyLedgerScreen';
import { useOnline, useRecordPayment, useRepCompanyLedger, useRepPayments } from '../../../src/screens/rep/useRepData';
import { OwnerCompanyDetailScreen } from '../../../src/screens/owner/CompanyDetailScreen';
import {
  fetchPaymentProof,
  fetchSaleWithItems,
  useOwnerCompanyLedger,
  useOwnerReps,
  useReassignCompany,
} from '../../../src/screens/owner/useOwnerData';
import { takePhoto } from '../../../src/lib/photo';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepCompanyLedgerRoute({ companyId }: { companyId: string }): React.ReactNode {
  const router = useRouter();
  const ledger = useRepCompanyLedger(companyId);
  const payments = useRepPayments();
  const { pendingRecord, record } = useRecordPayment();
  const online = useOnline();

  return (
    // The frame reaches the status bar; the bottom inset is the shell's.
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <CompanyLedgerScreen
        company={ledger.company}
        ledger={ledger.ledger}
        error={ledger.error}
        loading={ledger.loading}
        openSales={payments.openSales.filter((s) => s.companyId === companyId)}
        pendingRecord={pendingRecord}
        online={online}
        record={record}
        captureProof={takePhoto}
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

function OwnerCompanyLedgerRoute({ companyId }: { companyId: string }): React.ReactNode {
  const router = useRouter();
  const ledger = useOwnerCompanyLedger(companyId);
  const reps = useOwnerReps();
  const { reassignBusy, reassignError, reassign } = useReassignCompany(ledger.reload);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerCompanyDetailScreen
        companyId={companyId}
        companyName={ledger.company?.name ?? ''}
        contactPerson={ledger.company?.contactPerson ?? null}
        phone={ledger.company?.phone ?? null}
        gstin={ledger.company?.gstin ?? null}
        ownerRepName={ledger.ownerRepName}
        shared={ledger.shared}
        ledger={ledger.ledger}
        error={ledger.error ?? reps.error}
        loading={ledger.loading}
        reps={reps.reps}
        onReassign={(id, ownerRepId) => {
          void reassign(id, ownerRepId).catch(() => {});
        }}
        reassignBusy={reassignBusy}
        reassignError={reassignError}
        onNewSale={() => router.push(`/sales/new?company=${companyId}`)}
        onRecordPayment={() => router.push(`/payments/new?company=${companyId}`)}
        onLoadSale={(saleId) => fetchSaleWithItems(saleId)}
        onLoadPaymentProof={(paymentId) => fetchPaymentProof(paymentId)}
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
  if (actor.role === 'owner') return <OwnerCompanyLedgerRoute companyId={companyId} />;
  if (actor.role === 'sales_rep') return <RepCompanyLedgerRoute companyId={companyId} />;
  return (
    <View style={styles.root}>
      <Text>Company</Text>
    </View>
  );
}
