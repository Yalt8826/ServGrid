/**
 * NavShell (T0.13; the desk branch is T4.7 — PLAN-FRONTEND.md §3,
 * UI/plan-2/07-OWNER.md "The desktop rail"). One route tree, two
 * presentations: bottom tabs from the role's group map on a phone, the
 * same five groups expanded to individual routes as a persistent 240px
 * left rail on the owner's desktop web build.
 *
 * The rail matches the phone's groups exactly and carries the same
 * active-state language — a 2px accent bar where the tab bar draws its
 * 2px underline — which is what makes the two layouts read as one
 * product.
 *
 * **It collapses** (owner, 2026-09-17). The first version of this
 * component argued against it — "one user, one laptop, a preference
 * nobody asked for" — and the owner asked, for the reason the argument
 * missed: his widest screens are tables, and the two hundred pixels a
 * rail spends on labels is the two hundred pixels a table's last column
 * needs. Collapsed, the rail keeps its marks and gives the page back.
 * The state is component-local and deliberately not persisted: it is a
 * glance-by-glance decision, not a stored preference, and this app keeps
 * no device storage outside the token store (the lint rule's subject).
 *
 * The desk branch — web, width ≥ 1024 — appears **exactly once in the
 * codebase**: here, asserted by test (even this doc comment must not
 * spell the check a second time). Screens never ask what platform they
 * are on; they read density from context. This component also sets
 * density (field / console / desk) from role and platform — exactly
 * once, per 01-FOUNDATIONS.md §3.3.
 */
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useRouter, usePathname } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DESK, DURATION, EASING, SEMANTIC, SLATE, SPACE, type Density, type Role } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { easing } from '../components/ui/motion';
import { DensityProvider } from '../components/ui/DensityProvider';
import { useSessionStore } from '../state/sessionStore';
import { NavTabBar } from './NavTabBar';
import { ROUTE_LABELS, activeRailRoute, densityForRole, groupMapFor } from './navmap';
import { RAIL_COLLAPSED_PAD, RAIL_MARK_GAP, RAIL_ROW_PAD, RailMark, routeMark } from './RailMark';

const DESK_MIN_WIDTH = 1024;

/** Who is signed in, under the product's name in the rail's head. */
const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  sales_rep: 'Sales rep',
};

/**
 * One route in the rail (OW.2). The pointer states the old rail never
 * had: hover says "this is a link" before the click, and the active row
 * carries a ground as well as the accent bar — a 3px bar alone, on a flat
 * slate column, was the whole of "where am I".
 *
 * Each row leads with its mark (2026-09-17). Expanded they are the
 * scannable edge that lets the eye skip the labels; collapsed they are
 * the entire row, which is why every route has one.
 */
