/**
 * D3 Dispatch Job tests (T2.9, UI/plan-2/05-DISPATCHER.md §D3) — the
 * six the spec names:
 *
 * - **Typing searches; no result offers create inline without leaving
 *   the form** — one field is both search and create; the *+ New
 *   customer* offer renders in the form's own tree.
 * - **The unit picker is populated from the selected customer's stack
 *   and is skippable** — the options ARE that site's units, and a
 *   submit without one goes through (`customer_product_id` is nullable,
 *   PLAN-DATA-MODEL.md §3.4).
 * - **Picker sorts by load ascending, never alphabetically** — proven
 *   with a roster whose load order and alphabetical order disagree.
 * - **Leave unassigned is an explicit option and is not preselected** —
 *   nothing is selected until a row is tapped; the unassigned row is a
 *   choice, never the silent default.
 * - **No company field exists in the tree** — the dispatcher holds no
 *   company permission (PLAN-BACKEND.md §5); the form does not even
 *   offer it.
 * - **Submit toast contains the allocated job number** — *"JC-2627-0044
 *   assigned to Ravi"*, because the dispatcher may need to read it back
 *   down the phone.
 *
 * Plus the Done-when: a job is raised and assigned ON this screen — one
 * submit carries the whole form, and an unset assignment is refused
 * with a sentence instead of being defaulted.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import {
  allText,
  create,
  findAll,
  findByTestID,
  firstDescendantOfType,
  toJson,
  type Node,
} from '../../components/ui/testing';
import {
  DispatchJobScreen,
  TechnicianPicker,
  type AssignmentChoice,
  type DispatchJobDeps,
} from './dispatch';
import {
  formatSubmitToast,
  sortTechniciansByLoad,
  unitLabelOf,
  type DispatchCustomerOption,
  type DispatchTechnician,
} from './dispatchForm';

// ── fixtures ─────────────────────────────────────────────────────────────

const TODAY_ISO = '2026-09-13';

const CUST_ID = '01890a5e-1000-7000-8000-00000000c001';
const UNIT_A = '01890a5e-2000-7000-8000-00000000u001';
const UNIT_B = '01890a5e-2000-7000-8000-00000000u002';
const SVC_BATTERY = '01890a5e-3000-7000-8000-00000000s001';
const SVC_VISIT = '01890a5e-3000-7000-8000-00000000s002';
const T_ZARA = '01890a5e-4000-7000-8000-00000000t001';
const T_RAVI = '01890a5e-4000-7000-8000-00000000t002';
const T_VIKRAM = '01890a5e-4000-7000-8000-00000000t003';
const T_AMIT = '01890a5e-4000-7000-8000-00000000t004';

const SUNRISE: DispatchCustomerOption = {
  id: CUST_ID,
  name: 'Sunrise Apartments',
  phone: '9845012345',
  addressLabel: '12 3rd Cross, Kormangala',
};

const STACK = [
  { id: UNIT_A, label: 'UPS 850VA · SN LM8842219' },
  { id: UNIT_B, label: 'Battery 150Ah · SN BT2200144' },
];

const SERVICES = [
  { id: SVC_BATTERY, name: 'Battery swap' },
  { id: SVC_VISIT, name: 'Site survey' },
];

/** Roster order is the server's answer — deliberately NOT alphabetical,
 * and with a tie (Ravi, Vikram at 3) the sort must keep roster order. */
const ROSTER: DispatchTechnician[] = [
  { employeeId: T_ZARA, name: 'Zara Khan', openTotal: 1, health: null },
  { employeeId: T_RAVI, name: 'Ravi Kumar', openTotal: 3, health: { health: 'active', minutesSince: 2 } },
  { employeeId: T_VIKRAM, name: 'Vikram Rao', openTotal: 3, health: null },
  { employeeId: T_AMIT, name: 'Amit Jain', openTotal: 6, health: null },
];

