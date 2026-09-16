/**
 * D4 Customer (T2.10, UI/plan-2/05-DISPATCHER.md §D4) — find a customer,
 * see their site and history, correct their details. The dispatcher's
 * worst moment is the phone ringing while a technician is already
 * on-site: the answer has to be a search away, scannable.
 *
 * Anatomy, exactly: **search over name and phone, two-line rows** ·
 * detail as **name, phones (tappable to call), address, area · the
 * product stack, read-only · job history as `JobRow`s · notes**.
 *
 * The two absences the spec is explicit about:
 *
 * - **No company field on the dispatcher's form.** Not rendered, and
 *   stripped server-side (`DispatcherCustomerCreateSchema` /
 *   `dispatcherCustomerPatchSchema`, PLAN.md §5 rule 3). The form fields
 *   don't even carry a `companyId` in their type — see
 *   `customerForm.ts`. The OWNER's routes (§O4b) pass the company
 *   capability to the SAME form, which is how his copy grows the field
 *   without a second form existing.
 * - **The stack is read-only here.** Technicians own the stack because
 *   they are the ones who know what got fitted (PLAN.md §4); a
 *   dispatcher editing it from a phone call is how a serial number
 *   becomes wrong. The `StackSection` takes its capability as a PROP —
 *   `editable={false}` on this screen — never a role read from context,
 *   so the same component can serve the owner in Phase 4 without a
 *   second branch.
 *
 * The screens are pure over injected data (the seam T2.7–T2.9 use);
 * `useCustomer.ts` is the online wiring and the route files mount them
 * behind `dispatch.console`. Online-only (PLAN-FRONTEND.md §4): the
 * failure mode is an explicit error state, never a queue.
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { STATUS, SEMANTIC, SPACE, TAP, type JobStatus } from '@servgrid/shared';
import type { CustomerDetailDispatcher } from '@servgrid/shared';
import { Banner, Button, EmptyState, Sheet, TextField } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import {
  emptyCustomerForm,
  validateCustomerForm,
  type CustomerFormFields,
  type CustomerFormProblems,
} from './customerForm';
import { firstNameOf } from './dispatchForm';
import { shortJobNumber } from './jobLogsFilters';

export const CUSTOMER_OFFLINE_MESSAGE = 'No connection. This screen is not live.';

const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 };

/** One search hit — the two-line row's content. */
export interface CustomerSearchRow {
  id: string;
  name: string;
  phone: string;
  /** `addressLine1`, or the city when the line is missing — one line. */
  addressLabel: string | null;
}

/** One unit of the site's stack, labelled for display. */
export interface CustomerStackUnit {
  id: string;
  /** `UPS 850VA · SN LM8842219` — the catalogue name, or the technician's
   * free text when he fitted something off-catalogue. */
  label: string;
}

/** One job in the site's history, ready to render as a `JobRow`. */
export interface CustomerHistoryJob {
  id: string;
  jobNumber: string;
  title: string;
  status: JobStatus;
  scheduledFor: string | null;
  technicianName: string | null;
}

// ── the stack section — capability as a prop, never a role read ──────────

/**
 * The site's product stack. `editable` is the seam the spec's "If it
 * fails" names: the DISPATCHER screen passes `false`, and nothing in
 * this component reads a role from context — Phase 4's owner screen
 * passes `true` to the same component, no second branch.
 *
 * Read-only (`editable={false}`): plain rows, no `Pressable`, no edit
 * affordance anywhere in the subtree — a serial number a dispatcher can
 * see but cannot touch from a phone call.
 */
export function StackSection({
  units,
  editable,
  onEditUnit,
}: {
  units: CustomerStackUnit[] | null;
  editable: boolean;
  onEditUnit?: (unitId: string) => void;
}): React.ReactNode {
  return (
    <View style={styles.section} testID="customer-stack">
      <Text style={styles.sectionLabel}>The stack</Text>
      {units === null ? null : units.length === 0 ? (
        <Text style={[styles.body, styles.stackEmpty]} testID="customer-stack-empty">
          No units recorded at this site.
        </Text>
      ) : (
        units.map((unit) =>
          editable ? (
            <Pressable
              key={unit.id}
              testID={`customer-stack-item-${unit.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${unit.label}`}
              onPress={onEditUnit === undefined ? undefined : () => onEditUnit(unit.id)}
              style={styles.stackRow}
            >
              <Text numberOfLines={1} style={styles.stackLabel}>
                {unit.label}
              </Text>
              <Text style={styles.stackEditLabel}>Edit</Text>
            </Pressable>
          ) : (
            <View key={unit.id} testID={`customer-stack-item-${unit.id}`} style={styles.stackRow}>
              <Text numberOfLines={1} style={styles.stackLabel}>
                {unit.label}
              </Text>
            </View>
          ),
        )
      )}
    </View>
  );
}

