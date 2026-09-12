/**
 * Complete sheet route (UI/plan-2/04-TECHNICIAN.md §T4, T1.19). The seam
 * where the pure `CompleteSheet` meets the mirror, the outbox and the
 * session — the screen owns the pixels, this file owns the optimistic
 * write, exactly like the detail route beside it.
 *
 * The optimistic completion (§5): the mirror's job moves to `completed`
 * FIRST (the detail screen behind already shows the closed docket), then
 * the row is enqueued to `POST /v1/jobs/:id/completions`; a failed
 * enqueue is reverted — a mirror that ran ahead of a queue that does not
 * exist is silent data loss.
 *
 * The delivery signal (`watchOutboxRow`) polls the row the enqueue
 * returned — one-shot, self-stopping: it fires when the row leaves
 * `queued` (`done` after a drain, `rejected` after a refusal) and then
 * cancels itself. The sheet listens for `done` and fires the Success
 * haptic — delivery, not intent — which is why the watcher keeps living
 * after the sheet has dismissed.
 *
 * Role- and flag-aware like the detail route: `tech.jobs` keeps the
 * screen dark until the server turns it on; another role keeps the
 * placeholder until its phases build their own surfaces.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import type { Mirror } from '../../../../src/db/mirror';
import { enqueue, rowById } from '../../../../src/sync/outbox';
import { moveJobStatus, revertJobStatus } from '../../../../src/screens/technician/jobData';
import { CompleteSheet } from '../../../../src/screens/technician/CompleteSheet';
import type { PartProduct } from '../../../../src/screens/technician/completeSheet';
import { technicianMirror, useTechJobsFlag, useTechnicianMirror } from '../../../../src/screens/technician/useTechnicianMirror';
import { useSessionStore } from '../../../../src/state/sessionStore';

const CATEGORIES: readonly PartProduct['category'][] = ['ups', 'battery', 'inverter', 'accessory', 'spare'];

/** How often the delivery signal re-reads the row it watches. The drain
 * runs on its own triggers; this only observes the verdict. */
const WATCH_INTERVAL_MS = 2000;

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
  const products: PartProduct[] =
    deps === null
      ? []
      : deps.products
          .filter((product): product is { id: string; name: string; category: PartProduct['category'] } =>
            (CATEGORIES as readonly string[]).includes(product.category),
          )
          .map((product) => ({ id: product.id, name: product.name, category: product.category }));

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
        <Text>Complete sheet</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CompleteSheet
        view={view}
        products={products}
        role={actor.role}
        now={new Date()}
        onDismiss={() => router.back()}
        onSubmit={async (payload) => {
          // §5: the mirror moves first, the row goes in the outbox
          // second; a failed enqueue is reverted.
          const previous = moveJobStatus(mirror.database, view.job.id, 'completed');
          if (previous === null) throw new Error('The job is no longer in the mirror.');
          try {
            const row = await enqueue(mirror.database, {
              employeeId,
              method: 'POST',
              path: `/v1/jobs/${view.job.id}/completions`,
              body: payload,
              entityType: 'job',
              entityLocalId: view.job.id,
            });
            return row.id;
          } catch (error) {
            revertJobStatus(mirror.database, view.job.id, previous);
            throw error;
          }
        }}
        watchOutboxRow={(rowId, onSettled) => {
          // One-shot, self-stopping: fire when the row leaves `queued`,
          // then cancel — the sheet's listener runs at most once.
          let timer: ReturnType<typeof setInterval> | null = null;
          const check = (): void => {
            const row = rowById(mirror.database, rowId);
            if (row === null || row.status === 'queued') return;
            if (timer !== null) clearInterval(timer);
            onSettled(row.status);
          };
          timer = setInterval(check, WATCH_INTERVAL_MS);
          return () => {
            if (timer !== null) clearInterval(timer);
          };
        }}
      />
    </SafeAreaView>
  );
}
