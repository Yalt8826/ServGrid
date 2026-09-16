/**
 * New AMC — route (T2B.4, §D5 "Form"). One route, three modes: `new`
 * (blank, start today), `renew` (prefilled from the AMC being renewed —
 * start the day after its end, same price) and `edit` (prefilled, PATCH
 * under `If-Match`). The route owns the reads (the source contract), the
 * submit (validate → create or update → straight to the saved AMC's
 * detail) and the overlap's translation: a `DUPLICATE_ENTITY` refusal's
 * `details.existing` becomes the Open-<number> link — never the raw
 * code. Same role and flag checks as the AMC tab.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { AmcFormScreen } from '../../../src/screens/contracts/AmcFormScreen';
import {
  editDraftOf,
  newDraft,
  renewalDraftOf,
  validateAmcDraft,
  type AmcDraft,
} from '../../../src/screens/contracts/model';
import { useContractDetail, useSaveContract } from '../../../src/screens/contracts/useContracts';
import { useCustomerSearch } from '../../../src/screens/dispatcher/useCustomerSearch';
import { istBusinessDate } from '../../../src/screens/dispatcher/useDispatcherDashboard';
import type { Contract } from '@servgrid/shared';
import { WriteNotSaved } from '../../../src/lib/intentWrite';
import { isFlagOn } from '../../../src/state/featureFlags';
import { useFlagsReady } from '../../../src/state/useFlagsReady';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

interface SaveError {
  message: string;
  existing: { id: string; contractNumber: string } | null;
}

function AmcFormRoute({ renewOf, editId }: { renewOf: string | null; editId: string | null }): React.ReactNode {
  const router = useRouter();
  const mode = editId !== null ? 'edit' : renewOf !== null ? 'renew' : 'new';
  const sourceId = editId ?? renewOf;
  const source = useContractDetail(sourceId ?? '');
  const { create, update, saving } = useSaveContract();
  const customerSearch = useCustomerSearch();

  const [draft, setDraft] = useState<AmcDraft>(() => newDraft(istBusinessDate(new Date())));
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  // The source contract's arrival builds the draft ONCE — a re-render
  // must never clobber what the dispatcher has since typed. The renew
  // and edit drafts carry the original's customer, so the search stays
  // untouched (read-only there anyway).
  const [draftedFrom, setDraftedFrom] = useState<string | null>(null);
  useEffect(() => {
    const contract = source.detail?.contract ?? null;
    if (contract === null || draftedFrom !== null) return;
    setDraft(draftOrNew(contract, renewOf, editId, istBusinessDate(new Date())));
    setDraftedFrom(contract.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.detail, draftedFrom]);

  // In `new` mode the picked customer becomes the draft's customer.
  useEffect(() => {
    if (mode !== 'new') return;
    const selected = customerSearch.selected;
    if (selected === null) return;
    setDraft((current) => (current.customerId === selected.id ? current : { ...current, customerId: selected.id, customerName: selected.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerSearch.selected]);

  const submit = async (): Promise<void> => {
    setSaveError(null);
    if (
      validateAmcDraft(draft).customer !== undefined ||
      validateAmcDraft(draft).endDate !== undefined ||
      validateAmcDraft(draft).contractValue !== undefined
    ) {
      // The screen renders the sentences under the fields; the route
      // refuses to spend a request the schema would refuse.
      return;
    }
    const original = source.detail?.contract ?? null;
    try {
      const saved =
        mode === 'edit' && original !== null
          ? await update(original, draft)
          : await create({
              customerId: draft.customerId ?? '',
              startDate: draft.startDate,
              endDate: draft.endDate,
              contractValue: draft.contractValue,
              notes: draft.notes === '' ? null : draft.notes,
            });
      router.replace(`/contracts/${saved.id}`);
    } catch (e) {
      // The overlap: the server's sentence stays, and the existing AMC
      // becomes a link. The raw code never renders.
      const existingDetails = e instanceof WriteNotSaved ? (e.details as { existing?: { id: string; contractNumber: string } } | null) : null;
      setSaveError({
        message: e instanceof Error ? e.message : 'The AMC could not be saved. Try again.',
        existing: e instanceof WriteNotSaved && e.code === 'DUPLICATE_ENTITY' && existingDetails?.existing ? existingDetails.existing : null,
      });
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <AmcFormScreen
        mode={mode}
        draft={draft}
        onChange={setDraft}
        customerSearch={{
          query: customerSearch.query,
          results: customerSearch.results,
          error: customerSearch.error,
          onQueryChange: customerSearch.setQuery,
          onSelect: customerSearch.select,
          onClear: customerSearch.clear,
        }}
        saving={saving}
        saveError={saveError}
        onOpenExisting={(id) => router.push(`/contracts/${id}`)}
        onSubmit={() => void submit()}
      />
    </SafeAreaView>
  );
}

/** The draft the route opens with, per mode. */
function draftOrNew(
  contract: Contract,
  renewOf: string | null,
  editId: string | null,
  todayIso: string,
): AmcDraft {
  if (editId !== null && contract.id === editId) return editDraftOf(contract);
  if (renewOf !== null && contract.id === renewOf) return renewalDraftOf(contract);
  return newDraft(todayIso);
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  const params = useLocalSearchParams<{ renewOf?: string | string[]; editId?: string | string[] }>();
  const flagsReady = useFlagsReady();
  if (actor === null) return null;
  if (actor.role !== 'dispatcher' && actor.role !== 'owner') {
    return (
      <View style={styles.root}>
        <Text>New AMC</Text>
      </View>
    );
  }
  // Unknown flags read as off on a cold browser load — wait for the
  // /auth/me answer before rendering the honest dark placeholder.
  if (!flagsReady || !isFlagOn('contracts.manage')) {
    return (
      <View style={styles.root}>
        <Text>New AMC</Text>
      </View>
    );
  }
  const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
  return <AmcFormRoute renewOf={first(params.renewOf)} editId={first(params.editId)} />;
}
