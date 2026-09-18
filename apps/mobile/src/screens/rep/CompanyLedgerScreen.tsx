/**
 * S4 Companies — detail and ledger (UI/plan-2/06-SALES-REP.md §S4).
 * Header: name, contact person, phone (tappable), GSTIN — and the balance
 * as the largest figure on screen, rendered through `creditView` (the
 * word Credit in `feedback.success` for an overpayment, never a minus in
 * red).
 *
 * The ledger, as three views (2026-09-18, Yashas: "two tabs one for
 * sales and one for payments with date filter option" — and the
 * interleaved view kept, because the running balance is the story of how
 * the balance got here and splitting the documents must not lose it):
 * **All / Sales / Payments**, plus a **one-day filter** — the Sales
 * page's chip and calendar, floored far back because the whole point is
 * looking at days already gone.
 *
 * Every row keeps its **running balance** in all three tabs — it is the
 * server's (`CompanyLedgerSchema.runningBalance`), computed over the full
 * interleaved sequence, so a Sales-only tab still shows the account's
 * truth as of each document rather than a running sum of sales alone.
 * The rep's phone and the owner's desktop cannot disagree about money.
 *
 * **A row opens the document it names** (2026-09-18): a sale's page with
 * its product lines, a payment's with how it was collected. Until then
 * the rep could walk into an account's history and go no further — the
 * owner's desk has opened these from the same ledger all along, through
 * `SaleItemsSheet` and `PaymentProofSheet`, and the phone's copy of the
 * row simply never got the press.
 *
 * Actions: *Record payment* (primary) · *New sale* (secondary). **No
 * reassign-owner control** — only the owner can move an account.
 *
 * Pure UI over injected deps; `useRepCompanyLedger` owns the reads.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { Company, CompanyLedger } from '@servgrid/shared';
import { COLORS, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Banner, Button, CalendarGrid, EmptyState, Sheet } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { istBusinessDate } from '../cash/handoverModel';
import { creditView, ledgerAmountOf } from './money';
import { RecordPaymentSheet, type RecordPaymentInput } from './PaymentsScreen';
import type { SaleRow } from './model';

/** How far back the day filter reaches — a constant, not today: the whole
 * point of the filter is looking at days already gone (the Sales page's
 * own lesson: CalendarGrid's today floor greyed out every day he wanted). */
export const LEDGER_HISTORY_FLOOR = '2020-01-01';

/** The three views of the account's money. `all` is first and the default —
 * the interleaved story of the balance is what a ledger IS. */
export type LedgerTab = 'all' | 'sale' | 'payment';

const TABS: readonly { key: LedgerTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sale', label: 'Sales' },
  { key: 'payment', label: 'Payments' },
];

export interface CompanyLedgerScreenProps {
  company: Company | null;
  ledger: CompanyLedger | null;
  error: string | null;
  loading: boolean;
  /** Confirmed sales — the record-payment sheet's *Against* options. */
  openSales: SaleRow[];
  pendingRecord: { busy: boolean; error: string | null };
  /** Forwarded to the record-payment sheet's submit gate. */
  online: boolean;
  record: (input: RecordPaymentInput) => Promise<void>;
  captureProof?: () => Promise<string | null>;
  onRecorded: () => void;
  onNewSale: (companyId: string) => void;
  /**
   * A ledger row opens what it names (2026-09-18): the sale's own page with
   * its product lines, or the payment's. The owner's desk has done exactly
   * this off this same ledger from the start — `SaleItemsSheet` and
   * `PaymentProofSheet` hung on `ledger-row-…` — and the rep's copy of the
   * row was never given it, so an account's documents were a dead end on
   * the phone. Left `undefined` the rows stay inert, which is what keeps
   * this screen usable without a router.
   */
  onOpenSale?: (saleId: string) => void;
  onOpenPayment?: (paymentId: string) => void;
  /** The tappable phone (§S4) — the route owns the dialer (`Linking`). */
  onCallPhone?: (phone: string) => void;
  onRetry: () => void;
  testID?: string;
}

