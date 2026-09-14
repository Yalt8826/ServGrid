/**
 * O4 Jobs tests (T4.11, UI/plan-2/07-OWNER.md §O4, docs/implementation/
 * PHASE-4-OWNER.md T4.11). The ones the spec names:
 *
 * - **The desktop table carries an amount column; the SAME component
 *   for a dispatcher renders NONE** — from the response schema, not
 *   from a flag: the owner rows are `JobCardOwner`, the dispatcher rows
 *   `JobCardDispatcher`, and the component derives the column from the
 *   cards' shape.
 * - **The amend form shows current, new and the difference.**
 * - **Amend on a confirmed day renders the reopen offer with the
 *   reconciliation named** — two deliberate steps, never auto-amend.
 * - **Card-vs-row verified at all four widths** — 390 · 800 · 1024 ·
 *   1440: below the rail's breakpoint the owner gets cards, at and
 *   above it the table. The width rule itself is NavShell's; the tests
 *   bind to it through `densityForRole` and a source read of
 *   `DESK_MIN_WIDTH`.
 *
 * The seam is the house one: react-test-renderer against the string
 * host stubs, the real component logic, deps injected.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { act } from 'react';

import type { JobCardDispatcher, JobCardOwner } from '@servgrid/shared';
import { DensityProvider } from '../../components/ui/DensityProvider';
import { densityForRole } from '../../navigation/navmap';
import { allText, create, findAll, findByTestID, firstDescendantOfType, toJson } from '../../components/ui/testing';
import { OwnerJobsScreen, type OwnerJobsDeps } from './JobsScreen';
import { AmendSheet, type AmendRefusal } from './AmendSheet';
import { carriesAmount, diffMoney, type JobRow } from './jobsModel';

const HERE = fileURLToPath(new URL('./', import.meta.url).href as unknown as string);

const OWNER_CARD: JobCardOwner = {
  id: 'b1000000-0000-4000-8000-00000000000a',
  jobNumber: 'JC-2627-0042',
  title: 'Battery swap',
  status: 'completed',
  priority: 'normal',
  scheduledFor: '2026-09-14T14:30:00+05:30',
  customerId: 'c1000000-0000-4000-8000-000000000001',
  customerName: 'Meenakshi Enterprises',
  assignedTo: 'e1000000-0000-4000-8000-000000000002',
  isOverdue: false,
  isContractVisit: false,
  version: 3,
  cost: '5000.00',
  discountAmount: '0',
  discountReason: null,
  amountCollected: '5000.00',
  collectionMode: 'cash',
};

/** The same job as the dispatcher's response schema answers it — no money field exists on it at all. */
const DISPATCHER_CARD: JobCardDispatcher = {
  id: OWNER_CARD.id,
  jobNumber: OWNER_CARD.jobNumber,
  title: OWNER_CARD.title,
  status: OWNER_CARD.status,
  priority: OWNER_CARD.priority,
  scheduledFor: OWNER_CARD.scheduledFor,
  customerId: OWNER_CARD.customerId,
  customerName: OWNER_CARD.customerName,
  assignedTo: OWNER_CARD.assignedTo,
  isOverdue: false,
  isContractVisit: false,
  version: 3,
};

function rowOf(card: JobCardOwner | JobCardDispatcher, technicianName: string | null): JobRow {
  return { card, technicianName };
}

function baseDeps(rows: JobRow[]): OwnerJobsDeps {
  return {
    detail: null,
    detailLoading: false,
    detailError: null,
    amendFlagOn: true,
    amendBusy: false,
    amendError: null,
    reopenBusy: false,
    onAmend: () => {},
    onReopen: () => {},
    onRetry: () => {},
    offline: false,
    loading: false,
    error: null,
    rows,
    technicians: [],
    filters: { date: 'all', tech: { kind: 'anyone' }, status: 'any' },
    query: '',
    onFiltersChange: () => {},
    onQueryChange: () => {},
    onOpenJob: () => {},
    onRetryList: () => {},
    onLoadMore: () => {},
    selectedJobId: null,
    onSelectJob: () => {},
  };
}

async function mount(element: React.ReactElement): Promise<Awaited<ReturnType<typeof create>>> {
  return create(<DensityProvider density="desk">{element}</DensityProvider>);
}

// ── the amount column, from the schema ──────────────────────────────────────

