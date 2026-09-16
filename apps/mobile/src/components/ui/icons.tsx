/**
 * The app's one icon vocabulary (mobile UI overhaul, 2026-09-16).
 *
 * Screens name an icon by **what it means** (`clock`, `navigate`,
 * `warning`), never by which glyph draws it. Every glyph in the product
 * therefore comes from this file: swapping the set is one edit, and a
 * screen cannot quietly pull in a second family's tone — the drifting
 * look the design system exists to prevent.
 *
 * Ionicons because it is the set Expo ships with `@expo/vector-icons`
 * (no extra native dependency, no rebuild) and its geometry is plain
 * enough to sit beside IBM Plex without competing with it. One family
 * only, like one type family.
 *
 * Rules this file enforces by construction:
 *
 * - **An icon never carries meaning alone.** Every icon this app renders
 *   sits beside its own word (`Icon` + a `Text`), because the app is read
 *   in a van, outdoors, one-handed. A camera glyph with no "Photos" label
 *   is a shape, not an instruction.
 * - **An icon is never the only accent on a screen.** Icons take
 *   `SEMANTIC.text.*` or the tone they belong to; the accent stays with
 *   the action (see `FRAME`'s note in the shared tokens).
 */
import { Ionicons } from '@expo/vector-icons';

/**
 * Meaning → glyph. Adding a name here is the only way to render an icon,
 * and the `keyof` type below makes every call site check against it.
 *
 * The glyph names are Ionicons' own; the keys are ours. Where the two
 * disagree (`jobs` → `clipboard-outline`) ours wins.
 */
const GLYPH = {
  // Navigation — the four tabs of a field role.
  dashboard: 'grid-outline',
  jobs: 'clipboard-outline',
  cash: 'cash-outline',
  profile: 'person-outline',
  // Movement and time.
  navigate: 'navigate-outline',
  clock: 'time-outline',
  calendar: 'calendar-outline',
  refresh: 'refresh',
  // Contact and place.
  phone: 'call-outline',
  location: 'location-outline',
  // State.
  warning: 'warning-outline',
  alert: 'alert-circle-outline',
  check: 'checkmark-circle-outline',
  checkFilled: 'checkmark-circle',
  info: 'information-circle-outline',
  tick: 'checkmark',
  close: 'close',
  // Disclosure and direction.
  chevronRight: 'chevron-forward',
  chevronDown: 'chevron-down',
  chevronUp: 'chevron-up',
  forward: 'arrow-forward',
  // Work objects.
  wrench: 'construct-outline',
  cube: 'cube-outline',
  camera: 'camera-outline',
  document: 'document-text-outline',
  business: 'business-outline',
  people: 'people-outline',
  wallet: 'wallet-outline',
  // Controls and account.
  plus: 'add',
  search: 'search-outline',
  list: 'list-outline',
  edit: 'create-outline',
  key: 'key-outline',
  logout: 'log-out-outline',
  send: 'paper-plane-outline',
  trending: 'trending-up',
  // The tracking ladder's four steps.
  shield: 'shield-checkmark-outline',
  battery: 'battery-half-outline',
  rocket: 'rocket-outline',
  bell: 'notifications-outline',
} as const;

export type IconName = keyof typeof GLYPH;

export interface IconProps {
  name: IconName;
  /** One of `ICON`'s four steps — never a free number. */
  size?: number;
  color: string;
  testID?: string;
}

export function Icon({ name, size = 20, color, testID }: IconProps): React.ReactNode {
  return <Ionicons name={GLYPH[name]} size={size} color={color} testID={testID} />;
}
