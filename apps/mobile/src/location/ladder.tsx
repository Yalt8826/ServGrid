/**
 * The permission ladder (UI/plan-2/08-SHARED-SCREENS.md §X4, PLAN.md §7,
 * PLAN-FRONTEND.md §6). Four steps, each its own screen, each with its
 * own explanation, resumable, showing `Step N of 4`:
 *
 *   1. Foreground location — in-flow prompt.
 *   2. Background location — cannot be requested in-flow on Android 11+.
 *      The screen explains why, quotes the Android wording verbatim
 *      (*Tap Permissions → Location → Allow all the time*), then
 *      `Linking.openSettings()`. The app polls on foreground return and
 *      advances automatically — the user never has to tell the app they
 *      did it.
 *   3. Battery optimisation — `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
 *   4. OEM autostart — manufacturer-detected deep link plus a screenshot
 *      walkthrough per vendor, ending in "I've done this", because there
 *      is no API to verify it.
 *
 * Notification permission comes AFTER the ladder, not inside it (the
 * Android 13+ prompt): a refusal must not strand anyone mid-ladder, and
 * a refusal is not fatal — tracking is unaffected and the fourth
 * TrackingHealthChip state reports it.
 *
 * Each completed step posts to `/v1/devices` immediately — the health
 * chip is only truthful if the server knows what was actually granted.
 *
 * This component is pure UI over injected seams (`LadderDeps`): the
 * probes read OS truth, the actions drive it. All native wiring lives in
 * the route file, which is also why no import here needs a platform
 * suffix — the file itself is shared, and its seams are the test points
 * (`ladder.test.tsx` drives every rule above through fakes).
 *
 * The background task (`task.native.ts`) is NOT imported here — the web
 * bundle renders routes too, and it must never import one.
 */
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FRAME, ICON, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button } from '../components/ui';
import { Icon, type IconName } from '../components/ui/icons';
import { textStyle } from '../fonts/textStyle';
import { matchAutostartVendor, type AutostartVendor } from './autostart';

export type LadderPermission = 'none' | 'foreground' | 'background';

/** The four diagnostics `POST /v1/devices` carries (deviceUpsertSchema). */
export interface LadderDiagnostics {
  locationPermission?: LadderPermission;
  batteryOptExempt?: boolean;
  autostartConfirmed?: boolean;
  notificationsEnabled?: boolean;
}

/** Merges the partial into the device row and posts it. True on 2xx. */
export type PostDiagnostics = (partial: LadderDiagnostics) => Promise<boolean>;

/** Reads OS truth. Never asks the user anything. */
export interface LadderProbe {
  foregroundLocation(): Promise<boolean>;
  backgroundLocation(): Promise<boolean>;
  batteryExempt(): Promise<boolean>;
  /** Local "I've done this" record — autostart has no API to verify. */
  autostartConfirmed(): Promise<boolean>;
  notifications(): Promise<boolean>;
}

/** Drives OS surfaces. Each returns what the OS actually said. */
export interface LadderActions {
  /** Step 1: the in-flow prompt. */
  requestForeground(): Promise<boolean>;
  /** Step 2: deep-link into the app's settings page. */
  openSettings(): Promise<void>;
  /** Step 3: the battery-optimisation intent. True = exemption granted. */
  requestBatteryExemption(): Promise<boolean>;
  /** Step 4: the vendor deep link (falls back to settings). */
  openAutostart(): Promise<void>;
  /** Step 4: records "I've done this" locally. */
  confirmAutostart(): Promise<boolean>;
  /** After the ladder: the Android 13+ notifications prompt. */
  requestNotifications(): Promise<boolean>;
}

/** Foreground-return subscription — the seam step 2 polls on. */
export type SubscribeForeground = (listener: () => void) => () => void;

export interface LadderDeps {
  probe: LadderProbe;
  actions: LadderActions;
  postDiagnostics: PostDiagnostics;
  subscribeForeground: SubscribeForeground;
  /** Manufacturer-detected vendor, or null for the generic walkthrough. */
  vendor: AutostartVendor | null;
  /** The ladder closed (finished or deferred). */
  onDone: () => void;
}