describe('OwnerJobsScreen — the amount column is the owner schema alone (§O4)', () => {
  it('the desk table carries the amount column for JobCardOwner rows', async () => {
    const r = await mount(<OwnerJobsScreen {...baseDeps([rowOf(OWNER_CARD, 'Ravi Kumar')])} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-jobs-table')).toBeDefined();
    // The column exists: sortable header and a rendered cell.
    expect(findByTestID(tree, 'header-sort-amount')).toBeDefined();
    expect(findByTestID(tree, `job-amount-${OWNER_CARD.id}`)).toBeDefined();
    expect(allText(findByTestID(tree, `job-amount-${OWNER_CARD.id}`)!)).toEqual(['₹5,000']);
    // §O4's column list, in order: number · customer · service · technician · scheduled · status · amount.
    const headers = findAll(findByTestID(tree, 'table-header')!, (n) => n.type === 'Text').map((n) => allText(n).join(''));
    // The §O4 columns are all there, amount LAST, and nothing else.
    const words = headers.map((h) => h.replace(/[↑↓]/g, '').trim()).filter((h) => h !== '');
    expect(words).toEqual(['Number', 'Customer', 'Service', 'Technician', 'Scheduled', 'Status', 'Amount']);
  });

  it('the SAME component for a dispatcher renders none — the schema has nothing to put there', async () => {
    expect(carriesAmount([rowOf(DISPATCHER_CARD, null)])).toBe(false);
    const r = await mount(<OwnerJobsScreen {...baseDeps([rowOf(DISPATCHER_CARD, 'Ravi Kumar')])} />);
    const tree = toJson(r);
    // The table renders; the amount column does not exist at any level.
    expect(findByTestID(tree, 'owner-jobs-table')).toBeDefined();
    expect(findByTestID(tree, 'header-sort-amount')).toBeUndefined();
    expect(findByTestID(tree, `job-amount-${DISPATCHER_CARD.id}`)).toBeUndefined();
    const headers = findAll(findByTestID(tree, 'table-header')!, (n) => n.type === 'Text').map((n) => allText(n).join(''));
    const words = headers.map((h) => h.replace(/[↑↓]/g, '').trim()).filter((h) => h !== '');
    expect(words).toEqual(['Number', 'Customer', 'Service', 'Technician', 'Scheduled', 'Status']);
  });

  it('a row click opens the side detail (the desk frame of the detail)', async () => {
    let selected: string | null = null;
    const deps = baseDeps([rowOf(OWNER_CARD, 'Ravi Kumar')]);
    deps.onSelectJob = (id) => {
      selected = id;
    };
    const r = await mount(<OwnerJobsScreen {...deps} />);
    const tree = toJson(r);
    await act(async () => {
      findByTestID(tree, `data-row-${OWNER_CARD.id}`)!.props.onPress?.();
    });
    expect(selected).toBe(OWNER_CARD.id);
  });
});

// ── the amend form ──────────────────────────────────────────────────────────

function amendSheetDeps() {
  const captured: { amend: Array<{ cost: string; discountAmount: string; discountReason: string; reason: string }>; reopen: string[] } = {
    amend: [],
    reopen: [],
  };
  const deps = {
    visible: true,
    jobNumber: 'JC-2627-0042',
    current: { cost: '5000.00', discountAmount: '0', discountReason: null },
    busy: false,
    error: null as AmendRefusal | null,
    reopenBusy: false,
    onAmend: (input: { cost: string; discountAmount: string; discountReason: string; reason: string }) => {
      captured.amend.push(input);
    },
    onReopen: (reason: string) => {
      captured.reopen.push(reason);
    },
    onDismiss: () => {},
  };
  return { deps, captured };
}

/** Types into the field under a testID (its input is the first TextInput). */
async function typeInto(tree: ReturnType<typeof toJson>, testID: string, text: string): Promise<void> {
  const field = findByTestID(tree, testID)!;
  const input = firstDescendantOfType(field, 'TextInput')!;
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

describe('AmendSheet — current, new and the difference (§O4)', () => {
  it('shows the stored figures, the new ones and the size of the correction', async () => {
    const { deps } = amendSheetDeps();
    const r = await create(<AmendSheet {...deps} />);
    let tree = toJson(r);
    // Current column, straight from the stored completion.
    expect(allText(findByTestID(tree, 'amend-current-cost')!)).toEqual(['₹5,000']);
    expect(allText(findByTestID(tree, 'amend-current-discountAmount')!)).toEqual(['₹0']);
    // New column starts at the stored values (patch semantics — absent keeps standing).
    expect(allText(findByTestID(tree, 'amend-new-cost')!)).toEqual(['₹5,000']);
    expect(allText(findByTestID(tree, 'amend-diff-cost')!)).toEqual(['—']);

    // The owner corrects 5000 → 500. The difference is the point.
    await typeInto(tree, 'amend-cost', '500');
    tree = toJson(r);
    expect(allText(findByTestID(tree, 'amend-new-cost')!)).toEqual(['₹500']);
    expect(allText(findByTestID(tree, 'amend-diff-cost')!)).toEqual(['− ₹4,500']);
  });

  it('submits only with a reason, carrying the correction and the why', async () => {
    const { deps, captured } = amendSheetDeps();
    const r = await create(<AmendSheet {...deps} />);
    const tree = toJson(r);
    // Reason required: the confirm is dead until the reason says something.
    const confirm = findAll(findByTestID(tree, 'amend-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });

    await typeInto(tree, 'amend-cost', '500');
    await typeInto(tree, 'amend-reason', 'typed 5000 for 500 — digit slip');
    const tree2 = toJson(r);
    const ready = findAll(findByTestID(tree2, 'amend-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(ready.props.accessibilityState).toMatchObject({ disabled: false });
    await act(async () => {
      ready.props.onPress?.();
    });
    expect(captured.amend).toEqual([
      { cost: '500', discountAmount: '0', discountReason: '', reason: 'typed 5000 for 500 — digit slip' },
    ]);
  });

  it('the money difference is exact paise arithmetic', () => {
    expect(diffMoney('500', '5000.00')).toBe('− ₹4,500');
    expect(diffMoney('1200', '1000')).toBe('+ ₹200');
    expect(diffMoney('500', '500')).toBe('—');
  });
});

describe('AmendSheet — a confirmed day refuses into the reopen offer (§O4, §6.2b)', () => {
  const REFUSAL: AmendRefusal = {
    message: 'This day is signed off in a confirmed cash reconciliation — reopen that day first, then amend.',
    reconciliation: { id: 'r1000000-0000-4000-8000-000000000001', businessDate: '2026-09-05', status: 'confirmed' },
  };

  it('the refusal renders the reopen offer with the reconciliation NAMED', async () => {
    const { deps, captured } = amendSheetDeps();
    deps.error = REFUSAL;
    const r = await create(<AmendSheet {...deps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'amend-reopen-offer')).toBeDefined();
    const named = allText(findByTestID(tree, 'amend-reopen-reconciliation')!).join(' ');
    expect(named).toContain('2026-09-05');
    expect(named).toContain('confirmed');
    expect(allText(findByTestID(tree, 'amend-reopen-message')!).join(' ')).toContain('signed off');
    // The plain amend confirm is gone while the day is signed off.
    expect(findByTestID(tree, 'amend-confirm')).toBeUndefined();
    expect(captured.amend).toEqual([]);
  });

  it('reopen needs its own reason, and reopening does not amend — two deliberate steps', async () => {
    const { deps, captured } = amendSheetDeps();
    deps.error = REFUSAL;
    const r = await create(<AmendSheet {...deps} />);
    const tree = toJson(r);
    // Dead without a reason — the button states it and would not fire.
    const reopen = findAll(findByTestID(tree, 'amend-reopen-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(reopen.props.accessibilityState).toMatchObject({ disabled: true });
    expect(captured.reopen).toEqual([]);

    await typeInto(tree, 'amend-reopen-reason', 'the technician synced late — the day was not final');
    const tree2 = toJson(r);
    const ready = findAll(findByTestID(tree2, 'amend-reopen-confirm')!, (n) => n.type === 'Pressable')[0]!;
    await act(async () => {
      ready.props.onPress?.();
    });
    // STEP ONE lands the reopen. STEP TWO is the owner pressing Amend
    // again — nothing here amends as a side effect of reopening.
    expect(captured.reopen).toEqual(['the technician synced late — the day was not final']);
    expect(captured.amend).toEqual([]);
  });
});

// ── card-vs-row at all four widths ──────────────────────────────────────────

describe('Card-vs-row at all four widths (Done-when)', () => {
  const WIDTHS = [390, 800, 1024, 1440] as const;

  it('NavShell still puts the desk breakpoint at 1024 — the widths below map to it', () => {
    const source = readFileSync(join(HERE, '..', '..', 'navigation', 'NavShell.tsx'), 'utf8');
    expect(source).toMatch(/DESK_MIN_WIDTH = 1024/);
  });

  for (const width of WIDTHS) {
    it(`jobs at ${width}px render ${width >= 1024 ? 'the table' : 'cards'}`, async () => {
      const density = densityForRole('owner', width >= 1024);
      const r = await create(
        <DensityProvider density={density}>
          <OwnerJobsScreen {...baseDeps([rowOf(OWNER_CARD, 'Ravi Kumar'), rowOf(DISPATCHER_CARD, 'Anitha Prasad')])} />
        </DensityProvider>,
      );
      const tree = toJson(r);
      if (width >= 1024) {
        expect(findByTestID(tree, 'owner-jobs-table')).toBeDefined();
        expect(findByTestID(tree, 'owner-jobs-list')).toBeUndefined();
        expect(findByTestID(tree, `owner-job-card-${OWNER_CARD.id}`)).toBeUndefined();
      } else {
        expect(findByTestID(tree, 'owner-jobs-list')).toBeDefined();
        expect(findByTestID(tree, 'owner-jobs-table')).toBeUndefined();
        expect(findByTestID(tree, `owner-job-card-${OWNER_CARD.id}`)).toBeDefined();
        // The phone card carries the amount too — the same schema rule.
        expect(findByTestID(tree, `owner-job-card-${OWNER_CARD.id}-amount`)).toBeDefined();
      }
    });
  }
});
