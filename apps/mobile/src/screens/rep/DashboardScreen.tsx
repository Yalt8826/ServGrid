/**
 * S1 Dashboard (UI/plan-2/06-SALES-REP.md §S1). Purpose: answer "how am I
 * doing this month, and who owes me money?" — in a customer's office,
 * often mid-conversation about money.
 *
 * Anatomy: name · the two figures (sold this month, outstanding) · *New
 * sale* · OWES THE MOST · RENEWING SOON · RECENT PAYMENTS.
 *
 * The figures are the server's, read online — nothing waits on the phone
 * behind them (online-only, decision 2026-09-15).
 *
 * Motion: figures cross-fade on change, 140ms (`MoneyFigure`). **No
 * count-up** — a money figure animating in front of a customer looks like
 * a slot machine.
 *
 * Renewing soon comes from `v_contracts_expiring` through the loader the
 * route supplies (`RenewingContract[]`, days remaining — urgency is the
 * point, not a date). The contracts backend is a later phase; an empty
 * list renders the section's empty line, never a spinner.
 *
 * Pure UI over injected data (`RepDashboardScreenProps`); `useRepDashboard`
 * owns the reads.
 */
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, EmptyState } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView, MoneyFigure } from './money';
import type { OwedRow, PaymentRow, RenewalRow } from './model';

export interface RepDashboardScreenProps {
  name: string;
  figures: { soldThisMonth: string; outstanding: string } | null;
  figuresError: string | null;
  /** `sales.cards` off — the sold figure renders "turned off", honestly. */
  salesOff: boolean;
  /** `sales.payments` off — dues and collections render turned off. */
  paymentsOff: boolean;
  owesTheMost: OwedRow[];
  renewingSoon: RenewalRow[];
  renewalsError: string | null;
  recentPayments: PaymentRow[];
  paymentsError: string | null;
  companyNames: Record<string, string>;
  onNewSale: () => void;
  onOpenCompany: (companyId: string) => void;
  onOpenPayments: () => void;
  onRetry: () => void;
  testID?: string;
}

/** A company row reads "Sterling Industries · owes ₹85,000" — the verb
 * keeps dues a view of what is owed, not a list of payments. */
export function owedRowText(name: string, balance: string): string {
  return `${name} · owes ₹${formatMoneyEnIN(balance)}`;
}