function baseDeps(overrides: Partial<DispatchJobDeps> = {}): DispatchJobDeps {
  return {
    offline: false,
    customerQuery: '',
    customers: null,
    customerError: null,
    selectedCustomer: null,
    stack: null,
    services: SERVICES,
    technicians: ROSTER,
    todayIso: TODAY_ISO,
    submitting: false,
    submitError: null,
    submitted: null,
    onCustomerQueryChange: vi.fn(),
    onSelectCustomer: vi.fn(),
    onNewCustomer: vi.fn(),
    onClearCustomer: vi.fn(),
    onSubmit: vi.fn(),
    onDismissToast: vi.fn(),
    ...overrides,
  };
}

// ── harness helpers ──────────────────────────────────────────────────────

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
  const inner = findAll(node, (n) => typeof n.props.onPress === 'function')[0];
  expect(inner).toBeDefined();
  return inner!;
}

function type(renderer: ReactTestRenderer, testID: string, text: string): void {
  const field = findID(renderer, testID);
  expect(field).toBeDefined();
  const input = firstDescendantOfType(field!, 'TextInput');
  expect(input).toBeDefined();
  expect(typeof input!.props.onChangeText).toBe('function');
  act(() => {
    input!.props.onChangeText?.(text);
  });
}

function valueOf(renderer: ReactTestRenderer, testID: string): string {
  const field = findID(renderer, testID);
  expect(field).toBeDefined();
  const input = firstDescendantOfType(field!, 'TextInput');
  expect(input).toBeDefined();
  return String(input!.props.value ?? '');
}

function textOf(renderer: ReactTestRenderer, testID: string): string {
  const node = findID(renderer, testID);
  expect(node).toBeDefined();
  return normText(allText(node!).join(' '));
}

/** JSX splits composed strings across text nodes; compare on words. */
function normText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The picker's rows, in render order: technicians then the unassigned
 * row — the picker container and the rows' inner load testIDs excluded. */
function pickerOrder(renderer: ReactTestRenderer): string[] {
  const picker = findID(renderer, 'dispatch-assign-picker');
  expect(picker).toBeDefined();
  return findAll(
    picker!,
    (n) =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('dispatch-assign-') &&
      n.props.testID !== 'dispatch-assign-picker' &&
      !n.props.testID.includes('-load-'),
  ).map((n) => n.props.testID as string);
}

function isSelected(node: Node | undefined): boolean {
  expect(node).toBeDefined();
  const state = node!.props.accessibilityState as { selected?: boolean } | undefined;
  return state?.selected === true;
}

/** Choose the given service from the sheet and wait for it to close. */
function chooseService(renderer: ReactTestRenderer, serviceId: string): void {
  press(findID(renderer, 'dispatch-service-trigger')!);
  expect(findID(renderer, 'dispatch-service-sheet')).toBeDefined();
  press(findID(renderer, `service-option-${serviceId}`)!);
  expect(findID(renderer, 'dispatch-service-sheet')).toBeUndefined();
}

// ── the six ──────────────────────────────────────────────────────────────