export const STEP_COUNT = 4;

type StepIndex = 1 | 2 | 3 | 4;

type Phase = { kind: 'loading' } | { kind: 'step'; step: StepIndex } | { kind: 'notifications' } | { kind: 'done' };

const STEPS: readonly StepIndex[] = [1, 2, 3, 4];

/** Each step's glyph — `icons.tsx` added these four for this screen and
 * the restyle finally hangs them up (2026-09-17). The mark names WHAT the
 * step is about before a word is read: shield = location permission,
 * battery = the exemption, rocket = autostart, bell = job alerts. */
const STEP_ICONS: Record<StepIndex, IconName> = {
  1: 'shield',
  2: 'shield',
  3: 'battery',
  4: 'rocket',
};

/** Shown when the immediate `/v1/devices` post fails: the step still
 * counts — OS truth survives — and the server learns on a later
 * foreground permission report. Never blocks the user's progress. */
const POST_FAILED_BANNER =
  'The server could not be reached. Your choice is saved on this phone and is reported the next time the app has a connection.';

const STEP_TITLES: Record<StepIndex, string> = {
  1: 'Location while using',
  2: 'Location all the time',
  3: 'Battery optimisation',
  4: 'Allow autostart',
};

/** Step 2's verbatim quote — the exact words Android shows (§X4). */
const STEP2_PATH_PARTS: Array<{ text: string; bold?: boolean }> = [
  { text: 'Tap ' },
  { text: 'Permissions', bold: true },
  { text: ' → ' },
  { text: 'Location', bold: true },
  { text: ' → ' },
  { text: 'Allow all the time', bold: true },
];

export function stepTitleOf(step: StepIndex): string {
  return `Step ${step} of ${STEP_COUNT}`;
}

