/**
 * `PendingBadge` (UI/plan-2/04-TECHNICIAN.md §T1 anatomy "⟳ 3",
 * 02-MOTION.md §5.3): the visible proof that queued work exists — and,
 * while a drain runs, the refresh indicator itself. Pull to refresh
 * **drains the outbox and this badge is the indicator — never a platform
 * spinner** (§6): there is no spinner anywhere in this component.
 *
 * At zero it renders nothing. The count ticks in tabular figures so
 * nothing reflows as it drains; at zero the badge scales out with
 * `spring.press` (§5.3). Never a continuous animation — the badge is
 * either still, or settling out of existence.
 *
 * Tapping it drains immediately — the one refresh gesture a standing,
 * one-handed technician can always reach.
 */
import { Pressable, Text } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useEffect } from 'react';

import { DURATION, RADII, SEMANTIC, SPRING } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';

export interface PendingBadgeProps {
  /** Queued + inflight rows (the outbox's own count, `rejected` and
   * `failed` excluded — kept rows are not pending work). */
  count: number;
  /** A drain cycle is running: the badge holds still and visible. */
  draining?: boolean;
  onPress?: () => void;
  testID?: string;
}

export function PendingBadge({ count, draining = false, onPress, testID }: PendingBadgeProps): React.ReactNode {
  // §5.3: the scale-out at zero is the satisfying half of the badge —
  // the count drains down, then the badge leaves. Reduced motion (or the
  // test seam) flips it instantly; movement is removed, feedback kept.
  const visible = useSharedValue(count > 0 ? 1 : 0);

  useEffect(() => {
    visible.value = count > 0 ? withSpring(1, SPRING.press) : withTiming(0, { duration: DURATION.quick });
  }, [count, visible]);

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ scale: visible.value }],
  }));

  if (count <= 0) return null;

  return (
    <Animated.View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          draining ? `Syncing ${count} items` : `${count} items waiting to sync — tap to sync now`
        }
        testID={testID}
        onPress={onPress}
        disabled={draining}
        hitSlop={8}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 32,
          paddingHorizontal: 10,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: draining ? SEMANTIC.line.strong : SEMANTIC.line.default,
          backgroundColor: SEMANTIC.bg.raised,
        }}
      >
        <Text
          style={{
            ...textStyle('label'),
            color: SEMANTIC.text.primary,
            fontVariant: ['tabular-nums'],
            marginRight: 6,
          }}
          testID={testID ? `${testID}-count` : undefined}
        >
          {String(count)}
        </Text>
        <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary }}>
          {draining ? 'Syncing' : 'Pending'}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
