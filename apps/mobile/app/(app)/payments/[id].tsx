/**
 * Payment detail route (field feedback 2026-09-14): the way the money
 * moved, for one collection. Fetches the rep's payments (rep-scoped by
 * the API), picks the one payment, resolves the company's name and the
 * settled sale's number. There is no GET-by-id on the payments surface;
 * a rep's month fits the list.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';

import type { Company, PaymentRecord, SaleRecord } from '@servgrid/shared';
import { FRAME } from '@servgrid/shared';
import { apiGet } from '../../../src/screens/rep/useRepData';
import { PaymentDetailScreen } from '../../../src/screens/rep/PaymentDetailScreen';
import { useSessionStore } from '../../../src/state/sessionStore';

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

function RepPaymentDetailRoute(): React.ReactNode {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const paymentId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [payment, setPayment] = useState<PaymentRecord | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [againstSaleNumber, setAgainstSaleNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const [paymentsR, companiesR, salesR] = await Promise.allSettled([
        apiGet<{ items: PaymentRecord[] }>('/v1/payments'),
        apiGet<{ items: Company[] }>('/v1/companies'),
        apiGet<{ items: SaleRecord[] }>('/v1/sales'),
      ]);
      if (!alive) return;
      const found =
        paymentsR.status === 'fulfilled' ? (paymentsR.value.items.find((p) => p.id === paymentId) ?? null) : null;
      setPayment(found);
      if (companiesR.status === 'fulfilled' && found !== null) {
        setCompanyName(companiesR.value.items.find((c) => c.id === found.companyId)?.name ?? null);
      }
      if (salesR.status === 'fulfilled' && found?.salesCardId != null) {
        setAgainstSaleNumber(salesR.value.items.find((s) => s.id === found.salesCardId)?.saleNumber ?? null);
      }
      setError(paymentsR.status === 'rejected' ? 'The payments list could not be loaded.' : null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [paymentId, tick]);

  return (
    // The frame reaches the status bar; the bottom inset is the shell's.
    <SafeAreaView style={{ flex: 1, backgroundColor: FRAME.bg }} edges={['top', 'left', 'right']}>
      <PaymentDetailScreen
        payment={payment}
        companyName={companyName}
        againstSaleNumber={againstSaleNumber}
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
  if (actor.role === 'sales_rep') return <RepPaymentDetailRoute />;
  return (
    <View style={styles.root}>
      <Text>Payment detail</Text>
    </View>
  );
}
