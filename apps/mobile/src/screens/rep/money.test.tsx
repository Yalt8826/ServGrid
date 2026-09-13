/**
 * T3.7 money display tests (UI/plan-2/06-SALES-REP.md §S1, §S4;
 * 01-FOUNDATIONS.md §6). The rules live in `money.tsx` so no screen can
 * re-derive them differently:
 *
 * - **Figures cross-fade, never count up** — 140ms, opacity only, no
 *   numeric tween, no scale on money.
 * - **A negative balance renders `Credit` in success colour, with no
 *   minus sign.**
 * - **Ledger amounts keep their signed display** — documents show
 *   direction, only balances use the Credit rule.
 * - Wire-format money sums exactly, in integer paise.
 */
import { describe, expect, it } from 'vitest';

import { SEMANTIC } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import {
  creditView,
  CROSSFADE_MS,
  isNegativeMoney,
  isPositiveMoney,
  ledgerAmountOf,
  MoneyFigure,
  sumMoney,
} from './money';

describe('money rules (§S1, §S4)', () => {
  it('sums wire money in integer paise — no float cents', () => {
    expect(sumMoney(['85000.00', '42500', '31000.25'])).toBe('158500.25');
    expect(sumMoney([])).toBe('0');
    expect(sumMoney(['0.05', '0.05', '0.05'])).toBe('0.15');
    expect(sumMoney(['-40'])).toBe('-40');
  });

  it('a negative balance renders Credit in success colour, with no minus sign', () => {
    const view = creditView('-1250.00');
    expect(view.credit).toBe(true);
    expect(view.color).toBe(SEMANTIC.feedback.success);
    expect(view.text).toBe('Credit ₹1,250');
    expect(view.text).not.toContain('-');
    expect(view.text).not.toContain('−');

    // Positive and zero stay plain figures in the text colour.
    expect(creditView('85000').text).toBe('₹85,000');
    expect(creditView('85000').credit).toBe(false);
    expect(creditView('0').text).toBe('₹0');
  });

  it('ledger amounts keep their signs — sale positive, payment negative', () => {
    expect(ledgerAmountOf('sale', '16800')).toBe('+ ₹16,800');
    expect(ledgerAmountOf('payment', '40000')).toBe('− ₹40,000');
    expect(isPositiveMoney('0.01')).toBe(true);
    expect(isNegativeMoney('-0.01')).toBe(true);
  });

  it('the cross-fade is 140ms and the figure never carries a scale', async () => {
    expect(CROSSFADE_MS).toBe(140);

    const r = await create(<MoneyFigure value="₹4,20,000" testID="figure" />);
    let tree = toJson(r);
    expect(findByTestID(tree, 'figure-text')).toBeDefined();
    expect(allText(tree)).toContain('₹4,20,000');

    // A change lands on the whole new value — the reanimated stub settles,
    // which is exactly the seam: there is no intermediate number to find
    // because there is no numeric tween at all, only opacity.
    await create(<MoneyFigure value="₹1,85,000" testID="figure" />);
    const changed = await create(<MoneyFigure value="₹1,85,000" testID="figure" />);
    tree = toJson(changed);
    expect(allText(tree)).toContain('₹1,85,000');

    // Opacity is the only animated property on the figure: no scale, no
    // translate — money does not move, and it certainly does not pulse.
    const figure = findByTestID(tree, 'figure')!;
    const stylesIn = findAll(figure, (n) => Array.isArray(n.props.style) || typeof n.props.style === 'object');
    for (const node of stylesIn) {
      const flat = JSON.stringify(node.props.style ?? {});
      expect(flat).not.toContain('scale');
      expect(flat).not.toContain('translate');
    }
  });

  it('the stale figure carries the dashed inset and the Pending sync caption', async () => {
    const stale = await create(<MoneyFigure value="₹85,000" stale testID="figure" />);
    expect(findByTestID(toJson(stale), 'figure-stale')).toBeDefined();
    expect(findByTestID(toJson(stale), 'figure-pending')).toBeDefined();
    expect(allText(toJson(stale))).toContain('Pending sync');

    const fresh = await create(<MoneyFigure value="₹85,000" testID="figure" />);
    expect(findByTestID(toJson(fresh), 'figure-stale')).toBeUndefined();
    expect(findByTestID(toJson(fresh), 'figure-pending')).toBeUndefined();
  });
});
