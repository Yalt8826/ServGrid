/**
 * The amend sheet (§O4, PLAN-BACKEND.md §6.2b) — the owner's correction
 * of a filed completion. Three things the spec pins, all here:
 *
 * - **Reason required.** The confirm button stays dead until the reason
 *   says something — an amendment without a stated why is exactly the
 *   ₹50,000-typo path this sheet exists to close.
 * - **Current values, new values, and the difference.** The owner is
 *   correcting a number and must see the size of the correction before
 *   committing it — the comparison is the sheet's body, not fine print.
 * - **The confirmed-day refusal opens the reopen offer, with the
 *   reconciliation named.** The API refuses with 409
 *   RECONCILIATION_CONFIRMED and `details.reconciliation`; the sheet
 *   renders that day, offers the reopen with its own required reason,
 *   and the owner still has to press *Amend* again afterwards — two
 *   deliberate steps, never one convenient one (§6.2b).
 *
 * Pure UI over injected deps; the route owns the POSTs.
 */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, MoneyField, Sheet, TextField } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { amendComparisonRows, type AmendCurrent } from './jobsModel';

/** The refusal as the sheet reads it: the message plus, when the day is signed off, the reconciliation itself. */
export interface AmendRefusal {
  message: string;
  reconciliation: { id: string; businessDate: string; status: string } | null;
}

export interface AmendSheetProps {
  visible: boolean;
  /** What is being corrected, named on the sheet: "JC-2627-0044". */
  jobNumber: string;
  /** The stored figures — the comparison's left column and the fields' starting point. */
  current: AmendCurrent;
  busy: boolean;
  /** The server refusal; a reconciliation in it opens the reopen offer. */
  error: AmendRefusal | null;
  reopenBusy: boolean;
  onAmend(input: { cost: string; discountAmount: string; discountReason: string; reason: string }): void;
  onReopen(reason: string): void;
  onDismiss(): void;
  testID?: string;
}

export function AmendSheet(props: AmendSheetProps): React.ReactNode {
  const [cost, setCost] = useState(props.current.cost ?? '0');
  const [discountAmount, setDiscountAmount] = useState(props.current.discountAmount ?? '0');
  const [discountReason, setDiscountReason] = useState(props.current.discountReason ?? '');
  const [reason, setReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');

  const rows = useMemo(
    () => amendComparisonRows(props.current, { cost, discountAmount, discountReason }),
    [props.current, cost, discountAmount, discountReason],
  );

  const refusal = props.error;
  const confirmedDay = refusal?.reconciliation ?? null;
  const ready = reason.trim().length > 0 && !props.busy;

  return (
    <Sheet
      visible={props.visible}
      title={`Amend completion — ${props.jobNumber}`}
      onDismiss={props.onDismiss}
      testID={props.testID ?? 'amend-sheet'}
      actions={
        confirmedDay === null ? (
          <Button
            label="Amend — corrects the record"
            disabled={!ready}
            disabledReason="A reason is required."
            loading={props.busy}
            onPress={() =>
              props.onAmend({
                cost: cost.trim() === '' ? '0' : cost.trim(),
                discountAmount: discountAmount.trim() === '' ? '0' : discountAmount.trim(),
                discountReason: discountReason.trim(),
                reason: reason.trim(),
              })
            }
            fullwidth
            testID="amend-confirm"
          />
        ) : null
      }
    >
      {/* The comparison — current · new · the difference (§O4). */}
      <View testID="amend-comparison">
        <View style={[styles.compareRow, styles.compareHeader]}>
          <Text style={styles.compareLabel} />
          <Text style={[styles.compareHead, styles.colCurrent]}>Current</Text>
          <Text style={[styles.compareHead, styles.colNext]}>New</Text>
          <Text style={[styles.compareHead, styles.colDiff]}>Difference</Text>
        </View>
        {rows.map((row) => (
          <View key={row.key} style={styles.compareRow}>
            <Text style={styles.compareLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={[styles.compareCell, styles.colCurrent]} testID={`amend-current-${row.key}`} numberOfLines={1}>
              {row.current}
            </Text>
            <Text style={[styles.compareCell, styles.colNext]} testID={`amend-new-${row.key}`} numberOfLines={1}>
              {row.next}
            </Text>
            <Text
              style={[styles.compareCell, styles.colDiff, styles.compareDiff, row.difference === '—' ? null : styles.compareDiffMoved]}
              testID={`amend-diff-${row.key}`}
              numberOfLines={1}
            >
              {row.difference}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.fields}>
        <MoneyField label="Amount" value={cost} onChangeText={setCost} testID="amend-cost" />
        <MoneyField label="Discount" value={discountAmount} onChangeText={setDiscountAmount} testID="amend-discount" />
        <TextField
          label="Discount reason"
          value={discountReason}
          onChangeText={setDiscountReason}
          testID="amend-discount-reason"
        />
        <TextField
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Why is the record being corrected?"
          helperText="Required — the trail keeps the reason beside the change."
          multiline
          rows={3}
          testID="amend-reason"
        />
      </View>

      {refusal !== null && confirmedDay === null ? (
        <Text style={styles.error} testID="amend-error">
          {refusal.message}
        </Text>
      ) : null}

      {/* The two-step path out of a confirmed day: the refusal names the
      reconciliation, the reopen carries its own required reason, and
      Amend must still be pressed again afterwards. */}
      {confirmedDay !== null ? (
        <View style={styles.reopenBlock} testID="amend-reopen-offer">
          <Text style={styles.reopenTitle} testID="amend-reopen-title">
            Day signed off — reopen first
          </Text>
          <Text style={styles.reopenBody} testID="amend-reopen-message">
            {refusal?.message}
          </Text>
          <Text style={styles.reopenNamed} testID="amend-reopen-reconciliation">
            {`Reconciliation of ${confirmedDay.businessDate} · ${confirmedDay.status}`}
          </Text>
          <TextField
            label="Reopen reason"
            value={reopenReason}
            onChangeText={setReopenReason}
            placeholder="Why does this signed-off day need to reopen?"
            testID="amend-reopen-reason"
          />
          <Button
            label={`Reopen ${confirmedDay.businessDate}'s handover`}
            variant="secondary"
            disabled={reopenReason.trim().length === 0 || props.reopenBusy}
            disabledReason="A reason is required."
            loading={props.reopenBusy}
            onPress={() => props.onReopen(reopenReason.trim())}
            fullwidth
            testID="amend-reopen-confirm"
          />
          <Text style={styles.reopenHint} testID="amend-reopen-hint">
            Reopening does not amend — press Amend again once the day is open.
          </Text>
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  compareRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: SEMANTIC.line.default },
  compareHeader: { borderBottomWidth: 1 },
  compareHead: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  compareLabel: { ...textStyle('label'), color: SEMANTIC.text.primary, flex: 1.2, paddingRight: 8 },
  compareCell: { ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  compareDiff: { color: SEMANTIC.text.secondary },
  compareDiffMoved: { color: SEMANTIC.feedback.warning },
  colCurrent: { width: 96, textAlign: 'right' },
  colNext: { width: 96, textAlign: 'right' },
  colDiff: { width: 88, textAlign: 'right' },
  fields: { marginTop: SPACE[4], gap: SPACE[3] },
  error: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] },
  reopenBlock: {
    marginTop: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.feedback.warning,
    padding: SPACE[3],
    gap: SPACE[2],
  },
  reopenTitle: { ...textStyle('h2'), color: SEMANTIC.text.primary },
  reopenBody: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  reopenNamed: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  reopenHint: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
});
