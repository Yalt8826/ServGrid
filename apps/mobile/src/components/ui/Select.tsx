/**
 * `Select` (Phase-0 primitive list). A pressable summary row opening a
 * `Sheet` of options in production; Phase 0 renders the trigger in all
 * states and owns the selection contract (label, caption error). The
 * chosen value renders as the summary, never a placeholder
 * once chosen.
 */
import { Pressable, Text, View } from 'react-native';
import { useState } from 'react';

import { RADII, SEMANTIC, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { haptic } from './haptics';
import { captionStyle } from './uiBase';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string | null;
  options: SelectOption[];
  onSelect: (value: string) => void;
  helperText?: string;
  errorText?: string;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

export function Select({
  label,
  value,
  options,
  onSelect,
  helperText,
  errorText,
  disabled = false,
  loading = false,
  testID,
}: SelectProps): React.ReactNode {
  const density = useDensity();
  const [pressed, setPressed] = useState(false);
  const height = density === 'field' ? TAP.min : density === 'console' ? 44 : 36;
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <View testID={testID} style={{ alignSelf: 'stretch' }}>
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 }}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        testID={testID ? `${testID}-trigger` : undefined}
        disabled={disabled || loading}
        onPress={() => {
          haptic('pickerSelect');
          if (value !== null) onSelect(value);
        }}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={{
          height,
          minHeight: height,
          borderRadius: RADII.control,
          borderWidth: 1,
          borderColor: errorText ? SEMANTIC.feedback.danger : SEMANTIC.line.default,
          backgroundColor: disabled ? SEMANTIC.bg.pressed : pressed ? SEMANTIC.bg.pressed : SEMANTIC.bg.raised,
          paddingHorizontal: 12,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'space-between',
        }}
      >
        <Text
          style={{
            ...textStyle('body', density),
            color: selected ? SEMANTIC.text.primary : SEMANTIC.text.placeholder,
          }}
        >
          {selected ? selected.label : 'Select'}
        </Text>
        {loading ? <Text style={captionStyle.caption}>…</Text> : null}
      </Pressable>
      {errorText ? (
        <Text testID={testID ? `${testID}-error` : undefined} style={[captionStyle.caption, { color: SEMANTIC.feedback.danger, marginTop: 4 }]}>
          {errorText}
        </Text>
      ) : helperText ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]}>{helperText}</Text>
      ) : null}
    </View>
  );
}