/**
 * The site's address and its captured location — one block, both detail
 * screens (2026-09-17).
 *
 * The owner asked for a site to read as three distinct things: its
 * **area** (the locality), its **address**, and its **location** (where
 * the technician actually stood). This renders the last two; the area
 * leads the address line, because a locality is the part of an address
 * a person navigates by. The owner's console and the dispatcher's phone
 * mount the same block through the same import — `StackSection`'s
 * precedent — so the two can never describe a site differently.
 *
 * The coordinates are shown to six decimals, which is ~10cm: enough that
 * a technician reading them off one screen into another lands on the
 * gate rather than the street. `onOpenMap` is the caller's, because only
 * the caller knows how its platform opens a map.
 */
export interface SiteFactFields {
  addressLine1: string | null;
  addressLine2: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** "Rajajinagar · Bengaluru 560010", skipping whatever is unknown. */
export function areaLineOf(facts: {
  area: string | null;
  city: string | null;
  pincode: string | null;
}): string | null {
  const place = [facts.city, facts.pincode].filter((p): p is string => p !== null && p !== '').join(' ');
  const parts = [facts.area, place].filter((p) => p !== null && p !== '');
  return parts.length === 0 ? null : parts.join(' · ');
}

export function SiteFacts({
  facts,
  onOpenMap,
}: {
  facts: SiteFactFields;
  onOpenMap?: (latitude: number, longitude: number) => void;
}): React.ReactNode {
  const areaLine = areaLineOf(facts);
  const pinned = facts.latitude !== null && facts.longitude !== null;
  return (
    <>
      <View style={styles.section} testID="customer-address-block">
        <Text style={styles.sectionLabel}>Address</Text>
        {facts.addressLine1 !== null && facts.addressLine1 !== '' ? (
          <Text style={styles.body} testID="customer-address">
            {facts.addressLine1}
          </Text>
        ) : null}
        {facts.addressLine2 !== null && facts.addressLine2 !== '' ? (
          <Text style={styles.body}>{facts.addressLine2}</Text>
        ) : null}
        {areaLine !== null ? (
          <Text style={[styles.body, styles.areaText]} testID="customer-area">
            {areaLine}
          </Text>
        ) : null}
      </View>

      <View style={styles.section} testID="customer-location-block">
        <Text style={styles.sectionLabel}>Location</Text>
        {pinned ? (
          <Pressable
            testID="customer-location"
            accessibilityRole={onOpenMap === undefined ? undefined : 'link'}
            accessibilityLabel="Open the site on a map"
            onPress={onOpenMap === undefined ? undefined : () => onOpenMap(facts.latitude!, facts.longitude!)}
            style={styles.stackRow}
          >
            <Text style={styles.body}>
              {`${facts.latitude!.toFixed(6)}, ${facts.longitude!.toFixed(6)}`}
            </Text>
            {onOpenMap === undefined ? null : <Text style={styles.stackEditLabel}>Map</Text>}
          </Pressable>
        ) : (
          // No pin yet is a fact about the site, not a broken screen — and
          // it says who fills it, because the office cannot.
          <Text style={[styles.body, styles.areaText]} testID="customer-location-empty">
            Not recorded yet — a technician captures this on site.
          </Text>
        )}
      </View>
    </>
  );
}

// ── the history row — the `JobRow` (03-COMPONENTS.md), 56 tall ───────────

/** `assigned` has no dedicated ramp entry — it rides the unassigned
 * slate, exactly as the D2 row does. */
function statusToneOf(status: JobStatus): { label: string; color: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: STATUS.completed };
    case 'en_route':
      return { label: 'En route', color: STATUS.en_route };
    case 'in_progress':
      return { label: 'In progress', color: STATUS.in_progress };
    case 'cancelled':
      return { label: 'Cancelled', color: STATUS.cancelled };
    default:
      return { label: status === 'assigned' ? 'Assigned' : 'Unassigned', color: STATUS.unassigned };
  }
}

