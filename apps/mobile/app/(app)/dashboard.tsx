/**
 * Dashboard route (UI/plan-2/04-TECHNICIAN.md §T1, 05-DISPATCHER.md
 * §D1). The seam where a pure dashboard screen meets its data — per
 * role, because the two roles read through different architectures:
 *
 * - **technician** — `useTechnicianMirror` owns the plumbing; the
 *   mirror is the source, no fetch behind the figures (PLAN-FRONTEND.md
 *   §4), and the `tech.jobs` flag keeps the screen dark until the
 *   server turns it on (PLAN-EXECUTION.md §3).
 * - **dispatcher** (T2.7) — online-only: `DispatcherDashboardRoute`
 *   reads the api through react-query, `dispatch.console` gates the
 *   screen the same way, and the offline banner lives in the screen.
 *   Its hooks live in their own component (not this one) so a
 *   technician's session never mounts a dispatcher query.
 *
 * An owner session keeps the placeholder until Phase 4 builds theirs.
 * Nothing here spins while flags load: the answer arrives when the
 * session does, and the placeholder is the honest dark.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { DispatcherDashboardScreen } from '../../src/screens/dispatcher/dashboard';
import {
  todayLabelOf,
  useDispatchConsoleFlag,
  useDispatcherDashboard,
} from '../../src/screens/dispatcher/useDispatcherDashboard';
import { DashboardScreen } from '../../src/screens/technician/DashboardScreen';
import { useTechJobsFlag, useTechnicianMirror } from '../../src/screens/technician/useTechnicianMirror';
import { useSessionStore } from '../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

/** The dispatcher's half of the route (T2.7): online-only reads, gated
 * on `dispatch.console` — the same flag the api's summary and roster
 * endpoints answer to, so the screen and the server go dark together. */
function DispatcherDashboardRoute(): React.ReactNode {
  const router = useRouter();
  const consoleFlag = useDispatchConsoleFlag();
  const data = useDispatcherDashboard(new Date());

  if (!consoleFlag.flagOn) {
    return (
      <View style={styles.root}>
        <Text>Dashboard</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DispatcherDashboardScreen
        now={new Date()}
        todayLabel={todayLabelOf(new Date())}
        offline={data.offline}
        figures={data.figures}
        figuresError={data.figuresError}
        load={data.load}
        loadError={data.loadError}
        sections={data.sections}
        sectionsError={data.sectionsError}
        onRetry={data.retry}
        onOpenJob={(jobId) => router.push(`/jobs/${jobId}`)}
        onDispatch={() => router.push('/jobs/new')}
        onOpenJobLogs={() => router.push('/jobs/logs')}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianMirror(actor);

  if (actor === null) {
    // Unreachable through the layout (RoleGate redirects first); a
    // session tearing down mid-render still paints its screen.
    return (
      <View style={styles.root}>
        <Text>Dashboard</Text>
      </View>
    );
  }

  if (actor.role === 'dispatcher') {
    // T2.7 — the dispatcher's dashboard. Its hooks mount only in the
    // dispatcher's component above.
    return <DispatcherDashboardRoute />;
  }

  if (actor.role !== 'technician' || !flag.flagOn || deps === null) {
    // Dark without the flag; the owner's dashboard is Phase 4's task.
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
