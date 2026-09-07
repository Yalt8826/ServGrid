/**
 * Login (UI/plan-2/08-SHARED-SCREENS.md §X1 — Phase 0 delivers the route;
 * T0.14 delivers the screen). Username, not email; the truthful
 * "Ask the owner" instruction; sign-in needs a connection, which makes
 * this the one place offline genuinely blocks.
 */
import { View, Text, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function LoginScreen() {
  return (
    <View style={styles.root}>
      <Text>Login (T0.14)</Text>
    </View>
  );
}