/** `14:30` — the IST wall clock the api already sends. */
function slotLabelOf(scheduledFor: string | null): string {
  return scheduledFor === null ? 'no date' : scheduledFor.slice(11, 16);
}

/**
 * ▌JC-…0042  Battery swap           → line 1: number + the work
 * ▌Ravi · 14:30          ● In progress → line 2: who · when, status
 *
 * The 4px status rail keeps the shared leading edge that makes the card
 * and the row read as one object at two densities — the customer's
 * history reads in the same visual language as Job Logs (§D2).
 */
function HistoryRow({
  job,
  onPress,
  testID,
}: {
  job: CustomerHistoryJob;
  onPress: (jobId: string) => void;
  testID: string;
}): React.ReactNode {
  const tone = statusToneOf(job.status);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Job ${job.jobNumber}`}
      onPress={() => onPress(job.id)}
      style={styles.historyRow}
    >
      <View style={[styles.rail, { backgroundColor: tone.color }]} />
      <View style={styles.historyBody}>
        <Text numberOfLines={1} style={styles.historyLine1}>
          {`${shortJobNumber(job.jobNumber)} · ${job.title}`}
        </Text>
        <View style={styles.historyLine2}>
          <Text numberOfLines={1} style={styles.historyWho}>
            {job.technicianName === null
              ? 'Unassigned'
              : `${firstNameOf(job.technicianName)} · ${slotLabelOf(job.scheduledFor)}`}
          </Text>
          <View style={styles.spacer} />
          <View style={styles.statusGroup}>
            <View style={[styles.dot, { backgroundColor: tone.color }]} />
            <Text style={styles.statusLabel}>{tone.label}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ── the search screen — /customers ───────────────────────────────────────

export interface CustomerSearchDeps {
  offline: boolean;
  /** The search box's text — hook-owned; the screen renders it. */
  query: string;
  /** The search's answers, or null while the search runs. */
  results: CustomerSearchRow[] | null;
  error: string | null;
  onQueryChange(query: string): void;
  /** The failed search's Retry — a real refetch, not a re-render. */
  onRetry(): void;
  onOpenCustomer(customerId: string): void;
  /** No match offers create inline — the same pattern D3's search uses. */
  onNewCustomer(): void;
}

export function CustomerSearchScreen(deps: CustomerSearchDeps): React.ReactNode {
  const noMatch = deps.results !== null && deps.results.length === 0 && deps.query.trim() !== '';
  return (
    <View style={styles.screen} testID="customer-search-screen">
      {deps.offline ? <Banner tone="danger" message={CUSTOMER_OFFLINE_MESSAGE} testID="customer-offline-banner" /> : null}
      <View style={styles.searchWrap}>
        <TextField
          label="Customer"
          value={deps.query}
          onChangeText={deps.onQueryChange}
          placeholder="Name or phone — typing searches"
          testID="customer-search-field"
        />
      </View>
      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetry} testID="customer-search-error" />
      ) : null}
      {deps.results !== null && deps.results.length > 0 ? (
        <View style={styles.results}>
          {deps.results.map((customer) => (
            <Pressable
              key={customer.id}
              testID={`customer-result-${customer.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${customer.name}`}
              onPress={() => deps.onOpenCustomer(customer.id)}
              style={styles.resultRow}
            >
              <Text numberOfLines={1} style={styles.resultName}>
                {customer.name}
              </Text>
              <Text numberOfLines={1} style={styles.resultMeta}>
                {customer.phone}
                {customer.addressLabel === null ? '' : ` · ${customer.addressLabel}`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {noMatch ? (
        <Pressable
          testID="customer-new-inline"
          accessibilityRole="button"
          onPress={deps.onNewCustomer}
          style={styles.newCustomerRow}
        >
          <Text style={styles.newCustomerLabel}>+ New customer</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── the detail screen — /customers/[id] ──────────────────────────────────

export interface CustomerDetailDeps {
  offline: boolean;
  /** The site, its stack and the address block, in one read; null while
   * it loads. The dispatcher's shape has no `companyId` at all. */
  detail: CustomerDetailDispatcher | null;
  /** The stack, labelled for display — read-only on this screen. */
  stack: CustomerStackUnit[] | null;
  /** The site's jobs, newest first — rendered as `JobRow`s. */
  history: CustomerHistoryJob[] | null;
  detailError: string | null;
  historyError: string | null;
  /** Phones are tappable to call (§D4) — the route owns the dialler. */
  onCall(phone: string): void;
  /** The site's captured location, opened in whatever map the platform has. */
  onOpenMap?(latitude: number, longitude: number): void;
  onEdit(): void;
  onOpenJob(jobId: string): void;
  onRetry(): void;
}

function phoneRow(phone: string, testID: string, onCall: (phone: string) => void): React.ReactNode {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Call ${phone}`}
      onPress={() => onCall(phone)}
      style={styles.phoneRow}
    >
      <Text style={styles.phoneValue}>{phone}</Text>
      <Text style={styles.phoneAction}>Call</Text>
    </Pressable>
  );
}

