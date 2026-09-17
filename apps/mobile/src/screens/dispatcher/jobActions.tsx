/**
 * The dispatcher's three job actions — reassign, reschedule, cancel
 * (2026-09-17, Yashas: "a reassign icon so the dispatcher can reassign it
 * if needed and also a reschedule button, cancel button at the end").
 *
 * They live on the job detail because that is where a dispatcher is
 * already looking at one job and deciding; the screen itself stays
 * read-only and these are the doors out of it. Each is a `Sheet` with one
 * question, because a sheet that asks two is a form:
 *
 * - **Reassign** — the roster, load-ordered, the current holder marked.
 *   `POST /v1/jobs/:id/assign` under `If-Match`: three dispatchers work
 *   the same queue every morning, so a lost race must come back as a
 *   conflict naming the current assignee, not as a silent overwrite.
 * - **Reschedule** — a day and a time slot, the same pair the dispatch
 *   form uses (`TIME_SLOTS`, `scheduledForOf`), seeded from the slot the
 *   job already has. `PATCH /v1/jobs/:id` under `If-Match`: moving a job
 *   is not a cancellation, and the status is left alone.
 * - **Cancel** — the reasons the API accepts, a note (required for
 *   `other`, the server's own rule), and an optional new date for the
 *   successor visit.
 *
 * Every sheet keeps the operator's words on screen while it works: a
 * failure says what the server said and leaves the sheet open with the
 * choice intact, so a refused reassignment is one press to retry.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { alpha, COLORS, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { Button, DatePicker, SectionHeader, Select, Sheet } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { textStyle } from '../../fonts/textStyle';
import { TIME_SLOTS, scheduledForOf } from './dispatchForm';

/** One roster row, as the reassign picker needs it. */
export interface ReassignCandidate {
  employeeId: string;
  name: string;
  openTotal: number;
}

export interface SheetChrome {
  busy: boolean;
  /** The server's sentence, verbatim, when a write was refused. */
  error: string | null;
  onDismiss: () => void;
}

// ── reassign ─────────────────────────────────────────────────────────────

export interface ReassignSheetProps extends SheetChrome {
  visible: boolean;
  jobNumber: string;
  /** Who holds it now, or null when nobody does. */
  currentTechnicianId: string | null;
  candidates: readonly ReassignCandidate[];
  onConfirm: (technicianId: string) => void;
}

