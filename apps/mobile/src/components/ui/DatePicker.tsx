/**
 * `DatePicker` (Phase-0 primitive list). Field §6 formats: `D MMM` this
 * year, `D MMM YYYY` otherwise. The trigger renders in all eight
 * states; picking a date is the next action.
 */
import { Pressable, Text, View } from 'react-native';
import { useState } from 'react';

import { RADII, SEMANTIC, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { haptic } from './haptics';
import { captionStyle } from './uiBase';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDateEnIN(iso: string, nowYear: number): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return Number(y) === nowYear ? `${Number(d)} ${month}` : `${Number(d)} ${month} ${y}`;
}

/** `14 Sep 2027`, always with the year — the AMC chip's date format: an
 * AMC term spans years, so the year is the fact (decision 2026-09-15). */
export function formatDateWithYear(iso: string): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return `${Number(d)} ${month} ${y}`;
}

export interface DatePickerProps {
  label: string;
  /** ISO `YYYY-MM-DD`, or null for no date yet. */
  value: string | null;
  onChange: (iso: string) => void;
  helperText?: string;
  errorText?: string;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

export function DatePicker({
  label,
  value,
  onChange,
  helperText,
  errorText,
  disabled = false,
  loading = false,
  testID,
}: DatePickerProps): React.ReactNode {
  const density = useDensity();
  const [pressed, setPressed] = useState(false);
  const height = density === 'field' ? TAP.min : density === 'console' ? 44 : 36;

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
          onChange(value ?? '2026-01-01');
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
        }}
      >
        <Text
          style={{
            ...textStyle('mono'),
            color: value ? SEMANTIC.text.primary : SEMANTIC.text.placeholder,
          }}
        >
          {value ? formatDateEnIN(value, 2026) : 'Pick a date'}
        </Text>
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
