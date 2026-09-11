/**
 * T1.22 spike data — 220 dispatcher-shaped jobs, deterministic.
 * (PHASE-1-TECHNICIAN.md §T1.22 / UI/plan-2/05-DISPATCHER.md §D2:
 * "200+ real-shaped jobs — not six".)
 *
 * Shape follows what a dispatcher's job row needs to answer the trial
 * question ("who has the Kormangala jobs today"): job number, customer,
 * phone, area, technician, status, scheduled instant. Fields mirror the
 * dispatcher surface loosely — this is a throwaway fixture, not the
 * Phase 2 mirror contract, and deliberately lives nowhere near the
 * technician screens' `JobView`.
 *
 * Everything is seeded (mulberry32): two runs produce byte-identical
 * data, so timings and trial runs are comparable. All day arithmetic is
 * IST (fixed +05:30, no DST — shifting the instant by whole days keeps
 * the wall clock honest), matching `business_date()` on the server.
 */
import type { JobStatus } from '@servgrid/shared';

export interface SpikeJob {
  id: string;
  /** `JC-2627-00042` — fiscal-year sequence, allocated at create. */
  jobNumber: string;
  customerName: string;
  /** `+91 98xxx xxxxx` — searchable, per D2's search surface. */
  contactPhone: string;
  /** Locality line, e.g. `Kormangala 3rd Blk`. */
  area: string;
  title: string;
  /** Technician display name, or null when the job is unassigned. */
  technician: string | null;
  status: JobStatus;
  /** ISO instant, IST wall clock, e.g. `2026-09-11T14:30:00+05:30`. */
  scheduledFor: string;
}

/** The roster the Phase 2 dispatcher screen will pick from. Six names —
 * enough spread that "who has the Kormangala jobs" can have a real
 * multi-technician answer. */
export const TECHNICIANS: readonly string[] = [
  'Ravi Kumar',
  'Anitha Prasad',
  'Suresh Naik',
  'Meena Iyer',
  'Farhan Ali',
  'Deepa Rao',
];

/** Bengaluru localities; Kormangala deliberately over-represented (the
 * trial question lives there). */
const AREAS: readonly string[] = [
  'Kormangala 3rd Blk',
  'Kormangala 5th Blk',
  'Kormangala 80 Ft Rd',
  'Kormangala 4th Blk',
  'Indiranagar 100ft Rd',
  'Indiranagar 12th Main',
  'HSR Layout Sector 1',
  'HSR Layout Sector 7',
  'Jayanagar 4th Blk',
  'Jayanagar 9th Blk',
  'BTM Layout 2nd Stage',
  'Marathahalli Bridge Rd',
  'Whitefield Kadugodi',
  'Electronic City Phase 1',
  'Hebbal Ring Rd',
  'Rajajinagar 1st Blk',
  'Malleshwaram 8th Cross',
  'Basavanagudi Gandhi Bazaar',
  'Frazer Town Mosque Rd',
  'Yelahanka New Town',
];

const CUSTOMERS: readonly string[] = [
  'Sri Venkateshwara Apartments',
  'Nandini Sweets & Bakes',
  'Trident Business Centre',
  'Prestige Tech Park Ops',
  'Lakshmi Clinic',
  'Meridian Hostel mess',
  'Sagar Hospitals facility',
  'Green Leaf Supermarket',
  'Ravi Electricals',
  'Sunrise PG for Gents',
  'Bharath Petrol Bunks',
  'Anand Sweets canteen',
  'Crescent Public School',
  'Hotel Nalapaka',
  'Whitefield Realty office',
  'Sri Sai Cold Storage',
  'Nova Diagnostics lab',
  'Kormangala Club kitchen',
  'Indira Nursing Home',
  'Metro Cash & Carry store',
  'Balaji Stores wholesale',
  'Ashirvad Old Age Home',
  'Prakash Bakery outlet',
  'Falcon Gym & Spa',
];

const TITLES: readonly string[] = [
  'UPS battery swap',
  'Inverter annual service',
  'Battery bank replacement',
  'Online UPS fault repair',
  'Home inverter installation',
  'UPS preventive maintenance',
  'Battery water top-up',
  'Inverter overload check',
  'UPS card replacement',
  'Battery terminal service',
];

/** mulberry32 — small, fast, seedable; plenty for a fixture. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IST = 'Asia/Kolkata';

// One formatter instance, hoisted: constructing Intl.DateTimeFormat is
// orders of magnitude dearer than formatting, and `istDateKey` runs per
// job per filter tap — the exact work the trial measures.
const istDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: IST });

/** `YYYY-MM-DD` in IST for an instant (same formatter as the
 * technician screens' `istDateKey`). */
