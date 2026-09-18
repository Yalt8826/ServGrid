/**
 * Dispatch Job route (UI/plan-2/05-DISPATCHER.md §D3, T2.9). The seam
 * where the pure DispatchJobScreen meets the api — `useDispatchForm`
 * owns the reads and the submit, and `dispatch.console` keeps the
 * DISPATCHER's screen dark until the server turns it on
 * (PLAN-EXECUTION.md §3). **The owner is exempt** (OW.1, 2026-09-16):
 * that flag is the dispatcher console's rollback, and the owner is who
 * covers the desk while it is off — his copy of this screen answered a
 * blank placeholder for exactly as long as he lacked a flag that was
 * never his. The server agrees (`flags/gates.ts`).
 *
 * The route needs no navmap entry of its own: `/jobs/new` carries the
 * `job` × `create` guard in ROUTE_GUARDS, dispatcher + owner, and sits
 * in both roles' Operations group. Reached from the dispatcher's
 * dashboard ("+ Dispatch a job", D1 being the screen that hands here).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { FRAME } from '@servgrid/shared';
import { DispatchJobScreen } from '../../../src/screens/dispatcher/dispatch';
import { useDispatchForm } from '../../../src/screens/dispatcher/useDispatchForm';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const router = useRouter();
  const flags = useDispatchJobLogsFlags();
  const actor = useSessionStore((s) => s.actor);
  // The AMC tab's Dispatch deep-link (`/jobs/new?customerId=…`) lands
  // with the customer already chosen; the plain Operations entry has no
  // param and starts from an empty search.
  const params = useLocalSearchParams<{ customerId?: string | string[] }>();
  const initialCustomerId = Array.isArray(params.customerId) ? params.customerId[0] : params.customerId;
  const deps = useDispatchForm({
    initialCustomerId: initialCustomerId ?? null,
    // The dispatch is done — leave. Back to where he came from (the
    // dashboard, the job logs, or the AMC tab on the deep link); a cold
    // entry with nothing behind it lands on the log instead.
    onCreated: () => {
      if (router.canGoBack()) router.back();
      else router.replace('/jobs');
    },
  });

  if (actor?.role !== 'owner' && !flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Dispatch Job</Text>
      </View>
    );
  }

  return (
    // The frame reaches the status bar; the bottom inset belongs to the
    // tab bar (the console's other routes, 2026-09-17).
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <DispatchJobScreen {...deps} />
    </SafeAreaView>
  );
}
