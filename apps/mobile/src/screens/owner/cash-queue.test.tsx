/**
 * O2 Cash reconciliation queue tests (T4.9, UI/plan-2/07-OWNER.md §O2) —
 * the seven the spec names:
 *
 * - **`missing_submission` rows sort first** across a mixed 30-day
 *   fixture — the row the feature exists to catch leads regardless of
 *   date, on both the phone cards and the desk table.
 * - **No expenses column exists** in either layout — technicians do not
 *   spend from collections, and nothing may offer a shortfall a story.
 * - **Confirm prefills the declared amount and allows editing it.**
 * - **Dispute blocks submit without a note.**
 * - **A confirmed row remains visible, marked resolved** — it stays so a
 *   confirmed day stays distinguishable from one that never existed.
 * - **Reopen is absent on `submitted` rows and present on `confirmed`
 *   ones** — deliberately a second action, never a shortcut.
 * - **Today's tab carries the still-syncing caption**, verbatim.
 *
 * The screen is pure over injected data; the desk layout is exercised
 * through the DensityProvider seam (the NavShell branch sets it once in
 * the app), exactly as the dashboard suite does.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { CashQueueRow } from '@servgrid/shared';
import { DensityProvider } from '../../components/ui';
import { allText, create, findAll, findByTestID, toJson, type Node } from '../../components/ui/testing';
import {
  OwnerCashQueueScreen,
  TODAY_CAPTION,
  queueRowKey,
  sortQueueRows,
  type CashQueueDeps,
} from './cash-queue';

// ── fixtures ─────────────────────────────────────────────────────────────

const TODAY = '2026-09-15';
const NAMES = ['Ravi Kumar', 'Suresh Babu', 'Anitha Menon', 'Deepa Nair', 'Farhan Ali'];

let seq = 0;
function row(overrides: Partial<CashQueueRow> = {}): CashQueueRow {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    declarationId: `a0000000-0000-4000-8000-${n}`,
    employeeId: `b0000000-0000-4000-8000-${n}`,
    employeeName: NAMES[seq % NAMES.length]!,
    role: 'technician',
    businessDate: '2026-09-10',
    expectedCash: '8400.00',
    declaredAmount: '8000.00',
    declaredAt: `${overrides.businessDate ?? '2026-09-10'}T13:40:00+05:30`,
    status: 'submitted',
    note: null,
    variance: '-400.00',
    flag: 'variance',
    ...overrides,
  };
}

/** A `missing_submission` day: no declaration row at all — the nulls
 * travel together (§O2: that is what makes it the only flag a LEFT JOIN
 * would drop). */
function missing(businessDate: string, employeeName: string, expectedCash: string): CashQueueRow {
  return row({
    declarationId: null,
    employeeName,
    businessDate,
    expectedCash,
    declaredAmount: null,
    declaredAt: null,
    status: null,
    variance: null,
    flag: 'missing_submission',
  });
}

function confirmedRow(overrides: Partial<CashQueueRow> = {}): CashQueueRow {
  return row({
    expectedCash: '6200.00',
    declaredAmount: '6200.00',
    variance: '0.00',
    status: 'confirmed',
    flag: 'match',
    ...overrides,
  });
}

/** 30 mixed days: flags cycle variance → match → no_expected_cash, with
 * the missing_submission days planted on the OLDEST dates — a sort that
 * only respected date would bury exactly the rows the screen exists for. */
function mixed30(): CashQueueRow[] {
  const start = Date.UTC(2026, 7, 17); // 30 days ending 2026-09-15
  const dayMs = 24 * 60 * 60 * 1000;
  const rows: CashQueueRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    const date = new Date(start + i * dayMs).toISOString().slice(0, 10);
    if (i < 6) {
      rows.push(missing(date, `Employee ${i}`, '12000.00'));
    } else {
      const flag = (['variance', 'match', 'no_expected_cash'] as const)[i % 3];
      rows.push(
        row({
          businessDate: date,
          employeeName: `Employee ${i}`,
          flag,
          status: flag === 'variance' ? 'submitted' : flag === 'match' ? 'confirmed' : 'submitted',
          expectedCash: flag === 'no_expected_cash' ? null : '8400.00',
          declaredAmount: flag === 'no_expected_cash' ? '500.00' : flag === 'match' ? '8400.00' : '8000.00',
          variance: flag === 'variance' ? '-400.00' : flag === 'match' ? '0.00' : null,
        }),
      );
    }
  }
  return rows;
}

