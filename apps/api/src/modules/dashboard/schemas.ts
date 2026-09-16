import { z } from 'zod';
import { isoDateTime, jobStatusSchema, moneyString, signedMoneyString, uuid } from '@servgrid/shared';

/**
 * Owner dashboard response schemas (PLAN.md §8, UI/plan-2/07-OWNER.md §O1).
 * Local to this module on purpose: the four figures and two charts are
 * pinned by the plan docs, and nothing else in the app needs their shape —
 * a shared export would be a second place a "dashboard figure" could
 * drift. Money crosses the wire as decimal strings (§3.4), dates as
 * `YYYY-MM-DD` IST business dates, exactly as the views compute them.
 */

/** One chart day: the IST business date and the job cards scheduled on it. */
export const jobsPerDayPointSchema = z
  .object({
    date: z.string().date(),
    jobs: z.number().int().min(0),
  })
  .strict();

/** One chart week: the ISO week start (Monday, IST) and revenue booked that week. */
export const revenuePerWeekPointSchema = z
  .object({
    weekStart: z.string().date(),
    revenue: moneyString,
  })
  .strict();

/** "Open jobs by status today" — every open status is present, zero included. */
export const openJobsByStatusSchema = z
  .object({
    unassigned: z.number().int().min(0),
    assigned: z.number().int().min(0),
    enRoute: z.number().int().min(0),
    inProgress: z.number().int().min(0),
  })
  .strict();

export const ownerDashboardResponseSchema = z
  .object({
    // Figure 1 — v_job_cards_dispatcher: open jobs on today's IST board, by status.
    openJobsByStatusToday: openJobsByStatusSchema,
    // Figure 2 — v_cash_reconciliation_queue: declared money the owner has not answered yet.
    cashAwaitingConfirmation: moneyString,
    // Figure 3 — job_completions: month-to-date completion revenue, the IST month.
    monthToDateRevenue: moneyString,
    // Figure 4 — v_company_balances: outstanding (positive) balances only; a credit is not a due.
    outstandingCompanyDues: moneyString,
    // Chart 1 — jobs per day, the 30 days ending today, oldest first.
    jobsPerDay: z.array(jobsPerDayPointSchema).length(30),
    // Chart 2 — revenue per week, the 12 ISO weeks ending the current one, oldest first.
    revenuePerWeek: z.array(revenuePerWeekPointSchema).length(12),
  })
  .strict();

export type OwnerDashboardResponse = z.infer<typeof ownerDashboardResponseSchema>;

/**
 * One row of the attention feed. The feed is polymorphic by design —
 * "ordered by consequence, not recency" (§O1) mixes five kinds of trouble
 * into one list — so the row carries every field a kind may need and the
 * `category` says which ones are populated. Ordering is the endpoint's
 * contract, not the client's: the array arrives in consequence order.
 */
export const attentionCategorySchema = z.enum([
  'missing_submission',
  'cash_variance',
  'overdue_job',
  'tracking_health',
  'contract_ending',
]);

export const attentionItemSchema = z
  .object({
    category: attentionCategorySchema,
    /** The person the row is about — the cash handover or the tracked handset. */
    employeeId: uuid.nullable(),
    employeeName: z.string().nullable(),
    /** Cash rows: the IST business day the money was collected on. */
    businessDate: z.string().date().nullable(),
    expectedCash: moneyString.nullable(),
    declaredAmount: moneyString.nullable(),
    /** declared − expected: negative means short (§O2). */
    variance: signedMoneyString.nullable(),
    /** Overdue rows: the job to jump to ("each row links straight to the thing"). */
    jobId: uuid.nullable(),
    jobNumber: z.string().nullable(),
    jobTitle: z.string().nullable(),
    jobStatus: jobStatusSchema.nullable(),
    scheduledDate: z.string().date().nullable(),
    customerName: z.string().nullable(),
    /** Tracking rows: `stale` or `permission_missing` — the two §O1 names. */
    health: z.enum(['stale', 'permission_missing']).nullable(),
    lastPingAt: isoDateTime.nullable(),
    /** AMC rows: the AMC to open. */
    contractId: uuid.nullable(),
    contractNumber: z.string().nullable(),
    contractEndDate: z.string().date().nullable(),
  })
  .strict();

export const ownerAttentionResponseSchema = z
  .object({
    items: z.array(attentionItemSchema),
  })
  .strict();

export type OwnerAttentionResponse = z.infer<typeof ownerAttentionResponseSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;

// ── the performance charts (OW.3, 2026-09-16) ──────────────────────────────

/**
 * The owner's four charts: revenue collected and jobs closed per
 * technician, sales value and sales count per rep. One endpoint serves
 * all four, because they answer for the SAME range — a screen where each
 * chart could be looking at a different week is a screen that invites the
 * wrong comparison.
 *
 * Every series is grouped per day and per person server-side. The client
 * stacks; it never sums money (PLAN.md §6).
 */
export const performanceRangeKeySchema = z.enum(['week', '30d', '90d']);
export type PerformanceRangeKey = z.infer<typeof performanceRangeKeySchema>;

/** `?range=` — the switcher over all four charts. Defaults to this week. */
export const performanceQuerySchema = z
  .object({ range: performanceRangeKeySchema.default('week') })
  .strict();

/** A person a chart stacks or filters by. */
export const performancePersonSchema = z.object({ id: uuid, name: z.string() }).strict();

/** One person's money on one day — absent when they took nothing that day. */
export const performanceMoneyPointSchema = z
  .object({ date: z.string().date(), employeeId: uuid, value: moneyString })
  .strict();

/** One person's count on one day. */
export const performanceCountPointSchema = z
  .object({ date: z.string().date(), employeeId: uuid, count: z.number().int().nonnegative() })
  .strict();

export const ownerPerformanceResponseSchema = z
  .object({
    range: z
      .object({ key: performanceRangeKeySchema, from: z.string().date(), to: z.string().date() })
      .strict(),
    /** Every day in the range, in order — a day nobody worked is a gap, not a missing column. */
    days: z.array(z.string().date()),
    technicians: z.array(performancePersonSchema),
    reps: z.array(performancePersonSchema),
    /** Cash collected (job_completions.amount_collected), by the day the work was done. */
    technicianRevenue: z.array(performanceMoneyPointSchema),
    technicianJobs: z.array(performanceCountPointSchema),
    /** Confirmed sales only, on the sale's own date. */
    repSalesValue: z.array(performanceMoneyPointSchema),
    repSalesCount: z.array(performanceCountPointSchema),
  })
  .strict();

export type OwnerPerformanceResponse = z.infer<typeof ownerPerformanceResponseSchema>;
