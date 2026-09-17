import { z } from 'zod';

import { uuid } from './schemas.ts';

/**
 * Service calls on the wire (2026-09-17, Yashas): the UPS/battery service
 * cycle. A customer is due six months after their last completed job, and
 * a dispatcher either books the visit or pushes the reminder out three
 * months.
 *
 * Both dates are `YYYY-MM-DD` business days and both are computed on the
 * server (migration 023's `v_service_calls`): a phone clock never decides
 * whether a customer is due, exactly as the AMC reminder facts are not
 * recomputed client-side.
 */
export const SERVICE_CALL_OUTCOMES = ['called', 'no_answer', 'not_interested', 'scheduled'] as const;
export const serviceCallOutcomeSchema = z.enum(SERVICE_CALL_OUTCOMES);
export type ServiceCallOutcome = z.infer<typeof serviceCallOutcomeSchema>;

/** Months between one completed service and the next reminder. */
export const SERVICE_CALL_GAP_MONTHS = 6;
/** The push-back the sheet proposes — "remind me again in three months". */
export const SERVICE_CALL_SNOOZE_MONTHS = 3;

export const ServiceCallSchema = z
  .object({
    customerId: uuid,
    customerName: z.string(),
    phone: z.string(),
    /** The customer's area, when the record has one — never coordinates. */
    area: z.string().nullable(),
    lastServiceOn: z.string().date(),
    lastJobNumber: z.string().nullable(),
    lastJobTitle: z.string().nullable(),
    dueOn: z.string().date(),
    /** The reminder is due this day: `dueOn`, unless a push-back moved it. */
    remindOn: z.string().date(),
    /** The push-back's own date, when the latest call set one. */
    pushedTo: z.string().date().nullable(),
    /** Negative while the reminder is still ahead of today. */
    daysDue: z.number().int(),
    /** Jobs at this customer nobody has finished or cancelled yet. */
    openJobs: z.number().int(),
    lastOutcome: serviceCallOutcomeSchema.nullable(),
    lastNote: z.string().nullable(),
    lastCalledBy: z.string().nullable(),
  })
  .strict();

export type ServiceCall = z.infer<typeof ServiceCallSchema>;

/**
 * The page's two lists: who is due today or overdue, and what has been
 * pushed back (so a dispatcher can see the calls he deferred and when they
 * return). A customer appears in exactly one of them.
 */
export const serviceCallsResponseSchema = z
  .object({
    due: z.array(ServiceCallSchema),
    pushed: z.array(ServiceCallSchema),
  })
  .strict();

export type ServiceCallsResponse = z.infer<typeof serviceCallsResponseSchema>;

/**
 * One call's record. `nextCallOn` moves the reminder out (it can never pull
 * it in — the view takes the later of the two dates); null closes the cycle
 * without a job, which is why the body must say *something*.
 */
export const followUpBodySchema = z
  .object({
    outcome: serviceCallOutcomeSchema,
    note: z.string().trim().max(500).optional(),
    nextCallOn: z.string().date().nullable().optional(),
  })
  .strict()
  .refine((body) => body.nextCallOn != null || (body.note ?? '') !== '', {
    message: 'Pick a date to call again, or say what happened.',
    path: ['nextCallOn'],
  });

export type FollowUpBody = z.infer<typeof followUpBodySchema>;

/** The label a row shows for an outcome — one map, used by every surface. */
export const SERVICE_CALL_OUTCOME_LABELS: Record<ServiceCallOutcome, string> = {
  called: 'Called',
  no_answer: 'No answer',
  not_interested: 'Not interested',
  scheduled: 'Visit booked',
};