function baseDeps(overrides: Partial<CashQueueDeps> = {}): CashQueueDeps {
  const rows = overrides.rows ?? mixed30();
  return {
    today: TODAY,
    rows,
    error: null,
    loading: false,
    offline: false,
    range: 'last14',
    flagFilter: 'all',
    onRange: vi.fn(),
    onFlagFilter: vi.fn(),
    onRetry: vi.fn(),
    actionBusy: false,
    actionError: null,
    onConfirm: vi.fn(async () => true),
    onDispute: vi.fn(async () => true),
    onReopen: vi.fn(async () => true),
    dayOpen: false,
    day: null,
    dayLoading: false,
    dayError: null,
    onViewDay: vi.fn(),
    onDismissDay: vi.fn(),
    ...overrides,
  };
}

function renderScreen(deps: CashQueueDeps, density: 'field' | 'desk' = 'field') {
  return create(
    <DensityProvider density={density}>
      <OwnerCashQueueScreen {...deps} />
    </DensityProvider>,
  );
}

// ── readers ──────────────────────────────────────────────────────────────

/** Every rendered row node, in render order. */
function rowsOf(renderer: ReactTestRenderer): Node[] {
  return findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('cash-row-'));
}

/** The flag a row currently carries, read off its pill. */
function flagOf(rowNode: Node): string {
  const pill = findAll(rowNode, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('cash-pill-'))[0];
  expect(pill).toBeDefined();
  return String(pill!.props.testID).replace('cash-pill-', '');
}

function findTextInput(root: Node | string | null | undefined): Node | undefined {
  return findAll(root ?? null, (n) => n.type === 'TextInput')[0];
}

function pressableOf(renderer: ReactTestRenderer, testID: string): Node {
  const hit = findAll(findByTestID(toJson(renderer), testID)!, (n) => n.type === 'Pressable')[0];
  expect(hit).toBeDefined();
  return hit!;
}

// ── the tests ────────────────────────────────────────────────────────────

describe('OwnerCashQueueScreen — sort order (§O2)', () => {
  it('missing_submission rows sort first across a mixed 30-day fixture, regardless of date', async () => {
    const renderer = await renderScreen(baseDeps());

    const rendered = rowsOf(renderer).map(flagOf);
    // Every missing_submission leads; every other flag follows — across
    // 30 mixed days, on the phone cards.
    const firstNonMissing = rendered.findIndex((f) => f !== 'missing_submission');
    expect(firstNonMissing).toBeGreaterThan(0);
    expect(rendered.slice(0, firstNonMissing).every((f) => f === 'missing_submission')).toBe(true);
    expect(rendered.slice(firstNonMissing).every((f) => f !== 'missing_submission')).toBe(true);
    // The fixture really had both worlds: 6 missing days, 24 others.
    expect(rendered.filter((f) => f === 'missing_submission')).toHaveLength(6);

    // …and the pure sort is the same promise for any caller.
    const sorted = sortQueueRows(mixed30());
    expect(sorted[0]!.flag).toBe('missing_submission');
    expect(sorted.slice(0, 6).every((r) => r.flag === 'missing_submission')).toBe(true);
    // Within the missing block: newest day first — still date-aware,
    // just never ahead of the flag.
    expect(sorted[0]!.businessDate >= sorted[1]!.businessDate).toBe(true);
  });

  it('the desk table keeps the same order — the flag column sorts by precedence, date second', async () => {
    const renderer = await renderScreen(baseDeps(), 'desk');

    const rendered = findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('data-row-'));
    expect(rendered.length).toBe(30);
    const flags = rendered.map((r) => {
      const pill = findAll(r, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('cash-pill-'))[0]!;
      return String(pill.props.testID).replace('cash-pill-', '');
    });
    const firstNonMissing = flags.findIndex((f) => f !== 'missing_submission');
    expect(flags.slice(0, firstNonMissing).every((f) => f === 'missing_submission')).toBe(true);
    expect(flags.slice(firstNonMissing).every((f) => f !== 'missing_submission')).toBe(true);
  });
});

