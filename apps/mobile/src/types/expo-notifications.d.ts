/**
 * Ambient module declaration for `expo-notifications`. The package is not
 * installed in the workspace yet (it lands with the FCM Google project —
 * T0.15 runbook step 2), so Metro never sees this file; it exists so
 * `tsc --noEmit` typechecks `src/push/*` and `app/_layout.tsx` against
 * the real API shape today instead of disabling typechecking.
 *
 * Delete this file the moment `expo-notifications` is a real dependency
 * (`pnpm --filter mobile expo install expo-notifications`) — from then on
 * the package's own types win, and this stub would shadow them.
 *
 * Only the surface `src/push/` and `app/_layout.tsx` touch is declared.
 */
declare module 'expo-notifications' {
  export interface NotificationBehaviour {
    shouldShowAlert: boolean;
    shouldPlaySound: boolean;
    shouldSetBadge: boolean;
  }

  export interface NotificationPayload {
    [key: string]: unknown;
  }

  export interface Notification {
    request: {
      content: {
        title: string | null;
        body: string | null;
        data: NotificationPayload;
      };
    };
  }

  export interface NotificationResponse {
    actionIdentifier: string;
    notification: Notification;
  }

  export interface NotificationHandler {
    handleNotification: (
      notification: Notification,
    ) => NotificationBehaviour | Promise<NotificationBehaviour>;
  }

  export interface NotificationContentInput {
    title?: string | null;
    body?: string | null;
    data?: NotificationPayload;
    /** Android 8+ channel. */
    channelId?: string;
  }

  export const AndroidImportance: { MAX: 5; HIGH: 4; DEFAULT: 3; LOW: 2; MIN: 1 };

  export function setNotificationHandler(handler: NotificationHandler): void;

  export function setNotificationChannelAsync(
    channelId: string,
    channel: {
      name: string;
      importance: (typeof AndroidImportance)[keyof typeof AndroidImportance];
    },
  ): Promise<void>;

  export function scheduleNotificationAsync(input: {
    content: NotificationContentInput;
    trigger: null;
  }): Promise<string>;

  export function getDevicePushTokenAsync(): Promise<{ type: string; data: string }>;

  export function addNotificationResponseReceivedListener(
    listener: (response: NotificationResponse) => void,
  ): { remove: () => void };

  export function addNotificationReceivedListener(listener: (notification: Notification) => void): {
    remove: () => void;
  };
}
