/**
 * New sale — the rep's route (UI/plan-2/06-SALES-REP.md §S2, T3.7). The
 * §S2 form over the pure `SaleFormScreen`: this file owns the reads (his
 * accounts + house for the company search, the catalogue for the product
 * picker) and the writes — draft create, then confirm, the move that
 * allocates the number and lifts the balance. Both run directly against
 * the API, like every write in the app. Gated on
 * `sales.cards` — the same flag the sales surface answers to.
 */
import { useEffect, useRef, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type { Company, Product, SaleRecord } from '@servgrid/shared';
import { FRAME } from '@servgrid/shared';
import { uuid } from '../../../src/lib/uuid';
import { SaleFormScreen, type PickerCompany, type PickerProduct } from '../../../src/screens/rep/SaleFormScreen';
import { apiGet, apiSend, useOnline, useRepFlags } from '../../../src/screens/rep/useRepData';
import { istBusinessDate } from '../../../src/screens/technician/HandoverScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepSaleFormRoute(): React.ReactNode {
  const router = useRouter();
  const params = useLocalSearchParams<{ company?: string | string[] }>();
  const flags = useRepFlags();
  const online = useOnline();
  const [companies, setCompanies] = useState<PickerCompany[]>([]);
  const [products, setProducts] = useState<PickerProduct[]>([]);
  // One key per confirm intent: a stalled frame can deliver several taps
  // of the same enabled button, and the server's idempotency replay is
  // what turns those into ONE confirmation of the balance move. Cleared
  // on success; a failed confirm frees its claim server-side, so keeping
  // the key across a retry is safe (the body is the same `{}`).
  const confirmKeyRef = useRef<string | null>(null);
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
          // No isActive filter here: GET /v1/products already returns
          // active rows only (§6.4) and the wire schema carries no
          // isActive — filtering on it silently emptied the picker.
          productsR.value.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            defaultPrice: p.defaultPrice,
          })),
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
    // The frame reaches the status bar; the bottom inset is the shell's.
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <SaleFormScreen
        companies={companies}
        products={products}
        today={istBusinessDate(new Date())}
        initialCompanyId={companyParam ?? null}
        online={online}
        createDraft={(input) => apiSend<SaleRecord>('POST', '/v1/sales', input)}
        confirmSale={async (id) => {
          if (confirmKeyRef.current === null) confirmKeyRef.current = await uuid();
          const sale = await apiSend<SaleRecord>('POST', `/v1/sales/${id}/confirm`, {}, undefined, {
            idempotencyKey: confirmKeyRef.current,
          });
          confirmKeyRef.current = null;
          return sale;
        }}
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
