/**
 * Dashboard route (UI/plan-2/04-TECHNICIAN.md §T1). The seam where the
 * pure `DashboardScreen` meets the mirror, the outbox and the session —
 * `useTechnicianMirror` owns the plumbing, the screen owns the pixels.
 *
 * The route is role- and flag-aware: `/dashboard` is an `open` route
 * every role lands on, but the technician's dashboard is this task's
 * surface — a dispatcher or owner session keeps the placeholder until
 * Phases 2 and 4 build theirs, and the `tech.jobs` flag keeps the
 * screen dark until the server turns it on (PLAN-EXECUTION.md §3).
 * Nothing here spins: the mirror is local, and the flag answer arrives
 * when the session does.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { DashboardScreen } from '../../src/screens/technician/DashboardScreen';
import { useTechJobsFlag, useTechnicianMirror } from '../../src/screens/technician/useTechnicianMirror';
import { useSessionStore } from '../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianMirror(actor);

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null) {
    // Dark without the flag; a different role's dashboard is another
    // phase's task.
    return (
      <View style={styles.root}>
        <Text>Dashboard</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DashboardScreen
        name={actor.username}
        jobs={deps.views}
        completedAtById={deps.completedAtById}
        health={deps.health}
        onHealthFix={() => router.push('/ladder')}
        pendingCount={deps.pendingCount}
        draining={deps.draining}
        onRefresh={deps.refresh}
        onStartJob={deps.startJob}
        onNavigate={deps.navigate}
        onOpenJob={(view) => router.push(`/jobs/${view.job.id}`)}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
