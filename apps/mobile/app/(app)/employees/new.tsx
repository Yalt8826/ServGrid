/**
 * New employee — route (UI/plan-2/07-OWNER.md §O7, T4.12). Username,
 * name, phone, role, temporary password; `must_change_password` is
 * automatic and stated on the screen. Owner-only server-side.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { EmployeeFormScreen } from '../../../src/screens/owner/EmployeeFormScreen';
import { useCreateEmployee } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerNewEmployeeRoute(): React.ReactNode {
  const router = useRouter();
  const { busy, error, create } = useCreateEmployee();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <EmployeeFormScreen
        busy={busy}
        error={error}
        create={create}
        onDone={() => router.push('/employees')}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerNewEmployeeRoute />;
  return (
    <View style={styles.root}>
      <Text>New employee</Text>
    </View>
  );
}
