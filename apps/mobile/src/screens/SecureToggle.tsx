/**
 * The password visibility toggle (§X1). Text, not an icon glyph — there
 * is no icon set in the product yet, and a word is legible in sunlight
 * to someone who has never used the app. The mask is the deviation;
 * visible is the default everywhere a temporary password is typed.
 */
import { Pressable, StyleSheet, Text } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';

export function SecureToggle({
  visible,
  onToggle,
  testID,
}: {
  visible: boolean;
  onToggle: () => void;
  testID?: string;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={visible ? 'Hide password' : 'Show password'}
      accessibilityState={{ expanded: visible }}
      onPress={onToggle}
      hitSlop={8}
      style={styles.toggle}
      testID={testID}
    >
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.secondary }}>
        {visible ? 'Hide' : 'Show'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toggle: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
