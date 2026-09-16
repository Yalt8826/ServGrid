/**
 * The owner's customers screens (T4.11, UI/plan-2/07-OWNER.md §O4b) —
 * "the dispatcher's §D4 with the scope opened up", structurally: the
 * stack section and history rows are the DISPATCHER'S components, and
 * the three differences are the owner's additions on top:
 *
 * - **The company field is present** (create and edit — see the shared
 *   `CustomerFormScreen`'s capability prop) and the detail links
 *   through to the company ledger.
 * - **The product stack is editable.** The `StackSection` is mounted
 *   with `editable` (the prop the dispatcher's screen passes `false`
 *   for) — the owner is the correction path when a serial was typed
 *   wrong and the technician has moved on. Edits here stamp **no
 *   `source_job_id`**: the payloads below simply carry no such field,
 *   and that absence is the signal the change did not come from work
 *   done (PLAN-BACKEND.md §6.4).
 * - **Desktop is a table** — name · area · phone · company · units ·
 *   open jobs · last job — with a side detail. Not cards. The phone
 *   renders the same rows as cards, per the role's one rule.
 *
 * Pure UI over injected data; `useOwnerCustomers` is the wiring.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { STATUS, SEMANTIC, SPACE } from '@servgrid/shared';
import type { CustomerDetail } from '@servgrid/shared';
import { Button, EmptyState, Sheet, Skeleton, TextField, DatePicker } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import type { CustomerHistoryJob, CustomerStackUnit } from '../dispatcher/customer';
import { SiteFacts, StackSection } from '../dispatcher/customer';

/** The stack correction sheet's payload — EXACTLY the three fields
 * §6.4's PATCH takes. No `sourceJobId`, no `source_job_id`: the
 * absence is the signal that this edit did not come from work done. */
export interface StackItemPatchInput {
  serialNumber?: string;
  quantity?: number;
  warrantyExpiresOn?: string | null;
}

export interface OwnerCustomerDetailDeps {
  /** The owner-shape detail — it carries `companyId`, which the dispatcher's never does. */
  detail: CustomerDetail | null;
  loading: boolean;
  detailError: string | null;
  /** The linked account's name — the ledger link's label. */
  companyName: string | null;
  /** The stack, labelled for display — EDITABLE here (§O4b). */
  stack: CustomerStackUnit[] | null;
  /** The site's jobs, newest first, as the dispatcher's history rows. */
  history: CustomerHistoryJob[] | null;
  historyError: string | null;
  /** Opens the correction sheet on one unit. */
  onEditStackItemOpen(unitId: string): void;
  onCall(phone: string): void;
  /** The site's captured location, opened in a map. */
  onOpenMap?(latitude: number, longitude: number): void;
  onOpenJob(jobId: string): void;
  /** Through to the company ledger (§O4b). Null company → no link. */
  onOpenCompany(): void;
  onRetry(): void;
  // ── the correction path ──────────────────────────────────────────────
  /** The item the edit sheet is open on, with its If-Match version. */
  editing: { id: string; label: string; serialNumber: string; quantity: number; warrantyExpiresOn: string | null; version: number } | null;
  savingStack: boolean;
  stackError: string | null;
  onSaveStackItem(itemId: string, version: number, patch: StackItemPatchInput): void;
  onRemoveStackItem(itemId: string): void;
  onCloseSheet(): void;
  /** Closes the desk side detail — the jobs side detail's ✕ Close. */
  onClose?(): void;
  /**
   * Whether this body paints the site's name itself. True by default;
   * the PAGE passes false, because its header owns the name and two
   * headings for one site is the duplication the console spent a phase
   * removing (2026-09-17).
   */
  showName?: boolean;
  testID?: string;
}