export function CompanyLedgerScreen(props: CompanyLedgerScreenProps): React.ReactNode {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<LedgerTab>('all');
  const [day, setDay] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const nowYear = new Date().getFullYear();
  // The calendar's today, the same seam as nowYear — the picker marks it
  // and opens on its month, nothing else depends on it.
  const today = istBusinessDate(new Date());
  const company = props.company;
  const balanceView = props.ledger === null ? null : creditView(props.ledger.balance);
  // The frame is full-bleed with its own padding, so the tab row sizes from
  // the frame's content box — the overflow lesson, again.
  const { width } = useWindowDimensions();
  const tabWidth = (width - SPACE[4] * 2) / TABS.length;
  const entries = props.ledger?.entries ?? [];
  const shown = entries.filter(
    (entry) => (tab === 'all' || entry.kind === tab) && (day === null || entry.date === day),
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'company-ledger'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="company-ledger-error" />
      ) : null}

      {company !== null ? (
        <View style={styles.frame} testID="company-header">
          <Text style={styles.frameTitle} testID="company-name">
            {company.name}
          </Text>
          {company.contactPerson !== null ? (
            <Text style={styles.meta} testID="company-contact">
              {company.contactPerson}
            </Text>
          ) : null}
          {company.phone !== null ? (
            <Text
              style={[styles.meta, styles.phone]}
              onPress={() => props.onCallPhone?.(company.phone ?? '')}
              testID="company-phone"
            >
              {company.phone}
            </Text>
          ) : null}
          {company.gstin !== null ? (
            <Text style={styles.meta} testID="company-gstin">
              {company.gstin}
            </Text>
          ) : null}
          {/* The three views as tabs on the frame — the service-call
              screen's control. All is first: the interleaved story. */}
          <View accessibilityRole="tablist" style={styles.tabs}>
            {TABS.map((entry) => {
              const selected = entry.key === tab;
              return (
                <Pressable
                  key={entry.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => setTab(entry.key)}
                  style={[styles.tab, { width: tabWidth }, selected ? styles.tabSelected : null]}
                  testID={`ledger-tab-${entry.key}`}
                >
                  <Text style={[styles.tabLabel, selected ? styles.tabLabelSelected : null]}>
                    {entry.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {balanceView !== null ? (
        <View style={[styles.balanceBlock, styles.body]}>
          <Text style={[styles.balance, { color: balanceView.color }]} testID="company-balance">
            {balanceView.text}
          </Text>
          <Text style={styles.balanceCaption}>balance</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <View style={styles.actionCell}>
          <Button label="New sale" icon="plus" variant="secondary" onPress={() => company !== null && props.onNewSale(company.id)} fullwidth testID="company-new-sale" />
        </View>
        <View style={styles.actionCell}>
          <Button label="Record payment" icon="wallet" onPress={() => setSheetOpen(true)} fullwidth testID="company-record-payment" />
        </View>
      </View>

      {/* The day filter: one control, the calendar behind it, and a way
          back to every day — the Sales page's chip, on this account. */}
      {props.ledger !== null ? (
        <View style={[styles.filterBar, styles.body]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: day !== null }}
            onPress={() => setPicking(true)}
            style={[styles.filterChip, day === null ? null : styles.filterChipOn]}
            testID="ledger-filter-day"
          >
            <Icon name="calendar" size={ICON.sm} color={day === null ? SEMANTIC.text.secondary : FRAME.text} />
            <Text style={day === null ? styles.filterLabel : styles.filterLabelOn}>
              {day === null ? 'Any day' : formatDateEnIN(day, nowYear)}
            </Text>
            <Icon name="chevronDown" size={ICON.sm} color={day === null ? SEMANTIC.text.secondary : FRAME.text} />
          </Pressable>
          {day === null ? null : (
            <Pressable
              accessibilityLabel="Clear the day filter"
              accessibilityRole="button"
              onPress={() => setDay(null)}
              style={styles.filterClear}
              testID="ledger-filter-clear"
            >
              <Icon name="close" size={ICON.md} color={SEMANTIC.text.secondary} />
            </Pressable>
          )}
        </View>
      ) : null}

      {props.ledger === null ? (
        <Text style={[styles.emptyLine, styles.body]} testID="company-ledger-empty">
          Nothing recorded yet.
        </Text>
      ) : shown.length === 0 ? (
        <EmptyState
          message={
            day !== null
              ? `Nothing on ${formatDateEnIN(day, nowYear)}.`
              : tab === 'sale'
                ? 'No sales recorded yet.'
                : 'No payments recorded yet.'
          }
          testID="ledger-empty"
        />
      ) : (
        shown.map((entry) => {
          // Tappable only when the route gave us somewhere to push — the
          // `PaymentsScreen` guard, so a caller without a router (a test, the
          // desk) renders the same rows with no dead affordance on them.
          const open = entry.kind === 'sale' ? props.onOpenSale : props.onOpenPayment;
          return (
            <Pressable
              key={`${entry.kind}-${entry.id}`}
              accessibilityRole={open === undefined ? undefined : 'button'}
              accessibilityLabel={open === undefined ? undefined : `Open ${entry.kind} ${entry.number}`}
              onPress={open === undefined ? undefined : () => open(entry.id)}
              style={styles.ledgerRow}
              testID={`ledger-row-${entry.kind}-${entry.id}`}
            >
              <Text style={styles.ledgerDate}>{formatDateEnIN(entry.date, nowYear)}</Text>
              <View style={styles.ledgerMain}>
                <Text style={styles.ledgerKind}>{entry.kind === 'sale' ? 'Sale' : `Payment${entry.mode === null ? '' : ` ${entry.mode}`}`}</Text>
                <Text style={styles.ledgerNumber}>{entry.number}</Text>
                {entry.voided ? (
                  <Text style={styles.ledgerVoid} testID={`ledger-voided-${entry.id}`}>
                    {`Voided${entry.voidReason === null ? '' : ` — ${entry.voidReason}`}`}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.ledgerAmount}>{ledgerAmountOf(entry.kind, entry.amount)}</Text>
              <Text style={styles.ledgerRunning} testID={`ledger-running-${entry.kind}-${entry.id}`}>
                {creditView(entry.runningBalance).text}
              </Text>
              {/* The chevron is the affordance, and it is drawn only when
                  the row actually opens something: a browse-only ledger
                  should not advertise a page that does not exist. */}
              {open === undefined ? null : (
                <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
              )}
            </Pressable>
          );
        })
      )}

      {picking ? (
        <Sheet
          visible
          title="Which day"
          onDismiss={() => setPicking(false)}
          testID="ledger-day-sheet"
        >
          {/* Floored far back, deliberately: the filter looks BACKWARDS at
              days already recorded, and CalendarGrid's today floor greyed
              out every day he wanted on the Sales page (2026-09-18). The
              future is simply not offered — no document can sit there. */}
          <CalendarGrid
            value={day ?? today}
            todayIso={today}
            minIso={LEDGER_HISTORY_FLOOR}
            onSelect={(iso) => {
              setDay(iso);
              setPicking(false);
            }}
            testID="ledger-day-calendar"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: day === null }}
            onPress={() => {
              setDay(null);
              setPicking(false);
            }}
            style={styles.anyDayRow}
            testID="ledger-day-any"
          >
            <Text style={styles.anyDayWord}>Any day</Text>
          </Pressable>
        </Sheet>
      ) : null}

      {sheetOpen && company !== null ? (
        <RecordPaymentSheet
          visible
          companies={[{ id: company.id, name: company.name }]}
          openSales={props.openSales}
          initialCompanyId={company.id}
          busy={props.pendingRecord.busy}
          error={props.pendingRecord.error}
          online={props.online}
          record={props.record}
          captureProof={props.captureProof}
          onDismiss={() => setSheetOpen(false)}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  /** The navy frame: who this account is, how to reach them, and what they
   * owe — the three things the ledger below explains. */
  frame: {
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    marginBottom: SPACE[2],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  /** The page's gutter, once the frame has taken the edges. */
  body: { paddingHorizontal: SPACE[4] },
  /** The three views as tabs on the frame's lower edge — the service-call
   * screen's control, sized from the frame's content box. */
  tabs: { alignSelf: 'stretch', flexDirection: 'row', marginTop: SPACE[3] },
  tab: {
    minHeight: TAP.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabSelected: { borderBottomColor: COLORS.accent },
  tabLabel: { ...textStyle('label'), color: FRAME.textMuted },
  tabLabelSelected: { color: FRAME.text },
  /** The day filter: one control in the page's gutter, the calendar behind
   * it, and a clear when a day is on (the Sales page's bar). */
  filterBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE[1], marginTop: SPACE[3] },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[1],
    minHeight: 44,
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
  },
  filterChipOn: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  filterLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  filterLabelOn: { ...textStyle('label'), color: SEMANTIC.text.onDark },
  filterClear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  anyDayRow: {
    minHeight: 52,
    justifyContent: 'center',
    marginTop: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  anyDayWord: { ...textStyle('body'), color: SEMANTIC.text.primary },
  meta: {
    ...textStyle('body'),
    color: FRAME.textMuted,
  },
  phone: {
    color: SEMANTIC.text.primary,
  },
  balanceBlock: {
    marginVertical: SPACE[2],
  },
  balance: {
    ...textStyle('display'),
    fontVariant: ['tabular-nums'],
  },
  balanceCaption: {
    ...textStyle('caption'),
    color: FRAME.textMuted,
  },
  actions: {
    flexDirection: 'row',
    gap: SPACE[2],
    marginTop: SPACE[2],
    paddingHorizontal: SPACE[4],
  },
  actionCell: { flex: 1 },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[3],
    marginBottom: SPACE[1],
  },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACE[4],
    marginTop: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    gap: SPACE[3],
  },
  ledgerDate: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  ledgerMain: {
    flex: 1,
    gap: 1,
  },
  ledgerKind: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  ledgerNumber: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  ledgerVoid: {
    ...textStyle('caption'),
    color: SEMANTIC.feedback.danger,
  },
  ledgerAmount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  ledgerRunning: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
});
