/**
 * New customer — placeholder route from PLAN-FRONTEND.md §2.
 * T0.13 delivers the screen; T0.11 guarantees the route exists.
 */
import { View, Text, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  return (
    <View style={styles.root}>
      <Text>New customer (T0.13)</Text>
    </View>
  );
}
