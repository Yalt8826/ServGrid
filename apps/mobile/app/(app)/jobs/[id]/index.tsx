/**
 * Job detail route (UI/plan-2/04-TECHNICIAN.md §T3, T1.18). The seam
 * where the pure `JobDetailScreen` meets the mirror and the session —
 * `useTechnicianMirror` owns the plumbing, the screen owns the pixels,
 * exactly like the dashboard and jobs routes.
 *
 * Role- and flag-aware like them: the `tech.jobs` flag keeps the screen
 * dark until the server turns it on, another role keeps the placeholder
 * until its phases build their own surfaces. Nothing here spins — the
 * mirror is local; an id the mirror does not hold shows the placeholder
 * rather than a fake docket.
 *
 * The two rejection-banner actions (`PLAN-FRONTEND.md` §5) both end at
 * the drain: this device's only copy is the mirror row, and the delta
 * overwrite IS the office version arriving. The full resolution flow —
 * clearing the kept rejection rows once the technician has judged them —
 * lands with the completion/cancellation rejection UX (T1.19/T1.20).
 */
import { Linking, Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { JobDetailScreen } from '../../../../src/screens/technician/JobDetailScreen';
import { useTechJobsFlag, useTechnicianMirror } from '../../../../src/screens/technician/useTechnicianMirror';
import { useSessionStore } from '../../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const jobId = Array.isArray(params.id) ? params.id[0] : params.id;
  const actor = useSessionStore((s) => s.actor);
  const flag = useTechJobsFlag();
  const deps = useTechnicianMirror(actor);

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
        events={deps.eventsByJobId[view.job.id] ?? []}
        completedAt={deps.completedAtById[view.job.id] ?? null}
        onBack={() => router.back()}
        onCall={(v) => {
          if (v.job.contactPhone !== null) void Linking.openURL(`tel:${v.job.contactPhone}`);
        }}
        onNavigate={deps.navigate}
        onStartJob={deps.startJob}
        onComplete={(v) => router.push(`/jobs/${v.job.id}/complete`)}
        onCancel={(v) => router.push(`/jobs/${v.job.id}/cancel`)}
        onDiscardMyCopy={deps.refresh}
        onViewOfficeVersion={deps.refresh}
        now={new Date()}
      />
    </SafeAreaView>
  );
}
