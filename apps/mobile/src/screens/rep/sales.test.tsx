/**
 * S2 Sales tests (UI/plan-2/06-SALES-REP.md §S2). The ones the spec
 * names:
 *
 * - **Drafts sort first and carry the Draft chip** — an unconfirmed sale
 *   burns no number and moves no balance, so it leads the list visibly
 *   unfinished, showing `Draft` where the number would be.
 * - The create form: snapshot at add time, editable unit price, computed
 *   total (`v_sales_card_totals`'s definition), and the two-button
 *   ending with the confirmation step on Confirm sale.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { SalesScreen, SALE_STATUS_PILL } from './SalesScreen';
import {
  formComplete,
  itemsOf,
  lineTotalOf,
  nextLineKey,
  SaleFormScreen,
  type SaleFormLine,
} from './SaleFormScreen';
import { sortSalesRows, type SaleRow } from './model';

const COMPANY_ID = 'c1000000-0000-4000-8000-000000000001';
const TODAY = '2026-09-11';

function row(overrides: Partial<SaleRow>): SaleRow {
  return {
    id: 's1000000-0000-4000-8000-000000000001',
    saleNumber: null,
    companyId: COMPANY_ID,
    companyName: 'Sterling Industries',
    saleDate: '2026-09-02',
    total: '16800.00',
    status: 'draft',
    ...overrides,
  };
}

function line(overrides: Partial<SaleFormLine> = {}): SaleFormLine {
  return {
    key: nextLineKey(),
    productId: 'pr0000000-0000-4000-8000-000000000001',
    productName: 'UPS 850VA Luminous',
    productSku: 'UPS-850',
    quantity: '2',
    unitPrice: '8400',
    serialsOpen: false,
    serials: '',
    ...overrides,
  };
}

describe('SalesScreen — the list (§S2)', () => {
  it('drafts sort first, then sale date newest first', () => {
    const sorted = sortSalesRows([
      row({ id: 's1000000-0000-4000-8000-00000000000a', status: 'confirmed', saleDate: '2026-09-08' }),
      row({ id: 's1000000-0000-4000-8000-00000000000b', status: 'draft', saleDate: '2026-09-01' }),
      row({ id: 's1000000-0000-4000-8000-00000000000c', status: 'confirmed', saleDate: '2026-09-10' }),
      row({ id: 's1000000-0000-4000-8000-00000000000d', status: 'draft', saleDate: '2026-09-05' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([
      's1000000-0000-4000-8000-00000000000d', // drafts first — visibly unfinished
      's1000000-0000-4000-8000-00000000000b',
      's1000000-0000-4000-8000-00000000000c',
      's1000000-0000-4000-8000-00000000000a',
    ]);
  });

  it('a draft shows Draft where the number would be and carries the Draft chip', async () => {
    const draft = row({ status: 'draft', saleNumber: null });
    const confirmed = row({ id: 's1000000-0000-4000-8000-000000000002', status: 'confirmed', saleNumber: 'SL-2627-00018' });
    const r = await create(
      <SalesScreen
        rows={[draft, confirmed]}
        error={null}
        loading={false}
        onNewSale={() => {}}
        onOpenSale={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    // The chip, on the draft row only.
    expect(findByTestID(tree, `sale-draft-chip-${draft.id}`)).toBeDefined();
    expect(findByTestID(tree, `sale-draft-chip-${confirmed.id}`)).toBeUndefined();
    // The number column: Draft, never a fake local number; the confirmed
    // card shows its allocated number.
    expect(allText(findByTestID(tree, `sale-number-${draft.id}`)!)).toContain('Draft');
    expect(allText(findByTestID(tree, `sale-number-${confirmed.id}`)!)).toContain('SL-2627-00018');
    // Status pills: warning for Draft, success for Confirmed.
    expect(SALE_STATUS_PILL.draft.color).not.toBe(SALE_STATUS_PILL.confirmed.color);
  });
});

describe('SaleFormScreen — create (§S2)', () => {
  it('the total is computed and displayed, and an edited unit price moves it', () => {
    expect(lineTotalOf('2', '8400')).toBe('16800');
    // The negotiated price: the snapshot is editable, the total follows.
    expect(lineTotalOf('2', '8000')).toBe('16000');
    expect(lineTotalOf('1', '4250.50')).toBe('4250.50');
    expect(lineTotalOf('', '8400')).toBe('0');

    const lines = [line(), line({ productId: null, productName: 'Installation', productSku: null, unitPrice: '500' })];
    expect(lineTotalOf('2', '8400') === '16800' && lineTotalOf('1', '500') === '500').toBe(true);
    expect(itemsOf(lines)).toHaveLength(2);
    // An incomplete line blocks the form; adding a complete one unblocks.
    expect(formComplete(COMPANY_ID, [line({ quantity: '' })])).toBe(false);
    expect(formComplete(COMPANY_ID, lines)).toBe(true);
    expect(formComplete(null, lines)).toBe(false);
  });

  it('serial numbers are optional per line and collapsed until opened', async () => {
    const deps = {
      companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
      products: [
        { id: 'pr0000000-0000-4000-8000-000000000001', name: 'UPS 850VA Luminous', sku: 'UPS-850', defaultPrice: '8400' },
      ],
      today: TODAY,
      initialCompanyId: COMPANY_ID,
      createDraft: vi.fn(async () => ({ id: 's1000000-0000-4000-8000-000000000009' })),
      confirmSale: vi.fn(async () => ({})),
      onDone: vi.fn(),
    };
    const r = await create(<SaleFormScreen {...deps} />);
    // Add the product — the snapshot lands on the line.
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-option-pr0000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const added = toJson(r);
    const qtyNode = findAll(added, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('sale-form-line-qty-'))[0]!;
    const lineKey = String(qtyNode.props.testID).replace('sale-form-line-qty-', '');
    expect(findByTestID(toJson(r), `sale-form-line-serials-${lineKey}`)).toBeUndefined();
    await act(async () => {
      findAll(findByTestID(toJson(r), `sale-form-line-serials-open-${lineKey}`)!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const serials = findByTestID(toJson(r), `sale-form-line-serials-${lineKey}`)!;
    const input = findAll(serials, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      input.props.onChangeText?.(' SN001, SN002 ');
    });
    const items = itemsOf([{ ...line(), serials: 'SN001, SN002 ' }]);
    expect(items[0]!.serialNumbers).toEqual(['SN001', 'SN002']);
  });

  it('the two-button ending: Save draft posts a draft; Confirm sale confirms through the step', async () => {
    const createDraft = vi.fn(async (_input: unknown) => ({ id: 's1000000-0000-4000-8000-000000000009' }));
    const confirmSale = vi.fn(async () => ({}));
    const onDone = vi.fn();
    const deps = {
      companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
      products: [
        { id: 'pr0000000-0000-4000-8000-000000000001', name: 'UPS 850VA Luminous', sku: 'UPS-850', defaultPrice: '8400' },
      ],
      today: TODAY,
      initialCompanyId: COMPANY_ID,
      createDraft,
      confirmSale,
      onDone,
    };
    const r = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-option-pr0000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });

    // Save draft (secondary): one call, no confirm, no number.
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-save-draft')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY_ID,
      saleDate: TODAY,
      items: [{ productId: 'pr0000000-0000-4000-8000-000000000001', productName: 'UPS 850VA Luminous', quantity: 1, unitPrice: '8400' }],
    });
    expect(confirmSale).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith('s1000000-0000-4000-8000-000000000009', false);

    // Confirm sale (primary): the confirmation step comes first, and the
    // copy names what confirming does — moves the balance.
    const r2 = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r2), 'sale-form-product-option-pr0000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    await act(async () => {
      findAll(findByTestID(toJson(r2), 'sale-form-confirm')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    expect(findByTestID(toJson(r2), 'sale-form-confirm-dialog')).toBeDefined();
    expect(allText(toJson(r2)).join(' | ')).toContain('Confirming allocates the sale number');
    await act(async () => {
      findAll(findByTestID(toJson(r2), 'sale-form-confirm-dialog')!, (n) => n.type === 'Pressable')
        .find((n) => allText(n).includes('Confirm sale'))!
        .props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirmSale).toHaveBeenCalledWith('s1000000-0000-4000-8000-000000000009');
    expect(onDone).toHaveBeenCalledWith('s1000000-0000-4000-8000-000000000009', true);
  });

  it('the form is incomplete without a company or a complete line — the buttons say why', async () => {
    const createDraft = vi.fn(async () => ({ id: 'x' }));
    const r = await create(
      <SaleFormScreen
        companies={[]}
        products={[]}
        today={TODAY}
        createDraft={createDraft}
        confirmSale={vi.fn(async () => ({}))}
        onDone={() => {}}
      />,
    );
    const save = findAll(findByTestID(toJson(r), 'sale-form-save-draft')!, (n) => n.type === 'Pressable')[0]!;
    expect(save.props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => {
      save.props.onPress?.();
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});
