/**
 * Complete sheet route (UI/plan-2/04-TECHNICIAN.md §T4). The seam where the
 * pure `CompleteSheet` meets the API and the session — the screen owns the
 * pixels, this file owns the write.
 *
 * Online-only (decision 2026-09-15): the completion goes straight to
 * `POST /v1/jobs/:id/complete`. The sheet resolves when the server has it
 * and stays open with everything typed when it does not. (The queued
 * version sent `/completions`, a path the server never had, so no
 * completion from a handset was ever accepted.)
 *
 * One intent, one key: the writer lives as long as this sheet, so a retry
 * after a dropped connection replays the first request instead of filing
 * a second completion.
 *
 * Role- and flag-aware: `tech.jobs` keeps the screen dark until the server
 * turns it on; another role keeps the placeholder.
 */
import { useRef } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { SEMANTIC } from '@servgrid/shared';
import { createIntentWriter, type IntentWriter } from '../../../../src/lib/intentWrite';
import { CompleteSheet } from '../../../../src/screens/technician/CompleteSheet';
import type { PartProduct } from '../../../../src/screens/technician/completeSheet';
import {
  TECHNICIAN_WORK_KEY,
  intentRequest,
  jobEventsKey,
  useTechJobsFlag,
  useTechnicianWork,
} from '../../../../src/screens/technician/useTechnicianWork';
import { useSessionStore } from '../../../../src/state/sessionStore';

const CATEGORIES: readonly PartProduct['category'][] = ['ups', 'battery', 'inverter', 'accessory', 'spare'];

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
  const products: PartProduct[] =
    deps === null
      ? []
      : deps.products
          .filter((product): product is { id: string; name: string; category: PartProduct['category'] } =>
            (CATEGORIES as readonly string[]).includes(product.category),
          )
          .map((product) => ({ id: product.id, name: product.name, category: product.category }));

  if (actor === null || actor.role !== 'technician' || !flag.flagOn || deps === null || view === null) {
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
          writer.current ??= createIntentWriter(intentRequest);
          await writer.current.send('POST', `/v1/jobs/${view.job.id}/complete`, payload);
          void queryClient.invalidateQueries({ queryKey: TECHNICIAN_WORK_KEY });
          void queryClient.invalidateQueries({ queryKey: jobEventsKey(view.job.id) });
        }}
      />
    </SafeAreaView>
  );
}
