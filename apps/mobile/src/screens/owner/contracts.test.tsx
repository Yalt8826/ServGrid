/**
 * O6 Contracts tests (UI/plan-2/07-OWNER.md §O6). The ones the spec
 * names:
 *
 * - **Contract detail renders EVERY attempt under a multi-attempt
 *   visit** — a visit on its third attempt is the thing the owner wants
 *   to see when a customer complains.
 * - **Renewals is a filtered view, not a separate screen** — expiring
 *   within 60 days, sorted by days remaining, visits used on every row.
 */
import { describe, expect, it } from 'vitest';

import { allText, create, findByTestID, findAllByTestID, toJson } from '../../components/ui/testing';
import { OwnerContractDetailScreen } from './ContractDetailScreen';
import { OwnerContractsScreen } from './ContractsScreen';
import { renewalsOf, type ContractRow, type ContractVisitRow } from './model';

const TODAY = '2026-09-15';

function contract(overrides: Partial<ContractRow>): ContractRow {
  return {
    id: 'k1000000-0000-4000-8000-000000000001',
    contractNumber: 'CT-2627-00007',
    site: 'Meenakshi Enterprises — Peenya',
    billing: 'on_visit',
    visitsUsed: 3,
    visitsIncluded: 12,
    startDate: '2026-04-01',
    endDate: '2027-03-31',
    value: '96000',
    soldByName: 'Suresh Naik',
    status: 'active',
    ...overrides,
  };
}

function visit(overrides: Partial<ContractVisitRow>): ContractVisitRow {
  return {
    id: 'v1000000-0000-4000-8000-000000000001',
    ordinal: 1,
    dueDate: '2026-04-07',
    status: 'completed',
    attempts: [
      { jobId: 'b1000000-0000-4000-8000-00000000000a', jobNumber: 'JC-2627-00101', status: 'completed', technicianName: 'Anitha Prasad' },
    ],
    ...overrides,
  };
}

describe('Contract detail — every attempt under a multi-attempt visit (§O6)', () => {
  it('a visit on its third attempt renders all three job cards', async () => {
    const r = await create(
      <OwnerContractDetailScreen
        contract={contract({})}
        visits={[
          visit({
            id: 'v1000000-0000-4000-8000-000000000002',
            ordinal: 2,
            dueDate: '2026-07-06',
            status: 'overdue',
            attempts: [
              { jobId: 'b1000000-0000-4000-8000-00000000000b', jobNumber: 'JC-2627-00201', status: 'cancelled', technicianName: 'Ravi Kumar' },
              { jobId: 'b1000000-0000-4000-8000-00000000000c', jobNumber: 'JC-2627-00255', status: 'cancelled', technicianName: 'Farhan Ali' },
              { jobId: 'b1000000-0000-4000-8000-00000000000d', jobNumber: 'JC-2627-00310', status: 'in_progress', technicianName: 'Ravi Kumar' },
            ],
          }),
        ]}
        error={null}
        loading={false}
        onOpenJob={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    // EVERY attempt renders, each named as an attempt, with its card.
    expect(findByTestID(tree, 'visit-attempt-v1000000-0000-4000-8000-000000000002-0')).toBeDefined();
    expect(findByTestID(tree, 'visit-attempt-v1000000-0000-4000-8000-000000000002-1')).toBeDefined();
    expect(findByTestID(tree, 'visit-attempt-v1000000-0000-4000-8000-000000000002-2')).toBeDefined();
    expect(findByTestID(tree, 'attempt-job-v1000000-0000-4000-8000-000000000002-0')).toBeDefined();
    expect(findByTestID(tree, 'attempt-job-v1000000-0000-4000-8000-000000000002-1')).toBeDefined();
    expect(findByTestID(tree, 'attempt-job-v1000000-0000-4000-8000-000000000002-2')).toBeDefined();
    const text = allText(tree).join(' | ');
    expect(text).toContain('JC-2627-00201');
    expect(text).toContain('JC-2627-00255');
    expect(text).toContain('JC-2627-00310');
    expect(text).toContain('Attempt 3');
    // The multi-attempt visit is called out at the visit level.
    expect(text).toContain('3 attempts');
  });

  it('a single-attempt visit renders its one card with no attempt fanfare', async () => {
    const r = await create(
      <OwnerContractDetailScreen
        contract={contract({})}
        visits={[visit({})]}
        error={null}
        loading={false}
        onOpenJob={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'visit-attempt-v1000000-0000-4000-8000-000000000001-0')).toBeDefined();
    expect(findByTestID(tree, 'visit-attempts-note-v1000000-0000-4000-8000-000000000001')).toBeUndefined();
  });
});

describe('Renewals — a filtered view, not a separate screen (§O6)', () => {
  it('keeps contracts expiring within 60 days, sorted by days remaining', () => {
    const rows = [
      contract({ id: 'k1000000-0000-4000-8000-000000000001', endDate: '2026-10-20', visitsUsed: 2 }), // 35 days
      contract({ id: 'k1000000-0000-4000-8000-000000000002', endDate: '2026-10-05', visitsUsed: 9 }), // 20 days
      contract({ id: 'k1000000-0000-4000-8000-000000000003', endDate: '2027-01-15' }), // outside the window
      contract({ id: 'k1000000-0000-4000-8000-000000000004', endDate: '2026-09-01' }), // already past
    ];
    const renewals = renewalsOf(rows, TODAY);
    expect(renewals.map((r) => r.id)).toEqual([
      'k1000000-0000-4000-8000-000000000002',
      'k1000000-0000-4000-8000-000000000001',
    ]);
    // Visits used ride the renewal row — a spent visit reduces what the
    // renewal is worth.
    expect(renewals[0]!.visitsUsed).toBe(9);
    expect(renewals[0]!.daysRemaining).toBe(20);
  });

  it('the renewals screen renders the window with the days count on each row', async () => {
    const r = await create(
      <OwnerContractsScreen
        variant="renewals"
        rows={[
          contract({ id: 'k1000000-0000-4000-8000-000000000001', endDate: '2026-10-05', visitsUsed: 9 }),
        ]}
        error={null}
        loading={false}
        today={TODAY}
        onOpenContract={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'contract-row-k1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(tree, 'contract-days-k1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(allText(findByTestID(tree, 'contract-days-k1000000-0000-4000-8000-000000000001')!).join('')).toContain('20');
    expect(allText(findByTestID(tree, 'contract-visits-k1000000-0000-4000-8000-000000000001') ?? tree).join('')).toContain('9/12');
  });

  it('the full list is the same screen, unfiltered', async () => {
    const r = await create(
      <OwnerContractsScreen
        variant="all"
        rows={[
          contract({ id: 'k1000000-0000-4000-8000-000000000001' }),
          contract({ id: 'k1000000-0000-4000-8000-000000000003', endDate: '2027-01-15' }),
        ]}
        error={null}
        loading={false}
        today={TODAY}
        onOpenContract={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findAllByTestID(tree, 'contract-row-k1000000-0000-4000-8000-000000000001').length).toBeGreaterThan(0);
    expect(findAllByTestID(tree, 'contract-row-k1000000-0000-4000-8000-000000000003').length).toBeGreaterThan(0);
  });
});