export function RepDashboardScreen(props: RepDashboardScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'rep-dashboard'}>
      <View style={styles.header}>
        <Text style={styles.heading} testID="dashboard-name">
          {props.name}
        </Text>
      </View>

      {props.figuresError !== null ? (
        <>
          <Text style={styles.errorText} testID="dashboard-figures-error">
            {props.figuresError}
          </Text>
          <Button label="Retry" variant="secondary" onPress={props.onRetry} testID="dashboard-retry" />
        </>
      ) : props.figures === null ? null : (
        <View style={styles.figuresRow}>
          <View style={styles.figureCell}>
            {props.salesOff ? (
              <Text style={styles.offLine} testID="dashboard-figure-sold-off">
                Turned off right now.
              </Text>
            ) : (
              <MoneyFigure
                value={`₹${formatMoneyEnIN(props.figures.soldThisMonth)}`}
                testID="dashboard-figure-sold"
              />
            )}
            <Text style={styles.figureCaption}>sold this month</Text>
          </View>
          <View style={styles.figureCell}>
            {props.paymentsOff ? (
              <Text style={styles.offLine} testID="dashboard-figure-outstanding-off">
                Turned off right now.
              </Text>
            ) : (
              <MoneyFigure
                value={`₹${formatMoneyEnIN(props.figures.outstanding)}`}
                testID="dashboard-figure-outstanding"
              />
            )}
            <Text style={styles.figureCaption}>outstanding</Text>
          </View>
        </View>
      )}

      <Button label="+ New sale" onPress={props.onNewSale} testID="dashboard-new-sale" />

      <Text style={styles.sectionLabel}>OWES THE MOST</Text>
      {props.paymentsOff ? (
        <Text style={styles.offLine} testID="dashboard-owed-off">
          Payments are turned off right now.
        </Text>
      ) : props.owesTheMost.length === 0 ? (
        <Text style={styles.emptyLine} testID="dashboard-owed-empty">
          Nothing outstanding across your accounts.
        </Text>
      ) : (
        props.owesTheMost.map((row) => {
          const view = creditView(row.balance);
          return (
            <Pressable
              key={row.companyId}
              accessibilityRole="button"
              onPress={() => props.onOpenCompany(row.companyId)}
              style={styles.listRow}
              testID={`dashboard-owed-${row.companyId}`}
            >
              <Text style={styles.rowPrimary}>{owedRowText(row.name, row.balance)}</Text>
              <View style={styles.rowEnd}>
                {/* Positive dues render plain; `creditView` only colours a
                negative — the row is filtered to positives, so this is the
                plain figure. */}
                <Text style={[styles.rowMoney, { color: view.color }]}>{`₹${formatMoneyEnIN(row.balance)}`}</Text>
                <Text style={styles.chevron}>→</Text>
              </View>
            </Pressable>
          );
        })
      )}

      <Text style={styles.sectionLabel}>RENEWING SOON</Text>
      {props.renewalsError !== null ? (
        <Text style={styles.errorText} testID="dashboard-renewals-error">
          {props.renewalsError}
        </Text>
      ) : props.renewingSoon.length === 0 ? (
        <Text style={styles.emptyLine} testID="dashboard-renewals-empty">
          Nothing renewing in the next 60 days.
        </Text>
      ) : (
        props.renewingSoon.map((row) => (
          <View key={row.id} style={styles.listRow} testID={`dashboard-renewal-${row.id}`}>
            <View style={styles.renewalMain}>
              <Text style={styles.rowPrimary}>{`${row.site} · ${row.contractNumber}`}</Text>
              <Text style={styles.rowSecondary} testID={`dashboard-renewal-days-${row.id}`}>
                {row.daysRemaining === 1 ? '1 day' : `${row.daysRemaining} days`}
              </Text>
            </View>
            <Text style={styles.rowMoney}>{`₹${formatMoneyEnIN(row.contractValue)}`}</Text>
          </View>
        ))
      )}

      <Text style={styles.sectionLabel}>RECENT PAYMENTS</Text>
      {props.paymentsOff ? (
        <Text style={styles.offLine} testID="dashboard-payments-off">
          Payments are turned off right now.
        </Text>
      ) : props.paymentsError !== null ? (
        <Text style={styles.errorText} testID="dashboard-payments-error">
          {props.paymentsError}
        </Text>
      ) : props.recentPayments.length === 0 ? (
        <Text style={styles.emptyLine} testID="dashboard-payments-empty">
          No payments collected yet.
        </Text>
      ) : (
        props.recentPayments.map((row) => (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            onPress={props.onOpenPayments}
            style={styles.listRow}
            testID={`dashboard-payment-${row.id}`}
          >
            <View style={styles.renewalMain}>
              <Text style={styles.rowPrimary}>{props.companyNames[row.companyId] ?? row.companyName}</Text>
              <Text style={styles.rowSecondary}>{`${row.paymentNumber} · ${row.mode} · ${formatDateEnIN(
                row.businessDate,
                nowYear,
              )}`}</Text>
            </View>
            <Text style={styles.rowMoney}>{`₹${formatMoneyEnIN(row.amount)}`}</Text>
          </Pressable>
        ))
      )}

      {props.figures !== null && props.figures.soldThisMonth === '0' && props.owesTheMost.length === 0 ? (
        <EmptyState message="No sales yet this month." testID="dashboard-empty" />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACE[2],
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  figuresRow: {
    flexDirection: 'row',
    gap: SPACE[6],
    marginVertical: SPACE[3],
  },
  figureCell: {
    flex: 1,
    gap: 2,
  },
  figureCaption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[4],
    marginBottom: SPACE[1],
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  rowPrimary: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  rowSecondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  rowMoney: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  rowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  chevron: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  renewalMain: {
    flex: 1,
    gap: 2,
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
  offLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
  errorText: {
    ...textStyle('body'),
    color: SEMANTIC.feedback.danger,
    paddingVertical: SPACE[2],
  },
});
