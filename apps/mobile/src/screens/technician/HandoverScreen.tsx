/**
 * T6 Cash handover (UI/plan-2/04-TECHNICIAN.md §T6, PLAN-FRONTEND.md §9).
 * Its own tab — touched once a day at the end of a shift by someone who
 * wants to leave, so it is one tap from the tab bar, not a row inside
 * Profile. A skipped handover is the `missing_submission` row the
 * owner's whole queue exists to catch.
 *
 * Anatomy: date (today, changeable back 7 days) · one large `MoneyField`
 * · optional note · *Submit declaration* · his own history with status
 * pills.
 *
 * The two absences, both deliberate (§T6): **no expected figure** — he
 * declares, and the system's expectation is the check; showing the
 * answer turns a reconciliation into a form-fill — and **no expenses
 * field**, because technicians do not spend from collections. Neither
 * string appears in this file's copy, and `handover.test.tsx` holds the
 * first absence against the whole rendered tree.
 *
 * States (§T6):
 * - no row for the day → the declaration form.
 * - `submitted`, not yet acted on → the declared amount, the pill, and
 *   an **Amend** action. Not a convenience: without it a typo'd figure
 *   has no route at all — the row is unique per employee-day, and a
 *   queue where variances are sometimes typos is a queue that gets
 *   skimmed.
 * - `confirmed` / `disputed` → read-only, with the copy saying why:
 *   correctable until signed off, then it takes a deliberate second
 *   action by someone else.
 *
 * Pure UI over injected seams (`HandoverDeps`) — the route file owns the
 * API calls, exactly as the ladder does. All dates are IST business
 * dates (`business_date()`, migration 001), computed once by the route
 * and passed in as `today`, so the window logic stays pure and
 * testable.
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CashAmendRequest, CashDeclareRequest, CashHandover, ReconciliationStatus } from '@servgrid/shared';
import { formatMoneyEnIN, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, DatePicker, MoneyField, TextField, formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

// ── pure date helpers (exported for the route and the tests) ──────────────

/** The declaration window: today back 7 days, inclusive (§T6). */
export const HANDOVER_WINDOW_DAYS = 7;

/** Today's IST business date — the same day the server's
 * `business_date()` stamps. `en-CA` formats as `YYYY-MM-DD`. */
export function istBusinessDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/** Calendar shift on plain ISO dates — no timezone hides in `YYYY-MM-DD`. */
export function shiftBusinessDate(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The picker refuses anything outside today → today − 7 (and the future). */
export function isWithinHandoverWindow(candidate: string, today: string): boolean {
  return candidate <= today && candidate >= shiftBusinessDate(today, -HANDOVER_WINDOW_DAYS);
}

/** The days the picker offers, today first. */
export function handoverWindow(today: string): string[] {
  const days: string[] = [];
  for (let back = 0; back <= HANDOVER_WINDOW_DAYS; back += 1) days.push(shiftBusinessDate(today, -back));
  return days;
}

// ── pure presentation helpers ─────────────────────────────────────────────

/** The server's `reconciliation_status`, as the pill reads (§T6). */
export const STATUS_PILL: Record<ReconciliationStatus, { label: string; color: string }> = {
  submitted: { label: 'Submitted', color: SEMANTIC.feedback.warning },
  confirmed: { label: 'Confirmed', color: SEMANTIC.feedback.success },
  disputed: { label: 'Disputed', color: SEMANTIC.feedback.danger },
};

/** Why the day is read-only (§T6) — correctable until signed off, then
 * it takes a deliberate second action by someone else. */
export function lockedCopy(status: ReconciliationStatus): string {
  return status === 'disputed'
    ? 'The office has disputed this day. Ask the owner to reopen it.'
    : 'The office has confirmed this day. Ask the owner to reopen it.';
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Mirrors the server's `moneyString` so the button never submits a body
 * the API would refuse. `0` is honest — some days no cash is collected. */
export function isValidAmount(raw: string): boolean {
  return AMOUNT_PATTERN.test(raw);
}

/** The screen's banner copy from a failed call — the server's `message`
 * verbatim when there is one (§X5), a plain fallback otherwise. */
export function handoverError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message === '' ? 'The declaration could not be saved. Try again.' : message;
}

// ── the screen ────────────────────────────────────────────────────────────

export interface HandoverDeps {
  /** Today's IST business date, `YYYY-MM-DD` — computed once by the route. */
  today: string;
  /** His own declarations, any order; the screen sorts newest first. */
  loadHistory: () => Promise<CashHandover[]>;
  declare: (input: CashDeclareRequest) => Promise<CashHandover>;
  /** `version` is the row's optimistic-concurrency version (`If-Match`). */
  amend: (id: string, version: number, input: CashAmendRequest) => Promise<CashHandover>;
}

function dateOptionLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  if (iso === shiftBusinessDate(today, -1)) return 'Yesterday';
  return formatDateEnIN(iso, Number(today.slice(0, 4)));
}

