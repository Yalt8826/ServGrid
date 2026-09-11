/**
 * T1.22 spike route — `/spike/job-logs` (THROWAWAY).
 *
 * Deliberately at the ROOT of the route tree, outside the `(app)` group:
 * `(app)` wraps every route in RoleGate → navmap, and adding a spike
 * route there would mean editing the shared `navmap.ts` and shipping a
 * dispatcher entry in the technician's Phase 1 shell. A root route needs
 * no registration beyond the file itself, touches no shared file, and
 * is deleted with the rest of the spike when the trial is scored.
 *
 * It renders the prototype with the generated 220-job fixture; the
 * clock is the real one, so "today" is the trial day. Navigation is
 * inert — rows log a selection; the trial measures finding, not
 * opening. Reach it via the dev menu or `expo start` deep link; it is
 * not in any nav map on purpose.
 */
import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { JobLogsScreen } from '../../src/spikes/job-logs/JobLogsScreen';
import { generateJobs } from '../../src/spikes/job-logs/mockJobs';

// Generated once per app launch — the trial needs a stable volume, and
// the fixture is deterministic for a given day anyway (seeded).
const JOBS = generateJobs(new Date());

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: SEMANTIC.bg.app },
});

export default function SpikeJobLogsRoute() {
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
      <JobLogsScreen jobs={JOBS} now={new Date()} onOpenJob={() => {}} />
    </SafeAreaView>
  );
}
