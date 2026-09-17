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
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { alpha, COLORS, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { Banner, Button, CalendarGrid, DatePicker, EmptyState, SectionHeader, Sheet, TextField, useDensity } from '../../components/ui';
import { Icon, type IconName } from '../../components/ui/icons';
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
  const density = useDensity();
  const body = useMemo(() => textStyle('body', density), [density]);
  const sorted = sortTechniciansByLoad(technicians);
  const busiestLoad = sorted.length === 0 ? 0 : Math.max(...sorted.map((technician) => technician.openTotal));
  return (
    <View testID="dispatch-assign-picker" style={styles.assignPanel}>
      {sorted.length === 0 ? (
        // The roster read has not answered yet (or nobody is on it). The
        // screen showed a lone "Leave unassigned" with no sign the crew
        // was still coming; the console's other pickers say so.
        <EmptyState message="No technicians on the roster." testID="dispatch-roster-empty" />
      ) : (
        sorted.map((technician, index) => {
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
              style={[
                styles.assignRow,
                index === 0 ? null : styles.assignRowNext,
                selected ? styles.assignRowSelected : null,
              ]}
            >
              <View style={styles.assignLoad}>
                <TechnicianLoadRow
                  name={technician.name}
                  load={technician.openTotal}
                  maxLoad={busiestLoad}
                  index={index}
                  testID={`dispatch-assign-load-${technician.employeeId}`}
                />
              </View>
              {selected ? <Icon name="check" size={ICON.sm} color={SEMANTIC.text.primary} /> : null}
            </Pressable>
          );
        })
      )}
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
            style={[
              styles.assignRow,
              styles.assignUnassigned,
              sorted.length === 0 ? null : styles.assignRowNext,
              selected ? styles.assignRowSelected : null,
            ]}
          >
            <Icon name="people" size={ICON.sm} color={SEMANTIC.text.secondary} />
            <Text style={[selected ? styles.assignUnassignedLabelSelected : styles.assignUnassignedLabel, body]}>
              Leave unassigned
            </Text>
            {selected ? <Icon name="check" size={ICON.sm} color={SEMANTIC.text.primary} /> : null}
          </Pressable>
        );
      })()}
    </View>
  );
}

// ── a section of the form ────────────────────────────────────────────────

/**
 * One block of the form under its marker (§D3's anatomy, 2026-09-17).
 *
 * The screen used to be one undivided column of white fields: a dozen
 * identical 12pt gaps with a grey word here and there, so the dispatcher
 * reading it back down the phone had nothing to navigate by. Each block
 * now names itself the way every other console screen does — glyph, word,
 * rule — and the fields inside it take a shared gap rather than each
 * carrying its own margin.
 */
