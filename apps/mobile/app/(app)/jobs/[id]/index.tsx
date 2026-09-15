/**
 * Job detail route (UI/plan-2/04-TECHNICIAN.md §T3, T1.18; the owner's
 * copy §O4, T4.11). Role split:
 *
 * - **Technician branch:** `JobDetailScreen` behind `tech.jobs`, fed by
 *   the server's work read and the job's own trail; an id his work read
 *   does not hold shows the placeholder rather than a fake docket.
 * - **Owner branch (T4.11):** the pushed detail screen — the full
 *   `job_events` timeline, the completion with its figures and parts,
 *   and the amend action. The phone frame of the same detail the desk
 *   table opens as a side pane.
 *
 * The two rejection-banner actions both read the server again: the
 * refusal is cleared and the office's version of the job arrives.
 */
import { Linking, Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { JobDetailScreen } from '../../../../src/screens/technician/JobDetailScreen';
import { useJobTimeline, useTechJobsFlag, useTechnicianWork } from '../../../../src/screens/technician/useTechnicianWork';
import { OwnerJobDetailBody } from '../../../../src/screens/owner/JobDetailBody';
import { useOwnerAmendFlag, useOwnerJobCard, useOwnerJobDetail } from '../../../../src/screens/owner/useOwnerJobs';
import { useSessionStore } from '../../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerJobDetailRoute({ jobId }: { jobId: string }): React.ReactNode {
  const card = useOwnerJobCard(jobId);
  const detail = useOwnerJobDetail(jobId);
  const amendFlagOn = useOwnerAmendFlag();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerJobDetailBody
        card={card.card}
        detail={detail.detail}
        detailLoading={detail.detailLoading || card.loading}
        detailError={detail.detailError ?? card.error}
        amendFlagOn={amendFlagOn}
        amendBusy={detail.amend.amendBusy}
        amendError={detail.amend.amendError}
        reopenBusy={detail.amend.reopenBusy}
        onAmend={detail.amend.onAmend}
        onReopen={detail.amend.onReopen}
        onRetry={detail.reload}
        testID="owner-job-detail-screen"
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = Array.isArray(params.id) ? params.id[0] : params.id;
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianWork(actor);
  const events = useJobTimeline(actor?.role === 'technician' && jobId !== undefined ? jobId : null);

  if (actor !== null && actor.role === 'owner' && jobId !== undefined) {
    return <OwnerJobDetailRoute jobId={jobId} />;
  }

  const view = jobId === undefined || deps === null ? null : (deps.views.find((v) => v.job.id === jobId) ?? null);

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null || view === null) {
    return (
      <View style={styles.root}>
        <Text>Job detail</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <JobDetailScreen
        view={view}
        events={events}
        completedAt={deps.completedAtById[view.job.id] ?? null}
        onBack={() => router.back()}
        onCall={(v) => {
          if (v.job.contactPhone !== null) void Linking.openURL(`tel:${v.job.contactPhone}`);
        }}
        onNavigate={deps.navigate}
        onStartJob={deps.startJob}
        onComplete={(v) => router.push(`/jobs/${v.job.id}/complete`)}
        onCancel={(v) => router.push(`/jobs/${v.job.id}/cancel`)}
        onRefresh={deps.refresh}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
