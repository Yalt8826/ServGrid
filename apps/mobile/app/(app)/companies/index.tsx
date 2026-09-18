/**
 * Companies — route (UI/plan-2/06-SALES-REP.md §S4, T3.7; owner's copy
 * §O5, T4.12). Role split:
 *
 * - **Rep branch:** the §S4 list over `useRepCompanies`: his accounts
 *   plus house accounts, balance descending, `Shared` chips, and NO
 *   reassign surface — only the owner can move an account.
 * - **Owner branch (T4.12):** every account, both reps', plus house
 *   accounts, with the owner rep column and the reassignment control
 *   that exists nowhere else in the product — choosing *Nobody* makes
 *   the account a house account, which is how leave gets covered.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FRAME, SEMANTIC } from '@servgrid/shared';
import { CompaniesScreen } from '../../../src/screens/rep/CompaniesScreen';
import { useRepCompanies } from '../../../src/screens/rep/useRepData';
import { OwnerCompaniesScreen } from '../../../src/screens/owner/CompaniesScreen';
import { useOwnerCompanies, useOwnerReps, useReassignCompany } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepCompaniesRoute(): React.ReactNode {
  const router = useRouter();
  const companies = useRepCompanies();

  return (
    // The frame reaches the status bar; the bottom inset is the shell's
    // (2026-09-18). The owner's branch keeps its own wrapper.
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <CompaniesScreen
        rows={companies.rows}
        error={companies.error}
        loading={companies.loading}
        onOpenCompany={(companyId) => router.push(`/companies/${companyId}`)}
        onNewSale={() => router.push('/sales/new')}
        onNewCompany={() => router.push('/companies/new')}
        onRetry={companies.reload}
      />
    </SafeAreaView>
  );
}

function OwnerCompaniesRoute(): React.ReactNode {
  const router = useRouter();
  const companies = useOwnerCompanies();
  const reps = useOwnerReps();
  const { reassignBusy, reassignError, reassign } = useReassignCompany(companies.reload);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerCompaniesScreen
        rows={companies.rows}
        error={companies.error ?? reps.error}
        loading={companies.loading}
        onOpenCompany={(companyId) => router.push(`/companies/${companyId}`)}
        reps={reps.reps}
        onReassign={(companyId, ownerRepId) => {
          void reassign(companyId, ownerRepId).catch(() => {});
        }}
        reassignBusy={reassignBusy}
        reassignError={reassignError}
        onRetry={companies.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerCompaniesRoute />;
  if (actor.role === 'sales_rep') return <RepCompaniesRoute />;
  return (
    <View style={styles.root}>
      <Text>Companies</Text>
    </View>
  );
}
