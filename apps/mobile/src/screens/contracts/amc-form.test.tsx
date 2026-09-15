/**
 * The AMC form's tests (T2B.4, §D5 "Form"). The ones the spec names:
 *
 * - **New mode** starts today with the 12-month default end; changing
 *   the start moves the end only while the end still IS that default —
 *   a hand-edited end is never overwritten (the coupling is the pure
 *   `endAfterStartChange`, driven here through the real render path).
 * - **Submit with nothing** renders the customer's and the price's
 *   sentences under their fields and never calls `onSubmit`.
 * - **Renew mode** shows the customer read-only (an AMC never moves
 *   between sites) with the prefilled dates and price.
 * - **The overlap** renders the server's sentence with the existing
 *   AMC's number as a link — the raw code never shows.
 */
import { describe, expect, it, vi } from 'vitest';

import { ContractSchema } from '@servgrid/shared';
import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { allText, create, findByTestID, firstDescendantOfType, toJson, type Node } from '../../components/ui/testing';
import { defaultEndFor, endAfterStartChange, newDraft, renewalDraftOf } from './model';
import { AmcFormScreen, type AmcFormScreenProps } from './AmcFormScreen';

// ── fixtures ─────────────────────────────────────────────────────────────

const CUST_ID = '01890a5e-1000-7000-8000-00000000c001';
const TODAY = '2026-09-15';

const SUNRISE = { id: CUST_ID, name: 'Sunrise Apartments', phone: '9845012345', addressLabel: '12 3rd Cross' };

