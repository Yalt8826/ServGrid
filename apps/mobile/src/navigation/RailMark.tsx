/**
 * Rail marks — the desk rail's icons (owner, 2026-09-17: "add icons to
 * them to make them look better").
 *
 * **Drawn from Views, not a font.** Three constraints decided that, and
 * all three are load-bearing:
 *
 * 1. `@expo/vector-icons` is not a dependency of this app (it is an
 *    optional peer of `expo`, and pnpm does not hoist it). Adding one
 *    would put an icon FONT in the web bundle and — because NavShell is
 *    shared, not a `.web.tsx` seam — in the Android APK as well, for
 *    marks that only ever paint on a desk. A `View` draws the same shape
 *    on both platforms and bundles as nothing.
 * 2. `NavShell.web.test.tsx` asserts the rail's exact text content, so a
 *    glyph (`▸`, `✕`) would fail it. These marks render no text at all.
 * 3. The same suite asserts nothing in the rail is filled with the accent
 *    or carries a radius. Every mark here is square and takes its colour
 *    from the caller.
 *
 * They are deliberately geometric and small (16px): at this size a
 * pictogram is read as a shape, and a shape that survives being 16px is
 * one built from two or three rectangles. Each mark is therefore a
 * silhouette, not an illustration — and each section's mark is
 * distinguishable from its neighbours' at a glance, which is the whole
 * job when a collapsed rail hides the labels.
 */
import { View, type ViewStyle } from 'react-native';

import { DESK } from '@servgrid/shared';

/** Every mark the rail can draw — routes and section headings share them. */
export type RailMarkName =
  | 'dashboard'
  | 'jobs'
  | 'new'
  | 'logs'
  | 'customers'
  | 'companies'
  | 'contracts'
  | 'sales'
  | 'payments'
  | 'employees'
  | 'location'
  | 'cash'
  | 'products'
  | 'services'
  | 'profile';

const BOX = 16;

/** One bar of a mark. Square by construction — the rail carries no radii. */
function Bar({ w, h, color, style }: { w: number; h: number; color: string; style?: ViewStyle }): React.ReactNode {
  return <View style={[{ width: w, height: h, backgroundColor: color }, style]} />;
}

/** An outlined shape: hairline border, hollow ground. */
function Outline({
  w,
  h,
  color,
  children,
  gap,
  style,
}: {
  w: number;
  h: number;
  color: string;
  children?: React.ReactNode;
  gap?: number;
  style?: ViewStyle;
}): React.ReactNode {
  return (
    <View
      style={[
        { width: w, height: h, borderWidth: 1, borderColor: color, alignItems: 'center', justifyContent: 'center', gap },
        style,
      ]}
    >
      {children}
    </View>
  );
}

