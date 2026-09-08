/**
 * Probe tests for the T0.15 push seam. The gates that matter:
 * - the FCM token reaches the app even when no session exists (parked)
 * - a parked token ships on the next authenticated start
 * - a data-only wake to a logged-out handset does nothing (no fetch, no
 *   notification) — the §12.1 logged-out-leak guard
 * - our own local notifications do not re-wake the sync (loop guard)
 * - the query keys the wake invalidates are the declared sync queries
 *
 * `expo-notifications` / `expo-task-manager` are not installed yet (they
 * land with the FCM Google project — T0.15 runbook step 2), so both are
 * module-mocked here. `react-native`, AsyncStorage and the zustand
 * session store run through the real vitest stubs/config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as RN from 'react-native';

/** The slice of a notification our code touches. */
interface Notificationish {
  request: { content: { title: string | null; body: string | null; data: Record<string, unknown> } };
}
interface Handlerish {
  handleNotification: (notification: Notificationish) => { shouldShowAlert: boolean };
}
/** The slice of scheduleNotificationAsync's input the assertions read. */
interface ScheduleInput {
  content: {
    title?: string | null;
    body?: string | null;
    data?: Record<string, unknown>;
    channelId?: string;
  };
  trigger: null;
}

const notif = vi.hoisted(() => ({
  getDevicePushTokenAsync: vi.fn(),
  setNotificationHandler: vi.fn((_handler: Handlerish) => undefined),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  scheduleNotificationAsync: vi.fn(async (_input: ScheduleInput) => 'sched-1'),
  addNotificationReceivedListener: vi.fn((_listener: (notification: Notificationish) => void) => ({
    remove: () => {},
  })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: () => {} })),
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
}));
vi.mock('expo-notifications', () => notif);

const taskManager = vi.hoisted(() => ({ defineTask: vi.fn() }));
vi.mock('expo-task-manager', () => taskManager);

// The real `api` singleton drags in the platform token-store split,
// which has no runtime module under vitest; the registration calls are
// asserted through this mock instead.
const fakeApi = vi.hoisted(() => ({
  api: {
    request: vi.fn(),
    store: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      installId: vi.fn(async () => 'device-1'),
    },
  },
}));
vi.mock('../lib/api', () => fakeApi);

import { handleDataOnlyPush, PUSH_INVALIDATED_QUERY_KEYS } from './backgroundTask';
import { __resetPushForTests, initPush, raiseSyncConfirmation } from './notifications';
import { acquirePushToken, pushSupported, registerPendingPushToken } from './push';
import { useSessionStore } from '../state/sessionStore';
import { configureQueryClient, getQueryClient, __resetQueryClient } from '../state/runtimeQueryClient';

const ACTOR = { id: '22222222-2222-4222-8222-222222222222', role: 'technician' as const, username: 'ravi' };
const TOKEN = 'fcm-token-abc123';

function apiResult(ok: boolean) {
  return { ok, status: ok ? 200 : 500, data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetQueryClient();
  __resetPushForTests();
  fakeApi.api.request.mockResolvedValue(apiResult(true));
  notif.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: TOKEN });
  RN.Platform.OS = 'android';
});

afterEach(() => {
  useSessionStore.getState().setAnonymous();
  RN.Platform.OS = 'android';
  return AsyncStorage.clear();
});

describe('acquirePushToken — the token gate', () => {
  it('web is a no-op: no FCM call, no registration', async () => {
    RN.Platform.OS = 'web';
    expect(pushSupported()).toBe(false);
    await expect(acquirePushToken()).resolves.toBeNull();
    expect(notif.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(fakeApi.api.request).not.toHaveBeenCalled();
  });

  it('no Play services (FCM rejects) → null, nothing thrown, nothing parked', async () => {
    notif.getDevicePushTokenAsync.mockRejectedValue(new Error('no play services'));
    await expect(acquirePushToken()).resolves.toBeNull();
    expect(fakeApi.api.request).not.toHaveBeenCalled();
    await expect(AsyncStorage.getItem('servgrid.pushToken.v1')).resolves.toBeNull();
  });

  it('anonymous: token is parked, API is NOT called, result is null', async () => {
    useSessionStore.getState().setAnonymous();
    await expect(acquirePushToken()).resolves.toBeNull();
    await expect(AsyncStorage.getItem('servgrid.pushToken.v1')).resolves.toBe(TOKEN);
    expect(fakeApi.api.request).not.toHaveBeenCalled();
  });

  it('authenticated: POSTs the token to /v1/devices/push-token and returns it', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    await expect(acquirePushToken()).resolves.toBe(TOKEN);
    expect(fakeApi.api.request).toHaveBeenCalledWith('POST', '/v1/devices/push-token', {
      body: { token: TOKEN, platform: 'android' },
    });
    await expect(AsyncStorage.getItem('servgrid.pushToken.v1')).resolves.toBe(TOKEN);
  });

  it('registration failing leaves the token parked and does not throw', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    fakeApi.api.request.mockResolvedValue(apiResult(false));
    await expect(acquirePushToken()).resolves.toBeNull();
    await expect(AsyncStorage.getItem('servgrid.pushToken.v1')).resolves.toBe(TOKEN);
  });
});

