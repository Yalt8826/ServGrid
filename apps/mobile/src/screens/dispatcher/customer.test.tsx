/**
 * D4 Customer tests (T2.10, UI/plan-2/05-DISPATCHER.md §D4) — the two
 * the spec names, plus the seams that hold them up:
 *
 * - **The stack renders with no edit affordance for a dispatcher** —
 *   technicians own the stack because they are the ones who know what
 *   got fitted (PLAN.md §4); a dispatcher editing it from a phone call
 *   is how a serial number becomes wrong. Read-only here is proven at
 *   the tree: no `Pressable`, no `onPress`, no *Edit* anywhere in the
 *   stack's subtree.
 * - **No company field in create or edit** — the dispatcher holds no
 *   company permission (PLAN.md §5); the form does not offer it, and
 *   neither the create body nor the patch body can even carry one.
 * - **The stack's capability is the prop, not a role read** — the
 *   spec's "If it fails": the component takes `editable` from the
 *   screen, so Phase 4's owner passes `true` to the same component
 *   without a second branch.
 *
 * Plus the anatomy the detail exists for: two-line search rows, phones
 * tappable to call, job history as `JobRow`s, and submit-time
 * validation on the form.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import { STATUS } from '@servgrid/shared';
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
  CUSTOMER_OFFLINE_MESSAGE,
  CustomerDetailScreen,
  CustomerFormScreen,
  CustomerSearchScreen,
  StackSection,
  type CustomerDetailDeps,
  type CustomerFormDeps,
  type CustomerHistoryJob,
  type CustomerSearchDeps,
  type CustomerStackUnit,
} from './customer';
import {
  customerCreateBody,
  customerPatchBody,
  customerFormOf,
  emptyCustomerForm,
  type CustomerFormFields,
} from './customerForm';

// ── fixtures ─────────────────────────────────────────────────────────────

const CUST_ID = '01890a5e-1000-7000-8000-00000000c001';
const UNIT_A = '01890a5e-2000-7000-8000-00000000u001';
const UNIT_B = '01890a5e-2000-7000-8000-00000000u002';
const JOB_1 = '01890a5e-3000-7000-8000-00000000j001';
const JOB_2 = '01890a5e-3000-7000-8000-00000000j002';

const PHONE = '9845012345';
const ALT_PHONE = '9845067890';

/** The dispatcher's detail shape: no `companyId` field exists on it at
 * all — the omission is type-level (§5 rule 3). */
const DETAIL = {
  id: CUST_ID,
  name: 'Sunrise Apartments',
  phone: PHONE,
  altPhone: ALT_PHONE,
  addressLine1: '12 3rd Cross, Kormangala',
  addressLine2: 'Near Jyoti Nivas',
  area: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560034',
  latitude: 12.9352,
  longitude: 77.6245,
  notes: 'Gate closes at 21:00 — ring the watchman.',
  version: 7,
  stack: [
    {
      id: UNIT_A,
      customerId: CUST_ID,
      productId: null,
      freeTextName: 'UPS 850VA',
      serialNumber: 'LM8842219',
      quantity: 1,
      installedOn: null,
      warrantyExpiresOn: null,
      notes: null,
      version: 1,
    },
  ],
};

const STACK: CustomerStackUnit[] = [
  { id: UNIT_A, label: 'UPS 850VA · SN LM8842219' },
  { id: UNIT_B, label: 'Battery 150Ah · SN BT2200144' },
];

const HISTORY: CustomerHistoryJob[] = [
  {
    id: JOB_1,
    jobNumber: 'JC-2627-00042',
    title: 'Battery swap',
    status: 'in_progress',
    scheduledFor: '2026-09-07T14:30:00+05:30',
    technicianName: 'Ravi Kumar',
  },
  {
    id: JOB_2,
    jobNumber: 'JC-2627-00017',
    title: 'Site survey',
    status: 'completed',
    scheduledFor: '2026-08-28T10:00:00+05:30',
    technicianName: null,
  },
];

const SEARCH_RESULTS = [
  { id: CUST_ID, name: 'Sunrise Apartments', phone: PHONE, addressLabel: '12 3rd Cross, Kormangala' },
  { id: '01890a5e-1000-7000-8000-00000000c002', name: 'Sunrise Bakery', phone: '9845099999', addressLabel: null },
];

