import { describe, expect, it } from 'vitest';

import { allText, create, toJson } from '../../components/ui/testing';
import { discountNoteOf, SaleDetailScreen } from './SaleDetailScreen';
import type { SaleRecord } from '@servgrid/shared';

const SALE: SaleRecord = {
  id: 's1000000-0000-4000-8000-000000000001',
  saleNumber: 'SL-2627-00001',
  companyId: 'c1000000-0000-4000-8000-000000000001',
  salesRepId: 'r1000000-0000-4000-8000-000000000001',
  saleDate: '2026-09-14',
  status: 'confirmed',
  notes: 'Left the bill with Anil.',
  confirmedAt: '2026-09-14T06:00:00.000Z',
  voidedAt: null,
  voidReason: null,
  total: '7560.00',
  items: [
    {
      lineNo: 1,
      productId: 'p1000000-0000-4000-8000-000000000001',
      productName: 'APC BX1100C-IN Line-Interactive UPS',
      productSku: 'UPS-APC-BX1100',
      quantity: '1',
      unitPrice: '7560.00',
      listPrice: '8400.00',
      discountPct: '10.00',
      lineTotal: '7560.00',
      serialNumbers: ['SN12345'],
    },
  ],
  version: 1,
};

describe('SaleDetailScreen (§S2 read side)', () => {
  it('the full sale renders: number, status, company, the line with its serial, total, notes', async () => {
    const r = await create(
      <SaleDetailScreen sale={SALE} companyName="Sri Venkateswara Traders" loading={false} error={null} onRetry={() => {}} />,
    );
    const text = allText(toJson(r)).join('\n');
    expect(text).toContain('SL-2627-00001');
    expect(text).toContain('Confirmed');
    expect(text).toContain('Sri Venkateswara Traders');
    expect(text).toContain('APC BX1100C-IN Line-Interactive UPS');
    expect(text).toContain('1 × ₹7,560');
    expect(text).toContain('Serials: SN12345');
    expect(text).toContain('₹7,560');
    expect(text).toContain('Left the bill with Anil.');
  });

  it('a missing sale says so honestly', async () => {
    const r = await create(
      <SaleDetailScreen sale={null} companyName={null} loading={false} error={null} onRetry={() => {}} />,
    );
    expect(allText(toJson(r)).join('\n')).toContain("We couldn't find that sale");
  });
});

describe('discountNoteOf — the discount a rep gave stays visible (TON.6)', () => {
  it('names the list price and the percentage when the line kept them', () => {
    expect(discountNoteOf({ listPrice: '8400.00', discountPct: '10.00' })).toBe(' · list ₹8,400 · 10% off');
  });

  it('says nothing for a typed price, a zero discount, or a line recorded before discounts were kept', () => {
    expect(discountNoteOf({ listPrice: null, discountPct: null })).toBe('');
    expect(discountNoteOf({ listPrice: '500.00', discountPct: '0.00' })).toBe('');
  });
});
