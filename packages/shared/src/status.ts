/**
 * Job status machine (PLAN-BACKEND.md §6.1), defined in packages/shared so
 * client and server agree on what is legal before a request is made.
 *
 * §6.1 rows are transitions; the "who may move it" column is service-side
 * (it needs the actor and the row's assignee), so only the transition graph
 * itself lives here.
 *
 * `en_route` is skippable — `assigned → in_progress` is legal, because a
 * technician already on site should not have to lie to the app to start work.
 */

export const JOB_STATUSES = [
  'unassigned',
  'assigned',
  'en_route',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES = ['completed', 'cancelled'] as const satisfies readonly JobStatus[];

/**
 * The transition graph, one entry per §6.1 row:
 *
 * | From         | To                              | Who (service-side)            |
 * |--------------|---------------------------------|-------------------------------|
 * | unassigned   | assigned                        | dispatcher, owner             |
 * | assigned     | en_route, in_progress           | assigned technician, owner    |
 * | assigned     | assigned (reassign)             | dispatcher, owner             |
 * | en_route     | assigned (reassign)             | dispatcher, owner             |
 * | en_route     | in_progress                     | assigned technician, owner    |
 * | in_progress  | completed                       | assigned technician, owner    |
 * | any non-terminal | cancelled                   | dispatcher, owner; tech w/ reason |
 * | completed, cancelled | —                       | terminal                      |
 *
 * Reassignment is legal from `assigned` and `en_route` and refused from
 * `in_progress` — the service turns that refusal into `409 ILLEGAL_TRANSITION`
 * naming who is on site. Cancelling is legal from every non-terminal state.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  unassigned: ['assigned', 'cancelled'],
  assigned: ['assigned', 'en_route', 'in_progress', 'cancelled'],
  en_route: ['assigned', 'in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** True when `from → to` is a legal job status transition. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Every status `from` may legally move to (empty for terminal states). */
export function allowedTransitions(from: JobStatus): readonly JobStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
