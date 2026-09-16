/**
 * Profile route (UI/plan-2/04-TECHNICIAN.md §T7, UI/plan-2/05-DISPATCHER.md
 * §D6, T2.10). The seam where the pure profile screens meet the OS and
 * the session — and, since T2.10, a ROLE SPLIT, because the two roles'
 * profiles are deliberately different shapes:
 *
 * **Technician (and rep/owner, until their own phases):** the §T7
 * screen —
 *
 * - health comes from the self-scoped view read (`/v1/location/health/me`,
 *   T1.12) — real view data, never a stored state;
 * - the four ladder rows are judged by OS truth plus the same server
 *   record the ladder writes (the device row's battery and autostart
 *   diagnostics, `GET /v1/devices/me`), so the rows and the ladder can
 *   never disagree — and nothing is remembered on the phone;
 * - the chip's red/amber taps navigate to the ladder, which opens at the
 *   failed step by its own probe — a stored hint can lie, the probe
 *   cannot;
 * - logout is immediate: the app is online-only (decision 2026-09-15),
 *   so nothing is ever queued on the handset to lose.
 *
 * **Dispatcher:** the §D6 screen — self only, and NOTHING of the
 * technician's device state: no pending badge, no sync state, no
 * tracking chip (the dispatcher holds no device state and is not
 * tracked), and logout is IMMEDIATE — there is nothing queued to lose.
 * The dispatcher branch never reads a
 * tracking health endpoint, and is dark without `dispatch.console`.
 *
 * **Owner (§O9, T4.12):** name, username, change password, logout, app
 * version, the catalogue links (Products · Services live under Profile
 * in the phone grouping), and the **second owner account reminder** —
 * who else holds owner access, because the recovery story depends on
 * that account existing and being remembered. NO tracking chip: owners
 * are not tracked.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppState, Text, View, StyleSheet } from 'react-native';

import type { TrackingHealth } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { api } from '../../../src/lib/api';
import { loadMyDevice } from '../../../src/lib/myDevice';
import { matchAutostartVendor } from '../../../src/location/autostart';
import { ProfileScreen, type LadderRowState } from '../../../src/screens/technician/ProfileScreen';
import { DispatcherProfileScreen } from '../../../src/screens/dispatcher/profile';
import { OwnerProfileScreen } from '../../../src/screens/owner/OwnerProfileScreen';
import { useOtherOwners } from '../../../src/screens/owner/useOwnerData';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { useSessionStore } from '../../../src/state/sessionStore';
import { useFullName } from '../../../src/state/useAuthMe';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function TechnicianProfileRoute(): React.ReactNode {
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
    // The same server record the ladder writes — one memory between the
    // two screens, or the rows would contradict the ladder.
    const device = await loadMyDevice();
    const battery = device?.batteryOptExempt === true;
    const autostart = device?.autostartConfirmed === true;
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

function DispatcherProfileRoute(): React.ReactNode {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const flags = useDispatchJobLogsFlags();

  // §D6 names a NAME and a username; the session store carries only the
  // username, so the name comes from `useFullName` and degrades to the
  // username until it lands. No tracking read: this role is not tracked.
  const fullName = useFullName();

  if (actor === null) return null;

  if (!flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Profile</Text>
      </View>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <DispatcherProfileScreen
        fullName={fullName}
        username={actor.username}
        appVersion={Constants.expoConfig?.version ?? 'dev'}
        changePassword={() => router.push('/change-password')}
        logout={() => {
          // §D6: IMMEDIATE — no gate (nothing is queued), no confirmation
          // (nothing to lose). Same session end as every role.
          void (async () => {
            await api.logout();
            useSessionStore.getState().setAnonymous();
            router.replace('/login');
          })();
        }}
      />
    </SafeAreaView>
  );
}

function OwnerProfileRoute(): React.ReactNode {
  const router = useRouter();
  const actor = useSessionStore((s) => s.actor);
  const { others } = useOtherOwners();

  // §O9 names a NAME; the session store carries only the username, so the
  // name comes from `useFullName`.
  const fullName = useFullName();

  if (actor === null) return null;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <OwnerProfileScreen
        fullName={fullName}
        username={actor.username}
        appVersion={Constants.expoConfig?.version ?? 'dev'}
        otherOwners={others}
        changePassword={() => router.push('/change-password')}
        logout={() => {
          // Immediate, like the dispatcher's: the owner is online-only,
          // there is nothing queued to lose.
          void (async () => {
            await api.logout();
            useSessionStore.getState().setAnonymous();
            router.replace('/login');
          })();
        }}
        onOpenProducts={() => router.push('/products')}
        onOpenServices={() => router.push('/services')}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  // The role split is the whole point of §D6: a dispatcher must never
  // see the technician's tracking and sync UI, so the dispatcher branch
  // renders a different screen from a different component — not the
  // same screen with pieces hidden. The owner gets the same treatment
  // (§O9): no tracking UI, plus the second-owner reminder.
  if (actor.role === 'owner') return <OwnerProfileRoute />;
  return actor.role === 'dispatcher' ? <DispatcherProfileRoute /> : <TechnicianProfileRoute />;
}