export function LadderScreen(deps: LadderDeps): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const working = useRef(false);

  // Resumable: the ladder opens at the first incomplete step, judged by
  // OS truth — never by a stored "where was I" that can lie.
  useEffect(() => {
    void (async () => {
      for (const step of STEPS) {
        let granted = false;
        try {
          granted = await probeFor(deps, step);
        } catch {
          granted = false;
        }
        if (!granted) {
          setPhase({ kind: 'step', step });
          return;
        }
      }
      let notifications = false;
      try {
        notifications = await deps.probe.notifications();
      } catch {
        notifications = false;
      }
      setPhase(notifications ? { kind: 'done' } : { kind: 'notifications' });
      if (notifications) deps.onDone();
    })();
  }, []);

  // Step 2 polls on foreground return: Android will not ask in-flow, so
  // the app checks by itself when the user comes back from Settings and
  // advances without anyone telling it they did it (§X4).
  useEffect(() => {
    if (phase.kind !== 'step' || phase.step !== 2) return;
    return deps.subscribeForeground(() => {
      void (async () => {
        if (working.current) return;
        working.current = true;
        try {
          if (await deps.probe.backgroundLocation()) {
            await completeStep({ locationPermission: 'background' }, 2);
          }
        } catch {
          // Stay on the step; the next foreground return polls again.
        } finally {
          working.current = false;
        }
      })();
    });
  }, [phase]);

  function probeFor(d: LadderDeps, step: StepIndex): Promise<boolean> {
    switch (step) {
      case 1:
        return d.probe.foregroundLocation();
      case 2:
        return d.probe.backgroundLocation();
      case 3:
        return d.probe.batteryExempt();
      case 4:
        return d.probe.autostartConfirmed();
    }
  }

  /** Posts the step's diagnostics, then walks forward from the completed
   * step — if later steps are already satisfied (a handset set up before,
   * an OEM that grants both permissions at once) it lands on the first
   * one that still needs the user. */
  async function completeStep(partial: LadderDiagnostics, completed: StepIndex): Promise<void> {
    setBanner(null);
    let posted = false;
    try {
      posted = await deps.postDiagnostics(partial);
    } catch {
      posted = false;
    }
    if (!posted) setBanner(POST_FAILED_BANNER);
    await advanceFrom(completed);
  }

  async function advanceFrom(completed: StepIndex): Promise<void> {
    for (const step of STEPS.filter((s) => s > completed)) {
      let granted = false;
      try {
        granted = await probeFor(deps, step);
      } catch {
        granted = false;
      }
      if (!granted) {
        setPhase({ kind: 'step', step });
        return;
      }
    }
    let notifications = false;
    try {
      notifications = await deps.probe.notifications();
    } catch {
      notifications = false;
    }
    if (notifications) {
      setPhase({ kind: 'done' });
      deps.onDone();
    } else {
      setPhase({ kind: 'notifications' });
    }
  }

  /** A step's primary action completed successfully. */
  async function runStep(step: StepIndex, action: () => Promise<boolean>): Promise<void> {
    if (busy || working.current) return;
    setBusy(true);
    try {
      // Step 1 posts what is actually true afterwards: a handset that
      // already granted background reports `background`, not `foreground`.
      if (step === 1) {
        const backgroundAlso = await deps.probe.backgroundLocation();
        if (await action()) {
          await completeStep({ locationPermission: backgroundAlso ? 'background' : 'foreground' }, 1);
        } else {
          setBanner('Location is still off. Tracking needs it to show you are on site — you can allow it any time.');
        }
        return;
      }
      if (step === 3) {
        if (await action()) {
          await completeStep({ batteryOptExempt: true }, 3);
        } else {
          setBanner('The exemption was not granted. Tracking may be slowed when the phone rests — you can try again.');
        }
        return;
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmAutostart(): Promise<void> {
    if (busy || working.current) return;
    setBusy(true);
    try {
      // There is no API to verify autostart; the user's word is the
      // contract, and it posts `autostart_confirmed` (§X4).
      await deps.actions.confirmAutostart();
      await completeStep({ autostartConfirmed: true }, 4);
    } catch {
      setBanner('That could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function allowNotifications(): Promise<void> {
    if (busy || working.current) return;
    setBusy(true);
    try {
      const granted = await deps.actions.requestNotifications();
      // A refusal is not fatal (§X4) — it is reported either way, so the
      // fourth chip state can tell the truth about alerts.
      await completeStepOnly({ notificationsEnabled: granted });
    } catch {
      setBanner('That could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  /** The notification ask sits after the ladder; posting it never
   * advances a step — it closes the flow either way. */
  async function completeStepOnly(partial: LadderDiagnostics): Promise<void> {
    setBanner(null);
    let posted = false;
    try {
      posted = await deps.postDiagnostics(partial);
    } catch {
      posted = false;
    }
    if (!posted) setBanner(POST_FAILED_BANNER);
    setPhase({ kind: 'done' });
    deps.onDone();
  }

  function declineNotifications(): void {
    // "Not now" posts nothing it does not know; the device row keeps its
    // previous value and the chip keeps saying alerts are off until the
    // OS reports otherwise. A refusal must not strand anyone here (§X4).
    setPhase({ kind: 'done' });
    deps.onDone();
  }

  if (phase.kind === 'loading' || phase.kind === 'done') return null;

  const vendor = deps.vendor;

  const phaseIcon: IconName = phase.kind === 'notifications' ? 'bell' : STEP_ICONS[phase.step];
  const phaseHeading = phase.kind === 'notifications' ? 'New job assignments' : STEP_TITLES[phase.step];
  const phaseLabel = phase.kind === 'notifications' ? 'Job alerts' : stepTitleOf(phase.step);

  return (
    // The app's ground on the ScrollView itself, not only the route's
    // wrapper: the steps vary in length, and where short content ends the
    // ground must still be the page's own (2026-09-16's stripe lesson).
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="ladder-screen">
      {/* The frame (2026-09-17): the glyph names the step, the counter
          says where in the ladder we are, and the title says what it asks.
          The counter keeps its testID on the single Text the tests read. */}
      <View style={styles.frame}>
        <View style={styles.frameMark}>
          <Icon name={phaseIcon} size={ICON.md} color={FRAME.text} />
        </View>
        <View style={styles.frameBody}>
          <Text style={styles.stepTitle} testID="ladder-step-title">
            {phaseLabel}
          </Text>
          <Text style={styles.heading}>{phaseHeading}</Text>
        </View>
      </View>

      {banner !== null ? <Banner tone="danger" message={banner} testID="ladder-banner" /> : null}

      {phase.kind === 'step' && phase.step === 1 ? (
        <>
          <Text style={styles.body}>
            ServGrid uses your location during work hours, so the office can see which jobs are covered.
          </Text>
          <Text style={styles.body}>Allow location access “While using the app”.</Text>
          <Button
            label="Allow location"
            onPress={() => void runStep(1, deps.actions.requestForeground)}
            loading={busy}
            fullwidth
            testID="ladder-step-action"
          />
        </>
      ) : null}

      {phase.kind === 'step' && phase.step === 2 ? (
        <>
          <Text style={styles.body}>
            Tracking must keep running with the app closed — that is what tells the office you are on site.
          </Text>
          <Text style={styles.body}>
            Android does not let the app ask for this directly, so the Settings app opens. There:
          </Text>
          <View style={styles.quote}>
            <Text style={styles.quoteText}>
              {STEP2_PATH_PARTS.map((part, i) =>
                part.bold ? (
                  <Text key={i} style={styles.quoteBold}>
                    {part.text}
                  </Text>
                ) : (
                  <Text key={i}>{part.text}</Text>
                ),
              )}
            </Text>
            {/* The words are Android's, so the frame is Android's: this is
                a quotation, not a ServGrid instruction. */}
            <Text style={styles.quoteSource}>— the Android Settings screen</Text>
          </View>
          <Button
            label="Open settings"
            onPress={() => void deps.actions.openSettings()}
            fullwidth
            testID="ladder-step-action"
          />
          <Text style={styles.hint}>The app checks by itself when you come back — you do not need to tell it.</Text>
        </>
      ) : null}

      {phase.kind === 'step' && phase.step === 3 ? (
        <>
          <Text style={styles.body}>
            Phones stop background apps to save battery. The exemption lets tracking keep its 15-minute rhythm
            through the work day.
          </Text>
          <Button
            label="Allow — ignore battery optimisation"
            onPress={() => void runStep(3, deps.actions.requestBatteryExemption)}
            loading={busy}
            fullwidth
            testID="ladder-step-action"
          />
        </>
      ) : null}

      {phase.kind === 'step' && phase.step === 4 ? (
        <>
          <Text style={styles.body}>
            {vendor !== null
              ? `${vendor.name} phones stop apps their own way. Autostart lets ServGrid keep tracking after a restart.`
              : 'Some phones stop apps their own way. Autostart lets ServGrid keep tracking after a restart.'}
          </Text>
          {(vendor !== null ? vendor : GENERIC_VENDOR).steps.map((step, i) => (
            <View key={`${i}-${step}`} style={styles.walkthroughStep}>
              {/* A number, not a dot: the steps are a procedure, and the
                  order is the content (2026-09-17). */}
              <View style={styles.walkthroughDot}>
                <Text style={styles.walkthroughNum}>{i + 1}</Text>
              </View>
              <View style={styles.walkthroughText}>
                <Text style={styles.body}>{step}</Text>
                <Screenshot image={(vendor !== null ? vendor : GENERIC_VENDOR).screenshots[i] ?? null} />
              </View>
            </View>
          ))}
          <Button
            label="Open autostart settings"
            variant="secondary"
            onPress={() => void deps.actions.openAutostart()}
            fullwidth
            testID="ladder-autostart-open"
          />
          <Button
            label="I've done this"
            onPress={() => void confirmAutostart()}
            loading={busy}
            fullwidth
            testID="ladder-autostart-confirm"
          />
        </>
      ) : null}

      {phase.kind === 'notifications' ? (
        <>
          <Text style={styles.body}>
            ServGrid can tell you the moment a job is assigned to you. This is separate from tracking — turning it
            down does not affect your work.
          </Text>
          <Button
            label="Allow job alerts"
            onPress={() => void allowNotifications()}
            loading={busy}
            fullwidth
            testID="ladder-notifications-allow"
          />
          <Button label="Not now" variant="ghost" onPress={declineNotifications} fullwidth testID="ladder-notifications-decline" />
        </>
      ) : null}

      {/* Sealed off from the step above by the app's own hairline: the
          escape is a decision, and it reads as one. */}
      <View style={styles.deferWrap}>
        <Button
          label="Finish later"
          icon="forward"
          variant="ghost"
          onPress={() => {
            setPhase({ kind: 'done' });
            deps.onDone();
          }}
          fullwidth
          testID="ladder-defer"
        />
        <Text style={styles.footer}>You can finish this later from Profile → Tracking.</Text>
      </View>
    </ScrollView>
  );
}

function Screenshot({ image }: { image: number | null }): React.ReactNode {
  // Real photographs from the roster's handsets land here — never
  // placeholders (§X4). A missing photograph degrades to the written
  // step alone.
  if (image === null) return null;
  return <Image source={image} style={styles.screenshot} resizeMode="contain" />;
}

const GENERIC_VENDOR: AutostartVendor = {
  match: [],
  name: 'Generic',
  activities: [],
  steps: [
    'Open your phone’s Settings',
    'Look for “Autostart”, “Startup manager” or “App auto-launch”',
    'Allow ServGrid',
  ],
  screenshots: [null, null, null],
};

// matchAutostartVendor is re-exported for the route's convenience and
// kept in `autostart.ts` (pure data, unit-testable without rendering).
export { matchAutostartVendor };

const styles = StyleSheet.create({
  /** The page's own ground, on the scroll itself (2026-09-16's stripe
   * lesson): steps vary in length, and short content must not leave a
   * stripe of something else below it. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  // Top-aligned: step 4 carries three walkthrough rows plus screenshots,
  // and a vertically-centred column of that length reads as broken.
  content: {
    flexGrow: 1,
    paddingTop: SPACE[2],
    paddingBottom: SPACE[6],
    paddingHorizontal: SPACE[4],
  },
  /** The frame: the step's glyph, its place in the ladder, and the ask. */
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    backgroundColor: FRAME.bg,
    borderRadius: RADII.control,
    paddingHorizontal: SPACE[4],
    paddingVertical: SPACE[4],
    marginBottom: SPACE[4],
  },
  frameMark: {
    width: 44,
    height: 44,
    borderRadius: RADII.control,
    backgroundColor: FRAME.bgSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameBody: { flex: 1, gap: 2 },
  stepTitle: {
    ...textStyle('caption'),
    color: FRAME.textMuted,
  },
  heading: {
    ...textStyle('h2'),
    color: FRAME.text,
  },
  body: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[3],
  },
  /** Step 2's quotation of the Android Settings screen — quoted matter
   * gets a ground, not just italics. */
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: SEMANTIC.line.strong,
    paddingLeft: SPACE[3],
    paddingVertical: SPACE[2],
    marginBottom: SPACE[4],
    backgroundColor: SEMANTIC.bg.raised,
    borderRadius: RADII.control,
  },
  quoteText: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  quoteBold: {
    fontWeight: '700',
  },
  quoteSource: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[1],
  },
  hint: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[3],
  },
  walkthroughStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: SPACE[3],
  },
  /** The procedure's number: order is the content of a walkthrough. */
  walkthroughDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: SEMANTIC.bg.dark,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACE[3],
  },
  walkthroughNum: { ...textStyle('caption'), color: SEMANTIC.text.onDark },
  walkthroughText: {
    flex: 1,
  },
  /** The vendor screenshot's bounded box: `require()` numbers and
   * `resizeMode="contain"` are load-bearing (the only Image in the app
   * with a numeric source), and a 3:4 phone photo needs the height floor. */
  screenshot: {
    width: '100%',
    height: 220,
    marginTop: SPACE[2],
    marginBottom: SPACE[2],
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  deferWrap: {
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    marginTop: SPACE[5],
    paddingTop: SPACE[2],
  },
  footer: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    textAlign: 'center',
    marginTop: SPACE[4],
    marginBottom: SPACE[2],
  },
});
