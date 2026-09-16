/**
 * The two ledger-row previews (owner, 2026-09-17) — the documents behind
 * a money row, reached by pressing it.
 *
 * One definition, three doors. The company page's ledger made every row
 * open its document, and the owner then asked for the same on the Sales
 * and Payments lists: a sale row shows the products sold, a payment row
 * shows the proof photo the rep captured. Those lists are the same
 * documents in a different arrangement, so they are the same sheets —
 * not a copy of them per screen.
 *
 * **The subject selects, the caller owns the load.** Each sheet takes the
 * row it is showing (`null` = closed) and the loader that resolves it, so
 * a screen's only state is which row is open. The sheet owns its own
 * loading, error and empty states: a slow read, a dead read and a
 * payment nobody photographed are three different things, and the sheet
 * that knows which one it is looking at is the only place that can say
 * so honestly.
 */
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import type { SaleRecord } from '@servgrid/shared';
import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Sheet } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
// The one definition of "how a line's discount reads" — the rep's own
// sale detail already spells it this way (SaleDetailScreen).
import { discountNoteOf } from '../rep/SaleDetailScreen';
import type { PaymentProof } from './useOwnerData';

/** What a sheet needs to name its subject: the id to load, the number to show. */
export interface PreviewSubject {
  id: string;
  /** The document's number — null while a sale is still a draft. */
  number: string | null;
}

/** The sale's products — the line items behind the document. */
export function SaleItemsSheet({
  sale,
  onLoad,
  onDismiss,
  testID = 'owner-sale-items-sheet',
}: {
  sale: PreviewSubject | null;
  onLoad: (saleId: string) => Promise<SaleRecord | null>;
  onDismiss: () => void;
  testID?: string;
}): React.ReactNode {
  const [record, setRecord] = useState<SaleRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const saleId = sale?.id ?? null;

  // Load on the ROW, not on the open: a second press on a different row
  // must resolve that row, and a dismissed sheet must not race a stale
  // reply back into view.
  useEffect(() => {
    if (saleId === null) {
      setRecord(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setRecord(null);
    void onLoad(saleId)
      .then((found) => {
        if (!alive) return;
        setRecord(found);
        setError(found === null ? 'That sale could not be found.' : null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'The sale could not be loaded.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [saleId, onLoad]);

  return (
    <Sheet
      visible={sale !== null}
      title={sale === null ? 'Sale' : `Sale ${sale.number ?? 'Draft'}`}
      onDismiss={onDismiss}
      testID={testID}
    >
      {error !== null ? (
        <Text style={styles.error} testID={`${testID}-error`}>
          {error}
        </Text>
      ) : loading ? (
        <Text style={styles.note} testID={`${testID}-loading`}>
          Reading the sale…
        </Text>
      ) : record !== null ? (
        <View>
          {record.items.map((item) => (
            <View key={item.lineNo} style={styles.itemRow} testID={`${testID}-item-${item.lineNo}`}>
              <View style={styles.itemMain}>
                <Text numberOfLines={2} style={styles.itemName}>
                  {item.productName}
                </Text>
                <Text style={styles.itemMeta}>
                  {`${item.productSku === null ? '' : `${item.productSku} · `}${item.quantity} × ₹${formatMoneyEnIN(item.unitPrice)}`}
                  {discountNoteOf(item)}
                </Text>
                {item.serialNumbers.length > 0 ? (
                  <Text style={styles.itemMeta}>{`SN ${item.serialNumbers.join(', ')}`}</Text>
                ) : null}
              </View>
              <Text style={styles.itemTotal}>{`₹${formatMoneyEnIN(item.lineTotal)}`}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue} testID={`${testID}-total`}>
              {`₹${formatMoneyEnIN(record.total)}`}
            </Text>
          </View>
          {record.notes !== null ? <Text style={styles.note}>{record.notes}</Text> : null}
        </View>
      ) : null}
    </Sheet>
  );
}

/** The payment's proof photo — the one piece of evidence a collection has. */
export function PaymentProofSheet({
  payment,
  onLoad,
  onDismiss,
  testID = 'owner-payment-proof-sheet',
}: {
  payment: PreviewSubject | null;
  onLoad: (paymentId: string) => Promise<PaymentProof | null>;
  onDismiss: () => void;
  testID?: string;
}): React.ReactNode {
  const [proof, setProof] = useState<PaymentProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const paymentId = payment?.id ?? null;

  useEffect(() => {
    if (paymentId === null) {
      setProof(null);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setProof(null);
    void onLoad(paymentId)
      .then((found) => {
        if (!alive) return;
        setProof(found);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'The proof photo could not be loaded.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [paymentId, onLoad]);

  return (
    <Sheet
      visible={payment !== null}
      title={payment === null ? 'Proof photo' : `Payment ${payment.number ?? ''}`.trim()}
      onDismiss={onDismiss}
      testID={testID}
    >
      {error !== null ? (
        <Text style={styles.error} testID={`${testID}-error`}>
          {error}
        </Text>
      ) : loading ? (
        <Text style={styles.note} testID={`${testID}-loading`}>
          Opening the photo…
        </Text>
      ) : proof === null ? (
        <Text style={styles.note} testID={`${testID}-empty`}>
          No proof photo was attached to this payment.
        </Text>
      ) : (
        <Image source={{ uri: proof.url }} resizeMode="contain" style={styles.proof} testID={`${testID}-image`} />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  note: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
  error: {
    ...textStyle('body'),
    color: SEMANTIC.feedback.danger,
    paddingVertical: SPACE[2],
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  itemMain: { flex: 1, gap: 2 },
  itemName: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  itemMeta: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  itemTotal: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: SPACE[3],
  },
  totalLabel: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  totalValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  proof: {
    width: '100%',
    height: 420,
    borderRadius: 4,
    backgroundColor: SEMANTIC.bg.dense,
  },
});
