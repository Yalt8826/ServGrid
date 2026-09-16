/**
 * Location console route (T4.10, UI/plan-2/07-OWNER.md §O3). The seam
 * where the pure screen meets the api. Three things are decided here,
 * not in the screen:
 *
 * - **`owner.location`** keeps the console dark until the server turns
 *   it on (PLAN-EXECUTION.md §3) — the honest placeholder, nothing
 *   spinning.
 * - **Focus** — expo-router's `useFocusEffect` is the `useIsFocused`
   * of this app. Blur sets it false, and false is what cancels the one
 *   permitted pulse and pauses the polling: a screen the owner cannot
 *   see does not keep timers.
 * - **Density** — `useDensity()` says whether this is the owner's desk
 *   (three panes, map included) or his Android phone (roster only, no
 *   map — the part that survives descoping).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { DeskListShell } from '../../../src/components/ui';
import { useDensity } from '../../../src/components/ui/DensityProvider';
import { LocationConsoleScreen } from '../../../src/screens/owner/location';
import { useLocationConsole } from '../../../src/screens/owner/useLocationConsole';
import { useFlagsReady } from '../../../src/state/useFlagsReady';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const density = useDensity();
  const desk = density === 'desk';
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const deps = useLocationConsole({ desk, focused });
  const flagsReady = useFlagsReady();
  if (!flagsReady || !deps.flagOn) {
    // Unknown flags read as off on a cold browser load — wait for the
    // /auth/me answer before rendering the honest dark placeholder.
    return (
      <View style={styles.root}>
        <Text>Location</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DeskListShell title="Location" testID="owner-location-page">
        <LocationConsoleScreen {...deps} />
      </DeskListShell>
    </SafeAreaView>
  );
}
