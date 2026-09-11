/**
 * Minimal vitest seam for `react-native-reanimated` (T0.12). Reanimated
 * ships a mock (mock.js → src/mock.ts) whose relative require and
 * type-stripped source vitest's pipeline cannot load, so this stub
 * reproduces the mock's observable contract for the API the primitives
 * use: shared values are plain `{ value }` boxes, `useAnimatedStyle`
 * runs its worklet immediately and returns the computed style, and the
 * `with*` animations return their target value. Assertions therefore
 * see final state — exactly what the state-based tests want.
 */

export function useSharedValue<T>(initial: T): { value: T } {
  return { value: initial };
}

export function useDerivedValue<T>(processor: () => T): { value: T } {
  return { value: processor() };
}

export function useAnimatedStyle<T extends Record<string, unknown>>(updater: () => T): T {
  return updater();
}

export function useAnimatedReaction(): void {}

export function useEvent(): () => void {
  return () => {};
}

export function useAnimatedScrollHandler(): () => void {
  return () => {};
}

export function useAnimatedRef(): { current: number | null } {
  return { current: null };
}

// Animations resolve to their target — final state, no clock.
export function withSpring(to: number): number {
  return to;
}
export function withTiming(to: number): number {
  return to;
}
export function withDecay(to: number): number {
  return to;
}
export function withRepeat(to: number): number {
  return to;
}
export function withDelay(_delay: number, to: number): number {
  return to;
}
/**
 * T1.18 (the stepper hero): a sequence resolves to its LAST step's value —
 * the node pop is `1 → 1.15 → 1` and the stub has no clock, so the final
 * rest value (1) is the observable outcome, same contract as the `with*`
 * family above.
 */
export function withSequence<T>(...steps: T[]): T {
  const last = steps[steps.length - 1];
  if (last === undefined) throw new Error('withSequence needs at least one step.');
  return last;
}
export function cancelAnimation(): void {}
export function runOnJS<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
export function interpolate(value: number): number {
  return value;
}
export function clamp(value: number): number {
  return value;
}

/**
 * Colour interpolation, same final-state semantics as the `with*`
 * family: the value arriving here is the target (a `useToggleProgress`
 * driven style), so the output range's far end wins once the progress
 * has reached it. This is what the T7 ladder row's 140ms colour change
 * reads as under test — the resolved colour, with no clock.
 */
export function interpolateColor(value: number, _inputRange: number[], outputRange: string[]): string {
  const last = outputRange[outputRange.length - 1];
  return value >= 1 && last !== undefined ? last : (outputRange[0] ?? 'transparent');
}

/**
 * Easing + reduced motion (T0.13): NavTabBar slides its underline with
 * `withTiming(x, { easing: Easing.bezier(...) })`. The easing factory is
 * identity — the stub has no clock to ease — and reduced motion follows
 * the system default of off.
 */
export const Easing = {
  bezier: (_x1: number, _y1: number, _x2: number, _y2: number) => (t: number): number => t,
  linear: (t: number): number => t,
  in: (t: number): number => t,
  out: (t: number): number => t,
  inOut: (t: number): number => t,
};

export function useReducedMotion(): boolean {
  return false;
}

export const ReduceMotion = {
  System: 'system',
  Always: 'always',
  Never: 'never',
} as const;

/**
 * `Animated` — the components namespace. Under the stub seam the View
 * and Text children render through react-test-renderer as ordinary
 * host-typed nodes carrying the style (string types pass props
 * verbatim), so `Animated.View style={...}` round-trips in toJSON().
 */
const Animated = {
  View: 'Animated.View',
  Text: 'Animated.Text',
  ScrollView: 'Animated.ScrollView',
};

export default Animated;
