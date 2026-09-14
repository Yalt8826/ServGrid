/**
 * The one permitted continuous animation in the product (T4.10,
 * UI/plan-2/07-OWNER.md §O3): during a five-minute `live` window the
 * selected employee's dot carries a slow pulse. It runs ONLY while this
 * screen is focused and stops when the window closes — a live window is
 * a bounded, deliberately-entered state the owner needs to see is
 * active, which is the whole of the justification; anywhere else a
 * continuous animation is a drain the product refuses.
 *
 * `enabled` is exactly `focused && liveWindowOpen` — the route derives
 * it, the hook only obeys it. Going false CANCELS the running repeat
 * (`cancelAnimation`, not a flag the worklet keeps consulting): a
 * stopped pulse is stopped, not paused-and-still-ticking.
 */
import { useEffect, useState } from 'react';
import {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/** Slow — a breath, not a heartbeat. One full grow-and-shrink cycle. */
export const PULSE_PERIOD_MS = 1600;
/** How far the dot grows at the peak of the pulse. */
export const PULSE_SCALE = 1.5;

export interface LivePulseStyle {
  transform: Array<{ scale: number }>;
}

export interface LivePulse {
  /** Spread onto the dot's wrapper while pulsing. */
  style: LivePulseStyle;
  /** True only while the repeat is armed — the honest answer to "is
   * the dot pulsing right now", and what the blur test asserts on. */
  running: boolean;
}

export function useLivePulse(enabled: boolean): LivePulse {
  const scale = useSharedValue(1);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!enabled) {
      cancelAnimation(scale);
      scale.value = 1;
      setRunning(false);
      return;
    }
    scale.value = withRepeat(
      withTiming(PULSE_SCALE, { duration: PULSE_PERIOD_MS / 2, easing: Easing.inOut(Easing.linear) }),
      -1,
      true, // ping-pong — grow, then shrink, no snap at the loop point
    );
    setRunning(true);
    return () => {
      cancelAnimation(scale);
      scale.value = 1;
      setRunning(false);
    };
  }, [enabled, scale]);

  const style = useAnimatedStyle<LivePulseStyle>(() => ({ transform: [{ scale: scale.value }] }));
  return { style, running };
}
