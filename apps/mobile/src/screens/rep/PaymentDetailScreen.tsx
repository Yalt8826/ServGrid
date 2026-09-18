/**
 * Payment detail (§S3 read side, field feedback 2026-09-14): the way the
 * money moved — number, company, amount, mode, the day and moment it was
 * collected, which sale it settled (or on-account), status and notes.
 * Pure over injected data; the route owns the reads.
 *
 * **The moment is pinned to IST rather than the handset's zone**
 * (2026-09-18). It was `new Date(receivedAt).toLocaleString('en-IN')`,
 * which is correct on a phone set to IST — so nothing on the walk was
 * actually wrong — but it is the handset that decided, and every other
 * instant in this app is rendered through an IST helper
 * (`istTimeLabel`, `istDateKey`) precisely so a device in another zone
 * cannot re-date the business's money. This page was the one place that
 * left the question to the phone. The shape also becomes the app's own:
 * a 24-hour clock and no seconds.
 *
 * **The house dress, same day** — the last screen in the rep's app without
 * it: the navy frame carries the number and the status as a tinted chip,
 * the amount is the largest figure on screen in its own accent-railed
 * panel, and the details sit in a bordered panel under a section marker —
 * the account ledger's shape, so the two money screens read as kin.
 */
import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PaymentRecord } from '@servgrid/shared';
import { alpha, COLORS, formatMoneyEnIN, FRAME, RADII, SEMANTIC, SPACE, TINT } from '@servgrid/shared';
import { SectionHeader, formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { istDateKey, istTimeLabel } from '../technician/jobView';

export const PAYMENT_DETAIL_MODE_LABEL: Record<PaymentRecord['mode'], string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  cheque: 'Cheque',
  bank_transfer: 'Bank transfer',
};

export const PAYMENT_DETAIL_STATUS: Record<PaymentRecord['status'], { label: string; color: string }> = {
  collected: { label: 'Collected', color: SEMANTIC.feedback.success },
  void: { label: 'Void', color: SEMANTIC.feedback.danger },
};

/**
 * `14 Sep, 22:26` — the IST day and clock of a collection, whatever zone
 * the handset is in. The clock is 24-hour, the app's own time shape
 * (`istTimeLabel`), so this page and the job cards read alike.
 */
export function collectedAtLabel(receivedAt: string): string {
  const day = istDateKey(receivedAt);
  const year = Number(day.slice(0, 4));
  return `${formatDateEnIN(day, year)}, ${istTimeLabel(receivedAt)}`;
}

export interface PaymentDetailScreenProps {
  payment: PaymentRecord | null;
  companyName: string | null;
  /** The settled sale's number, resolved by the route; null = on account. */
  againstSaleNumber: string | null;
  loading: boolean;
  error: string | null;
  /**
   * The proof photo's short-lived URL, or null when the payment carries
   * none (2026-09-18 — Yashas: "on the sales rep user i click on payment
   * details it does not show the picture captured and sent during the
   * record being made"). A dep seam like every read on this screen: the
   * route owns the call, so the screen renders and tests without a device.
   * Left undefined the section is absent entirely.
   */
  loadProof?: () => Promise<string | null>;
  onRetry: () => void;
  testID?: string;
}

