/**
 * Products — route (UI/plan-2/07-OWNER.md §O8, T4.12). The catalogue
 * table under Profile in the phone grouping: settings, not work. Simple
 * table, deactivate rather than delete. Owner writes are the role fact
 * the server enforces at its own door (§6.4); no flag.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerProductsScreen } from '../../../src/screens/owner/ProductsScreen';
import { useDeactivateCatalogItem, useOwnerProducts } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerProductsRoute(): React.ReactNode {
  const products = useOwnerProducts();
  const { busyId, deactivate } = useDeactivateCatalogItem('products', products.reload);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerProductsScreen
        rows={products.rows}
        error={products.error}
        loading={products.loading}
        onDeactivate={(productId) => {
          const row = products.rows.find((p) => p.id === productId);
          if (row !== undefined) void deactivate(productId, row.version).catch(() => {});
        }}
        deactivateBusyId={busyId}
        onRetry={products.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerProductsRoute />;
  return (
    <View style={styles.root}>
      <Text>Products</Text>
    </View>
  );
}
