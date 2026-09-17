/**
 * D3 Dispatch Job (T2.9, UI/plan-2/05-DISPATCHER.md §D3) — raise a job
 * and assign it, while the customer is still on the phone. **Single
 * scroll, no wizard**: the worst moment this screen exists for is
 * mid-call, an address being recited, a technician needed before the
 * customer hangs up. Every field on one page; if it ever grows a second
 * step, cut a field instead (§D3 "If it fails").
 *
 * The screen is pure over injected data (the seam T2.7/T2.8 use);
 * `useDispatchForm` is the online wiring and the route file is the
 * mount point gated on `dispatch.console`.
 *
 * Anatomy, exactly:
 *
 * - **Customer search-or-create is one field.** Typing searches; the
 *   results render inline under it (the shared `CustomerSearchRows`,
 *   the same rows the AMC form searches with); no match offers *+ New
 *   customer* inline — the offer lives in the form, not behind a mode
 *   switch.
 * - **A customer with an active AMC gets the offer, already ticked**
 *   (decision 2026-09-15): *AMC job · AMC-2627-00031 · until 14 Sep
 *   2027* sits between the chosen customer and the unit reveal; a
 *   checkbox, not a call to action. Unticked, the job is an ordinary
 *   job.
 * - **Selecting a customer collapses the search to one line and reveals
 *   the unit picker** — the one progressive-disclosure moment (220ms,
 *   `base`). The reveal animates opacity/translate only (02-MOTION.md
 *   §9: never `height`); the disclosure reads the same.
 * - **The unit picker reads that site's stack** and is **skippable** —
 *   a dispatcher taking a call may not know which UPS it is; the serial
 *   can wait for the technician.
 * - **Priority is four segments, not a dropdown.** `Urgent` is the only
 *   value that overrides notification suppression, so choosing it says
 *   so, in words, right under the segment.
 * - **`TechnicianPicker` is inline at the bottom, sorted by load
 *   ascending** — the answer is at the top. Each row is the shared
 *   `TechnicianLoadRow`: name, mono count, inline load bar, availability.
 *   The bars draw staggered 30ms, 260ms each (§5.5) — the one stagger
 *   outside the stepper, earned because the *comparison* is the decision.
 *   *Leave unassigned* is the explicit LAST option and nothing is
 *   preselected — never the silent default.
 * - **No company field.** Dispatchers hold no company permission and the
 *   api strips `companyId` from their payloads (§5 rule 3); the form
 *   does not even offer it.
 *
 * Submit shows a toast carrying the number — *"JC-2627-0044 assigned to
 * Ravi"* — because the dispatcher may need to read it back down the
 * phone. Validation happens on submit, never while typing
 * (03-COMPONENTS.md), and the two things the server cannot raise a card
 * without (customer, service) are refused with a sentence, not a shake.
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { Banner, Button, CalendarGrid, DatePicker, Sheet, TextField } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { useArrival } from '../../components/ui/motion';
import { textStyle } from '../../fonts/textStyle';
import { CustomerSearchRows } from './CustomerSearchRows';
import {
  PRIORITY_SEGMENTS,
  TIME_SLOTS,
  URGENT_SUPPRESSION_NOTE,
  formatSubmitToast,
  sortTechniciansByLoad,
  validateDispatchForm,
  type DispatchCustomerOption,
  type DispatchJobFields,
  type DispatchPriority,
  type DispatchServiceOption,
  type DispatchTechnician,
  type DispatchUnitOption,
} from './dispatchForm';

export const DISPATCH_OFFLINE_MESSAGE = 'No connection. This screen is not live.';

/** The picker's choice: unset until a row is tapped — *Leave
 * unassigned* is a choice like any other, never a silent default. */
export type AssignmentChoice = { kind: 'unset' } | { kind: 'tech'; id: string } | { kind: 'unassigned' };

/** Which option sheet is open — one at a time, like D2's filter bar. */
type SheetKey = 'unit' | 'service' | 'time' | 'date' | null;

