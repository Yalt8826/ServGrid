import { describe, expect, it } from 'vitest';

import type { PaymentRecord } from '@servgrid/shared';
import { allText, create, toJson } from '../../components/ui/testing';
import { PaymentDetailScreen } from './PaymentDetailScreen';

const PAYMENT: PaymentRecord = {
  id: 'p1000000-0000-4000-8000-000000000001',
  paymentNumber: 'PM-2627-00001',
  companyId: 'c1000000-0000-4000-8000-000000000001',
  salesCardId: 's1000000-0000-4000-8000-000000000001',
  amount: '3000.00',
  mode: 'cash',
  referenceNo: null,
  receivedBy: 'r1000000-0000-4000-8000-000000000001',
  receivedAt: '2026-09-14T06:30:00.000Z',
  businessDate: '2026-09-14',
  status: 'collected',
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  notes: null,
  version: 1,
};

describe('PaymentDetailScreen (§S3 read side)', () => {
  it('the way the money moved renders: number, amount, mode, day, company, the settled sale', async () => {
    const r = await create(
      <PaymentDetailScreen
        payment={PAYMENT}
        companyName="Sri Venkateswara Traders"
        againstSaleNumber="SL-2627-00001"
        loading={false}
        error={null}
        onRetry={() => {}}
      />,
    );
    const text = allText(toJson(r)).join('\n');
    expect(text).toContain('PM-2627-00001');
    expect(text).toContain('Collected');
    expect(text).toContain('₹3,000');
    expect(text).toContain('Cash');
    expect(text).toContain('Sri Venkateswara Traders');
    expect(text).toContain('SL-2627-00001');
  });

  it('on-account says so — the absence of a settled sale is the feature', async () => {
    const onAccount = { ...PAYMENT, salesCardId: null };
    const r = await create(
      <PaymentDetailScreen payment={onAccount} companyName="Sri Venkateswara Traders" againstSaleNumber={null} loading={false} error={null} onRetry={() => {}} />,
    );
    expect(allText(toJson(r)).join('\n')).toContain('On account');
  });
});
