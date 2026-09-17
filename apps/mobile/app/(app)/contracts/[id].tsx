/**
 * AMC detail — route (T2B.4, §D5 "Detail"). The AMC's facts and every
 * job linked to it; Edit, Renew and Cancel (reason required) act on it.
 * The cancel goes through `useSaveContract().cancel` (one key per intent)
 * and refetches the detail; a refusal lands back in the sheet, which
 * stays open. Same role and flag checks as the AMC tab.
 */
import { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { FRAME } from '@servgrid/shared';
import { AmcDetailScreen } from '../../../src/screens/contracts/AmcDetailScreen';
import { useContractDetail, useSaveContract } from '../../../src/screens/contracts/useContracts';
import { WriteNotSaved } from '../../../src/lib/intentWrite';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useFlagsReady } from '../../../src/state/useFlagsReady';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function AmcDetailRoute({ contractId }: { contractId: string }): React.ReactNode {
  const router = useRouter();
  const { detail, loading, error, refetch } = useContractDetail(contractId);
  const { cancel, saving } = useSaveContract();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const onCancel = async (reason: string): Promise<void> => {
    setCancelError(null);
    try {
      await cancel(contractId, reason);
      refetch();
    } catch (e) {
      setCancelError(e instanceof WriteNotSaved ? e.message : 'The AMC could not be cancelled. Try again.');
      throw e; // the screen keeps the sheet open on a refusal
    }
  };

  return (
    // The frame reaches the status bar; the bottom inset belongs to the
    // tab bar (the console's other routes, 2026-09-17).
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <AmcDetailScreen
        detail={detail}
        loading={loading}
        error={error}
        onRetry={refetch}
        onBack={() => router.back()}
        onEdit={() => router.push(`/contracts/new?editId=${contractId}`)}
        onRenew={() => router.push(`/contracts/new?renewOf=${contractId}`)}
        onOpenJob={(jobId) => router.push(`/jobs/${jobId}`)}
        onCancel={onCancel}
        cancelling={saving}
        cancelError={cancelError}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const contractId = Array.isArray(params.id) ? params.id[0] : params.id;
  const flagsReady = useFlagsReady();
  if (actor === null || contractId === undefined) return null;
  if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
    return (
      <View style={styles.root}>
        <Text>AMC</Text>
      </View>
    );
  }
  // Unknown flags read as off on a cold browser load — wait for the
  // /auth/me answer before rendering the honest dark placeholder.
  if (!flagsReady || !isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>AMC</Text>
      </View>
    );
  }
  return <AmcDetailRoute contractId={contractId} />;
}
