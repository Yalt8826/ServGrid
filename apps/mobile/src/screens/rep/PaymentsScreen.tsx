/**
 * S3 Payments (UI/plan-2/06-SALES-REP.md §S3). Two tabs, and the first is
 * labelled **Owed**, not "Pending": pending is a view of dues
 * (`v_company_balances WHERE balance > 0`), not a list of payment rows —
 * the stored-counter reading is exactly what the data model rejects.
 * Rows read "Sterling Industries · owes ₹85,000" with a **Record
 * payment** action — the verb makes clear the payment does not exist yet.
 * Empty state: "No company owes you anything." Collected lists actual
 * payments.
 *
 * The record-payment sheet (§S3):
 * - **Mode as segments on two rows** — `Cash` `UPI` `Cheque` /
 *   `Bank` `Card`, each 52 tall. Five across 360dp truncates "Bank
 *   transfer" into something ambiguous; two rows of comfortable targets
 *   beat one row of cramped ones, because a mis-tap records the wrong
 *   mode on real money.
 * - **Cash is first and visually identical to the others** — emphasising
 *   it would nudge behaviour in the one area the reconciliation exists to
 *   police. First because it is the one with a consequence.
 * - **Reference appears for non-cash modes only**, required for cheque
 *   and bank. Choosing Cash raises one line: "Cash goes on your handover
 *   today." — a reminder connecting two screens, not a warning.
 * - Proof photo: the capture is a dep seam (`captureProof`); the local
 *   URI travels with the payment input and uploads after its parent.
 *
 * Motion: a recorded payment updates the company's row optimistically,
 * **before the sheet closes** — the derived-balance model demonstrated.
 * The figure cross-fades (`MoneyFigure` rules) as the sheet dismisses.
 *
 * Pure UI over injected deps; `useRepPayments` owns the reads.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PaymentMode } from '@servgrid/shared';
import { formatMoneyEnIN, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Banner, Button, EmptyState, MoneyField, Select, Sheet, TextField } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { CASH_HANDOVER_REMINDER, MODE_ROWS, OWED_EMPTY_MESSAGE, referenceNeededFor, referenceRequiredFor } from './model';
import type { OwedRow, PaymentRow, SaleRow } from './model';

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

export function isValidAmount(raw: string): boolean {
  const n = Number(raw);
  return MONEY_PATTERN.test(raw) && n > 0;
}

/** The sheet's input, as the route's `record` dep receives it. */
export interface RecordPaymentInput {
  companyId: string;
  amount: string;
  /** null = on account (§S3: the absence IS the feature). */
  salesCardId: string | null;
  mode: PaymentMode;
  referenceNo: string | null;
  /** Local file URI queued as the proof photo; uploads after the parent. */
  proofPhotoUri: string | null;
}

export interface RecordPaymentSheetProps {
  visible: boolean;
  /** His accounts plus house — the picker's whole world. */
  companies: Array<{ id: string; name: string }>;
  /** Confirmed sales — the *Against* select's specific-sale options. */
  openSales: SaleRow[];
  /** Prefilled when opened from a company row (§S3). */
  initialCompanyId?: string | null;
  busy: boolean;
  error: string | null;
  record: (input: RecordPaymentInput) => Promise<void>;
  /** The proof-photo capture seam; the route owns the picker. */
  captureProof?: () => Promise<string | null>;
  onDismiss: () => void;
  testID?: string;
}

/**
 * The record-payment sheet. Validation is stated where it bites: amount
 * must be money above zero; reference is shown for non-cash modes and
 * required for cheque and bank.
 */
