/**
 * New product — route (OW.3, 2026-09-16). The catalogue had a list and a
 * detail but no way to add to it, though the endpoint has existed since
 * Phase 0. Owner-only, as the server's own door is (§6.4).
 */
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { SEMANTIC } from '@servgrid/shared';
import { OwnerProductFormScreen } from '../../../src/screens/owner/CatalogFormScreens';
import { useCreateCatalogItem } from '../../../src/screens/owner/useOwnerData';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function OwnerProductFormRoute(): React.ReactNode {
  const router = useRouter();
  const { busy, error, create } = useCreateCatalogItem('products');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <OwnerProductFormScreen
        busy={busy}
        error={error}
        onCancel={() => router.back()}
        onSubmit={(payload) => {
          void create(payload)
            .then(() => router.replace('/products'))
            .catch(() => {
              // The banner carries the server's sentence; the form keeps
              // everything typed so a refusal costs a correction, not a retype.
            });
        }}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'owner') return <OwnerProductFormRoute />;
  return (
    <View style={styles.root}>
      <Text>New product</Text>
    </View>
  );
}
