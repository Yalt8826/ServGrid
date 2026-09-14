/**
 * T4.1 spike route — `/spike/rnw-desktop` (THROWAWAY).
 *
 * Same pattern as `/spike/job-logs`: deliberately at the ROOT of the
 * route tree, outside the `(app)` group, so no shared `navmap.ts` /
 * RoleGate edit is needed. Deleted with the rest of the spike when the
 * verdict is recorded.
 *
 * Web-only in practice: the spike measures react-native-web rendering.
 * Open at `/spike/rnw-desktop` in a browser against the web export
 * (`pnpm -F mobile bundle:check` output, or `expo start --web`).
 */
import { View } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { DeskShell } from '../../src/spikes/rnw-desktop/DeskShell';
import { generateDeskJobs } from '../../src/spikes/rnw-desktop/mockJobs';

// Generated once per app launch — the harness needs a stable volume,
// and the fixture is seeded (deterministic for a given day).
const JOBS = generateDeskJobs(new Date());

const styles = {
  root: { flex: 1, backgroundColor: SEMANTIC.bg.app },
};

export default function SpikeRnwDesktopRoute() {
  return (
    <View style={styles.root}>
      <DeskShell jobs={JOBS} />
    </View>
  );
}
