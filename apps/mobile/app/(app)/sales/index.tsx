/**
 * Sales — the list route (UI/plan-2/06-SALES-REP.md §S2, T3.7;
 * owner's copy §O5, T4.12). Role split:
 *
 * - **Rep branch:** the §S2 list (drafts first, Draft chip, status
 *   pills) over `useRepSales`, gated on `sales.cards` the same way the
 *   server's sales surface is.
 * - **Owner branch (T4.12):** the §O5 list — cards on a phone, a table
 *   with a running total on the desk — with the VOID action, the one
 *   place in the product a sale can be reversed, reason required.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { DeskListShell } from '../../../src/components/ui';
import { SalesScreen } from '../../../src/screens/rep/SalesScreen';
import { useRepFlags, useRepSales } from '../../../src/screens/rep/useRepData';
import { OwnerSalesScreen } from '../../../src/screens/owner/SalesScreen';
import { fetchSaleWithItems, useOwnerSales, useVoidSale } from '../../../src/screens/owner/useOwnerData';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useFlagsReady } from '../../../src/state/useFlagsReady';
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

function OwnerSalesRoute(): React.ReactNode {
  const sales = useOwnerSales();
  const { voidBusy, voidError, voidSale } = useVoidSale(sales.reload);
  const flagsReady = useFlagsReady();

  if (!flagsReady || !isFlagOn('sales.cards')) {
    // Unknown flags read as off on a cold browser load — wait for the
    // /auth/me answer before rendering the honest dark placeholder.
    return (
      <View style={styles.root}>
        <Text>Sales</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DeskListShell title="Sales" testID="owner-sales-page">
        <OwnerSalesScreen
          rows={sales.rows}
          error={sales.error}
          loading={sales.loading}
          onVoid={(sale, reason) => {
            void voidSale(sale.id, reason).catch(() => {});
          }}
          voidBusy={voidBusy}
          voidError={voidError}
          onRetry={sales.reload}
          onLoadSale={(saleId) => fetchSaleWithItems(saleId)}
        />
      </DeskListShell>
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerSalesRoute />;
  if (actor.role === 'sales_rep') return <RepSalesRoute />;
  return (
    <View style={styles.root}>
      <Text>Sales</Text>
    </View>
  );
}
