/**
 * The AMC model's rules (T2B.4) — the arithmetic and the copy the tab,
 * the detail and the form render, asserted pure:
 *
 * - **Plain-date arithmetic in UTC**: 31 Jan + 1 month clamps to Feb's
 *   last day (28, or 29 in a leap year); a 12-month term ending is
 *   start + 12 months − 1 day, and a leap-day start keeps its full term.
 * - **Renewal prefills** start the day after the old end with the same
 *   price — a renewal can be recorded before the old term ends because
 *   the two ranges do not overlap (decision 2026-09-15).
 * - **patchOf sends only the changed keys** — an untouched field is
 *   absent, never re-sent; blank notes go over as null (a clearing).
 * - **The sentences**: validation under its field, the due line, the
 *   urgency line ("ends today / tomorrow / in N days — urgency is the
 *   point, not a date"), the open-job line, the dispatch option's label.
 */
import { describe, expect, it } from 'vitest';

import { ContractSchema, type Contract } from '@servgrid/shared';
import {
  addDays,
  addMonths,
  amcOptionLabel,
  defaultEndFor,
  dueLine,
  editDraftOf,
  endingLine,
  newDraft,
  openJobLine,
  patchOf,
  renewalDraftOf,
  stateLabel,
  validateAmcDraft,
} from './model';

/** A full Contract the wire would accept — the builder parses it, so a
 * fixture the schema would refuse fails here, not in front of a user. */
