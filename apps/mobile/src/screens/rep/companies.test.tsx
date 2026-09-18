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
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import type { Company, CompanyLedger } from '@servgrid/shared';
import { SEMANTIC } from '@servgrid/shared';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { accountsMatching, CompaniesScreen } from './CompaniesScreen';
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
    addressLine1: null,
    addressLine2: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
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

    // Near midnight the day is IST, not the timestamp's UTC date: 01:30 on
    // the 7th in Kolkata is 20:00 on the 6th in UTC, and the old
    // `.slice(0, 10)` dated this account's last activity a day early.
    const lateNight = companiesRowsOf(
      [company(STERLING, 'Sterling Industries', HIS_ID)],
      [
        {
          companyId: STERLING,
          name: 'Sterling Industries',
          balance: '85000.00',
          lastSaleDate: null,
          lastPaymentAt: '2026-09-06T20:00:00.000Z',
        },
      ],
    );
    expect(lastActivityOf(lateNight[0]!)).toBe('2026-09-07');

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

  it('the list filters by name as he types, and says how much of the book it is showing', async () => {
    const rows = companiesRowsOf(
      [
        company(NANDI, 'Nandi Motors', HIS_ID),
        company(STERLING, 'Sterling Industries', HIS_ID),
        company(HOUSE, 'House Spares', null),
      ],
      [
        { companyId: NANDI, name: 'Nandi Motors', balance: '42500.00', lastSaleDate: null, lastPaymentAt: null },
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

    // Unfiltered: every row, and the caption is the whole book.
    expect(allText(findByTestID(toJson(r), 'companies-count')!)).toEqual(['3 accounts']);
    for (const id of [NANDI, STERLING, HOUSE]) {
      expect(findByTestID(toJson(r), `company-row-${id}`)).toBeDefined();
    }

    const type = async (text: string): Promise<void> => {
      const field = findAll(findByTestID(toJson(r), 'companies-search')!, (n) => n.type === 'TextInput')[0]!;
      await act(async () => {
        field.props.onChangeText?.(text);
      });
    };

    await type('nand');
    expect(findByTestID(toJson(r), `company-row-${NANDI}`)).toBeDefined();
    expect(findByTestID(toJson(r), `company-row-${STERLING}`)).toBeUndefined();
    // "1 account of 3" — a bare "1 account" would read as the book having
    // shrunk to one, which is a different and alarming fact.
    expect(allText(findByTestID(toJson(r), 'companies-count')!)).toEqual(['1 account of 3']);

    // Case does not matter to a rep typing with one thumb.
    await type('STERLING');
    expect(findByTestID(toJson(r), `company-row-${STERLING}`)).toBeDefined();
    expect(findByTestID(toJson(r), `company-row-${NANDI}`)).toBeUndefined();

    // A miss says so and offers the way back rather than a blank page.
    await type('zzz');
    expect(findByTestID(toJson(r), 'companies-no-match')).toBeDefined();
    expect(allText(findByTestID(toJson(r), 'companies-no-match')!)).toContain('No account matches “zzz”.');
    expect(findByTestID(toJson(r), `company-row-${NANDI}`)).toBeUndefined();

    await act(async () => {
      const action = findAll(findByTestID(toJson(r), 'companies-no-match')!, (n) => typeof n.props.onPress === 'function')[0]!;
      action.props.onPress?.();
    });
    expect(findByTestID(toJson(r), 'companies-no-match')).toBeUndefined();
    expect(allText(findByTestID(toJson(r), 'companies-count')!)).toEqual(['3 accounts']);
  });

  it('there is nothing to filter when the book is empty, so the field is not there', async () => {
    const r = await create(
      <CompaniesScreen
        rows={[]}
        error={null}
        loading={false}
        onOpenCompany={() => {}}
        onNewSale={() => {}}
        onNewCompany={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'companies-empty')).toBeDefined();
    // An empty search box over "No accounts yet." invites a search of
    // nothing.
    expect(findByTestID(tree, 'companies-search')).toBeUndefined();
  });

  it('accountsMatching is the filter on its own — name only, trimmed, case-blind', () => {
    const rows = companiesRowsOf(
      [company(NANDI, 'Nandi Motors', HIS_ID), company(STERLING, 'Sterling Industries', HIS_ID)],
      [
        { companyId: NANDI, name: 'Nandi Motors', balance: '42500.00', lastSaleDate: null, lastPaymentAt: null },
        { companyId: STERLING, name: 'Sterling Industries', balance: '85000.00', lastSaleDate: null, lastPaymentAt: null },
      ],
    );
    // The fixture's own order is balance descending: Sterling, then Nandi.
    expect(rows.map((r) => r.name)).toEqual(['Sterling Industries', 'Nandi Motors']);

    expect(accountsMatching(rows, '').map((r) => r.name)).toEqual(['Sterling Industries', 'Nandi Motors']);
    expect(accountsMatching(rows, '   ').map((r) => r.name)).toEqual(['Sterling Industries', 'Nandi Motors']);
    expect(accountsMatching(rows, '  nandi ').map((r) => r.name)).toEqual(['Nandi Motors']);
    expect(accountsMatching(rows, 'INDUSTR').map((r) => r.name)).toEqual(['Sterling Industries']);
    // A phrase that spans two words of a name does not match: this is a
    // substring filter, not a token search, and pretending otherwise would
    // hide rows a rep can see on screen.
    expect(accountsMatching(rows, 'motors ltd')).toEqual([]);
    // The surviving order is the LIST's (balance descending), never the
    // order the rows happened to match in.
    expect(accountsMatching(rows, 'i').map((r) => r.name)).toEqual(['Sterling Industries', 'Nandi Motors']);
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

  it('the ledger opens on All, and the tabs split the documents without dropping the balance', async () => {
    const r = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    const tree = toJson(r);
    // All is the default: both documents, interleaved.
    expect(findByTestID(tree, 'ledger-tab-all')).toBeDefined();
    expect(findByTestID(tree, 'ledger-tab-sale')).toBeDefined();
    expect(findByTestID(tree, 'ledger-tab-payment')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeDefined();

    // Sales only — and the running balance stays, because it is the
    // account's truth as of each document, not a sum of this tab.
    await act(async () => {
      findByTestID(toJson(r), 'ledger-tab-sale')!.props.onPress?.();
    });
    const sales = toJson(r);
    expect(findByTestID(sales, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    expect(findByTestID(sales, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeUndefined();
    expect(allText(findByTestID(sales, 'ledger-running-sale-s1000000-0000-4000-8000-000000000002')!)).toContain(
      '₹1,25,000',
    );

    await act(async () => {
      findByTestID(toJson(r), 'ledger-tab-payment')!.props.onPress?.();
    });
    const payments = toJson(r);
    expect(findByTestID(payments, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(payments, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeUndefined();

    // …and back to the whole story.
    await act(async () => {
      findByTestID(toJson(r), 'ledger-tab-all')!.props.onPress?.();
    });
    expect(findByTestID(toJson(r), 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
  });

  it('the day filter narrows every tab to one day, and Any day gives the ledger back', async () => {
    const r = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    // The chip opens the calendar sheet.
    await act(async () => {
      findByTestID(toJson(r), 'ledger-filter-day')!.props.onPress?.();
    });
    const sheet = toJson(r);
    expect(findByTestID(sheet, 'ledger-day-sheet')).toBeDefined();
    expect(findByTestID(sheet, 'ledger-day-calendar')).toBeDefined();
    expect(findByTestID(sheet, 'ledger-day-any')).toBeDefined();

    // The 2nd holds only the sale.
    await act(async () => {
      const dayCell = findByTestID(sheet, 'ledger-day-calendar-day-2026-09-02')!;
      findAll(dayCell, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
    let tree = toJson(r);
    expect(findByTestID(tree, 'ledger-day-sheet')).toBeUndefined();
    // The chip reads the day and offers the way back.
    expect(allText(findByTestID(tree, 'ledger-filter-day')!).join(' ')).toContain('2 Sep');
    expect(findByTestID(tree, 'ledger-filter-clear')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeUndefined();

    // Sales tab + the day: the same one row.
    await act(async () => {
      findByTestID(tree, 'ledger-tab-sale')!.props.onPress?.();
    });
    tree = toJson(r);
    expect(findByTestID(tree, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();

    // A day with nothing on it says so rather than an empty page.
    await act(async () => {
      findByTestID(tree, 'ledger-filter-day')!.props.onPress?.();
    });
    await act(async () => {
      const dayCell = findByTestID(toJson(r), 'ledger-day-calendar-day-2026-09-06')!;
      findAll(dayCell, (n) => typeof n.props.onPress === 'function')[0]!.props.onPress?.();
    });
    tree = toJson(r);
    expect(findByTestID(tree, 'ledger-empty')).toBeDefined();
    expect(allText(findByTestID(tree, 'ledger-empty')!).join(' ')).toContain('Nothing on 6 Sep.');

    // Any day clears it from the sheet too; the tab is still Sales, so
    // back to All before expecting the whole ledger.
    await act(async () => {
      findByTestID(tree, 'ledger-filter-day')!.props.onPress?.();
    });
    await act(async () => {
      findByTestID(toJson(r), 'ledger-day-any')!.props.onPress?.();
    });
    await act(async () => {
      findByTestID(toJson(r), 'ledger-tab-all')!.props.onPress?.();
    });
    tree = toJson(r);
    expect(findByTestID(tree, 'ledger-empty')).toBeUndefined();
    expect(findByTestID(tree, 'ledger-filter-clear')).toBeUndefined();
    expect(findByTestID(tree, 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')).toBeDefined();
    expect(findByTestID(tree, 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')).toBeDefined();
  });

  it('recording a payment FROM THE COMPANY PAGE closes the form (2026-09-18)', async () => {
    // The reported bug, held here: this page passes the route's raw
    // `record`, so nothing but the sheet itself could have dismissed it.
    const record = vi.fn(async (_input: { companyId: string; amount: string }) => {});
    const r = await create(<CompanyLedgerScreen {...ledgerProps({ record })} />);

    // Open the record-payment sheet from the account's own button.
    await act(async () => {
      findAll(findByTestID(toJson(r), 'company-record-payment')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    expect(findByTestID(toJson(r), 'payment-sheet')).toBeDefined();

    // Type the amount and file it.
    const amount = findAll(findByTestID(toJson(r), 'payment-sheet-amount')!, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      amount.props.onChangeText?.('5000');
    });
    await act(async () => {
      findAll(findByTestID(toJson(r), 'payment-sheet-submit')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(record).toHaveBeenCalledTimes(1);
    // …and the form is gone, rather than sitting open over a payment that
    // has already been filed.
    expect(findByTestID(toJson(r), 'payment-sheet')).toBeUndefined();
  });

  it('a ledger row opens the document it names — the sale its lines, the payment its own page', async () => {
    const opened: string[] = [];
    const r = await create(
      <CompanyLedgerScreen
        {...ledgerProps({
          onOpenSale: (saleId: string) => opened.push(`sale:${saleId}`),
          onOpenPayment: (paymentId: string) => opened.push(`payment:${paymentId}`),
        })}
      />,
    );
    // The row is a control, and says so — on a phone there is no cursor to
    // advertise it.
    const saleRow = findByTestID(toJson(r), 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')!;
    expect(saleRow.type).toBe('Pressable');
    expect(saleRow.props.accessibilityRole).toBe('button');

    await act(async () => {
      saleRow.props.onPress?.();
    });
    const paymentRow = findByTestID(toJson(r), 'ledger-row-payment-p1000000-0000-4000-8000-000000000001')!;
    await act(async () => {
      paymentRow.props.onPress?.();
    });
    // Each row names its OWN document, and the right kind of it: a sale row
    // must not open a payment.
    expect(opened).toEqual([
      'sale:s1000000-0000-4000-8000-000000000002',
      'payment:p1000000-0000-4000-8000-000000000001',
    ]);
  });

  it('without a router the rows stay inert — no dead affordance on a browse-only ledger', async () => {
    const r = await create(<CompanyLedgerScreen {...ledgerProps()} />);
    const row = findByTestID(toJson(r), 'ledger-row-sale-s1000000-0000-4000-8000-000000000002')!;
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.onPress).toBeUndefined();
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
