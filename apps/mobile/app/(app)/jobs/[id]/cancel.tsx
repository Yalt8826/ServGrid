/**
 * Cancel sheet route (UI/plan-2/04-TECHNICIAN.md §T5, T1.20). The seam
 * where the pure `CancelSheet` meets the mirror, the outbox and the
 * session — the screen owns the pixels, this file owns the optimistic
 * write, exactly like the complete route beside it.
 *
 * The optimistic cancellation (§5): the mirror's job moves to
 * `cancelled` FIRST (the detail screen behind already shows the frozen
 * docket), then the row is enqueued to `POST /v1/jobs/:id/cancel`
 * (PLAN-BACKEND.md §6.3 — the technician's on-site path, never the
 * office's PATCH-reschedule); a failed enqueue is reverted — a mirror
 * that ran ahead of a queue that does not exist is silent data loss. A
 * cancellation is a closer like a completion: it needs no delivery
 * watcher, because the rejection banner (§5) is the surface that speaks
 * when the server refuses.
 *
 * Role- and flag-aware like the complete route: `tech.jobs` keeps the
 * screen dark until the server turns it on; another role keeps the
 * placeholder until its phases build their own surfaces.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import type { Mirror } from '../../../../src/db/mirror';
import { enqueue } from '../../../../src/sync/outbox';
import { moveJobStatus, revertJobStatus } from '../../../../src/screens/technician/jobData';
import { CancelSheet } from '../../../../src/screens/technician/CancelSheet';
import { technicianMirror, useTechJobsFlag, useTechnicianMirror } from '../../../../src/screens/technician/useTechnicianMirror';
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

  const employeeId = actor?.role === 'technician' ? actor.id : null;
  const [mirror, setMirror] = useState<Mirror | null>(null);
  useEffect(() => {
    if (employeeId === null) return;
    let alive = true;
    void technicianMirror(employeeId).then((opened) => {
      if (alive) setMirror(opened);
    });
    return () => {
      alive = false;
    };
  }, [employeeId]);

  if (
    actor === null ||
    actor.role !== 'technician' ||
    !flag.flagOn ||
    deps === null ||
    view === null ||
    mirror === null ||
    employeeId === null
  ) {
    return (
      <View style={styles.root}>
        <Text>Cancel sheet</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CancelSheet
        view={view}
        now={new Date()}
        onDismiss={() => router.back()}
        onSubmit={async (payload) => {
          // §5: the mirror moves first, the row goes in the outbox
          // second; a failed enqueue is reverted.
          const previous = moveJobStatus(mirror.database, view.job.id, 'cancelled');
          if (previous === null) throw new Error('The job is no longer in the mirror.');
          try {
            await enqueue(mirror.database, {
              employeeId,
              method: 'POST',
              path: `/v1/jobs/${view.job.id}/cancel`,
              body: payload,
              entityType: 'job',
              entityLocalId: view.job.id,
            });
          } catch (error) {
            revertJobStatus(mirror.database, view.job.id, previous);
            throw error;
          }
        }}
      />
    </SafeAreaView>
  );
}
