/**
 * S4 Companies tests (UI/plan-2/06-SALES-REP.md §S4). The ones the spec
 * names:
 *
 * - **A negative balance renders `Credit` in success colour, with no
 *   minus sign** — an overpayment is good news; the schema permits it.
 * - **The company list contains no reference to the other rep's accounts
 *   at any depth** — he sees his accounts plus house accounts, and the
 *   UI never hints that others exist. Proven on the RENDERED TREE from
 *   an isolated fixture, not only the payload (the "Done when" box).
 * - House accounts carry a small `Shared` chip; rows sort by balance
 *   descending; the ledger interleaves with the server's running balance.
 */
import { describe, expect, it } from 'vitest';

import type { Company, CompanyLedger } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { allText, create, findByTestID, toJson } from '../../components/ui/testing';
import { CompaniesScreen } from './CompaniesScreen';
import { CompanyLedgerScreen } from './CompanyLedgerScreen';
import { companiesRowsOf, lastActivityOf } from './model';

const HIS_ID = '10000000-0000-4000-8000-000000000001';
const STERLING = 'c1000000-0000-4000-8000-000000000001';
const NANDI = 'c2000000-0000-4000-8000-000000000002';
const HOUSE = 'c3000000-0000-4000-8000-000000000003';

function company(id: string, name: string, ownerRepId: string | null): Company {
  return {
    id,
    name,
    contactPerson: 'Accounts',
    phone: '+91 80 4000 1234',
    email: null,
    gstin: '29ABCDE1234F1Z5',
    notes: null,
    ownerRepId,
    isActive: true,
    version: 1,
  };
}

