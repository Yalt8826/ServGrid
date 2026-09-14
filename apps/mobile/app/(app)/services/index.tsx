/**
 * Services — route (UI/plan-2/07-OWNER.md §O8, T4.12). The job-type
 * catalogue under Profile in the phone grouping: settings, not work.
 * Same deactivation rule as products.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerServicesScreen } from '../../../src/screens/owner/ServicesScreen';
import { useDeactivateCatalogItem, useOwnerServices } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerServicesRoute(): React.ReactNode {
  const services = useOwnerServices();
  const { busyId, deactivate } = useDeactivateCatalogItem('services', services.reload);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerServicesScreen
        rows={services.rows}
        error={services.error}
        loading={services.loading}
        onDeactivate={(serviceId) => {
          const row = services.rows.find((s) => s.id === serviceId);
          if (row !== undefined) void deactivate(serviceId, row.version).catch(() => {});
        }}
        deactivateBusyId={busyId}
        onRetry={services.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerServicesRoute />;
  return (
    <View style={styles.root}>
      <Text>Services</Text>
    </View>
  );
}
