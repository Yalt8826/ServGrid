/**
 * O5 Sales and Payments tests (UI/plan-2/07-OWNER.md §O5). **Void lives
 * here and only here — reason required, on both sales and payments**: a
 * void without a reason is a balance that moved for nothing. Running
 * totals count the confirmed documents; drafts move no money, voids are
 * reversals.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import { DensityProvider } from '../../components/ui';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { OwnerSalesScreen } from './SalesScreen';
import { OwnerPaymentsScreen } from './PaymentsScreen';
import { salesRunningTotalOf, paymentsRunningTotalOf, type OwnerSaleRow, type OwnerPaymentRow } from './model';

function sale(overrides: Partial<OwnerSaleRow>): OwnerSaleRow {
  return {
    id: 's1000000-0000-4000-8000-000000000001',
    saleNumber: 'SL-2627-00018',
    companyId: 'c1000000-0000-4000-8000-000000000001',
    companyName: 'Sterling Industries',
    repName: 'Ravi Kumar',
    saleDate: '2026-09-11',
    total: '16800',
    status: 'confirmed',
    ...overrides,
  };
}

function payment(overrides: Partial<OwnerPaymentRow>): OwnerPaymentRow {
  return {
    id: 'p1000000-0000-4000-8000-000000000001',
    paymentNumber: 'PM-2627-00031',
    companyId: 'c1000000-0000-4000-8000-000000000001',
    companyName: 'Sterling Industries',
    repName: 'Ravi Kumar',
    businessDate: '2026-09-12',
    amount: '10000',
    mode: 'cash',
    status: 'confirmed',
    ...overrides,
  };
}

describe('Sales — void lives here, reason required (§O5)', () => {
  it('confirmed cards carry the Void action; the sheet refuses an empty reason', async () => {
    const onVoid = vi.fn(async () => {});
    const r = await create(
      <OwnerSalesScreen
        onLoadSale={async () => null}
        rows={[sale({}), sale({ id: 's1000000-0000-4000-8000-000000000002', status: 'draft', saleNumber: null })]}
        error={null}
        loading={false}
        onVoid={onVoid}
        voidBusy={false}
        voidError={null}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    // Void on the confirmed card only — a draft has nothing to reverse.
    expect(findByTestID(tree, 'sale-void-s1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(tree, 'sale-void-s1000000-0000-4000-8000-000000000002')).toBeUndefined();

    // Open the sheet: the submit is disabled with the why.
    await act(async () => {
      findAll(findByTestID(tree, 'sale-void-s1000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    let sheet = toJson(r);
    expect(findByTestID(sheet, 'owner-sale-void-sheet')).toBeDefined();
    const confirm = findAll(findByTestID(sheet, 'void-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });

    // A reason unlocks it, and confirming carries the reason.
    const reason = findAll(findByTestID(sheet, 'void-reason')!, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      reason.props.onChangeText?.('Customer returned the goods — card entered twice.');
    });
    sheet = toJson(r);
    await act(async () => {
      findAll(findByTestID(sheet, 'void-confirm')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    expect(onVoid).toHaveBeenCalledWith(expect.objectContaining({ id: 's1000000-0000-4000-8000-000000000001' }), 'Customer returned the goods — card entered twice.');
  });
});

describe('Payments — void lives here too, reason required (§O5)', () => {
  it('confirmed collections carry the Void action; the sheet gates on the reason', async () => {
    const onVoid = vi.fn(async () => {});
    const r = await create(
      <OwnerPaymentsScreen
        onLoadPaymentProof={async () => null}
        rows={[payment({})]}
        error={null}
        loading={false}
        onVoid={onVoid}
        voidBusy={false}
        voidError={null}
        onRetry={() => {}}
      />,
    );
    await act(async () => {
      findAll(findByTestID(toJson(r), 'payment-void-p1000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const confirm = findAll(findByTestID(toJson(r), 'void-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('Running totals — confirmed documents only (§O5)', () => {
  it('sales: drafts move no money, voids are reversals', () => {
    expect(
      salesRunningTotalOf([
        sale({ total: '16800' }),
        sale({ id: 's1000000-0000-4000-8000-000000000002', total: '5000', status: 'draft', saleNumber: null }),
        sale({ id: 's1000000-0000-4000-8000-000000000003', total: '9999', status: 'void' }),
      ]),
    ).toBe('16800');
  });

  it('payments: only confirmed collections count', () => {
    expect(
      paymentsRunningTotalOf([
        payment({ amount: '10000' }),
        payment({ id: 'p1000000-0000-4000-8000-000000000002', amount: '4000', status: 'void' }),
      ]),
    ).toBe('10000');
  });

  it('both lists render the totals bar', async () => {
    const s = await create(
      <OwnerSalesScreen
        onLoadSale={async () => null} rows={[sale({})]} error={null} loading={false} onVoid={async () => {}} voidBusy={false} voidError={null} onRetry={() => {}} />,
    );
    expect(findByTestID(toJson(s), 'owner-sales-running-total')).toBeDefined();
    const p = await create(
      <OwnerPaymentsScreen
        onLoadPaymentProof={async () => null} rows={[payment({})]} error={null} loading={false} onVoid={async () => {}} voidBusy={false} voidError={null} onRetry={() => {}} />,
    );
    expect(findByTestID(toJson(p), 'owner-payments-running-total')).toBeDefined();
  });
});

describe('The screen rule — cards on a phone, a table on the desk (§O5)', () => {
  it('at desk density the sales list renders the sortable table with its totals bar', async () => {
    const r = await create(
      <DensityProvider density="desk">
        <OwnerSalesScreen
        onLoadSale={async () => null}
          rows={[sale({}), sale({ id: 's1000000-0000-4000-8000-000000000002', total: '5000', status: 'draft', saleNumber: null })]}
          error={null}
          loading={false}
          onVoid={async () => {}}
          voidBusy={false}
          voidError={null}
          onRetry={() => {}}
        />
      </DensityProvider>,
    );
    const tree = toJson(r);
    // The table: a header with sortable columns and one row per sale.
    expect(findByTestID(tree, 'table-header')).toBeDefined();
    expect(findByTestID(tree, 'header-sort-total')).toBeDefined();
    expect(findByTestID(tree, 'data-row-s1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(tree, 'data-row-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    expect(findByTestID(tree, 'owner-sales-running-total')).toBeDefined();
    expect(allText(tree).join(' ')).toContain('16,800');
  });
});

describe('the row IS the door to its document (owner, 2026-09-17)', () => {
  /**
   * The company page's ledger rows open the document behind them; the
   * owner asked for the same on these two lists. Sales rows preview the
   * products sold, payments rows the proof photo — through the SAME two
   * sheets the ledger uses, so the three doors cannot drift apart.
   */
  it('pressing a sale row opens the items sheet, which reads that row', async () => {
    const onLoadSale = vi.fn(async () => null);
    const r = await create(
      <DensityProvider density="desk">
        <OwnerSalesScreen
          onLoadSale={onLoadSale}
          rows={[sale({})]}
          error={null}
          loading={false}
          onVoid={async () => {}}
          voidBusy={false}
          voidError={null}
          onRetry={() => {}}
        />
      </DensityProvider>,
    );
    // Closed until a row is pressed: the sheet is absent, not invisible.
    expect(findByTestID(toJson(r), 'owner-sales-items-sheet')).toBeUndefined();

    const row = findByTestID(toJson(r), 'data-row-s1000000-0000-4000-8000-000000000001')!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });

    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-sales-items-sheet')).toBeDefined();
    // The number the row showed names the sheet — the owner can tell which
    // document he is looking at.
    expect(allText(tree).join(' ')).toContain('Sale SL-2627-00018');
    expect(onLoadSale).toHaveBeenCalledWith('s1000000-0000-4000-8000-000000000001');
  });

  it('pressing a payment row opens the proof sheet for THAT payment', async () => {
    const onLoadPaymentProof = vi.fn(async () => null);
    const r = await create(
      <DensityProvider density="desk">
        <OwnerPaymentsScreen
          onLoadPaymentProof={onLoadPaymentProof}
          rows={[payment({})]}
          error={null}
          loading={false}
          onVoid={async () => {}}
          voidBusy={false}
          voidError={null}
          onRetry={() => {}}
        />
      </DensityProvider>,
    );
    expect(findByTestID(toJson(r), 'owner-payments-proof-sheet')).toBeUndefined();

    const row = findByTestID(toJson(r), 'data-row-p1000000-0000-4000-8000-000000000001')!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });

    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-payments-proof-sheet')).toBeDefined();
    expect(allText(tree).join(' ')).toContain('Payment PM-2627-00031');
    expect(onLoadPaymentProof).toHaveBeenCalledWith('p1000000-0000-4000-8000-000000000001');
  });

  it('a payment nobody photographed says so — the sheet never shows a broken image', async () => {
    const r = await create(
      <DensityProvider density="desk">
        <OwnerPaymentsScreen
          onLoadPaymentProof={async () => null}
          rows={[payment({})]}
          error={null}
          loading={false}
          onVoid={async () => {}}
          voidBusy={false}
          voidError={null}
          onRetry={() => {}}
        />
      </DensityProvider>,
    );
    const row = findByTestID(toJson(r), 'data-row-p1000000-0000-4000-8000-000000000001')!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });
    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-payments-proof-sheet-empty')).toBeDefined();
    expect(findByTestID(tree, 'owner-payments-proof-sheet-image')).toBeUndefined();
  });

  it('a dead read says what broke, and offers no image', async () => {
    const r = await create(
      <DensityProvider density="desk">
        <OwnerSalesScreen
          onLoadSale={async () => {
            throw new Error('The sales list could not be loaded.');
          }}
          rows={[sale({})]}
          error={null}
          loading={false}
          onVoid={async () => {}}
          voidBusy={false}
          voidError={null}
          onRetry={() => {}}
        />
      </DensityProvider>,
    );
    const row = findByTestID(toJson(r), 'data-row-s1000000-0000-4000-8000-000000000001')!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });
    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-sales-items-sheet-error')).toBeDefined();
    expect(allText(tree).join(' ')).toContain('The sales list could not be loaded.');
  });
});
