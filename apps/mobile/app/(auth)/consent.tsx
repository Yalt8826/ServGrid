/**
 * Consent — tracking consent, technician + sales rep, first login
 * (UI/plan-2/08-SHARED-SCREENS.md §X3 — Phase 0 delivers the route; the
 * consent endpoints arrive with T0.9 / T0.14). It gates the location
 * task, not the app.
 */
import { View, Text, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function ConsentScreen() {
  return (
    <View style={styles.root}>
      <Text>Consent (T0.14)</Text>
    </View>
  );
}
