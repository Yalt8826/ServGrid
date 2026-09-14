/**
 * Employees — route (UI/plan-2/07-OWNER.md §O7, T4.12). The owner's
 * roster: name · role · active · tracking health · last login, sorted by
 * health severity — the person with a problem is at the top. Owner-only
 * server-side (the employees surface's own door); no extra flag.
 */
import { SafeAreaView, } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerEmployeesScreen } from '../../../src/screens/owner/EmployeesScreen';
import { useOwnerEmployees } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';
import { Text, View, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerEmployeesRoute(): React.ReactNode {
  const router = useRouter();
  const employees = useOwnerEmployees();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerEmployeesScreen
        rows={employees.rows}
        error={employees.error}
        loading={employees.loading}
        onOpenEmployee={(employeeId) => router.push(`/employees/${employeeId}`)}
        onNewEmployee={() => router.push('/employees/new')}
        onRetry={employees.reload}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerEmployeesRoute />;
  return (
    <View style={styles.root}>
      <Text>Employees</Text>
    </View>
  );
}
