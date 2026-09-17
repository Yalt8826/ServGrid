/**
 * The AMC detail's tests (T2B.4, §D5 "Detail"). The ones the spec names:
 *
 * - **The facts render** — number, customer, term, price, state, last
 *   service, next due, open job — and **every linked job** renders with
 *   a tap that routes to the job.
 * - **A cancelled AMC renders no actions** — it is a record, not a
 *   working surface.
 * - **The cancel sheet**: confirm stays disabled while the reason is
 *   blank; with a reason it cancels with THAT reason; a refusal renders
 *   in the sheet and the sheet stays open — the reason is never lost.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { ContractDetailSchema, type ContractDetail } from '@servgrid/shared';
import { allText, create, findByTestID, toJson, type Node } from '../../components/ui/testing';
import { AmcDetailScreen, type AmcDetailScreenProps } from './AmcDetailScreen';

// ── fixtures ─────────────────────────────────────────────────────────────

const JOB_A = 'a1000000-0000-4000-8000-000000000001';
const JOB_B = 'a1000000-0000-4000-8000-000000000002';

function detail(overrides: Partial<Parameters<typeof ContractDetailSchema.parse>[0]> = {}): ContractDetail {
  return ContractDetailSchema.parse({
    contract: {
      id: 'b1000000-0000-4000-8000-000000000001',
      contractNumber: 'AMC-2627-00031',
      customerId: '01890a5e-1000-7000-8000-00000000c001',
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
      openJob: { id: JOB_A, jobNumber: 'JC-2627-00044', scheduledFor: '2026-10-12T06:00:00.000Z' },
      daysToEnd: 364,
      isVisitDue: true,
      isEndingSoon: false,
      version: 1,
    },
    jobs: [
      {
        id: JOB_A,
        jobNumber: 'JC-2627-00044',
        title: 'AMC visit — UPS check',
        status: 'assigned',
        scheduledFor: '2026-10-12T06:00:00.000Z',
        closedAt: null,
        assignedToName: 'Ravi Kumar',
      },
      {
        id: JOB_B,
        jobNumber: 'JC-2627-00051',
        title: 'Battery swap',
        status: 'completed',
        scheduledFor: null,
        closedAt: '2026-08-20T09:30:00.000Z',
        assignedToName: null,
      },
    ],
    ...overrides,
  });
}

function baseProps(overrides: Partial<AmcDetailScreenProps> = {}): AmcDetailScreenProps {
  return {
    detail: detail(),
    loading: false,
    error: null,
    onRetry: vi.fn(),
    onEdit: vi.fn(),
    onRenew: vi.fn(),
    onOpenJob: vi.fn(),
    onCancel: vi.fn().mockResolvedValue(undefined),
    cancelling: false,
    cancelError: null,
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

/** The pressable a primitive owns — Button hangs its testID on the
 * outer View and its onPress on the Pressable inside. */
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

/** The TextInput inside a field — the one whose onChangeText the test drives. */
function inputInside(field: Node): Node | undefined {
  const stack: Node[] = [field];
  while (stack.length > 0) {
    const current = stack.shift()!;
    if (current.props.onChangeText !== undefined) return current;
    for (const child of current.children ?? []) {
      if (child !== null && typeof child !== 'string') stack.push(child);
    }
  }
  return undefined;
}

function typeReason(renderer: ReactTestRenderer, text: string): void {
  const reason = findID(renderer, 'amc-cancel-reason');
  expect(reason).toBeDefined();
  const input = inputInside(reason!);
  expect(input).toBeDefined();
  act(() => {
    input!.props.onChangeText?.(text);
  });
}

// ── the tests ────────────────────────────────────────────────────────────

