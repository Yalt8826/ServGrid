/**
 * Theme token surface — the complete set from `UI/plan-2/01-FOUNDATIONS.md`,
 * `02-MOTION.md` §1–3, §7–8 and `03-COMPONENTS.md` (the eight states).
 *
 * The safety-yellow accent hex appears only in `../theme.ts` (custom lint
 * rule 1). Every other module imports tokens from here; screens reference
 * semantic aliases, never raw hex.
 *
 * Units: numbers are dp/pt. `slate.400` is `#7C8B9A` — the lightest slate
 * clearing 3:1 on both backgrounds (placeholders, stale inset);
 * `slate.300` is disabled text alone, a deliberate 2.39:1 bounded
 * exception (§1.5).
 */
import { ACCENT } from '../theme.ts';

/** Base palette (§1.1). */
export const COLORS = {
  base: '#16202B',
  muted: '#5A6B7C',
  surface: '#FDFDFB',
  surfaceDense: '#F2F4F7',
  border: '#DDE2E8',
  accent: ACCENT,
  onAccent: '#16202B',
} as const;

/** The slate ramp (§1.2). */
export const SLATE = {
  50: '#F8FAFB', // slate.050 — pressed state on light surfaces
  100: '#F2F4F7', // = surfaceDense
  200: '#DDE2E8', // = border
  300: '#9AA8B5', // disabled text only (2.39:1, bounded exception)
  400: '#7C8B9A', // placeholders, stale inset — clears 3:1 on both
  500: '#5A6B7C', // = muted
  700: '#2C3948',
  900: '#16202B',
} as const;

/**
 * Status colours (§1.3). `in_progress` is accent-deliberate; `overdue` is
 * deliberately absent — it is a filter, not a status, rendered as an
 * outlined danger chip, never a rail.
 */
export const STATUS = {
  completed: '#0F8A5F',
  en_route: '#D98A00',
  in_progress: ACCENT,
  cancelled: '#B3261E',
  unassigned: '#5A6B7C',
} as const;

/** Semantic aliases (§1.4) — screens reference these, never raw hex. */
export const SEMANTIC = {
  text: {
    primary: SLATE[900],
    secondary: SLATE[500],
    placeholder: SLATE[400],
    disabled: SLATE[300],
    onAccent: SLATE[900],
    onDark: COLORS.surface,
    // Secondary text on a dark ground. `text.secondary` (slate.500) is
    // 3.00:1 there — the non-text floor, well under the 4.5:1 a label
    // needs. slate.300 is 6.78:1 on slate.900 and is what the rail's
    // group headings and inactive routes use.
    onDarkSecondary: SLATE[300],
  },
  bg: {
    app: COLORS.surface,
    raised: '#FFFFFF',
    dense: SLATE[100],
    pressed: SLATE[50],
    dark: SLATE[900],
  },
  line: {
    default: SLATE[200],
    strong: SLATE[400],
    focus: SLATE[900],
    stale: SLATE[400],
  },
  feedback: {
    success: '#0F8A5F',
    warning: '#D98A00',
    danger: '#B3261E',
    info: SLATE[500],
  },
} as const;

/**
 * Type ramp (§2). `family` is resolved at runtime by the font loader
 * (`apps/mobile/src/fonts`) — `sans` maps to IBM Plex Sans, `cond` to
 * IBM Plex Sans Condensed. Two families, no third: the `mono` token is
 * Plex Sans at 400 with `tabular-nums`, per PLAN.md §9's "one family,
 * two widths". Neither ever falls back to a system face — the splash
 * gate holds until both are loaded.
 */
export const TYPE = {
  display: { size: 32, lineHeight: 36, weight: '600', family: 'cond' },
  displayLg: { size: 44, lineHeight: 46, weight: '600', family: 'cond' },
  h1: { size: 22, lineHeight: 28, weight: '600', family: 'sans' },
  h2: { size: 18, lineHeight: 24, weight: '600', family: 'sans' },
  body: { size: 16, lineHeight: 22, weight: '400', family: 'sans' },
  bodyStrong: { size: 16, lineHeight: 22, weight: '500', family: 'sans' },
  label: { size: 14, lineHeight: 18, weight: '500', family: 'sans' },
  caption: { size: 13, lineHeight: 16, weight: '400', family: 'sans' },
  // `mono` names the *style*, not a monospace face: PLAN-FRONTEND.md §7
  // reads `mono 15 / 20 Sans 400 tabular`, and PLAN.md §9 is explicit —
  // "one family, two widths". Plex Sans was chosen *because* its tabular
  // figures do this job, so a third family would be both a bundle cost and
  // a different look for every number in the app.
  mono: { size: 15, lineHeight: 20, weight: '400', family: 'sans', tabular: true },
} as const;

