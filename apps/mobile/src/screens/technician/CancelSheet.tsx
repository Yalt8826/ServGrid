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
 * - **An AMC job cancels like any other — AMCs carry no visit count
 *   (decision 2026-09-15).** The pre-2B "spends a visit" warning slot is
 *   gone: there is nothing spent to warn about.
 * - **Skippable is honest.** No date is a valid submission (§6.3: an
 *   ordinary job is simply cancelled). Submit demands a reason — never a
 *   date.
 * - **Submit is never disabled for a network reason.** Like the complete
 *   sheet: the write is the route's job (§5); a failure keeps the sheet
 *   open with everything he chose — never lose the record of a wasted trip.
 *
 * Pure UI over injected seams — the route owns the write to the server,
 * exactly like the complete route beside it.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { alpha, COLORS, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Icon } from '../../components/ui/icons';
import { DatePicker, formatDateEnIN } from '../../components/ui/DatePicker';
import { Sheet } from '../../components/ui/Sheet';
import { TextField } from '../../components/ui/TextField';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { messageOfWriteError } from '../../lib/intentWrite';
import { istDateKey, type JobView } from './jobView';
import {
  cancelPayloadOf,
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
   * Files the cancellation with the server (the route's). Resolves once
   * the server has it; rejects with the sentence to show when it does not
   * — and the sheet stays open with the reason he chose.
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
  const [submitError, setSubmitError] = useState<string | null>(null);

  const blocker = submitBlockerOf({ reasonCode, note });

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

  /** The submit pipeline past validation: the route sends it; a failure
   * keeps the sheet open with everything he chose and says why — the
   * record of a wasted trip is never lost (§5). */
  function performSubmit(): void {
    if (blocker !== null || submitting || reasonCode === null) return;
    setSubmitting(true);
    setSubmitError(null);
    void (async () => {
      try {
        await deps.onSubmit(cancelPayloadOf({ reasonCode, note, rescheduleTo }));
        setSubmitting(false);
        deps.onDismiss();
      } catch (error) {
        setSubmitting(false);
        setSubmitError(messageOfWriteError(error));
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
          selection idiom. The rows took a radio mark on 2026-09-16: nine
          identical outlined rows read as nine text fields, and a list of
          choices has to look like one before the technician reads a word
          of it. The mark is shape beside the colour, never colour alone. */}
      <View style={styles.block}>
        <SectionHeader label="Reason" icon="alert" />
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
              <Icon
                name={selected ? 'checkFilled' : 'check'}
                size={ICON.md}
                color={selected ? FRAME.accent : SEMANTIC.text.placeholder}
              />
              <Text
                style={{
                  ...textStyle('body'),
                  color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.primary,
                  flex: 1,
                }}
              >
                {reason.label}
              </Text>
            </Pressable>
          );
        })}
        </View>
      </View>

      {/* The note — optional for every reason, required for `other`; the
          blocker under the submit button says so when it matters. */}
      <TextField
        label="Note"
        value={note}
        onChangeText={setNote}
        placeholder="What happened here"
        // "Other" is the one reason the office cannot read on its own, so
        // the field stops describing the rule and states it: an empty note
        // with Other chosen is the error, on the field, before the submit
        // button's own blocker says the same thing.
        errorText={reasonCode === 'other' && note.trim() === '' ? 'Say what happened — Other needs a note.' : undefined}
        helperText={reasonCode === 'other' ? undefined : 'Optional — add it when the office needs the detail.'}
        testID="cancel-note"
      />

      {/* Reschedule to — a date picker, skippable (§T5). The field shows
          the choice; the rows below offer today and the next fortnight,
          so every tappable day is a legal one. */}
      <View style={styles.block}>
        <SectionHeader label="Reschedule" icon="calendar" tint={COLORS.accent} />
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
          icon="calendar"
          variant="secondary"
          onPress={() => setPickerOpen(!pickerOpen)}
          testID="cancel-reschedule-open"
        />

        {pickerOpen ? (
          <View testID="cancel-reschedule-picker" style={styles.picker}>
            {rescheduleWindow(today).map((iso) => {
              const chosenDay = rescheduleTo === iso;
              return (
                <Pressable
                  key={iso}
                  testID={`cancel-reschedule-option-${iso}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosenDay }}
                  onPress={() => chooseDate(iso)}
                  style={[styles.pickerRow, chosenDay ? styles.pickerRowChosen : null]}
                >
                  <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>
                    {iso === today ? 'Today' : formatDateEnIN(iso, nowYear)}
                  </Text>
                  {chosenDay ? <Icon name="check" size={ICON.sm} color={SEMANTIC.text.primary} /> : null}
                  <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}>
                    {iso}
                  </Text>
                </Pressable>
              );
            })}
            <Button label="Never mind" variant="ghost" onPress={() => setPickerOpen(false)} testID="cancel-reschedule-close" />
          </View>
        ) : null}

        {rescheduleTo !== null ? (
          <>
            {/* Choosing a date reveals the one-line confirmation (§T5) —
                the sentence he can read back to the customer. It is a
                tinted strip now: this line is the one thing on the sheet
                that must be said out loud, so it is not small grey print. */}
            <View style={styles.confirmStrip}>
              <Icon name="calendar" size={ICON.sm} color={SEMANTIC.text.primary} />
              <Text testID="cancel-reschedule-confirm" style={styles.confirm}>
                {rescheduleConfirmLine(rescheduleTo, nowYear)}
              </Text>
            </View>
            <Button
              label="Remove the date"
              icon="close"
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

      {submitError !== null ? <Banner tone="danger" message={submitError} testID="cancel-banner" /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch', gap: SPACE[3], marginTop: SPACE[4] },
  reasons: { alignSelf: 'stretch', gap: SPACE[2] },
  reasonRow: {
    minHeight: TAP.min, // ≥52pt (§T5 test): floor-sized, grows with type
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  reasonRowSelected: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
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
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: RADII.control,
  },
  pickerRowChosen: {
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  confirmStrip: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    borderWidth: 1,
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  confirm: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
});
