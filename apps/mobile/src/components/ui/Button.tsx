/**
 * `Button` (03-COMPONENTS.md). Label 15/18 weight 600; height 52/44/36
 * by density; radius 4. Variants: primary (accent, the one per screen),
 * secondary (1px strong line), ghost, danger (outlined, never filled).
 *
 * States. Pressed: scale 0.97 on touch-down, spring.press. Disabled:
 * slate.100 fill, text.disabled, no press response — **always paired
 * with a caption saying why** (`disabledReason`, enforced by test).
 * Loading: label stays, a 16px indeterminate bar draws under it; width
 * never changes.
 */
import { Pressable, Text, View } from 'react-native';
import { useState } from 'react';
import Animated from 'react-native-reanimated';

import { COLORS, RADII, SEMANTIC, TAP, type ComponentState } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';
import { haptic } from './haptics';
import { usePressScale } from './motion';
import { captionStyle, staleInsetStyle } from './uiBase';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Required whenever `disabled` — the visible why (caption). */
  disabledReason?: string;
  loading?: boolean;
  /** The row carries local data the server has not confirmed. */
  stale?: boolean;
  fullwidth?: boolean;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  disabledReason,
  loading = false,
  stale = false,
  fullwidth = false,
  testID,
}: ButtonProps): React.ReactNode {
  const density = useDensity();
  const [pressed, setPressed] = useState(false);
  // Scale on touch-down, spring.press. Disabled and loading buttons do not
  // move: a control that answers a press it will not act on is a lie.
  const press = usePressScale(0.97, !disabled && !loading);
  const height = density === 'field' ? 52 : density === 'console' ? 44 : 36;
  const hScale = height / 52;

  const colors = buttonColors(variant, disabled, pressed);

  return (
    <View
      testID={testID}
      style={[
        {
          alignSelf: fullwidth ? 'stretch' : 'flex-start',
          ...(stale ? staleInsetStyle() : {}),
        },
      ]}
    >
      <Animated.View style={press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled, busy: loading }}
        disabled={disabled || loading}
        hitSlop={height < TAP.min ? TAP.hitSlop : 0}
        onPress={onPress}
        onPressIn={() => {
          setPressed(true);
          press.onPressIn();
          if (!disabled && !loading) haptic('primaryActionPress');
        }}
        onPressOut={() => {
          setPressed(false);
          press.onPressOut();
        }}
        style={{
          height,
          minHeight: height,
          paddingHorizontal: 20,
          borderRadius: RADII.control,
          backgroundColor: colors.fill,
          borderWidth: colors.borderWidth,
          borderColor: colors.borderColor,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          alignSelf: 'stretch',
        }}
      >
        <Text
          style={{
            ...textStyle('label'),
            fontSize: Math.round(15 * (density === 'desk' ? 0.9 : 1)),
            lineHeight: Math.round(18 * (density === 'desk' ? 0.9 : 1)),
            fontWeight: '600',
            color: colors.label,
          }}
        >
          {label}
        </Text>
        {loading ? (
          <View
            testID={testID ? `${testID}-loading` : 'button-loading'}
            style={{
              position: 'absolute',
              bottom: 6 * hScale,
              height: 2,
              width: 16,
              borderRadius: 1,
              backgroundColor: colors.bar,
            }}
          />
        ) : null}
      </Pressable>
      </Animated.View>
      {disabled && disabledReason ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]}>{disabledReason}</Text>
      ) : null}
      {stale ? (
        <Text style={[captionStyle.caption, { marginTop: 4 }]} testID={testID ? `${testID}-stale` : undefined}>
          Pending sync
        </Text>
      ) : null}
    </View>
  );
}

function buttonColors(
  variant: ButtonVariant,
  disabled: boolean,
  pressed: boolean,
): { fill: string; label: string; borderWidth: number; borderColor: string; bar: string } {
  if (disabled) {
    return {
      fill: SEMANTIC.bg.dense,
      label: SEMANTIC.text.disabled,
      borderWidth: 0,
      borderColor: 'transparent',
      bar: SEMANTIC.text.disabled,
    };
  }
  const pressTint = pressed ? SEMANTIC.bg.pressed : SEMANTIC.bg.app;
  switch (variant) {
    case 'primary':
      return {
        fill: COLORS.accent,
        label: SEMANTIC.text.onAccent,
        borderWidth: 0,
        borderColor: 'transparent',
        bar: SEMANTIC.text.onAccent,
      };
    case 'secondary':
      return {
        fill: pressTint,
        label: SEMANTIC.text.primary,
        borderWidth: 1,
        borderColor: SEMANTIC.line.strong,
        bar: SEMANTIC.text.primary,
      };
    case 'ghost':
      return {
        fill: pressed ? SEMANTIC.bg.pressed : 'transparent',
        label: SEMANTIC.text.secondary,
        borderWidth: 0,
        borderColor: 'transparent',
        bar: SEMANTIC.text.secondary,
      };
    case 'danger':
      return {
        fill: pressed ? SEMANTIC.bg.pressed : 'transparent',
        label: SEMANTIC.feedback.danger,
        borderWidth: 1,
        borderColor: SEMANTIC.feedback.danger,
        bar: SEMANTIC.feedback.danger,
      };
  }
}

export type ButtonStateName = ComponentState;