function Section({
  label,
  icon,
  tint,
  first = false,
  children,
}: {
  label: string;
  icon: IconName;
  /** The accent, on the one section that carries the screen's decision. */
  tint?: string;
  /** The first block sits under the banners without the section gap. */
  first?: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={[styles.section, first ? styles.sectionFirst : null]}>
      <SectionHeader label={label} icon={icon} {...(tint === undefined ? {} : { tint })} />
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// ── one option row of a picker sheet ─────────────────────────────────────

/**
 * A picker option: leading glyph, word, and a tick when it is the one the
 * dispatcher holds. Keeping the testID and the selected state on this
 * Pressable is what the D3 tests read.
 *
 * `label` is rendered verbatim — a unit's `UPS 850VA · SN LM8842219` is
 * asserted by exact text, so nothing decorative goes inside the word.
 */
function SheetOption({
  testID,
  label,
  selected,
  icon,
  onPress,
}: {
  testID: string;
  label: string;
  selected: boolean;
  icon: IconName;
  onPress(): void;
}): React.ReactNode {
  // Its own density read: this helper is not inside the screen component.
  const density = useDensity();
  const body = useMemo(() => textStyle('body', density), [density]);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.optionRow, selected ? styles.optionRowSelected : null]}
    >
      <Icon name={icon} size={ICON.sm} color={selected ? FRAME.text : SEMANTIC.text.secondary} />
      <Text style={[selected ? styles.optionLabelSelected : styles.optionLabel, body, styles.optionText]}>{label}</Text>
      {selected ? <Icon name="check" size={ICON.sm} color={FRAME.text} /> : null}
    </Pressable>
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

  // Body type follows the density ramp: this screen runs at console (15)
  // for a dispatcher and at desk (14) for the owner, and the module-level
  // `StyleSheet` cannot read the provider (2026-09-17).
  const density = useDensity();
  const body = useMemo(() => textStyle('body', density), [density]);

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
  /** The read is still in flight — the results line is not "no match" yet. */
  const searchInFlight = !hasCustomer && deps.customers === null && deps.customerQuery.trim() !== '';
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
      {/* The navy frame the rest of the console wears: what the screen is
          for, above the form it asks for. The route paints the same navy
          behind the status bar. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="dispatch-form-title">
          Dispatch Job
        </Text>
        <Text style={styles.frameCaption}>Raise a job and name a technician, while the caller is on the phone.</Text>
      </View>
      {/* No stray whitespace on this line: a same-line gap between the
          ScrollView's opening tag and its first child renders as a string
          child of a View — RN's "Text strings must be rendered within a
          <Text> component" (found on device, 2026-09-17). */}
      <ScrollView contentContainerStyle={styles.content}>
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
          <Banner tone="danger" message={deps.submitError} onDismiss={deps.onDismissToast} testID="dispatch-submit-error" />
        ) : null}

        <Section label="Customer" icon="business" first>
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
                <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
              </Pressable>
            </View>
            {/* The AMC offer sits between the chosen customer and the
            unit reveal: it is about THIS customer, read before the work
            is specified (decision 2). A real tick, not a ☑ character —
            the app's other checkboxes are icons. */}
            {deps.amc !== null ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: deps.amcTicked }}
                onPress={deps.onToggleAmc}
                hitSlop={hitSlop}
                style={styles.amcRow}
                testID="dispatch-amc-option"
              >
                <Icon
                  name={deps.amcTicked ? 'checkFilled' : 'check'}
                  size={ICON.md}
                  color={deps.amcTicked ? SEMANTIC.feedback.success : SEMANTIC.text.placeholder}
                />
                <Text style={[styles.amcLabel, body]}>{deps.amc.label}</Text>
              </Pressable>
            ) : null}
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
            {searchInFlight ? (
              <Text style={styles.sheetNote} testID="dispatch-customer-searching">
                Searching…
              </Text>
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
                <Icon name="plus" size={ICON.sm} color={SEMANTIC.text.primary} />
                <Text style={[styles.newCustomerLabel, body]}>+ New customer</Text>
              </Pressable>
            ) : null}
            {attempted && problems.customer !== undefined ? (
              <Text style={styles.fieldError} testID="dispatch-customer-required">
                {problems.customer}
              </Text>
            ) : null}
          </>
        )}
        </Section>

        {/* The unit rides in when the customer is chosen — §D3's one
            progressive-disclosure moment (220ms, opacity/translate; under
            reduced motion it just is). It belongs to the WORK, not to the
            customer record, so it opens this section rather than closing
            the last one (2026-09-17). */}
        <Section label="The work" icon="wrench">
        {hasCustomer ? (
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
                <Icon name="cube" size={ICON.sm} color={SEMANTIC.text.secondary} />
                <Text
                  numberOfLines={1}
                  style={[
                    selectedUnitLabel === null ? styles.triggerPlaceholderLabel : styles.triggerLabel,
                    body,
                    styles.triggerValue,
                  ]}
                >
                  {selectedUnitLabel ?? (deps.stack === null ? 'Loading…' : 'Optional — skip if the caller does not know')}
                </Text>
                <Icon name="chevronDown" size={ICON.sm} color={SEMANTIC.text.secondary} />
              </Pressable>
            </View>
          </Animated.View>
        ) : null}

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
            <Icon name="wrench" size={ICON.sm} color={SEMANTIC.text.secondary} />
            <Text style={[selectedService === null ? styles.triggerPlaceholderLabel : styles.triggerLabel, body, styles.triggerValue]}>
              {selectedService ?? 'Select'}
            </Text>
            <Icon name="chevronDown" size={ICON.sm} color={SEMANTIC.text.secondary} />
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
            <View style={styles.urgentStrip}>
              <Icon name="bell" size={ICON.sm} color={SEMANTIC.feedback.warning} />
              <Text style={styles.urgentNote} testID="dispatch-priority-note">
                {URGENT_SUPPRESSION_NOTE}
              </Text>
            </View>
          ) : null}
        </View>
        </Section>

        <Section label="Schedule" icon="calendar">
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
                <Icon name="clock" size={ICON.sm} color={SEMANTIC.text.secondary} />
                <Text style={[time === null ? styles.triggerPlaceholderLabel : styles.triggerLabel, body, styles.triggerValue]}>
                  {time ?? 'No time'}
                </Text>
                <Icon name="chevronDown" size={ICON.sm} color={SEMANTIC.text.secondary} />
              </Pressable>
            </View>
          </View>
        </Section>

        <Section label="Contact" icon="phone">
          <View style={styles.fieldWrap}>
            <TextField label="Contact name" value={contactName} onChangeText={setContactName} testID="dispatch-contact-name" />
          </View>
          <View style={styles.fieldWrap}>
            <TextField label="Contact phone" value={contactPhone} onChangeText={setContactPhone} testID="dispatch-contact-phone" />
          </View>
        </Section>

        <Section label="Notes" icon="document">
          <View style={styles.fieldWrap}>
            <TextField label="Notes" value={notes} onChangeText={setNotes} multiline rows={3} testID="dispatch-notes" />
          </View>
        </Section>

        {/* The decision the screen exists to make — the one accent marker:
            "the comparison is the decision" (§D3). */}
        <Section label="Assign to" icon="people" tint={COLORS.accent}>
          <Text style={styles.assignHint}>Lightest load first — the comparison is the decision.</Text>
          {attempted && problems.assignment !== undefined ? (
            <Text style={styles.fieldError} testID="dispatch-assign-error">
              {problems.assignment}
            </Text>
          ) : null}
          <TechnicianPicker technicians={deps.technicians} choice={assignment} disabled={deps.submitting} onChoose={setAssignment} />
        </Section>

        <View style={styles.submitWrap}>
          <Button
            label="Create and assign"
            icon="send"
            loading={deps.submitting}
            onPress={submit}
            fullwidth
            testID="dispatch-submit"
          />
        </View>
      </ScrollView>

      {/* One option sheet open at a time; choosing applies and closes. */}
      {sheet === 'unit' ? (
        <Sheet visible title="Which unit" onDismiss={() => setSheet(null)} testID="dispatch-unit-sheet">
          <View style={styles.options}>
            {deps.stack === null ? (
              <Text style={styles.sheetNote} testID="dispatch-unit-loading">
                Reading this site's units…
              </Text>
            ) : null}
            <SheetOption
              testID="unit-option-none"
              label="No specific unit"
              selected={unitId === null}
              icon="cube"
              onPress={() => {
                setUnitId(null);
                setSheet(null);
              }}
            />
            {(deps.stack ?? []).map((unit) => (
              <SheetOption
                key={unit.id}
                testID={`unit-option-${unit.id}`}
                label={unit.label}
                selected={unitId === unit.id}
                icon="cube"
                onPress={() => {
                  setUnitId(unit.id);
                  setSheet(null);
                }}
              />
            ))}
          </View>
        </Sheet>
      ) : null}
      {sheet === 'service' ? (
        <Sheet visible title="What is the work" onDismiss={() => setSheet(null)} testID="dispatch-service-sheet">
          {deps.services.length === 0 ? (
            <EmptyState message="No services in the catalogue." testID="dispatch-service-empty" />
          ) : (
            <View style={styles.options}>
              {deps.services.map((service) => (
                <SheetOption
                  key={service.id}
                  testID={`service-option-${service.id}`}
                  label={service.name}
                  selected={serviceId === service.id}
                  icon="wrench"
                  onPress={() => {
                    setServiceId(service.id);
                    setSheet(null);
                  }}
                />
              ))}
            </View>
          )}
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
          <SheetOption
            testID="date-option-none"
            label="No day"
            selected={scheduledDate === null}
            icon="calendar"
            onPress={() => {
              haptic('pickerSelect');
              setScheduledDate(null);
              setSheet(null);
            }}
          />
        </Sheet>
      ) : null}

      {sheet === 'time' ? (
        <Sheet visible title="When" onDismiss={() => setSheet(null)} testID="dispatch-time-sheet">
          <View style={styles.options}>
            {TIME_SLOTS.map((slot) => (
              <SheetOption
                key={slot}
                testID={`time-option-${slot}`}
                label={slot}
                selected={time === slot}
                icon="clock"
                onPress={() => {
                  setTime(slot);
                  setSheet(null);
                }}
              />
            ))}
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  // The frame (2026-09-17): what the screen is for, on the console's navy.
  frame: {
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[3],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  // One block per section: the marker, then its fields on a shared gap.
  section: { marginTop: SPACE[5] },
  sectionFirst: { marginTop: SPACE[3] },
  sectionBody: { alignSelf: 'stretch', gap: SPACE[3], marginTop: SPACE[3] },
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
  fieldWrap: { alignSelf: 'stretch' },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 },
  /** A sheet's line of prose — a state the sheet is in, not an error. */
  sheetNote: { ...textStyle('caption'), color: SEMANTIC.text.secondary, paddingVertical: SPACE[2] },
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
  amcLabel: { color: SEMANTIC.text.primary, flex: 1 },
  newCustomerRow: {
    minHeight: TAP.console,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  newCustomerLabel: { color: SEMANTIC.text.primary, fontWeight: '600' },
  trigger: {
    minHeight: TAP.console,
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: SPACE[3],
    alignItems: 'center',
    flexDirection: 'row',
    gap: SPACE[2],
  },
  /** The value owns the middle of the row, between its glyph and caret. */
  triggerValue: { flex: 1 },
  triggerLabel: { color: SEMANTIC.text.primary },
  triggerPlaceholderLabel: { color: SEMANTIC.text.placeholder },
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
  // The app's one "this is on" fill: navy, with the label in light ink —
  // the same selected state the complete sheet's segments wear.
  segmentActive: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  segmentPressed: { backgroundColor: SEMANTIC.bg.pressed },
  segmentLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  segmentLabelActive: { ...textStyle('label'), color: SEMANTIC.text.onDark },
  /** Urgent is a state worth a strip, not a line of small amber print. */
  urgentStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.warning, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.warning, TINT.chip),
  },
  urgentNote: { ...textStyle('caption'), color: SEMANTIC.text.primary, flex: 1 },
  scheduleRow: { flexDirection: 'row', gap: SPACE[2] },
  scheduleDate: { flex: 1 },
  scheduleTime: { width: 128 },
  assignHint: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  // The crew is one panel of hairline rows — the console's own roster
  // shape (the dashboard's load panel, the job detail's picker), not a
  // stack of separate boxes.
  assignPanel: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  assignRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[2],
  },
  /** The load row owns the width; the tick rides the trailing edge. */
  assignLoad: { flex: 1 },
  assignRowNext: { borderTopWidth: 1, borderTopColor: SEMANTIC.line.default },
  assignRowSelected: { backgroundColor: alpha(COLORS.accent, TINT.band) },
  assignUnassigned: { minHeight: TAP.console, flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  assignUnassignedLabel: { color: SEMANTIC.text.secondary, flex: 1 },
  assignUnassignedLabelSelected: { color: SEMANTIC.text.primary, fontWeight: '600', flex: 1 },
  /** A sheet of options: a spaced stack, the chosen one navy with a tick. */
  options: { alignSelf: 'stretch', gap: SPACE[1] },
  optionRow: {
    minHeight: TAP.console,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  optionRowSelected: { backgroundColor: SEMANTIC.bg.dark },
  optionText: { flex: 1 },
  optionLabel: { color: SEMANTIC.text.primary },
  optionLabelSelected: { color: SEMANTIC.text.onDark, fontWeight: '600' },
  submitWrap: { marginTop: SPACE[5] },
});
