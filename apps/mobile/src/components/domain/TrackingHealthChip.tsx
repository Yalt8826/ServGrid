/**
 * `TrackingHealthChip` (PLAN-FRONTEND.md §6, UI/plan-2/04-TECHNICIAN.md
 * §T7). Four states, all rendered from the real view data of
 * `GET /v1/location/health/me` (`v_employee_tracking_health`, migration
 * 009) — never from a stored "last known good":
 *
 * | State | Text | View value |
 * |---|---|---|
 * | green | "Tracking active · last ping 6 min ago" | `active` |
 * | amber | "Last ping 2h ago" | `stale` — older than 45 min |
 * | red   | "Background permission missing — fix" | `permission_missing` / `never_reported` |
 * | amber | "Job alerts off — you won't be told about new jobs" | `notifications_enabled = false` |
 *
 * The fourth state is the notification permission riding on the one chip
 * that is already looked at (§6): a separate chip would be a second thing
 * nobody looks at. When several states apply the more severe wins —
 * broken tracking before slow tracking before quiet alerts — because the
 * chip answers "is tracking working", and a technician sent to fix
 * autostart while his background permission is gone has been lied to by
 * precedence.
 *
 * Red and amber are tappable and deep-link into the permission ladder at
 * the failed step (§6). Green is not tappable: there is nothing to fix.
 *
 * **Never animate the chip.** No reanimated import, no shared value, no
 * press scale — a pulsing red chip would run continuously on the device
 * whose battery this app is trying to protect. `profile.test.tsx` holds
 * that line: it walks the rendered subtree and fails on any animation
 * driver.
 */
import { Pressable, Text, View } from 'react-native';

import type { TrackingHealth } from '@servgrid/shared';
import { alpha, ICON, RADII, SEMANTIC, TINT } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Icon, type IconName } from '../ui/icons';

/** Where a tap on the chip lands in the permission ladder. `1`–`4` are
 * the ladder's steps; `'notifications'` is the ask that follows them. */
export type LadderTarget = 1 | 2 | 3 | 4 | 'notifications';

export type ChipTone = 'good' | 'warn' | 'bad';

export interface ChipView {
  tone: ChipTone;
  text: string;
  /** Non-null exactly when the chip is tappable: the step to fix. */
  fixTo: LadderTarget | null;
}

/** §6's examples, made general: "6 min ago", "2h ago". */
export function formatLastPing(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** The first ladder step that can be failing, given the reported
 * permission. The ladder itself re-probes OS truth and opens wherever
 * the work actually is — this hint only orients the link. */
export function stepForPermission(permission: TrackingHealth['locationPermission']): Extract<LadderTarget, number> {
  if (permission === 'background') return 3; // granted — the usual silent killers are battery/autostart
  if (permission === 'foreground') return 2;
  return 1;
}

/**
 * The four states, in severity order. `not_tracked` cannot occur for a
 * tracked role (the view reserves it for owner/dispatcher), but the chip
 * degrades to red rather than pretending — silent degradation is the
 * failure mode this project treats as the enemy.
 */
export function chipViewOf(health: TrackingHealth): ChipView {
  if (
    health.health === 'permission_missing' ||
    health.health === 'never_reported' ||
    health.health === 'not_tracked'
  ) {
    // §6's red text is exact while the permission really is missing; a
    // background grant that still never reports gets honest copy of its
    // own — sending him to re-grant a permission he has is a lie.
    if (health.health === 'permission_missing') {
      return { tone: 'bad', text: 'Background permission missing — fix', fixTo: stepForPermission(health.locationPermission) };
    }
    if (health.health === 'never_reported') {
      return { tone: 'bad', text: 'Tracking has never reported — fix', fixTo: stepForPermission(health.locationPermission) };
    }
    return { tone: 'bad', text: 'Tracking is not set up on this phone — fix', fixTo: 1 };
  }
  if (health.health === 'stale') {
    const since = health.minutesSince === null ? '' : `Last ping ${formatLastPing(health.minutesSince)}`;
    return {
      tone: 'warn',
      text: since === '' ? 'Tracking has not reported recently — fix' : since,
      fixTo: stepForPermission(health.locationPermission),
    };
  }
  if (health.notificationsEnabled === false) {
    return { tone: 'warn', text: 'Job alerts off — you won’t be told about new jobs', fixTo: 'notifications' };
  }
  const since = health.minutesSince === null ? '' : ` · last ping ${formatLastPing(health.minutesSince)}`;
  return { tone: 'good', text: `Tracking active${since}`, fixTo: null };
}

const TONE_COLOR = {
  good: SEMANTIC.feedback.success,
  warn: SEMANTIC.feedback.warning,
  bad: SEMANTIC.feedback.danger,
} as const;

/**
 * The tone's own glyph, so the chip is legible before the sentence is
 * read: a tick means there is nothing to do, a triangle means there is.
 * The copy still says which — the glyph is never the whole message.
 */
const TONE_ICON: Record<ChipTone, IconName> = {
  good: 'checkFilled',
  warn: 'warning',
  bad: 'warning',
};

export interface TrackingHealthChipProps {
  /** The row `GET /v1/location/health/me` returned — real view data. */
  health: TrackingHealth;
  /** Red and amber only; never wired for green. */
  onFix?: (target: LadderTarget) => void;
  testID?: string;
}

export function TrackingHealthChip({ health, onFix, testID }: TrackingHealthChipProps): React.ReactNode {
  const view = chipViewOf(health);
  const tappable = view.fixTo !== null && onFix !== undefined;
  const tone = TONE_COLOR[view.tone];

  const body = (
    <>
      <Icon name={TONE_ICON[view.tone]} size={ICON.md} color={tone} />
      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }} testID={testID ? `${testID}-text` : undefined}>
        {view.text}
      </Text>
      {tappable ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Text style={{ ...textStyle('label'), color: SEMANTIC.text.primary, fontWeight: '600' }}>Fix</Text>
          <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
        </View>
      ) : null}
    </>
  );

  return (
    <View
      testID={testID}
      style={{
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: RADII.control,
        borderWidth: 1,
        // The tone as a tinted ground, one step firmer than the chip's own
        // (this strip is a whole row, not a label). The tint is a ground
        // only: the sentence stays slate.900 — see StatusPill's note.
        borderColor: alpha(tone, TINT.chipLine),
        backgroundColor: alpha(tone, TINT.wash + TINT.band),
      }}
    >
      {tappable ? (
        <Pressable
          accessibilityRole="button"
          testID={testID ? `${testID}-fix` : undefined}
          onPress={() => {
            if (view.fixTo !== null) onFix?.(view.fixTo);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}