/** 4pt space scale (§3). */
export const SPACE = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  12: 48,
  16: 64,
} as const;

/** Tap targets and layout constants (§3). */
export const TAP = {
  min: 52, // field density; gloves, moving vehicle
  console: 44, // console secondary controls only, always + hitSlop 8
  desk: 36, // pointer input
  hitSlop: 8,
  gutterField: 16,
  gutterDesk: 24,
  thumbBar: 72, // fixed bottom action bar height
} as const;

/**
 * Layout caps. A phone has no use for these; a 1900px browser window
 * does — without one, every field on the owner's build stretches the
 * full viewport and the login form reads as a broken page rather than a
 * form. `content` is the reading measure for a single-column screen;
 * `form` is narrower because an input the width of a desk is harder to
 * scan, not easier.
 */
export const LAYOUT = {
  contentMaxWidth: 960,
  formMaxWidth: 420,
  railWidth: 240,
} as const;

/** Radii (§3.2) — square corners on job objects are a signature. */
export const RADII = {
  none: 0, // job cards, status rails, table rows — the docket
  control: 4, // inputs, sheets, chips, buttons
  dialog: 8, // modal dialogs only
  avatar: 999, // avatars only
} as const;

/** The three density modes (§3.3). NavShell sets it, exactly once. */
export type Density = 'field' | 'console' | 'desk';

export const DENSITY: Record<Density, {
  rowHeight: number;
  tapTarget: number;
  bodySize: number;
  gutter: number;
  verticalRhythm: number;
}> = {
  field: { rowHeight: 88, tapTarget: 52, bodySize: 16, gutter: 16, verticalRhythm: 12 },
  console: { rowHeight: 56, tapTarget: 44, bodySize: 15, gutter: 12, verticalRhythm: 8 },
  desk: { rowHeight: 40, tapTarget: 36, bodySize: 14, gutter: 24, verticalRhythm: 6 },
};

/**
 * Elevation (§4) — borders, not shadows, on Android. Three levels;
 * never more than one overlay at a time. Web/desk may add the shadow
 * values from the doc; the flags, not platform checks inside screens,
 * carry the decision.
 */
export const ELEVATION = {
  flat: { borderWidth: 1, borderColor: SEMANTIC.line.default },
  raised: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    webShadow: '0 1px 2px rgba(22,32,43,0.06)',
  },
  overlay: {
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    scrim: 'rgba(22,32,43,0.45)',
    webShadow: '0 8px 24px rgba(22,32,43,0.12)',
  },
} as const;

/**
 * The desk vocabulary — the owner's web console only (OW.2, 2026-09-16).
 *
 * Everything here is additive and read at `desk` density alone, so the
 * technician, dispatcher and rep screens cannot shift a pixel: the phone
 * apps keep their look until the whole-app pass.
 *
 * What it fixes. The console was one flat white page against one flat
 * slate rail, with the 4pt scale applied as though a 1900px window were a
 * 360dp phone — no page rhythm, no card, nothing to tell a section from
 * the gap beside it, and a rail whose only state was "the accent bar is
 * somewhere". The answer is not new colour: it is LAYERS. The page sits
 * one step down (`page.bg`), content sits on white cards a hair above it,
 * and the rail keeps the slate identity while gaining the states a
 * pointer expects — hover, active ground, and the accent still reserved
 * for where you are.
 *
 * Radius 8 on a desk card is a deliberate amendment to §3.2's "square
 * corners are a signature": the square edge belongs to the job docket,
 * and a docket is a phone object. A 1400px console of square white
 * rectangles reads as an unstyled page, which is the complaint this
 * phase exists to answer.
 */
