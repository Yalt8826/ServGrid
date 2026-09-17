/**
 * The AMC form (T2B.4, §D5 "Form"): customer, start (today), end (start
 * + 12 months − 1 day), price, notes. Renew prefills start = old end + 1
 * and the old price; edit prefills everything. An overlap with an
 * existing AMC renders its number AS A LINK, never an error code (the
 * 409's `details.existing`, decision 8's price and the owner's "see
 * which one beat him there").
 *
 * Validation happens on submit only (03-COMPONENTS.md): the messages sit
 * under their fields and `onSubmit` is not called while one stands.
 * Changing Start moves End only while End still IS the untouched default
 * — a hand-edited end is never overwritten. In renew and edit modes the
 * customer is read-only: an AMC never moves between sites (decision 1,
 * the AMC is the site's).
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { COLORS, FRAME, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Banner, Button, CalendarGrid, DatePicker, MoneyField, SectionHeader, Sheet, TextField, useDensity } from '../../components/ui';
import type { IconName } from '../../components/ui/icons';
import { haptic } from '../../components/ui/haptics';
// The IST business day, from the module that already owns that arithmetic
// (`useDispatcherDashboard`'s copy pulls Expo native modules in, which the
// screen tests cannot load). One helper, not a third copy of the shift.
import { istBusinessDateKey } from '../dispatcher/jobLogsFilters';
import { textStyle } from '../../fonts/textStyle';
import { CustomerSearchRows } from '../dispatcher/CustomerSearchRows';
import type { DispatchCustomerOption } from '../dispatcher/dispatchForm';
import { endAfterStartChange, validateAmcDraft, type AmcDraft, type AmcFormProblems } from './model';

export interface AmcFormScreenProps {
  mode: 'new' | 'renew' | 'edit';
  draft: AmcDraft;
  onChange(next: AmcDraft): void;
  customerSearch: {
    query: string;
    results: DispatchCustomerOption[] | null;
    error: string | null;
    onQueryChange(q: string): void;
    onSelect(c: DispatchCustomerOption): void;
    onClear(): void;
  };
  saving: boolean;
  saveError: { message: string; existing: { id: string; contractNumber: string } | null } | null;
  onOpenExisting(id: string): void;
  onSubmit(): void;
}

const TITLE: Record<AmcFormScreenProps['mode'], string> = {
  new: 'New AMC',
  renew: 'Renew AMC',
  edit: 'Edit AMC',
};

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

export function AmcFormScreen(props: AmcFormScreenProps): React.ReactNode {
  const [attempted, setAttempted] = useState(false);
  // Which date field is being picked, if any (2026-09-17). The term used
  // to hang off two bare `DatePicker`s — a field with a trigger and no
  // choosing UI — so a start or an end could be read but never changed.
  const [daySheet, setDaySheet] = useState<'start' | 'end' | null>(null);
  const density = useDensity();
  const bodyStrong = useMemo(() => textStyle('bodyStrong', density), [density]);
  const draft = props.draft;
  const customerPicked = draft.customerId !== null;
  const readOnlyCustomer = props.mode !== 'new';

  const problems: AmcFormProblems = attempted ? validateAmcDraft(draft) : {};

  const submit = (): void => {
    const found = validateAmcDraft(draft);
    setAttempted(true);
    if (found.customer !== undefined || found.startDate !== undefined || found.endDate !== undefined || found.contractValue !== undefined) {
      return;
    }
    props.onSubmit();
  };

  // Start moves End only while End still equals the default the form
  // proposed — the one guard that keeps a hand-edited end safe.
  const onStartChange = (start: string): void => {
    props.onChange({ ...draft, startDate: start, endDate: endAfterStartChange(draft, start, props.mode) });
  };

  return (
    <View style={styles.screen} testID="amc-form">
      {/* The frame (2026-09-17): which form this is, and what it records. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="amc-form-title">
          {TITLE[props.mode]}
        </Text>
        <Text style={styles.frameCaption}>
          {props.mode === 'renew'
            ? 'A new term, prefilled from the one that is ending.'
            : 'A year of cover for one site, at one price.'}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {props.saveError !== null ? (
          props.saveError.existing !== null ? (
            <Banner
              tone="danger"
              message={props.saveError.message}
              actions={[
                {
                  label: `Open ${props.saveError.existing.contractNumber}`,
                  onPress: () => props.onOpenExisting(props.saveError!.existing!.id),
                },
              ]}
              testID="amc-existing-banner"
            />
          ) : (
            <Banner tone="danger" message={props.saveError.message} testID="amc-save-error" />
          )
        ) : null}

        {/* ── customer ────────────────────────────────────────────────── */}
        <Section label="Customer" icon="business" first>
        <View style={styles.fieldWrap} testID="amc-customer">
          {readOnlyCustomer || customerPicked ? (
            <View>
              <Text style={styles.fieldLabel}>Customer</Text>
              <View style={styles.selectedRow} testID="amc-customer-selected">
                <Text numberOfLines={1} style={[styles.selectedName, bodyStrong]}>
                  {draft.customerName ?? ''}
                </Text>
                {!readOnlyCustomer ? (
                  <Pressable
                    testID="amc-customer-change"
                    accessibilityRole="button"
                    accessibilityLabel="Change customer"
                    hitSlop={hitSlop}
                    disabled={props.saving}
                    onPress={() => {
                      haptic('pickerSelect');
                      props.customerSearch.onClear();
                    }}
                    style={styles.selectedClear}
                  >
                    <Text style={styles.selectedClearLabel}>Change</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : (
            <View>
              <TextField
                label="Customer"
                value={props.customerSearch.query}
                onChangeText={props.customerSearch.onQueryChange}
                placeholder="Name or phone — typing searches"
                testID="amc-customer-field"
              />
              {props.customerSearch.error !== null ? (
                <Text style={styles.fieldError} testID="amc-customer-error">
                  {props.customerSearch.error}
                </Text>
              ) : null}
              {props.customerSearch.results !== null && props.customerSearch.results.length > 0 ? (
                <CustomerSearchRows
                  results={props.customerSearch.results}
                  onSelect={props.customerSearch.onSelect}
                  testIDPrefix="amc-customer-result"
                  disabled={props.saving}
                />
              ) : null}
            </View>
          )}
          {problems.customer !== undefined ? (
            <Text style={styles.fieldError} testID="amc-customer-problem">
              {problems.customer}
            </Text>
          ) : null}
        </View>

        </Section>

        {/* ── term ────────────────────────────────────────────────────── */}
        <Section label="Term" icon="calendar">
          <View style={styles.fieldWrap}>
            {/* `DatePicker` has a trigger and no choosing UI of its own —
                a tap used to re-emit the date it already held, so a term
                could be read but never moved. The trigger opens the same
                `CalendarGrid` every other day picker in the app uses. */}
            <DatePicker
              label="Start"
              value={draft.startDate}
              onChange={() => {
                haptic('pickerSelect');
                setDaySheet('start');
              }}
              errorText={problems.startDate}
              disabled={props.saving}
              testID="amc-start"
            />
          </View>
          <View style={styles.fieldWrap}>
            <DatePicker
              label="End"
              value={draft.endDate}
              onChange={() => {
                haptic('pickerSelect');
                setDaySheet('end');
              }}
              helperText="12 months by default"
              errorText={problems.endDate}
              disabled={props.saving}
              testID="amc-end"
            />
          </View>
        </Section>

        {/* ── price and notes ─────────────────────────────────────────── */}
        <Section label="Price" icon="wallet" tint={COLORS.accent}>
        <View style={styles.fieldWrap}>
          <MoneyField
            label="Price"
            value={draft.contractValue}
            onChangeText={(value) => props.onChange({ ...draft, contractValue: value })}
            errorText={problems.contractValue}
            disabled={props.saving}
            testID="amc-price"
          />
        </View>
        </Section>

        <Section label="Notes" icon="document">
          <View style={styles.fieldWrap}>
            <TextField
              label="Notes"
              value={draft.notes}
              onChangeText={(notes) => props.onChange({ ...draft, notes })}
              multiline
              rows={3}
              testID="amc-notes"
            />
          </View>
        </Section>

        <View style={styles.submitWrap}>
          <Button label="Save AMC" icon="check" loading={props.saving} onPress={submit} fullwidth testID="amc-save" />
        </View>
      </ScrollView>

      {/* One day sheet at a time, mounted only while open. The floor is
          what makes the pair coherent: a term may start in the past (the
          record is often backdated) but never end before it starts. */}
      {daySheet === 'start' ? (
        <Sheet visible title="Which day" onDismiss={() => setDaySheet(null)} testID="amc-start-sheet">
          <CalendarGrid
            value={draft.startDate}
            todayIso={istBusinessDateKey(new Date())}
            minIso={AMC_BACKDATE_FLOOR}
            onSelect={(iso) => {
              haptic('pickerSelect');
              onStartChange(iso);
              setDaySheet(null);
            }}
            testID="amc-start-calendar"
          />
        </Sheet>
      ) : null}
      {daySheet === 'end' ? (
        <Sheet visible title="Which day" onDismiss={() => setDaySheet(null)} testID="amc-end-sheet">
          <CalendarGrid
            value={draft.endDate}
            todayIso={istBusinessDateKey(new Date())}
            minIso={draft.startDate}
            onSelect={(iso) => {
              haptic('pickerSelect');
              props.onChange({ ...draft, endDate: iso });
              setDaySheet(null);
            }}
            testID="amc-end-calendar"
          />
        </Sheet>
      ) : null}
    </View>
  );
}

/** How far back a term may be dated. A record is written after the fact
 * often enough that "today" is the wrong floor, and a floor the owner
 * cannot reach is a floor nobody wanted. */
const AMC_BACKDATE_FLOOR = '2020-01-01';

/**
 * One block of the form under its marker — the same shape the dispatch
 * form wears (2026-09-17): the screen was five bare fields in a column,
 * each carrying its own margin, with nothing naming what it was asking.
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
  tint?: string;
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  /** The frame: which form this is (2026-09-17). */
  frame: {
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[3],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8], paddingTop: SPACE[2] },
  section: { marginTop: SPACE[5] },
  sectionFirst: { marginTop: SPACE[3] },
  sectionBody: { alignSelf: 'stretch', gap: SPACE[3], marginTop: SPACE[3] },
  fieldWrap: { alignSelf: 'stretch' },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 },
  fieldError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: 4 },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: TAP.hitSlop,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    minHeight: TAP.console,
  },
  selectedName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 },
  selectedClear: { flexDirection: 'row', alignItems: 'center', gap: SPACE[1], paddingHorizontal: SPACE[2], minHeight: TAP.console, justifyContent: 'center' },
  selectedClearLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  submitWrap: { marginTop: SPACE[5] },
});
