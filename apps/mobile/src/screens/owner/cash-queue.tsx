/**
 * O2 Cash reconciliation queue (T4.9, UI/plan-2/07-OWNER.md §O2). **The
 * reason Phase 4 exists. Not descopable.**
 *
 * **One job, two densities** — the rule this phase measures every screen
 * by: **desk** is a table (flag edge · employee · date · expected ·
 * declared · variance), **phone** is the same rows as cards with
 * expected/declared/variance stacked as a three-column mini-grid inside
 * each card. Never a card grid on desktop.
 *
 * **The two non-negotiables:**
 *
 * - **The default range includes days with no submission**, ends
 *   YESTERDAY, all flags, `missing_submission` first regardless of date.
 *   The server owns that default (§10, T4.2) and its order; the client
 *   re-asserts it (`sortQueueRows`) so a refetch can never demote the row
 *   the feature exists to catch. Today is one tap away (the range
 *   picker's Today option) and every row dated the server's `today`
 *   carries the caption verbatim.
 * - **Every variance is real.** There is NO expenses column — technicians
 *   do not spend from collections — and nothing on this screen lets a
 *   shortfall be explained away. The only actions are confirm, dispute,
 *   or go and look.
 *
 * **Actions per row:** Confirm (primary, opens with the declared amount
 * PREFILLED and editable — the owner confirms what was actually handed
 * over, which may differ) · Dispute (requires a note) · View the day
 * (the completions and payments behind the expected figure). Reopen
 * appears ONLY on confirmed rows, requires a reason, and is deliberately
 * a second action rather than a shortcut on the amend screen.
 *
 * **Motion:** confirming collapses the row over `DURATION.base` (220ms)
 * and cross-fades the flag pill to `match`, with a `Success` haptic. The
 * row does NOT disappear — it stays, resolved, so the owner can see his
 * own work; filtering it out would make a confirmed day
 * indistinguishable from one that never existed. (§9's transform-and-
 * opacity rule renders the "collapse" as a scale settle, never a height
 * relayout.)
 *
 * Pure UI over injected data; `useCashQueue` owns the reads and writes.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { DESK, DURATION, EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import type { CashQueueFlag, CashQueueRow } from '@servgrid/shared';
import { formatMoneyEnIN } from '@servgrid/shared';
import {
  Banner,
  Button,
  EmptyState,
  MoneyField,
  PageHeader,
  Panel,
  Select,
  Sheet,
  TextField,
  pageContentStyle,
  useDensity,
} from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { formatDateEnIN } from '../../components/ui/DatePicker';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import { DeskTable } from './deskTable';
import type { DeskTableColumn, SortState } from './deskTable';
import { varianceLabel } from './model';

/** §O2: today's caption, verbatim — the flags must not lie on the current day. */
export const TODAY_CAPTION = 'Today — still syncing. Figures settle overnight.';

/** §O2's range picker: the default ends yesterday; Today is one tap away. */
export type CashQueueRange = 'last14' | 'today';

export type CashQueueFlagFilter = 'all' | CashQueueFlag;

/** The day behind the expected figure — mirror of the api module's
 * `cash/schemas.ts` (the dashboard model's rule: duplicated, not shared,
 * so the wire shape cannot drift silently through a shared export). */
export interface CashDayCompletion {
  jobId: string;
  jobNumber: string;
  customerName: string | null;
  workSummary: string;
  amountCollected: string;
  completedAt: string;
}

export interface CashDayPayment {
  paymentId: string;
  paymentNumber: string;
  companyName: string;
  amount: string;
  receivedAt: string;
}

export interface CashQueueDay {
  employeeId: string;
  employeeName: string;
  businessDate: string;
  completions: CashDayCompletion[];
  cashPayments: CashDayPayment[];
  completionTotal: string;
  paymentTotal: string;
}

// ── pure helpers (the server's order, re-asserted) ──────────────────────────

