/**
 * `MoneyField` (03-COMPONENTS.md). `mono` tabular, en-IN grouping
 * applied on blur and stripped while typing, no `₹` inside the input —
 * the prefix sits outside, `text.secondary` — numeric keypad, no
 * spinner controls.
 */
import { Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { formatMoneyEnIN, stripToNumeric, RADII, SEMANTIC, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { captionStyle } from './uiBase';

export interface MoneyFieldProps {
  label: string;
  /** Raw numeric string — digits and at most one dot. */
  value: string;
  onChangeText: (rawNumeric: string) => void;
  helperText?: string;
  errorText?: string;
  disabled?: boolean;
  testID?: string;
}

export function MoneyField({
  label,
  value,
  onChangeText,
  helperText,
  errorText,
  disabled = false,
  testID,
}: MoneyFieldProps): React.ReactNode {
  const density = useDensity();
  const [focused, setFocused] = useState(false);
  const height = density === 'field' ? TAP.min : density === 'console' ? 44 : 36;

  const borderColor = errorText
    ? SEMANTIC.feedback.danger
    : focused
      ? SEMANTIC.line.focus
      : SEMANTIC.line.default;

  return (
    <View testID={testID} style={{ alignSelf: 'stretch' }}>
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary, marginBottom: 6 }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height,
          minHeight: height,
          borderRadius: RADII.control,
          borderWidth: focused ? 2 : 1,
          borderColor,
          backgroundColor: disabled ? SEMANTIC.bg.pressed : SEMANTIC.bg.raised,
          paddingHorizontal: 12,
        }}
      >
        <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary, marginRight: 8 }}>₹</Text>
        <TextInput
          accessibilityLabel={label}
          editable={!disabled}
          inputMode="decimal"
          keyboardType="numeric"
          value={focused ? value : formatMoneyEnIN(value)}
          onChangeText={(t) => onChangeText(stripToNumeric(t))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            color: SEMANTIC.text.primary,
            ...textStyle('mono'),
          }}
        />
      </View>
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
