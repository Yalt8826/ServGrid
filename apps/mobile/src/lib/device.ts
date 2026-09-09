/**
 * The login payload's `device` half (PLAN-BACKEND.md §4): six fields the
 * API's `devices` upsert requires. Manufacturer and model are what the
 * owner's tracking-health console and the OEM autostart walkthroughs are
 * keyed on later, so they come from `expo-device` — honest values or an
 * explicit fallback, never a blank string. Route-file only: the auth
 * screens stay testable without native modules.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { api } from './api';
import type { LoginDevice } from './apiClient';

export async function buildLoginDevice(): Promise<LoginDevice> {
  return {
    installId: await api.store.installId(),
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'web' ? 'web' : 'android',
    appVersion: Constants.expoConfig?.version ?? 'dev',
    osVersion: String(Platform.Version),
    manufacturer: Device.manufacturer ?? Device.deviceName ?? 'unknown',
    model: Device.modelName ?? Device.modelId ?? 'unknown',
  };
}
