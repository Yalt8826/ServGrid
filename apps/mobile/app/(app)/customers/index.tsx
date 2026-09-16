/**
 * Customers — route. Two screens behind one path:
 *
 * - **Dispatcher** (D4, T2.10): search over name and phone, two-line
 *   rows, because his worst moment is the phone ringing while a
 *   technician is already on site. `dispatch.console` gates it.
 * - **Owner** (§O4b, T4.11): the whole customer base as a table — name ·
 *   area · phone · company · units · open jobs · last job — with the side
 *   detail and a door to create one. That screen and its hook were built
 *   in Phase 4 and never mounted: the route rendered the dispatcher's
 *   search for every role, which is why the owner's Customers page looked
 *   empty until he typed something (OW.5, 2026-09-16).
 *
 * The owner does not answer to `dispatch.console` — that flag is the
 * dispatcher console's rollback, never a gate on the person covering it.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { Button, DeskListShell, TextField } from '../../../src/components/ui';
import { CustomerSearchScreen } from '../../../src/screens/dispatcher/customer';
import { useCustomerSearch } from '../../../src/screens/dispatcher/useCustomer';
import { useDispatchJobLogsFlags } from '../../../src/screens/dispatcher/useJobLogs';
import { OwnerCustomersScreen } from '../../../src/screens/owner/CustomersScreen';
import { useOwnerCustomers } from '../../../src/screens/owner/useOwnerCustomers';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

/** One keystroke pause — the dispatch form's number, for the same reason. */
const SEARCH_DEBOUNCE_MS = 250;

function OwnerCustomersRoute(): React.ReactNode {
  const router = useRouter();
  // Typing searches on the pause, not on every character: the search is
  // the server's `?q=` over name and phone, because the table caps at 200
  // rows and filtering what is already fetched would search only those.
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const list = useOwnerCustomers(debouncedQuery);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <DeskListShell
        title="Customers"
        subtitle={
          debouncedQuery.trim() === ''
            ? `${list.rows.length} ${list.rows.length === 1 ? 'site' : 'sites'}`
            : `${list.rows.length} matching “${debouncedQuery.trim()}”`
        }
        actions={
          <>
            <View style={{ minWidth: 260 }}>
              <TextField
                label="Search"
                value={query}
                onChangeText={setQuery}
                placeholder="Name or phone"
                testID="owner-customers-search"
              />
            </View>
            {query === '' ? null : (
              <Button
                label="Clear"
                variant="secondary"
                onPress={() => setQuery('')}
                testID="owner-customers-search-clear"
              />
            )}
            <Button label="+ New customer" onPress={() => router.push('/customers/new')} testID="owner-customers-new" />
          </>
        }
        testID="owner-customers-page"
      >
        <OwnerCustomersScreen
          offline={list.offline}
          error={list.error}
          loading={list.loading}
          rows={list.rows}
          onRetryList={list.reload}
          emptyMessage={
            debouncedQuery.trim() === ''
              ? 'No customers yet.'
              : `No customer matches “${debouncedQuery.trim()}”.`
          }
          onOpenCustomer={(customerId) => router.push(`/customers/${customerId}`)}
        />
      </DeskListShell>
    </SafeAreaView>
  );
}

export default function Screen() {
  const flags = useDispatchJobLogsFlags();
  const actor = useSessionStore((s) => s.actor);
  const deps = useCustomerSearch();

  if (actor?.role === 'owner') return <OwnerCustomersRoute />;

  if (!flags.consoleOn) {
    // Dark without the flag — the honest placeholder, nothing spinning.
    return (
      <View style={styles.root}>
        <Text>Customers</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CustomerSearchScreen {...deps} />
    </SafeAreaView>
  );
}