export function istDateKey(instant: Date | string): string {
  return istDayKey.format(typeof instant === 'string' ? new Date(instant) : instant);
}

/** IST day key shifted by whole days — +05:30 is fixed, so shifting the
 * instant by 24h multiples keeps the wall clock on the right day. */
function shiftedDayKey(now: Date, offsetDays: number): string {
  return istDateKey(new Date(now.getTime() + offsetDays * 86_400_000));
}

/** Dispatch-day slots, 08:30–18:30 IST — the hours jobs actually book. */
const SLOTS: readonly string[] = [
  '08:30',
  '09:00',
  '09:45',
  '10:15',
  '11:00',
  '11:45',
  '12:30',
  '14:00',
  '14:30',
  '15:15',
  '16:00',
  '16:45',
  '17:30',
  '18:30',
];

/** Day-mix table: [IST day offset, job count, status pool]. Past days
 * are finished work; today is a live dispatch day; future days are
 * assigned/unassigned queues. Yesterday leaks four open carry-overs,
 * because that is what dispatch floors look like at 08:00. */
const DAY_MIX: readonly { offset: number; count: number; pool: readonly JobStatus[] }[] = [
  { offset: -7, count: 18, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -6, count: 14, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -5, count: 14, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -4, count: 14, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -3, count: 14, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -2, count: 14, pool: ['completed', 'completed', 'completed', 'completed', 'cancelled'] },
  { offset: -1, count: 22, pool: ['completed', 'completed', 'completed', 'completed', 'completed', 'assigned', 'assigned', 'in_progress', 'cancelled'] },
  { offset: 0, count: 48, pool: ['completed', 'completed', 'assigned', 'assigned', 'assigned', 'en_route', 'en_route', 'in_progress', 'in_progress', 'unassigned', 'cancelled'] },
  { offset: 1, count: 26, pool: ['assigned', 'assigned', 'assigned', 'assigned', 'unassigned', 'unassigned'] },
  { offset: 2, count: 10, pool: ['assigned', 'assigned', 'unassigned'] },
  { offset: 3, count: 9, pool: ['assigned', 'assigned', 'unassigned'] },
  { offset: 4, count: 9, pool: ['assigned', 'unassigned'] },
  { offset: 5, count: 8, pool: ['assigned', 'unassigned'] },
];

/** 220 — the D2 floor is "200+ … not six". */
export const TOTAL_JOBS = DAY_MIX.reduce((sum, d) => sum + d.count, 0);

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)] as T;
}

function makePhone(rand: () => number): string {
  const lead = pick(rand, ['98', '97', '96', '95', '94']);
  let rest = '';
  for (let i = 0; i < 8; i += 1) rest += String(Math.floor(rand() * 10));
  return `+91 ${lead} ${rest.slice(0, 4)} ${rest.slice(4)}`;
}

/**
 * Generate the fixture. `now` anchors "today" in IST; pass a fixed
 * instant in tests/trials so the dataset never drifts under the trial.
 */
export function generateJobs(now: Date, seed = 20260912): SpikeJob[] {
  const rand = prng(seed);
  const jobs: SpikeJob[] = [];
  let seq = 0;

  for (const day of DAY_MIX) {
    const dayKey = shiftedDayKey(now, day.offset);
    for (let i = 0; i < day.count; i += 1) {
      seq += 1;
      const status = pick(rand, day.pool);
      const slot = SLOTS[Math.floor(rand() * SLOTS.length)] as string;
      const unassigned = status === 'unassigned' || (status === 'cancelled' && rand() < 0.3);
      jobs.push({
        id: `01890a5e-0000-7000-8000-${pad(seq, 12)}`,
        jobNumber: `JC-2627-${pad(seq, 5)}`,
        customerName: pick(rand, CUSTOMERS),
        contactPhone: makePhone(rand),
        area: pick(rand, AREAS),
        title: pick(rand, TITLES),
        technician: unassigned ? null : TECHNICIANS[Math.floor(rand() * TECHNICIANS.length)] as string,
        status,
        scheduledFor: `${dayKey}T${slot}:00+05:30`,
      });
    }
  }

  // Chronological job numbers: earliest day got the lowest sequence.
  return jobs.reverse();
}

/** `JC-2627-00042` → `JC-…0042` — the D2 anatomy's row label. */
export function shortJobNumber(jobNumber: string): string {
  const digits = jobNumber.slice(-5);
  return `JC-…${digits.slice(1)}`;
}

/** `14:30` IST wall clock for the row's second line. */
export function slotLabel(scheduledFor: string): string {
  return scheduledFor.slice(11, 16);
}

/** Row label uses the technician's first name (`Ravi · 14:30`). */
export function firstName(technician: string): string {
  return technician.split(' ')[0] ?? technician;
}