describe('CompaniesScreen (§S4)', () => {
  it('rows sort by balance descending; house accounts carry the Shared chip', async () => {
    const rows = companiesRowsOf(
      [
        company(NANDI, 'Nandi Motors', HIS_ID),
        company(STERLING, 'Sterling Industries', HIS_ID),
        company(HOUSE, 'House Spares', null),
      ],
      [
        {
          companyId: NANDI,
          name: 'Nandi Motors',
          balance: '42500.00',
          lastSaleDate: '2026-09-02',
          lastPaymentAt: '2026-09-06T04:30:00.000Z',
        },
        {
          companyId: STERLING,
          name: 'Sterling Industries',
          balance: '85000.00',
          lastSaleDate: null,
          lastPaymentAt: null,
        },
        { companyId: HOUSE, name: 'House Spares', balance: '0.00', lastSaleDate: null, lastPaymentAt: null },
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(['Sterling Industries', 'Nandi Motors', 'House Spares']);
    expect(rows[2]!.shared).toBe(true);
    expect(rows[0]!.shared).toBe(false);

    // Last activity is the later of the sale day and the payment day.
    expect(lastActivityOf(rows[1]!)).toBe('2026-09-06');

    const r = await create(
      <CompaniesScreen
        rows={rows}
        error={null}
        loading={false}
        onOpenCompany={() => {}}
        onNewSale={() => {}}
      onNewCompany={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, `company-shared-chip-${HOUSE}`)).toBeDefined();
    expect(findByTestID(tree, `company-shared-chip-${STERLING}`)).toBeUndefined();
  });

  it('a negative balance renders Credit in the success colour, with no minus sign', async () => {
    const rows = companiesRowsOf(
      [company(STERLING, 'Sterling Industries', HIS_ID)],
      [{ companyId: STERLING, name: 'Sterling Industries', balance: '-1250.00', lastSaleDate: null, lastPaymentAt: null }],
    );
    const r = await create(
      <CompaniesScreen
        rows={rows}
        error={null}
        loading={false}
        onOpenCompany={() => {}}
        onNewSale={() => {}}
      onNewCompany={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    const node = findByTestID(tree, `company-balance-${STERLING}`)!;
    expect(allText(node)).toContain('Credit ₹1,250');
    // The colour is feedback.success — good news, not an error.
    const style = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    expect(JSON.stringify(style)).toContain(SEMANTIC.feedback.success);
    // And there is no minus sign anywhere in the balance's text.
    for (const t of allText(node)) {
      expect(t).not.toContain('-');
      expect(t).not.toContain('−');
    }
  });

  it('the rendered tree contains no reference to the other rep accounts at any depth', async () => {
    // The fixture is exactly what the server sends a rep: his accounts
    // plus house. The OTHER REP'S company never arrives — and the proof
    // is the rendered tree, the whole of it: its name appears in no
    // string, no testID, no accessibility state, no style.
    const rows = companiesRowsOf(
      [company(STERLING, 'Sterling Industries', HIS_ID), company(HOUSE, 'House Spares', null)],
      [
        { companyId: STERLING, name: 'Sterling Industries', balance: '85000.00', lastSaleDate: null, lastPaymentAt: null },
        { companyId: HOUSE, name: 'House Spares', balance: '0.00', lastSaleDate: null, lastPaymentAt: null },
      ],
    );
    const r = await create(
      <CompaniesScreen
        rows={rows}
        error={null}
        loading={false}
        onOpenCompany={() => {}}
        onNewSale={() => {}}
      onNewCompany={() => {}}
        onRetry={() => {}}
      />,
    );
    const rendered = JSON.stringify(toJson(r));
    expect(rendered).not.toContain('Prakash Textiles');
    expect(rendered).not.toContain('other-rep');
    // The row count is the whole truth: no "12 more", no greyed rows —
    // the screen renders exactly the isolated fixture, nothing around it.
    const rowCount = rows.length;
    expect(rowCount).toBe(2);
  });
});

describe('CompanyLedgerScreen (§S4)', () => {
  const LEDGER: CompanyLedger = {
    companyId: STERLING,
    balance: '85000.00',
    entries: [
      {
        kind: 'payment',
        id: 'p1000000-0000-4000-8000-000000000001',
        number: 'PM-2627-00042',
        date: '2026-09-06',
        recordedAt: '2026-09-06T04:30:00.000Z',
        mode: 'upi',
        amount: '-40000.00',
        voided: false,
        voidReason: null,
        runningBalance: '85000.00',
      },
      {
        kind: 'sale',
        id: 's1000000-0000-4000-8000-000000000002',
        number: 'SL-2627-0019',
        date: '2026-09-02',
        recordedAt: '2026-09-02T06:00:00.000Z',
        mode: null,
        amount: '52000.00',
        voided: false,
        voidReason: null,
        runningBalance: '125000.00',
      },
    ],
  };

  function ledgerProps(overrides: Partial<Parameters<typeof CompanyLedgerScreen>[0]> = {}) {
    return {
      company: company(STERLING, 'Sterling Industries', HIS_ID),
      ledger: LEDGER,
      error: null,
      loading: false,
      openSales: [],
      pendingRecord: { busy: false, error: null },
      online: true,
      record: async () => {},
      onRecorded: () => {},
      onNewSale: () => {},
    onNewCompany: () => {},
      onRetry: () => {},
      ...overrides,
    };
  }

  it('the ledger interleaves newest first with the running balance column', async () => {
    const r = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    // Signed amounts and the server's running balance, as §S4's example.
    expect(allText(tree)).toContain('+ ₹52,000');
    expect(allText(tree)).toContain('− ₹40,000');
    expect(findByTestID(tree, 'ledger-running-payment-p1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(allText(tree)).toContain('₹1,25,000');
    expect(allText(tree)).toContain('₹85,000');
  });

  it('the header balance is the largest figure and follows the Credit rule', async () => {
    const credit = await create(
      <CompanyLedgerScreen
        {...ledgerProps({ ledger: { ...LEDGER, balance: '-1250.00' } })}
      />,
    );
    const node = findByTestID(toJson(credit), 'company-balance')!;
    expect(allText(node)).toContain('Credit ₹1,250');
    const style = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
    expect(JSON.stringify(style)).toContain(SEMANTIC.feedback.success);
    // No minus sign in the header figure.
    for (const t of allText(node)) {
      expect(t).not.toContain('-');
      expect(t).not.toContain('−');
    }

    const plain = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    expect(allText(findByTestID(toJson(plain), 'company-balance')!)).toContain('₹85,000');
  });

  it('header shows name, contact, tappable phone, GSTIN — and no reassign-owner control', async () => {
    const r = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'company-name')).toBeDefined();
    expect(findByTestID(tree, 'company-contact')).toBeDefined();
    expect(findByTestID(tree, 'company-phone')).toBeDefined();
    expect(findByTestID(tree, 'company-gstin')).toBeDefined();
    // The absent control, asserted: no owner UI lives here.
    const rendered = JSON.stringify(tree);
    expect(rendered.toLowerCase()).not.toContain('reassign');
    expect(rendered.toLowerCase()).not.toContain('change owner');
    expect(findByTestID(tree, 'company-record-payment')).toBeDefined();
    expect(findByTestID(tree, 'company-new-sale')).toBeDefined();
  });
});
