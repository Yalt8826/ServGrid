/**
 * The OEM autostart roster (UI/plan-2/08-SHARED-SCREENS.md §X4, PLAN.md
 * §7): Xiaomi, Realme, Vivo, Oppo and OnePlus each hide autostart
 * somewhere different, and the paths change between OS versions. There
 * is no API to verify the setting, so this screen's contract with the
 * truth is: deep-link attempts in order, fall back to the app's settings
 * page, show exactly what to tap, and accept an "I've done this".
 *
 * The candidate activity names are the widely documented paths per
 * vendor/OS generation; the device tries them in order and any failure
 * falls through — a wrong guess degrades to Settings, never to a dead
 * button.
 *
 * `screenshots` holds the per-step photographs FROM THE ACTUAL HANDSETS.
 * Phase 1 entry gates on borrowing one handset per OEM long enough to
 * photograph these paths (docs/UI/plan-2/08-SHARED-SCREENS.md §X4);
 * until those photographs are captured each slot stays null and the
 * walkthrough shows its written step alone. Slots expect the images at
 * `apps/mobile/assets/autostart/<vendor>-<n>.png`, wired in with
 * `require()` at that point — real photographs only, never placeholders.
 *
 * Pure data — imported by the ladder UI (`ladder.tsx`), which the router
 * bundles for both platforms, so this file stays free of native imports.
 */

export interface AutostartVendor {
  /** Lowercase `Device.manufacturer` / brand substrings matched. */
  match: string[];
  /** Display name for the screen's heading. */
  name: string;
  /** `<package>/<activity>` candidates, tried in order. */
  activities: string[];
  /** The walkthrough steps, in order, as the user performs them. */
  steps: string[];
  /** One photograph per step, from the actual handset. null until
   * captured (phase entry gate — see file comment). */
  screenshots: (number | null)[];
}

export const AUTOSTART_VENDORS: AutostartVendor[] = [
  {
    match: ['xiaomi', 'redmi', 'poco'],
    name: 'Xiaomi',
    activities: [
      'com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity',
      'com.miui.securitycenter/com.miui.powercenter.PowerSettings',
    ],
    steps: [
      'Open “Autostart” in Security',
      'Find ServGrid in the list',
      'Turn the Autostart switch on',
    ],
    screenshots: [null, null, null],
  },
  {
    match: ['realme'],
    name: 'Realme',
    activities: [
      'com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity',
      'com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity',
    ],
    steps: [
      'Open “App management” in Phone Manager',
      'Tap “App auto-startup”',
      'Allow ServGrid to start automatically',
    ],
    screenshots: [null, null, null],
  },
  {
    match: ['vivo', 'iqoo'],
    name: 'Vivo',
    activities: [
      'com.vivo.permissionmanager/com.vivo.permissionmanager.activity.BgStartUpManagerActivity',
      'com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.BgStartUpManager',
      'com.iqoo.secure/com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity',
    ],
    steps: [
      'Open Settings → Battery → Background power consumption management',
      'Choose ServGrid',
      'Allow “High background power consumption”',
    ],
    screenshots: [null, null, null],
  },
  {
    match: ['oppo'],
    name: 'Oppo',
    activities: [
      'com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity',
      'com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity',
    ],
    steps: [
      'Open Phone Manager → Privacy permissions',
      'Tap “Startup manager”',
      'Allow ServGrid to start automatically',
    ],
    screenshots: [null, null, null],
  },
  {
    match: ['oneplus'],
    name: 'OnePlus',
    activities: [
      'com.oneplus.security/com.oneplus.security.chainlaunch.ChainLaunchAppListActivity',
      'com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity',
    ],
    steps: [
      'Open Battery settings → “App auto-launch”',
      'Find ServGrid in the list',
      'Turn auto-launch on',
    ],
    screenshots: [null, null, null],
  },
];

/** Manufacturer → vendor, or null when the handset is not on the roster.
 * Unrostered handsets get the generic fallback screen, not a wrong
 * vendor's walkthrough. */
export function matchAutostartVendor(manufacturer: string | null | undefined): AutostartVendor | null {
  const brand = (manufacturer ?? '').trim().toLowerCase();
  if (brand === '') return null;
  return AUTOSTART_VENDORS.find((vendor) => vendor.match.some((m) => brand.includes(m))) ?? null;
}
