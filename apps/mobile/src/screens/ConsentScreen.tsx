/**
 * Consent — location tracking (UI/plan-2/08-SHARED-SCREENS.md §X3).
 * The highest-stakes copy in the product: it decides whether the app is
 * experienced as something done WITH staff or TO them.
 *
 * Copy rules carried out here: the limits come before the capability
 * (the hours before the tracking); the last sentence before the button
 * says plainly what is NOT collected; no legalese, no scroll-to-accept,
 * no pre-ticked box. There is no Decline button — a fake choice is
 * worse than an honest requirement — and the screen is not dismissible
 * (hardware back included). What it does NOT do is gate the app: a
 * technician who never accepts still sees his jobs; background tracking
 * simply never starts and his health chip reads `permission_missing`
 * (PLAN-BACKEND.md §4) — a conversation between two people, not a
 * lockout administered by software.
 *
 * The version comes from this login's response (PLAN-BACKEND.md §4) and
 * is posted back verbatim; the server refuses anything but the current
 * copy, because evidence a stale client labels is not evidence.
 */
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';

import { COLORS, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Banner, Button } from '../components/ui';
import { Icon } from '../components/ui/icons';
import { textStyle } from '../fonts/textStyle';
import type { ApiClient } from '../lib/apiClient';

/** The one consent kind that exists (migration 002 / `CONSENT_KINDS`). */
const KIND = 'location_tracking' as const;

/** The limits, in order — hours before tracking (§X3 copy rules). */
const LIMITS = [
  'Monday to Saturday, 09:00 – 19:00',
  'About once every 15 minutes',
  'A notification stays visible while tracking is on',
  'Never outside those hours',
  'Kept for 180 days, then deleted',
];

const CAPABILITY =
  'ServGrid records your location while you are working, so the office can see which jobs are covered.';

/** The sentence that makes the rest credible — what is NOT collected. */
const LAST_SENTENCE =
  'Your manager can see where you are during work hours. Nobody can see where you are outside them.';

const FOOTER =
  'Tracking is part of the job. If you have questions, talk to the owner before accepting.';

export interface ConsentScreenProps {
  api: ApiClient;
  /** The copy version this login was told to present. */
  version: string;
  onAccepted: () => void;
}

/**
 * The banner sentence for a refused acceptance: the server's message
 * verbatim (§X5 — the backend owns this copy; e.g. a stale client is
 * told to reload the consent screen), or a plain fallback when the
 * failure carries no readable message.
 */
export function consentErrorBanner(
  error: { code: string; message: string; requestId?: string } | null,
): string {
  return error?.message ?? 'The acceptance could not be recorded. Try again.';
}

export function ConsentScreen({ api, version, onAccepted }: ConsentScreenProps): React.ReactNode {
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  // Not dismissible — but what backing out actually withholds is
  // tracking, never the app, and closing the app is not a refusal the
  // server records. Acceptance is the only button.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, []);

  async function accept(): Promise<void> {
    if (pending) return;
    setPending(true);
    setBanner(null);
    try {
      const result = await api.request('POST', '/v1/consents', {
        body: { kind: KIND, version },
      });
      if (result.ok) {
        onAccepted();
      } else {
        setBanner(consentErrorBanner(result.error));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="consent-screen"
    >
      {/* The frame (2026-09-17): the shield names the subject — location —
          before any of the five promises is read. */}
      <View style={styles.frame}>
        <View style={styles.frameMark}>
          <Icon name="shield" size={ICON.md} color={FRAME.text} />
        </View>
        <View style={styles.frameBody}>
          <Text style={styles.frameTitle}>Location tracking</Text>
          <Text style={styles.frameCaption}>What ServGrid does — and does not do</Text>
        </View>
      </View>

      <View style={styles.limits}>
        {LIMITS.map((limit, index) => (
          <View key={limit} style={[styles.limit, index === 0 ? null : styles.limitNext]}>
            <Icon name="shield" size={ICON.sm} color={SEMANTIC.feedback.success} />
            <Text style={styles.limitText}>{limit}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.capability}>{CAPABILITY}</Text>
      <Text style={styles.lastSentence}>{LAST_SENTENCE}</Text>

      {banner !== null ? (
        <Banner tone="danger" message={banner} testID="consent-banner" />
      ) : null}

      <Button
        label="I understand"
        onPress={() => void accept()}
        loading={pending}
        fullwidth
        testID="consent-accept"
      />
      <Text style={styles.footer}>{FOOTER}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  /** The page's own ground on the scroll itself (2026-09-16's stripe
   * lesson): the five promises are short, and the ground must not change
   * where they end. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    flexGrow: 1,
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
    paddingBottom: SPACE[6],
  },
  /** The frame: what is being agreed to, under the shield — consent is
   * about location, and the mark says so before the words. */
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    backgroundColor: FRAME.bg,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[4],
    paddingVertical: SPACE[4],
    marginBottom: SPACE[4],
  },
  frameMark: {
    width: 44,
    height: 44,
    borderRadius: RADII.control,
    backgroundColor: FRAME.bgSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameBody: { flex: 1 },
  frameTitle: { ...textStyle('h2'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** What tracking will NOT do: a panel of shield-checked lines, so the
   * promises read as the list they are. */
  limits: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  limit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.min - 8,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  limitNext: { borderTopWidth: 1, borderTopColor: SEMANTIC.line.default },
  limitText: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  capability: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    marginTop: SPACE[4],
    marginBottom: SPACE[3],
  },
  /** The one sentence that must survive a skim: the accent rail, the way
   * the console marks the rows it needs acted on. */
  lastSentence: {
    borderLeftWidth: 4,
    borderLeftColor: COLORS.accent,
    paddingLeft: SPACE[3],
    paddingVertical: SPACE[2],
    marginBottom: SPACE[6],
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  footer: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    textAlign: 'center',
    marginTop: SPACE[4],
  },
});
