/**
 * Test seam for `react-native` (T0.12). React primitives render under
 * react-test-renderer against string-typed host stubs — the reconciler
 * treats any string type as a host node, so the tree JSON keeps props,
 * styles and text exactly as the component authored them.
 *
 * This exercises the REAL component logic (state machines, token styles,
 * handlers) with zero native surface. Only the narrow API the UI
 * primitives use is modelled; extend it deliberately when a primitive
 * needs more, mirroring the RN contract in the comment.
 */

// Host elements — string types preserve verbatim props in toJSON().
export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const Pressable = 'Pressable';
export const Image = 'Image';
export const ScrollView = 'ScrollView';
export const Modal = 'Modal';
export const ActivityIndicator = 'ActivityIndicator';
// Pull to refresh on the technician's dashboard reads the server again;
// the stub keeps the host element so the tree shows the control and its
// refreshing state.
export const RefreshControl = 'RefreshControl';

/** Only what the primitives touch; `create` is identity under tests. */
export const StyleSheet = {
  create<T extends Record<string, object>>(styles: T): T {
    return styles;
  },
  flatten(style: object | object[]): Record<string, unknown> {
    return (Array.isArray(style) ? style : [style]).reduce(
      (acc, s) => ({ ...acc, ...s }),
      {} as Record<string, unknown>,
    );
  },
  compose: (...styles: (object | null | undefined | false)[]) => styles.filter(Boolean),
  hairlineWidth: 1,
} as const;

/** Tests run as android (the shipped platform); `select` mirrors RN. */
export const Platform = {
  OS: 'android' as 'android' | 'ios' | 'web' | 'windows' | 'macos',
  select<T extends Record<string, unknown>>(spec: Partial<T> & { default: T[keyof T] }): T[keyof T] {
    return (spec[Platform.OS] ?? spec.default) as T[keyof T];
  },
};

export const I18nManager = {
  isRTL: false,
  allowRTL: () => {},
  forceRTL: () => {},
};

export const AccessibilityInfo = {
  addEventListener: () => ({ remove: () => {} }),
  removeEventListener: () => {},
  isReduceMotionEnabled: async () => false,
  isScreenReaderEnabled: async () => false,
};

/**
 * Only the subscription surface the screens use (T0.14): the forced
 * password change and consent screens swallow hardware back ("not
 * skippable, no back"). Tests only need the subscription to exist.
 */
export const BackHandler = {
  addEventListener: (_event: string, _handler: () => boolean): { remove: () => void } => ({
    remove: () => {},
  }),
};

export const ScaledSheet = { create: StyleSheet.create };

/**
 * A phone-sized viewport (T0.13): NavTabBar divides it across the role's
 * tabs for the sliding underline. Constant — width-driven behaviour is
 * NavShell's branch, which tests read as source, not as render.
 */
export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number } {
  return { width: 412, height: 915, scale: 2, fontScale: 1 };
}
