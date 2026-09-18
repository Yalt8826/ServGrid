/**
 * S1 Dashboard (UI/plan-2/06-SALES-REP.md §S1). Purpose: answer "how am I
 * doing this month, and who owes me money?" — in a customer's office,
 * often mid-conversation about money.
 *
 * Anatomy: name · the two figures (sold this month, outstanding) · *New
 * sale* · OWES THE MOST · RECENT PAYMENTS. The old RENEWING SOON section
 * is gone — reps have no part in AMCs (decision 2026-09-15).
 *
 * The figures are the server's, read online — nothing waits on the phone
 * behind them (online-only, decision 2026-09-15).
 *
 * Motion: figures cross-fade on change, 140ms (`MoneyFigure`). **No
 * count-up** — a money figure animating in front of a customer looks like
 * a slot machine.
 *
 * Pure UI over injected data (`RepDashboardScreenProps`); `useRepDashboard`
 * owns the reads.
 */
import { ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';

import { alpha, formatMoneyEnIN, FRAME, ICON, RADII, SEMANTIC, SPACE, TINT } from '@servgrid/shared';
import { Button, EmptyState, SectionHeader } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { creditView, MoneyFigure } from './money';
import { istDayLabel, istGreeting } from '../technician/jobView';
import type { OwedRow, PaymentRow } from './model';

export interface RepDashboardScreenProps {
  name: string;
  /** Injectable clock — the greeting and the date line are judged by it. */
  now: Date;
  figures: { soldThisMonth: string; outstanding: string } | null;
  figuresError: string | null;
  /** `sales.cards` off — the sold figure renders "turned off", honestly. */
  salesOff: boolean;
  /** `sales.payments` off — dues and collections render turned off. */
  paymentsOff: boolean;
  owesTheMost: OwedRow[];
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'rep-dashboard'}>
      {/* The frame (2026-09-18): who is signed in, the month's two figures,
          and the one action — on the navy the tab bar wears. The route
          paints the same navy behind the status bar. */}
      <View style={styles.frame}>
        {/* The greeting and the IST date line — the other dashboards' own
            header shape, judged by the injected clock, never the phone's
            timezone. */}
        <Text style={styles.greeting} testID="dashboard-greeting">
          {`${istGreeting(props.now)}, `}
          {/* The name rides inside the greeting — it was said twice, once
              here and once on its own line under it (2026-09-18). The
              inner Text keeps `dashboard-name` for the screen's own
              "who is this" hook. */}
          <Text testID="dashboard-name">{props.name}</Text>
        </Text>
        <Text style={styles.dateLine} testID="dashboard-date">
          {istDayLabel(props.now)}
        </Text>
        <View style={styles.frameHead}>
          {/* THE action of the screen — the accent, like every other
              dashboard's primary. */}
          <Button label="New sale" icon="plus" variant="primary" onPress={props.onNewSale} testID="dashboard-new-sale" />
        </View>
        <View style={styles.frameRule} />

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
              {/* The icon tints with the figure: success when the month has
                  sales, the frame's muted ink when it does not — the same
                  "colour only when non-zero" rule the other dashboards run
                  on their dark-ground inks. */}
              <View style={[styles.figureMark, { backgroundColor: alpha(props.salesOff ? FRAME.text : props.figures.soldThisMonth === '0' ? FRAME.text : FRAME.success, TINT.band) }]}>
                <Icon name="trending" size={ICON.sm} color={props.salesOff || props.figures.soldThisMonth === '0' ? FRAME.textMuted : FRAME.success} />
              </View>
              {props.salesOff ? (
                <Text style={styles.offLine} testID="dashboard-figure-sold-off">
                  Turned off right now.
                </Text>
              ) : (
                <MoneyFigure
                  value={`₹${formatMoneyEnIN(props.figures.soldThisMonth)}`}
                  onFrame
                  testID="dashboard-figure-sold"
                />
              )}
              <Text style={styles.figureCaption}>sold this month</Text>
            </View>
            <View style={styles.figureDivider} />
            <View style={styles.figureCell}>
              <View style={[styles.figureMark, { backgroundColor: alpha(props.paymentsOff || props.figures.outstanding === '0' ? FRAME.text : FRAME.warning, TINT.band) }]}>
                <Icon name="wallet" size={ICON.sm} color={props.paymentsOff || props.figures.outstanding === '0' ? FRAME.textMuted : FRAME.warning} />
              </View>
              {props.paymentsOff ? (
                <Text style={styles.offLine} testID="dashboard-figure-outstanding-off">
                  Turned off right now.
                </Text>
              ) : (
                <MoneyFigure
                  value={`₹${formatMoneyEnIN(props.figures.outstanding)}`}
                  onFrame
                  testID="dashboard-figure-outstanding"
                />
              )}
              <Text style={styles.figureCaption}>outstanding</Text>
            </View>
          </View>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeader label="Owes the most" icon="wallet" />
      </View>
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
              style={styles.card}
              testID={`dashboard-owed-${row.companyId}`}
            >
              {/* The 4pt rail in the danger ink: this list IS the debt —
                  sorted by it, highest first. */}
              <View style={[styles.rail, { backgroundColor: SEMANTIC.feedback.danger }]} />
              <View style={styles.cardBody}>
                <Text style={styles.rowPrimary}>{owedRowText(row.name, row.balance)}</Text>
                <View style={styles.rowEnd}>
                  {/* Positive dues render plain; `creditView` only colours a
                  negative — the row is filtered to positives, so this is the
                  plain figure. */}
                  <Text style={[styles.rowMoney, { color: view.color }]}>{`₹${formatMoneyEnIN(row.balance)}`}</Text>
                  <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
                </View>
              </View>
            </Pressable>
          );
        })
      )}

      <View style={styles.section}>
        <SectionHeader label="Recent payments" icon="wallet" />
      </View>
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
            style={styles.card}
            testID={`dashboard-payment-${row.id}`}
          >
            <View style={[styles.rail, { backgroundColor: SEMANTIC.feedback.success }]} />
            <View style={styles.cardBody}>
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
  /** The page's own ground on the scroll itself — the frame above must
   * not bleed into where short content ends. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
  },
  /** The frame: who, the month's two figures, and the one action. The
   * negative margins bleed it to ALL screen edges — the strip of white
   * above it was the content's top padding showing (reported on the
   * handset, 2026-09-18). */
  frame: {
    backgroundColor: FRAME.bg,
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
  },
  greeting: { ...textStyle('h1'), color: FRAME.text },
  dateLine: {
    ...textStyle('caption'),
    color: FRAME.textMuted,
    marginBottom: SPACE[4],
  },
  /** The frame's action line — New sale alone now that the name is said
   * once, in the greeting above it. */
  frameHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: SPACE[4],
  },
  frameRule: { height: 1, backgroundColor: FRAME.divider, marginBottom: SPACE[4] },
  figuresRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  figureCell: {
    flex: 1,
    gap: 2,
  },
  /** The hairline between the two figures — the dashboard's own divider
   * language (FRAME.divider), vertical here. */
  figureDivider: { width: 1, backgroundColor: FRAME.divider, marginHorizontal: SPACE[4] },
  figureCaption: {
    ...textStyle('caption'),
    color: FRAME.textMuted,
  },
  /** A row is a card: air between, hairline round, a 4pt rail leading. */
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[3],
    marginTop: SPACE[2],
    paddingRight: SPACE[3],
    paddingVertical: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rail: { alignSelf: 'stretch', width: 4 },
  cardBody: { flex: 1, gap: 2 },
  /** A section's air below the frame and between the two lists. */
  section: { marginTop: SPACE[5] },
  /** The figure's icon tile, tinted with the figure's own ink. */
  figureMark: {
    width: 28,
    height: 28,
    borderRadius: RADII.control,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACE[2],
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
  rowMain: {
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
