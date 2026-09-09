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

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button } from '../components/ui';
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
    <ScrollView contentContainerStyle={styles.content} testID="consent-screen">
      <Text style={styles.heading}>Location tracking</Text>

      {LIMITS.map((limit) => (
        <View key={limit} style={styles.limit}>
          <View style={styles.dot} />
          <Text style={styles.limitText}>{limit}</Text>
        </View>
      ))}

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
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: SPACE[4],
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[4],
  },
  limit: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: SPACE[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: SEMANTIC.text.placeholder,
    marginTop: 7,
    marginRight: SPACE[3],
  },
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
  lastSentence: {
    ...textStyle('body'),
    fontWeight: '600',
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[6],
  },
  footer: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    textAlign: 'center',
    marginTop: SPACE[4],
  },
});
