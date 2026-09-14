/**
 * Sale detail route (field feedback 2026-09-14). The §S2 read: fetches
 * the rep's sales list (rep-scoped by the API), picks the one sale with
 * its line items, and resolves the company's name. The list is the
 * read — there is no GET-by-id on the sales surface, and a rep's month
 * of sales fits one unpaginated response.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';

import type { Company, SaleRecord } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { apiGet } from '../../../src/screens/rep/useRepData';
import { SaleDetailScreen } from '../../../src/screens/rep/SaleDetailScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepSaleDetailRoute(): React.ReactNode {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const saleId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [sale, setSale] = useState<SaleRecord | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const [salesR, companiesR] = await Promise.allSettled([
        apiGet<{ items: SaleRecord[] }>('/v1/sales'),
        apiGet<{ items: Company[] }>('/v1/companies'),
      ]);
      if (!alive) return;
      const found = salesR.status === 'fulfilled' ? (salesR.value.items.find((s) => s.id === saleId) ?? null) : null;
      setSale(found);
      if (companiesR.status === 'fulfilled') {
        setCompanyName(companiesR.value.items.find((c) => c.id === found?.companyId)?.name ?? null);
      }
      setError(salesR.status === 'rejected' ? 'The sales list could not be loaded.' : null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [saleId, tick]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <SaleDetailScreen
        sale={sale}
        companyName={companyName}
        loading={loading}
        error={error}
        onRetry={() => setTick((t) => t + 1)}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepSaleDetailRoute />;
  return (
    <View style={styles.root}>
      <Text>Sale detail</Text>
    </View>
  );
}
