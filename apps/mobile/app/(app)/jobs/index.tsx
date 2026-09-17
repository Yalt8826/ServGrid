/**
 * Jobs route (UI/plan-2/04-TECHNICIAN.md §T2; the owner's copy §O4,
 * T4.11; the dispatcher's D2, 05-DISPATCHER.md). Role split:
 *
 * - **Technician branch:** `JobsScreen` behind `tech.jobs`, fed by the
 *   server's work read (`useTechnicianWork`, online-only).
 * - **Owner branch (T4.11):** the same job, the owner's surface — the
 *   schema-shaped list (`JobCardOwner` carries the amount the
 *   dispatcher's schema never will), the dispatcher's filter bar on the
 *   phone, the desk table and side detail under the NavShell's desk
 *   density.
 * - **Dispatcher branch (2026-09-17):** D2 itself. `NAV_GROUPS.dispatcher`
 *   puts `/jobs` under the **Operations** tab, so this path IS the job
 *   logs — it rendered the bare `Jobs` placeholder until now, which is
 *   what a dispatcher saw on tapping the tab they use most. `/jobs/logs`
 *   stays the same screen with its own URL (the dashboard's button and
 *   the load-row tap link to it); the filter state lives in the query
 *   string either way.
 */
import { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { FRAME, SEMANTIC } from '@servgrid/shared';
import { JobsScreen } from '../../../src/screens/technician/JobsScreen';
import { useTechJobsFlag, useTechnicianWork } from '../../../src/screens/technician/useTechnicianWork';
import { OwnerJobsScreen } from '../../../src/screens/owner/JobsScreen';
import { useOwnerJobDetail, useOwnerJobs } from '../../../src/screens/owner/useOwnerJobs';
import { JobLogsScreen } from '../../../src/screens/dispatcher/job-logs';
import { useDispatchJobLogsFlags, useJobLogs } from '../../../src/screens/dispatcher/useJobLogs';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function DispatcherJobLogsRoute(): React.ReactNode {
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
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <JobLogsScreen {...deps} />
    </SafeAreaView>
  );
}

function OwnerJobsRoute(): React.ReactNode {
  const router = useRouter();
  const jobs = useOwnerJobs();
  // The desk side detail's selection. On the phone this stays null and
  // the card tap pushes `/jobs/:id` instead — the spec's two frames for
  // one detail.
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const detail = useOwnerJobDetail(selectedJobId);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerJobsScreen
        offline={jobs.offline}
        loading={jobs.loading}
        error={jobs.error}
        rows={jobs.rows}
        technicians={jobs.technicians}
        filters={jobs.filters}
        query={jobs.query}
        amendFlagOn={jobs.amendFlagOn}
        amendBusy={detail.amend.amendBusy}
        amendError={detail.amend.amendError}
        reopenBusy={detail.amend.reopenBusy}
        detail={detail.detail}
        detailLoading={detail.detailLoading}
        detailError={detail.detailError}
        onAmend={detail.amend.onAmend}
        onReopen={detail.amend.onReopen}
        onRetry={detail.reload}
        onFiltersChange={jobs.onFiltersChange}
        onQueryChange={jobs.onQueryChange}
        onOpenJob={(jobId) => router.push(`/jobs/${jobId}`)}
        onRetryList={jobs.onRetry}
        onLoadMore={jobs.onLoadMore}
        selectedJobId={selectedJobId}
        onSelectJob={setSelectedJobId}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianWork(actor);

  if (actor !== null && actor.role === 'owner') {
    return <OwnerJobsRoute />;
  }

  if (actor !== null && actor.role === 'dispatcher') {
    return <DispatcherJobLogsRoute />;
  }

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null) {
    return (
      <View style={styles.root}>
        <Text>Jobs</Text>
      </View>
    );
  }

  return (
    // The frame's ground, top edge only — the dashboard's treatment: the
    // screen's navy header runs to the status bar, and the bottom inset
    // belongs to the shell that draws the tab bar (2026-09-16).
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <JobsScreen
        jobs={deps.views}
        completedAtById={deps.completedAtById}
        onOpenJob={(view) => router.push(`/jobs/${view.job.id}`)}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
