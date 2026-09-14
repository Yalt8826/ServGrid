/**
 * O5 Companies — the detail (UI/plan-2/07-OWNER.md §O5). The ledger is
 * **identical to the rep's §S4 but unscoped** — interleaved documents,
 * newest first, with the server-computed running balance, Credit in
 * `feedback.success` — over a header that names the owner rep and
 * carries the reassignment control, here too. Voided documents keep
 * their rows with their reasons: the ledger says what happened.
 *
 * Pure UI over injected deps; the route owns the reads and the PATCH.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CompanyLedger } from '@servgrid/shared';
import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView, ledgerAmountOf } from '../rep/money';
import { ReassignSheet } from './ReassignSheet';
import type { RepOption } from './ReassignSheet';

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
  onRetry: () => void;
  testID?: string;
}

export function OwnerCompanyDetailScreen(props: OwnerCompanyDetailScreenProps): React.ReactNode {
  const [reassignOpen, setReassignOpen] = useState(false);
  const nowYear = new Date().getFullYear();
  const balanceView = props.ledger === null ? null : creditView(props.ledger.balance);

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'owner-company-detail'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-company-error" />
      ) : null}

      <View testID="company-header">
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
        <Button
          label="Reassign account"
          variant="secondary"
          onPress={() => setReassignOpen(true)}
          testID="company-reassign"
        />
      </View>

      {balanceView !== null ? (
        <View style={styles.balanceBlock}>
          <Text style={[styles.balance, { color: balanceView.color }]} testID="company-balance">
            {balanceView.text}
          </Text>
          <Text style={styles.balanceCaption}>balance</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button label="New sale" onPress={props.onNewSale} testID="company-new-sale" />
        <Button label="Record payment" variant="secondary" onPress={props.onRecordPayment} testID="company-record-payment" />
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
        }}        onDismiss={() => setReassignOpen(false)}
        testID="owner-reassign-sheet"
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
  balanceBlock: { marginVertical: SPACE[2] },
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
    paddingVertical: SPACE[2],
  },
});
