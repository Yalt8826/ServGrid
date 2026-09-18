/**
 * The void sheet (§O5): **void lives here and only here** — reason
 * required, on both sales and payments. A rep who needs a sale reversed
 * asks; the owner's answer moves a balance backwards, so the reason is
 * the record of why. The submit stays disabled until the reason says
 * something — a void without a reason is a balance that moved for
 * nothing (the server's own rule, saleVoidSchema/paymentVoidSchema).
 *
 * Pure UI over injected deps; the routes own the POST.
 */
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, Sheet, TextField } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

export interface VoidReasonSheetProps {
  visible: boolean;
  /** What is being reversed, named on the sheet: "Sale SL-2627-00018". */
  subject: string;
  /** The money the reversal moves, if it is at hand. */
  amount?: string | null;
  busy: boolean;
  error: string | null;
  /** Must REJECT when the reversal is refused — the sheet keeps itself open
   * so the owner can correct the reason, and closes itself when it lands. */
  onConfirm: (reason: string) => Promise<void>;
  onDismiss: () => void;
  testID?: string;
}

export function VoidReasonSheet(props: VoidReasonSheetProps): React.ReactNode {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length > 0 && !props.busy;

  /**
   * The reversal closes its own form once it lands (2026-09-18, Yashas:
   * "after a record is done the form screen for any user closes
   * automatically"). Leaving that to the caller is the same trap the
   * payment form fell into — the owner's payments and sales screens both
   * passed an `onConfirm` that fired the POST and changed nothing about the
   * sheet, so a voided payment left the form sitting open over money that
   * had already reversed. A refusal keeps it open, with the server's words.
   */
  async function submit(): Promise<void> {
    if (!ready) return;
    try {
      await props.onConfirm(reason.trim());
    } catch {
      return;
    }
    props.onDismiss();
  }

  return (
    <Sheet
      visible={props.visible}
      title="Void"
      onDismiss={props.onDismiss}
      testID={props.testID ?? 'void-sheet'}
      actions={
        <Button
          label="Void — reverses the balance"
          variant="danger"
          disabled={!ready}
          disabledReason="A reason is required."
          loading={props.busy}
          onPress={() => void submit()}
          fullwidth
          testID="void-confirm"
        />
      }
    >
      <Text style={styles.subject} testID="void-subject">
        {props.subject}
      </Text>
      {props.amount != null ? (
        <Text style={styles.amount} testID="void-amount">
          {props.amount}
        </Text>
      ) : null}
      <TextField
        label="Reason"
        value={reason}
        onChangeText={setReason}
        placeholder="What happened?"
        helperText="Required — the ledger keeps the reason beside the reversal."
        multiline
        rows={3}
        testID="void-reason"
      />
      {props.error !== null ? (
        <Text style={styles.error} testID="void-error">
          {props.error}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  subject: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[1],
  },
  amount: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    marginBottom: SPACE[3],
  },
  error: {
    ...textStyle('caption'),
    color: SEMANTIC.feedback.danger,
    marginTop: SPACE[2],
  },
});
