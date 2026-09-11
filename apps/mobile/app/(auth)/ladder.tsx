/**
 * Permission ladder route (UI/plan-2/08-SHARED-SCREENS.md §X4). Entering
 * after consent at first login, and re-entered whenever tracking health
 * says a step is missing — the ladder is resumable and opens at the
 * failed step. Technician and sales rep only: the dispatcher and the
 * owner are not tracked, so there is nothing for them to grant here.
 *
 * This file is the seam where the pure `LadderScreen` meets the OS: the
 * probes read real permission state, the actions drive the real prompts,
 * intents and settings pages, and each completed step is posted to
 * `/v1/devices` immediately. The background task itself is reached only
 * through `trackingGate` — on web that resolves to a no-op stub and the
 * web bundle never imports the task module.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Redirect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Linking, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../src/lib/api';
import { buildLoginDevice } from '../../src/lib/device';
import { landingRouteFor } from '../../src/routes/landing';
import { matchAutostartVendor } from '../../src/location/autostart';
import { LadderScreen, type LadderDiagnostics } from '../../src/location/ladder';
import { ensureTrackingStarted } from '../../src/location/trackingGate';
import { useSessionStore } from '../../src/state/sessionStore';

/**
 * Steps 3 and 4 cannot be read back from the OS through Expo (no API for
 * `isIgnoringBatteryOptimizations`, none for autostart) — the ladder's
 * only memory of them is these local records, written when the OS or the
 * user said "done". A reinstall clears them, which is honest: an
 * uninstall resets both settings too, so the steps are re-walked.
 */
const BATTERY_FLAG_KEY = 'servgrid.ladder.batteryExempt';
const AUTOSTART_FLAG_KEY = 'servgrid.ladder.autostartConfirmed';

/** Android's action that opens an activity by component name. */
const ACTION_MAIN = 'android.intent.action.MAIN';

async function readFlag(key: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key)) === '1';
  } catch {
    return false;
  }
}

async function writeFlag(key: string): Promise<boolean> {
  try {
    await AsyncStorage.setItem(key, '1');
    return true;
  } catch {
    return false;
  }
}

export default function LadderRoute() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const [vendor] = useState(() => matchAutostartVendor(Device.manufacturer ?? Device.deviceName ?? null));

  useEffect(() => {
    // The task definition registers at module scope (via the gate's
    // import); if background permission is already granted — a returning
    // technician whose tracking died with a reinstall — tracking starts
    // again here, without waiting for the ladder to be walked.
    void ensureTrackingStarted().catch(() => {});
  }, []);

  if (actor === null) {
    return <Redirect href="/login" />;
  }
  if (actor.role === 'dispatcher' || actor.role === 'owner') {
    return <Redirect href={landingRouteFor(actor.role)} />;
  }

  async function postDiagnostics(partial: LadderDiagnostics): Promise<boolean> {
    const result = await api.request('POST', '/v1/devices', {
      body: { ...(await buildLoginDevice()), ...partial },
    });
    // The moment background permission is confirmed granted is the
    // earliest honest moment to start the foreground service.
    if (result.ok && partial.locationPermission === 'background') {
      await ensureTrackingStarted();
    }
    return result.ok;
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'bottom', 'left', 'right']}
    >
      <LadderScreen
        vendor={vendor}
        onDone={() => router.replace(landingRouteFor(actor.role))}
        postDiagnostics={postDiagnostics}
        subscribeForeground={(listener) => {
          const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') listener();
          });
          return () => subscription.remove();
        }}
        probe={{
          foregroundLocation: async () => (await Location.getForegroundPermissionsAsync()).granted,
          backgroundLocation: async () => (await Location.getBackgroundPermissionsAsync()).granted,
          batteryExempt: () => readFlag(BATTERY_FLAG_KEY),
          autostartConfirmed: () => readFlag(AUTOSTART_FLAG_KEY),
          notifications: async () => {
            const settings = await Notifications.getPermissionsAsync();
            return settings.granted;
          },
        }}
        actions={{
          requestForeground: async () => (await Location.requestForegroundPermissionsAsync()).granted,
          openSettings: async () => {
            await Linking.openSettings();
          },
          requestBatteryExemption: async () => {
            const pkg = Constants.expoConfig?.android?.package;
            if (pkg === undefined) return false;
            const result = await IntentLauncher.startActivityAsync(
              IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              { data: `package:${pkg}` },
            );
            const granted = result.resultCode === IntentLauncher.ResultCode.Success;
            if (granted) await writeFlag(BATTERY_FLAG_KEY);
            return granted;
          },
          openAutostart: async () => {
            for (const component of vendor?.activities ?? []) {
              const [pkg, cls] = component.split('/');
              if (pkg === undefined || cls === undefined) continue;
              try {
                await IntentLauncher.startActivityAsync(ACTION_MAIN, { packageName: pkg, className: cls });
                return; // the activity opened — the walkthrough did its job
              } catch {
                // Activity not present on this OS generation — try the
                // next candidate, then fall back to the settings page.
              }
            }
            await Linking.openSettings();
          },
          confirmAutostart: () => writeFlag(AUTOSTART_FLAG_KEY),
          requestNotifications: async () => (await Notifications.requestPermissionsAsync()).granted,
        }}
      />
    </SafeAreaView>
  );
}
