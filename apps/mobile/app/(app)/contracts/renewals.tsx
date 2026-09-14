/**
 * Renewals — route (UI/plan-2/07-OWNER.md §O6, T4.12). **A filtered
 * view, not a separate screen**: the same contracts screen with
 * `variant="renewals"` — expiring within 60 days, sorted by days
 * remaining, visits used on every row because a spent visit reduces
 * what the renewal is worth. Same `contracts.manage` gate as the list.
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

function OwnerRenewalsRoute(): React.ReactNode {
  const router = useRouter();
  const contracts = useOwnerContracts();

  if (!isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>Renewals</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerContractsScreen
        variant="renewals"
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
  if (actor.role === 'owner') return <OwnerRenewalsRoute />;
  return (
    <View style={styles.root}>
      <Text>Renewals</Text>
    </View>
  );
}
