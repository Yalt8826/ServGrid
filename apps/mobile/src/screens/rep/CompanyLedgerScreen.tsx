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
import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button } from '../../components/ui';
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
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'company-ledger'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="company-ledger-error" />
      ) : null}

      {company !== null ? (
        <View testID="company-header">
          <Text style={styles.name} testID="company-name">
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
        <View style={styles.balanceBlock}>
          <Text style={[styles.balance, { color: balanceView.color }]} testID="company-balance">
            {balanceView.text}
          </Text>
          <Text style={styles.balanceCaption}>balance</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button label="Record payment" onPress={() => setSheetOpen(true)} testID="company-record-payment" />
        <Button
          label="New sale"
          variant="secondary"
          onPress={() => company !== null && props.onNewSale(company.id)}
          testID="company-new-sale"
        />
      </View>

      <Text style={styles.sectionLabel}>LEDGER</Text>
      {props.ledger === null ? (
        <Text style={styles.emptyLine} testID="company-ledger-empty">
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
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  name: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  meta: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
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
    color: SEMANTIC.text.secondary,
  },
  actions: {
    gap: SPACE[3],
    marginVertical: SPACE[2],
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[3],
    marginBottom: SPACE[1],
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
  ledgerDate: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
    width: 72,
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
    paddingVertical: SPACE[2],
  },
});
