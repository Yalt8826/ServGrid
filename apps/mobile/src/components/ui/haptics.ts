/**
 * Haptic mapping — the single place `expo-haptics` is called from
 * (02-MOTION.md §8). Semantic events from `packages/shared` map onto
 * the platform API here. Android respects the system haptic setting;
 * never on scroll, never on every keystroke, never on passive data
 * arrival.
 */
import * as Haptics from 'expo-haptics';

import type { HapticEvent } from '@servgrid/shared';

export function haptic(event: HapticEvent): void {
  switch (event) {
    case 'primaryActionPress':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case 'pickerSelect':
    case 'longPressArmed':
      void Haptics.selectionAsync();
      break;
    case 'jobStatusAdvanced':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case 'completionSynced':
    case 'outboxDrained':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      break;
    case 'syncRejected':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      break;
    case 'destructiveConfirmed':
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      break;
    case 'validationFailed':
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      break;
  }
}
