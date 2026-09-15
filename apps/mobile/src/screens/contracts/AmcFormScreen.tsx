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
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, TAP, SPACE } from '@servgrid/shared';
import { Banner, Button, DatePicker, MoneyField, TextField } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
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
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{TITLE[props.mode]}</Text>

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
        <View style={styles.fieldWrap} testID="amc-customer">
          {readOnlyCustomer || customerPicked ? (
            <View>
              <Text style={styles.fieldLabel}>Customer</Text>
              <View style={styles.selectedRow} testID="amc-customer-selected">
                <Text numberOfLines={1} style={styles.selectedName}>
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

        {/* ── term ────────────────────────────────────────────────────── */}
        <View style={styles.fieldWrap}>
          <DatePicker
            label="Start"
            value={draft.startDate}
            onChange={onStartChange}
            errorText={problems.startDate}
            disabled={props.saving}
            testID="amc-start"
          />
        </View>
        <View style={styles.fieldWrap}>
          <DatePicker
            label="End"
            value={draft.endDate}
            onChange={(end) => props.onChange({ ...draft, endDate: end })}
            helperText="12 months by default"
            errorText={problems.endDate}
            disabled={props.saving}
            testID="amc-end"
          />
        </View>

        {/* ── price and notes ─────────────────────────────────────────── */}
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

        <View style={styles.submitWrap}>
          <Button label="Save AMC" loading={props.saving} onPress={submit} fullwidth testID="amc-save" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8] },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary, paddingTop: SPACE[3], paddingBottom: SPACE[2] },
  fieldWrap: { marginTop: SPACE[3] },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 },
  fieldError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: 4 },
  selectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    minHeight: TAP.min,
  },
  selectedName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 },
  selectedClear: { paddingHorizontal: SPACE[2], minHeight: TAP.min, justifyContent: 'center' },
  selectedClearLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  submitWrap: { marginTop: SPACE[5] },
});