/** One labelled fact, on the panel's hairline row. */
function Row({ label, value, testID }: { label: string; value: string; testID?: string }): React.ReactNode {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function PaymentDetailScreen(props: PaymentDetailScreenProps): React.ReactNode {
  const loadProof = props.loadProof;
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofState, setProofState] = useState<'idle' | 'loading' | 'ready' | 'none' | 'error'>('idle');
  const [proofError, setProofError] = useState<string | null>(null);
  const paymentId = props.payment?.id ?? null;

  // Loaded on the ROW, not on a press: the proof is evidence the payment
  // happened, and a receipt you have to go looking for is one nobody
  // checks. A 5-minute presigned URL (§9) means this is fetched per visit.
  useEffect(() => {
    if (loadProof === undefined || paymentId === null) return;
    let alive = true;
    setProofState('loading');
    setProofError(null);
    void loadProof()
      .then((url) => {
        if (!alive) return;
        setProofUrl(url);
        setProofState(url === null ? 'none' : 'ready');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setProofError(e instanceof Error ? e.message : 'The proof photo could not be loaded.');
        setProofState('error');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId, loadProof]);

  if (props.loading) {
    return (
      <View style={styles.center} testID="payment-detail-loading">
        <Text style={styles.secondary}>Loading…</Text>
      </View>
    );
  }
  if (props.error !== null || props.payment === null) {
    return (
      <View style={styles.center} testID="payment-detail-missing">
        <Text style={styles.secondary}>
          {props.error ?? "We couldn't find that payment — it may be on another rep's accounts."}
        </Text>
      </View>
    );
  }

  const payment = props.payment;
  const status = PAYMENT_DETAIL_STATUS[payment.status];
  const nowYear = new Date().getFullYear();

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID={props.testID ?? 'payment-detail'}
    >
      {/* The frame: which payment, and where it stands — the number a
          customer reads out, the word the office files it under. */}
      <View style={styles.frame}>
        <View style={styles.frameHead}>
          <View style={styles.frameBody}>
            <Text style={styles.frameTitle} testID="payment-detail-title">
              {payment.paymentNumber}
            </Text>
            <Text style={styles.frameCaption}>
              {`${PAYMENT_DETAIL_MODE_LABEL[payment.mode]} · ${formatDateEnIN(payment.businessDate, nowYear)}`}
            </Text>
          </View>
          {/* The status as a tinted chip — the dot keeps the status ink,
              the word the meaning, the tint only a ground. */}
          <View
            testID="payment-detail-status"
            style={[
              styles.statusChip,
              {
                borderColor: alpha(status.color, TINT.chipLine),
                backgroundColor: alpha(status.color, TINT.chip),
              },
            ]}
          >
            <View style={[styles.statusDot, { backgroundColor: status.color }]} />
            <Text style={styles.statusText}>{status.label}</Text>
          </View>
        </View>
      </View>

      <View style={styles.body}>
        {/* The figure, on the accent rail — the one number this page exists
            to show, at display size like the ledger's balance. */}
        <View style={styles.amountCard} testID="payment-detail-amount-card">
          <View style={styles.amountRail} />
          <View style={styles.amountBody}>
            <Text style={styles.amountValue}>{`₹${formatMoneyEnIN(payment.amount)}`}</Text>
            <Text style={styles.secondary}>Counted toward the balance.</Text>
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeader label="Details" icon="document" />
        </View>
        <View style={styles.panel}>
          <Row label="Company" value={props.companyName ?? '—'} testID="payment-detail-company" />
          <View style={styles.rowRule} />
          <Row
            label="Against"
            value={props.againstSaleNumber ?? 'On account'}
            testID="payment-detail-against"
          />
          <View style={styles.rowRule} />
          <Row
            label="Collected at"
            value={collectedAtLabel(payment.receivedAt)}
            testID="payment-detail-collected-at"
          />
          {payment.referenceNo !== null ? (
            <>
              <View style={styles.rowRule} />
              <Row label="Reference" value={payment.referenceNo} />
            </>
          ) : null}
        </View>

        {loadProof === undefined ? null : (
          <>
            <View style={styles.section}>
              <SectionHeader label="Proof photo" icon="camera" />
            </View>
            {proofState === 'loading' ? (
              <Text style={styles.secondary} testID="payment-detail-proof-loading">
                Opening the photo…
              </Text>
            ) : proofState === 'error' ? (
              <Text style={[styles.secondary, styles.voidText]} testID="payment-detail-proof-error">
                {proofError}
              </Text>
            ) : proofState === 'ready' && proofUrl !== null ? (
              // The bytes are never proxied: the URL is the store's own,
              // signed for five minutes (§9).
              <Image
                source={{ uri: proofUrl }}
                resizeMode="contain"
                style={styles.proof}
                testID="payment-detail-proof"
              />
            ) : (
              // Said plainly, and only once the read has answered: a payment
              // recorded without a photo is a real state (the picker is a
              // seam), not an error.
              <Text style={styles.secondary} testID="payment-detail-proof-none">
                No proof photo was attached to this payment.
              </Text>
            )}
          </>
        )}

        {payment.notes !== null ? (
          <>
            <View style={styles.section}>
              <SectionHeader label="Notes" icon="document" />
            </View>
            <Text style={styles.secondary}>{payment.notes}</Text>
          </>
        ) : null}

        {payment.voidReason !== null ? (
          <>
            <View style={styles.section}>
              <SectionHeader label="Voided" icon="document" tint={SEMANTIC.feedback.danger} />
            </View>
            <Text style={[styles.secondary, styles.voidText]}>{payment.voidReason}</Text>
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: SEMANTIC.bg.app },
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingTop: SPACE[2],
    paddingBottom: SPACE[8],
  },
  /** The navy frame, bleeding to the screen's edges — the route paints
   * the same slate behind the status bar. */
  frame: {
    alignSelf: 'stretch',
    backgroundColor: FRAME.bg,
    // Bleeds 16 past the screen each side and pads 32 back in — this
    // page's content container carries no gutter of its own (the body
    // does), so the frame must return its own: 32 − 16 = the 16dp gutter.
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4] * 2,
    paddingTop: SPACE[4],
    paddingBottom: SPACE[3],
  },
  frameHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE[3] },
  frameBody: { flex: 1, gap: 2 },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** The day's state, as a tinted chip (the StatusPill arithmetic). */
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[2],
    paddingVertical: 3,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { ...textStyle('label'), color: FRAME.text },
  /** The page's gutter under the full-bleed frame. */
  body: { paddingHorizontal: SPACE[4], paddingTop: SPACE[2], gap: SPACE[2] },
  /** The one number, on the accent rail — the invoice panel's shape. */
  amountCard: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
    marginTop: SPACE[1],
  },
  amountRail: { width: 4, backgroundColor: COLORS.accent },
  amountBody: { flex: 1, padding: SPACE[3], gap: 2 },
  amountValue: {
    ...textStyle('display'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  section: { marginTop: SPACE[3], marginBottom: SPACE[1] },
  panel: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[1],
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE[3],
    paddingVertical: SPACE[2],
  },
  rowRule: { height: 1, backgroundColor: SEMANTIC.line.default },
  fieldLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  rowValue: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    textAlign: 'right',
    flexShrink: 1,
  },
  secondary: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  /** The photo, contained in a fixed box — the owner's proof sheet size, so
   * a tall picture cannot push the figures off the page. */
  proof: {
    width: '100%',
    height: 420,
    borderRadius: 4,
    backgroundColor: SEMANTIC.bg.dense,
  },
  voidText: { color: SEMANTIC.feedback.danger },
});
