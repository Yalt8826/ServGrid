/**
 * The owner dashboard's pure model (T4.8, UI/plan-2/07-OWNER.md §O1) —
 * view figures, attention rows, the copy and the targets. No
 * react-native, no api, no hooks — the same layering as the rep's
 * `model.ts`, so the screen's tests assert these rules directly without
 * dragging the API client or expo-network into the import graph.
 *
 * Every figure's VALUE is the server's (`GET /v1/dashboard/owner`, T4.6);
 * the only transformation here is wire-format money becoming `en-IN`
 * display money (`₹1,00,000`, never `₹100,000`) — the one formatter,
 * `formatMoneyEnIN`, so this screen cannot regroup differently from the
 * rest of the app. The response shapes below mirror
 * `apps/api/src/modules/dashboard/schemas.ts`, which is the authority:
 * they are deliberately duplicated, not shared, because a shared export
 * would be a second place a dashboard figure could drift.
 */
import { formatMoneyEnIN } from '@servgrid/shared';
import { formatDateEnIN } from '../../components/ui';

// ── wire shapes (mirror of the api module's schemas — see header) ─────────

/** One chart day: the IST business date and the job cards scheduled on it. */
export interface JobsPerDayPoint {
  date: string;
  jobs: number;
}

/** One chart week: the ISO week start (Monday, IST) and revenue booked that week. */
export interface RevenuePerWeekPoint {
  weekStart: string;
  revenue: string;
}

/** `GET /v1/dashboard/owner` — the four figures and the two charts. */
export interface OwnerDashboardResponse {
  openJobsByStatusToday: {
    unassigned: number;
    assigned: number;
    enRoute: number;
    inProgress: number;
  };
  cashAwaitingConfirmation: string;
  monthToDateRevenue: string;
  outstandingCompanyDues: string;
  jobsPerDay: JobsPerDayPoint[];
  revenuePerWeek: RevenuePerWeekPoint[];
}

export type AttentionCategory =
  | 'missing_submission'
  | 'cash_variance'
  | 'overdue_job'
  | 'tracking_health';

/** `GET /v1/dashboard/owner/attention` — one row, polymorphic by category. */
export interface AttentionItem {
  category: AttentionCategory;
  employeeId: string | null;
  employeeName: string | null;
  businessDate: string | null;
  expectedCash: string | null;
  declaredAmount: string | null;
  variance: string | null;
  jobId: string | null;
  jobNumber: string | null;
  jobTitle: string | null;
  jobStatus: string | null;
  scheduledDate: string | null;
  customerName: string | null;
  health: 'stale' | 'permission_missing' | null;
  lastPingAt: string | null;
}

// ── the four figures ───────────────────────────────────────────────────────

/** One dashboard figure — value already display-formatted, tabular. */
export interface OwnerFigure {
  key: 'openJobs' | 'cashAwaiting' | 'monthToDate' | 'companyDues';
  label: string;
  value: string;
  /** What populates this figure — the line a new deployment reads under its `0`. */
  caption: string;
}

/** Wire money → `₹1,00,000`. The one money path on this screen. */
export function rupeesOf(amount: string): string {
  return `₹${formatMoneyEnIN(amount)}`;
}

/**
 * The four figures in display order (§O1's table). Figure 1 is "open jobs
 * **by status** today", so its caption IS the status breakdown — the sum
 * alone would drop the by-status part the plan pins. The money figures
 * carry captions naming what populates them, which is what a new
 * deployment's `₹0` sits on: zero with no caption reads as breakage.
 */
