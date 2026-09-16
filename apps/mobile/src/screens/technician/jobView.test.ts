/**
 * The job-logic rules the dashboard and the job detail share (mobile UI
 * overhaul, 2026-09-16). Pure functions over the work read — no renderer:
 *
 * - `activeJobOf` — the job he is on. The product decision it encodes is
 *   Yashas's: a technician works **one job at a time**, so the dashboard
 *   raises one job above the lists and no other job may be started while
 *   it stands.
 * - `busyWithSentence` — the one sentence that says whose job is in the
 *   way, used as the blocked button's `disabledReason`.
 * - `dayLabelOf` — the day on a row that is not today, because the
 *   compact card's meta row carries a clock time and a clock time is not
 *   a date.
 */
import { describe, expect, it } from 'vitest';

import { activeJobOf, busyWithSentence, dayLabelOf, type JobView } from './jobView';

/** Friday 11 September 2026, 10:00 IST. */
const NOW = new Date('2026-09-11T10:00:00+05:30');
const TODAY_0830 = '2026-09-11T08:30:00+05:30';
const TODAY_1430 = '2026-09-11T14:30:00+05:30';
const TOMORROW_0900 = '2026-09-12T09:00:00+05:30';

function viewOf(job: Partial<JobView['job']> & { id: string }): JobView {
  return {
    job: {
      jobNumber: `JC-2627-${job.id.padStart(5, '0')}`,
      title: 'UPS battery swap',
      status: 'assigned',
      priority: 'normal',
      scheduledFor: TODAY_0830,
      customerId: 'c1',
      contactName: null,
      contactPhone: null,
      description: null,
      contract: null,
      version: 1,
      ...job,
    },
    customerName: 'Sunrise Apartments',
    area: 'Kormangala 3rd Blk',
    coordinates: null,
    pending: false,
    rejectedMessage: null,
  };
}

describe('activeJobOf — the job he is on', () => {
  it('prefers the job on site over the one he is travelling to', () => {
    const travelling = viewOf({ id: 'b', status: 'en_route', scheduledFor: TODAY_0830 });
    const onSite = viewOf({ id: 'c', status: 'in_progress', scheduledFor: TODAY_1430 });
    expect(activeJobOf([travelling, onSite], NOW)?.job.id).toBe('c');
  });

  it('falls back to the travelling job when nobody is on site', () => {
    const travelling = viewOf({ id: 'b', status: 'en_route', scheduledFor: TODAY_1430 });
    expect(activeJobOf([travelling], NOW)?.job.id).toBe('b');
  });

  it('is null when every job is merely assigned, completed or cancelled', () => {
    expect(activeJobOf([viewOf({ id: 'a', status: 'assigned' })], NOW)).toBeNull();
    expect(activeJobOf([viewOf({ id: 'a', status: 'completed' })], NOW)).toBeNull();
    expect(activeJobOf([viewOf({ id: 'a', status: 'cancelled' })], NOW)).toBeNull();
    expect(activeJobOf([], NOW)).toBeNull();
  });

  it('never depends on array order — the earliest slot wins inside a status', () => {
    const later = viewOf({ id: 'later', status: 'in_progress', scheduledFor: TODAY_1430 });
    const earlier = viewOf({ id: 'earlier', status: 'in_progress', scheduledFor: TODAY_0830 });
    expect(activeJobOf([later, earlier], NOW)?.job.id).toBe('earlier');
    expect(activeJobOf([earlier, later], NOW)?.job.id).toBe('earlier');
  });

  it('names the job in the way, in one sentence', () => {
    const active = viewOf({ id: '42', status: 'in_progress' });
    expect(busyWithSentence(active)).toBe('Finish JC-2627-00042 first.');
  });
});

describe('dayLabelOf — a time is not a date', () => {
  it('is null for today, and for a job with no slot at all', () => {
    expect(dayLabelOf(TODAY_0830, NOW)).toBeNull();
    expect(dayLabelOf(TODAY_1430, NOW)).toBeNull();
    expect(dayLabelOf(null, NOW)).toBeNull();
  });

  it('says Tomorrow for the next day', () => {
    expect(dayLabelOf(TOMORROW_0900, NOW)).toBe('Tomorrow');
  });

  it('names the weekday and date beyond tomorrow', () => {
    // Matched loosely on the month: ICU abbreviates September as "Sep" or
    // "Sept" depending on the build (Node here says "Sept", Hermes says
    // "Sep"), and both read fine on a row.
    expect(dayLabelOf('2026-09-17T09:00:00+05:30', NOW)).toMatch(/^Thu 17 Sep/);
    expect(dayLabelOf('2026-09-25T09:00:00+05:30', NOW)).toMatch(/^Fri 25 Sep/);
  });

  it('judges the day in IST — a late-UTC instant is already tomorrow here', () => {
    // 20:00Z on the 11th is 01:30 IST on the 12th: tomorrow, not today.
    expect(dayLabelOf('2026-09-11T20:00:00Z', NOW)).toBe('Tomorrow');
  });
});
