/**
 * New sale — the rep's route (UI/plan-2/06-SALES-REP.md §S2, T3.7). The
 * §S2 form over the pure `SaleFormScreen`: this file owns the reads (his
 * accounts + house for the company search, the catalogue for the product
 * picker) and the writes — draft create, then confirm, the move that
 * allocates the number and lifts the balance. Both run directly today,
 * like the cash-handover route's calls; the screen's seams make rewiring
 * to enqueue outbox rows a route-file change only. Gated on
 * `sales.cards` — the same flag the sales surface answers to.
 */
import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Company, Product, SaleRecord } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { SaleFormScreen, type PickerCompany, type PickerProduct } from '../../../src/screens/rep/SaleFormScreen';
import { apiGet, apiSend, useRepFlags } from '../../../src/screens/rep/useRepData';
import { istBusinessDate } from '../../../src/screens/technician/HandoverScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepSaleFormRoute(): React.ReactNode {
  const router = useRouter();
  const params = useLocalSearchParams<{ company?: string | string[] }>();
  const flags = useRepFlags();
  const [companies, setCompanies] = useState<PickerCompany[]>([]);
  const [products, setProducts] = useState<PickerProduct[]>([]);
  const companyParam = Array.isArray(params.company) ? params.company[0] : params.company;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [companiesR, productsR] = await Promise.allSettled([
        apiGet<{ items: Company[] }>('/v1/companies'),
        apiGet<Product[]>('/v1/products'),
      ]);
      if (!alive) return;
      if (companiesR.status === 'fulfilled') {
        setCompanies(companiesR.value.items.map((c) => ({ id: c.id, name: c.name })));
      }
      if (productsR.status === 'fulfilled') {
        setProducts(
          productsR.value
            .filter((p) => p.isActive)
            .map((p) => ({ id: p.id, name: p.name, sku: p.sku, defaultPrice: p.defaultPrice })),
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!flags.ready || !flags.cards) {
    return (
      <View style={styles.root}>
        <Text>New sale</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} edges={['top', 'left', 'right', 'bottom']}>
      <SaleFormScreen
        companies={companies}
        products={products}
        today={istBusinessDate(new Date())}
        initialCompanyId={companyParam ?? null}
        createDraft={(input) => apiSend<SaleRecord>('POST', '/v1/sales', input)}
        confirmSale={(id) => apiSend<SaleRecord>('POST', `/v1/sales/${id}/confirm`, {})}
        onDone={() => {
          // Back to the list, where the draft (or the number arriving
          // from the confirm) is the newest row.
          router.replace('/sales');
        }}
      />
    </SafeAreaView>
  );
}

export default function Screen() {
  const actor = useSessionStore((s) => s.actor);
  if (actor === null) return null;
  if (actor.role === 'sales_rep') return <RepSaleFormRoute />;
  return (
    <View style={styles.root}>
      <Text>New sale</Text>
    </View>
  );
}
