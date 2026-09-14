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
import type { PaymentMode, ProductRecord, ServiceRecord } from '@servgrid/shared';
import { sumMoney } from '../rep/money';
import { daysUntil } from '../rep/model';

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
  | { kind: 'cash'; id: string; businessDate: string; status: string; declaredAmount: string }
  | { kind: 'outbox'; id: string; endpoint: string };

/** Where each blocking row's link lands — the screen the reassignment
 * happens on. Outbox rows have no screen: they drain or they don't. */
export function blockingRowRoute(row: BlockingRow): string | null {
  switch (row.kind) {
    case 'job':
      return `/jobs/${row.id}`;
    case 'company':
      return `/companies/${row.id}`;
    case 'cash':
      return '/cash';
    case 'outbox':
      return null;
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
    case 'outbox':
      return `Undrained · ${row.endpoint}`;
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
    case 'outbox':
      return 'Undrained offline work';
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
