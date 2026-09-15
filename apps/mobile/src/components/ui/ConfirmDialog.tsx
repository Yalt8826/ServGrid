/**
 * `ConfirmDialog` (03-COMPONENTS.md). Only for irreversible actions
 * with no undo — if an undo is possible, ship the undo instead.
 * Destructive action on the right, `danger` variant (outlined, never
 * filled). Radius 8 — modal dialogs are the only place. `ImpactMedium`
 * on confirm.
 */
import { Modal, Pressable, Text, View } from 'react-native';

import { RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { haptic } from './haptics';
import { Button } from './Button';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  disabled?: boolean;
  testID?: string;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
  disabled = false,
  testID,
}: ConfirmDialogProps): React.ReactNode {
  if (!visible) return null;
  return (
    <Modal transparent visible={visible} onRequestClose={onCancel}>
      <View testID={testID} style={{ flex: 1, backgroundColor: SEMANTIC.bg.dark, opacity: 0.45, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            backgroundColor: SEMANTIC.bg.raised,
            borderRadius: RADII.dialog,
            borderWidth: 1,
            borderColor: SEMANTIC.line.default,
            padding: SPACE[4],
            gap: SPACE[3],
          }}
        >
          <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary }}>{title}</Text>
          <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>{message}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE[3] }}>
            <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={disabled} />
            <Button
              label={confirmLabel}
              variant="danger"
              onPress={() => {
                haptic('destructiveConfirmed');
                onConfirm();
              }}
              disabled={disabled}
              disabledReason={disabled ? 'Unavailable while the server is unreachable' : undefined}
              testID={testID ? `${testID}-confirm` : undefined}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
