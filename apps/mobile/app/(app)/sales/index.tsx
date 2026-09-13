/**
 * Sales — the list route (UI/plan-2/06-SALES-REP.md §S2, T3.7). The rep's
 * branch renders the §S2 list (drafts first, Draft chip, status pills)
 * over `useRepSales`, gated on `sales.cards` the same way the server's
 * sales surface is: the flag decides whether the screen answers, and a
 * dark placeholder is the honest off. Other roles keep the placeholder
 * (the owner's sales screens are Phase 4's task).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { SalesScreen } from '../../../src/screens/rep/SalesScreen';
import { useRepFlags, useRepSales } from '../../../src/screens/rep/useRepData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepSalesRoute(): React.ReactNode {
  const router = useRouter();
  const flags = useRepFlags();
  const sales = useRepSales();

  if (!flags.ready) {
    return (
      <View style={styles.root}>
        <Text>Sales</Text>
      </View>
    );
  }
  if (!flags.cards) {
    // The T0 rollback, rendered: sales.cards off is a dark screen.
    return (
      <View style={styles.root}>
        <Text>Sales</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <SalesScreen
        rows={sales.rows}
        error={sales.error}
        loading={sales.loading}
        onNewSale={() => router.push('/sales/new')}
        onOpenSale={(saleId) => router.push(`/sales/${saleId}`)}
        onRetry={sales.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepSalesRoute />;
  return (
    <View style={styles.root}>
      <Text>Sales</Text>
    </View>
  );
}
