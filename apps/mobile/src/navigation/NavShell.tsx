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
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS, LAYOUT, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { DensityProvider } from '../components/ui/DensityProvider';
import { useSessionStore } from '../state/sessionStore';
import { NavTabBar } from './NavTabBar';
import { ROUTE_LABELS, densityForRole, groupMapFor, routeIsCovered } from './navmap';

const DESK_MIN_WIDTH = 1024;
const RAIL_WIDTH = LAYOUT.railWidth;

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
            // what keeps the rail at 240 instead of half the window.
            testID="desk-rail"
            style={{
              width: RAIL_WIDTH,
              flexGrow: 0,
              flexShrink: 0,
              flexBasis: RAIL_WIDTH,
              backgroundColor: SEMANTIC.bg.dark,
              borderRightWidth: 1,
              borderRightColor: SEMANTIC.line.strong,
            }}
            contentContainerStyle={{
              paddingBottom: SPACE[4],
            }}
          >
            {groupMapFor(role).map((group) => {
              // The spec's rail reads "Dashboard" as one bare item, not a
              // heading repeated under itself (07-OWNER.md): a section
              // whose single route is named exactly like the group skips
              // the heading. The other four groups head their routes.
              const only = group.routes[0];
              const bare =
                group.routes.length === 1 && only !== undefined && (ROUTE_LABELS[only] ?? only) === group.label;
              return (
                <View key={group.key} style={{ marginTop: SPACE[4] }}>
                  {bare ? null : (
                    <Text
                      style={{
                        ...textStyle('caption'),
                        color: SEMANTIC.text.onDarkSecondary,
                        paddingHorizontal: SPACE[3],
                        marginBottom: SPACE[1],
                      }}
                    >
                      {group.label}
                    </Text>
                  )}
                  {group.routes.map((route) => {
                    const active = routeIsCovered(route, pathname);
                    return (
                      <Pressable
                        key={route}
                        accessibilityRole="link"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={ROUTE_LABELS[route] ?? route}
                        onPress={() => router.navigate(route)}
                        style={{
                          minHeight: TAP.desk,
                          justifyContent: 'center',
                          paddingHorizontal: SPACE[3],
                          borderLeftWidth: 2,
                          borderLeftColor: active ? COLORS.accent : 'transparent',
                        }}
                      >
                        <Text
                          style={{
                            // The rail only renders at desk density; the
                            // density var keeps that true by construction
                            // (14px body at desk, §3.3).
                            ...textStyle('body', density),
                            color: active ? SEMANTIC.text.onDark : SEMANTIC.text.onDarkSecondary,
                          }}
                        >
                          {ROUTE_LABELS[route] ?? route}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            })}
          </ScrollView>
          <View style={{ flex: 1 }}>{children}</View>
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
