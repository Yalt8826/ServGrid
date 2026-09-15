/**
 * Cancel sheet route (UI/plan-2/04-TECHNICIAN.md §T5). The seam where the
 * pure `CancelSheet` meets the API and the session — the screen owns the
 * pixels, this file owns the write.
 *
 * Online-only (decision 2026-09-15): the cancellation goes straight to
 * `POST /v1/jobs/:id/cancel` (PLAN-BACKEND.md §6.3 — the technician's
 * on-site path, never the office's PATCH-reschedule). The sheet resolves
 * when the server has it, and stays open with the reason he chose when it
 * does not — the record of a wasted trip is never lost. One intent, one
 * key, for as long as the sheet is open.
 *
 * Role- and flag-aware like the complete route.
 */
import { useRef } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { SEMANTIC } from '@servgrid/shared';
import { createIntentWriter, type IntentWriter } from '../../../../src/lib/intentWrite';
import { CancelSheet } from '../../../../src/screens/technician/CancelSheet';
import {
  TECHNICIAN_WORK_KEY,
  intentRequest,
  jobEventsKey,
  useTechJobsFlag,
  useTechnicianWork,
} from '../../../../src/screens/technician/useTechnicianWork';
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
  const deps = useTechnicianWork(actor);
  const queryClient = useQueryClient();
  const writer = useRef<IntentWriter | null>(null);

  const view = jobId === undefined || deps === null ? null : (deps.views.find((v) => v.job.id === jobId) ?? null);

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null || view === null) {
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
          writer.current ??= createIntentWriter(intentRequest);
          await writer.current.send('POST', `/v1/jobs/${view.job.id}/cancel`, payload);
          void queryClient.invalidateQueries({ queryKey: TECHNICIAN_WORK_KEY });
          void queryClient.invalidateQueries({ queryKey: jobEventsKey(view.job.id) });
        }}
      />
    </SafeAreaView>
  );
}
