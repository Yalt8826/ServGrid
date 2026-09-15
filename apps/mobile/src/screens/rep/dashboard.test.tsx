/**
 * S1 Dashboard tests (UI/plan-2/06-SALES-REP.md §S1). The ones the spec
 * names:
 *
 * - **Figures never carry a stale inset or Pending sync** — the app is
 *   online-only, so nothing waits on the phone behind a figure.
 * - **Figures cross-fade, never count up** (mechanism asserted in
 *   `money.test.tsx`; here the figure text IS the value).
 * - The owed rows read "… · owes ₹85,000", descending — a rep's day is
 *   this list in order.
 * - Renewing soon shows days remaining, not a date.
 * - Empty: "No sales yet this month."
 */
import { describe, expect, it } from 'vitest';

import type { CompanyBalance, PaymentRecord, SaleRecord } from '@servgrid/shared';
import { allText, create, findByTestID, toJson } from '../../components/ui/testing';
import { RepDashboardScreen, owedRowText } from './DashboardScreen';
import { outstandingOf, owesTheMostOf, soldThisMonthOf } from './model';

const COMPANY_ID = 'c1000000-0000-4000-8000-000000000001';

function balance(overrides: Partial<CompanyBalance>): CompanyBalance {
  return {
    companyId: COMPANY_ID,
    name: 'Sterling Industries',
    balance: '85000.00',
    lastSaleDate: '2026-09-02',
    lastPaymentAt: null,
    ...overrides,
  };
}

