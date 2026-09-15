/**
 * Permission matrix tests (T0.5) — "the highest-value tests in the
 * codebase" (PLAN-BACKEND.md §5).
 *
 * Table-driven over every `role × resource × action` cell. EXPECTED
 * enumerates all 4 × 16 × 4 = 256 cells with an explicit expected Scope;
 * a missing cell fails (`undefined !== '…'`), so an added resource that is
 * not consciously scoped breaks this suite instead of defaulting to
 * anything. The task brief's arithmetic ("4 × 17 × 4 = 272") counted 17
 * resources; PLAN-BACKEND.md §5 — the named source of the Resource union —
 * defines 16, and no seventeenth appears anywhere in docs/. The count
 * corrected in the phase doc; the exhaustive-cell approach is exactly as
 * specified.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACTIONS, permit, RESOURCES, ROLES, type Action, type Resource, type Role, type Scope } from './permissions.ts';

const row = (
  read: Scope,
  create: Scope,
  update: Scope,
  del: Scope,
): Record<Action, Scope> => ({ read, create, update, delete: del });

/**
 * One entry per resource; every role × action cell inside is explicit —
 * per-action cells, not a flat per-role scope, because two doc rules need
 * the asymmetry (owner reads all cash rows yet never declares; a
 * dispatcher reads customers but cannot create one). Transcribed
 * cell-for-cell from PLAN.md §5 (matrix) with the scope refinements from
 * PLAN-BACKEND.md §5 and PLAN-GAPS.md G1/G3 — see the table in
 * permissions.ts.
 */
