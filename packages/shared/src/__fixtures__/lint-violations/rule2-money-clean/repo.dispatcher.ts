/**
 * Control — a dispatcher repo module with ordinary, legal SQL. Must stay
 * clean: the money-tables rule fires on the revenue tables, not on
 * dispatcher work itself (the dispatcher reads the dispatcher views).
 */

/** Legal dispatcher query: reads the dispatcher view, not revenue tables. */
export const dispatcherJobCards = `
  SELECT id, status, scheduled_date
  FROM v_job_cards_dispatcher
  WHERE technician_id = $1
`;
