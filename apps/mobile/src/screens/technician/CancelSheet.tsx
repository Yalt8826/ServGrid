/**
 * T5 Cancel sheet (T1.20, UI/plan-2/04-TECHNICIAN.md §T5,
 * PLAN-BACKEND.md §6.3). This is where a wasted trip gets recorded —
 * filled by the one person who knows whether the customer said "come
 * Thursday" or "don't bother", usually standing at a locked gate with
 * four more jobs waiting.
 *
 * Anatomy, exactly as §T5: reason code as **large tappable rows, never a
 * dropdown** (a dropdown hides the answer he is standing in front of) ·
 * note, required for `other` · **Reschedule to**, a date picker,
 * skippable. Same rise as the complete sheet (the `Sheet` primitive);
 * reason selection fires the Selection haptic and the row fills
 * slate.900 — the complete sheet's segment idiom, one selection language
 * across the two closers.
 *
 * - **Choosing a date reveals the confirmation line** — *"Visit moves to
 *   22 Mar."* — the sentence he can read back to the customer he is
 *   still standing with. It renders FROM STATE: no date, no line.
 * - **A past date is refused with a message, never clamped.** The entry
 *   guard (`rescheduleDateErrorOf`) refuses before state, so a clamp has
 *   no path in and the DatePicker's own fallback date cannot sneak one
 *   through either.
 * - **The contract warning slot is built, and renders nothing pre-2B**
 *   (the "Done when"): `contractWarningOf` is null without a contract,
 *   which pre-2B is every job. When 2B arrives, the warning stands above
 *   the date picker in body weight — the one place the app warns a
 *   technician about a default, because the spent visit lands on the
 *   customer, invisibly.
 * - **Skippable is honest.** No date is a valid submission (§6.3: an
 *   ordinary job is simply cancelled; a contract visit becomes
 *   `skipped`). Submit demands a reason — never a date.
 * - **Submit is never disabled for a network reason.** Like the complete
 *   sheet: the optimistic write + enqueue are the route's job (§5); a
 *   failed enqueue keeps the sheet open with everything he chose —
 *   never lose the record of a wasted trip.
 *
 * Pure UI over injected seams — the route owns the mirror write and the
 * enqueue, exactly like the complete route beside it.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { DatePicker, formatDateEnIN } from '../../components/ui/DatePicker';
import { Sheet } from '../../components/ui/Sheet';
import { TextField } from '../../components/ui/TextField';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { istDateKey, type JobView } from './jobView';
import {
  cancelPayloadOf,
  contractWarningOf,
  rescheduleConfirmLine,
  rescheduleDateErrorOf,
  rescheduleWindow,
  submitBlockerOf,
  CANCEL_REASONS,
  type CancelReasonCode,
  type CancelSheetPayload,
} from './cancelSheet';

export interface CancelSheetDeps {
  /** The job being cancelled — the contract chip decides the warning. */
  view: JobView;
  /** Injectable clock — "in the past" and "today" are judged against it,
   * in IST (the technician's business day, `jobView.istDateKey`). */
  now: Date;
  /**
   * The optimistic write + enqueue (the route's). Resolves when the
   * cancellation is queued; rejects (sheet stays open, nothing lost)
   * when the local enqueue itself failed.
   */
  onSubmit: (payload: CancelSheetPayload) => Promise<void>;
  onDismiss: () => void;
}

