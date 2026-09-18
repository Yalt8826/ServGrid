/**
 * The declaration form (UI/plan-2/04-TECHNICIAN.md §T6, PLAN-FRONTEND.md
 * §9). The panel, not the screen: the navy frame and the Declare/History
 * tabs belong to `CashScreen`, which composes this with
 * `CashHistoryScreen` (2026-09-18 — the history came back, and it needed
 * a tab of its own rather than a block appended here).
 *
 * Anatomy: date (today, changeable back 7 days) · one large `MoneyField`
 * · optional note · *Submit declaration* · the selected day's state with
 * its status pill.
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
 * `history` arrives from `CashScreen` rather than being loaded here: the
 * tabs read the same rows, and two loads of one day's declarations is two
 * chances to show two answers.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CashAmendRequest, CashDeclareRequest, CashHandover } from '@servgrid/shared';
import { alpha, COLORS, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { formatMoneyEnIN } from '@servgrid/shared';
import { Banner, Button, DatePicker, MoneyField, SectionHeader, TextField } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import {
  dateOptionLabel,
  HANDOVER_WINDOW_DAYS,
  handoverError,
  handoverWindow,
  isValidAmount,
  isWithinHandoverWindow,
  lockedCopy,
  STATUS_PILL,
} from './handoverModel';

export interface HandoverPanelDeps {
  /** Today's IST business date, `YYYY-MM-DD` — computed once by the route. */
  today: string;
  /** His own declarations, any order; the panel reads the selected day's.
   * `null` while the read is in flight. */
  history: CashHandover[] | null;
  declare: (input: CashDeclareRequest) => Promise<CashHandover>;
  /** `version` is the row's optimistic-concurrency version (`If-Match`). */
  amend: (id: string, version: number, input: CashAmendRequest) => Promise<CashHandover>;
  /** Called with the row a declare or amend produced, so the screen that
   * owns the history can fold it in without a second read. */
  onChanged: (row: CashHandover) => void;
}

export function HandoverPanel(deps: HandoverPanelDeps): React.ReactNode {
  const [date, setDate] = useState(deps.today);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [amending, setAmending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const row = deps.history?.find((h) => h.businessDate === date) ?? null;

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
      deps.onChanged(declared);
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
      deps.onChanged(amended);
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
    <View style={styles.body} testID="handover-panel">
      {error !== null ? (
        <Banner tone="danger" message={error} onDismiss={() => setError(null)} testID="handover-banner" />
      ) : null}

      <View style={styles.block}>
        <SectionHeader label="Day" icon="calendar" />
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
          icon="calendar"
          variant="secondary"
          onPress={() => setPickerOpen(true)}
          testID="handover-date-open"
        />
      </View>

      {pickerOpen ? (
        <View style={styles.sheet} testID="handover-date-sheet">
          <SectionHeader label="Pick a day" icon="calendar" />
          {handoverWindow(deps.today).map((iso) => {
            const chosenDay = iso === date;
            return (
              <Pressable
                key={iso}
                accessibilityRole="button"
                accessibilityState={{ selected: chosenDay }}
                onPress={() => chooseDate(iso)}
                style={[styles.sheetRow, chosenDay ? styles.sheetRowChosen : null]}
                testID={`handover-date-option-${iso}`}
              >
                <Text style={styles.sheetRowLabel}>{dateOptionLabel(iso, deps.today)}</Text>
                {chosenDay ? <Icon name="check" size={ICON.sm} color={SEMANTIC.text.primary} /> : null}
                <Text style={styles.sheetRowDate}>{iso}</Text>
              </Pressable>
            );
          })}
          <Button label="Cancel" variant="ghost" onPress={() => setPickerOpen(false)} testID="handover-date-close" />
        </View>
      ) : null}

      {row === null ? (
        <View style={styles.panel}>
          <SectionHeader label="Declare" icon="wallet" tint={COLORS.accent} />
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
        <View style={styles.panel}>
          <SectionHeader label="Amend" icon="edit" />
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
        <View style={styles.panel}>
          <SectionHeader
            label="Declared"
            icon={pill?.label === 'Confirmed' ? 'checkFilled' : 'wallet'}
            tint={pill?.color ?? SEMANTIC.text.primary}
          />
          <Text style={styles.fieldLabel}>Declared for {dateOptionLabel(row.businessDate, deps.today)}</Text>
          <Text style={styles.declaredAmount} testID="handover-declared-amount">
            {`₹ ${formatMoneyEnIN(row.declaredAmount)}`}
          </Text>
          {/* The day's state as a tinted chip — the dot keeps the status
              ink, the word carries the meaning, the tint is only a ground
              (the same arithmetic as StatusPill). */}
          <View
            testID="handover-status-pill"
            style={[styles.pillChip, {
              borderColor: alpha(pill?.color ?? SEMANTIC.text.primary, TINT.chipLine),
              backgroundColor: alpha(pill?.color ?? SEMANTIC.text.primary, TINT.chip),
            }]}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pill?.color }} />
            <Text style={styles.pillText}>{pill?.label}</Text>
          </View>
          {row.note !== null ? <Text style={styles.note}>{row.note}</Text> : null}
          {row.status === 'submitted' ? (
            <Button label="Amend" icon="edit" variant="secondary" onPress={beginAmend} testID="handover-amend" />
          ) : (
            <Text style={styles.lockedCopy} testID="handover-locked-copy">
              {lockedCopy(row.status)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    alignSelf: 'stretch',
    flexGrow: 1,
    // No horizontal gutter here: `CashScreen` owns the page's padding, so
    // the panel and the history list line up on the same edge.
    paddingTop: SPACE[5],
  },
  panel: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
    padding: SPACE[4],
    gap: SPACE[3],
    marginBottom: SPACE[5],
  },
  /** The day's state, as a tinted chip (the StatusPill arithmetic: the dot
   * carries the status ink, the word the meaning, the tint only a ground). */
  pillChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[2],
    paddingVertical: 3,
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
  sheet: {
    alignSelf: 'stretch',
    marginBottom: SPACE[5],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    padding: SPACE[3],
    gap: SPACE[2],
  },
  sheetRow: {
    minHeight: TAP.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: RADII.control,
  },
  sheetRowChosen: {
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  sheetRowLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  sheetRowDate: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
});