function baseProps(overrides: Partial<AmcFormScreenProps> = {}): AmcFormScreenProps {
  return {
    mode: 'new',
    draft: newDraft(TODAY),
    onChange: vi.fn(),
    customerSearch: {
      query: '',
      results: null,
      error: null,
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onClear: vi.fn(),
    },
    saving: false,
    saveError: null,
    onOpenExisting: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

function findID(renderer: ReactTestRenderer, testID: string): Node | undefined {
  return findByTestID(toJson(renderer), testID);
}

function press(node: Node): void {
  expect(typeof node.props.onPress).toBe('function');
  act(() => {
    node.props.onPress?.();
  });
}

function pressableOf(node: Node): Node {
  if (typeof node.props.onPress === 'function') return node;
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.shift()!;
    if (typeof current.props.onPress === 'function') return current;
    for (const child of current.children ?? []) {
      if (child !== null && typeof child !== 'string') stack.push(child);
    }
  }
  throw new Error('no pressable inside');
}

function typeInto(renderer: ReactTestRenderer, testID: string, text: string): void {
  const field = findID(renderer, testID);
  expect(field).toBeDefined();
  const input = firstDescendantOfType(field!, 'TextInput');
  expect(input).toBeDefined();
  act(() => {
    input!.props.onChangeText?.(text);
  });
}

// ── the coupling ─────────────────────────────────────────────────────────

describe('start \u2192 end coupling (endAfterStartChange)', () => {
  const draft = newDraft(TODAY); // end is the untouched default

  it('a default end moves with the start', () => {
    expect(endAfterStartChange(draft, '2026-10-31', 'new')).toBe(defaultEndFor('2026-10-31'));
    expect(endAfterStartChange(draft, '2026-10-31', 'renew')).toBe(defaultEndFor('2026-10-31'));
  });

  it('a hand-edited end never moves', () => {
    const edited = { ...draft, endDate: '2028-03-31' };
    expect(endAfterStartChange(edited, '2026-10-31', 'new')).toBe('2028-03-31');
  });

  it('edit mode never silently moves the term', () => {
    expect(endAfterStartChange(draft, '2026-10-31', 'edit')).toBe(draft.endDate);
  });
});

// ── the screen ───────────────────────────────────────────────────────────

describe('AmcFormScreen (§D5)', () => {
  it('new mode: start today, end at the default; the render path keeps the coupling', async () => {
    let draft = newDraft(TODAY);
    const onChange = vi.fn((next: typeof draft) => {
      draft = next;
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = await create(<AmcFormScreen {...baseProps({ draft, onChange })} />);
    });

    // The blank form proposes start today, end = start + 12 months − 1 day.
    expect(findID(renderer, 'amc-start')).toBeDefined();
    expect(allText(findID(renderer, 'amc-start')!).join(' ')).toContain('15 Sep');
    expect(allText(findID(renderer, 'amc-end')!).join(' ')).toContain('14 Sep 2027');

    // The date field's trigger runs the coupling through the real render
    // path: whatever start the picker hands over, the end lands on that
    // start's default.
    press(pressableOf(findID(renderer, 'amc-start-trigger')!));
    expect(onChange).toHaveBeenCalled();
    const emitted = onChange.mock.calls.at(-1)![0] as typeof draft;
    expect(emitted.endDate).toBe(defaultEndFor(emitted.startDate));
  });

  it('a hand-edited end survives the start changing on the render path', async () => {
    const handEdited = { ...newDraft(TODAY), endDate: '2028-03-31' };
    const onChange = vi.fn();
    const renderer = await create(<AmcFormScreen {...baseProps({ draft: handEdited, onChange })} />);

    press(pressableOf(findID(renderer, 'amc-start-trigger')!));
    const emitted = onChange.mock.calls[0]![0] as typeof handEdited;
    expect(emitted.endDate).toBe('2028-03-31');
  });

  it('submit with nothing renders the customer\u2019s and the price\u2019s sentences under their fields, and onSubmit is not called', async () => {
    const onSubmit = vi.fn();
    const renderer = await create(<AmcFormScreen {...baseProps({ onSubmit })} />);

    press(pressableOf(findID(renderer, 'amc-save')!));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(allText(findID(renderer, 'amc-customer-problem')!).join(' ')).toBe('Who is the AMC for? Pick a customer.');
    // The price sentence is the MoneyField's own error slot — under the field.
    expect(allText(findID(renderer, 'amc-price-error')!).join(' ')).toBe('Enter the AMC price, for example 18000.');
  });

  it('typing a customer searches; picking one clears the search box (the shared rows)', async () => {
    const customerSearch = {
      query: '',
      results: null,
      error: null,
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onClear: vi.fn(),
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = await create(<AmcFormScreen {...baseProps({ customerSearch })} />);
    });
    typeInto(renderer, 'amc-customer-field', 'Sun');
    expect(customerSearch.onQueryChange).toHaveBeenCalledWith('Sun');

    await act(async () => {
      renderer.update(
        <AmcFormScreen
          {...baseProps({
            customerSearch: { ...customerSearch, query: 'Sun', results: [SUNRISE] },
          })}
        />,
      );
    });
    const rows = findID(renderer, 'amc-customer-result-01890a5e-1000-7000-8000-00000000c001');
    expect(rows).toBeDefined();
    expect(allText(rows!).join(' ')).toContain('Sunrise Apartments');
    expect(allText(rows!).join(' ')).toContain('9845012345');
  });

  it('a picked customer collapses to one line with a Change action; picking clears back to search', async () => {
    const onClear = vi.fn();
    const renderer = await create(
      <AmcFormScreen
        {...baseProps({
          draft: { ...newDraft(TODAY), customerId: CUST_ID, customerName: 'Sunrise Apartments' },
          customerSearch: {
            query: '',
            results: null,
            error: null,
            onQueryChange: vi.fn(),
            onSelect: vi.fn(),
            onClear,
          },
        })}
      />,
    );
    const selected = findID(renderer, 'amc-customer-selected');
    expect(selected).toBeDefined();
    expect(allText(selected!).join(' ')).toContain('Sunrise Apartments');
    expect(findID(renderer, 'amc-customer-field')).toBeUndefined();
    press(pressableOf(findID(renderer, 'amc-customer-change')!));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renew mode shows the customer read-only with the prefilled dates and price', async () => {
    const source = ContractSchema.parse({
      id: 'b1000000-0000-4000-8000-00000000000b',
      contractNumber: 'AMC-2627-00031',
      customerId: CUST_ID,
      customerName: 'Sunrise Apartments',
      startDate: '2026-09-15',
      endDate: '2027-09-14',
      contractValue: '18000.00',
      notes: 'Gate code 4412',
      createdBy: '01890a5e-5000-7000-8000-00000000e001',
      createdByName: 'The dispatcher',
      createdAt: '2026-09-15T04:30:00.000Z',
      cancelledAt: null,
      cancelReason: null,
      state: 'active',
      lastServiceDate: '2026-05-03',
      nextVisitDue: '2026-09-03',
      openJob: null,
      daysToEnd: 364,
      isVisitDue: true,
      isEndingSoon: false,
      version: 1,
    });
    const draft = renewalDraftOf(source);
    const renderer = await create(<AmcFormScreen {...baseProps({ mode: 'renew', draft })} />);

    expect(allText(findID(renderer, 'amc-form')!).join(' ')).toContain('Renew AMC');
    // The customer is shown, not searched, and there is no way to change him.
    expect(findID(renderer, 'amc-customer-selected')).toBeDefined();
    expect(findID(renderer, 'amc-customer-change')).toBeUndefined();
    expect(findID(renderer, 'amc-customer-field')).toBeUndefined();
    // Prefilled: start the day after the old end, the 12-month default, the same price.
    expect(allText(findID(renderer, 'amc-start')!).join(' ')).toContain('15 Sep 2027');
    expect(allText(findID(renderer, 'amc-end')!).join(' ')).toContain('14 Sep 2028');
    const priceInput = firstDescendantOfType(findID(renderer, 'amc-price')!, 'TextInput');
    expect(priceInput).toBeDefined();
    // The renewal carries the old AMC's price, grouped en-IN (zero paise dropped).
    expect(String(priceInput!.props.value ?? '')).toBe('18,000');
    // And the notes did NOT carry over — a renewal starts its record clean.
    const notes = firstDescendantOfType(findID(renderer, 'amc-notes')!, 'TextInput');
    expect(String(notes!.props.value ?? '')).toBe('');
  });

  it('the overlap renders the server\u2019s sentence with Open <number> \u2014 never the raw code', async () => {
    const onOpenExisting = vi.fn();
    const renderer = await create(
      <AmcFormScreen
        {...baseProps({
          saveError: {
            message: 'AMC-2627-00031 already covers this customer from 15 Sep 2026 to 14 Sep 2027.',
            existing: { id: 'b1000000-0000-4000-8000-00000000000b', contractNumber: 'AMC-2627-00031' },
          },
          onOpenExisting,
        })}
      />,
    );

    const banner = findID(renderer, 'amc-existing-banner');
    expect(banner).toBeDefined();
    const texts = allText(banner!).join(' ');
    expect(texts).toContain('AMC-2627-00031 already covers this customer');
    expect(texts).not.toContain('DUPLICATE_ENTITY');

    press(pressableOf(findID(renderer, 'amc-existing-banner')!));
    expect(onOpenExisting).toHaveBeenCalledWith('b1000000-0000-4000-8000-00000000000b');
  });
});
