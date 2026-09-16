/**
 * Phone bottom tab bar (T0.13, UI/plan-2/08-SHARED-SCREENS.md §X6).
 * Renders the role's group map — never a filtered owner map.
 *
 * **On the navy frame (2026-09-16).** The bar was a white strip with four
 * grey words and a yellow underline: it read as a footer, not as the way
 * around the app. It is now the frame's other half — the same slate.900
 * the dashboard's header wears and the same ground the owner's rail sits
 * on — with a glyph above each label so a tab is found by shape before
 * it is read.
 *
 * Active tab: **2px accent underline above the label, sliding between
 * tabs over 220ms** (DURATION.base, EASING.standard) — a precise
 * underline, not a filled pill. The active glyph carries the accent and
 * the active label is white; the inactive pair is `textMuted`. That is
 * the rail's own rule (an accent bar plus white item text), so the two
 * chrome layouts stay one product, and the accent is never a *fill*.
 * Reduced motion removes the movement; the underline still moves to the
 * active tab, just without the transition (02-MOTION §10).
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

import { DURATION, FRAME, ICON, TAP, type Role } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { Icon, type IconName } from '../components/ui/icons';
import { coveringGroupIndex, groupMapFor, type NavGroupKey } from './navmap';

const UNDERLINE_HEIGHT = 2;
/** Tab bar height: the 52pt field target plus the glyph's line and the
 * label's — the glyph is extra content, not extra tap area. */
const BAR_HEIGHT = TAP.min + 18;

/**
 * A tab's glyph, by the group's own key — the key names the job the tab
 * does (`operations`, `catalogue`), so the map does not have to guess
 * from a label a role may reword. A group with no entry renders its label
 * alone: better a tab without a glyph than a wrong one.
 */
const TAB_ICON: Partial<Record<NavGroupKey, IconName>> = {
  dashboard: 'dashboard',
  jobs: 'jobs',
  cash: 'cash',
  profile: 'profile',
  operations: 'wrench',
  amc: 'document',
  sales: 'trending',
  companies: 'business',
  people: 'people',
  catalogue: 'cube',
};

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
        backgroundColor: FRAME.bg,
        borderTopWidth: 1,
        borderTopColor: FRAME.divider,
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
            backgroundColor: FRAME.accent,
          },
        ]}
      />
      <View style={{ flexDirection: 'row' }}>
        {groups.map((group, index) => {
          const active = index === activeIndex;
          const glyph = TAB_ICON[group.key];
          const ink = active ? FRAME.accent : FRAME.textMuted;
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
                gap: 2,
              }}
            >
              {glyph === undefined ? null : <Icon name={glyph} size={ICON.md} color={ink} />}
              <Text
                style={{
                  ...textStyle('label'),
                  fontSize: 12,
                  lineHeight: 16,
                  color: active ? FRAME.text : FRAME.textMuted,
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