describe('OwnerCashQueueScreen — no expenses column (§O2)', () => {
  it('no expenses column exists in either layout', async () => {
    for (const density of ['field', 'desk'] as const) {
      const renderer = await renderScreen(baseDeps(), density);
      const words = allText(toJson(renderer)).join(' ').toLowerCase();
      // The word itself may not appear — not as a column, not as a
      // caption, nowhere a shortfall could be explained away.
      expect(words).not.toContain('expense');
      if (density === 'desk') {
        // The sortable columns the spec fixes: employee, date, expected,
        // declared, variance, flag — and nothing to explain a shortfall.
        const headers = findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('header-sort-'));
        expect(headers).toHaveLength(6);
      }
    }
  });
});

describe('OwnerCashQueueScreen — confirm (§O2)', () => {
  it('Confirm prefills the declared amount and allows editing it', async () => {
    const onConfirm = vi.fn(async () => true);
    const varianceRow = row({ declaredAmount: '8000.00' });
    const renderer = await renderScreen(baseDeps({ rows: [varianceRow], onConfirm }));

    await act(async () => {
      pressableOf(renderer, `cash-confirm-${queueRowKey(varianceRow)}`).props.onPress?.();
    });
    expect(findByTestID(toJson(renderer), 'cash-confirm-sheet')).toBeDefined();

    // Prefilled with the DECLARED amount — what he said he handed over
    // (the field's blurred display is the en-IN grouped figure).
    const input = findTextInput(findByTestID(toJson(renderer), 'cash-confirm-amount'))!;
    expect(input.props.value).toBe('8,000');

    // …and editable: the owner confirms what was ACTUALLY handed over.
    await act(async () => {
      input.props.onChangeText?.('9500');
    });
    await act(async () => {
      pressableOf(renderer, 'cash-confirm-submit').props.onPress?.();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ employeeId: varianceRow.employeeId }), '9500');
    // Success closes the sheet — but the ROW stays on the screen.
    expect(findByTestID(toJson(renderer), `cash-row-${queueRowKey(varianceRow)}`)).toBeDefined();
  });

  it('a missing_submission day carries View the day only — confirm and dispute act on a declaration, and none exists yet', async () => {
    // The confirm/dispute endpoints act on `cash_reconciliations.id`
    // (§10); a missing_submission day HAS no declaration row — the
    // employee's declaration is the resolution path. The honest screen
    // offers the owner his eyes (View the day) and nothing that would
    // pretend the day was answerable.
    const undeclared = missing('2026-09-12', 'Ravi Kumar', '12000.00');
    const renderer = await renderScreen(baseDeps({ rows: [undeclared] }));

    expect(findByTestID(toJson(renderer), `cash-confirm-${queueRowKey(undeclared)}`)).toBeUndefined();
    expect(findByTestID(toJson(renderer), `cash-dispute-${queueRowKey(undeclared)}`)).toBeUndefined();
    expect(findByTestID(toJson(renderer), `cash-day-${queueRowKey(undeclared)}`)).toBeDefined();
  });
});

describe('OwnerCashQueueScreen — dispute (§O2)', () => {
  it('Dispute blocks submit without a note', async () => {
    const onDispute = vi.fn(async () => true);
    const varianceRow = row({});
    const renderer = await renderScreen(baseDeps({ rows: [varianceRow], onDispute }));

    await act(async () => {
      pressableOf(renderer, `cash-dispute-${queueRowKey(varianceRow)}`).props.onPress?.();
    });
    expect(findByTestID(toJson(renderer), 'cash-dispute-sheet')).toBeDefined();

    // Empty note: the submit is disabled, with the why — asserted, not
    // pressed (a disabled control that answers a press would be a lie).
    const submit = pressableOf(renderer, 'cash-dispute-submit');
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    expect(onDispute).not.toHaveBeenCalled();

    // A note unlocks it, and the note travels trimmed.
    const note = findTextInput(findByTestID(toJson(renderer), 'cash-dispute-note'))!;
    await act(async () => {
      note.props.onChangeText?.('  Bag was short — the ₹400 is unaccounted for.  ');
    });
    await act(async () => {
      pressableOf(renderer, 'cash-dispute-submit').props.onPress?.();
    });
    expect(onDispute).toHaveBeenCalledTimes(1);
    expect(onDispute).toHaveBeenCalledWith(expect.objectContaining({ employeeId: varianceRow.employeeId }), 'Bag was short — the ₹400 is unaccounted for.');
  });
});

