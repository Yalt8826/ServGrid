/**
 * Test seam for `expo-haptics` (T0.12). Records every fired haptic so
 * component tests can assert the mapping in `02-MOTION.md` §8 (e.g. a
 * Chip selection fires `Selection`, a sync rejection fires
 * `NotificationWarning`). Never on scroll or passive data arrival.
 */
const fired: string[] = [];

export const ImpactLight = 'impactLight';
export const ImpactMedium = 'impactMedium';
export const ImpactHeavy = 'impactHeavy';
export const Selection = 'selection';
export const NotificationSuccess = 'notificationSuccess';
export const NotificationWarning = 'notificationWarning';
export const NotificationError = 'notificationError';

export async function impactAsync(style: string): Promise<void> {
  fired.push(`impact:${style}`);
}
export async function notificationAsync(type: string): Promise<void> {
  fired.push(`notification:${type}`);
}
export async function selectionAsync(): Promise<void> {
  fired.push('selection');
}

/** Test assertion surface — the log of fired haptics. */
export function __fired(): readonly string[] {
  return fired;
}
export function __reset(): void {
  fired.length = 0;
}
