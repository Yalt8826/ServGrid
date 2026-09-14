/**
 * Companies — the rep's route (UI/plan-2/06-SALES-REP.md §S4, T3.7). The
 * §S4 list over `useRepCompanies`: his accounts plus house accounts,
 * balance descending, `Shared` chips, no hint that other accounts exist.
 * The list itself is not flag-gated (the companies surface never was); a
 * balances read failing degrades the column, not the screen.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { CompaniesScreen } from '../../../src/screens/rep/CompaniesScreen';
import { useRepCompanies } from '../../../src/screens/rep/useRepData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepCompaniesRoute(): React.ReactNode {
  const router = useRouter();
  const companies = useRepCompanies();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
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

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepCompaniesRoute />;
  return (
    <View style={styles.root}>
      <Text>Companies</Text>
    </View>
  );
}
