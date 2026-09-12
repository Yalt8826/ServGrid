/**
 * App side of the push contract (PLAN-BACKEND.md §12.1): a data-only FCM
 * wake is handled by syncing — never by displaying remote content. What
 * the user sees is the LOCAL notification the T2.6 handler raises from
 * the rows the sync just received (`../notifications/handler`); the wake
 * itself is invisible, and a wake whose delta returned nothing raises
 * nothing.
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
import { handleDataOnlyPush, SYNC_ON_PUSH_TASK } from './backgroundTask';
import { PUSH_LOCAL_KIND, SYNC_NOTIFICATION_CHANNEL } from '../notifications/handler';

function isLocallyRaised(notification: Notifications.Notification): boolean {
  return notification.request.content.data?.kind === PUSH_LOCAL_KIND;
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
    // defineTask alone is NOT enough (found on hardware, T0.15 probe
    // 2026-09-12): background/terminated data-only deliveries reach the
    // task only when it is also REGISTERED with the SDK. Without this,
    // the foreground listener works and every backgrounded wake dies
    // silently — the exact failure 6b of the runbook exists to surface.
    void Notifications.registerTaskAsync(SYNC_ON_PUSH_TASK).catch(() => {
      // Unregistered background wake — the foreground listener and the
      // sync triggers still cover the session; retried next launch.
    });
  } catch {
    // Not installed yet or registration refused — the foreground
    // listener below still handles foreground deliveries.
  }
  try {
    // Foreground display gate: remote wakes show nothing; our own local
    // notifications do. (In the background the OS owns presentation: a
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
      // Created at FIRST LAUNCH, not at first use — a channel created
      // late is silently ignored for the app's lifetime, which presents
      // as "push works in dev, not in the build" (§T2.6 "If it fails").
      void Notifications.setNotificationChannelAsync(SYNC_NOTIFICATION_CHANNEL, {
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
    // A tap on a row notification is an explicit user action; the wake it
    // triggers is the sync the tap exists to cause.
    Notifications.addNotificationResponseReceivedListener(() => {
      void runWake();
    });
  } catch {
    installed = false; // allow a retry on next launch
  }
}

/** One wake, whatever the surface delivered it. Never throws. The T2.6
 * composition inside `handleDataOnlyPush` owns what is raised — per-row
 * local notifications from synced rows, and nothing when the delta
 * returned nothing. */
async function runWake(): Promise<void> {
  try {
    await handleDataOnlyPush();
  } catch {
    // A wake failing must never crash the app or the headless task.
  }
}
