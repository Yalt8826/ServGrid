/**
 * Jobs route (UI/plan-2/04-TECHNICIAN.md §T2; the owner's copy §O4,
 * T4.11). Role split:
 *
 * - **Technician branch:** the mirror-backed `JobsScreen` behind
 *   `tech.jobs` — the seam where the pure screen meets the mirror and
 *   the session; nothing here spins, the mirror is local.
 * - **Owner branch (T4.11):** the same job, the owner's surface — the
 *   schema-shaped list (`JobCardOwner` carries the amount the
 *   dispatcher's schema never will), the dispatcher's filter bar on the
 *   phone, the desk table and side detail under the NavShell's desk
 *   density.
 */
import { useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { JobsScreen } from '../../../src/screens/technician/JobsScreen';
import { useTechJobsFlag, useTechnicianMirror } from '../../../src/screens/technician/useTechnicianMirror';
import { OwnerJobsScreen } from '../../../src/screens/owner/JobsScreen';
import { useOwnerJobDetail, useOwnerJobs } from '../../../src/screens/owner/useOwnerJobs';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

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
  const deps = useTechnicianMirror(actor);

  if (actor !== null && actor.role === 'owner') {
    return <OwnerJobsRoute />;
  }

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
