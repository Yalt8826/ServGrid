/**
 * The rep screens' pure model (T3.7): view rows, the derived figures, the
 * sort and the copy. No react-native, no api, no hooks — the same layering
 * as the technician's `jobView.ts`/`jobData.ts` split, so the screens'
 * tests assert these rules directly without dragging the API client into
 * the import graph.
 *
 * The rep's own scoping is the server's job (`owner_rep_id = him OR NULL`
 * on company, `sales_rep_id = him` on sale, `received_by = him` on
 * payment) — every list arrives already isolated; the screens' tests prove
 * the rendered tree from isolated fixtures.
 */
import type {
  Company,
  CompanyBalance,
  PaymentMode,
} from '@servgrid/shared';
import { istBusinessDate } from '../technician/HandoverScreen';
import { sumMoney } from './money';

// ── view rows ──────────────────────────────────────────────────────────────

/** One "owes the most" / Owed-tab row — a view of dues, not a payment. */
export interface OwedRow {
  companyId: string;
  name: string;
  balance: string;
}

/** One companies-tab row: his accounts plus house accounts, balance desc. */
export interface CompanyRow {
  companyId: string;
  name: string;
  /** Null when the balances read is unavailable (`sales.payments` off). */
  balance: string | null;
  lastSaleDate: string | null;
  lastPaymentAt: string | null;
  /** House account (`owner_rep_id IS NULL`) — the small `Shared` chip. */
  shared: boolean;
}

export interface SaleRow {
  id: string;
  saleNumber: string | null;
  companyId: string;
  companyName: string;
  saleDate: string;
  total: string;
  status: 'draft' | 'confirmed' | 'void';
}

export interface PaymentRow {
  id: string;
  paymentNumber: string;
  companyId: string;
  companyName: string;
  amount: string;
  mode: PaymentMode;
  businessDate: string;
}

// ── derived figures (§S1) ──────────────────────────────────────────────────

/** The IST month `YYYY-MM` a plain business date falls in. */
export function istMonthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Today's IST business date — the dashboard's month boundary. */
export function istToday(): string {
  return istBusinessDate(new Date());
}

/** Sold this month (§S1): confirmed cards' totals, `v_sales_card_totals`'s
 * definition carried by each row's `total`. Drafts move no money; voids
 * are reversals — both excluded. */
export function soldThisMonthOf(sales: ReadonlyArray<{ status: string; saleDate: string; total: string }>, month: string): string {
  return sumMoney(
    sales.filter((s) => s.status === 'confirmed' && istMonthOf(s.saleDate) === month).map((s) => s.total),
  );
}

/**
 * How many sales he made this month (2026-09-18): the count `soldThisMonthOf`
 * sums — same filter, same month, so the figure and its count can never
 * disagree about what "this month" means.
 */
export function salesCountThisMonthOf(
  sales: ReadonlyArray<{ status: string; saleDate: string }>,
  month: string,
): number {
  return sales.filter((s) => s.status === 'confirmed' && istMonthOf(s.saleDate) === month).length;
}

/** Outstanding across his accounts (§S1): the sum of positive balances.
 * A credit balance is not outstanding — it is the customer's good news. */
export function outstandingOf(balances: readonly CompanyBalance[]): string {
  return sumMoney(balances.filter((b) => Number(b.balance) > 0).map((b) => b.balance));
}

/** "Owes the most" (§S1): positive balances, descending, top `limit`. */
export function owesTheMostOf(balances: readonly CompanyBalance[], limit = 5): OwedRow[] {
  return balances
    .filter((b) => Number(b.balance) > 0)
    .sort((a, b) => Number(b.balance) - Number(a.balance))
    .slice(0, limit)
    .map((b) => ({ companyId: b.companyId, name: b.name, balance: b.balance }));
}

/**
 * Drafts sort first (§S2) — an unconfirmed sale burns no number and moves
 * no balance, so it leads the list visibly unfinished — then sale date,
 * newest first within each group.
 */
export function sortSalesRows(rows: readonly SaleRow[]): SaleRow[] {
  const byDateDesc = (a: SaleRow, b: SaleRow): number =>
    a.saleDate < b.saleDate ? 1 : a.saleDate > b.saleDate ? -1 : 0;
  return [
    ...rows.filter((r) => r.status === 'draft').sort(byDateDesc),
    ...rows.filter((r) => r.status !== 'draft').sort(byDateDesc),
  ];
}

// ── the list's day sections and its day filter (2026-09-18) ───────────────

/** `YYYY-MM-DD` ± `days`, on plain calendar days via UTC — no timezone to
 * be wrong in, the same trick the rest of the app's day arithmetic uses. */
