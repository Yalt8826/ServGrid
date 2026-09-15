/**
 * T7 Profile (UI/plan-2/04-TECHNICIAN.md §T7, PLAN-FRONTEND.md §5, §6).
 * Purpose: prove tracking works, and fix it when it does not. Worst
 * moment: the owner has just asked why his location stopped updating at
 * 11:00.
 *
 * Anatomy: name, role, username · the `TrackingHealthChip`, prominent ·
 * the permission ladder as four rows with individual state · app
 * version, device model · *Change password* · *Log out*.
 *
 * **Logout is one tap.** The app is online-only (decision 2026-09-15):
 * nothing is ever queued on the phone, so there is nothing to lose and no
 * gate to pass — and no dialog exists on this screen.
 *
 * Motion (§T7): a ladder row that resolves — a permission granted on
 * return from settings — plays the one celebratory beat the role earns:
 * a 140ms colour change and a checkmark scale-in. Rows at rest do not
 * move; the initial render shows the state as it is. The chip never
 * animates (see `TrackingHealthChip`).
 *
 * **Not on this screen:** no earnings, no performance stats, no ranking
 * of technicians against each other — `PLAN.md` §11 names employee
 * reaction to tracking as a live risk, and gamified surveillance is the
 * fastest way to realise it.
 *
 * Pure UI over injected seams (`ProfileDeps`); the route file owns the
 * OS probes, the router and the session, exactly as the ladder route
 * does.
 */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import type { TrackingHealth } from '@servgrid/shared';
import { DURATION, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Button } from '../../components/ui';
import { TrackingHealthChip, type LadderTarget } from '../../components/domain/TrackingHealthChip';
import { textStyle } from '../../fonts/textStyle';
import { useToggleProgress } from '../../components/ui/motion';

// ── the ladder rows ───────────────────────────────────────────────────────

export type LadderStep = 1 | 2 | 3 | 4;

/** One permission-ladder row with its individual state (§T7). The route
 * judges OS truth — the same source the ladder itself resumes by — never
 * a stored "where was I" that can lie. */
export interface LadderRowState {
  step: LadderStep;
  /** "Location while using" · "Location all the time" · "Battery
   * optimisation" · "Xiaomi autostart" (vendor-detected). */
  title: string;
  /** "Granted" · "Exempt" · "Not confirmed". */
  stateText: string;
  done: boolean;
}

export interface ProfileDeps {
  username: string;
  /** Display role, e.g. "Technician". */
  role: string;
  appVersion: string;
  deviceModel: string;
  /** The self-scoped health read (`GET /v1/location/health/me`). */
  loadHealth: () => Promise<TrackingHealth>;
  /** The four ladder rows, judged by OS truth. */
  loadLadderRows: () => Promise<LadderRowState[]>;
  /** The route owns the session end. */
  logout: () => void;
  /** Red/amber chip taps and row *Fix* buttons. The route navigates to
   * the ladder, which opens at the failed step by its own probe. */
  openLadder: (target: LadderTarget) => void;
  changePassword: () => void;
  /** Foreground-return subscription — rows re-probe when he comes back
   * from Settings, and a newly-resolved row plays the beat. */
  subscribeForeground?: (listener: () => void) => () => void;
}

/** The checkmark's celebratory beat (§T7): a 140ms colour change and a
 * scale-in when a row resolves on return from settings. The initial
 * paint shows the state as it is — `useToggleProgress` starts at the
 * current truth, so only a *change* tweens. The circle scales from 0
 * when pending (the ⚠ stands in its slot); transform and opacity only
 * (§9 — nothing here relayouts). */
function RowCheck({ done }: { done: boolean }): React.ReactNode {
  const progress = useToggleProgress(done, DURATION.quick);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: progress.value }],
    backgroundColor: interpolateColor(progress.value, [0, 1], [SEMANTIC.bg.dense, SEMANTIC.feedback.success]),
  }));
  return (
    <View style={styles.checkSlot} testID={done ? 'ladder-row-check' : 'ladder-row-pending'}>
      <Animated.View style={[styles.check, style]}>
        <Text style={styles.checkGlyph}>✓</Text>
      </Animated.View>
      {!done ? <Text style={styles.pendingGlyph}>⚠</Text> : null}
    </View>
  );
}

