/**
 * Dispatch Job route (UI/plan-2/05-DISPATCHER.md §D3, T2.9). The seam
 * where the pure DispatchJobScreen meets the api — `useDispatchForm`
 * owns the reads and the submit, and `dispatch.console` keeps the
 * screen dark until the server turns it on (PLAN-EXECUTION.md §3).
 *
 * The route needs no navmap entry of its own: `/jobs/new` carries the
 * `job` × `create` guard in ROUTE_GUARDS, dispatcher + owner, and sits
 * in both roles' Operations group. Reached from the dispatcher's
 * dashboard ("+ Dispatch a job", D1 being the screen that hands here).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { DispatchJobScreen } from '../../../src/screens/dispatcher/dispatch';
import { useDispatchForm } from '../../../src/screens/dispatcher/useDispatchForm';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const deps = useDispatchForm();

  if (!flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Dispatch Job</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DispatchJobScreen {...deps} />
    </SafeAreaView>
  );
}
