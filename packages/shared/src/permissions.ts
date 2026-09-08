/**
 * The permission matrix (PLAN.md §5), expressed once here and imported by
 * both sides (PLAN-BACKEND.md §5). The API turns a scope into a SQL
 * predicate — scoping is applied in the query, never filtered in JavaScript
 * after the fact. The UI uses the same `permit()` to decide what to render,
 * so a screen cannot exist that the API will 403 (PLAN-FRONTEND.md §3).
 *
 * Roles are the DB enum `employee_role` (PLAN-DATA-MODEL.md §2).
 */

export const ROLES = ['owner', 'dispatcher', 'technician', 'sales_rep'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The `Resource` union from PLAN-BACKEND.md §5. Both money splits and both
 * location splits are load-bearing — do not collapse either pair:
 *
 * - `job.money` / `contract.money` — revenue is guarded wherever it lives,
 *   not only in `job_completions`; the dispatcher guarantee covers
 *   `service_contracts.contract_value` too.
 * - `location.read` / `location.health` — *where someone is* (owner alone)
 *   is not *whether the device is reporting* (dispatcher's roster warning,
 *   no coordinates in it). Without the split the choice was a live map of
 *   eight people on the desk, or a warning reading data the matrix forbids.
 */
export const RESOURCES = [
  'job',
  'job.money',
  'job.assign',
  'customer',
  'customer.stack',
  'company',
  'contract',
  'contract.money',
  'sale',
  'payment',
  'cash.declare',
  'cash.confirm',
  'employee',
  'location.read',
  'location.health',
  'location.send',
] as const;
export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Three scopes beyond all/none, and the distinction matters (§5):
 * - `own` — rows where the actor is the author or owner (`sales_rep_id`,
 *   `received_by`, `employee_id`, `companies.owner_rep_id`).
 * - `assigned` — rows reachable *through* an assignment. A technician reads
 *   a customer not because he created it but because he has a job there.
 */
export type Scope = 'all' | 'own' | 'assigned' | 'none';

/**
 * The matrix, transcribed cell-for-cell from PLAN.md §5 with the scope
 * refinements from PLAN-BACKEND.md §5 and PLAN-GAPS.md G1/G3:
 *
 * | Resource          | Technician                        | Dispatcher            | Sales Rep                          | Owner            |
 * |-------------------|-----------------------------------|-----------------------|------------------------------------|------------------|
 * | job (own)         | read/status/complete/cancel       | —                     | —                                  | full             |
 * | job (all)         | —                                 | CRUD + assign         | —                                  | full             |
 * | job.money         | writes own at completion          | none                  | —                                  | full, amends     |
 * | customer          | read (assigned only)              | create/read/update    | —                                  | full             |
 * | customer.stack    | update                            | —                     | —                                  | full             |
 * | company           | —                                 | none                  | own accounts + house accounts      | full             |
 * | contract          | visit context, resched/spend      | context, dates/skip   | contracts he sold                  | full             |
 * | contract.money    | —                                 | none                  | —                                  | full             |
 * | sale              | —                                 | —                     | own                                | full             |
 * | payment           | —                                 | —                     | own                                | full             |
 * | cash.declare      | declares own                      | —                     | declares own                       | confirm/reopen   |
 * | cash.confirm      | —                                 | —                     | —                                  | all              |
 * | employee          | self                              | self                  | self                               | full             |
 * | location.read     | —                                 | —                     | —                                  | all              |
 * | location.health   | own row                           | health only           | own row                            | all              |
 * | location.send     | sends                             | —                     | sends                              | all              |
 *
 * `owner` is `all` on every resource and every action — the `full` cells
 * above — which also covers deletion.
 */
const cell = (read: Scope, create: Scope, update: Scope, del: Scope): Record<Action, Scope> => ({
  read,
  create,
  update,
  delete: del,
});

/**
 * The matrix, cell-for-cell from PLAN.md §5 with the scope refinements from
 * PLAN-BACKEND.md §5 and PLAN-GAPS.md G1/G3 (see the table in the header).
 * Cells are per-action on purpose: the docs need the asymmetry — the owner
 * reads the whole cash queue yet never declares; a dispatcher reads
 * customers but cannot create one.
 *
 * `owner` is `all` on every resource and every action — the `full` cells in
 * PLAN.md §5 — which also covers deletion.
 */
const MATRIX: Readonly<Record<Role, Readonly<Record<Resource, Record<Action, Scope>>>>> = {
  owner: {
    job: cell('all', 'all', 'all', 'all'),
    'job.money': cell('all', 'all', 'all', 'all'),
    'job.assign': cell('all', 'all', 'all', 'all'),
    customer: cell('all', 'all', 'all', 'all'),
    'customer.stack': cell('all', 'all', 'all', 'all'),
    company: cell('all', 'all', 'all', 'all'),
    contract: cell('all', 'all', 'all', 'all'),
    'contract.money': cell('all', 'all', 'all', 'all'),
    sale: cell('all', 'all', 'all', 'all'),
    payment: cell('all', 'all', 'all', 'all'),
    'cash.declare': cell('all', 'none', 'none', 'none'), // confirms/reopens; does not declare
    'cash.confirm': cell('all', 'all', 'all', 'all'),
    employee: cell('all', 'all', 'all', 'all'),
    'location.read': cell('all', 'all', 'all', 'all'),
    'location.health': cell('all', 'all', 'all', 'all'),
    'location.send': cell('all', 'all', 'all', 'all'),
  },

  dispatcher: {
    job: cell('all', 'all', 'all', 'all'), // all jobs CRUD + assign; reads v_job_cards_dispatcher
    'job.money': cell('none', 'none', 'none', 'none'), // the revenue guarantee
    'job.assign': cell('all', 'all', 'all', 'all'),
    customer: cell('all', 'all', 'all', 'none'), // create/read/update; company_id stripped server-side
    'customer.stack': cell('none', 'none', 'none', 'none'),
    company: cell('none', 'none', 'none', 'none'), // no company permission at all (PLAN.md §5)
    contract: cell('all', 'none', 'all', 'none'), // context + due dates + skips, via v_contract_visits_dispatcher
    'contract.money': cell('none', 'none', 'none', 'none'), // that view has no value column
    sale: cell('none', 'none', 'none', 'none'),
    payment: cell('none', 'none', 'none', 'none'),
    'cash.declare': cell('none', 'none', 'none', 'none'),
    'cash.confirm': cell('none', 'none', 'none', 'none'),
    employee: cell('own', 'none', 'own', 'none'), // self only
    'location.read': cell('none', 'none', 'none', 'none'), // never a position
    'location.health': cell('all', 'none', 'none', 'none'), // roster warning; last-ping age, no coordinates
    'location.send': cell('none', 'none', 'none', 'none'),
  },

  technician: {
    job: cell('own', 'own', 'own', 'own'), // own jobs: read, status, complete, cancel
    'job.money': cell('none', 'own', 'none', 'none'), // write-once at completion — the MoneyGate cell
    'job.assign': cell('none', 'none', 'none', 'none'),
    customer: cell('assigned', 'none', 'none', 'none'), // read, assigned only — through a job
    'customer.stack': cell('none', 'none', 'assigned', 'assigned'), // at sites he has/had a job for
    company: cell('none', 'none', 'none', 'none'),
    contract: cell('assigned', 'none', 'assigned', 'none'), // the contract behind his visit
    'contract.money': cell('none', 'none', 'none', 'none'),
    sale: cell('none', 'none', 'none', 'none'),
    payment: cell('none', 'none', 'none', 'none'),
    'cash.declare': cell('own', 'own', 'own', 'none'), // declares own
    'cash.confirm': cell('none', 'none', 'none', 'none'),
    employee: cell('own', 'none', 'own', 'none'), // self
    'location.read': cell('none', 'none', 'none', 'none'),
    'location.health': cell('own', 'none', 'none', 'none'), // the health chip on his own profile (§8)
    'location.send': cell('own', 'own', 'none', 'none'), // sends
  },

  sales_rep: {
    job: cell('none', 'none', 'none', 'none'),
    'job.money': cell('none', 'none', 'none', 'none'),
    'job.assign': cell('none', 'none', 'none', 'none'),
    customer: cell('none', 'none', 'none', 'none'),
    'customer.stack': cell('none', 'none', 'none', 'none'),
    company: cell('own', 'own', 'own', 'none'), // owner_rep_id = actor OR owner_rep_id IS NULL (G3); create sets owner_rep_id = creator
    contract: cell('own', 'own', 'own', 'none'), // contracts he sold — scoped by sold_by (§11.1)
    'contract.money': cell('own', 'own', 'own', 'none'), // reads the value of what he sold
    sale: cell('own', 'own', 'own', 'none'), // own sales; owner voids
    payment: cell('own', 'own', 'own', 'none'), // own payments; owner voids
    'cash.declare': cell('own', 'own', 'own', 'none'), // reps declare too (PLAN-GAPS G2)
    'cash.confirm': cell('none', 'none', 'none', 'none'),
    employee: cell('own', 'none', 'own', 'none'), // self
    'location.read': cell('none', 'none', 'none', 'none'),
    'location.health': cell('own', 'none', 'none', 'none'), // his own chip
    'location.send': cell('own', 'own', 'none', 'none'), // sends
  },
};

/**
 * Resolve the scope of one `role × resource × action` cell. A pure lookup:
 * every row-scoped rule (technician `job.money` write-once-no-read,
 * dispatcher `location.health` without `location.read`, `own` on `company`
 * as `owner_rep_id = actor OR owner_rep_id IS NULL`) is encoded in the cell
 * itself and pinned by permissions.test.ts — there is no second place for
 * a permission to hide.
 */
export function permit(role: Role, resource: Resource, action: Action): Scope {
  return MATRIX[role][resource][action];
}
