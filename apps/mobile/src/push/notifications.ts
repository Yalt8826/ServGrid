/**
 * App side of the push contract (PLAN-BACKEND.md §12.1, T0.15): a
 * data-only FCM wake is handled by syncing — never by displaying remote
 * content. What the user sees is the LOCAL notification raised from the
 * rows the sync just received; the wake itself is invisible.
 *
 * Two delivery surfaces, one executor:
 * - foreground: `addNotificationReceivedListener`
 * - background/killed: the headless task via `expo-task-manager`
 *   (registration is a no-op where the OS will not deliver it — see the
 *   T0.15 runbook's probe step for the honest decision tree).
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import {
  handleDataOnlyPush,
  SYNC_ON_PUSH_TASK,
} from './backgroundTask';

/** Channel the sync confirmations post into (Android 8+). */
const CHANNEL_ID = 'servgrid-sync';

/** Marker in `content.data` for notifications this module raised itself. */
const LOCAL_KIND = 'servgrid-local';

function isLocallyRaised(notification: Notifications.Notification): boolean {
  return notification.request.content.data?.kind === LOCAL_KIND;
}

/** The visible end of a delivered push. Never carries job content —
 * per-row notifications are raised from received rows once the sync
 * engine exists (Phase 1); this bare confirmation is the Phase 0
 * delivery proof the T0.15 probe records. */
export async function raiseSyncConfirmation(): Promise<void> {
  // `channelId` belongs on the *trigger*, not the content — and an
  // immediate notification (`trigger: null`) has no trigger to carry it,
  // so Android routes it through the default channel. The dedicated
  // channel is still created below for the per-row notifications T2.6
  // raises, which schedule with a trigger and can name it.
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'ServGrid',
      body: 'New work synced — open the app to review.',
      data: { kind: LOCAL_KIND },
    },
    trigger: null,
  });
}

/** One wake, whatever the surface delivered it. Never throws. */
async function runWake(): Promise<void> {
  try {
    const raised = await handleDataOnlyPush();
    if (raised) await raiseSyncConfirmation();
  } catch {
    // A wake failing must never crash the app or the headless task.
  }
}

let installed = false;

/** Test helper: clear the installed state so initPush() can run again. */
export function __resetPushForTests(): void {
  installed = false;
}

/**
 * Register everything push needs at start-up. Idempotent, never throws:
 * push is a latency improvement (§12.1), so any failure here degrades
 * to the plain sync triggers and is retried on the next launch.
 */
export function initPush(): void {
  if (installed) return;
  installed = true;
  try {
    // Headless task for background/killed deliveries. defineTask is
    // global and one-shot per task name.
    TaskManager.defineTask(SYNC_ON_PUSH_TASK, () => runWake());
  } catch {
    // Not installed yet or registration refused — the foreground
    // listener below still handles foreground deliveries.
  }
  try {
    // Foreground display gate: remote wakes show nothing; our own local
    // confirmations do. (In the background the OS owns presentation: a
    // data-only wake never reaches the tray, and a scheduled local
    // notification always does.) Idempotent — the SDK replaces the
    // global handler.
    // `handleNotification` returns a promise, and the behaviour shape is
    // `shouldShowBanner` / `shouldShowList` — `shouldShowAlert` is
    // deprecated. Both were wrong against the real SDK and invisible
    // while a hand-written .d.ts stood in for it.
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const ours = isLocallyRaised(notification);
        return {
          shouldShowBanner: ours,
          shouldShowList: ours,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      },
    });
    if (Platform.OS === 'android') {
      void Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Job updates',
        importance: Notifications.AndroidImportance.HIGH,
      }).catch(() => {});
    }
    // Foreground delivery of the data-only wake. Our own local
    // notifications also arrive here — ignore them, or raising one
    // would wake again and loop.
    Notifications.addNotificationReceivedListener((notification) => {
      if (isLocallyRaised(notification)) return;
      void runWake();
    });
    // A tap on a confirmation is an explicit user action; the wake it
    // triggers is the sync the tap exists to cause.
    Notifications.addNotificationResponseReceivedListener(() => {
      void runWake();
    });
  } catch {
    installed = false; // allow a retry on next launch
  }
}
