import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import {
  type FollowUpBody,
  type ServiceCall,
  type ServiceCallsResponse,
} from '@servgrid/shared';
import {
  insertFollowUp,
  listDue,
  listPushed,
  serviceCallForCustomer,
  type ServiceCallRow,
} from './repo.js';

/**
 * Service calls (migration 023). Thin on purpose: the whole cycle is
 * derived in `v_service_calls`, so the service's only jobs are to phrase
 * the two refusals and map rows to the wire.
 */

/** A customer who has never been served has no cycle to remind anybody about. */
const NOT_SERVED_MESSAGE = "That customer has no completed job yet, so there is nothing to remind you about.";

function toCall(row: ServiceCallRow): ServiceCall {
  return {
    customerId: row.customer_id,
    customerName: row.customer_name,
    phone: row.phone,
    area: row.area,
    lastServiceOn: row.last_service_on,
    lastJobNumber: row.last_job_number,
    lastJobTitle: row.last_job_title,
    dueOn: row.due_on,
    pushedTo: row.pushed_to,
    remindOn: row.remind_on,
    daysDue: row.days_due,
    openJobs: row.open_jobs,
    lastOutcome: row.last_outcome,
    lastNote: row.last_note,
    lastCalledBy: row.last_called_by,
  };
}

export function createServiceCallsService() {
  return {
    /** Both lists at once — the page shows them together, and two reads are cheaper than two round trips. */
    async list(): Promise<ServiceCallsResponse> {
      const [due, pushed] = await Promise.all([listDue(getPool()), listPushed(getPool())]);
      return { due: due.map(toCall), pushed: pushed.map(toCall) };
    },

    /**
     * Record a call. The customer must have been served once — a follow-up
     * against a customer with no completed job would be a note the
     * reminder page could never show (the view only carries served
     * customers), so it is refused rather than silently stored.
     */
    async recordCall(input: { id: string; customerId: string; body: FollowUpBody }): Promise<ServiceCall | null> {
      const before = await serviceCallForCustomer(getPool(), input.customerId);
      if (before === null) throw new AppError('NOT_FOUND', NOT_SERVED_MESSAGE);

      await insertFollowUp(getPool(), input.customerId, input.id, {
        outcome: input.body.outcome,
        note: input.body.note?.trim() === '' ? null : (input.body.note ?? null),
        nextCallOn: input.body.nextCallOn ?? null,
      });

      // The answer is the customer's state AFTER the call, read back
      // through the view, so the screen never predicts the new date.
      return serviceCallForCustomer(getPool(), input.customerId).then((row) => (row === null ? null : toCall(row)));
    },
  };
}

export type ServiceCallsService = ReturnType<typeof createServiceCallsService>;
