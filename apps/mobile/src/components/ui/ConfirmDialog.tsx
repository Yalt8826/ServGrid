/**
 * `ConfirmDialog` (03-COMPONENTS.md). Only for irreversible actions
 * with no undo — if an undo is possible, ship the undo instead.
 * Destructive action on the right, `danger` variant (outlined, never
 * filled). Radius 8 — modal dialogs are the only place. `ImpactMedium`
 * on confirm.
 */
import { Modal, Pressable, Text, View } from 'react-native';

import { alpha, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
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
      <View testID={testID} style={{ flex: 1, justifyContent: 'flex-end' }}>
        {/*
          * The dimming layer — and the tap-anywhere-to-cancel target under
          * it. **Its translucency must live here, on the layer itself.**
          * It used to sit on the parent as `opacity: 0.45`, which dimmed the
          * PANEL too: the form behind showed straight through the dialog and
          * the dialog's own words washed out (2026-09-18, Yashas on the sale
          * form's confirm: "too transparent i have the screen on right now").
          * `alpha()` on the backdrop keeps the panel opaque, which is what a
          * dialog is for.
          */}
        <Pressable
          accessibilityLabel="Cancel"
          onPress={onCancel}
          style={{ position: 'absolute', inset: 0, backgroundColor: alpha(SEMANTIC.bg.dark, 0.45) }}
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
