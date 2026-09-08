/**
 * Status machine tests (T0.5): every legal transition from PLAN-BACKEND.md
 * §6.1 accepted — including `en_route → assigned` (reassign) and
 * `assigned → in_progress` (skipping en route) — and the refusals:
 * `in_progress → assigned` refused (reassigning someone who has started
 * work), and both terminal states accept nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allowedTransitions,
  canTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  type JobStatus,
} from './status.ts';

/** Every `from → to` row of the §6.1 table. */
const LEGAL: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
  ['unassigned', 'assigned'], // dispatcher, owner (service-side who-check)
  ['assigned', 'en_route'], // assigned technician, owner
  ['assigned', 'in_progress'], // skipping en route — legal on purpose
  ['assigned', 'assigned'], // reassign
  ['en_route', 'assigned'], // reassign; resets to assigned, emits `reassigned`
  ['en_route', 'in_progress'], // assigned technician, owner
  ['in_progress', 'completed'], // assigned technician, owner
  ['unassigned', 'cancelled'], // any non-terminal → cancelled
  ['assigned', 'cancelled'],
  ['en_route', 'cancelled'],
  ['in_progress', 'cancelled'],
];

const REFUSED: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
  ['in_progress', 'assigned'], // reassigning someone who has started work → 409 ILLEGAL_TRANSITION
  ['in_progress', 'en_route'],
  ['completed', 'completed'],
  ['completed', 'cancelled'],
  ['completed', 'unassigned'],
  ['completed', 'assigned'],
  ['completed', 'en_route'],
  ['completed', 'in_progress'],
  ['cancelled', 'cancelled'],
  ['cancelled', 'completed'],
  ['cancelled', 'unassigned'],
  ['cancelled', 'assigned'],
  ['cancelled', 'en_route'],
  ['cancelled', 'in_progress'],
  ['unassigned', 'en_route'], // nobody is en route to a job nobody holds
  ['unassigned', 'in_progress'],
  ['unassigned', 'completed'], // completion requires in_progress or assigned/en_route actor paths
];

describe('job status machine (PLAN-BACKEND.md §6.1)', () => {
  it('accepts every legal transition', () => {
    for (const [from, to] of LEGAL) {
      assert.equal(canTransition(from, to), true, `${from} → ${to} must be legal`);
    }
  });

  it('accepts en_route → assigned (reassign) and assigned → in_progress (skipping en route)', () => {
    assert.equal(canTransition('en_route', 'assigned'), true);
    assert.equal(canTransition('assigned', 'in_progress'), true);
  });

  it('refuses in_progress → assigned — reassigning someone who has started work', () => {
    assert.equal(canTransition('in_progress', 'assigned'), false);
  });

  it('both terminal states accept nothing', () => {
    for (const terminal of ['completed', 'cancelled'] as const) {
      for (const to of JOB_STATUSES) {
        assert.equal(canTransition(terminal, to), false, `terminal ${terminal} → ${to} must be refused`);
      }
    }
  });

  it('every non-legal pair is refused — total over all 36 pairs', () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const expected = legal.has(`${from}->${to}`);
        assert.equal(canTransition(from, to), expected, `${from} → ${to}`);
      }
    }
  });

  it('REFUSED list contains no legal transition', () => {
    for (const [from, to] of REFUSED) {
      assert.equal(canTransition(from, to), false, `${from} → ${to} was expected refused but is legal`);
    }
  });

  it('allowedTransitions() agrees with canTransition() and is empty for terminals', () => {
    for (const from of JOB_STATUSES) {
      const targets = allowedTransitions(from);
      for (const to of JOB_STATUSES) {
        assert.equal(targets.includes(to), canTransition(from, to), `${from} → ${to}`);
      }
    }
    assert.deepEqual(allowedTransitions('completed'), []);
    assert.deepEqual(allowedTransitions('cancelled'), []);
  });

  it('isTerminalJobStatus marks exactly completed and cancelled', () => {
    assert.deepEqual(
      JOB_STATUSES.filter(isTerminalJobStatus),
      ['completed', 'cancelled'],
    );
    for (const s of ['unassigned', 'assigned', 'en_route', 'in_progress'] as const) {
      assert.equal(isTerminalJobStatus(s), false);
    }
  });
});