describe('AmcDetailScreen (§D5)', () => {
  it('the facts render, every linked job renders, and a job tap routes to the job', async () => {
    const onOpenJob = vi.fn();
    const renderer = await create(<AmcDetailScreen {...baseProps({ onOpenJob })} />);

    const facts = findID(renderer, 'amc-detail-facts');
    expect(facts).toBeDefined();
    const factTexts = allText(facts!).join(' ');
    expect(factTexts).toContain('AMC-2627-00031');
    expect(factTexts).toContain('Sunrise Apartments');
    expect(factTexts).toContain('15 Sep 2026 – 14 Sep 2027');
    expect(factTexts).toContain('₹18,000');
    expect(factTexts).toContain('Active');
    // The label carries the words once; the value is the date (the row
    // used to read "Last service | last service 3 May 2026").
    expect(factTexts).toContain('Last service');
    expect(allText(findID(renderer, 'amc-detail-service')!).join(' ')).toBe('3 May 2026');
    expect(factTexts).toContain('Next visit due');
    expect(allText(findID(renderer, 'amc-detail-next-due')!).join(' ')).toBe('3 Sep 2026');
    expect(factTexts).toContain('JC-2627-00044 booked for 12 Oct');
    expect(factTexts).toContain('Gate code 4412');

    const jobs = findID(renderer, 'amc-detail-jobs');
    expect(jobs).toBeDefined();
    const jobTexts = allText(jobs!).join(' ');
    expect(jobTexts).toContain('JC-2627-00044 · AMC visit — UPS check');
    expect(jobTexts).toContain('Ravi Kumar');
    expect(jobTexts).toContain('JC-2627-00051 · Battery swap');

    press(pressableOf(findID(renderer, `amc-detail-job-${JOB_A}`)!));
    expect(onOpenJob).toHaveBeenCalledWith(JOB_A);
  });

  it('a cancelled AMC renders no Edit, no Renew, no Cancel', async () => {
    const cancelled = detail();
    const renderer = await create(
      <AmcDetailScreen
        {...baseProps({
          detail: {
            ...cancelled,
            contract: {
              ...cancelled.contract,
              state: 'cancelled',
              cancelledAt: '2026-09-20T05:00:00.000Z',
              cancelReason: 'Customer moved sites',
            },
          },
        })}
      />,
    );
    expect(findID(renderer, 'amc-detail-actions')).toBeUndefined();
    expect(findID(renderer, 'amc-detail-edit')).toBeUndefined();
    expect(findID(renderer, 'amc-detail-renew')).toBeUndefined();
    expect(findID(renderer, 'amc-detail-cancel')).toBeUndefined();
  });

  it('the cancel sheet: blank reason keeps confirm disabled', async () => {
    const renderer = await create(<AmcDetailScreen {...baseProps()} />);
    press(pressableOf(findID(renderer, 'amc-detail-cancel')!));
    expect(findID(renderer, 'amc-cancel-sheet')).toBeDefined();

    const confirm = pressableOf(findID(renderer, 'amc-cancel-confirm')!);
    expect((confirm.props.accessibilityState as { disabled?: boolean }).disabled).toBe(true);
  });

  it('the cancel sheet: with a reason it cancels with that reason', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const renderer = await create(<AmcDetailScreen {...baseProps({ onCancel })} />);
    press(pressableOf(findID(renderer, 'amc-detail-cancel')!));

    typeReason(renderer, 'Customer moved sites');

    press(pressableOf(findID(renderer, 'amc-cancel-confirm')!));
    await act(async () => {});
    expect(onCancel).toHaveBeenCalledWith('Customer moved sites');
    // Success closes the sheet.
    expect(findID(renderer, 'amc-cancel-sheet')).toBeUndefined();
  });

  it('a refusal renders inside the sheet and the sheet stays open', async () => {
    const onCancel = vi.fn().mockRejectedValue(new Error('This AMC has a job in progress.'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = await create(<AmcDetailScreen {...baseProps({ onCancel, cancelError: null })} />);
    });
    press(pressableOf(findID(renderer, 'amc-detail-cancel')!));

    typeReason(renderer, 'Changed my mind');

    press(pressableOf(findID(renderer, 'amc-cancel-confirm')!));
    // Let the rejection settle.
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    // The screen renders the route's cancelError on the next render.
    await act(async () => {
      renderer.update(<AmcDetailScreen {...baseProps({ onCancel, cancelError: 'This AMC has a job in progress.' })} />);
    });

    const sheet = findID(renderer, 'amc-cancel-sheet');
    expect(sheet).toBeDefined();
    expect(allText(sheet!).join(' ')).toContain('This AMC has a job in progress.');
  });
});
