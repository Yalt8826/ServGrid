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
