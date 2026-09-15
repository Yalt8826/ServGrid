/**
 * AMC — route (T2B.4, UI/plan-2/05-DISPATCHER.md §D5, 07-OWNER.md §O6).
 * The dispatcher's own AMC tab and an Operations entry for the owner;
 * reps have none (decision 2026-09-15). The route is the mount point:
 * role + flag, the debounced search, and the wiring — the screen is
 * pure over injected props and `useContractSections` owns the reads.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { AmcScreen } from '../../../src/screens/contracts/AmcScreen';
import { useContractSections } from '../../../src/screens/contracts/useContracts';
import { istBusinessDate } from '../../../src/screens/dispatcher/useDispatcherDashboard';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

/** Mid-call typing searches on the pause, not on every character — the
 * dispatch form's debounce, same number. */
const SEARCH_DEBOUNCE_MS = 250;

function AmcRoute({ role }: { role: 'dispatcher' | 'owner' }): React.ReactNode {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const sections = useContractSections(debouncedQuery);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <AmcScreen
        role={role}
        todayIso={istBusinessDate(new Date())}
        query={query}
        onQueryChange={setQuery}
        due={sections.due}
        ending={sections.ending}
        all={sections.all}
        dueError={sections.errors.due}
        endingError={sections.errors.ending}
        allError={sections.errors.all}
        onRetry={sections.refetch}
        onNew={() => router.push('/contracts/new')}
        onOpen={(contractId) => router.push(`/contracts/${contractId}`)}
        onDispatch={(customerId) => router.push(`/jobs/new?customerId=${customerId}`)}
        onRenew={(contractId) => router.push(`/contracts/new?renewOf=${contractId}`)}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
    return (
      <View style={styles.root}>
        <Text>AMC</Text>
      </View>
    );
  }
  if (!isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>AMC</Text>
      </View>
    );
  }
  return <AmcRoute role={actor.role} />;
}
