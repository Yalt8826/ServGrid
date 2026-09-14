/**
 * T4.1 spike fixture — 500 real-shaped jobs for the desktop DataTable
 * (THROWAWAY). Same discipline as the T1.22 fixture: seeded, Bengaluru
 * areas, plausible technicians, IST slots, a realistic status mix — at
 * the volume the owner's job table must scan (the spec's number: 500).
 *
 * Shape is the OWNER's table (`UI/plan-2/07-OWNER.md` §O4): number ·
 * customer · service · technician · scheduled · status · amount. The
 * amount column is owner-only in the product; here it is the sortable
 * money column the spike must measure.
 */
import type { JobStatus } from '@servgrid/shared';

export interface DeskJob {
  id: number;
  jobNumber: string;
  customer: string;
  service: string;
  technician: string | null;
  area: string;
  /** Epoch ms — the sort key. */
  scheduledForMs: number;
  /** Pre-rendered display form, e.g. `3 Sep · 14:30`. */
  scheduledLabel: string;
  /** Rupees, integer — the money column. */
  amount: number;
  status: JobStatus;
}

/** mulberry32 — deterministic, seedable, tiny. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = [
  'Kormangala 5th Blk',
  'Indiranagar',
  'Jayanagar 4th Blk',
  'Whitefield',
  'HSR Layout Sec 2',
  'BTM Layout 1st Stg',
  'Frazer Town',
  'Malleshwaram',
  'Rajajinagar',
  'Marathahalli',
];

const TECHNICIANS = [
  'Ravi Kumar',
  'Suresh Naik',
  'Anitha Prasad',
  'Farhan Ali',
  'Lakshmi Iyer',
  'Vikram Rao',
  'Meena Nair',
  'Joseph Dsouza',
];

const CUSTOMER_PREFIX = [
  'Sri Ganesh Apts',
  'Nestaway Homes',
  'Brigade Court',
  'Purva Highlands',
  'Mantri Serenity',
  'Sobha Aquamarine',
  'Prestige Shantiniketan',
  'Total Environment',
  'Godrej Eternity',
  'Assetz Marq',
];

const CUSTOMER_SUFFIX = [
  'R Sharma',
  'K Venkatesh',
  'A Fernandes',
  'M Reddy',
  'S Iyer',
  'N Kamath',
  'P Nair',
  'D Agarwal',
];

const SERVICES = [
  'RO Service',
  'Deep Cleaning',
  'Pest Control',
  'AC Service',
  'Electrical Visit',
  'Plumbing Visit',
  'AMC Visit',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Status mix of a scanning surface: mostly closed work, a live today. */
const STATUS_POOL: JobStatus[] = [
  ...Array<JobStatus>(30).fill('completed'),
  ...Array<JobStatus>(6).fill('cancelled'),
  ...Array<JobStatus>(6).fill('in_progress'),
  ...Array<JobStatus>(4).fill('en_route'),
  ...Array<JobStatus>(4).fill('assigned'),
  ...Array<JobStatus>(3).fill('unassigned'),
];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Indexed access under `noUncheckedIndexedAccess` — fixture tables are
 * statically known non-empty, so the fallback never fires. */
function pick<T>(arr: readonly T[], i: number): T {
  return arr[i] ?? (arr[0] as T);
}

/** IST slot label on a 30-min grid, 08:30–18:30. */
function slotLabel(baseMs: number, r: number): string {
  const d = new Date(baseMs);
  const hour = 8 + Math.floor(r * 10);
  const minute = r < 0.5 ? 30 : 0;
  d.setHours(hour, minute, 0, 0);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${pad(d.getHours(), 2)}:${pad(minute, 2)}`;
}

/**
 * 500 seeded jobs spread across ±10 days around today. Deterministic
 * for a given day — two runs sort the same data.
 */
export function generateDeskJobs(now: Date, count = 500): DeskJob[] {
  const r = rng(20260914);
  const jobs: DeskJob[] = [];
  for (let i = 0; i < count; i += 1) {
    const dayOffset = Math.floor(r() * 21) - 10;
    const base = new Date(now);
    base.setDate(base.getDate() + dayOffset);
    base.setHours(0, 0, 0, 0);
    const slotR = r();
    const scheduledMs = base.getTime() + Math.floor(slotR * 10 * 3600_000);
    const status = pick(STATUS_POOL, Math.floor(r() * STATUS_POOL.length));
    jobs.push({
      id: i,
      jobNumber: `JC-2627-${pad(100 + i, 5)}`,
      customer: `${pick(CUSTOMER_PREFIX, Math.floor(r() * CUSTOMER_PREFIX.length))} · ${pick(CUSTOMER_SUFFIX, Math.floor(r() * CUSTOMER_SUFFIX.length))}`,
      service: pick(SERVICES, Math.floor(r() * SERVICES.length)),
      technician: status === 'unassigned' ? null : pick(TECHNICIANS, Math.floor(r() * TECHNICIANS.length)),
      area: pick(AREAS, Math.floor(r() * AREAS.length)),
      scheduledForMs: scheduledMs,
      scheduledLabel: slotLabel(scheduledMs, slotR),
      amount: 300 + Math.floor(r() * 117) * 100,
      status,
    });
  }
  return jobs;
}