export interface DispatchJobDeps {
  offline: boolean;
  /** The search box's text — hook-owned; the screen renders it. */
  customerQuery: string;
  /** The search's answers, or null while the search runs. */
  customers: DispatchCustomerOption[] | null;
  customerError: string | null;
  selectedCustomer: DispatchCustomerOption | null;
  /** The selected site's stack, or null while it loads. */
  stack: DispatchUnitOption[] | null;
  services: DispatchServiceOption[];
  /** The roster, in the order the server answered; the screen sorts. */
  technicians: DispatchTechnician[];
  /** `YYYY-MM-DD` of "today" in IST — the schedule field's default. */
  todayIso: string;
  submitting: boolean;
  submitError: string | null;
  /** The raised card, as the toast reads it back. */
  submitted: { jobNumber: string; technicianName: string | null } | null;
  /** The selected customer's active AMC, or null when he has none (or the
   * flag is off) — the checkbox offer (decision 2). */
  amc: { contractId: string; label: string } | null;
  /** Ticked for every newly picked customer; unticking sends no contractId. */
  amcTicked: boolean;
  onCustomerQueryChange(query: string): void;
  onSelectCustomer(customer: DispatchCustomerOption): void;
  onNewCustomer(): void;
  onClearCustomer(): void;
  onToggleAmc(): void;
  onSubmit(fields: DispatchJobFields): void;
  onDismissToast(): void;
}

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

// ── TechnicianPicker ─────────────────────────────────────────────────────

/**
 * The actual decision of this screen, given its rows: **load ascending,
 * never alphabetically**, each row the shared `TechnicianLoadRow` — name,
 * mono count, inline bar (a fraction of the busiest), availability — and
 * *Leave unassigned* the explicit last row. Nothing is selected until
 * the dispatcher taps.
 */
export function TechnicianPicker({
  technicians,
  choice,
  disabled,
  onChoose,
}: {
  technicians: readonly DispatchTechnician[];
  choice: AssignmentChoice;
  disabled: boolean;
  onChoose(choice: AssignmentChoice): void;
}): React.ReactNode {
  const sorted = sortTechniciansByLoad(technicians);
  const busiestLoad = sorted.length === 0 ? 0 : Math.max(...sorted.map((technician) => technician.openTotal));
  return (
    <View testID="dispatch-assign-picker">
      {sorted.map((technician, index) => {
        const selected = choice.kind === 'tech' && choice.id === technician.employeeId;
        return (
          <Pressable
            key={technician.employeeId}
            testID={`dispatch-assign-${technician.employeeId}`}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            hitSlop={hitSlop}
            onPress={() => {
              haptic('pickerSelect');
              onChoose({ kind: 'tech', id: technician.employeeId });
            }}
            style={[styles.assignRow, selected ? styles.assignRowSelected : null]}
          >
            <TechnicianLoadRow
              name={technician.name}
              load={technician.openTotal}
              maxLoad={busiestLoad}
              index={index}
              testID={`dispatch-assign-load-${technician.employeeId}`}
            />
          </Pressable>
        );
      })}
      {(() => {
        const selected = choice.kind === 'unassigned';
        return (
          <Pressable
            testID="dispatch-assign-unassigned"
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            hitSlop={hitSlop}
            onPress={() => {
              haptic('pickerSelect');
              onChoose({ kind: 'unassigned' });
            }}
            style={[styles.assignRow, styles.assignUnassigned, selected ? styles.assignRowSelected : null]}
          >
            <Text style={selected ? styles.assignUnassignedLabelSelected : styles.assignUnassignedLabel}>
              Leave unassigned
            </Text>
          </Pressable>
        );
      })()}
    </View>
  );
}

// ── one segment of the priority control ──────────────────────────────────