export function ProfileScreen(deps: ProfileDeps): React.ReactNode {
  const [health, setHealth] = useState<TrackingHealth | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [rows, setRows] = useState<LadderRowState[] | null>(null);

  // Resolve-into-state, never a loading spinner for content this screen
  // can show honestly without: the name degrades to the username, the
  // chip area says it cannot see tracking right now.
  useEffect(() => {
    let alive = true;
    deps
      .loadHealth()
      .then((h) => {
        if (alive) {
          setHealth(h);
          setHealthUnavailable(false);
        }
      })
      .catch(() => {
        if (alive) setHealthUnavailable(true);
      });
    deps
      .loadLadderRows()
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return from Settings: re-probe. A row flipping to done is what plays
  // the beat — RowCheck animates the change, not the initial paint.
  const rowsLoader = useRef(() => {
    deps
      .loadLadderRows()
      .then((r) => setRows(r))
      .catch(() => {});
  });
  useEffect(() => {
    if (deps.subscribeForeground === undefined) return;
    return deps.subscribeForeground(() => rowsLoader.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = health?.employeeName ?? deps.username;

  return (
    <ScrollView contentContainerStyle={styles.content} testID="profile-screen">
      <Text style={styles.heading} testID="profile-name">
        {name}
      </Text>
      <Text style={styles.caption} testID="profile-role">
        {`${deps.role} · ${deps.username}`}
      </Text>

      {/* Prominent, always visible (§T7). Never animated. */}
      <View style={styles.chipBlock} testID="profile-health-chip">
        {health !== null ? (
          <TrackingHealthChip health={health} onFix={deps.openLadder} testID="tracking-chip" />
        ) : healthUnavailable ? (
          <Text style={styles.unavailable} testID="profile-health-unavailable">
            Tracking status is unavailable right now.
          </Text>
        ) : null}
      </View>

      <Text style={styles.sectionLabel}>Tracking permissions</Text>
      {(rows ?? []).map((row) => (
        <View key={row.step} style={styles.ladderRow} testID={`profile-ladder-row-${row.step}`}>
          <RowCheck done={row.done} />
          <Text style={styles.ladderTitle}>{row.title}</Text>
          <Text
            style={[styles.ladderState, { color: row.done ? SEMANTIC.text.secondary : SEMANTIC.feedback.warning }]}
          >
            {row.stateText}
          </Text>
          {!row.done ? (
            <Button
              label="Fix"
              variant="secondary"
              onPress={() => deps.openLadder(row.step)}
              testID={`profile-ladder-fix-${row.step}`}
            />
          ) : null}
        </View>
      ))}

      <Text style={styles.sectionLabel}>This phone</Text>
      <View style={styles.infoRow} testID="profile-app-version">
        <Text style={styles.infoLabel}>App version</Text>
        <Text style={styles.infoValue}>{deps.appVersion}</Text>
      </View>
      <View style={styles.infoRow} testID="profile-device-model">
        <Text style={styles.infoLabel}>Device model</Text>
        <Text style={styles.infoValue}>{deps.deviceModel}</Text>
      </View>

      <View style={styles.actions}>
        <Button label="Change password" variant="secondary" onPress={deps.changePassword} fullwidth testID="profile-change-password" />

        <Button label="Log out" variant="danger" onPress={deps.logout} fullwidth testID="profile-logout" />
      </View>
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
  chipBlock: {
    alignSelf: 'stretch',
    marginBottom: SPACE[5],
    minHeight: TAP.min,
  },
  unavailable: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[2],
  },
  ladderRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TAP.min,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  check: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkGlyph: {
    ...textStyle('label'),
    color: SEMANTIC.text.onDark,
  },
  ladderTitle: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
  ladderState: {
    ...textStyle('label'),
  },
  infoRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  infoLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  infoValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    alignSelf: 'stretch',
    gap: SPACE[3],
    marginTop: SPACE[5],
  },
  checkSlot: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingGlyph: {
    ...textStyle('h2'),
    color: SEMANTIC.feedback.warning,
  },
});
