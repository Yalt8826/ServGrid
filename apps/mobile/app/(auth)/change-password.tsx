/**
 * Forced password change — shown when `mustChangePassword`. Not
 * skippable, not dismissible, no back (UI/plan-2/08-SHARED-SCREENS.md
 * §X2 — Phase 0 delivers the route; T0.14 delivers the screen).
 */
import { View, Text, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function ChangePasswordScreen() {
  return (
    <View style={styles.root}>
      <Text>Change password (T0.14)</Text>
    </View>
  );
}
