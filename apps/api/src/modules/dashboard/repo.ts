import type { JobStatus } from '@servgrid/shared';
import type { Db } from '../auth/repo.js';

/**
 * Owner dashboard SQL (PLAN.md §8, UI/plan-2/07-OWNER.md §O1; PHASE-4-OWNER.md
 * T4.6). Every figure reads an object the schema already owns — "nothing
 * here needs a new query" is the point of the endpoint, so the dashboard
 * cannot become a second definition of any number:
 *
 *   open jobs by status today   → v_job_cards_dispatcher   (migration 013)
 *   cash awaiting confirmation  → v_cash_reconciliation_queue (migration 018)
 *   month-to-date revenue       → job_completions         (migration 007)
 *   outstanding company dues    → v_company_balances      (migration 018)
 *
 * and the attention feed reads the same views plus
 * v_employee_tracking_health (migration 009). None of it selects from
 * job_cards directly — the integration suite proves that from the captured
 * SQL text, not from this comment.
 *
 * "Today" everywhere below is `business_date(now())` — the Asia/Kolkata
 * calendar day (migration 001), never the server clock's UTC date, which
 * is wrong for five and a half hours out of every twenty-four. The chart
 * series run on generated_series so a day with no jobs is a zero bar, not
 * a missing row — an absent bucket renders as a broken chart.
 *
 * The contracts-expiring slice of the attention feed (§O1 item 5) has no
 * source yet: `v_contracts_expiring` ships with migration 015 (Phase 2B),
 * which has not run when this module lands. The feed's contract is the
 * category union plus its order; when 015 lands, its branch slots in at
 * rank 5. Inventing a contracts table here would be starting Phase 2B's
 * work, and guessing at its columns would be worse.
 */

/** Figure 1 — the open jobs on today's IST board, one column per open status. */
export interface OpenJobsByStatusRow {
  unassigned: string;
  assigned: string;
  en_route: string;
  in_progress: string;
}

export async function countOpenJobsByStatusToday(db: Db): Promise<OpenJobsByStatusRow> {
  const r = await db.query<OpenJobsByStatusRow>(
    `SELECT
       count(*) FILTER (WHERE v.status = 'unassigned')  AS unassigned,
       count(*) FILTER (WHERE v.status = 'assigned')    AS assigned,
       count(*) FILTER (WHERE v.status = 'en_route')    AS en_route,
       count(*) FILTER (WHERE v.status = 'in_progress') AS in_progress
     FROM v_job_cards_dispatcher v
     WHERE v.status NOT IN ('completed', 'cancelled')
       AND v.scheduled_date = business_date(now())`,
  );
  return r.rows[0]!;
}

/**
 * Figure 2 — declared money the owner has not answered yet. `submitted` is
 * the queue view's carried-through declaration status: neither confirmed
 * nor disputed. A `missing_submission` day has nothing declared, so it
 * cannot be money awaiting confirmation — it is money awaiting a
 * declaration, and the attention feed catches it instead.
 */
export async function sumCashAwaitingConfirmation(db: Db): Promise<string> {
  const r = await db.query<{ awaiting: string }>(
    `SELECT COALESCE(
       SUM(q.declared_amount) FILTER (WHERE q.declaration_status = 'submitted'),
       0::numeric(14,2)
     )::text AS awaiting
     FROM v_cash_reconciliation_queue q`,
  );
  return r.rows[0]!.awaiting;
}

/** Figure 3 — month-to-date completion revenue, the IST month to date. */
export async function sumMonthToDateRevenue(db: Db): Promise<string> {
  const r = await db.query<{ revenue: string }>(
    `SELECT COALESCE(SUM(jc.amount_collected), 0::numeric(14,2))::text AS revenue
     FROM job_completions jc
     WHERE jc.business_date >= date_trunc('month', business_date(now()))::date`,
  );
  return r.rows[0]!.revenue;
}

/**
 * Figure 4 — total outstanding company dues. Positive balances only: a
 * negative balance is a credit (§O2's own reading of v_company_balances),
 * and netting a credit against real dues would understate what is owed.
 */
export async function sumOutstandingCompanyDues(db: Db): Promise<string> {
  const r = await db.query<{ dues: string }>(
    `SELECT COALESCE(
       SUM(b.balance) FILTER (WHERE b.balance > 0),
       0::numeric(14,2)
     )::text AS dues
     FROM v_company_balances b`,
  );
  return r.rows[0]!.dues;
}

export interface ChartDayRow {
  day: string;
  jobs: string;
}

/** Chart 1 — job cards per scheduled IST day, the 30 days ending today, oldest first. */
export async function jobsPerDay(db: Db): Promise<ChartDayRow[]> {
  const r = await db.query<ChartDayRow>(
    `SELECT to_char(business_date(now()) - n, 'YYYY-MM-DD') AS day, count(v.id)::text AS jobs
     FROM generate_series(29, 0, -1) AS n
     LEFT JOIN v_job_cards_dispatcher v ON v.scheduled_date = business_date(now()) - n
     GROUP BY n
     ORDER BY n DESC`,
  );
  return r.rows;
}

export interface ChartWeekRow {
  week_start: string;
  revenue: string;
}

