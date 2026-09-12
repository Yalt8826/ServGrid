/**
 * `TechnicianLoadRow` (03-COMPONENTS.md, UI/plan-2/05-DISPATCHER.md §D1).
 * One row: name (`body`) · load count (`mono`, tabular) · **inline load
 * bar** · availability — with the tracking-health warning rendered inline
 * when his device went quiet, because the dispatcher is the person who
 * will actually notice.
 *
 * This is the SHARED half of the assignment picker (`TechnicianPicker`,
 * T2.9) and the dashboard's TECHNICIAN LOAD list (T2.7): one component,
 * so the dispatcher reads one visual language for "who is busy"
 * everywhere (§D1). The bar is the decision-support — relative load is
 * legible before any number is read (PLAN.md §8) — so its width is a
 * fraction of the busiest technician in the list, never an absolute.
 *
 * Motion (02-MOTION.md §5.5): on focus the bars draw from zero, left to
 * right, staggered 30ms apart, 260ms each, `enter` — the one place
 * stagger is allowed outside the stepper, because the *comparison* is
 * the decision. `draw=false` renders the final bar (past the first
 * focus, and under the reduced-motion seam).
 *
 * The health column reads `location.health` ONLY (PLAN-BACKEND.md §5):
 * a health value and the last-ping age. No coordinate exists in this
 * component's props, and none may — the dispatcher's tree is checked
 * for coordinates in dashboard.test.tsx and in the money-leak suite's
 * roster walk.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../ui/motion';/** The `v_employee_tracking_health` health values, as the wire spells them. */
export type TrackingHealthValue = 'not_tracked' | 'permission_missing' | 'never_reported' | 'stale' | 'active';

export interface TechnicianHealthState {
  health: TrackingHealthValue;
  /** Age of the last ping in minutes; null when he has never reported. */
  minutesSince: number | null;
}

export interface TechnicianLoadRowProps {
  name: string;
  /** The count the mono figure and the bar both show (open jobs). */
  load: number;
  /** The busiest load in the list — the bar is a fraction of it. */
  maxLoad: number;
  /** His tracking health, when the roster read answered; null = unknown. */
  health?: TechnicianHealthState | null;
  /** Draw the bar on focus (staggered by `index`); false = already drawn. */
  draw?: boolean;
  index?: number;
  testID?: string;
}

const DRAW_MS = 260;
const STAGGER_MS = 30;
const BAR_HEIGHT = 4;

/** The last-ping age in words — the `location.health` read's whole point. */
function ageLabel(minutesSince: number | null): string {
  if (minutesSince === null) return 'never reported';
  if (minutesSince < 60) return `last ping ${minutesSince}m ago`;
  const hours = Math.floor(minutesSince / 60);
  const minutes = minutesSince % 60;
  return minutes === 0 ? `last ping ${hours}h ago` : `last ping ${hours}h ${minutes}m ago`;
}

export function TechnicianLoadRow({
  name,
  load,
  maxLoad,
  health = null,
  draw = true,
  index = 0,
  testID,
}: TechnicianLoadRowProps): React.ReactNode {
  const enter = easing(EASING.enter);
  const progress = useSharedValue(draw ? 0 : 1);

  useEffect(() => {
    if (!draw) return;
    progress.value = withDelay(index * STAGGER_MS, withTiming(1, { duration: DRAW_MS, easing: enter }));
  }, [draw, enter, index, progress]);

  // Relative to the busiest row: a list where everyone is at three must
  // not read as "half busy" (PLAN.md §8 — the bar is the comparison).
  const fraction = maxLoad > 0 ? Math.min(1, load / maxLoad) : 0;
  const barStyle = useAnimatedStyle(() => ({ width: `${Math.round(progress.value * fraction * 100)}%` }));

  const stale = health !== null && (health.health === 'stale' || health.health === 'never_reported');
  const blocked = health !== null && health.health === 'permission_missing';
  const warns = stale || blocked;

  return (
    <View testID={testID} style={styles.row}>
      <Text numberOfLines={1} style={[textStyle('body'), styles.name]}>{name}</Text>
      <Text style={[textStyle('mono'), styles.count]}>{load}</Text>
      <View style={styles.track}>
        <Animated.View testID={testID === undefined ? undefined : `${testID}-bar`} style={[styles.fill, barStyle]} />
      </View>
      <View style={styles.state}>
        {health === undefined || health === null ? null : warns ? (
          <Text testID={testID === undefined ? undefined : `${testID}-warning`} style={[textStyle('caption'), styles.warningText]}>
            {blocked ? '⚠ tracking off' : '⚠ no ping'}
            {'\n'}
            {blocked ? 'he cannot report' : ageLabel(health.minutesSince)}
          </Text>
        ) : (
          <Text testID={testID === undefined ? undefined : `${testID}-state`} style={[textStyle('caption'), styles.stateText]}>
            {health.health === 'not_tracked' ? 'not tracked' : 'active'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: 56,
    paddingVertical: SPACE[2],
  },
  name: {
    color: SEMANTIC.text.primary,
    width: 96,
  },
  count: {
    color: SEMANTIC.text.primary,
    minWidth: 24,
    textAlign: 'right',
  },
  track: {
    flex: 1,
    height: BAR_HEIGHT,
    backgroundColor: SEMANTIC.bg.dense,
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: BAR_HEIGHT,
    backgroundColor: SEMANTIC.text.secondary,
  },
  state: {
    width: 120,
    alignItems: 'flex-start',
  },
  stateText: {
    color: SEMANTIC.text.secondary,
  },
  warningText: {
    color: SEMANTIC.feedback.warning,
  },
});