export function HandoverScreen(deps: HandoverDeps): React.ReactNode {
  const [history, setHistory] = useState<CashHandover[] | null>(null);
  const [date, setDate] = useState(deps.today);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [amending, setAmending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    deps
      .loadHistory()
      .then((rows) => {
        if (alive) setHistory([...rows].sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1)));
      })
      .catch(() => {
        if (alive) setHistory([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const row = history?.find((h) => h.businessDate === date) ?? null;

  function chooseDate(iso: string): void {
    // The guard behind the picker: the sheet only offers in-window days,
    // and anything handed to the picker from outside the window is
    // refused here rather than applied (§T6 — changeable back 7 days).
    if (!isWithinHandoverWindow(iso, deps.today)) {
      setDateError(`Handovers cover the last ${HANDOVER_WINDOW_DAYS} days — pick a day from today back.`);
      return;
    }
    setDateError(null);
    setPickerOpen(false);
    setDate(iso);
    setAmount('');
    setNote('');
    setAmending(false);
    setError(null);
  }

  async function submit(): Promise<void> {
    if (busy || !isValidAmount(amount)) return;
    setBusy(true);
    setError(null);
    try {
      const declared = await deps.declare({
        businessDate: date,
        declaredAmount: amount,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setHistory((current) => [declared, ...(current ?? []).filter((h) => h.id !== declared.id)]);
      setAmount('');
      setNote('');
    } catch (e) {
      setError(handoverError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAmendment(): Promise<void> {
    if (row === null || busy || !isValidAmount(amount)) return;
    setBusy(true);
    setError(null);
    try {
      const amended = await deps.amend(row.id, row.version, {
        declaredAmount: amount,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      setHistory((current) => (current ?? []).map((h) => (h.id === amended.id ? amended : h)));
      setAmending(false);
      setAmount('');
      setNote('');
    } catch (e) {
      setError(handoverError(e));
    } finally {
      setBusy(false);
    }
  }

  function beginAmend(): void {
    if (row === null) return;
    setAmount(row.declaredAmount);
    setNote(row.note ?? '');
    setAmending(true);
  }

  function cancelAmend(): void {
    setAmending(false);
    setAmount('');
    setNote('');
    setError(null);
  }

  const pill = row !== null ? STATUS_PILL[row.status] : null;

  return (
    <ScrollView contentContainerStyle={styles.content} testID="handover-screen">
      <Text style={styles.heading} testID="handover-title">
        Cash handover
      </Text>
      <Text style={styles.caption}>Declare the cash you are handing over. One number.</Text>

      {error !== null ? <Banner tone="danger" message={error} onDismiss={() => setError(null)} testID="handover-banner" /> : null}

      <View style={styles.block}>
        <DatePicker
          label="Date"
          value={date}
          onChange={chooseDate}
          errorText={dateError ?? undefined}
          helperText={dateError === null ? `Today back ${HANDOVER_WINDOW_DAYS} days` : undefined}
          testID="handover-date"
        />
        <Button
          label="Change date"
          variant="ghost"
          onPress={() => setPickerOpen(true)}
          testID="handover-date-open"
        />
      </View>

      {row === null ? (
        <View style={styles.block}>
          <MoneyField
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            helperText="The amount you are handing over at the counter."
            testID="handover-amount"
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="Anything the office should know"
            testID="handover-note"
          />
          <Button
            label="Submit declaration"
            onPress={() => void submit()}
            loading={busy}
            disabled={!isValidAmount(amount)}
            disabledReason="Enter the amount you are handing over."
            fullwidth
            testID="handover-submit"
          />
        </View>
      ) : amending ? (
        <View style={styles.block}>
          <MoneyField
            label="Corrected amount"
            value={amount}
            onChangeText={setAmount}
            helperText="Your correction replaces the figure the office sees."
            testID="handover-amend-amount"
          />
          <TextField label="Note (optional)" value={note} onChangeText={setNote} testID="handover-amend-note" />
          <Button
            label="Save amendment"
            onPress={() => void saveAmendment()}
            loading={busy}
            disabled={!isValidAmount(amount)}
            disabledReason="Enter the corrected amount."
            fullwidth
            testID="handover-amend-save"
          />
          <Button label="Keep original" variant="ghost" onPress={cancelAmend} fullwidth testID="handover-amend-cancel" />
        </View>
      ) : (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>Declared for {dateOptionLabel(row.businessDate, deps.today)}</Text>
          <Text style={styles.declaredAmount} testID="handover-declared-amount">
            {`₹ ${formatMoneyEnIN(row.declaredAmount)}`}
          </Text>
          <Text style={styles.pillText} testID="handover-status-pill">
            <Text style={{ color: pill?.color }}>● </Text>
            {pill?.label}
          </Text>
          {row.note !== null ? <Text style={styles.note}>{row.note}</Text> : null}
          {row.status === 'submitted' ? (
            <Button label="Amend" variant="secondary" onPress={beginAmend} testID="handover-amend" />
          ) : (
            <Text style={styles.lockedCopy} testID="handover-locked-copy">
              {lockedCopy(row.status)}
            </Text>
          )}
        </View>
      )}

      <Text style={styles.sectionLabel}>Your declarations</Text>
      {history === null ? null : history.length === 0 ? (
        <Text style={styles.emptyHistory} testID="handover-history-empty">
          Nothing declared yet.
        </Text>
      ) : (
        history.map((h) => {
          const historyPill = STATUS_PILL[h.status];
          return (
            <View key={h.id} style={styles.historyRow} testID={`handover-history-row-${h.businessDate}`}>
              <Text style={styles.historyDate}>{dateOptionLabel(h.businessDate, deps.today)}</Text>
              <Text style={styles.historyAmount}>{`₹ ${formatMoneyEnIN(h.declaredAmount)}`}</Text>
              <Text style={[styles.historyPill, { color: historyPill.color }]}>{historyPill.label}</Text>
            </View>
          );
        })
      )}

      {pickerOpen ? (
        <View style={styles.sheet} testID="handover-date-sheet">
          <Text style={styles.sheetTitle}>Pick a day</Text>
          {handoverWindow(deps.today).map((iso) => (
            <Pressable
              key={iso}
              accessibilityRole="button"
              onPress={() => chooseDate(iso)}
              style={[styles.sheetRow, iso === date ? styles.sheetRowSelected : null]}
              testID={`handover-date-option-${iso}`}
            >
              <Text style={styles.sheetRowLabel}>{dateOptionLabel(iso, deps.today)}</Text>
              <Text style={styles.sheetRowDate}>{iso}</Text>
            </Pressable>
          ))}
          <Button label="Cancel" variant="ghost" onPress={() => setPickerOpen(false)} testID="handover-date-close" />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[1],
  },
  caption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[4],
  },
  block: {
    alignSelf: 'stretch',
    gap: SPACE[3],
    marginBottom: SPACE[5],
  },
  fieldLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  declaredAmount: {
    ...textStyle('display'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACE[1],
  },
  pillText: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[2],
  },
  note: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[2],
  },
  lockedCopy: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[2],
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[2],
    marginTop: SPACE[2],
  },
  emptyHistory: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  historyRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACE[3],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  historyDate: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  historyAmount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    marginRight: SPACE[3],
  },
  historyPill: {
    ...textStyle('label'),
  },
  sheet: {
    alignSelf: 'stretch',
    marginTop: SPACE[4],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    padding: SPACE[3],
  },
  sheetTitle: {
    ...textStyle('h2'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[2],
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: SPACE[2],
    borderRadius: RADII.control,
  },
  sheetRowSelected: {
    backgroundColor: SEMANTIC.bg.dense,
  },
  sheetRowLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  sheetRowDate: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
});
