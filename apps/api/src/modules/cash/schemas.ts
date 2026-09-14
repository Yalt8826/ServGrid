import { z } from 'zod';
import { isoDateTime, moneyString, uuid } from '@servgrid/shared';

/**
 * The queue's day breakdown (PHASE-4-OWNER.md T4.9, UI/plan-2/07-OWNER.md
 * §O2 "View the day"). Local to this module on purpose — the same rule
 * the dashboard module runs: the shape is pinned by the one screen that
 * reads it, and a shared export would be a second place it could drift.
 *
 * §O2: *View the day* — "the completions and payments behind the expected
 * figure, so the owner can see which jobs produced the cash." Both lists
 * are the CASH side only (collection_mode='cash' completions, mode='cash'
 * collected payments) — exactly the two SELECTs
 * `v_employee_expected_cash` unions, for one (employee, business_date),
 * so the two totals the response carries always add up to the expected
 * figure the queue row shows. A UPI payment is company money, never
 * handover money; listing it here would re-introduce the confusion the
 * view exists to end.
 */

export const cashQueueDayQuerySchema = z
  .object({
    employeeId: uuid,
    businessDate: z.string().date(),
  })
  .strict();

export type CashQueueDayQuery = z.infer<typeof cashQueueDayQuerySchema>;

/** One cash completion behind the expected figure — the job that produced it. */
export const cashDayCompletionSchema = z
  .object({
    jobId: uuid,
    jobNumber: z.string(),
    customerName: z.string().nullable(),
    workSummary: z.string(),
    amountCollected: moneyString,
    completedAt: isoDateTime,
  })
  .strict();

/** One collected cash payment behind the expected figure (the rep side, §10). */
export const cashDayPaymentSchema = z
  .object({
    paymentId: uuid,
    paymentNumber: z.string(),
    companyName: z.string(),
    amount: moneyString,
    receivedAt: isoDateTime,
  })
  .strict();

export const cashQueueDayResponseSchema = z
  .object({
    employeeId: uuid,
    employeeName: z.string(),
    businessDate: z.string().date(),
    completions: z.array(cashDayCompletionSchema),
    cashPayments: z.array(cashDayPaymentSchema),
    /** SUM(cash completions) — matches `v_employee_expected_cash`'s completions side. */
    completionTotal: moneyString,
    /** SUM(collected cash payments) — matches its payments side. */
    paymentTotal: moneyString,
  })
  .strict();

export type CashQueueDayResponse = z.infer<typeof cashQueueDayResponseSchema>;
export type CashDayCompletion = z.infer<typeof cashDayCompletionSchema>;
export type CashDayPayment = z.infer<typeof cashDayPaymentSchema>;
