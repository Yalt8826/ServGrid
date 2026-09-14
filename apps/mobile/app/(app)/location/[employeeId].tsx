/**
 * Day-trail deep link (T4.10) — `/location/[employeeId]` opens the
 * console with that employee already selected, so a roster row on
 * another surface (or a bookmarked "where is Ravi") lands preselected.
 * Same screen, same flag, same focus rule as the index route.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { useDensity } from '../../../src/components/ui/DensityProvider';
import { LocationConsoleScreen } from '../../../src/screens/owner/location';
import { useLocationConsole } from '../../../src/screens/owner/useLocationConsole';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const { employeeId } = useLocalSearchParams<{ employeeId: string }>();
  const density = useDensity();
  const desk = density === 'desk';
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const deps = useLocationConsole({ desk, focused, initialEmployeeId: employeeId });
  if (!deps.flagOn) {
    return (
      <View style={styles.root}>
        <Text>Location</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <LocationConsoleScreen {...deps} />
    </SafeAreaView>
  );
}
