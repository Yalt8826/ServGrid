/**
 * New company route (field feedback 2026-09-14): the rep's create form
 * over the pure CompanyFormScreen. POST /v1/companies runs directly like
 * the rest of the rep's writes; the server stamps the creating rep as
 * the owner, so on success the route opens the new account's ledger.
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type { Company } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { apiSend, useOnline } from '../../../src/screens/rep/useRepData';
import { CompanyFormScreen } from '../../../src/screens/rep/CompanyFormScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepNewCompanyRoute(): React.ReactNode {
  const router = useRouter();
  const online = useOnline();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <CompanyFormScreen
        online={online}
        create={async (input) => {
          const company = await apiSend<Company>('POST', '/v1/companies', input);
          return company.id;
        }}
        onCreated={(companyId) => router.replace(`/companies/${companyId}`)}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepNewCompanyRoute />;
  return (
    <View style={styles.root}>
      <Text>New account</Text>
    </View>
  );
}
