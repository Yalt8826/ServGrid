/**
 * Service calls route (2026-09-17, Yashas). The seam where the pure
 * `ServiceCallsScreen` meets the api: `useServiceCalls` owns the read and
 * the follow-up write, and the deep links into the dispatch form are the
 * AMC tab's own (`/jobs/new?customerId=…`, the form that already knows how
 * to arrive with a customer chosen).
 *
 * Guarded like the jobs it is built on (`job` × `read`, `all` only) — the
 * list is the whole book of customers, so a row-scoped cell must not reach
 * it; the API refuses a technician and a rep for the same reason.
 */
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FRAME } from '@servgrid/shared';
import { ServiceCallsScreen } from '../../src/screens/dispatcher/serviceCalls';
import { useServiceCalls } from '../../src/screens/dispatcher/useServiceCalls';
import { istBusinessDateKey } from '../../src/screens/dispatcher/jobLogsFilters';

export default function Screen() {
  const router = useRouter();
  const deps = useServiceCalls();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <ServiceCallsScreen
        {...deps}
        todayIso={istBusinessDateKey(new Date())}
        onAssign={(customerId: string) => router.push(`/jobs/new?customerId=${customerId}`)}
      />
    </SafeAreaView>
  );
}
