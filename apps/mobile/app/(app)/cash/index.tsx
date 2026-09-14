/**
 * Cash reconciliation queue route (T4.9, UI/plan-2/07-OWNER.md §O2). The
 * seam where the pure screen meets the api. Two things are decided here,
 * not in the screen:
 *
 * - **`owner.cash`** keeps the queue dark until the server turns it on
 *   (PLAN-EXECUTION.md §3) — the honest placeholder, nothing spinning.
 *   This is the screen the phase exists for, so a dark flag is treated
 *   as an outage, not a rollback: the psql fallback lives in
 *   docs/implementation/T4.9-RUNBOOK.md.
 * - **Density** — `useDensity()` says whether this is the owner's desk
 *   (the table — rows, sortable columns, a scannable left edge) or his
 *   Android phone (the same rows as cards, `missing_submission` first).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerCashQueueScreen } from '../../../src/screens/owner/cash-queue';
import { useCashQueue } from '../../../src/screens/owner/useCashQueue';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default function Screen() {
  const deps = useCashQueue();
  if (!deps.flagOn) {
    return (
      <View style={styles.root}>
        <Text>Cash queue</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerCashQueueScreen {...deps} />
    </SafeAreaView>
  );
}