/** The view's flag precedence (migration 018) as a sort weight. */
export const FLAG_ORDER: Record<CashQueueFlag, number> = {
  missing_submission: 0,
  no_expected_cash: 1,
  variance: 2,
  match: 3,
};

/**
 * `missing_submission` first regardless of date, then newest day, then
 * name — exactly the server's ORDER BY (§10). Applied on every render so
 * a refetch, a filter change or a stale response can never demote the
 * row the entire feature exists to catch.
 */
export function sortQueueRows(rows: CashQueueRow[]): CashQueueRow[] {
  return [...rows].sort((a, b) => {
    const flag = FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag];
    if (flag !== 0) return flag;
    if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? 1 : -1;
    return a.employeeName.localeCompare(b.employeeName);
  });
}

/** The flag pill: the words the owner acts on, the colour he scans for. */
export const FLAG_PILL: Record<CashQueueFlag, { label: string; color: string }> = {
  missing_submission: { label: 'Missing submission', color: SEMANTIC.feedback.danger },
  no_expected_cash: { label: 'No expected cash', color: SEMANTIC.feedback.warning },
  variance: { label: 'Variance', color: SEMANTIC.feedback.warning },
  match: { label: 'Match', color: SEMANTIC.feedback.success },
};

/** Wire money → `₹1,00,000`. The one money path on this screen. */
export function rupees(amount: string): string {
  return `₹${formatMoneyEnIN(amount)}`;
}

/** A queue row with no declaration renders `—` where a figure would be. */
export function amountOrDash(amount: string | null): string {
  return amount === null ? '—' : rupees(amount);
}

/** Row key — a missing_submission day has no declaration id to key on. */
export function queueRowKey(row: CashQueueRow): string {
  return row.declarationId ?? `${row.employeeId}:${row.businessDate}`;
}

// ── deps ────────────────────────────────────────────────────────────────────

export interface CashQueueDeps {
  /** The server's IST today — the caption's authority, never the device clock. */
  today: string;
  /** Queue rows for the current range + filter; null = not loaded yet. */
  rows: CashQueueRow[] | null;
  error: string | null;
  loading: boolean;
  offline: boolean;
  range: CashQueueRange;
  flagFilter: CashQueueFlagFilter;
  onRange: (range: CashQueueRange) => void;
  onFlagFilter: (flag: CashQueueFlagFilter) => void;
  onRetry: () => void;
  /** The write in flight (confirm/dispute/reopen) and its refusal, verbatim. */
  actionBusy: boolean;
  actionError: string | null;
  /** Resolves true when the row came back confirmed — the sheet closes, the row stays. */
  onConfirm: (row: CashQueueRow, confirmedAmount: string) => Promise<boolean>;
  onDispute: (row: CashQueueRow, ownerNote: string) => Promise<boolean>;
  onReopen: (row: CashQueueRow, reason: string) => Promise<boolean>;
  /** The day read (§O2 "View the day"): null until one is asked for. */
  dayOpen: boolean;
  day: CashQueueDay | null;
  dayLoading: boolean;
  dayError: string | null;
  onViewDay: (row: CashQueueRow) => void;
  onDismissDay: () => void;
}

// ── the row motion — collapse 220ms, pill cross-fade, row stays ─────────────

/**
 * The confirm settle: scale Y to 0.94 on the confirm, back over
 * `DURATION.base` (220ms) — §9 allows transform and opacity only, so the
 * brief's "collapses" lands as a scale settle, never a height relayout.
 * The row remains mounted: resolved, visible, the owner's own work.
 */
function useConfirmSettle(settling: boolean): ReturnType<typeof useAnimatedStyle> {
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!settling) return;
    scale.value = withTiming(0.94, { duration: DURATION.base / 2, easing: easing(EASING.exit) });
    const t = setTimeout(() => {
      scale.value = withTiming(1, { duration: DURATION.base / 2, easing: easing(EASING.enter) });
    }, DURATION.base / 2);
    return () => clearTimeout(t);
  }, [settling, scale]);
  return useAnimatedStyle(() => ({ transform: [{ scaleY: scale.value }] }));
}

