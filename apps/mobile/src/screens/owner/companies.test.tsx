/**
 * O5 Companies tests (UI/plan-2/07-OWNER.md §O5). The ones the spec
 * names:
 *
 * - **The reassignment control exists on the owner's company screen and
 *   NOWHERE ELSE** — asserted on the rendered owner screens and by
 *   grepping the rep's screen tree: a rep holds `update: own` on
 *   company, and the owner endpoint is exactly the surface his own-scope
 *   must not reach, so his screens must not even draw the control.
 * - Reassigning to *Nobody* makes it a house account — how leave gets
 *   covered.
 * - The owner rep column names the rep; house accounts read as house
 *   accounts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { act } from 'react';

import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { OwnerCompaniesScreen } from './CompaniesScreen';
import { OwnerCompanyDetailScreen } from './CompanyDetailScreen';
import type { OwnerCompanyRow } from './model';

const OWNER_DIR = dirname(fileURLToPath(new URL(import.meta.url).href as unknown as string));
const REP_DIR = join(OWNER_DIR, '..', 'rep');

const REPS = [
  { id: 'e1000000-0000-4000-8000-000000000001', name: 'Ravi Kumar', username: 'ravi.k' },
  { id: 'e1000000-0000-4000-8000-000000000002', name: 'Suresh Naik', username: 'suresh.n' },
];

function companyRow(overrides: Partial<OwnerCompanyRow>): OwnerCompanyRow {
  return {
    companyId: 'c1000000-0000-4000-8000-000000000001',
    name: 'Sterling Industries',
    balance: '42000',
    ownerRepId: REPS[0]!.id,
    ownerRepName: REPS[0]!.name,
    shared: false,
    ...overrides,
  };
}

const base = {
  onOpenCompany: () => {},
  error: null,
  loading: false,
  reps: REPS,
  onReassign: () => {},
  reassignBusy: false,
  reassignError: null,
  onRetry: () => {},
};

describe('OwnerCompaniesScreen — the reassignment control (§O5)', () => {
  it('every row carries Reassign — the control that exists nowhere else', async () => {
    const r = await create(
      <OwnerCompaniesScreen
        rows={[
          companyRow({}),
          companyRow({ companyId: 'c1000000-0000-4000-8000-000000000002', name: 'Nova Power', ownerRepId: REPS[1]!.id, ownerRepName: REPS[1]!.name }),
        ]}
        {...base}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'company-reassign-c1000000-0000-4000-8000-000000000001')).toBeDefined();
    expect(findByTestID(tree, 'company-reassign-c1000000-0000-4000-8000-000000000002')).toBeDefined();
  });

  it('the owner rep column names the rep; a house account reads as a house account', async () => {
    const r = await create(
      <OwnerCompaniesScreen
        rows={[
          companyRow({}),
          companyRow({ companyId: 'c1000000-0000-4000-8000-000000000003', name: 'House Supply Co', ownerRepId: null, ownerRepName: null, shared: true }),
        ]}
        {...base}
      />,
    );
    const tree = toJson(r);
    expect(allText(findByTestID(tree, 'company-rep-c1000000-0000-4000-8000-000000000001')!)).toContain('Ravi Kumar');
    expect(allText(findByTestID(tree, 'company-rep-c1000000-0000-4000-8000-000000000003')!)).toContain('House account');
  });

  it('reassigning to Nobody confirms with ownerRepId null — the leave cover', async () => {
    const onReassign = () => {};
    const r = await create(<OwnerCompaniesScreen rows={[companyRow({})]} {...base} onReassign={onReassign} />);
    let tree = toJson(r);
    // Open the sheet, choose Nobody (the house option).
    await act(async () => {
      findAll(findByTestID(tree, 'company-reassign-c1000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    tree = toJson(r);
    expect(findByTestID(tree, 'reassign-option-house')).toBeDefined();
    await act(async () => {
      findAll(findByTestID(tree, 'reassign-option-house')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    // The confirm button enables and would carry null.
    tree = toJson(r);
    const confirm = findAll(findByTestID(tree, 'reassign-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('the control is absent while the sheet holds no choice — disabled with the why', async () => {
    const r = await create(<OwnerCompaniesScreen rows={[companyRow({})]} {...base} />);
    await act(async () => {
      findAll(findByTestID(toJson(r), 'company-reassign-c1000000-0000-4000-8000-000000000001')!, (n) => n.type === 'Pressable')[0]!.props.onPress?.();
    });
    const confirm = findAll(findByTestID(toJson(r), 'reassign-confirm')!, (n) => n.type === 'Pressable')[0]!;
    expect(confirm.props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('OwnerCompanyDetailScreen — the control lives here too, and only here', () => {
  it('the detail header carries Reassign and names the owner rep', async () => {
    const r = await create(
      <OwnerCompanyDetailScreen
        companyId="c1000000-0000-4000-8000-000000000001"
        companyName="Sterling Industries"
        contactPerson={null}
        phone={null}
        gstin={null}
        ownerRepName="Ravi Kumar"
        shared={false}
        ledger={null}
        error={null}
        loading={false}
        reps={REPS}
        onReassign={() => {}}
        reassignBusy={false}
        reassignError={null}
        onNewSale={() => {}}
        onRecordPayment={() => {}}
        onRetry={() => {}}
      />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'company-reassign')).toBeDefined();
    expect(allText(findByTestID(tree, 'company-owner-rep')!)).toContain('Ravi Kumar');
  });
});

describe('The reassignment control exists NOWHERE ELSE — the rep screen tree grep', () => {
  /** Code lines only — block comments and line comments stripped, so a
   * spec sentence in a header comment ("no reassign-owner control
   * exists here") cannot satisfy or trip the grep. The match is the
   * control's own vocabulary: the button label and the endpoint. */
  function codeLinesOf(src: string): string[] {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'));
  }

  it('no rep screen source draws the control or targets the owner endpoint', () => {
    const files = readdirSync(REP_DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const code = codeLinesOf(readFileSync(join(REP_DIR, f), 'utf8'));
      const drawsControl = code.some((line) => /Reassign/.test(line));
      const targetsOwnerEndpoint = code.some((line) => /companies\/.*\/owner/.test(line));
      if (drawsControl || targetsOwnerEndpoint) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('the owner screen tree DOES carry it (the control has a home)', () => {
    const src = readFileSync(join(OWNER_DIR, 'CompaniesScreen.tsx'), 'utf8');
    expect(src).toContain('Reassign');
    const detail = readFileSync(join(OWNER_DIR, 'CompanyDetailScreen.tsx'), 'utf8');
    expect(detail).toContain('Reassign');
  });
});