export function RecordPaymentSheet(props: RecordPaymentSheetProps): React.ReactNode {
  const [companyId, setCompanyId] = useState<string | null>(props.initialCompanyId ?? null);
  const [amount, setAmount] = useState('');
  const [salesCardId, setSalesCardId] = useState<string | null>(null);
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [proofUri, setProofUri] = useState<string | null>(null);
  const [proofNote, setProofNote] = useState<string | null>(null);

  const companyOptions = props.companies.map((c) => ({ label: c.name, value: c.id }));
  const againstOptions = [
    { label: 'On account', value: 'on-account' },
    ...props.openSales
      .filter((s) => s.companyId === companyId)
      .map((s) => ({ label: `${s.saleNumber ?? ''} · ₹${formatMoneyEnIN(s.total)}`, value: s.id })),
  ];

  const needsReference = referenceNeededFor(mode);
  const referenceRequired = referenceRequiredFor(mode);
  const referenceError =
    referenceRequired && reference.trim() === '' ? 'A cheque or bank transfer needs its reference.' : undefined;
  const canRecord =
    companyId !== null && isValidAmount(amount) && (!referenceRequired || reference.trim() !== '');

  async function capture(): Promise<void> {
    if (props.captureProof === undefined) {
      // No picker in this build: the honest note, not a dead button press.
      setProofNote('The proof photo is attached after the payment syncs.');
      return;
    }
    try {
      const uri = await props.captureProof();
      if (uri !== null) {
        setProofUri(uri);
        setProofNote(null);
      }
    } catch {
      setProofNote('The camera could not be opened.');
    }
  }

  async function submit(): Promise<void> {
    if (props.busy || !canRecord || companyId === null) return;
    try {
      await props.record({
        companyId,
        amount,
        salesCardId,
        mode,
        referenceNo: needsReference && reference.trim() !== '' ? reference.trim() : null,
        proofPhotoUri: proofUri,
      });
    } catch {
      // The screen owns the error surface (its banner) and has already
      // rolled the optimistic row back — nothing to add here.
    }
  }

  return (
    <Sheet
      visible={props.visible}
      title="Record payment"
      onDismiss={props.onDismiss}
      testID={props.testID ?? 'payment-sheet'}
      actions={
        <Button
          label="Record payment"
          onPress={() => void submit()}
          loading={props.busy}
          disabled={!canRecord}
          disabledReason={
            companyId === null
              ? 'Pick the company.'
              : !isValidAmount(amount)
                ? 'Enter the amount received.'
                : 'Enter the reference for this mode.'
          }
          fullwidth
          testID="payment-sheet-submit"
        />
      }
    >
      <View style={styles.sheetBody}>
        {props.error !== null ? <Banner tone="danger" message={props.error} testID="payment-sheet-error" /> : null}

        <Select
          label="Company"
          value={companyId}
          options={companyOptions}
          onSelect={setCompanyId}
          testID="payment-sheet-company"
        />

        <MoneyField
          label="Amount"
          value={amount}
          onChangeText={setAmount}
          helperText="The money that changed hands just now."
          testID="payment-sheet-amount"
        />

        <Select
          label="Against"
          value={salesCardId ?? 'on-account'}
          options={againstOptions}
          onSelect={(value) => setSalesCardId(value === 'on-account' ? null : value)}
          helperText="On account unless this settles one specific sale."
          testID="payment-sheet-against"
        />

        <Text style={styles.fieldLabel}>Mode</Text>
        {/* Two rows (§S3): Cash UPI Cheque / Bank Card. Cash first and
        identical — no emphasis on the one mode the reconciliation polices. */}
        {MODE_ROWS.map((row, index) => (
          <View key={index} style={styles.modeRow} testID={`payment-mode-row-${index + 1}`}>
            {row.map((segment) => {
              const selected = mode === segment.mode;
              return (
                <Pressable
                  key={segment.mode}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setMode(segment.mode)}
                  style={[styles.modeSegment, selected ? styles.modeSegmentSelected : null]}
                  testID={`payment-mode-${segment.mode}`}
                >
                  <Text
                    style={[styles.modeLabel, selected ? styles.modeLabelSelected : null]}
                    numberOfLines={1}
                    ellipsizeMode="clip"
                  >
                    {segment.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}

        {mode === 'cash' ? (
          <Text style={styles.cashReminder} testID="payment-cash-reminder">
            {CASH_HANDOVER_REMINDER}
          </Text>
        ) : null}

        {needsReference ? (
          <TextField
            label={mode === 'cheque' ? 'Cheque number' : mode === 'bank_transfer' ? 'Bank reference' : 'Reference'}
            value={reference}
            onChangeText={setReference}
            errorText={referenceError}
            testID="payment-sheet-reference"
          />
        ) : null}

        <View style={styles.proofBlock}>
          <Text style={styles.fieldLabel}>Proof photo</Text>
          {proofUri !== null ? (
            <Text style={styles.proofQueued} testID="payment-proof-queued">
              Proof queued — uploads after the payment.
            </Text>
          ) : (
            <Button label="Capture" variant="secondary" onPress={() => void capture()} testID="payment-proof-capture" />
          )}
          {proofNote !== null ? (
            <Text style={styles.proofNote} testID="payment-proof-note">
              {proofNote}
            </Text>
          ) : null}
        </View>
      </View>
    </Sheet>
  );
}

export interface PaymentsScreenProps {
  owed: OwedRow[];
  collected: PaymentRow[];
  companies: Array<{ id: string; name: string }>;
  openSales: SaleRow[];
  error: string | null;
  loading: boolean;
  pendingRecord: { busy: boolean; error: string | null };
  record: (input: RecordPaymentInput) => Promise<void>;
  applyOptimisticPayment: (companyId: string, amount: string) => void;
  onRetry: () => void;
  /** Opened from a company row or the /payments/new route (§S3 prefill). */
  sheetCompanyId?: string | null;
  startWithSheetOpen?: boolean;
  captureProof?: () => Promise<string | null>;
  testID?: string;
}

/** Which tab is showing. `owed` is first and the default — a rep's day is
 * this list in order. */
export type PaymentsTab = 'owed' | 'collected';

export function PaymentsScreen(props: PaymentsScreenProps): React.ReactNode {
  const [tab, setTab] = useState<PaymentsTab>('owed');
  const [sheetOpen, setSheetOpen] = useState(props.startWithSheetOpen ?? false);
  const [sheetCompany, setSheetCompany] = useState<string | null>(props.sheetCompanyId ?? null);
  const nowYear = new Date().getFullYear();

  function openSheet(companyId: string | null): void {
    setSheetCompany(companyId);
    setSheetOpen(true);
  }

  async function record(input: RecordPaymentInput): Promise<void> {
    // The optimistic half lands BEFORE the sheet closes (§S3 motion):
    // the company's row moves while the sheet is still up, and the
    // cross-fade plays as it dismisses.
    props.applyOptimisticPayment(input.companyId, input.amount);
    try {
      await props.record(input);
    } catch (e) {
      // A refused payment puts the row back and keeps the sheet open with
      // the server's words — the money did not move, the screen must not
      // pretend it did.
      props.applyOptimisticPayment(input.companyId, `-${input.amount}`);
      throw e;
    }
    setSheetOpen(false);
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'rep-payments'}>
      <View style={styles.tabRow}>
        {/* The labels are the point (§S3): Owed, never "Pending". */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: tab === 'owed' }}
          onPress={() => setTab('owed')}
          style={[styles.tab, tab === 'owed' ? styles.tabSelected : null]}
          testID="payments-tab-owed"
        >
          <Text style={[styles.tabLabel, tab === 'owed' ? styles.tabLabelSelected : null]}>Owed</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: tab === 'collected' }}
          onPress={() => setTab('collected')}
          style={[styles.tab, tab === 'collected' ? styles.tabSelected : null]}
          testID="payments-tab-collected"
        >
          <Text style={[styles.tabLabel, tab === 'collected' ? styles.tabLabelSelected : null]}>Collected</Text>
        </Pressable>
      </View>

      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="payments-error" />
      ) : null}

      {tab === 'owed' ? (
        props.owed.length === 0 ? (
          <EmptyState message={OWED_EMPTY_MESSAGE} testID="payments-owed-empty" />
        ) : (
          props.owed.map((row) => (
            <View key={row.companyId} style={styles.owedRow} testID={`payments-owed-${row.companyId}`}>
              <Text style={styles.owedText}>{`${row.name} · owes ₹${formatMoneyEnIN(row.balance)}`}</Text>
              <Button label="Record payment" variant="secondary" onPress={() => openSheet(row.companyId)} testID={`payments-record-${row.companyId}`} />
            </View>
          ))
        )
      ) : props.collected.length === 0 ? (
        <EmptyState message="No payments collected yet." testID="payments-collected-empty" />
      ) : (
        props.collected.map((row) => (
          <View key={row.id} style={styles.collectedRow} testID={`payments-collected-${row.id}`}>
            <View style={styles.collectedMain}>
              <Text style={styles.collectedPrimary}>{row.companyName}</Text>
              <Text style={styles.collectedSecondary}>
                {`${row.paymentNumber} · ${row.mode} · ${formatDateEnIN(row.businessDate, nowYear)}`}
              </Text>
            </View>
            <Text style={styles.collectedAmount}>{`₹${formatMoneyEnIN(row.amount)}`}</Text>
          </View>
        ))
      )}

      {/* Mounted only while open: each open starts a fresh sheet, with the
      company prefilled when it came from a row (§S3). */}
      {sheetOpen ? (
        <RecordPaymentSheet
          visible
          companies={props.companies}
          openSales={props.openSales}
          initialCompanyId={sheetCompany}
          busy={props.pendingRecord.busy}
          error={props.pendingRecord.error}
          record={record}
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
  tabRow: {
    flexDirection: 'row',
    gap: SPACE[2],
    marginBottom: SPACE[2],
  },
  tab: {
    minHeight: TAP.min,
    paddingHorizontal: SPACE[4],
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabSelected: {
    backgroundColor: SEMANTIC.bg.dark,
    borderColor: SEMANTIC.bg.dark,
  },
  tabLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
  },
  tabLabelSelected: {
    color: SEMANTIC.text.onDark,
  },
  owedRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  owedText: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  collectedRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  collectedMain: {
    flex: 1,
    gap: 2,
  },
  collectedPrimary: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  collectedSecondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  collectedAmount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  sheetBody: {
    gap: SPACE[3],
  },
  fieldLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  modeRow: {
    flexDirection: 'row',
    gap: SPACE[2],
  },
  modeSegment: {
    flex: 1,
    minHeight: TAP.min,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: SPACE[1],
  },
  modeSegmentSelected: {
    backgroundColor: SEMANTIC.bg.dark,
    borderColor: SEMANTIC.bg.dark,
  },
  modeLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
  },
  modeLabelSelected: {
    color: SEMANTIC.text.onDark,
  },
  cashReminder: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  proofBlock: {
    gap: SPACE[2],
  },
  proofQueued: {
    ...textStyle('body'),
    color: SEMANTIC.feedback.success,
  },
  proofNote: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
});