/** The flag pill cross-fades 140ms whenever its flag — including to `match`. */
function FlagPill({ flag }: { flag: CashQueueFlag }): React.ReactNode {
  const pill = FLAG_PILL[flag];
  const enter = easing(EASING.enter);
  const opacity = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: DURATION.quick, easing: enter });
  }, [enter, flag, opacity]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      testID={`cash-pill-${flag}`}
      style={[styles.pill, { borderColor: pill.color }, fade]}
    >
      <Text style={[styles.pillLabel, { color: pill.color }]}>{pill.label}</Text>
    </Animated.View>
  );
}

// ── the sheets ──────────────────────────────────────────────────────────────

/**
 * Confirm — primary action, opens with the declared amount PREFILLED and
 * editable: the owner confirms what was actually handed over, and both
 * figures stay stored (§10). A `missing_submission` day has no
 * declaration to prefill — the field opens empty, which is the honest
 * form of "we do not know what he took in".
 */
function ConfirmSheet({
  row,
  busy,
  error,
  onConfirm,
  onDismiss,
}: {
  row: CashQueueRow | null;
  busy: boolean;
  error: string | null;
  onConfirm: (confirmedAmount: string) => void;
  onDismiss: () => void;
}): React.ReactNode {
  const [amount, setAmount] = useState('');
  const prefilled = useRef<string | null>(null);
  // Re-prefill only when a DIFFERENT row opens: typing must survive a
  // rerender, and editing the figure is the entire point of the sheet.
  if (row !== null && prefilled.current !== queueRowKey(row)) {
    prefilled.current = queueRowKey(row);
    setAmount(row.declaredAmount === null ? '' : row.declaredAmount);
  }
  const ready = amount !== '' && !busy;
  return (
    <Sheet
      visible={row !== null}
      title="Confirm the day"
      onDismiss={onDismiss}
      testID="cash-confirm-sheet"
      actions={
        <Button
          label="Confirm"
          disabled={!ready}
          disabledReason="Enter the amount that was handed over."
          loading={busy}
          onPress={() => onConfirm(amount)}
          fullwidth
          testID="cash-confirm-submit"
        />
      }
    >
      {row !== null ? (
        <>
          <Text style={styles.sheetSubject} testID="cash-confirm-subject">
            {row.employeeName} — {formatDateEnIN(row.businessDate, Number(row.businessDate.slice(0, 4)))}
          </Text>
          <Text style={styles.sheetMeta} testID="cash-confirm-figures">
            {`Expected ${amountOrDash(row.expectedCash)} · declared ${amountOrDash(row.declaredAmount)}`}
          </Text>
          <MoneyField
            label="Amount handed over"
            value={amount}
            onChangeText={setAmount}
            helperText="Prefilled with the declaration — edit it if the bag said otherwise."
            testID="cash-confirm-amount"
          />
          {error !== null ? (
            <Text style={styles.sheetError} testID="cash-confirm-error">
              {error}
            </Text>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** Dispute — the note is the point (§10): a dispute without it is a
 * flag he cannot act on tomorrow. Submit stays disabled until it says
 * something; the server's 422 is the backstop, not the guard. */
function DisputeSheet({
  row,
  busy,
  error,
  onDispute,
  onDismiss,
}: {
  row: CashQueueRow | null;
  busy: boolean;
  error: string | null;
  onDispute: (ownerNote: string) => void;
  onDismiss: () => void;
}): React.ReactNode {
  const [note, setNote] = useState('');
  const ready = note.trim().length > 0 && !busy;
  return (
    <Sheet
      visible={row !== null}
      title="Dispute the day"
      onDismiss={onDismiss}
      testID="cash-dispute-sheet"
      actions={
        <Button
          label="Dispute"
          variant="danger"
          disabled={!ready}
          disabledReason="A note is required — say what does not add up."
          loading={busy}
          onPress={() => onDispute(note.trim())}
          fullwidth
          testID="cash-dispute-submit"
        />
      }
    >
      {row !== null ? (
        <>
          <Text style={styles.sheetSubject} testID="cash-dispute-subject">
            {row.employeeName} — {row.businessDate}
          </Text>
          <Text style={styles.sheetMeta} testID="cash-dispute-figures">
            {`Expected ${amountOrDash(row.expectedCash)} · declared ${amountOrDash(row.declaredAmount)}`}
          </Text>
          <TextField
            label="What does not add up?"
            value={note}
            onChangeText={setNote}
            placeholder="The note the employee will read."
            helperText="Required — a dispute without a note is not one he can answer."
            multiline
            rows={3}
            testID="cash-dispute-note"
          />
          {error !== null ? (
            <Text style={styles.sheetError} testID="cash-dispute-error">
              {error}
            </Text>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/** Reopen — only on confirmed rows, reason required, deliberately a
 * second action: confirmation is where money stops being provisional. */
function ReopenSheet({
  row,
  busy,
  error,
  onReopen,
  onDismiss,
}: {
  row: CashQueueRow | null;
  busy: boolean;
  error: string | null;
  onReopen: (reason: string) => void;
  onDismiss: () => void;
}): React.ReactNode {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length > 0 && !busy;
  return (
    <Sheet
      visible={row !== null}
      title="Reopen the day"
      onDismiss={onDismiss}
      testID="cash-reopen-sheet"
      actions={
        <Button
          label="Reopen — returns the day to submitted"
          variant="danger"
          disabled={!ready}
          disabledReason="A reason is required — this reverses a sign-off."
          loading={busy}
          onPress={() => onReopen(reason.trim())}
          fullwidth
          testID="cash-reopen-submit"
        />
      }
    >
      {row !== null ? (
        <>
          <Text style={styles.sheetSubject} testID="cash-reopen-subject">
            {row.employeeName} — {row.businessDate}
          </Text>
          <Text style={styles.sheetMeta}>
            Amending a completion on a signed-off day starts here. The day returns to submitted; the audit trail keeps
            what the sign-off said.
          </Text>
          <TextField
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder="Why is the sign-off being reversed?"
            helperText="Required — the reversal is audited with it."
            multiline
            rows={3}
            testID="cash-reopen-reason"
          />
          {error !== null ? (
            <Text style={styles.sheetError} testID="cash-reopen-error">
              {error}
            </Text>
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

/**
 * View the day — the completions and payments behind the expected
 * figure, so the owner can see which jobs produced the cash. CASH only:
 * UPI/card/transfer money went to the company account and was never in
 * the bag. The two totals add up to the queue row's expected figure.
 */
function DaySheet({
  open,
  day,
  loading,
  error,
  onDismiss,
}: {
  open: boolean;
  day: CashQueueDay | null;
  loading: boolean;
  error: string | null;
  onDismiss: () => void;
}): React.ReactNode {
  return (
    <Sheet visible={open} title={day !== null ? `${day.employeeName} — ${day.businessDate}` : 'The day'} onDismiss={onDismiss} testID="cash-day-sheet">
      {error !== null ? (
        <Text style={styles.sheetError} testID="cash-day-error">
          {error}
        </Text>
      ) : null}
      {loading && day === null ? (
        <Text style={styles.sheetMeta} testID="cash-day-loading">
          Reading the day…
        </Text>
      ) : null}
      {day !== null ? (
        <>
          <Text style={styles.daySection} testID="cash-day-completions-heading">
            CASH COMPLETIONS — {rupees(day.completionTotal)}
          </Text>
          {day.completions.length === 0 ? (
            <Text style={styles.sheetMeta} testID="cash-day-completions-empty">
              No cash completions this day.
            </Text>
          ) : (
            day.completions.map((c) => (
              <View key={c.jobId} style={styles.dayRow} testID={`cash-day-completion-${c.jobNumber}`}>
                <Text style={styles.dayRowMain}>
                  {`${c.jobNumber} · ${c.customerName ?? '—'}`}
                </Text>
                <Text style={styles.dayRowSub}>{c.workSummary}</Text>
                <Text style={styles.dayRowAmount}>{rupees(c.amountCollected)}</Text>
              </View>
            ))
          )}
          <Text style={styles.daySection} testID="cash-day-payments-heading">
            CASH PAYMENTS — {rupees(day.paymentTotal)}
          </Text>
          {day.cashPayments.length === 0 ? (
            <Text style={styles.sheetMeta} testID="cash-day-payments-empty">
              No cash payments this day.
            </Text>
          ) : (
            day.cashPayments.map((p) => (
              <View key={p.paymentId} style={styles.dayRow} testID={`cash-day-payment-${p.paymentNumber}`}>
                <Text style={styles.dayRowMain}>{`${p.paymentNumber} · ${p.companyName}`}</Text>
                <Text style={styles.dayRowAmount}>{rupees(p.amount)}</Text>
              </View>
            ))
          )}
          <Text style={styles.sheetMeta} testID="cash-day-total">
            {`Expected for the day: ${rupees((Number(day.completionTotal) + Number(day.paymentTotal)).toFixed(2))}`}
          </Text>
        </>
      ) : null}
    </Sheet>
  );
}

// ── the rows ────────────────────────────────────────────────────────────────

/** Today's row is still syncing. `padded` is for the desk, where the
 * caption sits inside the card and the table below it starts flush to
 * the card's edge. */
function TodayCaption({ padded = false }: { padded?: boolean }): React.ReactNode {
  return (
    <Text style={[styles.todayCaption, padded && styles.todayCaptionPadded]} testID="cash-today-caption">
      {TODAY_CAPTION}
    </Text>
  );
}

interface RowActions {
  onConfirm: (row: CashQueueRow) => void;
  onDispute: (row: CashQueueRow) => void;
  onReopen: (row: CashQueueRow) => void;
  onViewDay: (row: CashQueueRow) => void;
}

/** The three (or four) actions of an open row. Confirm is primary;
 * Reopen exists ONLY on a confirmed row — a `submitted` day has nothing
 * to reverse (§10). */
function actionSet(row: CashQueueRow, acts: RowActions, size: 'row' | 'card'): React.ReactNode {
  const confirmable = row.declarationId !== null && row.status === 'submitted';
  return (
    <View style={size === 'card' ? styles.cardActions : styles.rowActions}>
      {confirmable ? (
        <Button label="Confirm" onPress={() => acts.onConfirm(row)} testID={`cash-confirm-${queueRowKey(row)}`} />
      ) : null}
      {confirmable ? (
        <Button label="Dispute" variant="secondary" onPress={() => acts.onDispute(row)} testID={`cash-dispute-${queueRowKey(row)}`} />
      ) : null}
      <Button label="View the day" variant="ghost" onPress={() => acts.onViewDay(row)} testID={`cash-day-${queueRowKey(row)}`} />
      {row.status === 'confirmed' ? (
        <Button label="Reopen" variant="secondary" onPress={() => acts.onReopen(row)} testID={`cash-reopen-${queueRowKey(row)}`} />
      ) : null}
    </View>
  );
}

/** One PHONE card: flag edge, pill, who and when, the three-column
 * mini-grid (expected/declared/variance — §O2), today's caption, actions. */
function CashCard({
  row,
  today,
  settling,
  acts,
}: {
  row: CashQueueRow;
  today: string;
  settling: boolean;
  acts: RowActions;
}): React.ReactNode {
  const settle = useConfirmSettle(settling);
  const pill = FLAG_PILL[row.flag];
  return (
    <Animated.View
      testID={`cash-row-${queueRowKey(row)}`}
      style={[styles.card, settle]}
    >
      <View style={[styles.cardEdge, { backgroundColor: pill.color }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardHead}>
          <FlagPill flag={row.flag} />
          <Text style={styles.cardName} testID={`cash-employee-${queueRowKey(row)}`}>
            {row.employeeName}
          </Text>
          <Text style={styles.cardDate}>
            {formatDateEnIN(row.businessDate, Number(row.businessDate.slice(0, 4)))}
          </Text>
        </View>
        <View style={styles.miniGrid} testID={`cash-figures-${queueRowKey(row)}`}>
          <View style={styles.miniCell}>
            <Text style={styles.miniLabel}>EXPECTED</Text>
            <Text style={[styles.miniValue, row.expectedCash === null && styles.miniValueDash]}>
              {amountOrDash(row.expectedCash)}
            </Text>
          </View>
          <View style={styles.miniCell}>
            <Text style={styles.miniLabel}>DECLARED</Text>
            <Text style={[styles.miniValue, row.declaredAmount === null && styles.miniValueDash]}>
              {amountOrDash(row.declaredAmount)}
            </Text>
          </View>
          <View style={styles.miniCell}>
            <Text style={styles.miniLabel}>VARIANCE</Text>
            <Text style={[styles.miniValue, row.variance === null && styles.miniValueDash]}>
              {row.variance === null ? '—' : varianceLabel(row.variance)}
            </Text>
          </View>
        </View>
        {row.businessDate === today ? <TodayCaption /> : null}
        {row.note !== null ? (
          <Text style={styles.cardNote} numberOfLines={2}>
            {row.note}
          </Text>
        ) : null}
        {actionSet(row, acts, 'card')}
      </View>
    </Animated.View>
  );
}

// ── the screen ──────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { value: 'last14', label: 'Last 14 days' },
  { value: 'today', label: 'Today' },
] as const;

const FLAG_FILTER_OPTIONS = [
  { value: 'all', label: 'All flags' },
  { value: 'missing_submission', label: 'Missing submission' },
  { value: 'no_expected_cash', label: 'No expected cash' },
  { value: 'variance', label: 'Variance' },
  { value: 'match', label: 'Match' },
] as const;

export function OwnerCashQueueScreen(deps: CashQueueDeps): React.ReactNode {
  const desk = useDensity() === 'desk';
  const [sort, setSort] = useState<SortState>({ key: 'flag', dir: 'asc' });
  const [confirmTarget, setConfirmTarget] = useState<CashQueueRow | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<CashQueueRow | null>(null);
  const [reopenTarget, setReopenTarget] = useState<CashQueueRow | null>(null);
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
  const nowYear = Number(deps.today.slice(0, 4));

  const rows = deps.rows === null ? null : sortQueueRows(deps.rows);

  const acts: RowActions = {
    onConfirm: (row) => setConfirmTarget(row),
    onDispute: (row) => setDisputeTarget(row),
    onReopen: (row) => setReopenTarget(row),
    onViewDay: (row) => deps.onViewDay(row),
  };

  const runConfirm = async (confirmedAmount: string): Promise<void> => {
    if (confirmTarget === null) return;
    const target = confirmTarget;
    if (await deps.onConfirm(target, confirmedAmount)) {
      setConfirmTarget(null);
      // Success haptic; the row settles and its pill cross-fades to
      // match — and the row STAYS (§O2 motion).
      haptic('completionSynced');
      setSettlingKey(queueRowKey(target));
    }
  };

  const runDispute = async (ownerNote: string): Promise<void> => {
    if (disputeTarget === null) return;
    if (await deps.onDispute(disputeTarget, ownerNote)) setDisputeTarget(null);
  };

  const runReopen = async (reason: string): Promise<void> => {
    if (reopenTarget === null) return;
    if (await deps.onReopen(reopenTarget, reason)) setReopenTarget(null);
  };

  const columns: DeskTableColumn<CashQueueRow>[] = [
    {
      key: 'employeeName',
      label: 'Employee',
      width: null,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellStrong} testID={`cash-employee-${queueRowKey(r)}`}>
          {r.employeeName}
        </Text>
      ),
      sortValue: (r) => r.employeeName,
    },
    {
      key: 'businessDate',
      label: 'Date',
      width: 96,
      render: (r) => <Text numberOfLines={1} style={styles.cell}>{formatDateEnIN(r.businessDate, nowYear)}</Text>,
      sortValue: (r) => r.businessDate,
    },
    {
      key: 'expectedCash',
      label: 'Expected',
      width: 110,
      align: 'right',
      render: (r) => <Text numberOfLines={1} style={styles.cellMoney}>{amountOrDash(r.expectedCash)}</Text>,
      sortValue: (r) => (r.expectedCash === null ? -1 : Number(r.expectedCash)),
    },
    {
      key: 'declaredAmount',
      label: 'Declared',
      width: 110,
      align: 'right',
      render: (r) => <Text numberOfLines={1} style={styles.cellMoney}>{amountOrDash(r.declaredAmount)}</Text>,
      sortValue: (r) => (r.declaredAmount === null ? -1 : Number(r.declaredAmount)),
    },
    {
      key: 'variance',
      label: 'Variance',
      width: 120,
      align: 'right',
      render: (r) => <Text numberOfLines={1} style={styles.cellMoney}>{r.variance === null ? '—' : varianceLabel(r.variance)}</Text>,
      sortValue: (r) => (r.variance === null ? -1 : Number(r.variance)),
    },
    {
      key: 'flag',
      label: 'Flag',
      width: 170,
      // The table's cell stretches its children, which drew the pill the
      // full 146dp of the column — a bordered empty-looking box for an
      // eight-letter word. In a row wrapper it hugs its label again.
      render: (r) => (
        <View style={styles.pillWrap}>
          <FlagPill flag={r.flag} />
        </View>
      ),
      sortValue: (r) => FLAG_ORDER[r.flag],
    },
    {
      key: 'actions',
      label: '',
      // An open row's three buttons are 304dp of 36dp-tall Button, and
      // the cell's own 12dp side padding means a 330dp column left them
      // 6dp short — they wrapped to a second line inside a 40dp row,
      // whose `overflow: hidden` then cut every label in half and let
      // "View the day" paint into the next row's band (2026-09-19).
      width: 356,
      render: (r) => actionSet(r, acts, 'row'),
    },
  ];

  // The page's two filters. On the desk they ride in the page header,
  // which is where a console list keeps its filters (Companies, §O5) —
  // and the header is the one element that outranks the table: a
  // dropdown menu painted under the rows it filters is the bug the
  // header's z-index exists to prevent.
  const filters = (
    <>
      <Select
        label="Range"
        value={deps.range}
        options={RANGE_OPTIONS.map((o) => ({ ...o }))}
        onSelect={(v) => deps.onRange(v as CashQueueRange)}
        testID="cash-range"
      />
      <Select
        label="Flags"
        value={deps.flagFilter}
        options={FLAG_FILTER_OPTIONS.map((o) => ({ ...o }))}
        onSelect={(v) => deps.onFlagFilter(v as CashQueueFlagFilter)}
        testID="cash-flag-filter"
      />
    </>
  );

  return (
    <View style={[styles.root, desk && pageContentStyle(true)]} testID="owner-cash-queue">
      <PageHeader
        title="Cash reconciliation"
        subtitle={desk ? 'Collected cash, against what each technician declared.' : undefined}
        actions={desk ? filters : undefined}
        testID="cash-page"
      />

      {deps.offline ? (
        <Banner tone="danger" message="No connection. Figures are not live." testID="cash-offline-banner" />
      ) : null}

      {desk ? null : <View style={styles.filters}>{filters}</View>}

      {deps.error !== null ? (
        <EmptyState
          message={deps.error}
          actionLabel="Retry"
          onAction={deps.onRetry}
          testID="cash-queue-error"
        />
      ) : deps.loading && rows === null ? (
        // Loading — quiet, no spinner theatre; the range and flags are
        // already on the screen and the rows arrive with their data.
        <Text style={styles.sheetMeta} testID="cash-queue-loading">
          Reading the queue…
        </Text>
      ) : rows !== null && rows.length === 0 ? (
        <EmptyState message="Nothing to reconcile in this range." testID="cash-queue-empty" />
      ) : rows !== null ? (
        desk ? (
          <Panel padded={false}>
            {deps.range === 'today' ? <TodayCaption padded /> : null}
            <DeskTable
              data={rows}
              columns={columns}
              rowKey={queueRowKey}
              sort={sort}
              onSort={setSort}
              edgeColor={(r) => FLAG_PILL[r.flag].color}
              scrollTestID="cash-queue-table"
              maxHeight={640}
            />
          </Panel>
        ) : (
          <ScrollView
            style={styles.cardList}
            contentContainerStyle={{ gap: SPACE[3], paddingBottom: SPACE[8] }}
            testID="cash-queue-cards"
          >
            {deps.range === 'today' ? <TodayCaption /> : null}
            {rows.map((row) => (
              <CashCard key={queueRowKey(row)} row={row} today={deps.today} settling={settlingKey === queueRowKey(row)} acts={acts} />
            ))}
          </ScrollView>
        )
      ) : null}

      <ConfirmSheet
        row={confirmTarget}
        busy={deps.actionBusy}
        error={deps.actionError}
        onConfirm={(amount) => void runConfirm(amount)}
        onDismiss={() => setConfirmTarget(null)}
      />
      <DisputeSheet
        row={disputeTarget}
        busy={deps.actionBusy}
        error={deps.actionError}
        onDispute={(note) => void runDispute(note)}
        onDismiss={() => setDisputeTarget(null)}
      />
      <ReopenSheet
        row={reopenTarget}
        busy={deps.actionBusy}
        error={deps.actionError}
        onReopen={(reason) => void runReopen(reason)}
        onDismiss={() => setReopenTarget(null)}
      />
      <DaySheet
        open={deps.dayOpen}
        day={deps.day}
        loading={deps.dayLoading}
        error={deps.dayError}
        onDismiss={deps.onDismissDay}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: SEMANTIC.bg.app,
    padding: SPACE[4],
    gap: SPACE[3],
  },
  // The desk's page furniture is `pageContentStyle(true)` — the same
  // measure DeskListShell hands the other lists, which this screen takes
  // directly because it owns its own header (the filters live in it).
  filters: { gap: SPACE[3] },
  cardList: { flex: 1 },
  card: {
    alignSelf: 'stretch',
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  cardEdge: { width: 4 },
  cardBody: { flex: 1, padding: SPACE[3], gap: SPACE[2] },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  cardName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 },
  cardDate: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  miniGrid: { flexDirection: 'row', alignSelf: 'stretch' },
  miniCell: { flex: 1, gap: 2 },
  miniLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  miniValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  miniValueDash: { color: SEMANTIC.text.disabled },
  cardNote: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], marginTop: SPACE[1] },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[1], alignItems: 'center' },
  todayCaption: { ...textStyle('caption'), color: SEMANTIC.text.secondary, fontStyle: 'italic' },
  todayCaptionPadded: { paddingHorizontal: DESK.card.pad, paddingTop: DESK.card.pad },
  pill: {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  /** A row wrapper so the pill hugs its label inside the desk cell. */
  pillWrap: { flexDirection: 'row', alignItems: 'center' },
  pillLabel: { ...textStyle('label'), fontSize: 11 },
  cell: { ...textStyle('body'), color: SEMANTIC.text.primary },
  cellStrong: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  cellMoney: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  sheetSubject: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, marginBottom: SPACE[1] },
  sheetMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginBottom: SPACE[2] },
  sheetError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] },
  daySection: { ...textStyle('label'), color: SEMANTIC.text.secondary, marginTop: SPACE[3], marginBottom: SPACE[1] },
  dayRow: {
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: 2,
  },
  dayRowMain: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  dayRowSub: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  dayRowAmount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
});