function HistoryRow({ job, onPress, testID }: { job: CustomerHistoryJob; onPress: (id: string) => void; testID: string }): React.ReactNode {
  const tone = STATUS[job.status as keyof typeof STATUS] ?? STATUS.unassigned;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Job ${job.jobNumber}`}
      onPress={() => onPress(job.id)}
      style={styles.historyRow}
    >
      <View style={[styles.historyRail, { backgroundColor: tone }]} />
      <View style={styles.historyBody}>
        <Text numberOfLines={1} style={styles.historyLine1}>
          {job.title}
        </Text>
        <Text numberOfLines={1} style={styles.historyMeta}>
          {`${job.jobNumber} · ${job.technicianName ?? 'Unassigned'}${job.scheduledFor === null ? '' : ` · ${job.scheduledFor.slice(0, 10)}`}`}
        </Text>
      </View>
    </Pressable>
  );
}

export function OwnerCustomerDetailBody(deps: OwnerCustomerDetailDeps): React.ReactNode {
  const [serial, setSerial] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [warranty, setWarranty] = useState<string | null>(null);
  const detail = deps.detail;
  const editing = deps.editing;

  // Fill the edit sheet's fields once per opened item — a value the
  // owner already changed is never overwritten by a re-render.
  const [filledFor, setFilledFor] = useState<string | null>(null);
  if (editing !== null && filledFor !== editing.id) {
    setSerial(editing.serialNumber);
    setQuantity(String(editing.quantity));
    setWarranty(editing.warrantyExpiresOn);
    setFilledFor(editing.id);
  }

  const close = deps.onCloseSheet;

  return (
    <View style={styles.root} testID={deps.testID ?? 'owner-customer-detail'}>
      {deps.onClose !== undefined ? (
        <View style={styles.closeRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close detail"
            hitSlop={8}
            onPress={deps.onClose}
            style={styles.closeButton}
            testID="owner-customer-detail-close"
          >
            <Text style={styles.closeLabel}>✕ Close</Text>
          </Pressable>
        </View>
      ) : null}

      {deps.detailError !== null ? (
        <EmptyState message={deps.detailError} actionLabel="Retry" onAction={deps.onRetry} testID="owner-customer-detail-error" />
      ) : deps.loading && detail === null ? (
        <View style={styles.loading} testID="owner-customer-detail-loading">
          <Skeleton width="50%" height={20} />
          <Skeleton width="80%" height={14} />
        </View>
      ) : detail === null ? null : (
        <ScrollView contentContainerStyle={styles.content}>
          {deps.showName === false ? null : (
            <Text style={styles.title} testID="owner-customer-name">
              {detail.name}
            </Text>
          )}

          {deps.companyName !== null ? (
            <Pressable
              testID="owner-customer-company"
              accessibilityRole="link"
              onPress={deps.onOpenCompany}
              style={styles.companyRow}
            >
              <Text style={styles.companyLabel}>{deps.companyName}</Text>
              <Text style={styles.companyAction}>Ledger →</Text>
            </Pressable>
          ) : null}

          <View style={styles.section} testID="owner-customer-phones">
            <Text style={styles.sectionLabel}>Phone</Text>
            <Pressable
              testID="owner-customer-call-primary"
              accessibilityRole="button"
              accessibilityLabel={`Call ${detail.phone}`}
              onPress={() => deps.onCall(detail.phone)}
              style={styles.phoneRow}
            >
              <Text style={styles.phoneValue}>{detail.phone}</Text>
              <Text style={styles.phoneAction}>Call</Text>
            </Pressable>
            {detail.altPhone !== null ? (
              <Pressable
                testID="owner-customer-call-alt"
                accessibilityRole="button"
                accessibilityLabel={`Call ${detail.altPhone}`}
                onPress={() => deps.onCall(detail.altPhone!)}
                style={styles.phoneRow}
              >
                <Text style={styles.phoneValue}>{detail.altPhone}</Text>
                <Text style={styles.phoneAction}>Call</Text>
              </Pressable>
            ) : null}
          </View>

          {/* The address and the captured location — the SAME block the
          dispatcher's phone mounts, so a site never reads two ways. */}
          <SiteFacts facts={detail} onOpenMap={deps.onOpenMap} />

          {/* The stack, EDITABLE — the owner is the correction path
          (§O4b). Same `StackSection` the dispatcher mounts read-only. */}
          <StackSection
            units={deps.stack}
            editable
            onEditUnit={(unitId) => {
              haptic('pickerSelect');
              deps.onEditStackItemOpen(unitId);
            }}
          />

          <View style={styles.section} testID="owner-customer-history">
            <Text style={styles.sectionLabel}>Job history</Text>
            {deps.historyError !== null ? (
              <EmptyState message={deps.historyError} testID="owner-customer-history-error" />
            ) : deps.history === null ? null : deps.history.length === 0 ? (
              <Text style={styles.caption} testID="owner-customer-history-empty">
                No jobs yet.
              </Text>
            ) : (
              deps.history.map((job) => (
                <HistoryRow key={job.id} job={job} onPress={deps.onOpenJob} testID={`owner-customer-history-${job.id}`} />
              ))
            )}
          </View>

          {detail.notes !== null && detail.notes.trim() !== '' ? (
            <View style={styles.section} testID="owner-customer-notes">
              <Text style={styles.sectionLabel}>Notes</Text>
              <Text style={styles.body}>{detail.notes}</Text>
            </View>
          ) : null}

        </ScrollView>
      )}

      {/* The correction sheet — serial, quantity, warranty; remove is the
      DELETE door. The SAVE payload carries no `source_job_id`, by type
      and by runtime: `StackItemPatchInput` has no such field. */}
      {editing !== null ? (
        <Sheet visible title={`Correct unit — ${editing.label}`} onDismiss={close} testID="owner-stack-edit-sheet">
          <TextField label="Serial number" value={serial} onChangeText={setSerial} testID="stack-field-serial" />
          <TextField
            label="Quantity"
            value={quantity}
            onChangeText={(v) => setQuantity(v.replace(/[^0-9]/g, ''))}
            testID="stack-field-quantity"
          />
          <View style={{ marginTop: SPACE[3] }}>
            <DatePicker label="Warranty expires" value={warranty} onChange={setWarranty} testID="stack-field-warranty" />
          </View>
          {deps.stackError !== null ? (
            <Text style={styles.error} testID="owner-stack-error">
              {deps.stackError}
            </Text>
          ) : null}
          <View style={styles.sheetActions}>
            <Button
              label="Save correction"
              loading={deps.savingStack}
              onPress={() =>
                deps.onSaveStackItem(editing.id, editing.version, {
                  ...(serial.trim() === '' || serial.trim() === editing.serialNumber ? {} : { serialNumber: serial.trim() }),
                  ...(Number(quantity) > 0 && Number(quantity) !== editing.quantity ? { quantity: Number(quantity) } : {}),
                  ...(warranty === editing.warrantyExpiresOn ? {} : { warrantyExpiresOn: warranty }),
                })
              }
              fullwidth
              testID="stack-save"
            />
            <Button label="Remove unit" variant="ghost" onPress={() => deps.onRemoveStackItem(editing.id)} fullwidth testID="stack-remove" />
          </View>
          <Text style={styles.caption} testID="owner-stack-hint">
            A correction here stamps no source job — the trail records it as an owner edit.
          </Text>
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: SPACE[3], paddingTop: SPACE[2] },
  closeButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: SPACE[2] },
  closeLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  root: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  loading: { padding: SPACE[4], gap: SPACE[2] },
  content: { padding: SPACE[4], paddingBottom: SPACE[8] },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  companyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACE[2],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: SPACE[3],
    minHeight: 44,
  },
  companyLabel: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  companyAction: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  section: { marginTop: SPACE[4], gap: SPACE[1] },
  sectionLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  body: { ...textStyle('body'), color: SEMANTIC.text.primary },
  caption: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingHorizontal: SPACE[3],
  },
  phoneValue: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  phoneAction: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 56,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    marginBottom: SPACE[1],
  },
  historyRail: { width: 3, borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },
  historyBody: { flex: 1, justifyContent: 'center', gap: 2, paddingHorizontal: SPACE[3], paddingVertical: SPACE[2] },
  historyLine1: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  historyMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  error: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] },
  sheetActions: { marginTop: SPACE[3], gap: SPACE[3] },
  actions: { marginTop: SPACE[5], gap: SPACE[3] },
});
