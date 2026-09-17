/**
 * Job Logs route (UI/plan-2/05-DISPATCHER.md §D2, T2.8). The seam where
 * the pure JobLogsScreen meets the api — `useJobLogs` owns the reads,
 * the URL owns the filter state, and `dispatch.console` keeps the screen
 * dark until the server turns it on (PLAN-EXECUTION.md §3).
 *
 * The route needs no navmap entry of its own: `/jobs/logs` inherits the
 * `/jobs` guard (`job` × `read`) through the nearest-ancestor walk, the
 * same path every job detail route takes. Reached from the dispatcher's
 * dashboard ("Job Logs", D2 being the screen D1 hands to).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FRAME } from '@servgrid/shared';
import { JobLogsScreen } from '../../../src/screens/dispatcher/job-logs';
import { useJobLogs, useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const deps = useJobLogs();

  if (!flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Job Logs</Text>
      </View>
    );
  }

  return (
    // The frame reaches the status bar; the bottom inset belongs to the
    // tab bar (the dispatcher dashboard's own arrangement).
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <JobLogsScreen {...deps} />
    </SafeAreaView>
  );
}
