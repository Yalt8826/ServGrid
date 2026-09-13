import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { permit, type Action, type Resource, type Role, type Scope } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from './auth.js';
import { AppError } from './errors.js';

/**
 * RBAC plugin (PLAN-BACKEND.md §5): `req.can(resource, action)` plus
 * scope resolution. The point of the plugin is the predicate: it turns a
 * scope into a SQL fragment the repo composes into its WHERE clause, so
 * scoping is applied *in the query*, never by filtering rows in
 * JavaScript after the fact. A filter applied after a SELECT is a filter
 * someone can forget in the next endpoint; a predicate in the query text
 * cannot be forgotten, only left out — and the authz suites fail loudly
 * when it is.
 *
 * The scope still comes from the one matrix in `packages/shared`, so the
 * API and the UI cannot drift. What lives here is only the translation:
 *
 * | Scope      | Predicate                                              |
 * |------------|--------------------------------------------------------|
 * | `all`      | none — the builder returns null                        |
 * | `own`      | actor is author or owner (`owner_rep_id = $n OR NULL`  |
 * |            | for company; other resources register their columns    |
 * |            | when their tables land)                                |
 * | `assigned` | reachable through an assignment — EXISTS over          |
 * |            | `job_cards`, present tense or closed, never only open  |
 * | `none`     | 403 before any query is built                          |
 *
 * Registration is deliberate, not exhaustive: an entry appears here when
 * the table it names exists (plan-data-model migrations), so a scope with
 * no registered predicate fails at query-build time — a programmer error,
 * never a silently unscoped query. `sale` is the next entry; it lands
 * with migration 011.
 */

/** The generic refusal for a role the matrix gives nothing on a cell. */
export const FORBIDDEN_MESSAGE = 'You do not have permission to do that.';

/** The refusal for a whole-table surface reached with a row-scoped cell. */
export const FORBIDDEN_ALL_MESSAGE =
  'You do not have permission to see this — it covers more than your own work.';

/** A predicate a repo composes into its WHERE clause with AND. */
export interface ScopePredicate {
  /**
   * WHERE fragment whose placeholders are numbered from the `paramStart`
   * the caller passed, so it drops into a query that already binds values.
   */
  sql: string;
  /** One value per placeholder, in order. The actor id is always bound, never interpolated. */
  params: unknown[];
}

export interface ScopePredicateOptions {
  /**
   * How the resource's own table is spelled in the caller's query — its
   * plain name or the alias the query gives it (`FROM companies c` →
   * `'c'`). Defaults to the table's plain name.
   */
  qualifier?: string;
  /** Placeholder number the predicate's first bound value takes. Default 1. */
  paramStart?: number;
}

interface PredicateArgs {
  actorId: string;
  paramStart: number;
  qualifier: string;
}

type PredicateBuilder = (args: PredicateArgs) => ScopePredicate;

interface ResourcePredicates {
  /** The resource's table, as a query spells it before aliasing. */
  table: string;
  own?: PredicateBuilder;
  assigned?: PredicateBuilder;
}

const PREDICATES: Partial<Record<Resource, ResourcePredicates>> = {
  job: {
    table: 'job_cards',
    // A technician's own jobs — present tense or closed, no status filter
    // on purpose: the completed job is the ordinary read (his history, the
    // customer stack at a site he has worked), and §6.1's who-column, not
    // the matrix, decides what he may then *do* to the row. Registered
    // with the jobs module (T1.5); the matrix grants the cell, so the
    // predicate had to exist before a scoped jobs query could run.
    own: ({ actorId, paramStart, qualifier }) => ({
      sql: `${qualifier}.assigned_to = $${paramStart}`,
      params: [actorId],
    }),
  },
  company: {
    table: 'companies',
    // `own` on company is ownership with a house-account floor (G3): a
    // NULL owner_rep_id is every rep's business, and since only the owner
    // may change the column, a rep can neither claim nor hand off an
    // account — that is also how leave is covered.
    own: ({ actorId, paramStart, qualifier }) => ({
      sql: `(${qualifier}.owner_rep_id = $${paramStart} OR ${qualifier}.owner_rep_id IS NULL)`,
      params: [actorId],
    }),
  },
  customer: {
    table: 'customers',
    // `assigned` reaches the customer *through* an assignment — he reads
    // a site because he has a job there, present tense or closed. No
    // status filter on purpose: the completed job is the ordinary case,
    // and a stack edit the day after closing must still be in scope.
    assigned: ({ actorId, paramStart, qualifier }) => ({
      sql: `EXISTS (SELECT 1 FROM job_cards jc WHERE jc.customer_id = ${qualifier}.id AND jc.assigned_to = $${paramStart})`,
      params: [actorId],
    }),
  },
  sale: {
    table: 'sales_cards',
    // `own` on sale is authorship (§5: `sales_rep_id`): the rep who made
    // the sale reads and edits HIS cards — another rep's sale is OUT_OF_SCOPE
    // at the row, and voiding is not a matrix scope at all but a door check
    // (owner only, the companies /owner precedent), because the matrix
    // cannot express "the same cell that lets him confirm must not let him
    // void". Registered with the sales module (T3.3); the matrix grants
    // sales_rep `own`, so the predicate had to exist before a scoped sales
    // query could run.
    own: ({ actorId, paramStart, qualifier }) => ({
      sql: `${qualifier}.sales_rep_id = $${paramStart}`,
      params: [actorId],
    }),
  },
  'customer.stack': {
    table: 'customer_products',
    // §6.4: a technician's scope on the stack is `assigned`, not `all` —
    // he corrects the equipment record at a site he has or has had a job
    // for, never at large. Same reach as `customer` × `assigned`, one
    // join further: the STACK row scopes through its customer. Registered
    // with the customers module (T2.4); the matrix grants technician
    // `assigned` on update/delete, so the predicate had to exist before a
    // scoped stack write could run.
    assigned: ({ actorId, paramStart, qualifier }) => ({
      sql: `EXISTS (SELECT 1 FROM job_cards jc WHERE jc.customer_id = ${qualifier}.customer_id AND jc.assigned_to = $${paramStart})`,
      params: [actorId],
    }),
  },
};

