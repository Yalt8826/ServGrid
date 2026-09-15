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
import type { PaymentMode, ProductRecord, ServiceRecord } from '@servgrid/shared';
import { sumMoney } from '../rep/money';
import { daysUntil } from '../rep/model';

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

/**
 * The owner screens' pure model (T4.12, UI/plan-2/07-OWNER.md §O5–§O9).
 * View rows, sorts, filters and the derived figures — no react-native, no
 * api, no hooks — the same layering as the rep's `model.ts`, so the
 * screens' tests assert these rules directly without dragging the API
 * client into the import graph.
 *
 * The owner's scoping is "none": every list arrives unscoped because the
 * server gives the owner `all` on every cell these screens read. What the
 * model adds is the owner's QUESTION — is this right, and if not, who do
 * I ask — so every row carries its person: the rep on a sale's company,
 * the sold-by on a contract, the collector on a payment.
 */

// ── O5 sales ───────────────────────────────────────────────────────────────

export type SaleStatus = 'draft' | 'confirmed' | 'void';

/** One owner sales row (§O5): the rep's card with its company named. */
export interface OwnerSaleRow {
  id: string;
  saleNumber: string | null;
  companyId: string;
  companyName: string;
  /** The card's maker — "if not, who do I ask" answered on the row. */
  repName: string | null;
  saleDate: string;
  total: string;
  status: SaleStatus;
}

/** Voids are reversals, not deletions — excluded from the running total
 * exactly as the rep's sold-this-month figure excludes them. */
export function salesRunningTotalOf(rows: readonly OwnerSaleRow[]): string {
  return sumMoney(rows.filter((r) => r.status === 'confirmed').map((r) => r.total));
}

/** Drafts first (visibly unfinished — the rep's rule), then date, newest
 * first; voids sort with the confirmed cards they reversed. */
export function sortOwnerSales(rows: readonly OwnerSaleRow[]): OwnerSaleRow[] {
  const byDateDesc = (a: OwnerSaleRow, b: OwnerSaleRow): number =>
    a.saleDate < b.saleDate ? 1 : a.saleDate > b.saleDate ? -1 : 0;
  return [...rows.filter((r) => r.status === 'draft').sort(byDateDesc), ...rows.filter((r) => r.status !== 'draft').sort(byDateDesc)];
}

// ── O5 payments ────────────────────────────────────────────────────────────

export type PaymentStatus = 'confirmed' | 'void';

/** One owner payments row (§O5): the collection with its collector. */
export interface OwnerPaymentRow {
  id: string;
  paymentNumber: string;
  companyId: string;
  companyName: string;
  /** `received_by` — who took the money. */
  repName: string | null;
  businessDate: string;
  amount: string;
  mode: PaymentMode;
  status: PaymentStatus;
}

export function paymentsRunningTotalOf(rows: readonly OwnerPaymentRow[]): string {
  return sumMoney(rows.filter((r) => r.status === 'confirmed').map((r) => r.amount));
}

export function sortOwnerPayments(rows: readonly OwnerPaymentRow[]): OwnerPaymentRow[] {
  return [...rows].sort((a, b) => (a.businessDate < b.businessDate ? 1 : a.businessDate > b.businessDate ? -1 : 0));
}

// ── O5 companies ───────────────────────────────────────────────────────────

/** One owner companies row (§O5): every account, both reps', plus the
 * house accounts — with its owner rep named. */
export interface OwnerCompanyRow {
  companyId: string;
  name: string;
  /** Null when the balances read is unavailable — degrades the column. */
  balance: string | null;
  ownerRepId: string | null;
  ownerRepName: string | null;
  /** House account (`owner_rep_id IS NULL`). */
  shared: boolean;
}

export function sortOwnerCompanies(rows: readonly OwnerCompanyRow[]): OwnerCompanyRow[] {
  return [...rows].sort((a, b) => {
    const av = a.balance === null ? Number.NEGATIVE_INFINITY : Number(a.balance);
    const bv = b.balance === null ? Number.NEGATIVE_INFINITY : Number(b.balance);
    return bv - av;
  });
}

// ── O6 contracts ───────────────────────────────────────────────────────────

export type ContractBilling = 'upfront' | 'on_visit';
export type ContractStatus = 'draft' | 'active' | 'expired' | 'cancelled';

/** One contract row (§O6 columns): number · site · billing · visits
 * used/included · start · end · value · sold by. */
export interface ContractRow {
  id: string;
  contractNumber: string | null;
  site: string;
  billing: ContractBilling;
  visitsUsed: number;
  visitsIncluded: number;
  startDate: string;
  endDate: string;
  value: string;
  soldByName: string | null;
  status: ContractStatus;
}