export function figuresOf(dashboard: OwnerDashboardResponse): OwnerFigure[] {
  const s = dashboard.openJobsByStatusToday;
  const open = s.unassigned + s.assigned + s.enRoute + s.inProgress;
  return [
    {
      key: 'openJobs',
      label: 'open jobs today',
      value: String(open),
      caption: `${s.unassigned} unassigned · ${s.assigned} assigned · ${s.enRoute} en route · ${s.inProgress} in progress`,
    },
    {
      key: 'cashAwaiting',
      label: 'cash awaiting confirmation',
      value: rupeesOf(dashboard.cashAwaitingConfirmation),
      caption: 'cash collected, not yet confirmed',
    },
    {
      key: 'monthToDate',
      label: 'month-to-date revenue',
      value: rupeesOf(dashboard.monthToDateRevenue),
      caption: 'completion revenue this month',
    },
    {
      key: 'companyDues',
      label: 'outstanding company dues',
      value: rupeesOf(dashboard.outstandingCompanyDues),
      caption: 'what companies still owe',
    },
  ];
}

// ── the attention feed ─────────────────────────────────────────────────────

export type AttentionSeverity = 'danger' | 'warning';

/** One rendered attention row — "each row links straight to the thing". */
export interface AttentionRowVm {
  key: string;
  category: AttentionCategory;
  severity: AttentionSeverity;
  title: string;
  meta: string;
  /** The flag word — right-aligned on the phone row, the Flag column on the desk. */
  note: string;
  /** The route to push — the thing itself, never a list it belongs to. */
  target: string;
}

function dateLabel(iso: string | null, now: Date): string {
  if (iso === null) return 'no date';
  return formatDateEnIN(iso, now.getFullYear());
}

/** `−400.00` → `₹400 short` — the sign becomes the word, §O2's honesty. */
export function varianceLabel(variance: string): string {
  const short = variance.startsWith('-');
  const abs = formatMoneyEnIN(variance.replace('-', ''));
  return short ? `₹${abs} short` : `₹${abs} over`;
}

/** `2h 35m ago` — the age a roster reader acts on (§O3's language). */
export function lastSeenLabel(lastPingAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(lastPingAt)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
}

/**
 * The feed arrives in consequence order (the endpoint's contract —
 * missing submissions, variances, overdue jobs, tracking health; the
 * mapper preserves it, never re-sorts). Each category states its trouble
 * in the words the owner acts on and carries the direct link: cash rows
 * to the reconciliation queue, an overdue job to the job, a sick tracker
 * to the location console's roster.
 */
export function attentionRowsOf(items: AttentionItem[], now: Date): AttentionRowVm[] {
  return items.map((item, index) => {
    const key = `${item.category}-${index}`;
    switch (item.category) {
      case 'missing_submission':
        return {
          key,
          category: item.category,
          severity: 'danger',
          title: `${item.employeeName ?? 'A technician'} — no declaration`,
          meta: `Collected ${rupeesOf(item.expectedCash ?? '0')} on ${dateLabel(item.businessDate, now)}`,
          note: 'missing submission',
          target: '/cash',
        };
      case 'cash_variance':
        return {
          key,
          category: item.category,
          severity: 'warning',
          title: `${item.employeeName ?? 'A technician'} — ${varianceLabel(item.variance ?? '0')}`,
          meta: `Expected ${rupeesOf(item.expectedCash ?? '0')} · declared ${rupeesOf(item.declaredAmount ?? '0')} on ${dateLabel(item.businessDate, now)}`,
          note: 'variance',
          target: '/cash',
        };
      case 'overdue_job':
        return {
          key,
          category: item.category,
          severity: 'danger',
          title: `${item.jobNumber ?? 'A job'} · ${item.jobTitle ?? 'untitled'}`,
          meta: `${item.customerName ?? 'Unknown customer'} · was due ${dateLabel(item.scheduledDate, now)}`,
          note: 'overdue',
          target: item.jobId === null ? '/jobs' : `/jobs/${item.jobId}`,
        };
      case 'tracking_health':
        return {
          key,
          category: item.category,
          severity: item.health === 'permission_missing' ? 'danger' : 'warning',
          title: `${item.employeeName ?? 'A technician'} — ${
            item.health === 'permission_missing' ? 'location permission missing' : 'tracker gone quiet'
          }`,
          meta:
            item.lastPingAt === null
              ? 'no fix yet'
              : `last ping ${lastSeenLabel(item.lastPingAt, now)}`,
          note: item.health ?? 'tracking',
          target: '/location',
        };
    }
  });
}