export const DESK = {
  page: {
    /** The console's ground: one step below the cards, so a card is visible without a shadow doing all the work. */
    bg: SLATE[50],
    padX: 32,
    padY: 24,
    /** Between stacked sections — the console's vertical rhythm, not the phone's 12. */
    gap: 24,
    /** Tables want width; past this a line of text stops being scannable. */
    maxWidth: 1440,
  },
  card: {
    bg: '#FFFFFF',
    border: SLATE[200],
    radius: RADII.dialog,
    pad: 20,
    /** Barely there by design: the layer does the work, the shadow only settles it. */
    webShadow: '0 1px 2px rgba(22,32,43,0.06)',
    webShadowHover: '0 4px 14px rgba(22,32,43,0.10)',
  },
  rail: {
    /** 240 as specified (07-OWNER.md) — the width was never the dull part. */
    width: 240,
    bg: SLATE[900],
    /** A pointer needs to see what it is over; slate.700 is the one step up that is not a colour change. */
    hover: SLATE[700],
    activeBg: SLATE[700],
    heading: SLATE[400],
    item: SLATE[300],
    itemActive: COLORS.surface,
    activeBar: COLORS.accent,
    /** 2px, the same bar the phone's tab bar draws — what makes the two layouts one product. */
    barWidth: 2,
    itemHeight: 38,
  },
  /**
   * Categorical colour for charts (OW.3). A stacked bar with eight
   * technicians needs eight tellable-apart inks, which the product's
   * two-colour vocabulary cannot give — and the STATUS palette must not
   * be borrowed, because a green segment that does not mean "completed"
   * is how a colour stops meaning anything. These are chart-only inks:
   * muted, industrial, and never used to say what state a row is in. The
   * accent leads, because the first series is the one being read.
   */
  chart: {
    series: [
      COLORS.accent,
      '#2C6E7F',
      '#8A5A2B',
      '#4B5E8E',
      '#6B7A3A',
      '#8C4A63',
      '#3F7D5B',
      '#7C5E9B',
    ],
    grid: SLATE[200],
    axis: SLATE[500],
  },
  table: {
    headBg: SLATE[100],
    headText: SLATE[500],
    /** Zebra at the lightest slate — a guide for the eye across a wide row, never a border. */
    zebra: SLATE[50],
    rowHover: SLATE[100],
    rowHeight: 44,
  },
} as const;

/**
 * Motion tokens — six durations, four easings, three springs
 * (02-MOTION.md §1–3). Easings are stored as cubic-bezier control
 * points so no import from any animation library is needed at token
 * level; consumers adapt them to their driver. **Never a spring with
 * damping below 15** — visible bounce reads as toy, and this is
 * equipment.
 */
export const DURATION = {
  instant: 0,
  tap: 90,
  quick: 140,
  base: 220,
  considered: 300,
  hero: 520,
} as const;

export const EASING = {
  enter: [0.05, 0.7, 0.1, 1] as const, // arriving — emphasised decelerate
  exit: [0.3, 0, 0.8, 0.15] as const, // leaving — accelerate
  standard: [0.2, 0, 0, 1] as const, // moving within the screen
  linear: [0, 0, 1, 1] as const, // progress indicators only
};

export const SPRING = {
  press: { damping: 26, stiffness: 420, mass: 0.7 }, // ~90ms, no visible overshoot
  sheet: { damping: 30, stiffness: 260, mass: 1 }, // settles ~300ms, hair of overshoot
  snap: { damping: 22, stiffness: 180, mass: 1 }, // gesture release, velocity-carried
} as const;

/**
 * Haptic mapping (02-MOTION.md §8). Values are semantic event names;
 * `apps/mobile` maps them onto `expo-haptics` in one place. Never on
 * scroll, never on every keystroke, never on passive data arrival.
 */
export const HAPTIC_EVENTS = [
  'primaryActionPress',
  'pickerSelect',
  'longPressArmed',
  'jobStatusAdvanced',
  'completionSynced',
  'outboxDrained',
  'syncRejected',
  'destructiveConfirmed',
  'validationFailed',
  'passwordChanged',
] as const;

export type HapticEvent = (typeof HAPTIC_EVENTS)[number];

/**
 * The seven states (03-COMPONENTS.md). Every interactive primitive is
 * specified in all of them; the gallery renders each. There was an eighth,
 * `stale` — local data the server had not confirmed — retired when the app
 * went online-only (decision 2026-09-15): nothing waits on the phone.
 */
export const STATES = [
  'default',
  'pressed',
  'focused',
  'disabled',
  'loading',
  'empty',
  'error',
] as const;

export type ComponentState = (typeof STATES)[number];

/**
 * The dashed inset: a 2px slate.400 dashed left edge. Since the app went
 * online-only it means one thing — a write for this row is on its way to
 * the server (`JobCard`, the job detail header), with `Sending…` beside
 * it. Never a spinner, never greyed out — the data is real.
 */
export const STALE = {
  insetWidth: 2,
  insetColor: SEMANTIC.line.stale,
} as const;