function sale(overrides: Partial<SaleRecord>): SaleRecord {
  return {
    id: 's1000000-0000-4000-8000-000000000001',
    saleNumber: 'SL-2627-00018',
    companyId: COMPANY_ID,
    salesRepId: '10000000-0000-4000-8000-000000000001',
    saleDate: '2026-09-02',
    status: 'confirmed',
    notes: null,
    confirmedAt: '2026-09-02T06:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    total: '16800.00',
    items: [],
    version: 1,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'p1000000-0000-4000-8000-000000000001',
    paymentNumber: 'PM-2627-00042',
    companyId: COMPANY_ID,
    salesCardId: null,
    amount: '40000.00',
    mode: 'upi',
    referenceNo: 'UPI-8891',
    receivedBy: '10000000-0000-4000-8000-000000000001',
    receivedAt: '2026-09-06T04:30:00.000Z',
    businessDate: '2026-09-06',
    status: 'collected',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    notes: null,
    version: 1,
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof RepDashboardScreen>[0]> = {}) {
  return {
    name: 'Anitha',
    figures: { soldThisMonth: '420000', outstanding: '185000' },
    figuresError: null,
    salesOff: false,
    paymentsOff: false,
    owesTheMost: [
      { companyId: COMPANY_ID, name: 'Sterling Industries', balance: '85000.00' },
    ],
    renewingSoon: [],
    renewalsError: null,
    recentPayments: [],
    paymentsError: null,
    companyNames: {},
    onNewSale: () => {},
    onOpenCompany: () => {},
    onOpenPayments: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

describe('RepDashboardScreen (§S1)', () => {
  it('the figures never carry a stale inset or Pending sync — nothing waits on the phone', async () => {
    const tree = toJson(await create(<RepDashboardScreen {...baseProps()} />));
    expect(findByTestID(tree, 'dashboard-figure-sold-stale')).toBeUndefined();
    expect(findByTestID(tree, 'dashboard-figure-outstanding-stale')).toBeUndefined();
    expect(findByTestID(tree, 'dashboard-pending-badge')).toBeUndefined();
    expect(allText(tree)).not.toContain('Pending sync');
  });

  it('the figures render whole values, mono tabular — never a count-up', async () => {
    const r = await create(<RepDashboardScreen {...baseProps()} />);
    expect(allText(toJson(r))).toContain('₹4,20,000');
    expect(allText(toJson(r))).toContain('₹1,85,000');
    // en-IN grouping, Indian digit order — never 420,000.
    expect(allText(toJson(r))).not.toContain('420,000');
  });

  it('owed rows read "… · owes ₹85,000", sorted by balance descending', async () => {
    expect(owedRowText('Sterling Industries', '85000')).toBe('Sterling Industries · owes ₹85,000');

    // The model: positive balances, descending, top five.
    const rows = owesTheMostOf([
      balance({ companyId: 'c0000000-0000-4000-8000-00000000000a', name: 'Small', balance: '100' }),
      balance({ companyId: 'c0000000-0000-4000-8000-00000000000b', name: 'Big', balance: '90000' }),
      balance({ companyId: 'c0000000-0000-4000-8000-00000000000c', name: 'Mid', balance: '42500' }),
      balance({ companyId: 'c0000000-0000-4000-8000-00000000000d', name: 'Credit', balance: '-500' }),
      balance({ companyId: 'c0000000-0000-4000-8000-00000000000e', name: 'Zero', balance: '0' }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Big', 'Mid', 'Small']);

    const rendered = await create(
      <RepDashboardScreen
        {...baseProps({
          owesTheMost: rows,
        })}
      />,
    );
    const texts = allText(toJson(rendered));
    expect(texts).toContain('Big · owes ₹90,000');
    expect(texts).toContain('Mid · owes ₹42,500');
    expect(texts).toContain('Small · owes ₹100');
    // A credit balance is not outstanding — it appears nowhere in the list.
    expect(texts.join(' | ')).not.toContain('Credit · owes');
  });

  it('the figures compute from confirmed cards and positive balances only', () => {
    const month = '2026-09';
    expect(
      soldThisMonthOf(
        [
          sale({ total: '16800' }),
          sale({ id: 's1000000-0000-4000-8000-000000000002', status: 'draft', total: '99999' }),
          sale({ id: 's1000000-0000-4000-8000-000000000003', status: 'void', total: '50000' }),
          sale({ id: 's1000000-0000-4000-8000-000000000004', saleDate: '2026-08-31', total: '12345' }),
        ],
        month,
      ),
    ).toBe('16800');

    expect(outstandingOf([balance({ balance: '85000' }), balance({ balance: '-500' })])).toBe('85000');
  });

  it('renewing soon shows days remaining — urgency is the point, not a date', async () => {
    const r = await create(
      <RepDashboardScreen
        {...baseProps({
          renewingSoon: [
            {
              id: 'k1000000-0000-4000-8000-000000000001',
              site: 'Kormangala 3rd Blk',
              contractNumber: 'AMC-2627-0031',
              endDate: '2026-10-01',
              visitsUsed: 3,
              visitsIncluded: 4,
              contractValue: '18000',
              daysRemaining: 17,
            },
          ],
        })}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'dashboard-renewal-days-k1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(allText(tree)).toContain('17 days');
  });

  it('the empty month says so plainly — no illustration', async () => {
    const r = await create(
      <RepDashboardScreen
        {...baseProps({
          figures: { soldThisMonth: '0', outstanding: '0' },
          owesTheMost: [],
          recentPayments: [],
        })}
      />,
    );
    expect(findByTestID(toJson(r), 'dashboard-empty')).toBeDefined();
    expect(allText(toJson(r))).toContain('No sales yet this month.');
  });

  it('recent payments render for reassurance that they landed', async () => {
    const row = payment();
    const r = await create(
      <RepDashboardScreen
        {...baseProps({
          recentPayments: [
            {
              id: row.id,
              paymentNumber: row.paymentNumber,
              companyId: row.companyId,
              companyName: row.companyId,
              amount: row.amount,
              mode: row.mode,
              businessDate: row.businessDate,
            },
          ],
          companyNames: { [COMPANY_ID]: 'Sterling Industries' },
        })}
      />,
    );
    expect(findByTestID(toJson(r), `dashboard-payment-${row.id}`)).toBeDefined();
    expect(allText(toJson(r))).toContain('Sterling Industries');
    expect(allText(toJson(r)).join(' | ')).toContain('PM-2627-00042');
    expect(allText(toJson(r))).toContain('₹40,000');
  });
});
