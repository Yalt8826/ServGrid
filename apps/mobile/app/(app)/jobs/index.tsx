/**
 * Jobs route (UI/plan-2/04-TECHNICIAN.md §T2). The seam where the pure
 * `JobsScreen` meets the mirror and the session — `useTechnicianMirror`
 * owns the plumbing, the screen owns the pixels.
 *
 * Role- and flag-aware exactly like the dashboard route: the
 * `tech.jobs` flag keeps the screen dark until the server turns it on,
 * and other roles keep the placeholder until their phases build their
 * own surfaces. Nothing here spins — the mirror is local.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { JobsScreen } from '../../../src/screens/technician/JobsScreen';
import { useTechJobsFlag, useTechnicianMirror } from '../../../src/screens/technician/useTechnicianMirror';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianMirror(actor);

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null) {
    return (
      <View style={styles.root}>
        <Text>Jobs</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <JobsScreen
        jobs={deps.views}
        completedAtById={deps.completedAtById}
        onOpenJob={(view) => router.push(`/jobs/${view.job.id}`)}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