describe('DispatchJobScreen (§D3)', () => {
  it('typing searches, and no match offers + New customer inline without leaving the form', async () => {
    let query = '';
    const onCustomerQueryChange = vi.fn((next: string) => {
      query = next;
      act(() => {
        renderer.update(
          <DispatchJobScreen
            {...baseDeps({
              customerQuery: query,
              customers: query.trim() === '' ? null : query === 'Sunrise' ? [SUNRISE] : [],
              onCustomerQueryChange,
            })}
          />,
        );
      });
    });
    const renderer = await create(<DispatchJobScreen {...baseDeps({ onCustomerQueryChange })} />);

    // Typing IS searching: the field hands every keystroke to the hook,
    // which debounces into `GET /v1/customers?q=`.
    type(renderer, 'dispatch-customer-field', 'Sun');
    expect(onCustomerQueryChange).toHaveBeenCalledWith('Sun');

    // A match renders inline under the field — tap to select, still in
    // the form.
    await act(async () => {
      renderer.update(
        <DispatchJobScreen
          {...baseDeps({ customerQuery: 'Sunrise', customers: [SUNRISE], onCustomerQueryChange })}
        />,
      );
    });
    const result = findID(renderer, `dispatch-customer-result-${CUST_ID}`);
    expect(result).toBeDefined();
    expect(allText(result!).join(' ')).toContain('Sunrise Apartments');
    const onSelect = vi.fn();
    await act(async () => {
      renderer.update(
        <DispatchJobScreen {...baseDeps({ customerQuery: 'Sunrise', customers: [SUNRISE], onSelectCustomer: onSelect, onCustomerQueryChange })} />,
      );
    });
    press(findID(renderer, `dispatch-customer-result-${CUST_ID}`)!);
    expect(onSelect).toHaveBeenCalledWith(SUNRISE);

    // No match: the offer is IN the form — the submit button is still on
    // the same screen, no navigation has happened.
    await act(async () => {
      renderer.update(
        <DispatchJobScreen
          {...baseDeps({ customerQuery: 'Greenfield', customers: [], onCustomerQueryChange })}
        />,
      );
    });
    const offer = findID(renderer, 'dispatch-new-customer');
    expect(offer).toBeDefined();
    expect(allText(offer!).join(' ')).toContain('+ New customer');
    expect(findID(renderer, 'dispatch-submit')).toBeDefined();
    const onNewCustomer = vi.fn();
    await act(async () => {
      renderer.update(
        <DispatchJobScreen
          {...baseDeps({ customerQuery: 'Greenfield', customers: [], onNewCustomer, onCustomerQueryChange })}
        />,
      );
    });
    press(findID(renderer, 'dispatch-new-customer')!);
    expect(onNewCustomer).toHaveBeenCalledTimes(1);
  });

  it('the unit picker is populated from the selected customer\u2019s stack and is skippable', async () => {
    const renderer = await create(
      <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK })} />,
    );

    // Selecting a customer collapsed the search to one line.
    expect(findID(renderer, 'dispatch-customer-selected')).toBeDefined();
    expect(textOf(renderer, 'dispatch-customer-selected')).toContain('Sunrise Apartments');
    expect(findID(renderer, 'dispatch-customer-field')).toBeUndefined();

    // …and revealed the unit picker (the one progressive disclosure).
    expect(findID(renderer, 'dispatch-unit-reveal')).toBeDefined();

    // Contact prefilled from the customer.
    expect(valueOf(renderer, 'dispatch-contact-name')).toBe('Sunrise Apartments');
    expect(valueOf(renderer, 'dispatch-contact-phone')).toBe('9845012345');

    // The sheet's options ARE that site's stack — both units, plus the
    // explicit skip.
    press(findID(renderer, 'dispatch-unit-trigger')!);
    expect(findID(renderer, 'dispatch-unit-sheet')).toBeDefined();
    expect(textOf(renderer, `unit-option-${UNIT_A}`)).toBe('UPS 850VA · SN LM8842219');
    expect(textOf(renderer, `unit-option-${UNIT_B}`)).toBe('Battery 150Ah · SN BT2200144');
    expect(findID(renderer, 'unit-option-none')).toBeDefined();
    press(findID(renderer, `unit-option-${UNIT_A}`)!);
    expect(findID(renderer, 'dispatch-unit-sheet')).toBeUndefined();

    // Skippable: a fresh form whose dispatcher never opened the unit
    // sheet submits with the unit null — the dispatcher may not know
    // (§D3).
    const onSubmit = vi.fn();
    const fresh = await create(
      <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK, onSubmit })} />,
    );
    chooseService(fresh, SVC_BATTERY);
    press(findID(fresh, 'dispatch-assign-unassigned')!);
    press(pressableOf(findID(fresh, 'dispatch-submit')!));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].unitId).toBeNull();

    // …and naming the unit the stack offered names it on the card.
    press(findID(fresh, 'dispatch-unit-trigger')!);
    press(findID(fresh, `unit-option-${UNIT_B}`)!);
    press(pressableOf(findID(fresh, 'dispatch-submit')!));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]![0].unitId).toBe(UNIT_B);
  });

  it('picker sorts by load ascending, never alphabetically', async () => {
    // The fixture's names are chosen so alphabetical order (Amit, Ravi,
    // Vikram, Zara) differs from load order — if the sort ever became a
    // name sort, this assertion fails.
    const renderer = await create(<DispatchJobScreen {...baseDeps()} />);
    expect(pickerOrder(renderer)).toEqual([
      `dispatch-assign-${T_ZARA}`, // 1
      `dispatch-assign-${T_RAVI}`, // 3 — tie…
      `dispatch-assign-${T_VIKRAM}`, // …3, roster order kept
      `dispatch-assign-${T_AMIT}`, // 6
      'dispatch-assign-unassigned', // the explicit LAST option
    ]);

    // The sort is the pure helper's, and it is stable.
    const names = sortTechniciansByLoad(ROSTER).map((technician) => technician.name);
    expect(names).toEqual(['Zara Khan', 'Ravi Kumar', 'Vikram Rao', 'Amit Jain']);
  });

  it('leave unassigned is an explicit option and is not preselected', async () => {
    const renderer = await create(
      <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK })} />,
    );

    // Nothing is selected on arrival — not a technician, not unassigned.
    const rows = pickerOrder(renderer);
    expect(rows.length).toBe(5);
    for (const testID of rows) {
      expect(isSelected(findID(renderer, testID))).toBe(false);
    }

    // Choosing a technician selects exactly that row.
    press(findID(renderer, `dispatch-assign-${T_RAVI}`)!);
    expect(isSelected(findID(renderer, `dispatch-assign-${T_RAVI}`))).toBe(true);
    expect(isSelected(findID(renderer, 'dispatch-assign-unassigned'))).toBe(false);

    // Choosing unassigned deselects the technician — it is a choice, not
    // a leftover default.
    press(findID(renderer, 'dispatch-assign-unassigned')!);
    expect(isSelected(findID(renderer, 'dispatch-assign-unassigned'))).toBe(true);
    expect(isSelected(findID(renderer, `dispatch-assign-${T_RAVI}`))).toBe(false);

    // …and the explicit choice submits technicianId null.
    const onSubmit = vi.fn();
    await act(async () => {
      renderer.update(
        <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK, onSubmit })} />,
      );
    });
    chooseService(renderer, SVC_VISIT);
    press(findID(renderer, 'dispatch-assign-unassigned')!);
    press(pressableOf(findID(renderer, 'dispatch-submit')!));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0].technicianId).toBeNull();
  });

  it('no company field exists in the tree', async () => {
    const renderer = await create(
      <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK })} />,
    );

    // The form is fully dressed — customer, stack, services, roster — so
    // the absence is the form's, not an empty tree's.
    expect(findID(renderer, 'dispatch-unit-trigger')).toBeDefined();
    expect(findID(renderer, 'dispatch-service-trigger')).toBeDefined();
    expect(findID(renderer, 'dispatch-assign-picker')).toBeDefined();

    // Dispatchers hold no company permission (PLAN-BACKEND.md §5 rule 3,
    // PLAN.md §5); the api strips companyId from their payloads and the
    // form never offers it — not hidden, ABSENT.
    const tree = JSON.stringify(toJson(renderer)).toLowerCase();
    expect(tree).not.toContain('company');
    expect(tree).not.toContain('companyid');
  });

  it('submit toast contains the allocated job number', async () => {
    const renderer = await create(
      <DispatchJobScreen
        {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK, submitted: { jobNumber: 'JC-2627-0044', technicianName: 'Ravi Kumar' } })}
      />,
    );

    const toast = findID(renderer, 'dispatch-toast');
    expect(toast).toBeDefined();
    const message = normText(allText(toast!).join(' '));
    expect(message).toContain('JC-2627-0044');
    expect(message).toContain('Ravi');
    // The sentence verbatim (the trailing glyph is the Banner's own dismiss).
    expect(message.startsWith('JC-2627-0044 assigned to Ravi')).toBe(true);

    // Unassigned is its own honest sentence — it never pretends a
    // technician was chosen.
    expect(formatSubmitToast('JC-2627-0044', null)).toBe('JC-2627-0044 raised, unassigned');
    expect(formatSubmitToast('JC-2627-0044', 'Ravi Kumar')).toBe('JC-2627-0044 assigned to Ravi');
  });

  it('a job is raised and assigned on this screen: one submit carries the whole form, and an unset assignment is refused', async () => {
    const onSubmit = vi.fn();
    const renderer = await create(
      <DispatchJobScreen {...baseDeps({ selectedCustomer: SUNRISE, stack: STACK, onSubmit })} />,
    );

    // Submit without a service and without naming anyone: refused with
    // sentences at the fields — never a silent default of unassigned,
    // never navigation to a second page.
    press(pressableOf(findID(renderer, 'dispatch-submit')!));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(findID(renderer, 'dispatch-service-error')).toBeDefined();
    expect(findID(renderer, 'dispatch-assign-error')).toBeDefined();
    expect(findID(renderer, 'dispatch-customer-required')).toBeUndefined(); // the customer IS chosen

    // Priority is four segments; Urgent says what it does.
    press(findID(renderer, 'dispatch-priority-urgent')!);
    expect(findID(renderer, 'dispatch-priority-note')).toBeDefined();
    expect(isSelected(findID(renderer, 'dispatch-priority-urgent'))).toBe(true);
    expect(isSelected(findID(renderer, 'dispatch-priority-normal'))).toBe(false);

    // Name a service and a technician, submit once — the whole form
    // travels in one payload, on this screen.
    chooseService(renderer, SVC_BATTERY);
    press(findID(renderer, `dispatch-assign-${T_RAVI}`)!);
    press(pressableOf(findID(renderer, 'dispatch-submit')!));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      unitId: null,
      serviceId: SVC_BATTERY,
      priority: 'urgent',
      scheduledDate: TODAY_ISO,
      scheduledFor: null, // no time slot chosen — the day alone is honest
      contactName: 'Sunrise Apartments',
      contactPhone: '9845012345',
      notes: '',
      technicianId: T_RAVI,
    });

    // The technician row composes the shared load row — the same visual
    // language D1 and D2's reassign picker read.
    const load = findID(renderer, `dispatch-assign-load-${T_RAVI}`);
    expect(load).toBeDefined();
    expect(allText(load!).join(' ')).toContain('Ravi Kumar');
    expect(allText(load!).join(' ')).toContain('3');
  });
});