describe('registerPendingPushToken — parked token ships after login', () => {
  it('ships a parked token once a session exists', async () => {
    await AsyncStorage.setItem('servgrid.pushToken.v1', TOKEN);
    useSessionStore.getState().setAuthenticated(ACTOR);
    await registerPendingPushToken();
    expect(fakeApi.api.request).toHaveBeenCalledWith('POST', '/v1/devices/push-token', {
      body: { token: TOKEN, platform: 'android' },
    });
  });

  it('does nothing with nothing parked', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    await registerPendingPushToken();
    expect(fakeApi.api.request).not.toHaveBeenCalled();
  });

  it('anonymous never POSTs, even with a token parked', async () => {
    await AsyncStorage.setItem('servgrid.pushToken.v1', TOKEN);
    useSessionStore.getState().setAnonymous();
    await registerPendingPushToken();
    expect(fakeApi.api.request).not.toHaveBeenCalled();
  });

  it('a failed POST keeps the token parked for the next attempt', async () => {
    await AsyncStorage.setItem('servgrid.pushToken.v1', TOKEN);
    useSessionStore.getState().setAuthenticated(ACTOR);
    fakeApi.api.request.mockResolvedValue(apiResult(false));
    await expect(registerPendingPushToken()).resolves.toBeUndefined();
    await expect(AsyncStorage.getItem('servgrid.pushToken.v1')).resolves.toBe(TOKEN);
  });
});

describe('handleDataOnlyPush — the §12.1 wake', () => {
  it('logged-out handset: no fetch, no sync, no notification', async () => {
    useSessionStore.getState().setAnonymous();
    await expect(handleDataOnlyPush()).resolves.toBe(false);
  });

  it('authenticated: invalidates the declared sync queries and returns true', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    configureQueryClient(ACTOR.role);
    const client = getQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    await expect(handleDataOnlyPush()).resolves.toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(PUSH_INVALIDATED_QUERY_KEYS.length);
    for (const key of PUSH_INVALIDATED_QUERY_KEYS) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [...key] });
    }
  });

  it('push before the query client exists degrades to a no-wake, not a crash', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    __resetQueryClient();
    await expect(handleDataOnlyPush()).resolves.toBe(false);
  });

  it('the invalidated keys are the sync queries, by name', () => {
    expect(PUSH_INVALIDATED_QUERY_KEYS).toEqual([
      ['jobs', 'list'],
      ['notifications', 'count'],
    ]);
  });
});

describe('notifications — surfaces and the loop guard', () => {
  it('registers the headless task and the foreground listener at init', async () => {
    await import('./notifications');
    initPush();
    expect(taskManager.defineTask).toHaveBeenCalledTimes(1);
    expect(notif.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
  });

  it('foreground gate: remote wakes show nothing, local confirmations do', async () => {
    await import('./notifications');
    initPush();
    const handler = notif.setNotificationHandler.mock.calls[0]?.[0];
    if (handler === undefined) throw new Error('setNotificationHandler was never called');
    const remote = { request: { content: { title: null, body: null, data: {} } } };
    const local = { request: { content: { title: 'x', body: 'y', data: { kind: 'servgrid-local' } } } };
    expect(handler.handleNotification(remote).shouldShowAlert).toBe(false);
    expect(handler.handleNotification(local).shouldShowAlert).toBe(true);
  });

  it('a locally-raised notification does not re-wake the sync (loop guard)', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    configureQueryClient(ACTOR.role);
    await import('./notifications');
    initPush();
    const listener = notif.addNotificationReceivedListener.mock.calls[0]?.[0];
    if (listener === undefined) throw new Error('received-listener was never registered');
    notif.scheduleNotificationAsync.mockClear();
    listener({ request: { content: { title: 'ServGrid', body: 'b', data: { kind: 'servgrid-local' } } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a remote foreground wake raises exactly one local confirmation', async () => {
    useSessionStore.getState().setAuthenticated(ACTOR);
    configureQueryClient(ACTOR.role);
    await import('./notifications');
    initPush();
    const listener = notif.addNotificationReceivedListener.mock.calls[0]?.[0];
    if (listener === undefined) throw new Error('received-listener was never registered');
    listener({ request: { content: { title: null, body: null, data: { type: 'data-only-sync' } } } });
    // The wake runs fire-and-forget; let the microtask queue drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(notif.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const content = notif.scheduleNotificationAsync.mock.calls[0]?.[0]?.content;
    expect(content?.data).toEqual({ kind: 'servgrid-local' });
    expect(content?.channelId).toBe('servgrid-sync');
  });

  it('the confirmation carries no job content — only the local marker', async () => {
    await raiseSyncConfirmation();
    const call = notif.scheduleNotificationAsync.mock.calls[0]?.[0];
    expect(call?.content?.data).toEqual({ kind: 'servgrid-local' });
    expect(JSON.stringify(call?.content)).not.toMatch(/job|customer|amount/i);
  });
});
