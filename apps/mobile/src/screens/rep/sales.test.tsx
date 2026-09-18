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
  SaleFormScreen,
  formComplete,
  invoiceTotalOf,
  isValidQuantity,
  itemsOf,
  lineTotalOf,
  nextLineKey,
  quantityValueOf,
  type SaleFormLine,
} from './SaleFormScreen';
import { dayLabelFor, filterSalesByDay, salesDaySections, sortSalesRows, type SaleRow } from './model';

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

describe('the list\u2019s day sections (§S2, 2026-09-18)', () => {
  it('a heading names the day: today, yesterday, then the date', () => {
    expect(dayLabelFor('2026-09-14', '2026-09-14')).toBe('Today');
    expect(dayLabelFor('2026-09-13', '2026-09-14')).toBe('Yesterday');
    expect(dayLabelFor('2026-09-08', '2026-09-14')).toBe('Tue 8 Sep');
    // A different year says so — a rep scrolling back must know which one.
    expect(dayLabelFor('2025-09-08', '2026-09-14')).toBe('Mon 8 Sep 2025');
  });

  it('the list divides by the day it was sold, newest day first, drafts first inside their own', () => {
    const sections = salesDaySections(
      [
        row({ id: 'a', status: 'confirmed', saleDate: '2026-09-08', total: '1000' }),
        row({ id: 'b', status: 'draft', saleDate: '2026-09-14', total: '2000' }),
        row({ id: 'c', status: 'confirmed', saleDate: '2026-09-14', total: '3000' }),
        row({ id: 'd', status: 'draft', saleDate: '2026-09-08', total: '500' }),
      ],
      '2026-09-14',
    );
    expect(sections.map((s) => s.label)).toEqual(['Today', 'Tue 8 Sep']);
    // A sale belongs to the day it was raised, so the day decides the section
    // and the draft rule applies within it.
    expect(sections[0]!.rows.map((r) => r.id)).toEqual(['b', 'c']);
    expect(sections[1]!.rows.map((r) => r.id)).toEqual(['d', 'a']);
    // Each day carries what he sold that day.
    expect(sections[0]!.total).toBe('5000');
    expect(sections[1]!.total).toBe('1500');
  });

  it('the day filter reaches backwards — today is not its floor', async () => {
    const early = row({ id: 's1000000-0000-4000-8000-0000000000e1', status: 'confirmed', saleDate: '2026-09-08', saleNumber: 'SL-2627-00001' });
    const late = row({ id: 's1000000-0000-4000-8000-0000000000e2', status: 'confirmed', saleDate: '2026-09-14', saleNumber: 'SL-2627-00002' });
    const r = await create(
      <SalesScreen
        rows={[early, late]}
        error={null}
        loading={false}
        todayIso="2026-09-14"
        onNewSale={() => {}}
        onOpenSale={() => {}}
        onRetry={() => {}}
      />,
    );
    await act(async () => {
      findByTestID(toJson(r), 'sales-filter-day')!.props.onPress?.();
    });
    const tree = toJson(r);
    expect(findByTestID(tree, 'sales-day-sheet')).toBeDefined();
    // A day already sold must be pickable: the filter looks back.
    const past = findByTestID(tree, 'sales-day-calendar-day-2026-09-08')!;
    expect((past.props.accessibilityState as { disabled: boolean }).disabled).toBe(false);
    // Picking it narrows the list, and the frame says which day is on.
    await act(async () => {
      past.props.onPress?.();
    });
    const narrowed = toJson(r);
    expect(findByTestID(narrowed, 'sales-day-2026-09-08')).toBeDefined();
    expect(findByTestID(narrowed, 'sales-day-2026-09-14')).toBeUndefined();
    expect(allText(findByTestID(narrowed, 'sales-filter-day')!)).toContain('Tue 8 Sep');
    // …and "Any day" in the sheet, or the ✕, puts every day back.
    await act(async () => {
      findByTestID(narrowed, 'sales-filter-clear')!.props.onPress?.();
    });
    expect(findByTestID(toJson(r), 'sales-day-2026-09-14')).toBeDefined();
    expect(findByTestID(toJson(r), 'sales-day-2026-09-08')).toBeDefined();
  });

  it('the filter narrows to one day, and null is every day', () => {
    const rows = [
      row({ id: 'a', saleDate: '2026-09-08' }),
      row({ id: 'b', saleDate: '2026-09-14' }),
    ];
    expect(filterSalesByDay(rows, null).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterSalesByDay(rows, '2026-09-14').map((r) => r.id)).toEqual(['b']);
    expect(filterSalesByDay(rows, '2026-09-01')).toEqual([]);
  });
});

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
        todayIso="2026-09-14"
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
    // The discount is the invoice's now, applied to every line and summed.
    expect(invoiceTotalOf([line()], '10')).toBe('15120');
    expect(invoiceTotalOf([line(), line({ quantity: '1', unitPrice: '1000' })], '10')).toBe('16020');
    expect(invoiceTotalOf([line()], '')).toBe('16800');
    expect(lineTotalOf('1', '4250.50')).toBe('4250.50');
    // A blank quantity is the placeholder's 1 (2026-09-18: the qty field
    // opens empty showing a grey 1, so typing overwrites the suggestion
    // instead of the rep having to delete it first).
    expect(lineTotalOf('', '8400')).toBe('8400');
    expect(quantityValueOf('')).toBe(1);
    expect(quantityValueOf('2.5')).toBe(2.5);
    expect(isValidQuantity('')).toBe(true);
    // …but zero is still not a line: no units is a line to remove.
    expect(isValidQuantity('0')).toBe(false);

    const lines = [line(), line({ productId: null, productName: 'Installation', productSku: null, unitPrice: '500' })];
    expect(lineTotalOf('2', '8400') === '16800' && lineTotalOf('1', '500') === '500').toBe(true);
    expect(itemsOf(lines)).toHaveLength(2);
    // A blank quantity no longer blocks the form — it IS one unit — while a
    // zero or a missing product still does.
    expect(formComplete(COMPANY_ID, [line({ quantity: '' })])).toBe(true);
    expect(formComplete(COMPANY_ID, [line({ quantity: '0' })])).toBe(false);
    expect(formComplete(COMPANY_ID, lines)).toBe(true);
    expect(formComplete(null, lines)).toBe(false);
    // The payload carries the resolved quantity, never a blank string.
    expect(itemsOf([line({ quantity: '' })])[0]!.quantity).toBe(1);
  });

  it('the sale date can actually be moved — the tappable field was a stub', async () => {
    const deps = {
      companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
      products: [],
      today: TODAY,
      online: true,
      initialCompanyId: COMPANY_ID,
      createDraft: vi.fn(async () => ({ id: 's1000000-0000-4000-8000-000000000010' })),
      confirmSale: vi.fn(async () => ({})),
      onDone: vi.fn(),
    };
    const r = await create(<SaleFormScreen {...deps} />);
    // The field shows today (the fixture's day)…
    expect(allText(findByTestID(toJson(r), 'sale-form-date')!)).toContain('11 Sep');

    // …and its trigger opens the app's month calendar rather than re-emitting
    // the date it already held (the stub's old behaviour).
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-date')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
    const open = toJson(r);
    expect(findByTestID(open, 'sale-form-date-calendar')).toBeDefined();
    // A day already past is pickable: a rep files the sale the morning after.
    const earlier = findAll(findByTestID(open, 'sale-form-date-calendar-day-2026-09-08')!, (n) => typeof n.props.onPress === 'function')[0]!;
    expect((earlier.props.accessibilityState as { disabled: boolean }).disabled).toBe(false);

    await act(async () => {
      earlier.props.onPress?.();
    });
    expect(allText(findByTestID(toJson(r), 'sale-form-date')!)).toContain('8 Sep');
    expect(findByTestID(toJson(r), 'sale-form-date-sheet')).toBeUndefined();
  });

  it('the account dropdown filters as he types, and the locality is searchable too', async () => {
    const OTHER = 'c2000000-0000-4000-8000-000000000002';
    const deps = {
      companies: [
        { id: COMPANY_ID, name: 'Sterling Industries', city: 'Whitefield' },
        { id: OTHER, name: 'Ganesh Electricals', city: 'Jayanagar' },
      ],
      products: [],
      today: TODAY,
      online: true,
      createDraft: vi.fn(async () => ({ id: 's1000000-0000-4000-8000-000000000012' })),
      confirmSale: vi.fn(async () => ({})),
      onDone: vi.fn(),
    };
    const r = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-company-trigger')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });

    // Two rows is far under the threshold that turns the field on by itself
    // — the form asks for it, because the list grows.
    const search = findByTestID(toJson(r), 'sale-form-company-search');
    expect(search).toBeDefined();
    // The row names where the account is, so "whitefield" is a search term.
    expect(allText(findByTestID(toJson(r), `sale-form-company-option-${COMPANY_ID}`)!)).toEqual([
      'Sterling Industries',
      'Whitefield',
    ]);

    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-company-search')!, (n) => n.type === 'TextInput')[0]!.props.onChangeText?.('jaya');
    });
    expect(findByTestID(toJson(r), `sale-form-company-option-${COMPANY_ID}`)).toBeUndefined();
    expect(findByTestID(toJson(r), `sale-form-company-option-${OTHER}`)).toBeDefined();
  });

  it('the discount is the invoice’s, not the line’s — and it moves the total and the payload', async () => {
    const createDraft = vi.fn(async (_input: unknown) => ({ id: 's1000000-0000-4000-8000-000000000011' }));
    const deps = {
      companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
      products: [
        { id: 'pr0000000-0000-4000-8000-000000000001', name: 'UPS 850VA Luminous', sku: 'UPS-850', defaultPrice: '8400' },
      ],
      today: TODAY,
      online: true,
      initialCompanyId: COMPANY_ID,
      createDraft,
      confirmSale: vi.fn(async () => ({})),
      onDone: vi.fn(),
    };
    const r = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-trigger')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-option-pr0000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });

    // No line carries a discount field any more.
    const qtyNode = findAll(toJson(r), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('sale-form-line-qty-'))[0]!;
    const lineKey = String(qtyNode.props.testID).replace('sale-form-line-qty-', '');
    expect(findByTestID(toJson(r), `sale-form-line-discount-${lineKey}`)).toBeUndefined();
    // …the invoice does, and the subtotal is the lines at list.
    expect(allText(findByTestID(toJson(r), 'sale-form-subtotal')!)).toEqual(['₹8,400']);
    expect(allText(findByTestID(toJson(r), 'sale-form-total')!)).toEqual(['Total', '₹8,400']);

    // 10% off the sale moves the total, and the payload carries it per line
    // (the server prices each line from list + discount, so the sums agree).
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-discount')!, (n) => n.type === 'TextInput')[0]!.props.onChangeText?.('10');
    });
    expect(allText(findByTestID(toJson(r), 'sale-form-total')!)).toEqual(['Total', '₹7,560']);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-save-draft')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0]![0]).toMatchObject({
      items: [{ productName: 'UPS 850VA Luminous', quantity: 1, listPrice: '8400', discountPct: '10' }],
    });
  });

  it('serial numbers are optional per line and collapsed until opened', async () => {
    const deps = {
      companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
      products: [
        { id: 'pr0000000-0000-4000-8000-000000000001', name: 'UPS 850VA Luminous', sku: 'UPS-850', defaultPrice: '8400' },
      ],
      today: TODAY,
      online: true,
      initialCompanyId: COMPANY_ID,
      createDraft: vi.fn(async () => ({ id: 's1000000-0000-4000-8000-000000000009' })),
      confirmSale: vi.fn(async () => ({})),
      onDone: vi.fn(),
    };
    const r = await create(<SaleFormScreen {...deps} />);
    // Add the product — the snapshot lands on the line. It is a dropdown now,
    // so the option lives behind its trigger (2026-09-18).
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-trigger')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
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
      online: true,
      initialCompanyId: COMPANY_ID,
      createDraft,
      confirmSale,
      onDone,
    };
    const r = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'sale-form-product-trigger')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
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
      items: [{ productId: 'pr0000000-0000-4000-8000-000000000001', productName: 'UPS 850VA Luminous', quantity: 1, listPrice: '8400', discountPct: '0' }],
    });
    expect(confirmSale).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith('s1000000-0000-4000-8000-000000000009', false);

    // Confirm sale (primary): the confirmation step comes first, and the
    // copy names what confirming does — moves the balance.
    const r2 = await create(<SaleFormScreen {...deps} />);
    await act(async () => {
      findAll(findByTestID(toJson(r2), 'sale-form-product-trigger')!, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
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
        online
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

  it('offline, the submits are disabled and the reasons name the connection', async () => {
    const createDraft = vi.fn(async () => ({ id: 'x' }));
    const r = await create(
      <SaleFormScreen
        companies={[]}
        products={[]}
        today={TODAY}
        online={false}
        createDraft={createDraft}
        confirmSale={vi.fn(async () => ({}))}
        onDone={() => {}}
      />,
    );
    const save = findAll(findByTestID(toJson(r), 'sale-form-save-draft')!, (n) => n.type === 'Pressable')[0]!;
    const confirm = findAll(findByTestID(toJson(r), 'sale-form-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(save.props.accessibilityState).toMatchObject({ disabled: true });
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });
    // The reason names the connection, not the empty form — offline is
    // the gate that bites first.
    expect(allText(toJson(r)).join('\n')).toContain("You're offline — saving needs a connection.");
    await act(async () => {
      save.props.onPress?.();
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});