function PrioritySegment({
  value,
  label,
  active,
  disabled,
  onPress,
}: {
  value: DispatchPriority;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress(): void;
}): React.ReactNode {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      testID={`dispatch-priority-${value}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={() => {
        haptic('pickerSelect');
        onPress();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.segment, active ? styles.segmentActive : null, pressed ? styles.segmentPressed : null]}
    >
      <Text style={active ? styles.segmentLabelActive : styles.segmentLabel}>{label}</Text>
    </Pressable>
  );
}

// ── the screen ───────────────────────────────────────────────────────────

export function DispatchJobScreen(deps: DispatchJobDeps): React.ReactNode {
  const [sheet, setSheet] = useState<SheetKey>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [priority, setPriority] = useState<DispatchPriority>('normal');
  const [scheduledDate, setScheduledDate] = useState<string | null>(deps.todayIso);
  const [time, setTime] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [assignment, setAssignment] = useState<AssignmentChoice>({ kind: 'unset' });
  const [attempted, setAttempted] = useState(false);

  // Contact prefills from the customer the dispatcher just picked — the
  // anatomy's "(prefilled from customer)". Only fills blanks: a number
  // the dispatcher already typed is never overwritten by a re-pick.
  const selected = deps.selectedCustomer;
  useEffect(() => {
    if (selected === null) return;
    setContactName((current) => (current === '' ? selected.name : current));
    setContactPhone((current) => (current === '' ? selected.phone : current));
  }, [selected]);

  const hasCustomer = selected !== null;
  const problems = attempted
    ? validateDispatchForm({
        hasCustomer,
        serviceId,
        technicianId: assignment.kind === 'tech' ? assignment.id : null,
        unassignedChosen: assignment.kind === 'unassigned',
      })
    : {};

  const submit = (): void => {
    setAttempted(true);
    const nextProblems = validateDispatchForm({
      hasCustomer,
      serviceId,
      technicianId: assignment.kind === 'tech' ? assignment.id : null,
      unassignedChosen: assignment.kind === 'unassigned',
    });
    if (nextProblems.customer !== undefined || nextProblems.service !== undefined || nextProblems.assignment !== undefined) {
      return;
    }
    deps.onSubmit({
      unitId,
      serviceId,
      priority,
      scheduledDate,
      scheduledFor: scheduledDate !== null && time !== null ? `${scheduledDate}T${time}:00+05:30` : null,
      contactName: contactName.trim(),
      contactPhone: contactPhone.trim(),
      notes: notes.trim(),
      technicianId: assignment.kind === 'tech' ? assignment.id : null,
    });
  };

  const searching = !hasCustomer && deps.customers !== null && deps.customers.length > 0;
  const noMatch =
    !hasCustomer && deps.customers !== null && deps.customers.length === 0 && deps.customerQuery.trim() !== '';

  // §D3's one progressive-disclosure moment: the unit picker rides in
  // when the customer is chosen. Opacity + translate only (02-MOTION.md
  // §9) over the spec's 220ms (`base`); under reduced motion it just is.
  const reveal = useArrival(8);
  const selectedUnitLabel =
    unitId === null ? null : (deps.stack ?? []).find((unit) => unit.id === unitId)?.label ?? null;
  const selectedService = serviceId === null ? null : (deps.services.find((s) => s.id === serviceId)?.name ?? null);

  return (
    <View style={styles.screen} testID="dispatch-screen">
      {/* No stray whitespace on this line: a same-line gap between the
          ScrollView's opening tag and its first child renders as a string
          child of a View — RN's "Text strings must be rendered within a
          <Text> component" (found on device, 2026-09-17). */}
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Dispatch Job</Text>

        {deps.offline ? (
          <Banner tone="danger" message={DISPATCH_OFFLINE_MESSAGE} testID="dispatch-offline-banner" />
        ) : null}

        {deps.submitted !== null ? (
          <Banner
            tone="success"
            message={formatSubmitToast(deps.submitted.jobNumber, deps.submitted.technicianName)}
            onDismiss={deps.onDismissToast}
            testID="dispatch-toast"
          />
        ) : null}
        {deps.submitError !== null ? (
          <Banner tone="danger" message={deps.submitError} testID="dispatch-submit-error" />
        ) : null}

        {hasCustomer ? (
          <>
            {/* The collapsed line: one row, name · phone, and a way back. */}
            <View style={styles.selectedRow} testID="dispatch-customer-selected">
              <View style={styles.selectedBody}>
                <Text numberOfLines={1} style={styles.selectedName}>
                  {selected!.name}
                </Text>
                <Text numberOfLines={1} style={styles.selectedMeta}>
                  {selected!.phone}
                  {selected!.addressLabel === null ? '' : ` · ${selected!.addressLabel}`}
                </Text>
              </View>
              <Pressable
                testID="dispatch-customer-clear"
                accessibilityRole="button"
                accessibilityLabel="Change customer"
                hitSlop={hitSlop}
                disabled={deps.submitting}
                onPress={() => {
                  setUnitId(null);
                  setContactName('');
                  setContactPhone('');
                  deps.onClearCustomer();
                }}
                style={styles.selectedClear}
              >
                <Text style={styles.selectedClearLabel}>Change</Text>
              </Pressable>
            </View>
            {/* The AMC offer sits between the chosen customer and the
            unit reveal: it is about THIS customer, read before the work
            is specified (decision 2). No accent — a checkbox, not a CTA. */}
            {deps.amc !== null ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: deps.amcTicked }}
                onPress={deps.onToggleAmc}
                hitSlop={hitSlop}
                style={styles.amcRow}
                testID="dispatch-amc-option"
              >
                <Text style={styles.amcBox}>{deps.amcTicked ? '☑' : '☐'}</Text>
                <Text style={styles.amcLabel}>{deps.amc.label}</Text>
              </Pressable>
            ) : null}
            {/* The one progressive-disclosure moment (220ms, opacity/translate). */}
            <Animated.View style={reveal} testID="dispatch-unit-reveal">
              <View style={styles.fieldWrap}>
                <Text style={styles.fieldLabel}>The unit</Text>
                <Pressable
                  testID="dispatch-unit-trigger"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: deps.submitting }}
                  disabled={deps.submitting}
                  hitSlop={hitSlop}
                  onPress={() => {
                    haptic('pickerSelect');
                    setSheet('unit');
                  }}
                  style={styles.trigger}
                >
                  <Text numberOfLines={1} style={selectedUnitLabel === null ? styles.triggerPlaceholderLabel : styles.triggerLabel}>
                    {selectedUnitLabel ?? (deps.stack === null ? 'Loading…' : 'Optional — skip if the caller does not know')}
                  </Text>
                  <Text style={styles.triggerChevron}> ▾</Text>
                </Pressable>
              </View>
            </Animated.View>
          </>
        ) : (
          <>
            <View style={styles.fieldWrap}>
              <TextField
                label="Customer"
                value={deps.customerQuery}
                onChangeText={deps.onCustomerQueryChange}
                placeholder="Name or phone — typing searches"
                testID="dispatch-customer-field"
              />
              {deps.customerError !== null ? (
                <Text style={styles.fieldError} testID="dispatch-customer-error">
                  {deps.customerError}
                </Text>
              ) : null}
            </View>
            {searching ? (
              <CustomerSearchRows
                results={deps.customers!}
                onSelect={deps.onSelectCustomer}
                testIDPrefix="dispatch-customer-result"
              />
            ) : null}
            {noMatch ? (
              <Pressable
                testID="dispatch-new-customer"
                accessibilityRole="button"
                hitSlop={hitSlop}
                onPress={() => {
                  haptic('pickerSelect');
                  deps.onNewCustomer();
                }}
                style={styles.newCustomerRow}
              >
                <Text style={styles.newCustomerLabel}>+ New customer</Text>
              </Pressable>
            ) : null}
            {attempted && problems.customer !== undefined ? (
              <Text style={styles.fieldError} testID="dispatch-customer-required">
                {problems.customer}
              </Text>
            ) : null}
          </>
        )}

        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>Service</Text>
          <Pressable
            testID="dispatch-service-trigger"
            accessibilityRole="button"
            accessibilityState={{ disabled: deps.submitting }}
            disabled={deps.submitting}
            hitSlop={hitSlop}
            onPress={() => {
              haptic('pickerSelect');
              setSheet('service');
            }}
            style={styles.trigger}
          >
            <Text style={selectedService === null ? styles.triggerPlaceholderLabel : styles.triggerLabel}>
              {selectedService ?? 'Select'}
            </Text>
            <Text style={styles.triggerChevron}> ▾</Text>
          </Pressable>
          {attempted && problems.service !== undefined ? (
            <Text style={styles.fieldError} testID="dispatch-service-error">
              {problems.service}
            </Text>
          ) : null}
        </View>

        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>Priority</Text>
          <View style={styles.segmentRow}>
            {PRIORITY_SEGMENTS.map((segment) => (
              <PrioritySegment
                key={segment.value}
                value={segment.value}
                label={segment.label}
                active={priority === segment.value}
                disabled={deps.submitting}
                onPress={() => setPriority(segment.value)}
              />
            ))}
          </View>
          {priority === 'urgent' ? (
            <Text style={styles.urgentNote} testID="dispatch-priority-note">
              {URGENT_SUPPRESSION_NOTE}
            </Text>
          ) : null}
        </View>

        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>Schedule</Text>
          <View style={styles.scheduleRow}>
            <View style={styles.scheduleDate}>
              {/* `DatePicker` is a field with a trigger and no choosing UI
                  of its own — its tap used to set a placeholder date, so
                  the day could not be chosen at all (found while wiring
                  the dispatcher's reschedule sheet, 2026-09-17). The day
                  is picked from the sheet below, like the time. */}
              <DatePicker label="Day" value={scheduledDate} onChange={() => setSheet('date')} testID="dispatch-date" />
            </View>
            <View style={styles.scheduleTime}>
              <Text style={styles.fieldLabel}>Time</Text>
              <Pressable
                testID="dispatch-time-trigger"
                accessibilityRole="button"
                hitSlop={hitSlop}
                onPress={() => {
                  haptic('pickerSelect');
                  setSheet('time');
                }}
                style={styles.trigger}
              >
                <Text style={time === null ? styles.triggerPlaceholderLabel : styles.triggerLabel}>
                  {time ?? 'No time'}
                </Text>
                <Text style={styles.triggerChevron}> ▾</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.fieldWrap}>
          <TextField label="Contact name" value={contactName} onChangeText={setContactName} testID="dispatch-contact-name" />
        </View>
        <View style={styles.fieldWrap}>
          <TextField label="Contact phone" value={contactPhone} onChangeText={setContactPhone} testID="dispatch-contact-phone" />
        </View>
        <View style={styles.fieldWrap}>
          <TextField label="Notes" value={notes} onChangeText={setNotes} multiline rows={3} testID="dispatch-notes" />
        </View>

        <Text style={styles.assignHeading}>Assign to</Text>
        <Text style={styles.assignHint}>Lightest load first — the comparison is the decision.</Text>
        {attempted && problems.assignment !== undefined ? (
          <Text style={styles.fieldError} testID="dispatch-assign-error">
            {problems.assignment}
          </Text>
        ) : null}
        <TechnicianPicker technicians={deps.technicians} choice={assignment} disabled={deps.submitting} onChoose={setAssignment} />

        <View style={styles.submitWrap}>
          <Button label="Create and assign" loading={deps.submitting} onPress={submit} fullwidth testID="dispatch-submit" />
        </View>
      </ScrollView>

      {/* One option sheet open at a time; choosing applies and closes. */}
      {sheet === 'unit' ? (
        <Sheet visible title="Which unit" onDismiss={() => setSheet(null)} testID="dispatch-unit-sheet">
          <Pressable
            testID="unit-option-none"
            accessibilityRole="button"
            accessibilityState={{ selected: unitId === null }}
            onPress={() => {
              setUnitId(null);
              setSheet(null);
            }}
            style={styles.optionRow}
          >
            <Text style={styles.optionLabel}>No specific unit</Text>
          </Pressable>
          {(deps.stack ?? []).map((unit) => (
            <Pressable
              key={unit.id}
              testID={`unit-option-${unit.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: unitId === unit.id }}
              onPress={() => {
                setUnitId(unit.id);
                setSheet(null);
              }}
              style={styles.optionRow}
            >
              <Text style={unitId === unit.id ? styles.optionLabelSelected : styles.optionLabel}>{unit.label}</Text>
            </Pressable>
          ))}
        </Sheet>
      ) : null}
      {sheet === 'service' ? (
        <Sheet visible title="What is the work" onDismiss={() => setSheet(null)} testID="dispatch-service-sheet">
          {deps.services.map((service) => (
            <Pressable
              key={service.id}
              testID={`service-option-${service.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: serviceId === service.id }}
              onPress={() => {
                setServiceId(service.id);
                setSheet(null);
              }}
              style={styles.optionRow}
            >
              <Text style={serviceId === service.id ? styles.optionLabelSelected : styles.optionLabel}>{service.name}</Text>
            </Pressable>
          ))}
        </Sheet>
      ) : null}
      {sheet === 'date' ? (
        <Sheet visible title="Which day" onDismiss={() => setSheet(null)} testID="dispatch-date-sheet">
          {/* The same month calendar the reschedule sheet uses — one day
              picker in the console, not two. Choosing a day closes the
              sheet; "No day" stays, because a job may be raised undated. */}
          <CalendarGrid
            value={scheduledDate}
            todayIso={deps.todayIso}
            onSelect={(iso) => {
              haptic('pickerSelect');
              setScheduledDate(iso);
              setSheet(null);
            }}
            testID="dispatch-date-calendar"
          />
          <Pressable
            testID="date-option-none"
            accessibilityRole="button"
            accessibilityState={{ selected: scheduledDate === null }}
            onPress={() => {
              haptic('pickerSelect');
              setScheduledDate(null);
              setSheet(null);
            }}
            style={styles.optionRow}
          >
            <Text style={scheduledDate === null ? styles.optionLabelSelected : styles.optionLabel}>No day</Text>
          </Pressable>
        </Sheet>
      ) : null}

      {sheet === 'time' ? (
        <Sheet visible title="When" onDismiss={() => setSheet(null)} testID="dispatch-time-sheet">
          {TIME_SLOTS.map((slot) => (
            <Pressable
              key={slot}
              testID={`time-option-${slot}`}
              accessibilityRole="button"
              accessibilityState={{ selected: time === slot }}
              onPress={() => {
                setTime(slot);
                setSheet(null);
              }}
              style={styles.optionRow}
            >
              <Text style={time === slot ? styles.optionLabelSelected : styles.optionLabel}>{slot}</Text>
            </Pressable>
          ))}
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  // The form is a sentence: capped at a readable measure and centred on
  // the desk instead of stretching a text field across 1160px (a phone
  // never reaches the cap, so the field layout is unchanged there).
  content: {
    paddingHorizontal: SPACE[4],
    paddingBottom: SPACE[8],
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary, paddingTop: SPACE[3], paddingBottom: SPACE[2] },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    minHeight: TAP.console,
  },
  selectedBody: { flex: 1 },
  selectedName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  selectedMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  selectedClear: { paddingHorizontal: SPACE[2], minHeight: TAP.min, justifyContent: 'center' },
  selectedClearLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  fieldWrap: { marginTop: SPACE[3] },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 },
  fieldError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: 4 },
  // The AMC checkbox row — box/label copied from CompleteSheet's
  // "Customer confirmed" row; at least TAP tall; no accent anywhere.
  amcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    paddingVertical: SPACE[1],
  },
  amcBox: { ...textStyle('body'), color: SEMANTIC.text.primary },
  amcLabel: { ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 },
  newCustomerRow: {
    minHeight: TAP.min,
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    marginTop: SPACE[1],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    backgroundColor: SEMANTIC.bg.raised,
  },
  newCustomerLabel: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  trigger: {
    minHeight: 44,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  triggerLabel: { ...textStyle('body'), color: SEMANTIC.text.primary, flexShrink: 1 },
  triggerPlaceholderLabel: { ...textStyle('body'), color: SEMANTIC.text.placeholder, flexShrink: 1 },
  triggerChevron: { ...textStyle('body'), color: SEMANTIC.text.secondary },
  segmentRow: { flexDirection: 'row', gap: SPACE[1] },
  segment: {
    flex: 1,
    minHeight: TAP.console,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: SEMANTIC.bg.dense, borderColor: SEMANTIC.text.primary },
  segmentPressed: { backgroundColor: SEMANTIC.bg.pressed },
  segmentLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  segmentLabelActive: { ...textStyle('label'), color: SEMANTIC.text.primary, fontWeight: '600' },
  urgentNote: { ...textStyle('caption'), color: SEMANTIC.feedback.warning, marginTop: 4 },
  scheduleRow: { flexDirection: 'row', gap: SPACE[2] },
  scheduleDate: { flex: 1 },
  scheduleTime: { width: 128 },
  assignHeading: { ...textStyle('h2'), color: SEMANTIC.text.primary, marginTop: SPACE[5] },
  assignHint: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: 2, marginBottom: SPACE[2] },
  assignRow: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: SPACE[2],
    marginBottom: SPACE[1],
  },
  assignRowSelected: { borderColor: SEMANTIC.line.focus },
  assignUnassigned: { minHeight: TAP.console, justifyContent: 'center' },
  assignUnassignedLabel: { ...textStyle('body'), color: SEMANTIC.text.secondary },
  assignUnassignedLabelSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  optionRow: {
    minHeight: TAP.min,
    justifyContent: 'center',
    paddingHorizontal: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
  },
  optionLabel: { ...textStyle('body'), color: SEMANTIC.text.primary },
  optionLabelSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  submitWrap: { marginTop: SPACE[5] },
});
