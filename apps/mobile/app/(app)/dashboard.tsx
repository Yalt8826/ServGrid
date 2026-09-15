/**
 * Dashboard route (UI/plan-2/04-TECHNICIAN.md §T1, 05-DISPATCHER.md
 * §D1, 06-SALES-REP.md §S1). The seam where a pure dashboard screen meets
 * its data — per role, because the roles read through different
 * architectures:
 *
 * - **technician** — `useTechnicianWork` reads the server's work read
 *   (online-only, PLAN-FRONTEND.md §4), and the `tech.jobs` flag keeps
 *   the screen dark until the server turns it on (PLAN-EXECUTION.md §3).
 * - **dispatcher** (T2.7) — online-only: `DispatcherDashboardRoute`
 *   reads the api through react-query, `dispatch.console` gates the
 *   screen the same way, and the offline banner lives in the screen.
 *   Its hooks live in their own component (not this one) so a
 *   technician's session never mounts a dispatcher query.
 * - **sales rep** (T3.7) — online reads through `useRepDashboard`, with
 *   the per-flag darks the hook computes (`salesOff` / `paymentsOff`).
 *   Renewing soon comes from the loader below — the contracts backend
 *   is a later phase, so today it honestly returns [].
 * - **owner** (T4.8) — online-only reads through `useOwnerDashboard`
 *   (the figures and attention feed have no sync working set); the door
 *   is the api's permission gate, which 403s every role but the owner,
 *   and the screen itself branches on density for the two layouts.
 *
 * Nothing here spins while flags load: the answer arrives when the
 * session does, and the placeholder is the honest dark.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { RepDashboardScreen } from '../../src/screens/rep/DashboardScreen';
import { useRepDashboard } from '../../src/screens/rep/useRepData';
import { DispatcherDashboardScreen } from '../../src/screens/dispatcher/dashboard';
import {
  todayLabelOf,
  useDispatchConsoleFlag,
  useDispatcherDashboard,
} from '../../src/screens/dispatcher/useDispatcherDashboard';
import { DashboardScreen } from '../../src/screens/technician/DashboardScreen';
import { useTechJobsFlag, useTechnicianWork } from '../../src/screens/technician/useTechnicianWork';
import { OwnerDashboardScreen } from '../../src/screens/owner/dashboard';
import { useOwnerDashboard } from '../../src/screens/owner/useOwnerDashboard';
import { useSessionStore } from '../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

/** The rep's half of the route (T3.7, §S1). Online-only: nothing is ever
 * queued on the handset, so the figures are never stale-marked. */
function RepDashboardRoute(): React.ReactNode {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const dashboard = useRepDashboard();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <RepDashboardScreen
        name={actor?.username ?? ''}
        pendingSyncCount={0}
        figures={
          dashboard.data === null
            ? null
            : { soldThisMonth: dashboard.data.soldThisMonth, outstanding: dashboard.data.outstanding }
        }
        figuresError={dashboard.errors.figures}
        salesOff={dashboard.salesOff}
        paymentsOff={dashboard.paymentsOff}
        owesTheMost={dashboard.data?.owesTheMost ?? []}
        renewingSoon={dashboard.data?.renewingSoon ?? []}
        renewalsError={dashboard.errors.renewals}
        recentPayments={dashboard.data?.recentPayments ?? []}
        paymentsError={dashboard.errors.payments}
        companyNames={{}}
        onNewSale={() => router.push('/sales/new')}
        onOpenCompany={(companyId) => router.push(`/companies/${companyId}`)}
        onOpenPayments={() => router.push('/payments')}
        onRetry={dashboard.reload}
      />
    </SafeAreaView>
  );
}

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

/** The owner's half of the route (T4.8, §O1): online-only reads; the
 * density branch inside the screen produces the phone cards and the
 * desk row-and-table from the same injected data. */
function OwnerDashboardRoute(): React.ReactNode {
  const router = useRouter();
  const data = useOwnerDashboard(new Date());

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerDashboardScreen
        now={new Date()}
        offline={data.offline}
        figures={data.figures}
        jobsPerDay={data.jobsPerDay}
        revenuePerWeek={data.revenuePerWeek}
        dashboardError={data.dashboardError}
        attention={data.attention}
        attentionError={data.attentionError}
        onRetry={data.retry}
        onOpenRow={(target) => router.push(target)}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianWork(actor);

  if (actor === null) {
    // Unreachable through the layout (RoleGate redirects first); a
    // session tearing down mid-render still paints its screen.
    return (
      <View style={styles.root}>
        <Text>Dashboard</Text>
      </View>
    );
  }

  if (actor.role === 'sales_rep') {
    // T3.7 — the rep's dashboard. Its hook mounts only in the rep's
    // component above, never under a technician's or dispatcher's session.
    return <RepDashboardRoute />;
  }

  if (actor.role === 'dispatcher') {
    // T2.7 — the dispatcher's dashboard. Its hooks mount only in the
    // dispatcher's component above.
    return <DispatcherDashboardRoute />;
  }

  if (actor.role === 'owner') {
    // T4.8 — the owner's dashboard. Its hook mounts only in the owner's
    // component above, never under a field role's session.
    return <OwnerDashboardRoute />;
  }

  if (actor.role !== 'technician' || !flag.flagOn || deps === null) {
    // Dark without the flag; the owner's other screens are Phase 4's tasks.
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
        pendingCount={0}
        draining={deps.refreshing}
        onRefresh={deps.refresh}
        onStartJob={deps.startJob}
        onNavigate={deps.navigate}
        onOpenJob={(view) => router.push(`/jobs/${view.job.id}`)}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