describe('OwnerCashQueueScreen — a confirmed row stays (§O2 motion)', () => {
  it('a confirmed row remains visible, marked resolved', async () => {
    const varianceRow = row({ employeeName: 'Suresh Babu' });
    const before = baseDeps({ rows: [varianceRow, confirmedRow({})] });
    const renderer = await renderScreen(before);

    // Confirm it for real through the sheet.
    await act(async () => {
      pressableOf(renderer, `cash-confirm-${queueRowKey(varianceRow)}`).props.onPress?.();
    });
    await act(async () => {
      const input = findTextInput(findByTestID(toJson(renderer), 'cash-confirm-amount'))!;
      input.props.onChangeText?.('8000.00');
    });
    await act(async () => {
      pressableOf(renderer, 'cash-confirm-submit').props.onPress?.();
    });

    // The hook replaces the row with the refreshed one — same
    // declaration id, same key, resolved. The row does not disappear.
    const resolved: CashQueueRow = { ...varianceRow, status: 'confirmed', flag: 'match', variance: '0.00' };
    const after = baseDeps({
      rows: [resolved, confirmedRow({})],
      onConfirm: before.onConfirm,
    });
    await act(async () => {
      renderer.update(
        <DensityProvider density="field">
          <OwnerCashQueueScreen {...after} />
        </DensityProvider>,
      );
    });

    const node = findByTestID(toJson(renderer), `cash-row-${queueRowKey(resolved)}`);
    expect(node).toBeDefined(); // STILL here — resolved, not filtered out
    expect(flagOf(node!)).toBe('match'); // the pill cross-faded to match
    expect(findByTestID(toJson(renderer), `cash-reopen-${queueRowKey(resolved)}`)).toBeDefined();
  });
});

describe('OwnerCashQueueScreen — reopen is a second action (§O2)', () => {
  it('Reopen is absent on submitted rows and present on confirmed ones', async () => {
    const open = row({});
    const settled = confirmedRow({});
    const renderer = await renderScreen(baseDeps({ rows: [open, settled] }));

    expect(findByTestID(toJson(renderer), `cash-reopen-${queueRowKey(open)}`)).toBeUndefined();
    expect(findByTestID(toJson(renderer), `cash-reopen-${queueRowKey(settled)}`)).toBeDefined();

    // Disputed rows are answered too — reopen belongs to CONFIRMED days.
    const disputed = row({ status: 'disputed', flag: 'variance' });
    const r2 = await renderScreen(baseDeps({ rows: [disputed] }));
    expect(findByTestID(toJson(r2), `cash-reopen-${queueRowKey(disputed)}`)).toBeUndefined();
  });

  it('Reopen requires a reason', async () => {
    const onReopen = vi.fn(async () => true);
    const settled = confirmedRow({});
    const renderer = await renderScreen(baseDeps({ rows: [settled], onReopen }));

    await act(async () => {
      pressableOf(renderer, `cash-reopen-${queueRowKey(settled)}`).props.onPress?.();
    });
    const submit = pressableOf(renderer, 'cash-reopen-submit');
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });

    const reason = findTextInput(findByTestID(toJson(renderer), 'cash-reopen-reason'))!;
    await act(async () => {
      reason.props.onChangeText?.('technician counted the bag again');
    });
    await act(async () => {
      pressableOf(renderer, 'cash-reopen-submit').props.onPress?.();
    });
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ declarationId: settled.declarationId }), 'technician counted the bag again');
  });
});

describe('OwnerCashQueueScreen — today never lies (§O2)', () => {
  it("Today's tab carries the still-syncing caption", async () => {
    // Today chosen: the caption is on the screen, verbatim.
    const renderer = await renderScreen(baseDeps({ range: 'today', rows: mixed30().slice(0, 5) }));
    const caption = findByTestID(toJson(renderer), 'cash-today-caption');
    expect(caption).toBeDefined();
    expect(allText(caption ?? null).join('')).toBe(TODAY_CAPTION);

    // A row DATED today carries it too, whatever range is active.
    const todayRow = row({ businessDate: TODAY, declaredAt: `${TODAY}T10:00:00+05:30` });
    const r2 = await renderScreen(baseDeps({ rows: [todayRow], range: 'last14' }));
    expect(findByTestID(toJson(r2), 'cash-today-caption')).toBeDefined();

    // …and a settled yesterday-only range does not warn about today.
    const r3 = await renderScreen(baseDeps({ rows: [row({ businessDate: '2026-09-14' })], range: 'last14' }));
    expect(findByTestID(toJson(r3), 'cash-today-caption')).toBeUndefined();
  });
});