export function addDaysIso(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The app's own short forms — the same words `formatDateEnIN` prints, so
 * a heading and the row under it never disagree about September ("Sep",
 * never ICU's "Sept"). */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A section's heading for a day: `Today`, `Yesterday`, else `Mon 14 Sep`
 * — with the year when it is not the current one, because a rep scrolling
 * back needs to know which September he is looking at.
 */
export function dayLabelFor(day: string, todayIso: string): string {
  if (day === todayIso) return 'Today';
  if (day === addDaysIso(todayIso, -1)) return 'Yesterday';
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  const label = `${WEEKDAYS[at.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
  return todayIso.slice(0, 4) === day.slice(0, 4) ? label : `${label} ${y}`;
}

export interface SalesDaySection {
  /** The day itself, `YYYY-MM-DD`. */
  day: string;
  /** `Today` / `Yesterday` / `Mon 14 Sep` — the heading. */
  label: string;
  rows: SaleRow[];
  /** What he sold that day, all statuses: the section's own figure. */
  total: string;
}

/**
 * The list divided by the day it was sold (§S2, 2026-09-18): one section
 * per sale date, newest day first, drafts leading inside their own day
 * (`sortSalesRows`) — a sale belongs to the day it was raised, so the
 * grouping decides the order and the draft rule applies within it.
 */
export function salesDaySections(rows: readonly SaleRow[], todayIso: string): SalesDaySection[] {
  const byDay = new Map<string, SaleRow[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.saleDate);
    if (bucket === undefined) byDay.set(row.saleDate, [row]);
    else bucket.push(row);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)) // newest day first
    .map(([day, dayRows]) => ({
      day,
      label: dayLabelFor(day, todayIso),
      rows: sortSalesRows(dayRows),
      total: sumMoney(dayRows.map((r) => r.total)),
    }));
}

/** The list narrowed to one day — `null` is every day, the resting state. */
export function filterSalesByDay(rows: readonly SaleRow[], day: string | null): SaleRow[] {
  return day === null ? [...rows] : rows.filter((row) => row.saleDate === day);
}

/** His accounts plus house accounts, balance descending, nulls last. */
export function companiesRowsOf(
  companies: readonly Company[],
  balances: readonly CompanyBalance[] | null,
): CompanyRow[] {
  const byId = new Map(balances?.map((b) => [b.companyId, b]));
  const rows: CompanyRow[] = companies.map((c) => {
    const b = byId.get(c.id) ?? null;
    return {
      companyId: c.id,
      name: c.name,
      balance: b?.balance ?? null,
      lastSaleDate: b?.lastSaleDate ?? null,
      lastPaymentAt: b?.lastPaymentAt ?? null,
      shared: c.ownerRepId === null,
    };
  });
  return rows.sort((a, b) => {
    const av = a.balance === null ? Number.NEGATIVE_INFINITY : Number(a.balance);
    const bv = b.balance === null ? Number.NEGATIVE_INFINITY : Number(b.balance);
    return bv - av;
  });
}

/** The last activity day a company row shows (§S4), sale or payment. */
export function lastActivityOf(row: CompanyRow): string | null {
  const sale = row.lastSaleDate;
  const payment = row.lastPaymentAt === null ? null : row.lastPaymentAt.slice(0, 10);
  if (sale === null) return payment;
  if (payment === null) return sale;
  return sale > payment ? sale : payment;
}

/** Calendar days from `today` to `iso` (plain ISO dates, UTC arithmetic). */
export function daysUntil(iso: string, today: string): number {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const [ty = 1970, tm = 1, td = 1] = today.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

// ── the payment sheet's rules (§S3) ────────────────────────────────────────

/** The `mode` segment labels — Bank reads "Bank", never a truncated
 * "Bank transf…"; five across 360dp does not fit honest labels. */
export const MODE_ROWS: ReadonlyArray<ReadonlyArray<{ label: string; mode: PaymentMode }>> = [
  [
    { label: 'Cash', mode: 'cash' },
    { label: 'UPI', mode: 'upi' },
    { label: 'Cheque', mode: 'cheque' },
  ],
  [
    { label: 'Bank', mode: 'bank_transfer' },
    { label: 'Card', mode: 'card' },
  ],
];

/** Reference appears for non-cash modes only (§S3). */
export function referenceNeededFor(mode: PaymentMode): boolean {
  return mode !== 'cash';
}

/** Required for cheque and bank — where the money's trail lives. */
export function referenceRequiredFor(mode: PaymentMode): boolean {
  return mode === 'cheque' || mode === 'bank_transfer';
}

/** The one line Cash raises (§S3) — a reminder, not a warning. */
export const CASH_HANDOVER_REMINDER = 'Cash goes on your handover today.';

/** The Owed tab's empty state (§S3) — companies, not payments. */
export const OWED_EMPTY_MESSAGE = 'No company owes you anything.';
