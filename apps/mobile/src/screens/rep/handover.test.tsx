/**
 * S6 Cash handover — the rep's lens on the technician's §T6 screen
 * (UI/plan-2/06-SALES-REP.md §S6: "identical to 04-TECHNICIAN.md §T6 with
 * a different heading"). The rep shares the same `CashScreen` — the
 * two absences and the amendment rule are asserted HERE against the rep's
 * usage so a later role-specialisation of the shared screen cannot
 * silently break the rep:
 *
 * - **No expected figure, no expenses field** — he declares; the
 *   system's expectation is the check.
 * - **Amend while `submitted`** — a typo'd figure has a route until the
 *   office signs the day off.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CashHandover } from '@servgrid/shared';
import { allText, create, findByTestID, toJson } from '../../components/ui/testing';
import { CashScreen } from '../cash/CashScreen';

const TODAY = '2026-09-11';

function declaration(overrides: Partial<CashHandover>): CashHandover {
  return {
    id: '0b6f1c2e-0000-4000-8000-000000000001',
    businessDate: TODAY,
    declaredAmount: '4500',
    note: null,
    status: 'submitted',
    declaredAt: `${TODAY}T13:30:00.000Z`,
    confirmedAmount: null,
    ownerNote: null,
    confirmedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('RepHandover — §S6 via the shared §T6 screen', () => {
  it('the rep heading renders, with no expected figure and no expenses field', async () => {
    const deps = {
      today: TODAY,
      loadHistory: vi.fn(async () => [declaration({})]),
      declare: vi.fn(async () => declaration({})),
      amend: vi.fn(async () => declaration({})),
    };
    const r = await create(<CashScreen {...deps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'handover-title')).toBeDefined();
    expect(allText(tree)).toContain('Cash handover');
    // The two deliberate absences, held against the whole rendered tree.
    const lower = allText(tree).join(' | ').toLowerCase();
    expect(lower).not.toContain('expected');
    expect(lower).not.toContain('expense');
  });

  it('amend is available while submitted — the rep path keeps the correction route', async () => {
    const deps = {
      today: TODAY,
      loadHistory: vi.fn(async () => [declaration({ status: 'submitted', declaredAmount: '4500' })]),
      declare: vi.fn(async () => declaration({})),
      amend: vi.fn(async () => declaration({})),
    };
    const r = await create(<CashScreen {...deps} />);
    expect(findByTestID(toJson(r), 'handover-amend')).toBeDefined();
    expect(findByTestID(toJson(r), 'handover-submit')).toBeUndefined();
    expect(allText(toJson(r))).toContain('₹ 4,500');

    const locked = {
      today: TODAY,
      loadHistory: vi.fn(async () => [declaration({ status: 'confirmed' as const })]),
      declare: vi.fn(async () => declaration({})),
      amend: vi.fn(async () => declaration({})),
    };
    const lockedRenderer = await create(<CashScreen {...locked} />);
    expect(findByTestID(toJson(lockedRenderer), 'handover-amend')).toBeUndefined();
    expect(findByTestID(toJson(lockedRenderer), 'handover-locked-copy')).toBeDefined();
  });
});
