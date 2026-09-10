/**
 * Phone bottom tab bar (T0.13, UI/plan-2/08-SHARED-SCREENS.md §X6).
 * Renders the role's group map — never a filtered owner map. Active tab:
 * **2px accent underline above the label, sliding between tabs over
 * 220ms** (DURATION.base, EASING.standard) — a precise underline, not a
 * filled pill. Reduced motion removes the movement; the underline still
 * moves to the active tab, just without the transition (02-MOTION §10).
 *
 * Deliberately free of expo-router: NavShell wires `activeRoute` and
 * `onSelect`, which keeps this renderable under the react-test-renderer
 * seam and the navigation concern in one file.
 */
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { COLORS, DURATION, SEMANTIC, TAP, type Role } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { coveringGroupIndex, groupMapFor } from './navmap';

const UNDERLINE_HEIGHT = 2;
/** Tab bar height: the 52pt field target plus the label's line. */
const BAR_HEIGHT = TAP.min + 18;

export interface NavTabBarProps {
  role: Role;
  activeRoute: string;
  onSelect: (route: string) => void;
}

export function NavTabBar({ role, activeRoute, onSelect }: NavTabBarProps): React.ReactNode {
  const groups = groupMapFor(role);
  const { width } = useWindowDimensions();
  const tabWidth = width / groups.length;

  const found = coveringGroupIndex(role, activeRoute);
  const activeIndex = found === -1 ? 0 : found;

  const reducedMotion = useReducedMotion();
  const offset = useSharedValue(activeIndex * tabWidth);

  useEffect(() => {
    offset.value = withTiming(activeIndex * tabWidth, {
      duration: reducedMotion ? DURATION.instant : DURATION.base,
      easing: Easing.bezier(0.2, 0, 0, 1), // EASING.standard — moving within the screen
    });
  }, [activeIndex, tabWidth, offset, reducedMotion]);

  const underlineStyle = useAnimatedStyle(() => ({
    width: tabWidth,
    transform: [{ translateX: offset.value }],
  }));

  return (
    <View
      accessibilityRole="tablist"
      style={{
        height: BAR_HEIGHT,
        backgroundColor: SEMANTIC.bg.raised,
        borderTopWidth: 1,
        borderTopColor: SEMANTIC.line.default,
      }}
    >
      <Animated.View
        testID="nav-underline"
        style={[
          underlineStyle,
          {
            position: 'absolute',
            top: 0,
            left: 0,
            height: UNDERLINE_HEIGHT,
            backgroundColor: COLORS.accent,
          },
        ]}
      />
      <View style={{ flexDirection: 'row' }}>
        {groups.map((group, index) => {
          const active = index === activeIndex;
          return (
            <Pressable
              key={group.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={group.label}
              onPress={() => onSelect(group.routes[0] ?? '/dashboard')}
              style={{
                width: tabWidth,
                minHeight: TAP.min,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  ...textStyle('label'),
                  color: active ? SEMANTIC.text.primary : SEMANTIC.text.secondary,
                }}
              >
                {group.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