// ── the picker in isolation ──────────────────────────────────────────────

describe('TechnicianPicker (§D3)', () => {
  it('renders the shared load row per technician and unassigned last, under any roster order', async () => {
    const choice: AssignmentChoice = { kind: 'tech', id: T_ZARA };
    const renderer = await create(
      <TechnicianPicker
        technicians={ROSTER}
        choice={choice}
        disabled={false}
        onChoose={() => {}}
      />,
    );

    // Load ascending: Zara (1) first, Amit (6) last before unassigned.
    expect(pickerOrder(renderer)).toEqual([
      `dispatch-assign-${T_ZARA}`,
      `dispatch-assign-${T_RAVI}`,
      `dispatch-assign-${T_VIKRAM}`,
      `dispatch-assign-${T_AMIT}`,
      'dispatch-assign-unassigned',
    ]);

    // The chosen row answers selected — and only that row.
    expect(isSelected(findID(renderer, `dispatch-assign-${T_ZARA}`))).toBe(true);
    expect(isSelected(findID(renderer, `dispatch-assign-${T_AMIT}`))).toBe(false);
  });
});

// ── label helpers ────────────────────────────────────────────────────────

describe('unitLabelOf', () => {
  it('prefers the catalogue name, falls back to the free text, then Unit \u2014 the serial always names it', () => {
    expect(unitLabelOf({ productName: 'UPS 850VA', freeTextName: null, serialNumber: 'LM8842219' })).toBe(
      'UPS 850VA · SN LM8842219',
    );
    expect(unitLabelOf({ productName: null, freeTextName: 'Old Exide', serialNumber: 'BT2200144' })).toBe(
      'Old Exide · SN BT2200144',
    );
    expect(unitLabelOf({ productName: null, freeTextName: null, serialNumber: 'X1' })).toBe('Unit · SN X1');
  });
});