function baseDetailDeps(overrides: Partial<CustomerDetailDeps> = {}): CustomerDetailDeps {
  return {
    offline: false,
    detail: DETAIL,
    stack: STACK,
    history: HISTORY,
    detailError: null,
    historyError: null,
    onCall: vi.fn(),
    onEdit: vi.fn(),
    onOpenJob: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

function baseSearchDeps(overrides: Partial<CustomerSearchDeps> = {}): CustomerSearchDeps {
  return {
    offline: false,
    query: 'sunrise',
    results: SEARCH_RESULTS,
    error: null,
    onQueryChange: vi.fn(),
    onRetry: vi.fn(),
    onOpenCustomer: vi.fn(),
    onNewCustomer: vi.fn(),
    ...overrides,
  };
}

function baseFormDeps(overrides: Partial<CustomerFormDeps> = {}): CustomerFormDeps {
  return {
    offline: false,
    mode: 'create',
    initial: null,
    saving: false,
    submitError: null,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

// ── harness helpers ──────────────────────────────────────────────────────

function findID(renderer: ReactTestRenderer, testID: string): Node | undefined {
  return findByTestID(toJson(renderer), testID);
}

function pressableOf(node: Node): Node {
  if (typeof node.props.onPress === 'function') return node;
  const inner = findAll(node, (n) => typeof n.props.onPress === 'function')[0];
  expect(inner).toBeDefined();
  return inner!;
}

async function press(renderer: ReactTestRenderer, testID: string): Promise<void> {
  const node = findID(renderer, testID);
  expect(node).toBeDefined();
  await act(async () => {
    pressableOf(node!).props.onPress?.();
    await Promise.resolve();
  });
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

// ── the tests ────────────────────────────────────────────────────────────

describe('CustomerDetailScreen (§D4)', () => {
  it('the stack renders with no edit affordance for a dispatcher', async () => {
    const renderer = await create(<CustomerDetailScreen {...baseDetailDeps()} />);

    // The stack IS rendered — read-only, not hidden. A dispatcher answering
    // "which UPS is it?" needs the stack on screen.
    const stack = findID(renderer, 'customer-stack');
    expect(stack).toBeDefined();
    const stackText = allText(stack!).join(' | ');
    expect(stackText).toContain('UPS 850VA · SN LM8842219');
    expect(stackText).toContain('Battery 150Ah · SN BT2200144');

    // …and nothing in its subtree is tappable: no Pressable, no onPress,
    // no Edit affordance of any kind.
    expect(findAll(stack!, (n) => n.type === 'Pressable')).toHaveLength(0);
    expect(findAll(stack!, (n) => typeof n.props.onPress === 'function')).toHaveLength(0);
    expect(stackText).not.toContain('Edit');

    // The section is built read-only by the screen: the capability is
    // passed down as a prop (`editable={false}`), never read from a role.
    const detailText = allText(toJson(renderer)).join(' | ');
    expect(detailText).toContain('The stack');
  });

  it('the stack capability is the prop, not a role read — editable only when passed true', async () => {
    // The same component, editable prop true (Phase 4's owner): the
    // affordance appears and names its unit.
    const onEditUnit = vi.fn();
    const editable = await create(<StackSection units={STACK} editable onEditUnit={onEditUnit} />);
    const stack = findID(editable, 'customer-stack')!;
    expect(allText(stack).join(' | ')).toContain('Edit');
    await press(editable, `customer-stack-item-${UNIT_A}`);
    expect(onEditUnit).toHaveBeenCalledWith(UNIT_A);

    // The dispatcher's screen passes false: no affordance, no handler —
    // one component, two capabilities, zero role reads in between.
    const readOnly = await create(<StackSection units={STACK} editable={false} />);
    expect(findAll(findID(readOnly, 'customer-stack')!, (n) => n.type === 'Pressable')).toHaveLength(0);
  });

  it('a site nobody has pinned yet says who fills it — the office cannot', async () => {
    const deps = baseDetailDeps();
    const renderer = await create(
      <CustomerDetailScreen {...deps} detail={{ ...deps.detail!, latitude: null, longitude: null }} />,
    );
    expect(allText(findID(renderer, 'customer-location-empty')!).join(' ')).toContain('technician');
    expect(findID(renderer, 'customer-location')).toBeUndefined();
  });

  it('a captured location reads as six decimals and opens a map', async () => {
    const onOpenMap = vi.fn();
    const deps = baseDetailDeps();
    const renderer = await create(
      <CustomerDetailScreen
        {...deps}
        onOpenMap={onOpenMap}
        detail={{ ...deps.detail!, latitude: 12.9352, longitude: 77.6245 }}
      />,
    );
    expect(allText(findID(renderer, 'customer-location')!).join(' ')).toContain('12.935200, 77.624500');
    await press(renderer, 'customer-location');
    expect(onOpenMap).toHaveBeenCalledWith(12.9352, 77.6245);
  });

  it('the detail carries name, phones tappable to call, address, area and notes', async () => {
    const deps = baseDetailDeps();
    const renderer = await create(<CustomerDetailScreen {...deps} />);
    const tree = toJson(renderer);

    expect(allText(tree).join(' | ')).toContain('Sunrise Apartments');
    expect(allText(tree).join(' | ')).toContain('12 3rd Cross, Kormangala');
    // The area line is the site's LOCALITY leading, then city and pincode
    // (2026-09-17) — it used to be "city · pincode" alone, which is what
    // the console's "area" column also showed before the column existed.
    expect(findID(renderer, 'customer-area')).toBeDefined();
    expect(allText(findID(renderer, 'customer-area')!).join(' ')).toContain('Bengaluru 560034');
    // No locality named yet is normal: the line never invents one.
    expect(allText(findID(renderer, 'customer-area')!).join(' ')).not.toContain('· ');

    // The captured location is its own block. This fixture is pinned, so
    // it reads as coordinates; the unpinned case is its own test below.
    expect(findID(renderer, 'customer-location-block')).toBeDefined();
    expect(allText(findID(renderer, 'customer-location')!).join(' ')).toContain('12.935200, 77.624500');
    expect(allText(tree).join(' | ')).toContain('Gate closes at 21:00');

    // Phones are tappable to call — both of them, the number as given.
    await press(renderer, 'customer-call-primary');
    expect(deps.onCall).toHaveBeenNthCalledWith(1, PHONE);
    await press(renderer, 'customer-call-alt');
    expect(deps.onCall).toHaveBeenNthCalledWith(2, ALT_PHONE);
  });

  it('the job history renders as JobRows — rail, two lines, status word — and rows open jobs', async () => {
    const deps = baseDetailDeps();
    const renderer = await create(<CustomerDetailScreen {...deps} />);

    const row = findID(renderer, `customer-history-${JOB_1}`);
    expect(row).toBeDefined();
    const rowText = allText(row!).join(' | ');
    expect(rowText).toContain('JC-…0042');
    expect(rowText).toContain('Battery swap');
    expect(rowText).toContain('Ravi'); // first name, as D2 reads it
    expect(rowText).toContain('14:30');
    expect(rowText).toContain('In progress');

    // The rail carries the status colour — never colour alone: the word
    // rides beside it (§1.6).
    const statusStyled = findAll(row!, (n) => JSON.stringify(n.props.style ?? '').includes(STATUS.in_progress));
    expect(statusStyled.length).toBeGreaterThan(0); // the rail, the dot
    expect(allText(row!).join(' | ')).toContain('In progress');

    // The second row's job has no technician yet: Unassigned, honestly.
    const row2 = findID(renderer, `customer-history-${JOB_2}`);
    expect(allText(row2!).join(' | ')).toContain('Unassigned');
    expect(allText(row2!).join(' | ')).toContain('Completed');

    // A row is the tap target, at 56 — it opens the job.
    await press(renderer, `customer-history-${JOB_1}`);
    expect(deps.onOpenJob).toHaveBeenCalledWith(JOB_1);
  });

  it('offline shows the danger banner; a failed detail offers Retry', async () => {
    const offline = await create(<CustomerDetailScreen {...baseDetailDeps({ offline: true })} />);
    const banner = findID(offline, 'customer-offline-banner');
    expect(banner).toBeDefined();
    expect(allText(banner!).join(' ')).toBe(CUSTOMER_OFFLINE_MESSAGE);

    const failed = await create(
      <CustomerDetailScreen
        {...baseDetailDeps({ detail: null, stack: null, detailError: 'The site could not be loaded.' })}
      />,
    );
    expect(findID(failed, 'customer-detail-error')).toBeDefined();
    expect(allText(toJson(failed), []).join(' ')).toContain('Retry');
  });
});

describe('CustomerSearchScreen (§D4)', () => {
  it('results are two-line rows — name over phone · address', async () => {
    const deps = baseSearchDeps();
    const renderer = await create(<CustomerSearchScreen {...deps} />);

    const row = findID(renderer, `customer-result-${CUST_ID}`);
    expect(row).toBeDefined();
    const rowText = allText(row!).join(' | ');
    expect(rowText).toContain('Sunrise Apartments');
    expect(rowText).toContain('9845012345');
    expect(rowText).toContain('12 3rd Cross, Kormangala');

    // The row itself is the tap target: it opens the site's detail.
    await press(renderer, `customer-result-${CUST_ID}`);
    expect(deps.onOpenCustomer).toHaveBeenCalledWith(CUST_ID);
  });

  it('no match offers create inline — the same pattern D3 uses', async () => {
    const deps = baseSearchDeps({ results: [] });
    const renderer = await create(<CustomerSearchScreen {...deps} />);
    expect(findID(renderer, 'customer-new-inline')).toBeDefined();
    await press(renderer, 'customer-new-inline');
    expect(deps.onNewCustomer).toHaveBeenCalledTimes(1);

    // No query, no answers, no offer: nothing pretends a search ran.
    const idle = await create(<CustomerSearchScreen {...baseSearchDeps({ query: '', results: null })} />);
    expect(findID(idle, 'customer-new-inline')).toBeUndefined();
  });
});

describe('CustomerFormScreen (§D4) — the two absences', () => {
  it('no company field in create or edit', async () => {
    // CREATE: the whole form is eight fields, and none of them is a company.
    const createScreen = await create(<CustomerFormScreen {...baseFormDeps({ mode: 'create' })} />);
    const createTree = toJson(createScreen);
    const createText = allText(createTree).join(' | ').toLowerCase();
    expect(createText).not.toContain('company');
    expect(JSON.stringify(createTree).toLowerCase()).not.toContain('company');
    expect(findID(createScreen, 'customer-field-name')).toBeDefined();
    expect(findID(createScreen, 'customer-field-phone')).toBeDefined();

    // EDIT: prefilled from the record, still no company field anywhere.
    const initial = customerFormOf(DETAIL);
    const editScreen = await create(<CustomerFormScreen {...baseFormDeps({ mode: 'edit', initial })} />);
    const editTree = toJson(editScreen);
    const editText = allText(editTree).join(' | ').toLowerCase();
    expect(editText).not.toContain('company');
    expect(JSON.stringify(editTree).toLowerCase()).not.toContain('company');

    // The edit form carries the record's own values, company absent from
    // the data as well as the pixels.
    const fieldIDs = findAll(editTree, (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('customer-field-')).map(
      (n) => n.props.testID as string,
    );
    expect(fieldIDs).toEqual(
      expect.arrayContaining([
        'customer-field-name',
        'customer-field-phone',
        'customer-field-alt-phone',
        'customer-field-address1',
        'customer-field-address2',
        'customer-field-city',
        'customer-field-pincode',
        'customer-field-notes',
      ]),
    );
    expect(fieldIDs.some((id) => id.includes('company'))).toBe(false);

    // And the bodies the form builds cannot carry one either — the type
    // is the first gate, the server's strip is the second.
    const fields: CustomerFormFields = { ...emptyCustomerForm(), name: 'Sunrise Apartments', phone: PHONE };
    expect(Object.keys(customerCreateBody(fields))).not.toContain('companyId');
    const patch = customerPatchBody(initial, { ...initial, notes: 'Arrive before 20:00.' });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!)).not.toContain('companyId');
  });

  it('edit prefills from the record the form opened with', async () => {
    const initial = customerFormOf(DETAIL);
    const renderer = await create(<CustomerFormScreen {...baseFormDeps({ mode: 'edit', initial })} />);

    // The record's values ride in the inputs (a TextField renders its
    // value as the input's, never as floating label text).
    const inputValueOf = (testID: string): string => {
      const field = findID(renderer, testID)!;
      const input = firstDescendantOfType(field, 'TextInput')!;
      return String(input.props.value ?? '');
    };
    expect(inputValueOf('customer-field-name')).toBe('Sunrise Apartments');
    expect(inputValueOf('customer-field-phone')).toBe(PHONE);
    expect(inputValueOf('customer-field-alt-phone')).toBe(ALT_PHONE);
    expect(inputValueOf('customer-field-city')).toBe('Bengaluru');
    expect(inputValueOf('customer-field-notes')).toContain('watchman');
  });

  it('submit-time validation: name and phone are required, then onSave carries the fields', async () => {
    const deps = baseFormDeps({ mode: 'create' });
    const renderer = await create(<CustomerFormScreen {...deps} />);

    // Empty submit is refused with sentences, not a shake (03-COMPONENTS).
    await press(renderer, 'customer-save');
    expect(deps.onSave).not.toHaveBeenCalled();
    expect(findID(renderer, 'customer-field-name-error')).toBeDefined();
    expect(findID(renderer, 'customer-field-phone-error')).toBeDefined();

    // Filled, the submit carries the whole form — validation passed.
    typeInto(renderer, 'customer-field-name', 'Sunrise Bakery');
    typeInto(renderer, 'customer-field-phone', '9845099999');
    typeInto(renderer, 'customer-field-city', 'Bengaluru');
    await press(renderer, 'customer-save');
    expect(deps.onSave).toHaveBeenCalledTimes(1);
    expect(deps.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sunrise Bakery', phone: '9845099999', city: 'Bengaluru' }),
    );
  });
});
