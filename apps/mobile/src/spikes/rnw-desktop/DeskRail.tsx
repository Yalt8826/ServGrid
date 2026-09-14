/**
 * T4.1 spike rail (THROWAWAY) — the T4.7 `NavShell` desk branch,
 * prototyped to the specification in `UI/plan-2/07-OWNER.md`: 240px
 * (`LAYOUT.railWidth`), `slate.900` ground, `surface` text, 2px accent
 * bar on the active route — the same active-state language as the
 * phone's tab underline. Five sections matching the phone's five
 * groups exactly, expanded to individual routes. No collapse control —
 * one user, one laptop, nobody asked.
 *
 * Rendered against the REAL token set and the REAL Plex faces, not
 * placeholders — the spike's own thesis is that half the RNW pain is in
 * fonts and borders, not layout.
 */
import { Pressable, Text, View } from 'react-native';

import { COLORS, LAYOUT, SEMANTIC, TAP } from '@servgrid/shared';
import { resolveFontFamily, textStyle } from '../../fonts/textStyle';

interface RailRoute {
  label: string;
  href: string;
}

interface RailSection {
  heading: string | null;
  routes: RailRoute[];
}

/** The owner's five groups, expanded (`PLAN-FRONTEND.md` §3, §O-rail). */
const SECTIONS: RailSection[] = [
  { heading: null, routes: [{ label: 'Dashboard', href: '/dashboard' }] },
  {
    heading: 'Operations',
    routes: [
      { label: 'Jobs', href: '/jobs' },
      { label: 'Dispatch', href: '/jobs/new' },
      { label: 'Customers', href: '/customers' },
      { label: 'Contracts', href: '/contracts' },
    ],
  },
  {
    heading: 'Sales',
    routes: [
      { label: 'Sales', href: '/sales' },
      { label: 'Payments', href: '/payments' },
      { label: 'Companies', href: '/companies' },
      { label: 'Renewals', href: '/contracts/renewals' },
    ],
  },
  {
    heading: 'People',
    routes: [
      { label: 'Employees', href: '/employees' },
      { label: 'Location', href: '/location' },
      { label: 'Cash queue', href: '/cash' },
    ],
  },
  {
    heading: 'Profile',
    routes: [
      { label: 'Profile', href: '/profile' },
      { label: 'Products', href: '/products' },
      { label: 'Services', href: '/services' },
    ],
  },
];

const styles = {
  rail: {
    width: LAYOUT.railWidth,
    backgroundColor: SEMANTIC.bg.dark,
    borderRightWidth: 1,
    borderRightColor: SEMANTIC.line.strong,
    paddingTop: 12,
    paddingBottom: 12,
  },
  section: { marginBottom: 12 },
  heading: {
    ...textStyle('caption'),
    color: SEMANTIC.text.onDarkSecondary,
    paddingHorizontal: 16,
    marginBottom: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  route: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: TAP.desk,
  },
  activeBar: { width: 2, height: TAP.desk, backgroundColor: COLORS.accent },
  inactiveBar: { width: 2, height: TAP.desk },
  routeLabel: { ...textStyle('body', 'desk'), color: SEMANTIC.text.onDark, paddingLeft: 14 },
  routeLabelActive: {
    fontWeight: '600' as const,
    fontFamily: resolveFontFamily('sans', '600'),
  },
};

export function DeskRail({ activeHref }: { activeHref: string }): React.ReactNode {
  return (
    <View style={styles.rail} testID="desk-rail">
      {SECTIONS.map((section) => (
        <View key={section.heading ?? 'dashboard'} style={styles.section}>
          {section.heading !== null ? <Text style={styles.heading}>{section.heading}</Text> : null}
          {section.routes.map((route) => {
            const active = route.href === activeHref;
            return (
              <Pressable
                key={route.href}
                style={styles.route}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
                onPress={() => {}}
              >
                <View style={active ? styles.activeBar : styles.inactiveBar} />
                <Text style={[styles.routeLabel, active && styles.routeLabelActive]} numberOfLines={1}>
                  {route.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
