/**
 * S4 Companies — detail and ledger (UI/plan-2/06-SALES-REP.md §S4).
 * Header: name, contact person, phone (tappable), GSTIN — and the balance
 * as the largest figure on screen, rendered through `creditView` (the
 * word Credit in `feedback.success` for an overpayment, never a minus in
 * red).
 *
 * The ledger: interleaved sales and payments, newest first, with the
 * **running balance column** — all `mono` tabular, so the column aligns
 * and a customer reading it upside down can follow it. The running
 * balance is the server's (`CompanyLedgerSchema.runningBalance`): the
 * rep's phone and the owner's desktop cannot disagree about money.
 *
 * Actions: *Record payment* (primary) · *New sale* (secondary). **No
 * reassign-owner control** — only the owner can move an account.
 *
 * Pure UI over injected deps; `useRepCompanyLedger` owns the reads.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Company, CompanyLedger } from '@servgrid/shared';
import { FRAME, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, SectionHeader } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView, ledgerAmountOf } from './money';
import { RecordPaymentSheet, type RecordPaymentInput } from './PaymentsScreen';
import type { SaleRow } from './model';

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
  /** The tappable phone (§S4) — the route owns the dialer (`Linking`). */
  onCallPhone?: (phone: string) => void;
  onRetry: () => void;
  testID?: string;
}

export function CompanyLedgerScreen(props: CompanyLedgerScreenProps): React.ReactNode {
  const [sheetOpen, setSheetOpen] = useState(false);
  const nowYear = new Date().getFullYear();
  const company = props.company;
  const balanceView = props.ledger === null ? null : creditView(props.ledger.balance);

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

      <View style={styles.sectionWrap}>
        <SectionHeader label="Ledger" icon="document" count={props.ledger === null ? undefined : props.ledger.entries.length} />
      </View>
      {props.ledger === null ? (
        <Text style={[styles.emptyLine, styles.body]} testID="company-ledger-empty">
          Nothing recorded yet.
        </Text>
      ) : (
        props.ledger.entries.map((entry) => (
          <View key={`${entry.kind}-${entry.id}`} style={styles.ledgerRow} testID={`ledger-row-${entry.kind}-${entry.id}`}>
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
          </View>
        ))
      )}

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
  sectionWrap: { paddingHorizontal: SPACE[4], marginTop: SPACE[4] },
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
