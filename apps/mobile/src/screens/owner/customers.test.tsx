/**
 * O4b Dispatch and Customers tests (T4.11, UI/plan-2/07-OWNER.md §O4b,
 * docs/implementation/PHASE-4-OWNER.md T4.11). The ones the spec names:
 *
 * - **Company field present for the owner, absent for a dispatcher,
 *   from the SAME component** — the capability prop, not a role read:
 *   the dispatcher's route never passes `company`, so the field does
 *   not exist on his form; the owner's does, create and edit.
 * - **The stack is editable; a save stamps no `source_job_id`** — the
 *   payloads the save builds carry no such field, by type and at
 *   runtime; that absence is the signal the change did not come from
 *   work done (PLAN-BACKEND.md §6.4).
 * - **Desktop renders a table, phone renders cards** — verified at all
 *   four widths, the same mapping the jobs screen's test binds to
 *   NavShell's 1024 breakpoint.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import type { CustomerDetail } from '@servgrid/shared';
import { DensityProvider } from '../../components/ui/DensityProvider';
import { densityForRole } from '../../navigation/navmap';
import { allText, create, findAll, findByTestID, firstDescendantOfType, toJson } from '../../components/ui/testing';
import { CustomerFormScreen, type CustomerFormCompanyDeps, type CustomerFormDeps } from '../dispatcher/customer';
import { emptyCustomerForm } from '../dispatcher/customerForm';
import { OwnerCustomerDetailBody, type OwnerCustomerDetailDeps } from './CustomerDetailBody';
import { OwnerCustomersScreen, type OwnerCustomersDeps } from './CustomersScreen';
import type { OwnerCustomerRow } from './customersModel';

const COMPANIES = [
  { id: 'c1000000-0000-4000-8000-000000000001', name: 'Sterling Industries' },
  { id: 'c1000000-0000-4000-8000-000000000002', name: 'Nova Power' },
];

// ── the company field, from the same component ──────────────────────────────

describe('CustomerFormScreen — the company field is a capability, not a role (§O4b)', () => {
  function formDeps(company: CustomerFormCompanyDeps | null): { deps: CustomerFormDeps; saved: unknown[] } {
    const saved: unknown[] = [];
    const deps: CustomerFormDeps = {
      offline: false,
      mode: 'create',
      initial: emptyCustomerForm(),
      saving: false,
      submitError: null,
      company,
      onSave: (fields) => {
        saved.push(fields);
      },
      onCancel: () => {},
    };
    return { deps, saved };
  }

  it('the dispatcher’s form (no company capability) renders NO company field', async () => {
    const { deps } = formDeps(null);
    const r = await create(<CustomerFormScreen {...deps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'customer-field-name')).toBeDefined();
    expect(findByTestID(tree, 'customer-field-phone')).toBeDefined();
    // §D4's first absence: not on the form at all — no field, no sheet.
    expect(findByTestID(tree, 'customer-field-company')).toBeUndefined();
    expect(findByTestID(tree, 'customer-company-sheet')).toBeUndefined();
  });

  it('the owner’s form renders it on create, and the picker links the site', async () => {
    let selected: string | null | undefined;
    const { deps } = formDeps({
      companies: COMPANIES,
      selectedCompanyId: null,
      onSelectCompany: (id) => {
        selected = id;
      },
    });
    const r = await create(<CustomerFormScreen {...deps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'customer-field-company')).toBeDefined();

    // Open the picker, choose an account.
    await act(async () => {
      findAll(findByTestID(tree, 'customer-field-company')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const tree2 = toJson(r);
    expect(findByTestID(tree2, 'customer-company-sheet')).toBeDefined();
    await act(async () => {
      findByTestID(tree2, `company-option-${COMPANIES[0]!.id}`)!.props.onPress?.();
    });
    expect(selected).toBe(COMPANIES[0]!.id);

    // "No company" detaches — null is a choice, not an absence.
    const tree3 = toJson(r);
    await act(async () => {
      findAll(findByTestID(tree3, 'customer-field-company')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const tree4 = toJson(r);
    await act(async () => {
      findByTestID(tree4, 'company-option-none')!.props.onPress?.();
    });
    expect(selected).toBeNull();
  });

  it('the owner’s form renders it on EDIT too', async () => {
    const { deps } = formDeps({ companies: COMPANIES, selectedCompanyId: COMPANIES[1]!.id, onSelectCompany: () => {} });
    const editDeps: CustomerFormDeps = { ...deps, mode: 'edit', initial: null };
    const r = await create(<CustomerFormScreen {...editDeps} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'customer-field-company')).toBeDefined();
    // The trigger names the linked account.
    expect(allText(findByTestID(tree, 'customer-field-company')!).join(' ')).toContain('Nova Power');
  });
});

// ── the editable stack, stamping nothing ────────────────────────────────────

const SITE_ID = 'd1000000-0000-4000-8000-000000000001';

const SITE: CustomerDetail = {
  id: 'd1000000-0000-4000-8000-000000000001',
  name: 'Meenakshi Enterprises — Peenya',
  phone: '9847000001',
  altPhone: null,
  addressLine1: '3rd Block, Peenya',
  addressLine2: null,
  area: null,
  city: 'Bengaluru',
  state: null,
  pincode: '560058',
  latitude: null,
  longitude: null,
  notes: null,
  companyId: COMPANIES[0]!.id,
  version: 7,
  stack: [
    {
      id: 'u1000000-0000-4000-8000-000000000001',
      customerId: SITE_ID,
      productId: null,
      freeTextName: 'UPS 850VA',
      serialNumber: 'LM8842219',
      quantity: 1,
      installedOn: '2025-04-01',
      warrantyExpiresOn: null,
      notes: null,
      version: 4,
    },
  ],
};

function detailDeps(overrides?: Partial<OwnerCustomerDetailDeps>): OwnerCustomerDetailDeps {
  return {
    detail: SITE,
    loading: false,
    detailError: null,
    companyName: 'Sterling Industries',
    stack: [{ id: 'u1000000-0000-4000-8000-000000000001', label: 'UPS 850VA · SN LM8842219' }],
    history: [],
    historyError: null,
    editing: {
      id: 'u1000000-0000-4000-8000-000000000001',
      label: 'UPS 850VA · SN LM8842219',
      serialNumber: 'LM8842219',
      quantity: 1,
      warrantyExpiresOn: null,
      version: 4,
    },
    savingStack: false,
    stackError: null,
    onEditStackItemOpen: () => {},
    onCloseSheet: () => {},
    onSaveStackItem: () => {},
    onRemoveStackItem: () => {},
    onCall: () => {},
    onOpenJob: () => {},
    onOpenCompany: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

describe('OwnerCustomerDetailBody — the stack is editable, stamping nothing (§O4b)', () => {
  it('renders the EDITABLE stack and the ledger link on the company row', async () => {
    let opened = false;
    const deps = detailDeps({
      onEditStackItemOpen: () => {
        opened = true;
      },
      onOpenCompany: () => {},
    });
    const r = await create(<OwnerCustomerDetailBody {...deps} />);
    const tree = toJson(r);
    // Editable: the unit row is pressable and wired to the correction sheet.
    const unit = findByTestID(tree, 'customer-stack-item-u1000000-0000-4000-8000-000000000001')!;
    expect(unit.props.accessibilityRole).toBe('button');
    await act(async () => {
      unit.props.onPress?.();
    });
    expect(opened).toBe(true);
    // The company row links through to the ledger, named.
    expect(findByTestID(tree, 'owner-customer-company')).toBeDefined();
    expect(allText(findByTestID(tree, 'owner-customer-company')!).join(' ')).toContain('Sterling Industries');
    expect(allText(findByTestID(tree, 'owner-customer-company')!).join(' ')).toContain('Ledger');
  });

  it('a save sends exactly the §6.4 patch — no source_job_id at runtime or in the type', async () => {
    const saved: Array<{ itemId: string; version: number; patch: Record<string, unknown> }> = [];
    const deps = detailDeps({
      onSaveStackItem: (itemId, version, patch) => {
        saved.push({ itemId, version, patch: patch as Record<string, unknown> });
      },
    });
    const r = await create(<OwnerCustomerDetailBody {...deps} />);
    let tree = toJson(r);
    // The correction: the serial was typed wrong, the technician has moved on.
    const serial = firstDescendantOfType(findByTestID(tree, 'stack-field-serial')!, 'TextInput')!;
    await act(async () => {
      serial.props.onChangeText?.('LM8842220');
    });
    tree = toJson(r);
    await act(async () => {
      findAll(findByTestID(tree, 'stack-save')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    expect(saved).toHaveLength(1);
    // If-Match rides the version the read returned.
    expect(saved[0]!.version).toBe(4);
    // Exactly the changed field — and NO source key of any spelling.
    expect(saved[0]!.patch).toEqual({ serialNumber: 'LM8842220' });
    expect(Object.keys(saved[0]!.patch)).not.toContain('sourceJobId');
    expect(Object.keys(saved[0]!.patch)).not.toContain('source_job_id');
    // The type itself cannot carry one — compile-time proof via the
    // source: StackItemPatchInput names three fields, no source.
    const { readdirSync, readFileSync } = await import('node:fs');
    const here = new URL('.', import.meta.url).pathname;
    for (const f of readdirSync(here)) {
      if (f === 'CustomerDetailBody.tsx' || f === 'useOwnerCustomers.ts') {
        const code = readFileSync(`${here}${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(code).not.toMatch(/source_job_id|sourceJobId/);
      }
    }
  });
});

// ── table on the desk, cards on the phone — all four widths ────────────────

const CUSTOMER_ROW: OwnerCustomerRow = {
  id: SITE.id,
  name: 'Meenakshi Enterprises — Peenya',
  area: 'Peenya',
  address: '3rd Block, Peenya, Bengaluru 560058',
  location: '13.028700, 77.519700',
  phone: '9847000001',
  companyId: COMPANIES[0]!.id,
  companyName: 'Sterling Industries',
  units: 2,
  openJobs: 1,
  lastJob: 'JC-…0042 · 14 Sep',
};

function listDeps(rows: OwnerCustomerRow[]): OwnerCustomersDeps {
  return {
    offline: false,
    error: null,
    loading: false,
    rows,
    onRetryList: () => {},
    onOpenCustomer: () => {},
  };
}

describe('OwnerCustomersScreen — desk is a table, phone is cards, at all four widths', () => {
  const WIDTHS = [390, 800, 1024, 1440] as const;

  for (const width of WIDTHS) {
    it(`customers at ${width}px render ${width >= 1024 ? 'the table' : 'cards'}`, async () => {
      const density = densityForRole('owner', width >= 1024);
      const r = await create(
        <DensityProvider density={density}>
          <OwnerCustomersScreen {...listDeps([CUSTOMER_ROW])} />
        </DensityProvider>,
      );
      const tree = toJson(r);
      if (width >= 1024) {
        // Not cards. A table — §O4b's columns, company among them.
        expect(findByTestID(tree, 'owner-customers-table')).toBeDefined();
        expect(findByTestID(tree, 'owner-customers-list')).toBeUndefined();
        expect(findByTestID(tree, `customer-company-${SITE.id}`)).toBeDefined();
        expect(findByTestID(tree, `customer-units-${SITE.id}`)).toBeDefined();
      } else {
        expect(findByTestID(tree, 'owner-customers-list')).toBeDefined();
        expect(findByTestID(tree, 'owner-customers-table')).toBeUndefined();
        expect(findByTestID(tree, `owner-customer-card-${SITE.id}`)).toBeDefined();
        expect(allText(findByTestID(tree, `owner-customer-card-${SITE.id}`)!).join(' ')).toContain('Sterling Industries');
      }
    });
  }

  it('a row click opens the site’s own page (not a pane beside the list)', async () => {
    let opened: string | null = null;
    const deps = listDeps([CUSTOMER_ROW]);
    deps.onOpenCustomer = (id) => {
      opened = id;
    };
    const r = await create(
      <DensityProvider density="desk">
        <OwnerCustomersScreen {...deps} />
      </DensityProvider>,
    );
    const tree = toJson(r);
    await act(async () => {
      findByTestID(tree, `data-row-${SITE.id}`)!.props.onPress?.();
    });
    expect(opened).toBe(SITE.id);
  });
});