function Mark({ name, color }: { name: RailMarkName; color: string }): React.ReactNode {
  switch (name) {
    // Four panes — the console's grid of figures.
    case 'dashboard':
      return (
        <View style={{ width: BOX, height: BOX, flexDirection: 'row', flexWrap: 'wrap', gap: 3 }}>
          <Bar w={6} h={6} color={color} />
          <Bar w={6} h={6} color={color} />
          <Bar w={6} h={6} color={color} />
          <Bar w={6} h={6} color={color} />
        </View>
      );
    // A stack of work — the queue the Jobs screens read.
    case 'jobs':
      return (
        <View style={{ width: BOX, height: BOX, justifyContent: 'center', gap: 3 }}>
          <Bar w={BOX} h={2} color={color} />
          <Bar w={12} h={2} color={color} />
          <Bar w={12} h={2} color={color} />
        </View>
      );
    // A plus — the two "create" routes (Dispatch a job, New AMC) and the
    // rep's new-sale door.
    case 'new':
      return (
        <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' }}>
          <Bar w={BOX} h={2} color={color} style={{ position: 'absolute' }} />
          <Bar w={2} h={BOX} color={color} style={{ position: 'absolute' }} />
        </View>
      );
    // A sheet of entries.
    case 'logs':
      return (
        <Outline w={13} h={BOX} color={color} gap={2}>
          <Bar w={7} h={1.5} color={color} />
          <Bar w={7} h={1.5} color={color} />
        </Outline>
      );
    // One head over one body — a single site.
    case 'customers':
      return (
        <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <Bar w={6} h={6} color={color} />
          <Bar w={BOX} h={3} color={color} />
        </View>
      );
    // Two heads — the roster, and the People section.
    case 'employees':
      return (
        <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <View style={{ flexDirection: 'row', gap: 2 }}>
            <Bar w={5} h={5} color={color} />
            <Bar w={5} h={5} color={color} />
          </View>
          <Bar w={14} h={3} color={color} />
        </View>
      );
    // A stack of floors — the ledger's accounts.
    case 'companies':
      return (
        <View style={{ width: BOX, height: BOX, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Bar w={4} h={BOX} color={color} />
          <Bar w={4} h={11} color={color} />
          <Bar w={4} h={7} color={color} />
        </View>
      );
    // A contract: a page with a signed line.
    case 'contracts':
      return (
        <Outline w={13} h={BOX} color={color} gap={3}>
          <Bar w={7} h={1.5} color={color} />
          <Bar w={4} h={1.5} color={color} />
        </Outline>
      );
    // Ascending bars — money going up, which is what sales reads for.
    case 'sales':
      return (
        <View style={{ width: BOX, height: BOX, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
          <Bar w={3} h={6} color={color} />
          <Bar w={3} h={11} color={color} />
          <Bar w={3} h={BOX} color={color} />
        </View>
      );
    // A card with its stripe — a collection.
    case 'payments':
      return (
        <View style={{ width: BOX, height: 12, justifyContent: 'center' }}>
          <Outline w={BOX} h={12} color={color}>
            <Bar w={BOX - 2} h={3} color={color} />
          </Outline>
        </View>
      );
    // A map pin: a square head on a stem.
    case 'location':
      return (
        <View style={{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center', gap: 1 }}>
          <Outline w={11} h={11} color={color}>
            <Bar w={4} h={4} color={color} />
          </Outline>
          <Bar w={2} h={3} color={color} />
        </View>
      );
    // A wallet with its clasp.
    case 'cash':
      return (
        <View style={{ width: BOX, height: 12, alignItems: 'flex-end', justifyContent: 'center' }}>
          <Outline w={BOX} h={12} color={color} />
          <Bar w={5} h={4} color={color} style={{ position: 'absolute', right: 0 }} />
        </View>
      );
    // A carton — the catalogue's stock.
    case 'products':
      return (
        <Outline w={14} h={14} color={color} gap={0}>
          <Bar w={14} h={1} color={color} />
        </Outline>
      );
    // Sliders — a service configured, not a thing counted.
    case 'services':
      return (
        <View style={{ width: BOX, height: BOX, justifyContent: 'center', gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Bar w={5} h={2} color={color} />
            <Bar w={2} h={2} color={color} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Bar w={2} h={2} color={color} />
            <Bar w={5} h={2} color={color} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Bar w={3} h={2} color={color} />
            <Bar w={4} h={2} color={color} />
          </View>
        </View>
      );
    // A single head, outlined — the person signed in.
    case 'profile':
      return (
        <Outline w={15} h={15} color={color}>
          <Bar w={5} h={5} color={color} />
        </Outline>
      );
  }
}

/** Route → mark. Every routed rail entry has one, so a collapsed rail is never blank. */
const ROUTE_MARKS: Record<string, RailMarkName> = {
  '/dashboard': 'dashboard',
  '/jobs': 'jobs',
  '/jobs/new': 'new',
  '/jobs/logs': 'logs',
  '/customers': 'customers',
  '/contracts': 'contracts',
  '/contracts/new': 'new',
  '/sales': 'sales',
  '/sales/new': 'new',
  '/payments': 'payments',
  '/companies': 'companies',
  '/companies/new': 'new',
  '/employees': 'employees',
  '/location': 'location',
  '/cash': 'cash',
  '/cash/handover': 'cash',
  '/products': 'products',
  '/services': 'services',
  '/profile': 'profile',
};

export function routeMark(route: string): RailMarkName {
  return ROUTE_MARKS[route] ?? 'jobs';
}

/** The mark itself, sized for a rail row. `opacity` dims it without a second colour. */
export function RailMark({
  name,
  color,
  style,
}: {
  name: RailMarkName;
  color: string;
  style?: ViewStyle;
}): React.ReactNode {
  return (
    <View testID={`rail-mark-${name}`} style={[{ width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Mark name={name} color={color} />
    </View>
  );
}

/** The mark's box, for a caller laying out around it. */
export const RAIL_MARK_SIZE = BOX;
/** Left padding every rail row shares, so marks and labels line up in both widths. */
export const RAIL_ROW_PAD = 16;
export const RAIL_MARK_GAP = DESK.rail.barWidth + 10;
/**
 * Collapsed, a row is its mark and nothing else, so the mark is centred in
 * the rail rather than sitting at the expanded padding — the same value the
 * heading's hairline is inset by, which keeps the marks, the separators and
 * the toggle on one vertical line.
 */
export const RAIL_COLLAPSED_PAD = Math.round(
  (DESK.rail.collapsedWidth - DESK.rail.barWidth - RAIL_MARK_SIZE) / 2,
);