export interface ScopePredicateInput extends ScopePredicateOptions {
  role: Role;
  actorId: string;
  resource: Resource;
  action: Action;
}

/**
 * The actor's scope on one matrix cell, as a composable SQL predicate.
 * `all` returns null — no restriction, the repo writes no fragment.
 * `none` throws FORBIDDEN before any query exists. `own` and `assigned`
 * return the registered builder's fragment; a scope with no builder is a
 * query that was written before its predicate was registered, and fails
 * here rather than running unscoped.
 */
export function scopePredicate(input: ScopePredicateInput): ScopePredicate | null {
  const { role, actorId, resource, action } = input;
  const scope = permit(role, resource, action);

  if (scope === 'all') return null;
  if (scope === 'none') {
    throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }

  const entry = PREDICATES[resource];
  const builder = entry?.[scope];
  if (!entry || !builder) {
    throw new Error(
      `rbac: no ${scope} predicate registered for ${resource} — the matrix grants this cell, ` +
        'so plugins/rbac.ts must turn it into SQL before the module that queries it lands',
    );
  }

  return builder({
    actorId,
    paramStart: input.paramStart ?? 1,
    qualifier: input.qualifier ?? entry.table,
  });
}

function claimsOf(request: FastifyRequest): { sub: string; role: Role } {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return auth;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * preHandler factory — 403 unless the matrix grants the cell at all
     * (scope `none` is refused). Attach after `requireAuth`.
     */
    requirePermission: (
      resource: Resource,
      action: Action,
      message?: string,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler factory for whole-table surfaces — 403 unless the cell
     * is `all`. A row-scoped cell (`own`, `assigned`) cannot satisfy an
     * endpoint that takes an arbitrary id or lists every row; self
     * service lives on /me-shaped routes keyed off the token instead.
     */
    requireAll: (
      resource: Resource,
      action: Action,
      message?: string,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** True when the matrix grants the cell at all — i.e. the scope is not `none`. */
    can(resource: Resource, action: Action): boolean;
    /** The raw scope from the matrix — the same cell the UI's `permit()` reads. */
    scope(resource: Resource, action: Action): Scope;
    /** 403 when the scope is `none` — call before building any query. */
    require(resource: Resource, action: Action, message?: string): void;
    /** 403 unless the scope is `all` — for whole-table (admin) surfaces. */
    requireAll(resource: Resource, action: Action, message?: string): void;
    /**
     * The actor's scope as a SQL predicate (see `scopePredicate`), or
     * null when `all`. Repos compose it into the query; they never
     * filter result rows in JavaScript.
     */
    scopePredicate(resource: Resource, action: Action, options?: ScopePredicateOptions): ScopePredicate | null;
  }
}

export const rbacPlugin = fp(
  async (app) => {
    app.decorateRequest('can', function can(this: FastifyRequest, resource: Resource, action: Action) {
      return this.scope(resource, action) !== 'none';
    });

    app.decorateRequest('scope', function scope(this: FastifyRequest, resource: Resource, action: Action): Scope {
      return permit(claimsOf(this).role, resource, action);
    });

    app.decorateRequest(
      'require',
      function requireScope(this: FastifyRequest, resource: Resource, action: Action, message?: string) {
        if (this.scope(resource, action) === 'none') {
          throw new AppError('FORBIDDEN', message ?? FORBIDDEN_MESSAGE);
        }
      },
    );

    app.decorateRequest(
      'requireAll',
      function requireAllScope(this: FastifyRequest, resource: Resource, action: Action, message?: string) {
        if (this.scope(resource, action) !== 'all') {
          throw new AppError('FORBIDDEN', message ?? FORBIDDEN_ALL_MESSAGE);
        }
      },
    );

    app.decorateRequest(
      'scopePredicate',
      function scopePredicateFor(
        this: FastifyRequest,
        resource: Resource,
        action: Action,
        options?: ScopePredicateOptions,
      ) {
        const auth = claimsOf(this);
        return scopePredicate({ role: auth.role, actorId: auth.sub, resource, action, ...options });
      },
    );

    // Async on purpose (see employees routes): Fastify's hook runner
    // advances a preHandler list only when the hook returns a thenable.
    app.decorate(
      'requirePermission',
      (resource, action, message) =>
        async function requirePermission(request: FastifyRequest) {
          request.require(resource, action, message);
        },
    );
    app.decorate(
      'requireAll',
      (resource, action, message) =>
        async function requireAll(request: FastifyRequest) {
          request.requireAll(resource, action, message);
        },
    );
  },
  { name: 'rbac', fastify: '5.x', dependencies: ['request-context', 'auth'] },
);