export function CustomerDetailScreen(deps: CustomerDetailDeps): React.ReactNode {
  const detail = deps.detail;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="customer-detail-screen">
      {deps.offline ? <Banner tone="danger" message={CUSTOMER_OFFLINE_MESSAGE} testID="customer-offline-banner" /> : null}
      {deps.detailError !== null ? (
        <EmptyState message={deps.detailError} actionLabel="Retry" onAction={deps.onRetry} testID="customer-detail-error" />
      ) : detail === null ? null : (
        <>
          <Text style={styles.title} testID="customer-name">
            {detail.name}
          </Text>

          <View style={styles.section} testID="customer-phones">
            <Text style={styles.sectionLabel}>Phone</Text>
            {phoneRow(detail.phone, 'customer-call-primary', deps.onCall)}
            {detail.altPhone !== null ? phoneRow(detail.altPhone, 'customer-call-alt', deps.onCall) : null}
          </View>

          <SiteFacts facts={detail} onOpenMap={deps.onOpenMap} />

          {/* The stack, READ-ONLY: the capability is passed down as a prop
          (`editable={false}`), never read from a role — §D4's second
          absence, and the seam Phase 4's owner screen reuses with `true`. */}
          <StackSection units={deps.stack} editable={false} />

          <View style={styles.section} testID="customer-history">
            <Text style={styles.sectionLabel}>Job history</Text>
            {deps.historyError !== null ? (
              <EmptyState message={deps.historyError} testID="customer-history-error" />
            ) : deps.history === null ? null : deps.history.length === 0 ? (
              <Text style={[styles.body, styles.stackEmpty]} testID="customer-history-empty">
                No jobs yet.
              </Text>
            ) : (
              deps.history.map((job) => (
                <HistoryRow
                  key={job.id}
                  job={job}
                  onPress={deps.onOpenJob}
                  testID={`customer-history-${job.id}`}
                />
              ))
            )}
          </View>

          {detail.notes !== null && detail.notes.trim() !== '' ? (
            <View style={styles.section} testID="customer-notes-block">
              <Text style={styles.sectionLabel}>Notes</Text>
              <Text style={styles.body} testID="customer-notes">
                {detail.notes}
              </Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button label="Edit customer" variant="secondary" onPress={deps.onEdit} fullwidth testID="customer-edit" />
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ── the form — /customers/new and /customers/[id]/edit ───────────────────

/**
 * The COMPANY field as a capability prop (§O4b, the same seam as
 * `StackSection`'s `editable`): the DISPATCHER'S routes never pass it,
 * so the field is not on his form at all; the OWNER'S routes pass it,
 * and the same form renders it on create and on edit. `companyId` is an
 * owner and rep field (PLAN.md §5) and the api strips it from
 * dispatcher payloads — the form carries that as a type, not as trust.
 */
export interface CustomerFormCompanyDeps {
  /** The accounts the owner can link the site to, name ascending. */
  companies: ReadonlyArray<{ id: string; name: string }>;
  selectedCompanyId: string | null;
  /** `null` detaches the site — a house-account-less site is normal. */
  onSelectCompany(companyId: string | null): void;
  disabled?: boolean;
}

export interface CustomerFormDeps {
  offline: boolean;
  mode: 'create' | 'edit';
  /** Edit mode's starting point — the record as it stands. Create starts
   * blank. Fields live in the screen; this fills once when it arrives. */
  initial: CustomerFormFields | null;
  saving: boolean;
  submitError: string | null;
  /** Present for the owner (§O4b): renders the company field, create and edit. */
  company?: CustomerFormCompanyDeps | null;
  /** Called only when the submit-time validation passes. */
  onSave(fields: CustomerFormFields): void;
  onCancel(): void;
}

export function CustomerFormScreen(deps: CustomerFormDeps): React.ReactNode {
  const [fields, setFields] = useState<CustomerFormFields>(deps.initial ?? emptyCustomerForm());
  const [filledFrom, setFilledFrom] = useState<CustomerFormFields | null>(deps.initial);
  const [attempted, setAttempted] = useState(false);
  const [companySheetOpen, setCompanySheetOpen] = useState(false);

  // Edit mode's record arrives from the network after mount. Fill once,
  // and only while the dispatcher has not started typing — a value he
  // entered is never overwritten by a late fetch.
  useEffect(() => {
    if (deps.initial === null) return;
    if (filledFrom !== null) return;
    const untouched = Object.values(fields).every((value) => value === '');
    if (untouched) {
      setFields(deps.initial);
      setFilledFrom(deps.initial);
    }
  }, [deps.initial, fields, filledFrom]);

  const problems: CustomerFormProblems = attempted ? validateCustomerForm(fields) : {};

  const save = (): void => {
    setAttempted(true);
    const nextProblems = validateCustomerForm(fields);
    if (nextProblems.name !== undefined || nextProblems.phone !== undefined) return;
    deps.onSave(fields);
  };

  const change = (field: keyof CustomerFormFields) => (value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="customer-form-screen">
      {deps.offline ? <Banner tone="danger" message={CUSTOMER_OFFLINE_MESSAGE} testID="customer-offline-banner" /> : null}
      <Text style={styles.title} testID="customer-form-title">
        {deps.mode === 'create' ? 'New customer' : 'Edit customer'}
      </Text>
      {deps.submitError !== null ? <Banner tone="danger" message={deps.submitError} testID="customer-form-error" /> : null}

      {/* The form fields. The COMPANY field renders only when the route
      passed the capability (§O4b) — the dispatcher's routes do not, so
      on his form there is no company field at all (§D4's first
      absence), and his payload type cannot carry one regardless. */}
      <View style={styles.fieldWrap}>
        <TextField label="Name" value={fields.name} onChangeText={change('name')} testID="customer-field-name" />
        {problems.name !== undefined ? (
          <Text style={styles.fieldError} testID="customer-field-name-error">
            {problems.name}
          </Text>
        ) : null}
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="Phone" value={fields.phone} onChangeText={change('phone')} testID="customer-field-phone" />
        {problems.phone !== undefined ? (
          <Text style={styles.fieldError} testID="customer-field-phone-error">
            {problems.phone}
          </Text>
        ) : null}
      </View>
      {/* The company field — only where the capability was passed (§O4b).
      The dispatcher's form renders nothing here: no prop, no field, and
      the payload type cannot carry one regardless. */}
      {deps.company !== undefined && deps.company !== null ? (
        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>Company</Text>
          <Pressable
            testID="customer-field-company"
            accessibilityRole="button"
            accessibilityState={{ disabled: deps.company.disabled === true }}
            disabled={deps.company.disabled === true}
            hitSlop={hitSlop}
            onPress={() => {
              haptic('pickerSelect');
              setCompanySheetOpen(true);
            }}
            style={styles.trigger}
          >
            <Text
              style={
                deps.company.selectedCompanyId === null ? styles.triggerPlaceholderLabel : styles.triggerLabel
              }
            >
              {companyLabelOf(deps.company)}
            </Text>
            <Text style={styles.triggerChevron}> ▾</Text>
          </Pressable>
          <Text style={styles.fieldHelper}>Links the site's jobs to the company ledger.</Text>
        </View>
      ) : null}
      <View style={styles.fieldWrap}>
        <TextField label="Alt phone" value={fields.altPhone} onChangeText={change('altPhone')} testID="customer-field-alt-phone" />
      </View>
      <View style={styles.fieldWrap}>
        <TextField
          label="Area"
          value={fields.area}
          onChangeText={change('area')}
          placeholder="Rajajinagar, Koramangala…"
          testID="customer-field-area"
        />
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="Address line 1" value={fields.addressLine1} onChangeText={change('addressLine1')} testID="customer-field-address1" />
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="Address line 2" value={fields.addressLine2} onChangeText={change('addressLine2')} testID="customer-field-address2" />
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="City" value={fields.city} onChangeText={change('city')} testID="customer-field-city" />
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="Pincode" value={fields.pincode} onChangeText={change('pincode')} testID="customer-field-pincode" />
      </View>
      <View style={styles.fieldWrap}>
        <TextField label="Notes" value={fields.notes} onChangeText={change('notes')} multiline rows={3} testID="customer-field-notes" />
      </View>

      <View style={styles.actions}>
        <Button label="Save customer" loading={deps.saving} onPress={save} fullwidth testID="customer-save" />
        <Button label="Cancel" variant="ghost" onPress={deps.onCancel} fullwidth testID="customer-cancel" />
      </View>

      {/* The company picker — the owner's one extra sheet. Choosing applies
      and closes; "No company" detaches the site. */}
      {deps.company !== undefined && deps.company !== null && companySheetOpen ? (
        <Sheet visible title="Which company" onDismiss={() => setCompanySheetOpen(false)} testID="customer-company-sheet">
          <Pressable
            testID="company-option-none"
            accessibilityRole="button"
            accessibilityState={{ selected: deps.company.selectedCompanyId === null }}
            onPress={() => {
              deps.company?.onSelectCompany(null);
              setCompanySheetOpen(false);
            }}
            style={styles.optionRow}
          >
            <Text style={deps.company.selectedCompanyId === null ? styles.optionLabelSelected : styles.optionLabel}>
              No company
            </Text>
          </Pressable>
          {deps.company.companies.map((company) => (
            <Pressable
              key={company.id}
              testID={`company-option-${company.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: deps.company?.selectedCompanyId === company.id }}
              onPress={() => {
                deps.company?.onSelectCompany(company.id);
                setCompanySheetOpen(false);
              }}
              style={styles.optionRow}
            >
              <Text style={deps.company?.selectedCompanyId === company.id ? styles.optionLabelSelected : styles.optionLabel}>
                {company.name}
              </Text>
            </Pressable>
          ))}
        </Sheet>
      ) : null}
    </ScrollView>
  );
}

/** The trigger's label — the linked account's name, or the honest empty. */
function companyLabelOf(company: CustomerFormCompanyDeps): string {
  if (company.selectedCompanyId === null) return 'No company';
  return company.companies.find((c) => c.id === company.selectedCompanyId)?.name ?? 'No company';
}

// ── shared styles ────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8] },
  searchWrap: { paddingTop: SPACE[3] },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary, paddingTop: SPACE[3], paddingBottom: SPACE[2] },
  section: { marginTop: SPACE[4], gap: SPACE[1] },
  sectionLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  body: { ...textStyle('body'), color: SEMANTIC.text.primary },
  areaText: { color: SEMANTIC.text.secondary },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TAP.console,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingHorizontal: SPACE[3],
  },
  phoneValue: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  phoneAction: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  stackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TAP.console,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    paddingHorizontal: SPACE[3],
  },
  stackLabel: { ...textStyle('body'), color: SEMANTIC.text.primary, flexShrink: 1 },
  stackEditLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  stackEmpty: { color: SEMANTIC.text.secondary },
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
  rail: { width: 3, borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },
  historyBody: { flex: 1, justifyContent: 'center', gap: 2, paddingHorizontal: SPACE[3], paddingVertical: SPACE[2] },
  historyLine1: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  historyLine2: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  historyWho: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flexShrink: 1 },
  spacer: { flex: 1 },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { ...textStyle('caption'), color: SEMANTIC.text.primary },
  results: { marginTop: SPACE[1], borderWidth: 1, borderColor: SEMANTIC.line.default, borderRadius: 4 },
  resultRow: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
  resultName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  resultMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
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
  fieldWrap: { marginTop: SPACE[3] },
  fieldError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: 4 },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 },
  fieldHelper: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: 4 },
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
  optionRow: {
    minHeight: TAP.min,
    justifyContent: 'center',
    paddingHorizontal: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
  },
  optionLabel: { ...textStyle('body'), color: SEMANTIC.text.primary },
  optionLabelSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  actions: { marginTop: SPACE[5], gap: SPACE[3] },
});
