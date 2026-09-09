/**
 * `TextField` (03-COMPONENTS.md). Label above; input 52 tall, 1px
 * `line.default`, radius 4; helper or error below as caption.
 *
 * States. Focused: border → `line.focus` 2px, quick 140ms, no glow.
 * Error: border `feedback.danger`, message replaces helper — shake is
 * banned, the message is the signal. Disabled: `slate.050` fill.
 * Never floating labels, never placeholder-as-label, no inline
 * validation while typing — validate on blur and on submit.
 */
import { Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { RADII, SEMANTIC, TAP, type ComponentState } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { captionStyle, staleInsetStyle } from './uiBase';

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  helperText?: string;
  /** Replaces helper text; border goes `feedback.danger`. */
  errorText?: string;
  disabled?: boolean;
  loading?: boolean;
  /** The value is local data the server has not confirmed. */
  stale?: boolean;
  secureTextEntry?: boolean;
  /**
   * Control rendered inside the field's row, after the input — a
   * password visibility toggle is the T0.14 use (§X1: visible by
   * default, the mask is one tap away). It is part of the field's own
   * tap target, not a decoration beside it.
   */
  trailing?: React.ReactNode;
  testID?: string;
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  helperText,
  errorText,
  disabled = false,
  loading = false,
  stale = false,
  secureTextEntry = false,
  trailing,
  testID,
}: TextFieldProps): React.ReactNode {
  const density = useDensity();
  const [focused, setFocused] = useState(false);
  const height = useDensity() === 'field' ? TAP.min : density === 'console' ? 44 : 36;
  const state: ComponentState = disabled
    ? 'disabled'
    : errorText
      ? 'error'
      : focused
        ? 'focused'
        : 'default';

  const borderColor =
    state === 'error'
      ? SEMANTIC.feedback.danger
      : state === 'focused'
        ? SEMANTIC.line.focus
        : SEMANTIC.line.default;

  return (
    <View testID={testID} style={[{ alignSelf: 'stretch' }, stale ? staleInsetStyle() : {}]}>
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          editable={!disabled && !loading}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={SEMANTIC.text.placeholder}
          secureTextEntry={secureTextEntry}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            height,
            minHeight: height,
            borderRadius: RADII.control,
            borderWidth: focused ? 2 : 1,
            borderColor,
            backgroundColor: disabled ? SEMANTIC.bg.pressed : SEMANTIC.bg.raised,
            paddingHorizontal: 12,
            color: SEMANTIC.text.primary,
            ...textStyle('body', density),
          }}
        />
        {trailing}
      </View>
      {errorText ? (
        <Text testID={testID ? `${testID}-error` : undefined} style={[captionStyle.caption, { color: SEMANTIC.feedback.danger, marginTop: 4 }]}>
          {errorText}
        </Text>
      ) : helperText ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]}>{helperText}</Text>
      ) : null}
      {stale ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]} testID={testID ? `${testID}-stale` : undefined}>
          Pending sync
        </Text>
      ) : null}
      {loading ? (
        <View style={{ height: 2, borderRadius: 1, backgroundColor: SEMANTIC.line.default, marginTop: 4 }}>
          <View style={{ height: 2, width: 16, borderRadius: 1, backgroundColor: SEMANTIC.text.secondary }} />
        </View>
      ) : null}
    </View>
  );
}