export function ReassignSheet(props: ReassignSheetProps): React.ReactNode {
  const busiest = Math.max(0, ...props.candidates.map((c) => c.openTotal));
  return (
    <Sheet
      visible={props.visible}
      testID="dispatch-reassign-sheet"
      title={`Reassign ${props.jobNumber}`}
      onDismiss={props.onDismiss}
      actions={
        <Text style={styles.sheetNote}>Pick the technician who should take it.</Text>
      }
    >
      <SectionHeader label="Technicians, lightest first" icon="people" />
      {props.candidates.length === 0 ? (
        <Text style={styles.empty}>No technicians on the roster.</Text>
      ) : (
        props.candidates.map((candidate, index) => {
          const current = candidate.employeeId === props.currentTechnicianId;
          return (
            <Pressable
              key={candidate.employeeId}
              testID={`dispatch-reassign-${candidate.employeeId}`}
              accessibilityRole="button"
              accessibilityLabel={current ? `${candidate.name} is already on this job` : `Assign to ${candidate.name}`}
              accessibilityState={{ disabled: props.busy || current }}
              disabled={props.busy || current}
              onPress={() => props.onConfirm(candidate.employeeId)}
              style={[styles.pickRow, current ? styles.pickRowCurrent : null]}
            >
              {/* The load row's bar is `flex: 1`, so it needs its own
                  column to fill — otherwise it pushes the chip off the
                  sheet's edge (found on the device, 2026-09-17). */}
              <View style={{ flex: 1 }}>
                <TechnicianLoadRow
                  name={candidate.name}
                  load={candidate.openTotal}
                  maxLoad={busiest}
                  index={index}
                />
              </View>
              {current ? (
                <Text testID={`dispatch-reassign-${candidate.employeeId}-current`} style={styles.currentChip}>
                  On it
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}
      {props.error === null ? null : (
        <Text testID="dispatch-reassign-error" style={styles.error}>
          {props.error}
        </Text>
      )}
    </Sheet>
  );
}

// ── reschedule ───────────────────────────────────────────────────────────

export interface RescheduleSheetProps extends SheetChrome {
  visible: boolean;
  jobNumber: string;
  /** The slot it currently carries, `YYYY-MM-DD` IST, or null. */
  currentDate: string | null;
  /** The current time as `HH:MM`, or null. */
  currentTime: string | null;
  onConfirm: (scheduledFor: string) => void;
}

export function RescheduleSheet(props: RescheduleSheetProps): React.ReactNode {
  const [date, setDate] = useState<string | null>(props.currentDate);
  const [time, setTime] = useState<string | null>(props.currentTime);

  const ready = date !== null && time !== null;
  return (
    <Sheet
      visible={props.visible}
      testID="dispatch-reschedule-sheet"
      title={`Reschedule ${props.jobNumber}`}
      hasUnsavedInput={date !== props.currentDate || time !== props.currentTime}
      onDismiss={props.onDismiss}
      actions={
        <Button
          label="Move the visit"
          icon="calendar"
          fullwidth
          loading={props.busy}
          disabled={!ready}
          disabledReason={ready ? undefined : 'Pick a day and a time.'}
          onPress={() => {
            if (date !== null && time !== null) props.onConfirm(scheduledForOf(date, time));
          }}
          testID="dispatch-reschedule-confirm"
        />
      }
    >
      <SectionHeader label="New slot" icon="calendar" tint={COLORS.accent} />
      <View style={styles.scheduleRow}>
        <View style={{ flex: 1 }}>
          <DatePicker
            label="Day"
            value={date}
            onChange={setDate}
            testID="dispatch-reschedule-date"
          />
        </View>
        <View style={{ width: 128 }}>
          <Select
            label="Time"
            value={time ?? ''}
            options={TIME_SLOTS.map((slot) => ({ value: slot, label: slot }))}
            placeholder="No time"
            onSelect={setTime}
            testID="dispatch-reschedule-time"
          />
        </View>
      </View>
      {/* The sentence the dispatcher reads back to the customer — §T5's
          confirmation, in the console's words. */}
      <Text testID="dispatch-reschedule-line" style={styles.confirmLine}>
        {ready ? `Visit moves to ${date} · ${time}` : 'Pick a day and a time.'}
      </Text>
      {props.error === null ? null : (
        <Text testID="dispatch-reschedule-error" style={styles.error}>
          {props.error}
        </Text>
      )}
    </Sheet>
  );
}

// ── cancel ───────────────────────────────────────────────────────────────

/** The reasons `jobCancelSchema` accepts, in the console's words. */
export const DISPATCH_CANCEL_REASONS: readonly { code: string; label: string }[] = [
  { code: 'customer_unavailable', label: 'Customer unavailable' },
  { code: 'no_access', label: 'No access' },
  { code: 'parts_unavailable', label: 'Parts unavailable' },
  { code: 'customer_cancelled', label: 'Customer cancelled' },
  { code: 'wrong_details', label: 'Wrong details' },
  { code: 'duplicate', label: 'Duplicate visit' },
  { code: 'rescheduled_by_office', label: 'Rescheduled by the office' },
  { code: 'contract_cancelled', label: 'Contract cancelled' },
  { code: 'other', label: 'Other' },
];

export interface CancelJobSheetProps extends SheetChrome {
  visible: boolean;
  jobNumber: string;
  onConfirm: (body: { reasonCode: string; reasonNote?: string; rescheduleTo?: string }) => void;
}

export function CancelJobSheet(props: CancelJobSheetProps): React.ReactNode {
  const [reasonCode, setReasonCode] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [rescheduleTo, setRescheduleTo] = useState<string | null>(null);

  const noteRequired = reasonCode === 'other' && note.trim() === '';
  const ready = reasonCode !== null && !noteRequired;
  return (
    <Sheet
      visible={props.visible}
      testID="dispatch-cancel-sheet"
      title={`Cancel ${props.jobNumber}`}
      hasUnsavedInput={reasonCode !== null || note !== '' || rescheduleTo !== null}
      onDismiss={props.onDismiss}
      actions={
        <Button
          label="Cancel this job"
          icon="close"
          variant="danger"
          fullwidth
          loading={props.busy}
          disabled={!ready}
          disabledReason={reasonCode === null ? 'Pick the reason the visit did not go ahead.' : noteRequired ? 'Say what happened — Other needs a note.' : undefined}
          onPress={() => {
            if (reasonCode === null) return;
            props.onConfirm({
              reasonCode,
              ...(note.trim() === '' ? {} : { reasonNote: note.trim() }),
              ...(rescheduleTo === null ? {} : { rescheduleTo }),
            });
          }}
          testID="dispatch-cancel-confirm"
        />
      }
    >
      <SectionHeader label="Reason" icon="alert" />
      <View style={styles.reasons}>
        {DISPATCH_CANCEL_REASONS.map((reason) => {
          const selected = reasonCode === reason.code;
          return (
            <Pressable
              key={reason.code}
              testID={`dispatch-cancel-reason-${reason.code}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setReasonCode(reason.code)}
              style={[styles.reasonRow, selected ? styles.reasonRowSelected : null]}
            >
              <Icon
                name={selected ? 'checkFilled' : 'check'}
                size={ICON.md}
                color={selected ? COLORS.accent : SEMANTIC.text.placeholder}
              />
              <Text style={{ ...textStyle('body'), color: selected ? SEMANTIC.text.onDark : SEMANTIC.text.primary, flex: 1 }}>
                {reason.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader label="Note" icon="document" />
      <TextInputCompat
        value={note}
        onChangeText={setNote}
        placeholder={reasonCode === 'other' ? 'What happened here — required' : 'Anything the office should know'}
        testID="dispatch-cancel-note"
      />

      <SectionHeader label="Successor visit" icon="calendar" tint={COLORS.accent} />
      <DatePicker
        label="Move the visit to"
        value={rescheduleTo}
        onChange={setRescheduleTo}
        helperText="Skippable — leave it out when the visit should not happen again."
        testID="dispatch-cancel-reschedule"
      />
      {props.error === null ? null : (
        <Text testID="dispatch-cancel-error" style={styles.error}>
          {props.error}
        </Text>
      )}
    </Sheet>
  );
}

/** A bare input for the sheet's note — `TextField` carries a label and its
 * own spacing, which the section marker above already provides. */
function TextInputCompat({
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  testID: string;
}): React.ReactNode {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={SEMANTIC.text.placeholder}
      multiline
      testID={testID}
      style={styles.note}
    />
  );
}

const styles = StyleSheet.create({
  sheetNote: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  empty: { ...textStyle('body'), color: SEMANTIC.text.secondary, paddingVertical: SPACE[3] },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    minHeight: TAP.min,
    paddingHorizontal: SPACE[2],
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: RADII.control,
  },
  pickRowCurrent: {
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  currentChip: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  scheduleRow: { flexDirection: 'row', gap: SPACE[3], alignItems: 'flex-start' },
  confirmLine: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, marginTop: SPACE[2] },
  reasons: { alignSelf: 'stretch', gap: SPACE[2] },
  reasonRow: {
    minHeight: TAP.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  reasonRowSelected: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  note: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    minHeight: 72,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  error: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] },
});