function contract(overrides: Partial<Contract> = {}): Contract {
  return ContractSchema.parse({
    id: 'c1000000-0000-4000-8000-000000000001',
    contractNumber: 'AMC-2627-00031',
    customerId: '01890a5e-1000-7000-8000-00000000c001',
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

describe('plain-date arithmetic (UTC, no timezone)', () => {
  it('addDays walks across month and year edges', () => {
    expect(addDays('2026-09-15', 1)).toBe('2026-09-16');
    expect(addDays('2026-09-15', -1)).toBe('2026-09-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('addMonths clamps to the month\u2019s last day — 31 Jan + 1 = 28/29 Feb', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-09-15', 12)).toBe('2027-09-15');
  });

  it('defaultEndFor is start + 12 months − 1 day; a leap-day start keeps its full term', () => {
    expect(defaultEndFor('2026-09-15')).toBe('2027-09-14');
    expect(defaultEndFor('2028-02-29')).toBe('2029-02-28');
  });
});

describe('the form\u2019s drafts', () => {
  it('newDraft starts today with the 12-month default end and nothing typed', () => {
    expect(newDraft('2026-09-15')).toEqual({
      customerId: null,
      customerName: null,
      startDate: '2026-09-15',
      endDate: '2027-09-14',
      contractValue: '',
      notes: '',
    });
  });

  it('renewalDraftOf starts the day after the old end and keeps the price and customer', () => {
    const draft = renewalDraftOf(contract({ endDate: '2027-09-14', contractValue: '18000.00' }));
    expect(draft.startDate).toBe('2027-09-15');
    expect(draft.endDate).toBe('2028-09-14');
    expect(draft.contractValue).toBe('18000.00');
    expect(draft.customerId).toBe('01890a5e-1000-7000-8000-00000000c001');
    expect(draft.notes).toBe('');
  });

  it('editDraftOf prefills every field as the server holds it, notes included', () => {
    const draft = editDraftOf(contract({ notes: 'Gate code 4412', contractValue: '20000.00' }));
    expect(draft).toEqual({
      customerId: '01890a5e-1000-7000-8000-00000000c001',
      customerName: 'Sunrise Apartments',
      startDate: '2026-09-15',
      endDate: '2027-09-14',
      contractValue: '20000.00',
      notes: 'Gate code 4412',
    });
  });
});

describe('patchOf — only the changed keys go over', () => {
  const original = contract({ notes: null, contractValue: '18000.00' });

  it('an untouched draft patches nothing', () => {
    expect(patchOf(original, editDraftOf(original))).toEqual({});
  });

  it('changed fields ride alone; blank notes mean "clear" and go as null', () => {
    const withNotes = contract({ notes: 'Gate code 4412', contractValue: '18000.00' });
    expect(
      patchOf(withNotes, {
        customerId: withNotes.customerId,
        customerName: withNotes.customerName,
        startDate: '2026-10-01',
        endDate: withNotes.endDate,
        contractValue: '19500',
        notes: '',
      }),
    ).toEqual({ startDate: '2026-10-01', contractValue: '19500', notes: null });
  });
});

describe('validateAmcDraft — the sentence sits under its field', () => {
  it('a blank form asks for the customer and the price', () => {
    const problems = validateAmcDraft(newDraft('2026-09-15'));
    expect(problems.customer).toBe('Who is the AMC for? Pick a customer.');
    expect(problems.contractValue).toBe('Enter the AMC price, for example 18000.');
    expect(problems.endDate).toBeUndefined();
  });

  it('an end before start is refused; a whole-rupee price passes', () => {
    const problems = validateAmcDraft({
      customerId: '01890a5e-1000-7000-8000-00000000c001',
      customerName: 'Sunrise Apartments',
      startDate: '2026-09-15',
      endDate: '2026-09-14',
      contractValue: '18000',
      notes: '',
    });
    expect(problems.endDate).toBe('The end date cannot be before the start date.');
    expect(problems.contractValue).toBeUndefined();
  });

  it('a price with more than two decimals (or junk) is refused', () => {
    for (const bad of ['18,000', '18000.123', 'abc', '-500', '']) {
      expect(
        validateAmcDraft({
          customerId: '01890a5e-1000-7000-8000-00000000c001',
          customerName: 'x',
          startDate: '2026-09-15',
          endDate: '2027-09-14',
          contractValue: bad,
          notes: '',
        }).contractValue,
      ).toBe('Enter the AMC price, for example 18000.');
    }
  });
});

describe('the line copy', () => {
  it('stateLabel words the four states', () => {
    expect(stateLabel('active')).toBe('Active');
    expect(stateLabel('upcoming')).toBe('Starts later');
    expect(stateLabel('expired')).toBe('Ended');
    expect(stateLabel('cancelled')).toBe('Cancelled');
  });

  it('dueLine reads the reminder: last service (any job) and due since', () => {
    expect(dueLine(contract())).toBe('last service 3 May 2026 · due since 3 Sep 2026');
    expect(dueLine(contract({ lastServiceDate: null }))).toBe('no job yet · due since 3 Sep 2026');
  });

  it('endingLine is urgency in words — 0, 1 and 4 days', () => {
    expect(endingLine(contract({ daysToEnd: 0 }))).toBe('ends today');
    expect(endingLine(contract({ daysToEnd: 1 }))).toBe('ends tomorrow');
    expect(endingLine(contract({ daysToEnd: 4 }))).toBe('ends in 4 days');
  });

  it('openJobLine names the booked job, or nothing', () => {
    expect(openJobLine(contract())).toBeNull();
    const openJobId = 'a1000000-0000-4000-8000-000000000001';
    const withOpen = contract({ openJob: { id: openJobId, jobNumber: 'JC-2627-00044', scheduledFor: null } });
    expect(openJobLine(withOpen)).toBe('JC-2627-00044 booked');
    const year = new Date().getFullYear();
    expect(
      openJobLine(
        contract({
          openJob: {
            id: openJobId,
            jobNumber: 'JC-2627-00044',
            scheduledFor: `${year}-10-12T06:00:00.000Z`,
          },
        }),
      ),
    ).toBe('JC-2627-00044 booked for 12 Oct');
  });

  it('amcOptionLabel is the dispatch form\u2019s checkbox label, year on', () => {
    expect(amcOptionLabel(contract())).toBe('AMC job · AMC-2627-00031 · until 14 Sep 2027');
  });
});