function RailItem({
  label,
  mark,
  route,
  active,
  collapsed,
  density,
  onPress,
}: {
  label: string;
  mark: ReturnType<typeof routeMark>;
  route: string;
  active: boolean;
  collapsed: boolean;
  density: Density;
  onPress: () => void;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  // The mark is always one step dimmer than its label, and takes the
  // hover/active lift with it — one hierarchy, two tones.
  const markColor = active ? DESK.rail.itemActive : hovered ? SEMANTIC.text.onDark : DESK.rail.heading;
  return (
    <Pressable
      testID={`rail-item-${route}`}
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      // Collapsed, this label is the only name the row has — the toggle
      // takes the marks from "decoration" to "the interface", so the
      // accessible name has to carry the meaning on its own.
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        minHeight: DESK.rail.itemHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: RAIL_MARK_GAP,
        paddingLeft: collapsed ? RAIL_COLLAPSED_PAD : RAIL_ROW_PAD,
        paddingRight: collapsed ? 0 : SPACE[4],
        borderLeftWidth: DESK.rail.barWidth,
        borderLeftColor: active ? DESK.rail.activeBar : 'transparent',
        backgroundColor: active ? DESK.rail.activeBg : hovered ? DESK.rail.hover : 'transparent',
      }}
    >
      <RailMark name={mark} color={markColor} />
      {collapsed ? null : (
        <Text
          numberOfLines={1}
          style={{
            // The rail only renders at desk density; the density var keeps
            // that true by construction (14px body at desk, §3.3).
            ...textStyle('body', density),
            color: active ? DESK.rail.itemActive : hovered ? SEMANTIC.text.onDark : DESK.rail.item,
            fontWeight: active ? '600' : '400',
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * A section heading (2026-09-17). It used to be the same slate.400 as the
 * marks beside it, one hairline of letter-spacing from an ordinary row —
 * so a section read as another dim item rather than as the top of a
 * group. Now: a hairline rule above it, and the label in the product's
 * safety yellow (DESK.rail.headingStrong).
 *
 * It carried a section mark for a day, and the owner had it removed: the
 * label is already the name of the group, so the mark said the same thing
 * twice while competing with the route marks under it for the same 16px.
 * The ROUTE marks stay — a collapsed rail is nothing but those.
 */
function SectionHeading({ label }: { label: string }): ReactNode {
  return (
    <View style={{ marginTop: SPACE[4] }}>
      <View
        style={{
          height: 1,
          backgroundColor: DESK.rail.divider,
          marginHorizontal: RAIL_ROW_PAD,
          marginBottom: SPACE[3],
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          ...textStyle('label'),
          color: DESK.rail.headingStrong,
          textTransform: 'uppercase',
          letterSpacing: 0.9,
          paddingLeft: RAIL_ROW_PAD,
          marginBottom: SPACE[1],
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * The collapse control (2026-09-17). Two chevrons drawn as Views: the rail
 * carries no text in its chrome (NavShell.web.test.tsx asserts the rail's
 * exact text content, and a `‹` glyph would land in it), and no icon font
 * is bundled for one button.
 */
function CollapseToggle({ collapsed, onPress }: { collapsed: boolean; onPress: () => void }): ReactNode {
  const [hovered, setHovered] = useState(false);
  const color = hovered ? SEMANTIC.text.onDark : DESK.rail.headingStrong;
  // A chevron pointing the way the rail will move: left to collapse,
  // right to expand. Two bars meeting at a corner.
  const chevron = (dir: 'left' | 'right'): ReactNode => (
    <View style={{ width: 7, height: 12, justifyContent: 'center' }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderLeftWidth: dir === 'left' ? 2 : 0,
          borderRightWidth: dir === 'right' ? 2 : 0,
          borderBottomWidth: 2,
          borderColor: color,
          transform: [{ rotate: dir === 'left' ? '45deg' : '-45deg' }],
        }}
      />
    </View>
  );
  return (
    <Pressable
      testID="desk-rail-collapse"
      accessibilityRole="button"
      accessibilityLabel={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        minHeight: 32,
        minWidth: 32,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {chevron(collapsed ? 'right' : 'left')}
    </Pressable>
  );
}

/**
 * The rail's open/close animation (owner, 2026-09-17).
 *
 * **This is the codebase's one deliberate exception to §9's
 * "`transform` and `opacity` only — never `width`".** The rule's stated
 * reason is a frame budget: "16.6ms on the roster's slowest handset". The
 * rail is not on a handset — it is the owner's desk, web-only by
 * construction (the desk branch, ≥1024px), and the one place this branch
 * can render. And the collapse it animates is *inherently* a
 * layout change: the page beside the rail has to take the 168px back, and
 * no transform can push a sibling. Clipping a `translateX` would move the
 * rail's pixels while leaving a hole where the rail was.
 *
 * What the exception keeps from the rule, because those parts still
 * apply: the tokens drive it (DURATION.base, EASING.standard — "moving
 * within the screen"), it runs only while a collapse is in flight, and
 * **reduced motion removes the movement, never the feedback** (§10): the
 * rail still opens and closes, it just does so in one frame.
 */
function useRailWidth(collapsed: boolean): {
  width: number;
  style: ReturnType<typeof useAnimatedStyle>;
} {
  const target = collapsed ? DESK.rail.collapsedWidth : DESK.rail.width;
  const reduced = useReducedMotion();
  const width = useSharedValue(target);

  useEffect(() => {
    // §10: the state change is the information; the tween is the
    // decoration. Reduced motion keeps the former.
    width.value = reduced
      ? target
      : withTiming(target, { duration: DURATION.base, easing: easing(EASING.standard) });
  }, [target, reduced, width]);

  const style = useAnimatedStyle(() => ({
    width: width.value,
    flexGrow: 0,
    flexShrink: 0,
    // The same three properties the static version pinned: RNW lets a
    // ScrollView grow to fill a flex row on width alone.
    flexBasis: width.value,
  }));

  return { width: target, style };
}

export function NavShell({ children }: { children: ReactNode }): ReactNode {
  const actor = useSessionStore((s) => s.actor);
  const pathname = usePathname();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Local to the shell and not persisted: a glance-by-glance decision, and
  // this app keeps no device storage outside the token store.
  const [collapsed, setCollapsed] = useState(false);

  const role = actor?.role ?? null;
  // THE platform branch — the only one in the codebase (PLAN-FRONTEND.md
  // §3): the owner's desk presentation. Every other surface is a phone.
  const desk = role !== null && Platform.OS === 'web' && width >= DESK_MIN_WIDTH;
  // Density is set here and nowhere else (01-FOUNDATIONS.md §3.3).
  const density = densityForRole(role ?? 'technician', desk);
  // The rail's animated width and its one active row, both resolved here
  // so the rows below stay dumb.
  const railWidth = useRailWidth(collapsed);
  const activeRoute = role === null ? null : activeRailRoute(role, pathname);

  return (
    <DensityProvider density={density}>
      {role === null ? (
        // Unreachable through the layout (RoleGate redirects first);
        // a session tearing down mid-render still paints its screen.
        children
      ) : desk ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          {/* The width lives on this Animated.View, not on the ScrollView
           * (the static version's arrangement): `width` alone does not hold
           * a ScrollView in a flex row on RNW — it grows to fill — and an
           * Animated.View is what `useRailWidth` can drive. The ScrollView
           * inside simply fills it. */}
          <Animated.View
            testID="desk-rail"
            style={[
              {
                backgroundColor: DESK.rail.bg,
                borderRightWidth: 1,
                borderRightColor: SLATE[700],
                // Mid-collapse the labels are wider than the rail; clip
                // them rather than letting the flex row reflow every frame
                // (which would wrap and jitter the text).
                overflow: 'hidden',
              },
              railWidth.style,
            ]}
          >
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{
                paddingBottom: SPACE[6],
              }}
            >
            {/* The rail's head. A console that opens on a bare list of
                links has nowhere for the eye to land; the product's name
                and who is signed in is that place, and it is also what
                makes the rail read as chrome rather than as content. */}
            <View
              testID="desk-rail-brand"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: SPACE[2],
                paddingLeft: RAIL_ROW_PAD,
                paddingRight: collapsed ? 0 : SPACE[3],
                paddingTop: SPACE[5],
                paddingBottom: SPACE[4],
                borderBottomWidth: 1,
                borderBottomColor: SLATE[700],
              }}
            >
              {collapsed ? null : (
                <View style={{ flexShrink: 1 }}>
                  <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.onDark }}>ServGrid</Text>
                  <Text style={{ ...textStyle('caption'), color: DESK.rail.heading, marginTop: 2 }}>
                    {ROLE_LABELS[role] ?? role}
                  </Text>
                </View>
              )}
              <CollapseToggle collapsed={collapsed} onPress={() => setCollapsed((c) => !c)} />
            </View>
            {groupMapFor(role).map((group) => {
              // The spec's rail reads "Dashboard" as one bare item, not a
              // heading repeated under itself (07-OWNER.md): a section
              // whose single route is named exactly like the group skips
              // the heading. The other four groups head their routes.
              const only = group.routes[0];
              const bare =
                group.routes.length === 1 && only !== undefined && (ROUTE_LABELS[only] ?? only) === group.label;
              // Collapsed there is no room for a heading, and a bare
              // centred mark over the section's own marks would read as a
              // duplicate row — so the separator becomes a hairline. The
              // first section needs no rule: the brand's border is above it.
              const first = group.key === groupMapFor(role)[0]?.key;
              return (
                <View key={group.key}>
                  {bare ? null : collapsed ? (
                    first ? null : (
                      <View
                        style={{
                          height: 1,
                          backgroundColor: DESK.rail.divider,
                          marginHorizontal: RAIL_COLLAPSED_PAD,
                          marginVertical: SPACE[3],
                        }}
                      />
                    )
                  ) : (
                    <SectionHeading label={group.label} />
                  )}
                  {group.routes.map((route) => (
                    <RailItem
                      key={route}
                      route={route}
                      label={ROUTE_LABELS[route] ?? route}
                      mark={routeMark(route)}
                      // ONE item, and the most specific one: `/jobs/new` is
                      // inside `/jobs` by prefix, so testing each route on
                      // its own lit Jobs as well as Dispatch.
                      active={route === activeRoute}
                      collapsed={collapsed}
                      density={density}
                      onPress={() => router.navigate(route)}
                    />
                  ))}
                </View>
              );
            })}
            </ScrollView>
          </Animated.View>
          {/* The page ground: one step below the cards a screen paints on,
              which is what gives the console depth without adding colour. */}
          <View style={{ flex: 1, backgroundColor: DESK.page.bg }}>{children}</View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>
          <View style={{ flex: 1 }}>{children}</View>
          <NavTabBar
            role={role}
            activeRoute={pathname}
            onSelect={(route) => router.navigate(route)}
          />
        </View>
      )}
    </DensityProvider>
  );
}
