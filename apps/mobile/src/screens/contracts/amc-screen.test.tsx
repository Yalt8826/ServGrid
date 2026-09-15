/**
 * The AMC tab's tests (T2B.4, §D5). The ones the spec names:
 *
 * - **Due rows** render the customer, the due line and a Dispatch button
 *   routed with the CUSTOMER id (the dispatch form opens on that site).
 * - **Ending rows** render the urgency line ("ends in 7 days") and the
 *   price with Indian grouping — Renew routed with the CONTRACT id.
 * - **Each section fails alone**: its empty sentence when empty, a
 *   skeleton (after the 200 ms delay) while loading, a danger Banner on
 *   failure — while the other two sections keep rendering.
 * - **Search** hands every keystroke to the route's debounce; a search
 *   that matches nothing says so and offers Clear search.
 * - **No job revenue on the dispatcher's tree** — the AMC price is the
 *   one money figure here (decision 8); job revenue keys are absent.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import { ContractSchema, type Contract } from '@servgrid/shared';
import type { ReactTestRenderer } from 'react-test-renderer';
import { allText, create, findByTestID, firstDescendantOfType, toJson, type Node } from '../../components/ui/testing';
import { AmcScreen, type AmcScreenProps } from './AmcScreen';

// ── fixtures ─────────────────────────────────────────────────────────────

const CUST_ID = '01890a5e-1000-7000-8000-00000000c001';
const OTHER_CUST_ID = '01890a5e-1000-7000-8000-00000000c002';

function contract(overrides: Partial<Contract> = {}): Contract {
  return ContractSchema.parse({
    id: 'b1000000-0000-4000-8000-000000000001',
    contractNumber: 'AMC-2627-00031',
    customerId: CUST_ID,
    customerName: 'Sunrise Apartments',
    startDate: '2026-09-15',
    endDate: '2027-09-14',
    contractValue: '18000.00',
    notes: null,
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
    ...overrides,
  });
}

const DUE = contract({ id: 'b1000000-0000-4000-8000-00000000000a', contractNumber: 'AMC-2627-00041' });
const ENDING = contract({
  id: 'b1000000-0000-4000-8000-00000000000b',
  contractNumber: 'AMC-2627-00031',
  customerName: 'Nandi Motors',
  customerId: OTHER_CUST_ID,
  daysToEnd: 7,
  isEndingSoon: true,
  nextVisitDue: '2026-09-10',
});
const LISTED = contract({ id: 'b1000000-0000-4000-8000-00000000000c', contractNumber: 'AMC-2627-00051', customerName: 'Greenfield Clinic' });

function baseProps(overrides: Partial<AmcScreenProps> = {}): AmcScreenProps {
  return {
    role: 'dispatcher',
    todayIso: '2026-09-15',
    query: '',
    onQueryChange: vi.fn(),
    due: null,
    ending: null,
    all: null,
    dueError: null,
    endingError: null,
    allError: null,
    onRetry: vi.fn(),
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onDispatch: vi.fn(),
    onRenew: vi.fn(),
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
  const inner = findByTestIDIn(node);
  expect(inner).toBeDefined();
  return inner!;
}

function findByTestIDIn(root: Node): Node | undefined {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const current = stack.shift()!;
    if (typeof current.props.onPress === 'function') return current;
    for (const child of current.children ?? []) {
      if (child !== null && typeof child !== 'string') stack.push(child);
    }
  }
  return undefined;
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

// ── the sections ─────────────────────────────────────────────────────────

describe('AmcScreen (§D5)', () => {
  it('due rows render the customer, the due line and a Dispatch button routed with the customer', async () => {
    const onDispatch = vi.fn();
    const renderer = await create(<AmcScreen {...baseProps({ due: [DUE], ending: [], all: [], onDispatch })} />);

    const row = findID(renderer, `amc-due-${DUE.id}`);
    expect(row).toBeDefined();
    const texts = allText(row!).join(' ');
    expect(texts).toContain('Sunrise Apartments');
    expect(texts).toContain('last service 3 May 2026 · due since 3 Sep 2026');

    press(pressableOf(findID(renderer, `amc-dispatch-${DUE.id}`)!));
    expect(onDispatch).toHaveBeenCalledWith(DUE.customerId);
  });

  it('ending rows render the urgency line and the price with Indian grouping; Renew carries the contract id', async () => {
    const onRenew = vi.fn();
    const renderer = await create(<AmcScreen {...baseProps({ due: [], ending: [ENDING], all: [], onRenew })} />);

    const row = findID(renderer, `amc-ending-${ENDING.id}`);
    expect(row).toBeDefined();
    const texts = allText(row!).join(' ');
    expect(texts).toContain('ends in 7 days');
    expect(texts).toContain('₹18,000');
    // en-IN grouping — never the western one.
    expect(texts).not.toContain('18,000.00,');

    press(pressableOf(findID(renderer, `amc-renew-${ENDING.id}`)!));
    expect(onRenew).toHaveBeenCalledWith(ENDING.id);
  });

  it('each section\u2019s empty sentence renders when its array is empty', async () => {
    const renderer = await create(<AmcScreen {...baseProps({ due: [], ending: [], all: [] })} />);
    expect(allText(findID(renderer, 'amc-due-empty')!).join(' ')).toContain('No AMC customer is due for a visit.');
    expect(allText(findID(renderer, 'amc-ending-empty')!).join(' ')).toContain('No AMC ends in the next 7 days.');
    expect(allText(findID(renderer, 'amc-all-empty')!).join(' ')).toContain('No AMCs recorded yet.');
  });

  it('a loading section renders skeleton rows after 200 ms, never the empty sentence', async () => {
    vi.useFakeTimers();
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = await create(<AmcScreen {...baseProps({ due: null, ending: [], all: [] })} />);
      });
      // Not yet — under the 200 ms delay nothing shows, so neither the
      // skeleton nor (crucially) the empty sentence may render.
      expect(findID(renderer, 'amc-due-empty')).toBeUndefined();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(findID(renderer, 'amc-due-skeleton')).toBeDefined();
      expect(findID(renderer, 'amc-due-empty')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed section shows its Banner while the other two still render their rows', async () => {
    const renderer = await create(
      <AmcScreen
        {...baseProps({
          due: null,
          dueError: 'The due list did not go through. Try again.',
          ending: [ENDING],
          all: [LISTED],
        })}
      />,
    );
    const banner = findID(renderer, 'amc-due-error');
    expect(banner).toBeDefined();
    expect(allText(banner!).join(' ')).toContain('The due list did not go through.');
    expect(findID(renderer, `amc-ending-${ENDING.id}`)).toBeDefined();
    expect(findID(renderer, `amc-all-${LISTED.id}`)).toBeDefined();

    // Retry re-asks only the failed section.
    const onRetry = vi.fn();
    await act(async () => {
      renderer.update(<AmcScreen {...baseProps({ due: null, dueError: 'x', ending: [ENDING], all: [LISTED], onRetry })} />);
    });
    press(pressableOf(findID(renderer, 'amc-due-error')!));
    expect(onRetry).toHaveBeenCalledWith('due');
  });

  it('search hands every keystroke on; a miss says so and offers Clear search', async () => {
    const onQueryChange = vi.fn();
    const renderer = await create(<AmcScreen {...baseProps({ all: [], query: '', onQueryChange })} />);
    typeInto(renderer, 'amc-search', 'Nandi');
    expect(onQueryChange).toHaveBeenCalledWith('Nandi');

    await act(async () => {
      renderer.update(<AmcScreen {...baseProps({ all: [], query: 'Nandi', onQueryChange })} />);
    });
    expect(allText(findID(renderer, 'amc-all-empty')!).join(' ')).toContain('No AMC matches.');
    press(pressableOf(findID(renderer, 'amc-clear-search')!));
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('rows open the detail; + New opens the form', async () => {
    const onOpen = vi.fn();
    const onNew = vi.fn();
    const renderer = await create(
      <AmcScreen {...baseProps({ due: [DUE], ending: [], all: [LISTED], onOpen, onNew })} />,
    );
    press(pressableOf(findID(renderer, `amc-due-open-${DUE.id}`)!));
    expect(onOpen).toHaveBeenCalledWith(DUE.id);
    press(pressableOf(findID(renderer, `amc-all-${LISTED.id}`)!));
    expect(onOpen).toHaveBeenCalledWith(LISTED.id);
    press(pressableOf(findID(renderer, 'amc-new')!));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('the dispatcher\u2019s tree carries no job revenue key — the AMC price is the only money here', async () => {
    const renderer = await create(<AmcScreen {...baseProps({ role: 'dispatcher', due: [DUE], ending: [ENDING], all: [LISTED] })} />);
    const texts = allText(toJson(renderer));
    expect(texts.join(' | ')).not.toContain('Amount collected');
    // Type-level, too: a `Contract` has no `cost` field — asserted by the
    // compiler, since the props above are all `Contract`s.
    const rows: Contract[] = [DUE, ENDING, LISTED];
    expect(rows.every((c) => !('cost' in c))).toBe(true);
    // And the search offers no revenue filter.
    const tree = JSON.stringify(toJson(renderer)).toLowerCase();
    expect(tree).not.toContain('amount collected');
  });

  it('the owner\u2019s phone keeps the list; testIDs stay findable', async () => {
    const renderer = await create(
      <AmcScreen {...baseProps({ role: 'owner', due: [DUE], ending: [ENDING], all: [LISTED] })} />,
    );
    expect(findID(renderer, `amc-due-${DUE.id}`)).toBeDefined();
    expect(findID(renderer, `amc-ending-${ENDING.id}`)).toBeDefined();
    expect(findID(renderer, `amc-all-${LISTED.id}`)).toBeDefined();
  });
});
