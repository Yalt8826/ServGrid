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
 * One intent, one key — keyed by the body. The writer used to live for
 * the whole sheet; but the Free ↔ Charge choice (decision 9) can change
 * the body between attempts, and the server refuses a changed body under
 * an old key (422 `IDEMPOTENCY_KEY_REUSED`). `bodyKeyedWriters` starts a
 * new writer — a new key — whenever the payload's JSON differs from the
 * last attempt's, and replays the pinned key when the body is unchanged
 * (the dropped-connection retry). `completedAt` is pinned inside the
 * sheet, so the same form state still produces the same body.
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
import { createIntentWriter } from '../../../../src/lib/intentWrite';
import { choosePhoto, takePhoto, uploadAttachment } from '../../../../src/lib/photo';
import { CompleteSheet } from '../../../../src/screens/technician/CompleteSheet';
import { bodyKeyedWriters, withSiteFix, type PartProduct } from '../../../../src/screens/technician/completeSheet';
import { captureSiteFix, type SiteFix } from '../../../../src/location/siteFix';
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
  // One key per submit intent, keyed by the body: an unchanged body
  // replays the pinned key (the dropped-connection retry), a changed
  // body — Free ↔ Charge — starts a new intent under a new key.
  const writers = useRef<ReturnType<typeof bodyKeyedWriters> | null>(null);
  // The on-site fix, captured ONCE per sheet. `undefined` = not asked yet,
  // `null` = asked and the device could not say. It is held across
  // attempts on purpose: the write is keyed by its body, so a fix that
  // moved between the first try and its retry would look like a new
  // intent and could file the completion twice.
  const fix = useRef<SiteFix | null | undefined>(undefined);

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
        services={deps.services}
        role={actor.role}
        // The camera, the library and the upload — wired here so the sheet
        // itself stays renderable without a device (2026-09-16). Photos are
        // filed against the job CARD: it exists the moment he taps, where
        // the completion row only exists after submit (migration 008's
        // before/after split).
        takePhoto={takePhoto}
        choosePhoto={choosePhoto}
        uploadPhoto={(fileUri) => uploadAttachment({ ownerType: 'job_card', ownerId: view.job.id, kind: 'photo', fileUri })}
        now={new Date()}
        onDismiss={() => router.back()}
        onSubmit={async (payload) => {
          if (fix.current === undefined) fix.current = await captureSiteFix();
          const body = withSiteFix(payload, fix.current);
          writers.current ??= bodyKeyedWriters(() => createIntentWriter(intentRequest));
          await writers.current.writerFor(JSON.stringify(body)).send('POST', `/v1/jobs/${view.job.id}/complete`, body);
          void queryClient.invalidateQueries({ queryKey: TECHNICIAN_WORK_KEY });
          void queryClient.invalidateQueries({ queryKey: jobEventsKey(view.job.id) });
        }}
      />
    </SafeAreaView>
  );
}