export function CancelSheet(deps: CancelSheetDeps): React.ReactNode {
  const { view } = deps;
  const today = istDateKey(deps.now);

  const [reasonCode, setReasonCode] = useState<CancelReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [rescheduleTo, setRescheduleTo] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  const blocker = submitBlockerOf({ reasonCode, note });
  // Phase 2B's warning in its Phase 1 slot: above the date picker, body
  // weight — and nothing at all until a contract exists (§T5 Done when).
  const warning = contractWarningOf(view.job.contract);

  /** The entry guard behind the picker AND the field: a refused date
   * never reaches state, so "not silently clamped" holds by construction
   * (§T5) — the message shows instead, and what he had stays. */
  function chooseDate(iso: string): void {
    const error = rescheduleDateErrorOf(iso, today);
    if (error !== null) {
      setDateError(error);
      return;
    }
    setDateError(null);
    setPickerOpen(false);
    setRescheduleTo(iso);
  }

  /** The submit pipeline past validation: optimistic write + enqueue are
   * the route's; a failed enqueue keeps the sheet open with everything
   * he chose — the record of a wasted trip is never lost (§5). */
  function performSubmit(): void {
    if (blocker !== null || submitting || reasonCode === null) return;
    setSubmitting(true);
    setSubmitFailed(false);
    void (async () => {
      try {
        await deps.onSubmit(cancelPayloadOf({ reasonCode, note, rescheduleTo }));
        setSubmitting(false);
        deps.onDismiss();
      } catch {
        setSubmitting(false);
        setSubmitFailed(true);
      }
    })();
  }

  const nowYear = deps.now.getFullYear();
  const hasUnsavedInput = reasonCode !== null || note.trim() !== '' || rescheduleTo !== null;

  return (
    <Sheet
      visible
      testID="cancel-sheet"
      title={`Cancel ${view.job.jobNumber}`}
      hasUnsavedInput={hasUnsavedInput}
      onDismiss={deps.onDismiss}
      actions={
        <Button
          label="Cancel job"
          variant="danger"
          onPress={performSubmit}
          loading={submitting}
          disabled={blocker !== null}
          disabledReason={blocker ?? undefined}
          fullwidth
          testID="cancel-submit"
        />
      }
    >
      {/* Reason code — nine large rows, not a dropdown (§T5). Selection
          haptic; the chosen row fills slate.900, the complete sheet's
          selection idiom. */}
      <View testID="cancel-reasons" style={styles.reasons}>
        {CANCEL_REASONS.map((reason) => {
          const selected = reasonCode === reason.code;
          return (
            <Pressable
              key={reason.code}
              testID={`cancel-reason-${reason.code}`}
              accessibilityRole="button"
              accessibilityLabel={reason.label}
              accessibilityState={{ selected }}
              onPress={() => {
                haptic('pickerSelect');
                setReasonCode(reason.code);
              }}
              style={[styles.reasonRow, selected ? styles.reasonRowSelected : null]}
            >
              <Text
                style={{
                  ...textStyle('body'),
                  color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.primary,
                }}
              >
                {reason.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* The note — optional for every reason, required for `other`; the
          blocker under the submit button says so when it matters. */}
      <TextField
        label="Note"
        value={note}
        onChangeText={setNote}
        placeholder="What happened here"
        helperText="Required when the reason is Other."
        testID="cancel-note"
      />

      {/* THE CONTRACT WARNING SLOT (§T5) — above the date picker, in body
          not caption. Renders nothing pre-2B: the slot exists, the copy
          waits for contracts to exist. */}
      {warning !== null ? (
        <Text testID="cancel-contract-warning" style={styles.warning}>
          {warning}
        </Text>
      ) : null}

      {/* Reschedule to — a date picker, skippable (§T5). The field shows
          the choice; the rows below offer today and the next fortnight,
          so every tappable day is a legal one. */}
      <View style={styles.block}>
        <DatePicker
          label="Reschedule to"
          value={rescheduleTo}
          onChange={chooseDate}
          errorText={dateError ?? undefined}
          helperText={
            dateError === null ? 'Skippable — leave it out when the visit cannot happen.' : undefined
          }
          testID="cancel-reschedule"
        />
        <Button
          label={rescheduleTo === null ? 'Choose a date' : 'Change date'}
          variant="ghost"
          onPress={() => setPickerOpen(!pickerOpen)}
          testID="cancel-reschedule-open"
        />

        {pickerOpen ? (
          <View testID="cancel-reschedule-picker" style={styles.picker}>
            {rescheduleWindow(today).map((iso) => (
              <Pressable
                key={iso}
                testID={`cancel-reschedule-option-${iso}`}
                accessibilityRole="button"
                onPress={() => chooseDate(iso)}
                style={styles.pickerRow}
              >
                <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
                  {iso === today ? 'Today' : formatDateEnIN(iso, nowYear)}
                </Text>
                <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}>
                  {iso}
                </Text>
              </Pressable>
            ))}
            <Button label="Never mind" variant="ghost" onPress={() => setPickerOpen(false)} testID="cancel-reschedule-close" />
          </View>
        ) : null}

        {rescheduleTo !== null ? (
          <>
            {/* Choosing a date reveals the one-line confirmation (§T5) —
                the sentence he can read back to the customer. */}
            <Text testID="cancel-reschedule-confirm" style={styles.confirm}>
              {rescheduleConfirmLine(rescheduleTo, nowYear)}
            </Text>
            <Button
              label="Remove the date"
              variant="ghost"
              onPress={() => {
                setRescheduleTo(null);
                setDateError(null);
              }}
              testID="cancel-reschedule-clear"
            />
          </>
        ) : null}
      </View>

      {submitFailed ? (
        <Banner tone="danger" message="The cancellation could not be queued — nothing was lost. Try again." testID="cancel-banner" />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch', gap: SPACE[2], marginTop: SPACE[2] },
  reasons: { alignSelf: 'stretch', gap: SPACE[2] },
  reasonRow: {
    minHeight: TAP.min, // ≥52pt (§T5 test): floor-sized, grows with type
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  reasonRowSelected: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  warning: {
    ...textStyle('bodyStrong'), // body weight, never caption (§T5)
    color: SEMANTIC.text.primary,
    marginTop: SPACE[4],
  },
  picker: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    gap: SPACE[1],
    padding: SPACE[2],
  },
  pickerRow: {
    minHeight: TAP.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[2],
    paddingHorizontal: SPACE[2],
  },
  confirm: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
});
