/**
 * `Chip` (03-COMPONENTS.md). 32 tall (36 in `field`), radius 4,
 * `label` type. Selected: slate.900 fill, `surface` text — **not
 * accent**; the accent is reserved. `Selection` haptic on toggle.
 */
import { Pressable, Text } from 'react-native';
import Animated from 'react-native-reanimated';
import { useState } from 'react';

import { RADII, SEMANTIC, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { haptic } from './haptics';
import { usePressScale } from './motion';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  testID?: string;
}

export function Chip({ label, selected = false, onToggle, disabled = false, testID }: ChipProps): React.ReactNode {
  const density = useDensity();
  const [pressed, setPressed] = useState(false);
  const height = density === 'field' ? 36 : 32;
  // A chip is a control, so it takes the press scale; the fill and border
  // swap on the same touch-down (02-MOTION.md §6, `quick` 140ms).
  const press = usePressScale(0.97, !disabled);

  return (
    <Animated.View style={press.style}>
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      testID={testID}
      disabled={disabled}
      hitSlop={height < TAP.min ? TAP.hitSlop : 0}
      onPress={() => {
        haptic('pickerSelect');
        onToggle?.();
      }}
      onPressIn={() => {
        setPressed(true);
        press.onPressIn();
      }}
      onPressOut={() => {
        setPressed(false);
        press.onPressOut();
      }}
      style={{
        height,
        minHeight: height,
        paddingHorizontal: 12,
        borderRadius: RADII.control,
        borderWidth: 1,
        borderColor: selected ? SEMANTIC.bg.dark : SEMANTIC.line.default,
        backgroundColor: disabled
          ? SEMANTIC.bg.pressed
          : selected
            ? SEMANTIC.bg.dark
            : pressed
              ? SEMANTIC.bg.pressed
              : SEMANTIC.bg.raised,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text
        style={{
          ...textStyle('label'),
          color: disabled
            ? SEMANTIC.text.disabled
            : selected
              ? SEMANTIC.text.onDark
              : SEMANTIC.text.primary,
        }}
      >
        {label}
      </Text>
    </Pressable>
    </Animated.View>
  );
}
