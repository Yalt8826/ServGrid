/**
 * Money display for the rep's screens (UI/plan-2/06-SALES-REP.md §S1, §S4;
 * UI/plan-2/01-FOUNDATIONS.md §6). Three rules live here so no screen can
 * re-derive them differently:
 *
 * - **Figures cross-fade, never count up.** A money figure animating in
 *   front of a customer looks like a slot machine; a change plays as one
 *   140ms opacity fade (`DURATION.quick`) and lands on the whole value.
 *   `transform` is never applied to money (§9 — and a scale on a figure
 *   reads as emphasis this screen must not imply).
 * - **A negative balance is `Credit`, rendered in `feedback.success`.**
 *   An overpayment is good news and the schema permits it; it never
 *   renders as a minus sign in red. `creditView` is the one formatter,
 *   and it keeps the minus out of the string entirely — a screen that
 *   wants the sign back would have to come here and delete the rule.
 * - **Ledger amounts keep their signs** (`+ ₹16,800` / `− ₹40,000`) —
 *   documents show direction; only the *balance* uses the Credit rule.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Animated from 'react-native-reanimated';

import { DURATION, EASING, formatMoneyEnIN, SEMANTIC } from '@servgrid/shared';
import { staleInsetStyle } from '../../components/ui/uiBase';
import { textStyle } from '../../fonts/textStyle';

/** The figure cross-fade (§S1): `quick` — 140ms, opacity only. */
export const CROSSFADE_MS = DURATION.quick;

/**
 * Sum wire-format money strings exactly. Money crosses the wire as decimal
 * strings because a float loses cents; the sum is accumulated in integer
 * paise and formatted back, so `0.1 + 0.2` never happens here.
 */
export function sumMoney(amounts: readonly string[]): string {
  let paise = 0;
  for (const raw of amounts) {
    const cleaned = raw.replace(/[^0-9.-]/g, '');
    if (cleaned === '' || cleaned === '-') continue;
    paise += Math.round(Number(cleaned) * 100);
  }
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const int = String(Math.floor(abs / 100));
  const dec = String(abs % 100).padStart(2, '0');
  return dec === '00' ? `${sign}${int}` : `${sign}${int}.${dec}`;
}

/** True when the wire-format money string names money owed (positive). */
export function isPositiveMoney(raw: string): boolean {
  return Number(raw) > 0;
}

export function isNegativeMoney(raw: string): boolean {
  return Number(raw) < 0;
}

/**
 * How a balance renders (§S4). Negative → the word Credit in
 * `feedback.success`, value shown without any sign; zero and positive →
 * the plain figure in the primary text colour.
 */
export function creditView(balance: string): { text: string; color: string; credit: boolean } {
  if (Number(balance) < 0) {
    return {
      text: `Credit ₹${formatMoneyEnIN(balance.replace('-', ''))}`,
      color: SEMANTIC.feedback.success,
      credit: true,
    };
  }
  return { text: `₹${formatMoneyEnIN(balance)}`, color: SEMANTIC.text.primary, credit: false };
}

/**
 * A ledger amount's signed display (§S4): sales positive, payments
 * negative — `+ ₹16,800` / `− ₹40,000`. The ledger row's own concern;
 * `creditView` above is the balance's.
 */
export function ledgerAmountOf(kind: 'sale' | 'payment', amount: string): string {
  const magnitude = formatMoneyEnIN(amount.replace('-', ''));
  return kind === 'sale' ? `+ ₹${magnitude}` : `− ₹${magnitude}`;
}

/**
 * One money figure with the change motion (§S1): 140ms opacity fade to
 * the new value, never a count-up. With reduced motion the value flips
 * immediately — movement is removed, the information is not.
 *
 * `stale` carries the dashed inset plus the `Pending sync` caption
 * (03-COMPONENTS.md). No screen sets it since the app went online-only
 * (2026-09-15); the design system's stale state is retired in TON.4b.
 */
export function MoneyFigure({
  value,
  stale = false,
  testID,
}: {
  value: string;
  stale?: boolean;
  testID?: string;
}): React.ReactNode {
  const reduced = useReducedMotion();
  const fade = useSharedValue(1);
  const lastValue = useRef(value);

  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    if (reduced) {
      fade.value = 1;
      return;
    }
    // One fade to the whole new value. No numeric tween anywhere: the
    // text IS the value, only its opacity moves.
    fade.value = 0;
    fade.value = withTiming(1, {
      duration: CROSSFADE_MS,
      easing: Easing.bezier(EASING.standard[0], EASING.standard[1], EASING.standard[2], EASING.standard[3]),
    });
  }, [value, fade, reduced]);

  const style = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <View style={stale ? styles.staleInset : null} testID={stale ? `${testID}-stale` : testID}>
      <Animated.View style={style}>
        <Text style={styles.figure} testID={testID ? `${testID}-text` : undefined}>
          {value}
        </Text>
      </Animated.View>
      {stale ? (
        <Text style={styles.staleCaption} testID={testID ? `${testID}-pending` : undefined}>
          Pending sync
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  figure: {
    ...textStyle('display'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  staleCaption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginTop: 2,
  },
  staleInset: staleInsetStyle(),
});
