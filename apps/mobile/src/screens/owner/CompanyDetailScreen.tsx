/**
 * O5 Companies — the detail (UI/plan-2/07-OWNER.md §O5). The ledger is
 * **identical to the rep's §S4 but unscoped** — interleaved documents,
 * newest first, with the server-computed running balance, Credit in
 * `feedback.success` — over a header that names the owner rep and
 * carries the reassignment control, here too. Voided documents keep
 * their rows with their reasons: the ledger says what happened.
 *
 * **Every ledger row is a door** (2026-09-17): a sale row opens the
 * line items — the products behind the document; a payment row opens
 * the proof photo the rep captured. The reads ride props the route
 * owns (`onLoadSale`, `onLoadPaymentProof`); the sheets hold their own
 * loading and error so a slow or missing document says so inline.
 *
 * Pure UI over injected deps; the route owns the reads and the PATCH.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CompanyLedger, SaleRecord } from '@servgrid/shared';
import { DESK, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, Panel, useDensity } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView, ledgerAmountOf } from '../rep/money';
import { PaymentProofSheet, SaleItemsSheet, type PreviewSubject } from './ledgerPreviews';
import { ReassignSheet } from './ReassignSheet';
import type { RepOption } from './ReassignSheet';
import type { PaymentProof } from './useOwnerData';

/** The house-account option — first, because it is the answer when
 * nobody owns the account (§O5: how leave gets covered). */
const HOUSE_OPTION: RepOption = { id: null, name: 'Nobody — house account' };

export interface OwnerCompanyDetailScreenProps {
  companyName: string;
  contactPerson: string | null;
  phone: string | null;
  gstin: string | null;
  /** Who holds the account now — null when it is a house account. */
  ownerRepName: string | null;
  shared: boolean;
  ledger: CompanyLedger | null;
  error: string | null;
  loading: boolean;
  reps: readonly RepOption[];
  companyId: string;
  onReassign: (companyId: string, ownerRepId: string | null) => void;
  reassignBusy: boolean;
  reassignError: string | null;
  onNewSale: () => void;
  onRecordPayment: () => void;
  /** A sale row, clicked — resolves the card with its line items. */
  onLoadSale: (saleId: string) => Promise<SaleRecord | null>;
  /** A payment row, clicked — resolves the proof photo. Null = none attached. */
  onLoadPaymentProof: (paymentId: string) => Promise<PaymentProof | null>;
  onRetry: () => void;
  testID?: string;
}

