/**
 * `TechnicianLoadRow` (03-COMPONENTS.md, UI/plan-2/05-DISPATCHER.md §D1).
 * One row: name (`body`) · load count (`mono`, tabular) · **inline load
 * bar**. The tracking-health column is GONE (owner, 2026-09-17): the
 * dispatcher does not consume the technicians' location-reporting state —
 * not as a warning, not as an "active" tick — so this row carries the
 * load comparison and nothing else. The row is a plain display unless a
 * caller wraps it in a press; the dashboard wraps it to open a
 * technician's day.
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
 * The coordinate rule still holds, and is stronger now: no tracking
 * state, no last-ping age, and no coordinate exists in this component's
 * props, and none may — the dispatcher's tree is checked for coordinates
 * in dashboard.test.tsx and in the money-leak suite's roster walk.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../ui/motion';
import { useDensity } from '../ui/DensityProvider';export interface TechnicianLoadRowProps {
  name: string;
  /** The count the mono figure and the bar both show (open jobs). */
  load: number;
  /** The busiest load in the list — the bar is a fraction of it. */
  maxLoad: number;
  /** Draw the bar on focus (staggered by `index`); false = already drawn. */
  draw?: boolean;
  index?: number;
  testID?: string;
}

const DRAW_MS = 260;
const STAGGER_MS = 30;
const BAR_HEIGHT = 4;

export function TechnicianLoadRow({
  name,
  load,
  maxLoad,
  draw = true,
  index = 0,
  testID,
}: TechnicianLoadRowProps): React.ReactNode {
  const enter = easing(EASING.enter);
  const progress = useSharedValue(draw ? 0 : 1);
  const density = useDensity();
  const desk = density === 'desk';

  useEffect(() => {
    if (!draw) return;
    progress.value = withDelay(index * STAGGER_MS, withTiming(1, { duration: DRAW_MS, easing: enter }));
  }, [draw, enter, index, progress]);

  // Relative to the busiest row: a list where everyone is at three must
  // not read as "half busy" (PLAN.md §8 — the bar is the comparison).
  const fraction = maxLoad > 0 ? Math.min(1, load / maxLoad) : 0;
  const barStyle = useAnimatedStyle(() => ({ width: `${Math.round(progress.value * fraction * 100)}%` }));

  return (
    <View testID={testID} style={styles.row}>
      {/* 96 is the phone's column; on the desk a full name fits and the
      ellipsis hid who was actually being assigned (2026-09-16 walk). */}
      <Text numberOfLines={1} style={[textStyle('body', density), styles.name, desk && styles.nameDesk]}>{name}</Text>
      <Text style={[textStyle('mono'), styles.count]}>{load}</Text>
      <View style={styles.track}>
        <Animated.View testID={testID === undefined ? undefined : `${testID}-bar`} style={[styles.fill, barStyle]} />
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
  nameDesk: {
    width: 208,
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
});
