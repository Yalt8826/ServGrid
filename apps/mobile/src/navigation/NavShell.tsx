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
 * product. It does not collapse: one user, one laptop, and a collapse
 * control would be a preference nobody asked for.
 *
 * The desk branch — web, width ≥ 1024 — appears **exactly once in the
 * codebase**: here, asserted by test (even this doc comment must not
 * spell the check a second time). Screens never ask what platform they
 * are on; they read density from context. This component also sets
 * density (field / console / desk) from role and platform — exactly
 * once, per 01-FOUNDATIONS.md §3.3.
 */
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DESK, SEMANTIC, SLATE, SPACE, type Density, type Role } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { DensityProvider } from '../components/ui/DensityProvider';
import { useSessionStore } from '../state/sessionStore';
import { NavTabBar } from './NavTabBar';
import { ROUTE_LABELS, densityForRole, groupMapFor, routeIsCovered } from './navmap';

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
 */
function RailItem({
  label,
  active,
  density,
  onPress,
}: {
  label: string;
  active: boolean;
  density: Density;
  onPress: () => void;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        minHeight: DESK.rail.itemHeight,
        justifyContent: 'center',
        paddingHorizontal: SPACE[4],
        borderLeftWidth: DESK.rail.barWidth,
        borderLeftColor: active ? DESK.rail.activeBar : 'transparent',
        backgroundColor: active ? DESK.rail.activeBg : hovered ? DESK.rail.hover : 'transparent',
      }}
    >
      <Text
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
    </Pressable>
  );
}

export function NavShell({ children }: { children: ReactNode }): ReactNode {
  const actor = useSessionStore((s) => s.actor);
  const pathname = usePathname();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const role = actor?.role ?? null;
  // THE platform branch — the only one in the codebase (PLAN-FRONTEND.md
  // §3): the owner's desk presentation. Every other surface is a phone.
  const desk = role !== null && Platform.OS === 'web' && width >= DESK_MIN_WIDTH;
  // Density is set here and nowhere else (01-FOUNDATIONS.md §3.3).
  const density = densityForRole(role ?? 'technician', desk);

  return (
    <DensityProvider density={density}>
      {role === null ? (
        // Unreachable through the layout (RoleGate redirects first);
        // a session tearing down mid-render still paints its screen.
        children
      ) : desk ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <ScrollView
            // `width` alone does not hold a ScrollView in a flex row on
            // RNW — it grows to fill. Pinning all three flex properties is
            // what keeps the rail at its width instead of half the window.
            testID="desk-rail"
            style={{
              width: DESK.rail.width,
              flexGrow: 0,
              flexShrink: 0,
              flexBasis: DESK.rail.width,
              backgroundColor: DESK.rail.bg,
              borderRightWidth: 1,
              borderRightColor: SLATE[700],
            }}
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
                paddingHorizontal: SPACE[4],
                paddingTop: SPACE[5],
                paddingBottom: SPACE[4],
                borderBottomWidth: 1,
                borderBottomColor: SLATE[700],
              }}
            >
              <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.onDark }}>ServGrid</Text>
              <Text style={{ ...textStyle('caption'), color: DESK.rail.heading, marginTop: 2 }}>
                {ROLE_LABELS[role] ?? role}
              </Text>
            </View>
            {groupMapFor(role).map((group) => {
              // The spec's rail reads "Dashboard" as one bare item, not a
              // heading repeated under itself (07-OWNER.md): a section
              // whose single route is named exactly like the group skips
              // the heading. The other four groups head their routes.
              const only = group.routes[0];
              const bare =
                group.routes.length === 1 && only !== undefined && (ROUTE_LABELS[only] ?? only) === group.label;
              return (
                <View key={group.key} style={{ marginTop: SPACE[5] }}>
                  {bare ? null : (
                    <Text
                      style={{
                        ...textStyle('caption'),
                        color: DESK.rail.heading,
                        textTransform: 'uppercase',
                        letterSpacing: 0.6,
                        paddingHorizontal: SPACE[4],
                        marginBottom: SPACE[2],
                      }}
                    >
                      {group.label}
                    </Text>
                  )}
                  {group.routes.map((route) => (
                    <RailItem
                      key={route}
                      label={ROUTE_LABELS[route] ?? route}
                      active={routeIsCovered(route, pathname)}
                      density={density}
                      onPress={() => router.navigate(route)}
                    />
                  ))}
                </View>
              );
            })}
          </ScrollView>
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
