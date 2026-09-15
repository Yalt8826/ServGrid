/**
 * Contract schema tests (T2B.2) — the payload rules the AMC form leans on
 * (PHASE-2B-CONTRACTS.md T2B.2): the term is ordered, an empty patch says
 * nothing and is refused, and a cancellation must say why.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contractCancelSchema, contractCreateSchema, contractPatchSchema } from './contracts.ts';

const BASE = {
  customerId: '0d7c3f52-6d4c-4f0e-9c6e-0a4f5a1b2c3d',
  startDate: '2026-09-01',
  endDate: '2027-08-31',
  contractValue: '18000.00',
};

describe('contract create schema', () => {
  it('refuses an end date before the start date', () => {
    const bad = contractCreateSchema.safeParse({ ...BASE, startDate: '2027-01-01', endDate: '2026-12-31' });
    assert.equal(bad.success, false);
  });

  it('accepts end == start — a one-day AMC is a term, not a typo', () => {
    const same = contractCreateSchema.safeParse({ ...BASE, startDate: '2027-01-01', endDate: '2027-01-01' });
    assert.equal(same.success, true);
  });

  it('refuses a negative price — moneyString stays unsigned; the DB CHECK is the backstop', () => {
    assert.equal(contractCreateSchema.safeParse({ ...BASE, contractValue: '-1.00' }).success, false);
  });
});

describe('contract patch schema', () => {
  it('refuses an empty patch — nothing to change is a refusal, not a no-op', () => {
    assert.equal(contractPatchSchema.safeParse({}).success, false);
  });

  it('refuses a patch that would invert the term', () => {
    assert.equal(
      contractPatchSchema.safeParse({ startDate: '2027-06-01', endDate: '2027-01-01' }).success,
      false,
    );
  });
});

describe('contract cancel schema', () => {
  it('refuses a blank reason', () => {
    assert.equal(contractCancelSchema.safeParse({ reason: '   ' }).success, false);
  });

  it('accepts a real reason', () => {
    assert.equal(contractCancelSchema.safeParse({ reason: 'Wrong site — recorded against the customer twice.' }).success, true);
  });
});
