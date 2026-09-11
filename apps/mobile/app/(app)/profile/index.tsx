/**
 * Profile route (UI/plan-2/04-TECHNICIAN.md §T7). The seam where the
 * pure `ProfileScreen` meets the OS and the session, exactly as the
 * ladder route does:
 *
 * - health comes from the self-scoped view read (`/v1/location/health/me`,
 *   T1.12) — real view data, never a stored state;
 * - the four ladder rows are judged by OS truth plus the same local
 *   records the ladder writes (`AsyncStorage` flags for the two steps
 *   Android cannot read back), so the rows and the ladder can never
 *   disagree;
 * - the chip's red/amber taps navigate to the ladder, which opens at the
 *   failed step by its own probe — a stored hint can lie, the probe
 *   cannot;
 * - logout ends the session via the API client and the session store;
 *   the root index redirects to login.
 *
 * The logout gate's count is the outbox's queued+inflight rows for this
 * employee, `rejected`/`failed` excluded by contract (PLAN-FRONTEND.md
 * §5). The outbox itself is T1.14 — not merged when this screen ships —
 * so the route feeds the honest count of the queue that exists today
 * (zero: there is nowhere for a row to wait yet). When T1.14 lands, the
 * drain's pending count replaces the literal; the screen is already
 * driven by the seam, so no screen code changes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppState } from 'react-native';

import type { TrackingHealth } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { matchAutostartVendor } from '../../../src/location/autostart';
import { ProfileScreen, type LadderRowState } from '../../../src/screens/technician/ProfileScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

/** Same keys, same semantics, as the ladder route — one memory between
 * the two screens, or the rows would contradict the ladder. */
const BATTERY_FLAG_KEY = 'servgrid.ladder.batteryExempt';
const AUTOSTART_FLAG_KEY = 'servgrid.ladder.autostartConfirmed';

async function readFlag(key: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(key)) === '1';
  } catch {
    return false;
  }
}

export default function Screen() {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);

  const loadLadderRows = async (): Promise<LadderRowState[]> => {
    const vendor = matchAutostartVendor(Device.manufacturer ?? Device.deviceName ?? null);
    let foreground = false;
    let background = false;
    try {
      foreground = (await Location.getForegroundPermissionsAsync()).granted;
      background = (await Location.getBackgroundPermissionsAsync()).granted;
    } catch {
      // Unreadable OS truth renders as not-granted, never as a crash.
    }
    const [battery, autostart] = await Promise.all([
      readFlag(BATTERY_FLAG_KEY),
      readFlag(AUTOSTART_FLAG_KEY),
    ]);
    return [
      {
        step: 1,
        title: 'Location while using',
        stateText: foreground ? 'Granted' : 'Not confirmed',
        done: foreground,
      },
      {
        step: 2,
        title: 'Location all the time',
        stateText: background ? 'Granted' : 'Not confirmed',
        done: background,
      },
      {
        step: 3,
        title: 'Battery optimisation',
        stateText: battery ? 'Exempt' : 'Not confirmed',
        done: battery,
      },
      {
        step: 4,
        title: `${vendor?.name ?? 'OEM'} autostart`,
        stateText: autostart ? 'Confirmed' : 'Not confirmed',
        done: autostart,
      },
    ];
  };

  if (actor === null) return null;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <ProfileScreen
        username={actor.username}
        role={actor.role === 'sales_rep' ? 'Sales rep' : actor.role.charAt(0).toUpperCase() + actor.role.slice(1)}
        appVersion={Constants.expoConfig?.version ?? 'dev'}
        deviceModel={Device.modelName ?? Device.modelId ?? 'unknown'}
        loadHealth={async () => {
          const res = await api.request<TrackingHealth>('GET', '/v1/location/health/me');
          if (!res.ok || res.data === null) throw new Error(res.error?.message ?? '');
          return res.data;
        }}
        loadLadderRows={loadLadderRows}
        // T1.14's outbox is the real source. Until it merges there is no
        // queue: zero is the honest count, and the gate stays open.
        pendingSyncCount={0}
        retrySync={() => {
          // The drain arrives with T1.14; today a retry has nothing to drain.
        }}
        logout={() => {
          void (async () => {
            await api.logout();
            useSessionStore.getState().setAnonymous();
            // The root index owns the redirect; this replace just avoids
            // a frame of the old screen on the way there.
            router.replace('/login');
          })();
        }}
        openLadder={(target) => {
          // The ladder probes OS truth and opens at the failed step by
          // itself (T1.16); the target from the chip only confirms the
          // entry is deliberate, it is not trusted as position.
          void target;
          router.push('/ladder');
        }}
        changePassword={() => router.push('/change-password')}
        subscribeForeground={(listener) => {
          const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') listener();
          });
          return () => subscription.remove();
        }}
      />
    </SafeAreaView>
  );
}