const EXPECTED: Readonly<Record<Resource, Readonly<Record<Role, Record<Action, Scope>>>>> = {
  job: {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('all', 'all', 'all', 'all'), // all jobs CRUD + assign
    technician: row('own', 'own', 'own', 'own'), // own jobs: read, status, complete, cancel
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  'job.money': {
    // owner: full, amends with a reason. dispatcher: none — the revenue guarantee.
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('none', 'none', 'none', 'none'),
    // write-once at completion: create own, every other action none (MoneyGate).
    technician: row('none', 'own', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  'job.assign': {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('all', 'all', 'all', 'all'), // CRUD + assign
    technician: row('none', 'none', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  customer: {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('all', 'all', 'all', 'none'), // create, read, update — no delete
    technician: row('assigned', 'none', 'none', 'none'), // read (assigned only)
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  'customer.stack': {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('none', 'none', 'none', 'none'),
    technician: row('none', 'none', 'assigned', 'assigned'), // update: add/patch/soft-delete, assigned scope
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  company: {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('none', 'none', 'none', 'none'), // no company permission at all
    // own accounts + house accounts: owner_rep_id = actor OR owner_rep_id IS NULL (G3).
    sales_rep: row('own', 'own', 'own', 'none'),
    technician: row('none', 'none', 'none', 'none'),
  },
  contract: {
    owner: row('all', 'all', 'all', 'all'),
    // records, edits, renews and cancels AMCs — the desk's own surface now
    // (decision 1 and 11, 2026-09-15).
    dispatcher: row('all', 'all', 'all', 'all'),
    // the AMC behind his job; read only — the job itself carries the link.
    technician: row('assigned', 'none', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'), // reps have no part in AMCs (decision 10)
  },
  'contract.money': {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('all', 'all', 'all', 'all'), // the price is his by decision (2026-09-15)
    technician: row('none', 'none', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  sale: {
    owner: row('all', 'all', 'all', 'all'), // full, incl. void
    dispatcher: row('none', 'none', 'none', 'none'),
    sales_rep: row('own', 'own', 'own', 'none'), // own sales; owner voids
    technician: row('none', 'none', 'none', 'none'),
  },
  payment: {
    owner: row('all', 'all', 'all', 'all'), // full, incl. void
    dispatcher: row('none', 'none', 'none', 'none'),
    sales_rep: row('own', 'own', 'own', 'none'), // own payments; owner voids
    technician: row('none', 'none', 'none', 'none'),
  },
  'cash.declare': {
    // declares own (technician and rep); owner reads the queue and confirms —
    // he does not declare, so his create/update/delete cells are none.
    owner: row('all', 'none', 'none', 'none'),
    dispatcher: row('none', 'none', 'none', 'none'),
    technician: row('own', 'own', 'own', 'none'),
    sales_rep: row('own', 'own', 'own', 'none'),
  },
  'cash.confirm': {
    owner: row('all', 'all', 'all', 'all'), // confirms all, reopens
    dispatcher: row('none', 'none', 'none', 'none'),
    technician: row('none', 'none', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  employee: {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('own', 'none', 'own', 'none'), // self
    technician: row('own', 'none', 'own', 'none'), // self
    sales_rep: row('own', 'none', 'own', 'none'), // self
  },
  'location.read': {
    owner: row('all', 'all', 'all', 'all'), // reads all — coordinates, trails, the console
    dispatcher: row('none', 'none', 'none', 'none'), // never a position
    technician: row('none', 'none', 'none', 'none'),
    sales_rep: row('none', 'none', 'none', 'none'),
  },
  'location.health': {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('all', 'none', 'none', 'none'), // health only — no position in it
    technician: row('own', 'none', 'none', 'none'), // his own chip
    sales_rep: row('own', 'none', 'none', 'none'),
  },
  'location.send': {
    owner: row('all', 'all', 'all', 'all'),
    dispatcher: row('none', 'none', 'none', 'none'),
    technician: row('own', 'own', 'none', 'none'), // sends
    sales_rep: row('own', 'own', 'none', 'none'), // sends
  },
};

describe('permission matrix — exhaustive role × resource × action', () => {
  const cells = ROLES.flatMap((role) => RESOURCES.flatMap((resource) => ACTIONS.map((action) => ({ role, resource, action }))));

  it('enumerates exactly 4 roles × 16 resources × 4 actions = 256 combinations', () => {
    assert.equal(ROLES.length, 4);
    assert.equal(RESOURCES.length, 16);
    assert.equal(ACTIONS.length, 4);
    assert.equal(cells.length, 256);
  });

  it('every combination has an explicit expected scope — a missing cell must fail, not default', () => {
    for (const { role, resource, action } of cells) {
      const expected = EXPECTED[resource]?.[role]?.[action];
      assert.notEqual(
        expected,
        undefined,
        `matrix expectation missing for ${role} × ${resource} × ${action} — add it explicitly, do not default`,
      );
    }
  });

  it('permit() matches the expected scope for all 256 combinations', () => {
    const mismatches: string[] = [];
    for (const { role, resource, action } of cells) {
      const actual = permit(role, resource, action);
      const expected = EXPECTED[resource]![role]![action]!;
      if (actual !== expected) mismatches.push(`${role} × ${resource} × ${action}: expected ${expected}, got ${actual}`);
    }
    assert.deepEqual(mismatches, []);
  });

  it('fails loudly if a resource is added without a conscious 4×4 scoping', () => {
    assert.equal(Object.keys(EXPECTED).length, RESOURCES.length);
    for (const resource of RESOURCES) {
      for (const role of ROLES) {
        assert.equal(Object.keys(EXPECTED[resource]![role]!).length, ACTIONS.length);
      }
    }
  });
});

describe('matrix cases the task brief names', () => {
  it('dispatcher job.money is none for every action', () => {
    for (const action of ACTIONS) {
      assert.equal(permit('dispatcher', 'job.money', action), 'none');
    }
  });

  it('technician job.money: read none, create own — the case that trips MoneyGate', () => {
    // A MoneyGate that assumes `read` would hide the amount field on the
    // complete sheet, from the one person who has to fill it in
    // (UI/plan-2/03-COMPONENTS.md).
    assert.equal(permit('technician', 'job.money', 'read'), 'none');
    assert.equal(permit('technician', 'job.money', 'create'), 'own');
    assert.equal(permit('technician', 'job.money', 'update'), 'none');
    assert.equal(permit('technician', 'job.money', 'delete'), 'none');
  });

  it('sales_rep company read is own — resolved as owner_rep_id = actor OR owner_rep_id IS NULL', () => {
    assert.equal(permit('sales_rep', 'company', 'read'), 'own');
  });

  it('job revenue stays hidden from the dispatcher; the AMC price is his (decision 2026-09-15)', () => {
    assert.equal(permit('dispatcher', 'job.money', 'read'), 'none');
    assert.equal(permit('dispatcher', 'contract.money', 'read'), 'all');
    assert.equal(permit('technician', 'contract.money', 'read'), 'none');
    assert.equal(permit('sales_rep', 'contract', 'read'), 'none');
  });

  it('both location splits stay split — dispatcher gets health, never position', () => {
    assert.equal(permit('dispatcher', 'location.health', 'read'), 'all');
    assert.equal(permit('dispatcher', 'location.read', 'read'), 'none');
  });
});
