/**
 * Contract detail — route (UI/plan-2/07-OWNER.md §O6, T4.12). The visit
 * schedule: every visit with its status and, where a visit produced
 * multiple job cards, ALL the attempts — a visit on its third attempt is
 * the thing the owner wants to see when a customer complains. Same
 * `contracts.manage` gate as the list.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerContractDetailScreen } from '../../../src/screens/owner/ContractDetailScreen';
import { useOwnerContractDetail } from '../../../src/screens/owner/useOwnerData';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerContractDetailRoute({ contractId }: { contractId: string }): React.ReactNode {
  const router = useRouter();
  const detail = useOwnerContractDetail(contractId);

  if (!isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>Contract</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerContractDetailScreen
        contract={detail.contract}
        visits={detail.visits}
        error={detail.error}
        loading={detail.loading}
        onOpenJob={(jobId) => router.push(`/jobs/${jobId}`)}
        onRetry={detail.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const contractId = Array.isArray(params.id) ? params.id[0] : params.id;
  if (actor === null || contractId === undefined) return null;
  if (actor.role === 'owner') return <OwnerContractDetailRoute contractId={contractId} />;
  return (
    <View style={styles.root}>
      <Text>Contract</Text>
    </View>
  );
}
