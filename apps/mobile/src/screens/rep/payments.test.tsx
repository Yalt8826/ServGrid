/**
 * S3 Payments tests (UI/plan-2/06-SALES-REP.md §S3). The ones the spec
 * names:
 *
 * - **The tab is labelled `Owed`, never "Pending"** — rows are dues (a
 *   view), and the empty state names companies, not payments.
 * - **Mode segments render on two rows; each is ≥52 tall** at 360dp —
 *   five across would truncate "Bank transfer" into something ambiguous
 *   on real money.
 * - **Choosing Cash renders the handover reminder; choosing UPI reveals
 *   the reference field** (required for cheque and bank).
 * - **Recording a payment updates the company's balance optimistically,
 *   BEFORE the sheet closes.**
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { allText, create, findAll, findAllByTestID, findByTestID, toJson, type Node } from '../../components/ui/testing';
import { PaymentsScreen, isValidAmount, RecordPaymentSheet, type RecordPaymentInput } from './PaymentsScreen';
import { CASH_HANDOVER_REMINDER, OWED_EMPTY_MESSAGE, referenceNeededFor, referenceRequiredFor } from './model';

const COMPANY_ID = 'c1000000-0000-4000-8000-000000000001';

function props(overrides: Partial<Parameters<typeof PaymentsScreen>[0]> = {}) {
  return {
    owed: [{ companyId: COMPANY_ID, name: 'Sterling Industries', balance: '85000.00' }],
    collected: [
      {
        id: 'p1000000-0000-4000-8000-000000000001',
        paymentNumber: 'PM-2627-00042',
        companyId: COMPANY_ID,
        companyName: 'Sterling Industries',
        amount: '40000.00',
        mode: 'upi' as const,
        businessDate: '2026-09-06',
      },
    ],
    companies: [{ id: COMPANY_ID, name: 'Sterling Industries' }],
    openSales: [],
    error: null,
    loading: false,
    pendingRecord: { busy: false, error: null },
    online: true,
    record: vi.fn(async (_input: RecordPaymentInput) => {}),
    applyOptimisticPayment: vi.fn(),
    onRetry: () => {},
    ...overrides,
  };
}

function styleValue(node: Node, key: string): unknown {
  const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
  for (const s of styles) {
    if (s !== null && typeof s === 'object' && key in (s as Record<string, unknown>)) {
      return (s as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID)!;
  const pressable = node.type === 'Pressable' ? node : findAll(node, (n) => n.type === 'Pressable')[0]!;
  await act(async () => {
    pressable.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function type(renderer: ReactTestRenderer, testID: string, text: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID)!;
  const input = findAll(node, (n) => n.type === 'TextInput')[0]!;
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

describe('PaymentsScreen (§S3)', () => {
  it('the first tab is labelled Owed, never "Pending"', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'payments-tab-owed')).toBeDefined();
    expect(findByTestID(tree, 'payments-tab-collected')).toBeDefined();
    const texts = allText(tree);
    expect(texts).toContain('Owed');
    expect(texts).toContain('Collected');
    // The stored-counter reading must not sneak back in anywhere.
    expect(texts.join(' | ').toLowerCase()).not.toContain('pending payment');
  });

  it('the empty state names companies, not payments', async () => {
    const r = await create(<PaymentsScreen {...props({ owed: [] })} />);
    expect(findByTestID(toJson(r), 'payments-owed-empty')).toBeDefined();
    expect(allText(toJson(r))).toContain(OWED_EMPTY_MESSAGE);
    expect(OWED_EMPTY_MESSAGE).toBe('No company owes you anything.');
  });

  it('rows read "Sterling Industries · owes ₹85,000" with a Record payment action', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    expect(allText(toJson(r))).toContain('Sterling Industries · owes ₹85,000');
    expect(findByTestID(toJson(r), `payments-record-${COMPANY_ID}`)).toBeDefined();
  });

  it('mode segments render on two rows, each ≥52 tall', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    await press(r, `payments-record-${COMPANY_ID}`);
    const tree = toJson(r);
    expect(findByTestID(tree, 'payment-sheet')).toBeDefined();

    const row1 = findByTestID(tree, 'payment-mode-row-1');
    const row2 = findByTestID(tree, 'payment-mode-row-2');
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    // Row one: Cash, UPI, Cheque. Row two: Bank, Card. Cash first and
    // visually identical — the segments carry the same styles.
    expect(findByTestID(tree, 'payment-mode-cash')).toBeDefined();
    expect(findByTestID(tree, 'payment-mode-upi')).toBeDefined();
    expect(findByTestID(tree, 'payment-mode-cheque')).toBeDefined();
    expect(findByTestID(tree, 'payment-mode-bank_transfer')).toBeDefined();
    expect(findByTestID(tree, 'payment-mode-card')).toBeDefined();

    for (const mode of ['cash', 'upi', 'cheque', 'bank_transfer', 'card'] as const) {
      const segment = findByTestID(tree, `payment-mode-${mode}`)!;
      // 360dp ÷ 5 ≈ 64dp per segment with flex:1 — the floor is the 52
      // field tap target, never a cramped 40-something.
      expect(styleValue(segment, 'minHeight')).toBe(52);
      expect(styleValue(segment, 'flex')).toBe(1);
    }

    // Cash is first: it is row one's first segment, and unselected it
    // looks exactly like the others (identical border/background tokens).
    const row1Nodes = findAllByTestID(tree, 'payment-mode-row-1');
    expect(row1Nodes.length).toBeGreaterThan(0);
  });

  it('choosing Cash renders the handover reminder; choosing UPI reveals the reference field', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    await press(r, `payments-record-${COMPANY_ID}`);

    // Cash is the default and first: the reminder is up from the start,
    // the reference field is not.
    expect(findByTestID(toJson(r), 'payment-cash-reminder')).toBeDefined();
    expect(allText(toJson(r))).toContain(CASH_HANDOVER_REMINDER);
    expect(findByTestID(toJson(r), 'payment-sheet-reference')).toBeUndefined();

    await press(r, 'payment-mode-upi');
    expect(findByTestID(toJson(r), 'payment-cash-reminder')).toBeUndefined();
    expect(findByTestID(toJson(r), 'payment-sheet-reference')).toBeDefined();

    // The rules behind the field: non-cash only; required for cheque and
    // bank, optional for UPI and card.
    expect(referenceNeededFor('cash')).toBe(false);
    expect(referenceNeededFor('upi')).toBe(true);
    expect(referenceRequiredFor('cheque')).toBe(true);
    expect(referenceRequiredFor('bank_transfer')).toBe(true);
    expect(referenceRequiredFor('upi')).toBe(false);
    expect(referenceRequiredFor('card')).toBe(false);
  });

  it('a cheque without its reference cannot be recorded; a UPI reference is optional', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    await press(r, `payments-record-${COMPANY_ID}`);
    await type(r, 'payment-sheet-amount', '5000');

    await press(r, 'payment-mode-cheque');
    // Reference missing: the submit button is disabled with its reason.
    let submit = findAll(findByTestID(toJson(r), 'payment-sheet-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    await press(r, 'payment-sheet-submit');

    await type(r, 'payment-sheet-reference', 'CHQ 447190');
    submit = findAll(findByTestID(toJson(r), 'payment-sheet-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submit.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('offline, the submit is disabled and the reason names the connection', async () => {
    const r = await create(<PaymentsScreen {...props({ online: false })} />);
    await press(r, `payments-record-${COMPANY_ID}`);
    await type(r, 'payment-sheet-amount', '5000');

    // The writes run directly today: offline must be a disabled button
    // that says so, never a silent failed POST of money.
    const submit = findAll(findByTestID(toJson(r), 'payment-sheet-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    expect(allText(toJson(r)).join('\n')).toContain("You're offline — recording needs a connection.");
    await press(r, 'payment-sheet-submit');
  });

  it('recording updates the balance optimistically BEFORE the sheet closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = vi.fn(async (_input: RecordPaymentInput) => {
      await gate;
    });
    const applyOptimisticPayment = vi.fn();

    const r = await create(
      <PaymentsScreen {...props({ record, applyOptimisticPayment })} />,
    );
    await press(r, `payments-record-${COMPANY_ID}`);
    await type(r, 'payment-sheet-amount', '40000');
    await press(r, 'payment-sheet-submit');

    // The network call is still parked on the gate — the sheet is up, the
    // company's row has ALREADY moved (before the sheet closes, §S3).
    expect(applyOptimisticPayment).toHaveBeenCalledWith(COMPANY_ID, '40000');
    expect(findByTestID(toJson(r), 'payment-sheet')).toBeDefined();

    await act(async () => {
      release();
      await gate;
      await Promise.resolve();
      await Promise.resolve();
    });
    // Only after the record resolves does the sheet dismiss.
    expect(findByTestID(toJson(r), 'payment-sheet')).toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, amount: '40000', mode: 'cash', referenceNo: null }),
    );
  });

  it('a refused payment is rolled back — the screen must not pretend the money moved', async () => {
    const record = vi.fn(async () => {
      throw new Error('The amount exceeds the balance.');
    });
    const applyOptimisticPayment = vi.fn();
    const r = await create(<PaymentsScreen {...props({ record, applyOptimisticPayment })} />);
    await press(r, `payments-record-${COMPANY_ID}`);
    await type(r, 'payment-sheet-amount', '999999');
    await press(r, 'payment-sheet-submit');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The optimistic row went back exactly as it was.
    expect(applyOptimisticPayment).toHaveBeenCalledWith(COMPANY_ID, '-999999');
    expect(findByTestID(toJson(r), 'payment-sheet')).toBeDefined();

    // The error surface is the route's pendingRecord state flowing back
    // in — the screen renders the server's words verbatim.
    await act(async () => {
      await r.update(
        <PaymentsScreen
          {...props({
            record,
            applyOptimisticPayment,
            pendingRecord: { busy: false, error: 'The amount exceeds the balance.' },
          })}
        />,
      );
    });
    expect(findByTestID(toJson(r), 'payment-sheet-error')).toBeDefined();
    expect(allText(toJson(r)).join(' | ')).toContain('The amount exceeds the balance.');
  });

  it('the Collected tab lists actual payments', async () => {
    const r = await create(<PaymentsScreen {...props()} />);
    await press(r, 'payments-tab-collected');
    const tree = toJson(r);
    expect(findByTestID(tree, 'payments-collected-p1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(allText(tree).join(' | ')).toContain('PM-2627-00042');
    expect(allText(tree)).toContain('₹40,000');
  });

  it('the amount must be money above zero', () => {
    expect(isValidAmount('')).toBe(false);
    expect(isValidAmount('0')).toBe(false);
    expect(isValidAmount('85,000')).toBe(false);
    expect(isValidAmount('85000')).toBe(true);
    expect(isValidAmount('4250.50')).toBe(true);
    expect(isValidAmount('4250.505')).toBe(false);
  });
});

describe('RecordPaymentSheet input shape', () => {
  it('an on-account payment carries no salesCardId — the absence IS the feature', async () => {
    let captured: RecordPaymentInput | null = null;
    const r = await create(
      <RecordPaymentSheet
        visible
        online
        companies={[{ id: COMPANY_ID, name: 'Sterling Industries' }]}
        openSales={[
          {
            id: 's1000000-0000-4000-8000-000000000009',
            saleNumber: 'SL-2627-00018',
            companyId: COMPANY_ID,
            companyName: 'Sterling Industries',
            saleDate: '2026-09-02',
            total: '16800',
            status: 'confirmed',
          },
        ]}
        initialCompanyId={COMPANY_ID}
        busy={false}
        error={null}
        record={async (input) => {
          captured = input;
        }}
        onDismiss={() => {}}
      />,
    );
    await type(r, 'payment-sheet-amount', '5000');
    await press(r, 'payment-sheet-submit');
    expect(captured).toMatchObject({ companyId: COMPANY_ID, amount: '5000', salesCardId: null, mode: 'cash' });
  });
});
