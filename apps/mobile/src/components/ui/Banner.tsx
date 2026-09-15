/**
 * `Banner` (03-COMPONENTS.md). Full-bleed, 4px leading rail in the
 * semantic colour, icon 20, message in `body` — the server's message
 * verbatim — up to two text actions, optional dismiss. Drops with
 * weight, spring.sheet, `Warning` haptic; never auto-dismisses. Never
 * a toast for an error: toasts vanish, and the technician was in a
 * basement.
 */
import { Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { haptic } from './haptics';
import { useArrival } from './motion';

export type BannerTone = 'danger' | 'warning' | 'success' | 'info';

export interface BannerProps {
  tone: BannerTone;
  /** The server's `message` verbatim (PLAN-BACKEND.md §3.1). */
  message: string;
  /** Up to two text actions. */
  actions?: { label: string; onPress: () => void }[];
  onDismiss?: () => void;
  testID?: string;
}

const TONE_COLOR: Record<BannerTone, string> = {
  danger: SEMANTIC.feedback.danger,
  warning: SEMANTIC.feedback.warning,
  success: SEMANTIC.feedback.success,
  info: SEMANTIC.feedback.info,
};

export function Banner({ tone, message, actions = [], onDismiss, testID }: BannerProps): React.ReactNode {
  const rail = TONE_COLOR[tone];
  // Drops from above with weight (spring.sheet, a hair of overshoot). The
  // only assertive motion in the product, and it earns it: the alternative
  // is a technician not noticing his completion was refused (02-MOTION §5.6).
  const arrival = useArrival(-16);
  return (
    <Animated.View
      testID={testID}
      onLayout={() => {
        if (tone === 'danger' || tone === 'warning') haptic('syncRejected');
      }}
      style={[
        {
          backgroundColor: SEMANTIC.bg.raised,
          borderLeftWidth: 4,
          borderLeftColor: rail,
          borderRadius: RADII.none,
          borderWidth: 1,
          borderColor: SEMANTIC.line.default,
          paddingVertical: SPACE[3],
          paddingLeft: SPACE[3],
          paddingRight: SPACE[2],
        },
        arrival,
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: rail, marginRight: SPACE[3] }} />
        <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>{message}</Text>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            accessibilityRole="button"
            onPress={a.onPress}
            hitSlop={8}
            style={{ paddingHorizontal: SPACE[2] }}
          >
            <Text style={{ ...textStyle('label'), color: rail }}>{a.label}</Text>
          </Pressable>
        ))}
        {onDismiss ? (
          <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={8} testID={testID ? `${testID}-dismiss` : undefined}>
            <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary }}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}
