/**
 * Everyday-interaction motion (02-MOTION.md §6) — the layer that is most
 * of what a user actually feels, as opposed to the six signature moments
 * (§5), which attach to screens Phase 1 builds.
 *
 * Why this file exists: the tokens landed in T0.12 and the primitives
 * described their motion in prose, but only `NavTabBar` drove any of it.
 * A press that answers with a colour swap and no spring is the thing
 * `00-PHILOSOPHY.md` §4.1 rules out — *every tap produces visible change
 * in under 100ms, and not a spinner: change.*
 *
 * Two rules hold everywhere below:
 *
 * - **Reduced motion removes movement, never feedback** (§10). Transforms
 *   become instant state flips; colour, haptics and state still change.
 *   An app that strips all response under reduced motion has confused
 *   decoration with information.
 * - **`transform` and `opacity` only** (§9). Never `width`, `height`,
 *   `top`, `margin` — those relayout, and the budget is 16.6ms on the
 *   roster's slowest handset.
 */
import { useCallback } from 'react';
import {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { DURATION, EASING, SPRING } from '@servgrid/shared';

/** Reanimated wants an easing fn; the tokens are bezier control points. */
export function easing(token: readonly [number, number, number, number]) {
  return Easing.bezier(token[0], token[1], token[2], token[3]);
}

export interface PressMotion {
  /** Spread onto the animated wrapper. */
  style: ReturnType<typeof useAnimatedStyle>;
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * Press feedback: scale to 0.97 on touch-**down**, `spring.press`
 * (~90ms, no visible overshoot).
 *
 * Touch-down and not touch-up is the whole point — feedback that waits
 * for the finger to lift is feedback that arrives after the decision.
 * `spring.press` has damping 26, so it settles without the bounce that
 * would read as toy rather than equipment (§3).
 */
export function usePressScale(to = 0.97, enabled = true): PressMotion {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);

  const set = useCallback(
    (v: number) => {
      if (!enabled) return;
      scale.value = reduced ? 1 : withSpring(v, SPRING.press);
    },
    [enabled, reduced, scale],
  );

  return {
    style: useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] })),
    onPressIn: useCallback(() => set(to), [set, to]),
    onPressOut: useCallback(() => set(1), [set]),
  };
}

/**
 * A 0→1 progress value that follows a boolean, for the `quick` 140ms
 * micro-state changes: a chip filling, a field border thickening.
 * Consumers interpolate colour or width off it in a worklet.
 */
export function useToggleProgress(on: boolean, duration = DURATION.quick): SharedValue<number> {
  const reduced = useReducedMotion();
  const progress = useSharedValue(on ? 1 : 0);
  progress.value = reduced
    ? on
      ? 1
      : 0
    : withTiming(on ? 1 : 0, { duration, easing: easing(EASING.standard) });
  return progress;
}

/**
 * Arrival with weight: a banner dropping from the top, a sheet rising
 * from its trigger. `spring.sheet` settles in ~300ms with a hair of
 * overshoot — enough that the surface reads as having mass, not enough
 * to bounce.
 *
 * `distance` is where it starts, in points: negative drops from above,
 * positive rises from below.
 */
export function useArrival(distance: number): ReturnType<typeof useAnimatedStyle> {
  const reduced = useReducedMotion();
  const offset = useSharedValue(reduced ? 0 : distance);
  const opacity = useSharedValue(reduced ? 1 : 0);

  offset.value = reduced ? 0 : withSpring(0, SPRING.sheet);
  opacity.value = reduced
    ? 1
    : withTiming(1, { duration: DURATION.base, easing: easing(EASING.enter) });

  return useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: offset.value }],
  }));
}
