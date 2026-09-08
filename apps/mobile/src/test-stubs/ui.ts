/**
 * Setup for component-render tests (T0.12). The primitives render via
 * react-test-renderer against the `react-native` host stubs
 * (`test-stubs/react-native.ts`); `act` requires the React 18+ opt-in
 * flag or every update warns and handler effects do not flush.
 */
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Expo/Metro global — the gallery dev-gate reads it.
(globalThis as Record<string, unknown>).__DEV__ = true;

export {};