/** Chart 2 — completion revenue per ISO week (Monday start, IST), the 12 weeks ending the current one, oldest first. */
export async function revenuePerWeek(db: Db): Promise<ChartWeekRow[]> {
  const r = await db.query<ChartWeekRow>(
    `SELECT to_char(date_trunc('week', business_date(now()))::date - n, 'YYYY-MM-DD') AS week_start,
            COALESCE(SUM(jc.amount_collected), 0::numeric(14,2))::text AS revenue
     FROM generate_series(77, 0, -7) AS n
     LEFT JOIN job_completions jc
       ON date_trunc('week', jc.business_date)::date = date_trunc('week', business_date(now()))::date - n
     GROUP BY n
     ORDER BY n DESC`,
  );
  return r.rows;
}

// ── the attention feed (§O1: ordered by consequence, not recency) ──────────

/**
 * The feed in one statement, because "ordered by consequence" is an order
 * the DATABASE puts on the rows, not one the client can re-derive from
 * timestamps. `rank` is the consequence order §O1 fixes; `sort_a`/`sort_b`
 * order within a rank by the thing that matters there — the oldest money
 * first, the largest variance first, the most-overdue promise first, the
 * un-permitted handset before a merely quiet one.
 *
 *   1 missing_submission  collected cash, no declaration — the row the
 *                         reconciliation feature exists to catch
 *   2 cash_variance       declared ≠ expected and still unanswered (the
 *                         queue's `variance` flag at declaration_status
 *                         `submitted` — a day the owner has confirmed is his
 *                         own resolved work, not attention; §O2 keeps the
 *                         row visible in the queue instead). `no_expected_cash`
 *                         is today-not-settled noise and is not a problem.
 *   3 overdue_job         the view's is_overdue — the dispatcher's definition,
 *                         so the dashboard cannot disagree with the list
 *   4 tracking_health     stale or permission-missing handsets (§O1's two);
 *                         `never_reported` is onboarding, not a problem
 *   5 contracts expiring  waits for v_contracts_expiring (migration 015,
 *                         Phase 2B) — see the file header
 */
export interface AttentionRow {
  rank: number;
  category: 'missing_submission' | 'cash_variance' | 'overdue_job' | 'tracking_health';
  employee_id: string | null;
  employee_name: string | null;
  business_date: string | null;
  expected_cash: string | null;
  declared_amount: string | null;
  variance: string | null;
  job_id: string | null;
  job_number: string | null;
  job_title: string | null;
  /** pg returns the enum as text; the union is the same claim the dispatcher card row makes. */
  job_status: JobStatus | null;
  scheduled_date: string | null;
  customer_name: string | null;
  health: 'stale' | 'permission_missing' | null;
  last_ping_at: Date | null;
}

export async function attentionFeed(db: Db): Promise<AttentionRow[]> {
  const r = await db.query<AttentionRow>(
    `SELECT * FROM (
       SELECT
         1 AS rank,
         'missing_submission'::text AS category,
         q.employee_id,
         q.employee_name,
         q.business_date::text      AS business_date,
         q.expected_cash::text      AS expected_cash,
         NULL::text                 AS declared_amount,
         NULL::text                 AS variance,
         NULL::uuid                 AS job_id,
         NULL::text                 AS job_number,
         NULL::text                 AS job_title,
         NULL::job_status           AS job_status,
         NULL::text                 AS scheduled_date,
         NULL::text                 AS customer_name,
         NULL::text                 AS health,
         NULL::timestamptz          AS last_ping_at,
         0                          AS sort_a,
         extract(epoch FROM q.business_date)::double precision AS sort_b
       FROM v_cash_reconciliation_queue q
       WHERE q.flag = 'missing_submission'

       UNION ALL

       SELECT
         2,
         'cash_variance',
         q.employee_id,
         q.employee_name,
         q.business_date::text,
         q.expected_cash::text,
         q.declared_amount::text,
         q.variance::text,
         NULL::uuid, NULL::text, NULL::text, NULL::job_status, NULL::text, NULL::text, NULL::text, NULL::timestamptz,
         0,
         (-abs(q.variance))::double precision
       FROM v_cash_reconciliation_queue q
       WHERE q.flag = 'variance'
         AND q.declaration_status = 'submitted'

       UNION ALL

       SELECT
         3,
         'overdue_job',
         NULL::uuid,
         v.assigned_to_name,
         NULL::text,
         NULL::text,
         NULL::text,
         NULL::text,
         v.id,
         v.job_number,
         v.title,
         v.status,
         v.scheduled_date::text,
         c.name,
         NULL::text,
         NULL::timestamptz,
         0,
         extract(epoch FROM v.scheduled_date)::double precision
       FROM v_job_cards_dispatcher v
       JOIN customers c ON c.id = v.customer_id
       WHERE v.is_overdue

       UNION ALL

       SELECT
         4,
         'tracking_health',
         h.employee_id,
         h.employee_name,
         NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::uuid, NULL::text, NULL::text, NULL::job_status, NULL::text, NULL::text,
         h.health::text,
         h.last_ping_at,
         CASE WHEN h.health = 'permission_missing' THEN 0 ELSE 1 END,
         (-COALESCE(h.minutes_since, 0))::double precision
       FROM v_employee_tracking_health h
       WHERE h.health IN ('stale', 'permission_missing')
     ) attention
     ORDER BY rank, sort_a, sort_b, employee_name NULLS LAST, job_number NULLS LAST`,
  );
  return r.rows;
}
