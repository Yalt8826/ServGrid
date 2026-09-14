/**
 * Contracts — route (UI/plan-2/07-OWNER.md §O6, T4.12). The owner's
 * contract list — number · site · billing · visits used/included ·
 * start · end · value · sold by — cards on a phone, the table on the
 * desk. Gated on `contracts.manage`, the same flag the contract
 * endpoints answer to (PHASE-2B-CONTRACTS T2B.4's surface).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerContractsScreen } from '../../../src/screens/owner/ContractsScreen';
import { ownerToday, useOwnerContracts } from '../../../src/screens/owner/useOwnerData';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerContractsRoute(): React.ReactNode {
  const router = useRouter();
  const contracts = useOwnerContracts();

  if (!isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>Contracts</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerContractsScreen
        variant="all"
        rows={contracts.rows}
        error={contracts.error}
        loading={contracts.loading}
        today={ownerToday()}
        onOpenContract={(contractId) => router.push(`/contracts/${contractId}`)}
        onRetry={contracts.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerContractsRoute />;
  return (
    <View style={styles.root}>
      <Text>Contracts</Text>
    </View>
  );
}