export function OwnerCompanyDetailScreen(props: OwnerCompanyDetailScreenProps): React.ReactNode {
  const [reassignOpen, setReassignOpen] = useState(false);
  // Which document is open — the sheets own everything else about them.
  const [openSale, setOpenSale] = useState<PreviewSubject | null>(null);
  const [openPayment, setOpenPayment] = useState<PreviewSubject | null>(null);
  const desk = useDensity() === 'desk';
  const nowYear = new Date().getFullYear();
  const balanceView = props.ledger === null ? null : creditView(props.ledger.balance);

  const actions = (
    <>
      <Button label="New sale" onPress={props.onNewSale} testID="company-new-sale" />
      <Button label="Record payment" variant="secondary" onPress={props.onRecordPayment} testID="company-record-payment" />
      <Button label="Reassign account" variant="ghost" onPress={() => setReassignOpen(true)} testID="company-reassign" />
    </>
  );

  return (
    <ScrollView contentContainerStyle={[styles.content, desk && styles.contentDesk]} testID={props.testID ?? 'owner-company-detail'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-company-error" />
      ) : null}

      <View style={[styles.header, desk && styles.headerDesk]} testID="company-header">
        <View style={styles.headerMain}>
          <Text style={styles.name} testID="company-name">
            {props.companyName}
          </Text>
          {props.contactPerson !== null ? (
            <Text style={styles.meta} testID="company-contact">
              {props.contactPerson}
            </Text>
          ) : null}
          {props.phone !== null ? (
            <Text style={styles.meta} testID="company-phone">
              {props.phone}
            </Text>
          ) : null}
          {props.gstin !== null ? (
            <Text style={styles.meta} testID="company-gstin">
              {props.gstin}
            </Text>
          ) : null}
          <View style={styles.repRow} testID="company-owner-rep">
            <Text style={styles.repLabel}>Owner rep</Text>
            <Text style={styles.repValue}>{props.shared ? 'House account' : (props.ownerRepName ?? '—')}</Text>
          </View>
        </View>
        <View style={[styles.actions, desk && styles.actionsDesk]}>{actions}</View>
      </View>

      {balanceView !== null ? (
        <View style={styles.balanceBlock}>
          <Text style={[styles.balance, { color: balanceView.color }]} testID="company-balance">
            {balanceView.text}
          </Text>
          <Text style={styles.balanceCaption}>balance</Text>
        </View>
      ) : null}

      <Panel title="Ledger" padded={false} testID="company-ledger">
        {props.ledger === null ? (
          <Text style={styles.emptyLine} testID="company-ledger-empty">
            Nothing recorded yet.
          </Text>
        ) : props.ledger.entries.length === 0 ? (
          <Text style={styles.emptyLine} testID="company-ledger-empty">
            Nothing recorded yet.
          </Text>
        ) : (
          <View>
            <View style={[styles.ledgerRow, styles.ledgerHead]}>
              <Text style={styles.ledgerDate}>Date</Text>
              <Text style={styles.ledgerKind}>Document</Text>
              <Text style={styles.ledgerAmount}>Amount</Text>
              <Text style={styles.ledgerRunning}>Balance</Text>
            </View>
            {props.ledger.entries.map((entry) => (
              <Pressable
                key={`${entry.kind}-${entry.id}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.kind} ${entry.number}`}
                onPress={() =>
                  entry.kind === 'sale'
                    ? setOpenSale({ id: entry.id, number: entry.number })
                    : setOpenPayment({ id: entry.id, number: entry.number })
                }
                style={[styles.ledgerRow, desk && styles.ledgerRowDesk]}
                testID={`ledger-row-${entry.kind}-${entry.id}`}
              >
                <Text style={styles.ledgerDate}>{formatDateEnIN(entry.date, nowYear)}</Text>
                <View style={styles.ledgerMain}>
                  <Text numberOfLines={1} style={styles.ledgerKind}>
                    {entry.kind === 'sale' ? 'Sale' : `Payment${entry.mode === null ? '' : ` ${entry.mode}`}`}
                  </Text>
                  <Text numberOfLines={1} style={styles.ledgerNumber}>
                    {entry.number}
                  </Text>
                  {entry.voided ? (
                    <Text numberOfLines={1} style={styles.ledgerVoid} testID={`ledger-voided-${entry.id}`}>
                      {`Voided${entry.voidReason === null ? '' : ` — ${entry.voidReason}`}`}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.ledgerAmount}>{ledgerAmountOf(entry.kind, entry.amount)}</Text>
                <Text style={styles.ledgerRunning} testID={`ledger-running-${entry.kind}-${entry.id}`}>
                  {creditView(entry.runningBalance).text}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </Panel>

      <ReassignSheet
        visible={reassignOpen}
        companyName={props.companyName}
        currentName={props.shared ? null : props.ownerRepName}
        options={[HOUSE_OPTION, ...props.reps]}
        busy={props.reassignBusy}
        error={props.reassignError}
        onConfirm={(ownerRepId) => {
          setReassignOpen(false);
          props.onReassign(props.companyId, ownerRepId);
        }}
        onDismiss={() => setReassignOpen(false)}
        testID="owner-reassign-sheet"
      />

      {/* A sale row's door: the products the document sold. */}
      <SaleItemsSheet
        sale={openSale}
        onLoad={props.onLoadSale}
        onDismiss={() => setOpenSale(null)}
        testID="company-sale-items-sheet"
      />

      {/* A payment row's door: the proof photo the rep captured. */}
      <PaymentProofSheet
        payment={openPayment}
        onLoad={props.onLoadPaymentProof}
        onDismiss={() => setOpenPayment(null)}
        testID="company-payment-proof-sheet"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  // The console's page furniture — same measure as the DeskListShell
  // pages, since this screen owns its own header (2026-09-17).
  contentDesk: {
    paddingHorizontal: DESK.page.padX,
    paddingTop: DESK.page.padY,
    paddingBottom: SPACE[12],
    gap: DESK.page.gap,
    maxWidth: DESK.page.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
  header: { gap: SPACE[2] },
  // Name and facts left, the money actions right — the page header
  // shape every other console page wears.
  headerDesk: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: SPACE[5],
  },
  headerMain: { flexShrink: 1, gap: 2 },
  name: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  meta: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  repRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    marginTop: SPACE[2],
  },
  repLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  repValue: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  actions: {
    gap: SPACE[3],
    marginVertical: SPACE[2],
  },
  actionsDesk: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: SPACE[2],
    marginVertical: 0,
  },
  balanceBlock: { marginVertical: SPACE[2] },
  balance: {
    ...textStyle('display'),
    fontVariant: ['tabular-nums'],
  },
  balanceCaption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[2],
  },
  ledgerRowDesk: {
    paddingHorizontal: DESK.card.pad,
    backgroundColor: SEMANTIC.bg.raised,
  },
  ledgerHead: {
    minHeight: 36,
    borderBottomWidth: 1,
  },
  ledgerDate: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
    width: 72,
  },
  ledgerMain: { flex: 1, gap: 1 },
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
    width: 96,
    textAlign: 'right',
  },
  ledgerRunning: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    width: 96,
    textAlign: 'right',
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    padding: DESK.card.pad,
  },
});