/** Contract list order: end date ascending — the thing running out is
 * the thing the owner needs on top. */
export function sortContractsByEnd(rows: readonly ContractRow[]): ContractRow[] {
  return [...rows].sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0));
}

export interface ContractRowWithDays extends ContractRow {
  daysRemaining: number;
}

/**
 * **Renewals is a filtered view, not a separate screen** (§O6): expiring
 * within 60 days, sorted by days remaining. Each row keeps its visits
 * used — a spent visit reduces what the renewal is worth.
 */
export const RENEWALS_WINDOW_DAYS = 60;

export function renewalsOf(rows: readonly ContractRow[], today: string): ContractRowWithDays[] {
  return rows
    .map((r) => ({ ...r, daysRemaining: daysUntil(r.endDate, today) }))
    .filter((r) => r.daysRemaining >= 0 && r.daysRemaining <= RENEWALS_WINDOW_DAYS)
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/** One visit in the detail's schedule, with EVERY attempt the visit
 * produced (§O6): a visit on its third attempt is the thing the owner
 * wants to see when a customer complains. */
export interface ContractVisitAttempt {
  jobId: string;
  jobNumber: string;
  status: string;
  technicianName: string | null;
}

export interface ContractVisitRow {
  id: string;
  /** The schedule's own ordinal — "visit 3 of 12". */
  ordinal: number;
  dueDate: string;
  status: string;
  attempts: ContractVisitAttempt[];
}

/** "Visit N" label — the schedule reads as a schedule, not a job list. */
export function visitLabel(visit: ContractVisitRow): string {
  return `Visit ${visit.ordinal}`;
}

/** True when the visit produced more than one job card — the multi-
 * attempt visits the detail exists to surface. */
export function isMultiAttempt(visit: ContractVisitRow): boolean {
  return visit.attempts.length > 1;
}

// ── O7 employees ───────────────────────────────────────────────────────────

export type TrackingHealthWord = 'active' | 'stale' | 'permission_missing' | 'never_reported' | 'not_tracked' | 'untracked_role';

/** One employees-list row (§O7): name · role · active · tracking health ·
 * last login. Health arrives from the roster read keyed by employee id. */
export interface EmployeeListRow {
  id: string;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  /** Null when the roster read is unavailable — degrades the column. */
  health: TrackingHealthWord | null;
}

const HEALTH_SEVERITY: Record<TrackingHealthWord, number> = {
  permission_missing: 0,
  never_reported: 0,
  not_tracked: 0,
  stale: 1,
  untracked_role: 2,
  active: 3,
};

/** The roster is sorted by health severity, not alphabetically — the
 * person with a problem is at the top (§O3's roster rule, §O7's list). */
export function sortEmployeeRows(rows: readonly EmployeeListRow[]): EmployeeListRow[] {
  return [...rows].sort((a, b) => {
    const ah = a.health === null ? 4 : HEALTH_SEVERITY[a.health];
    const bh = b.health === null ? 4 : HEALTH_SEVERITY[b.health];
    if (ah !== bh) return ah - bh;
    return a.fullName.localeCompare(b.fullName);
  });
}

/** The health column's word — the chip's tone in one string. */
export function healthLabel(health: TrackingHealthWord | null): string {
  switch (health) {
    case 'active':
      return 'Active';
    case 'stale':
      return 'Stale';
    case 'permission_missing':
    case 'never_reported':
    case 'not_tracked':
      return 'Problem';
    case 'untracked_role':
      return 'Not tracked';
    default:
      return '—';
  }
}

// ── O7 deactivation 409 — the blocking rows ────────────────────────────────

/**
 * The 409's details, one row per blocker (T4.5's server shape). The
 * screen renders these as LINKED ROWS — the owner's next action is to
 * reassign them, and the screen hands him that work rather than
 * describing it (§O7).
 */
export type BlockingRow =
  | { kind: 'job'; id: string; jobNumber: string; title: string; status: string }
  | { kind: 'company'; id: string; name: string }
  | { kind: 'cash'; id: string; businessDate: string; status: string; declaredAmount: string };

/** Where each blocking row's link lands — the screen the reassignment
 * happens on. */
export function blockingRowRoute(row: BlockingRow): string | null {
  switch (row.kind) {
    case 'job':
      return `/jobs/${row.id}`;
    case 'company':
      return `/companies/${row.id}`;
    case 'cash':
      return '/cash';
  }
}

/** The row's one-line label — equipment-record copy, not prose. */
export function blockingRowLabel(row: BlockingRow): string {
  switch (row.kind) {
    case 'job':
      return `${row.jobNumber} · ${row.title} · ${row.status}`;
    case 'company':
      return row.name;
    case 'cash':
      return `Cash ${row.businessDate} · ${row.status}`;
  }
}

/** The section header each blocking kind renders under. */
export function blockingRowSection(row: BlockingRow): string {
  switch (row.kind) {
    case 'job':
      return 'Open jobs — reassign each';
    case 'company':
      return 'Owned accounts — reassign or make house accounts';
    case 'cash':
      return 'Unconfirmed cash — confirm or dispute';
  }
}

// ── O7 device diagnostics — the equipment record ───────────────────────────

/** The eight diagnostics (§O7), in record order. A `null` value renders
 * as its honest unknown; a boolean renders Yes/No — "not confirmed" is
 * the OEM-mitigation truth for every handset that never checked in. */
export interface DiagnosticRow {
  key: string;
  label: string;
  value: string;
  /** Null = unknown (never reported); the row renders the value's word. */
  ok: boolean | null;
}

/** The unconfirmed-state defaults the schema itself carries — a handset
 * that never checks in reads unhealthy, never silently healthy. */
export function diagnosticRowsOf(d: {
  manufacturer: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  locationPermission: 'none' | 'foreground' | 'background';
  batteryOptExempt: boolean;
  autostartConfirmed: boolean;
  notificationsEnabled: boolean;
}): DiagnosticRow[] {
  const permissionWord =
    d.locationPermission === 'background' ? 'Background' : d.locationPermission === 'foreground' ? 'Foreground only' : 'None';
  return [
    { key: 'manufacturer', label: 'Manufacturer', value: d.manufacturer ?? 'Unknown', ok: d.manufacturer !== null ? true : null },
    { key: 'model', label: 'Model', value: d.model ?? 'Unknown', ok: d.model !== null ? true : null },
    { key: 'os', label: 'OS version', value: d.osVersion ?? 'Unknown', ok: d.osVersion !== null ? true : null },
    { key: 'app', label: 'App version', value: d.appVersion ?? 'Unknown', ok: d.appVersion !== null ? true : null },
    {
      key: 'permission',
      label: 'Location permission',
      value: permissionWord,
      ok: d.locationPermission === 'background' ? true : false,
    },
    { key: 'battery', label: 'Battery-optimisation exemption', value: d.batteryOptExempt ? 'Exempt' : 'Not exempt', ok: d.batteryOptExempt },
    {
      key: 'autostart',
      label: 'Autostart confirmed',
      value: d.autostartConfirmed ? 'Confirmed' : 'Not confirmed',
      ok: d.autostartConfirmed,
    },
    {
      key: 'notifications',
      label: 'Notifications enabled',
      value: d.notificationsEnabled ? 'Yes' : 'No',
      ok: d.notificationsEnabled,
    },
  ];
}

// ── O8 catalogue ───────────────────────────────────────────────────────────

/** Products' category words (the wire enums, readable). */
export const PRODUCT_CATEGORY_LABELS: Record<ProductRecord['category'], string> = {
  ups: 'UPS',
  battery: 'Battery',
  inverter: 'Inverter',
  accessory: 'Accessory',
  spare: 'Spare',
};

/** The active table first, the deactivated below — deactivation is the
 * correction path, not a deletion, so the rows stay visible (§O8). */
export function splitActive<T extends { isActive: boolean }>(rows: readonly T[]): { active: T[]; inactive: T[] } {
  return {
    active: rows.filter((r) => r.isActive),
    inactive: rows.filter((r) => !r.isActive),
  };
}

/** Services arrive without `isActive` (the wire shape carries active rows
 * only); the owner table still splits on the field when present. */
export interface OwnerProductRow extends ProductRecord {
  isActive: boolean;
}

export interface OwnerServiceRow extends ServiceRecord {
  isActive: boolean;
}

// ── O9 profile ─────────────────────────────────────────────────────────────

/** The second owner account (§O9): the reminder names WHO ELSE holds
 * owner access, because the recovery story depends on that account
 * existing and being remembered. */
export interface SecondOwner {
  id: string;
  fullName: string;
  username: string;
}

/** The profile's line, verbatim-shaped: names the person, not just the
 * count — an owner looking for his recovery account needs a name. */
export function secondOwnerLine(others: readonly SecondOwner[]): string {
  if (others.length === 0) {
    return 'No other account holds owner access. Create a second owner so the recovery story has an account to point at.';
  }
  const names = others.map((o) => `${o.fullName} (${o.username})`).join(', ');
  return `Also holds owner access: ${names}. Recovery depends on that account existing and being remembered.`;
}
