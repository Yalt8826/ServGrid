/**
 * Shared zod schemas — request + response, per endpoint (T0.5 build list).
 * Imported by the API for validation (PLAN-BACKEND.md §3.4: on both request
 * body and response) and by the app for payload typing. The apps already
 * depend on zod, so the package declares it as a peer dependency and is
 * resolved by the workspace install.
 *
 * Shape rules the docs pin down:
 * - Response shape **by role** is enforced by separate schemas, not one
 *   schema with optional fields — `JobCardTechnician` / `JobCardDispatcher`
 *   / `JobCardOwner` (§6.3). An optional field is a field that can leak.
 * - Dispatcher payloads carry no money and no `companyId`; the server
 *   strips `customers.company_id` rather than merely omitting the form
 *   field (§5 rule 3).
 * - `completedAt` is clamped server-side, not in the future and not more
 *   than 14 days old (§6.2 step 1 and the clamp paragraph).
 */
import { z, type ZodTypeAny } from 'zod';

import { ACTIONS, RESOURCES, ROLES, SCOPES } from './permissions.ts';
import { JOB_STATUSES } from './status.ts';
import { PING_REJECT_CODES } from './errors.ts';
import { FEATURE_FLAGS } from './flags.ts';

// ── primitives ──────────────────────────────────────────────────────────────

/** JS numbers lose cents above 2^53/1000; money crosses the wire as a decimal string like "1234.50". */
export const moneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'decimal amount as a string, e.g. "1234.50"');

/**
 * Money that may be negative — the ledger and the balance views deal in
 * signed figures. A sale is positive and a payment negative (§S4's
 * `+ ₹16,800 / − ₹40,000`), and an overpayment leaves a company's balance
 * negative on purpose: a credit is a real state and good news, rendered by
 * the UI as "Credit", never as a minus in red. The plain `moneyString`
 * above stays unsigned — it types document amounts as entered.
 */
export const signedMoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'signed decimal amount as a string, e.g. "1234.50" or "-800.00"');

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });

// ── enum mirrors ────────────────────────────────────────────────────────────

export const jobStatusSchema = z.enum(JOB_STATUSES);
export const resourceSchema = z.enum(RESOURCES);
export const actionSchema = z.enum(ACTIONS);
export const scopeSchema = z.enum(SCOPES);
export const roleSchema = z.enum(ROLES);
export const pingRejectCodeSchema = z.enum(PING_REJECT_CODES);

// ── jobs (§6) ───────────────────────────────────────────────────────────────

export const jobStatusChangeSchema = z
  .object({
    to: jobStatusSchema,
    occurredAt: isoDateTime,
  })
  .strict();

/**
 * One `stackChanges[]` line (§6.2 step 5): a unit that now STANDS at the
 * site. The server upserts it into `customer_products` inside the
 * completion transaction, stamped `source_job_id` — the audit trail from
 * stack row back to the job that caused it (PLAN-DATA-MODEL.md §3.3).
 * Third-party kit has no SKU: `freeTextName` carries it when `productId`
 * is absent (the same shape as the customer_products CHECK).
 */
export const jobStackChangeSchema = z
  .object({
    productId: uuid.optional(),
    freeTextName: z.string().min(1).max(200).optional(),
    serialNumber: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(9999).optional(),
    installedOn: z.string().date().optional(),
    warrantyExpiresOn: z.string().date().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.productId !== undefined || v.freeTextName !== undefined, {
    message: 'Name the equipment — pick a product or type what it is.',
  });

/**
 * One `parts[]` line (§6.2 step 6): what was fitted or consumed on the
 * job. A record, never a bill — `unit_cost` is optional because a
 * technician in a stairwell does not know it, and nothing here touches
 * `cost` (PLAN-DATA-MODEL.md §3.4).
 */
export const jobCompletionPartSchema = z
  .object({
    productId: uuid.optional(),
    freeTextName: z.string().min(1).max(200).optional(),
    /** numeric(10,2), CHECK (quantity > 0) — the DB is the backstop. */
    quantity: z.number().min(0.01).max(99_999_999.99),
    unitCost: moneyString.optional(),
    serialNumber: z.string().min(1).max(200).optional(),
    fromCustomerStock: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.productId !== undefined || v.freeTextName !== undefined, {
    message: 'Name the part — pick a product or type what it is.',
  });

export const jobCompleteSchema = z
  .object({
    completedAt: isoDateTime,
    workSummary: z.string().min(1),
    /** Absent/zero only; the DB constraint and service rule carry the discount rule. */
    cost: moneyString.optional(),
    discountAmount: moneyString.optional(),
    discountReason: z.string().optional(),
    amountCollected: moneyString.optional(),
    collectionMode: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'none']).optional(),
    paymentReference: z.string().optional(),
    customerSigned: z.boolean().optional(),
    stackChanges: z.array(jobStackChangeSchema).max(50).optional(),
    parts: z.array(jobCompletionPartSchema).max(50).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.discountAmount === undefined ||
      /^0(\.0{1,2})?$/.test(v.discountAmount) || // a zero discount is no discount — the DB asks for no reason either (§3.4)
      (v.discountReason !== undefined && v.discountReason.length > 0),
    { message: 'A discount requires a reason.' },
  );

export const jobAssignSchema = z
  .object({ technicianId: uuid })
  .strict();

/**
 * One entry of `POST /v1/jobs/bulk-assign` (§6.3). A multi-select spans
 * cards the dispatcher last saw at DIFFERENT versions, so the bulk
 * request carries the precondition per job — the body form of the
 * `If-Match` header the single assign takes: the picker sends, for every
 * selected card, the version it showed.
 */
export const jobBulkAssignEntrySchema = z
  .object({
    id: uuid,
    /** The card version the picker showed — the per-job `If-Match` (§6.3). */
    ifMatch: z.number().int().min(1),
  })
  .strict();

export const jobBulkAssignSchema = z
  .object({
    jobIds: z.array(jobBulkAssignEntrySchema).min(1).max(50),
    technicianId: uuid,
  })
  .strict()
  .refine((v) => new Set(v.jobIds.map((j) => j.id)).size === v.jobIds.length, {
    message: 'The same job appears twice in the selection.',
  });

export const jobCancelSchema = z
  .object({
    reasonCode: z.enum([
      'customer_unavailable',
      'customer_cancelled',
      'duplicate',
      'wrong_details',
      'no_access',
      'parts_unavailable',
      'rescheduled_by_office',
      'contract_cancelled',
      'other',
    ]),
    /** `other` requires a note (the DB CHECK carries the same rule). */
    reasonNote: z.string().optional(),
    rescheduleTo: z.string().date().optional(),
  })
  .strict()
  .refine((v) => v.reasonCode !== 'other' || (v.reasonNote !== undefined && v.reasonNote.length > 0), {
    message: 'A cancellation with reason “other” requires a note.',
  });

/**
 * PATCH /v1/jobs/:id of `scheduled_for` (§6.3) — rescheduling. Moving a
 * job to another day is NOT a cancellation (PLAN-DATA-MODEL.md §3.4):
 * this is the office's path for it, sent under `If-Match`, emitting a
 * `rescheduled` event and leaving status alone. The technician on site
 * does not call this — he cancels with a `rescheduleTo` and lets the
 * successor carry the new date.
 */
export const jobRescheduleSchema = z
  .object({
    scheduledFor: isoDateTime,
  })
  .strict();

export type JobCancel = z.infer<typeof jobCancelSchema>;
export type JobReschedule = z.infer<typeof jobRescheduleSchema>;

// ── job card responses — one schema per role, no optional-field overlaps ────

export const JobCardTechnicianSchema = z
  .object({
    id: uuid,
    jobNumber: z.string(),
    title: z.string(),
    status: jobStatusSchema,
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    scheduledFor: isoDateTime.nullable(),
    customerId: uuid,
    contactName: z.string().nullable(),
    contactPhone: z.string().nullable(),
    description: z.string().nullable(),
    contract: z
      .object({
        number: z.string(),
        billing: z.enum(['upfront', 'per_visit']),
        visitsRemaining: z.number().int(),
      })
      .nullable(),
    version: z.number().int(),
  })
  .strict();

export const JobCardDispatcherSchema = z
  .object({
    id: uuid,
    jobNumber: z.string(),
    title: z.string(),
    status: jobStatusSchema,
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    scheduledFor: isoDateTime.nullable(),
    customerId: uuid,
    customerName: z.string(),
    assignedTo: uuid.nullable(),
    isOverdue: z.boolean(),
    isContractVisit: z.boolean(),
    version: z.number().int(),
  })
  .strict(); // money-free by construction — v_job_cards_dispatcher has no value column

export const JobCardOwnerSchema = JobCardDispatcherSchema.extend({
  cost: moneyString.nullable(),
  discountAmount: moneyString.nullable(),
  discountReason: z.string().nullable(),
  amountCollected: moneyString.nullable(),
  collectionMode: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'none']).nullable(),
}).strict();

export type JobCardTechnician = z.infer<typeof JobCardTechnicianSchema>;
export type JobCardDispatcher = z.infer<typeof JobCardDispatcherSchema>;
export type JobCardOwner = z.infer<typeof JobCardOwnerSchema>;
export type JobStackChange = z.infer<typeof jobStackChangeSchema>;
export type JobCompletionPart = z.infer<typeof jobCompletionPartSchema>;

// ── assignment (§6.3): bulk results and the technician-load picker ──────────

/**
 * `POST /v1/jobs/bulk-assign` — partial results, one entry per requested
 * job, honest about both outcomes (§6.3; UI/plan-2/05-DISPATCHER.md §D2:
 * "5 reassigned, 1 failed — JC-…0044 was completed while you were
 * choosing"). Applied entries carry the reassigned card; refused entries
 * carry the machine code and the sentence the dispatcher reads.
 */
export const BulkAssignAppliedSchema = (card: ZodTypeAny) =>
  z
    .object({
      jobId: uuid,
      jobNumber: z.string(),
      ok: z.literal(true),
      job: card,
    })
    .strict();

/** Codes a single job inside a bulk can refuse with (the whole-request refusals — 403, 428 — never appear per job). */
export const BULK_ASSIGN_REFUSAL_CODES = ['NOT_FOUND', 'VERSION_CONFLICT', 'ILLEGAL_TRANSITION'] as const;

export const BulkAssignRefusedSchema = z
  .object({
    jobId: uuid,
    jobNumber: z.string(),
    ok: z.literal(false),
    code: z.enum(BULK_ASSIGN_REFUSAL_CODES),
    message: z.string(),
  })
  .strict();

export const BulkAssignResponseSchema = (card: ZodTypeAny): ZodTypeAny =>
  z
    .object({
      results: z.array(
        z.discriminatedUnion('ok', [BulkAssignAppliedSchema(card), BulkAssignRefusedSchema]),
      ),
    })
    .strict();

/**
 * `GET /v1/technicians/load` — one row of `v_technician_load` (migration
 * 013) for the assignment picker and the dashboard's load list. This is
 * also how a dispatcher gets technician NAMES — `GET /v1/employees` is
 * owner-only — so the response carries the name and the load and nothing
 * else: no completion fields, no money, nothing per job.
 */
export const TechnicianLoadSchema = z
  .object({
    employeeId: uuid,
    technicianName: z.string(),
    openToday: z.number().int(),
    doneToday: z.number().int(),
    openTotal: z.number().int(),
    /** The promised start of the job he is currently ON (in_progress); null when idle. */
    activeSince: isoDateTime.nullable(),
  })
  .strict();

export type TechnicianLoad = z.infer<typeof TechnicianLoadSchema>;

// ── dispatcher dashboard (§6.3 GET /v1/jobs/summary, UI/plan-2/05 §D1) ──────

/**
 * `GET /v1/jobs/summary` — the dashboard's four figures (overdue,
 * unassigned, today, done today), counted server-side from
 * `v_job_cards_dispatcher` with the same definitions the list reads, so
 * the figure and the row cannot disagree about what overdue means
 * (migration 013's whole point; T2.1). Counted, never derived client-side
 * by paging: a figure that silently stops at the page boundary lies to
 * the one role that acts on it.
 */
export const DispatcherSummarySchema = z
  .object({
    overdue: z.number().int().min(0),
    unassigned: z.number().int().min(0),
    today: z.number().int().min(0),
    doneToday: z.number().int().min(0),
  })
  .strict(); // money-free by construction — the view has no value column

export type DispatcherSummary = z.infer<typeof DispatcherSummarySchema>;

// ── companies (§3.2 data model, §5 `own` on company, §11) ───────────────────

/**
 * A B2B account (PLAN-DATA-MODEL.md §3.2). `ownerRepId` is ownership: each
 * rep sees his accounts plus the house accounts (`ownerRepId: null`), which
 * is the rbac scope `own` on company as the SQL predicate
 * `owner_rep_id = :actor OR owner_rep_id IS NULL` — never a filter over
 * fetched rows. The field moves ONLY through PATCH /v1/companies/:id/owner,
 * owner only; it is deliberately absent from the create and patch payloads
 * below, so a rep can neither set it at birth (create stamps the creator)
 * nor smuggle it in an edit.
 */
export const CompanySchema = z
  .object({
    id: uuid,
    name: z.string(),
    contactPerson: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    pincode: z.string().nullable(),
    gstin: z.string().nullable(),
    notes: z.string().nullable(),
    ownerRepId: uuid.nullable(),
    version: z.number().int(),
  })
  .strict();

export type CompanyRecord = z.infer<typeof CompanySchema>;

/** POST /v1/companies (§11) — the actor who creates it becomes its owner; the server stamps that, the payload carries no `ownerRepId`. */
export const CompanyCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    contactPerson: z.string().max(200).optional(),
    phone: z.string().min(1).max(32).optional(),
    email: z.string().max(200).optional(),
    addressLine1: z.string().max(200).optional(),
    addressLine2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    pincode: z.string().max(10).optional(),
    // The DB CHECK is the same shape (migration 005 companies_gstin_shape);
    // mirrored here so a typo dies at the form, not as a mapped refusal.
    gstin: z
      .string()
      .max(15)
      .regex(/^[0-9A-Z]{15}$/, 'GSTIN is 15 characters, capitals and digits.')
      .optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type CompanyCreate = z.infer<typeof CompanyCreateSchema>;

/** PATCH /v1/companies/:id (§11) — every field optional, at least one sent. `ownerRepId` is NOT a field: ownership moves through the owner endpoint alone. */
export const companyPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    contactPerson: z.string().max(200).nullish(),
    phone: z.string().max(32).nullish(),
    email: z.string().max(200).nullish(),
    addressLine1: z.string().max(200).nullish(),
    addressLine2: z.string().max(200).nullish(),
    city: z.string().max(100).nullish(),
    state: z.string().max(100).nullish(),
    pincode: z.string().max(10).nullish(),
    gstin: z
      .string()
      .max(15)
      .regex(/^[0-9A-Z]{15}$/, 'GSTIN is 15 characters, capitals and digits.')
      .nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export type CompanyPatch = z.infer<typeof companyPatchSchema>;

/**
 * PATCH /v1/companies/:id/owner (§11) — OWNER ONLY. `{ ownerRepId | null }`:
 * reassignment and the leave cover. `null` makes the account a house
 * account visible to every rep. A rep cannot claim another rep's account
 * or hand one off — his own included — which the route enforces at the
 * door, not in the handler.
 */
export const companyOwnerPatchSchema = z
  .object({
    ownerRepId: uuid.nullable(),
  })
  .strict();

export type CompanyOwnerPatch = z.infer<typeof companyOwnerPatchSchema>;

// ── customers (§5 rule 3, §6.4) ─────────────────────────────────────────────

export const CustomerCreateSchema = z
  .object({
    name: z.string().min(1),
    phone: z.string().min(1),
    altPhone: z.string().optional(),
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
    city: z.string().optional(),
    pincode: z.string().optional(),
    notes: z.string().optional(),
    companyId: uuid.nullish(),
  })
  .strict();

/**
 * The dispatcher's create payload (§5 rule 3): `companyId` is STRIPPED by
 * this transform — not rejected, and not merely absent from the form. A
 * field a role cannot read is a field it must not be able to write, and
 * stripping it here means the value cannot survive any future handler
 * someone adds on top of this schema: the row lands with company_id NULL.
 */
export const DispatcherCustomerCreateSchema = CustomerCreateSchema.transform((payload) => {
  const rest = { ...payload };
  delete rest.companyId;
  return rest;
});

export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;
export type DispatcherCustomerCreate = z.infer<typeof DispatcherCustomerCreateSchema>;

/** PATCH /v1/customers/:id (§6.4) — every field optional, one required. `companyId` is an owner and rep field (PLAN.md §5); null detaches the site. */
export const customerPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    phone: z.string().min(1).max(32).optional(),
    altPhone: z.string().max(32).nullish(),
    addressLine1: z.string().max(200).nullish(),
    addressLine2: z.string().max(200).nullish(),
    city: z.string().max(100).nullish(),
    pincode: z.string().max(10).nullish(),
    notes: z.string().max(2000).nullish(),
    companyId: uuid.nullish(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

/**
 * The dispatcher's PATCH: `companyId` cannot survive it — the same
 * transform stripping as the create schema (§5 rule 3), so a payload made
 * only of `companyId` becomes "nothing to change" and is refused after
 * the strip, never honoured.
 */
export const dispatcherCustomerPatchSchema = customerPatchSchema
  .transform((payload) => {
    const rest = { ...payload };
    delete rest.companyId;
    return rest;
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export type CustomerPatch = z.infer<typeof customerPatchSchema>;

// ── cash handover (§10) ─────────────────────────────────────────────────────

/** The DB enum `reconciliation_status` (migration 002), mirrored so the client can render the status pill. */
export const RECONCILIATION_STATUSES = ['submitted', 'confirmed', 'disputed'] as const;
export const reconciliationStatusSchema = z.enum(RECONCILIATION_STATUSES);
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** An IST business date (`business_date()`, migration 001) — `YYYY-MM-DD`. */
export const businessDateSchema = z.string().date();

export const cashDeclareRequestSchema = z
  .object({
    businessDate: businessDateSchema,
    declaredAmount: moneyString,
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const cashAmendRequestSchema = z
  .object({
    declaredAmount: moneyString.optional(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => v.declaredAmount !== undefined || v.note !== undefined, {
    message: 'Nothing to change.',
  });

/**
 * One handover as the declaring employee sees it (§10, UI plan-2 §T6) —
 * deliberately narrow, and the narrowness is the feature: no
 * `expected_cash`, because he declares what he is handing over and the
 * system's expectation is the check (showing him the answer first turns a
 * reconciliation into a form-fill); no owner-side confirmation columns,
 * because the queue is the owner's (Phase 4). Strict, so a leaked
 * `expected_cash` fails response validation rather than shipping.
 */
export const CashHandoverSchema = z
  .object({
    id: uuid,
    businessDate: businessDateSchema,
    declaredAmount: moneyString,
    note: z.string().nullable(),
    status: reconciliationStatusSchema,
    declaredAt: isoDateTime,
    version: z.number().int(),
  })
  .strict();

export const cashHandoverListResponseSchema = z.array(CashHandoverSchema);

export type CashHandover = z.infer<typeof CashHandoverSchema>;
export type CashDeclareRequest = z.infer<typeof cashDeclareRequestSchema>;
export type CashAmendRequest = z.infer<typeof cashAmendRequestSchema>;

// ── cash reconciliation queue (§10, PLAN-DATA-MODEL.md §4) ─────────────────

/**
 * The flag `v_cash_reconciliation_queue` emits, in the view's precedence
 * order. `missing_submission` is the row the feature exists to catch —
 * collected cash, no declaration — so the queue sorts it first regardless
 * of date.
 */
export const CASH_QUEUE_FLAGS = ['missing_submission', 'no_expected_cash', 'variance', 'match'] as const;
export const cashQueueFlagSchema = z.enum(CASH_QUEUE_FLAGS);
export type CashQueueFlag = (typeof CASH_QUEUE_FLAGS)[number];

/** The roles that declare cash (§10 POST /v1/cash/handovers) — the queue's `role` filter. */
export const DECLARING_ROLES = ['technician', 'sales_rep'] as const;
export const declaringRoleSchema = z.enum(DECLARING_ROLES);
export type DeclaringRole = (typeof DECLARING_ROLES)[number];

/**
 * One row of the owner's queue, exactly as the view carries it. The
 * declaration-side figures are null together (`declarationId`, too) —
 * a `missing_submission` day has no declaration row at all, which is
 * what makes it the only flag a LEFT JOIN would drop.
 * `declarationId` is the `cash_reconciliations.id` confirm/dispute/reopen
 * act on; the view itself does not carry it, so the repo LEFT JOINs the
 * table on the unique (employee, date) pair to surface it.
 */
export const cashQueueRowSchema = z
  .object({
    declarationId: uuid.nullable(),
    employeeId: uuid,
    employeeName: z.string(),
    role: roleSchema,
    businessDate: businessDateSchema,
    expectedCash: moneyString.nullable(),
    declaredAmount: moneyString.nullable(),
    declaredAt: isoDateTime.nullable(),
    status: reconciliationStatusSchema.nullable(),
    note: z.string().nullable(),
    variance: signedMoneyString.nullable(),
    flag: cashQueueFlagSchema,
  })
  .strict();

/**
 * `from`/`to` are inclusive; when both are absent the service applies the
 * default — the last 14 days ending *yesterday*, because today's figures
 * are not final (a synced-late completion shows `no_expected_cash` until
 * its day drains). Today is reachable only by passing `to` explicitly,
 * and the response carries `today` so the client can caption those rows
 * "still syncing" instead of letting the flags lie.
 */
export const cashQueueQuerySchema = z
  .object({
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
    /** Repeated keys (`flag=a&flag=b`) arrive as an array; one as a string. */
    flag: z.union([cashQueueFlagSchema, z.array(cashQueueFlagSchema)]).optional(),
    role: declaringRoleSchema.optional(),
  })
  .transform((q) => ({
    from: q.from,
    to: q.to,
    flags: q.flag === undefined ? undefined : Array.isArray(q.flag) ? q.flag : [q.flag],
    role: q.role,
  }));

export const cashQueueResponseSchema = z
  .object({
    today: businessDateSchema,
    from: businessDateSchema,
    to: businessDateSchema,
    rows: z.array(cashQueueRowSchema),
  })
  .strict();

export const cashConfirmRequestSchema = z
  .object({
    /** May differ from the declaration on purpose (§10 test line): both figures are stored. */
    confirmedAmount: moneyString,
  })
  .strict();

export const cashDisputeRequestSchema = z
  .object({
    /** Trimmed before the length check: whitespace-only is without a note. */
    ownerNote: z.string().trim().min(1).max(1000),
  })
  .strict();

export const cashReopenRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export type CashQueueRow = z.infer<typeof cashQueueRowSchema>;
export type CashQueueQuery = z.output<typeof cashQueueQuerySchema>;
export type CashQueueResponse = z.infer<typeof cashQueueResponseSchema>;
export type CashConfirmRequest = z.infer<typeof cashConfirmRequestSchema>;
export type CashDisputeRequest = z.infer<typeof cashDisputeRequestSchema>;
export type CashReopenRequest = z.infer<typeof cashReopenRequestSchema>;

// ── devices (§8) ────────────────────────────────────────────────────────────

export const deviceUpsertSchema = z
  .object({
    installId: z.string().min(1),
    platform: z.enum(['android', 'ios', 'web']),
    appVersion: z.string(),
    osVersion: z.string(),
    manufacturer: z.string(),
    model: z.string(),
    fcmToken: z.string().optional(),
    locationPermission: z.enum(['none', 'foreground', 'background']).optional(),
    batteryOptExempt: z.boolean().optional(),
    autostartConfirmed: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .strict();

export type DeviceUpsert = z.infer<typeof deviceUpsertSchema>;

// ── location pings (§8) ─────────────────────────────────────────────────────

export const locationPingSchema = z
  .object({
    recordedAt: isoDateTime,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyM: z.number().nonnegative(),
    altitudeM: z.number().optional(),
    speedMps: z.number().nonnegative().optional(),
    headingDeg: z.number().min(0).max(360).optional(),
    batteryPct: z.number().int().min(0).max(100).optional(),
    isMoving: z.boolean().optional(),
    source: z.enum(['scheduled', 'on_demand', 'live', 'manual']),
  })
  .strict();

/** Batch of up to 200, buffered on device. */
export const locationPingBatchSchema = z.object({ pings: z.array(locationPingSchema).max(200) });

export const pingBatchResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.array(z.object({ index: z.number().int().nonnegative(), code: pingRejectCodeSchema })),
});

export type LocationPingPayload = z.infer<typeof locationPingSchema>;
export type PingBatchResultParsed = z.infer<typeof pingBatchResultSchema>;

// ── tracking health (§8: /v1/location/health/me) ────────────────────────────

/**
 * One row of `v_employee_tracking_health` (PLAN-DATA-MODEL.md §4, migration
 * 009) as `GET /v1/location/health/me` returns it — the actor's own row and
 * nobody else's. `notificationsEnabled` rides through from the newest
 * device row and is deliberately NOT folded into `health` (§4): a
 * technician with notifications off is still tracking correctly, so the
 * client renders it as a separate chip state. The device and ping columns
 * are nullable through the view's LEFT JOINs — no device install yet, or no
 * ping ever, is an honest null, not an absent field.
 */
export const trackingHealthSchema = z
  .object({
    employeeId: uuid,
    employeeName: z.string(),
    role: roleSchema,
    deviceId: uuid.nullable(),
    locationPermission: z.enum(['none', 'foreground', 'background']).nullable(),
    notificationsEnabled: z.boolean().nullable(),
    lastPingAt: isoDateTime.nullable(),
    minutesSince: z.number().nullable(),
    health: z.enum(['not_tracked', 'permission_missing', 'never_reported', 'stale', 'active']),
  })
  .strict();

export type TrackingHealth = z.infer<typeof trackingHealthSchema>;

// ── auth (§4) ───────────────────────────────────────────────────────────────

/**
 * Same shape the DB CHECK enforces on `employees.username`
 * (PLAN-DATA-MODEL.md §3.1) — the client failing this is a 422 before
 * the server ever hashes anything.
 */
export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9._-]{3,32}$/, 'Use 3-32 characters: a-z, 0-9, dots, dashes, underscores.');

/** The device half of the login payload (§4) — six required fields, no diagnostics. */
export const authDeviceSchema = z
  .object({
    installId: z.string().min(1),
    platform: z.enum(['android', 'ios', 'web']),
    appVersion: z.string().min(1),
    osVersion: z.string().min(1),
    manufacturer: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    username: usernameSchema,
    password: z.string().min(1),
    device: authDeviceSchema,
  })
  .strict();

/** The employee as login and /v1/auth/me return it — never the password hash. */
export const employeePublicSchema = z
  .object({
    id: uuid,
    username: z.string(),
    fullName: z.string(),
    phone: z.string().nullable(),
    role: z.enum(ROLES),
    mustChangePassword: z.boolean(),
    lastLoginAt: isoDateTime.nullable(),
  })
  .strict();

/** Current state of the location-tracking consent (§4, §7). */
export const consentStateSchema = z
  .object({
    /** True means the employee still owes acceptance for `version`. */
    required: z.boolean(),
    /** The date string of the consent copy revision — bumping it re-prompts everyone. */
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const tokenPairSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
  })
  .strict();

export const loginResponseSchema = tokenPairSchema
  .extend({
    employee: employeePublicSchema,
    mustChangePassword: z.boolean(),
    consent: consentStateSchema,
  })
  .strict();

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export const refreshResponseSchema = tokenPairSchema;

export const passwordChangeRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    /** Eight characters is a floor, not a policy — the owner hands out the temp passwords. */
    newPassword: z.string().min(8, 'Use at least 8 characters.'),
  })
  .strict();
export const passwordChangeResponseSchema = z.object({ ok: z.boolean() });
export const logoutResponseSchema = z.object({ ok: z.boolean() });

export const permissionsSnapshotSchema = z.record(resourceSchema, z.record(actionSchema, scopeSchema));
export const featureFlagsSchema = z.record(z.enum(FEATURE_FLAGS), z.boolean());

export const authMeResponseSchema = z
  .object({
    employee: employeePublicSchema,
    permissions: permissionsSnapshotSchema,
    featureFlags: featureFlagsSchema,
    consent: consentStateSchema,
  })
  .strict();

// ── feature-flag administration (PLAN-EXECUTION.md §3) ─────────────────────

/** One PUT: flip exactly one named flag for one employee. */
export const flagOverrideRequestSchema = z
  .object({
    flag: z.enum(FEATURE_FLAGS),
    enabled: z.boolean(),
  })
  .strict();

export const employeeFlagsSchema = z.object({
  employeeId: z.string(),
  username: z.string(),
  role: z.string(),
  flags: featureFlagsSchema,
});

export const flagListResponseSchema = z.object({ employees: z.array(employeeFlagsSchema) });

export const flagOverrideResponseSchema = z.object({
  employeeId: z.string(),
  flags: featureFlagsSchema,
});

export type FlagOverrideRequest = z.infer<typeof flagOverrideRequestSchema>;
export type FlagListResponse = z.infer<typeof flagListResponseSchema>;
export type FlagOverrideResponse = z.infer<typeof flagOverrideResponseSchema>;

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type EmployeePublic = z.infer<typeof employeePublicSchema>;
export type ConsentState = z.infer<typeof consentStateSchema>;

// ── employee administration (§4.1) ──────────────────────────────────────────

/**
 * One device install as the owner's employee detail shows it (§3.1): the
 * four OEM-mitigation diagnostics default to their unconfirmed state, so
 * a handset that never checks in reads unhealthy rather than silently
 * healthy. Tracking health rides on `v_employee_tracking_health`, which
 * ships with migration 009 (Phase 1) — the detail response grows that
 * field then, not before.
 */
export const deviceDiagnosticSchema = z
  .object({
    id: uuid,
    installId: z.string(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    osVersion: z.string().nullable(),
    appVersion: z.string().nullable(),
    locationPermission: z.enum(['none', 'foreground', 'background']),
    batteryOptExempt: z.boolean(),
    autostartConfirmed: z.boolean(),
    notificationsEnabled: z.boolean(),
    lastSeenAt: isoDateTime.nullable(),
    isActive: z.boolean(),
  })
  .strict();

/**
 * The employee as the owner's endpoints return it. Wider than the
 * public login shape: `isActive`, `createdAt` and `version` are owner
 * facts, and `version` is what the client sends back as `If-Match` on
 * PATCH — an admin payload without it would make optimistic concurrency
 * unreachable from the screen.
 */
export const employeeAdminSchema = z
  .object({
    id: uuid,
    username: z.string(),
    fullName: z.string(),
    phone: z.string().nullable(),
    role: roleSchema,
    isActive: z.boolean(),
    mustChangePassword: z.boolean(),
    lastLoginAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    version: z.number().int(),
  })
  .strict();

export const employeeCreateRequestSchema = z
  .object({
    username: usernameSchema,
    fullName: z.string().min(1),
    phone: z.string().min(1).nullish(),
    role: roleSchema,
    /** Handed to the employee by voice or in person (§4.1) — never stored in clear. */
    tempPassword: z.string().min(8, 'Use at least 8 characters.'),
  })
  .strict();

/** `role` may repeat in the query string; one value arrives as a string. */
export const employeeListQuerySchema = z
  .object({
    role: z.union([roleSchema, z.array(roleSchema)]).optional(),
    isActive: z.enum(['true', 'false']).optional(),
  })
  .transform((q) => ({
    roles: q.role === undefined ? undefined : Array.isArray(q.role) ? q.role : [q.role],
    isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
  }));

export const employeeListResponseSchema = z.array(employeeAdminSchema);

export type EmployeeListFilter = z.infer<typeof employeeListQuerySchema>;

export const employeeDetailResponseSchema = employeeAdminSchema.extend({
  devices: z.array(deviceDiagnosticSchema),
});

export const employeePatchRequestSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(1).nullish(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export const employeePasswordResetRequestSchema = z
  .object({
    tempPassword: z.string().min(8, 'Use at least 8 characters.'),
  })
  .strict();

export type EmployeeAdmin = z.infer<typeof employeeAdminSchema>;
export type EmployeeDetail = z.infer<typeof employeeDetailResponseSchema>;
export type EmployeeCreateRequest = z.infer<typeof employeeCreateRequestSchema>;
export type EmployeePatchRequest = z.infer<typeof employeePatchRequestSchema>;
export type EmployeePasswordResetRequest = z.infer<typeof employeePasswordResetRequestSchema>;
export type DeviceDiagnostic = z.infer<typeof deviceDiagnosticSchema>;

// ── consents (§4) ───────────────────────────────────────────────────────────

/**
 * `consent_kind` (migration 002) — one value today; the type exists so a
 * second consent kind never needs a migration on a text column.
 */
export const CONSENT_KINDS = ['location_tracking'] as const;
export const consentKindSchema = z.enum(CONSENT_KINDS);

/** The consent copy's version — the date string of the revision (§4). */
export const consentVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One kind+version this actor still owes (GET /v1/consents/required). */
export const consentObligationSchema = z
  .object({ kind: consentKindSchema, version: consentVersionSchema })
  .strict();

export const requiredConsentsResponseSchema = z
  .object({ required: z.array(consentObligationSchema) })
  .strict();

export const consentCreateRequestSchema = z
  .object({
    kind: consentKindSchema,
    version: consentVersionSchema,
    deviceId: uuid.nullish(),
    /**
     * In the contract and read by nobody. The server records the request's
     * own address (§4): this row is DPDP Act evidence, and evidence a client
     * can author is not evidence. Naming the field here is what keeps
     * "ignored" a visible, tested decision rather than silent stripping.
     */
    ipAddress: z.string().optional(),
  })
  .strict();

export const consentCreateResponseSchema = z
  .object({
    kind: consentKindSchema,
    version: consentVersionSchema,
    acceptedAt: isoDateTime,
    deviceId: uuid.nullable(),
    /** The server-recorded request address — never an echo of the body. */
    ipAddress: z.string().nullable(),
  })
  .strict();

export type ConsentKind = z.infer<typeof consentKindSchema>;
export type ConsentObligation = z.infer<typeof consentObligationSchema>;
export type RequiredConsentsResponse = z.infer<typeof requiredConsentsResponseSchema>;
export type ConsentCreateRequest = z.infer<typeof consentCreateRequestSchema>;
export type ConsentCreateResponse = z.infer<typeof consentCreateResponseSchema>;

// ── error envelope (§3.1) ───────────────────────────────────────────────────

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(), // switched against the ErrorCode union on the client side
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

// ── sync (§7 — bootstrap, delta, batch) ─────────────────────────────────────
//
// The offline mirror's three doors (PLAN-BACKEND.md §7, PLAN-DATA-MODEL.md
// §6). The mirror holds five collections for a technician: his jobs (the
// same card shape the REST surface returns him, contract inline), the
// customers those jobs touch and their product stacks, and the active
// catalogue. Rows leave the mirror two ways — a `deleted` tombstone (soft
// delete) or an `out_of_scope` tombstone (the reassigned job) — and a
// tombstone never deletes an outbox row; the server decides on drain.

/** Catalogue row as the mirror holds it — active rows only; a deactivation arrives as a `deleted` tombstone. */
export const SyncProductSchema = z
  .object({
    id: uuid,
    sku: z.string(),
    name: z.string(),
    category: z.enum(['ups', 'battery', 'inverter', 'accessory', 'spare']),
    brand: z.string().nullable(),
    modelNumber: z.string().nullable(),
    capacityLabel: z.string().nullable(),
    unit: z.string().nullable(),
    defaultPrice: moneyString.nullable(),
    warrantyMonths: z.number().int().nullable(),
    version: z.number().int(),
  })
  .strict();

/** Job-type catalogue row, active rows only. */
export const SyncServiceSchema = z
  .object({
    id: uuid,
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    defaultCharge: moneyString.nullable(),
    version: z.number().int(),
  })
  .strict();

/** A site the actor's jobs touch — reached through a job, never the whole customer table. */
export const SyncCustomerSchema = z
  .object({
    id: uuid,
    name: z.string(),
    phone: z.string(),
    altPhone: z.string().nullable(),
    addressLine1: z.string().nullable(),
    addressLine2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    pincode: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    notes: z.string().nullable(),
    companyId: uuid.nullable(),
    version: z.number().int(),
  })
  .strict();

/** One unit standing at a site (§3.3) — active rows only; a released serial arrives as a `deleted` tombstone. */
export const SyncCustomerProductSchema = z
  .object({
    id: uuid,
    customerId: uuid,
    productId: uuid.nullable(),
    freeTextName: z.string().nullable(),
    serialNumber: z.string(),
    quantity: z.number().int(),
    installedOn: businessDateSchema.nullable(),
    warrantyExpiresOn: businessDateSchema.nullable(),
    notes: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();

/**
 * A row that has stopped being this actor's business (§7). `deleted` — the
 * row went `is_active = false`. `out_of_scope` — the row is perfectly alive
 * but no longer the actor's: the job reassigned from Ravi to Anitha is not
 * deleted and not inactive, it has simply stopped being Ravi's. The client
 * deletes the mirror row and drops it from any list — and keeps any outbox
 * row pointing at it (§7: the server decides on drain).
 */
export const syncTombstoneSchema = z
  .object({
    entity: z.enum(['job', 'customer', 'customer_product', 'product', 'service']),
    id: uuid,
    reason: z.enum(['deleted', 'out_of_scope']),
  })
  .strict();
export type SyncTombstone = z.infer<typeof syncTombstoneSchema>;

/** The bounded working set — a technician's is tens of rows, not the whole database (§7). */
export const syncWorkingSetSchema = z
  .object({
    jobs: z.array(JobCardTechnicianSchema),
    customers: z.array(SyncCustomerSchema),
    customerProducts: z.array(SyncCustomerProductSchema),
    products: z.array(SyncProductSchema),
    services: z.array(SyncServiceSchema),
  })
  .strict();
export type SyncWorkingSet = z.infer<typeof syncWorkingSetSchema>;

/** `GET /v1/sync/bootstrap` — the cold-start set plus the cursor to delta from. */
export const syncBootstrapResponseSchema = z
  .object({
    data: syncWorkingSetSchema,
    cursor: isoDateTime,
  })
  .strict();
export type SyncBootstrapResponse = z.infer<typeof syncBootstrapResponseSchema>;

/**
 * `GET /v1/sync/delta` — the working set's changes since `cursor` plus
 * tombstones, plus the cursor to carry into the next call. `hasMore` pages
 * a client that has been offline a fortnight; the cursor only advances
 * (it is the server's `updated_at`, never the device clock).
 */
export const syncDeltaResponseSchema = z
  .object({
    data: syncWorkingSetSchema,
    tombstones: z.array(syncTombstoneSchema),
    cursor: isoDateTime,
    hasMore: z.boolean(),
  })
  .strict();
export type SyncDeltaResponse = z.infer<typeof syncDeltaResponseSchema>;

/**
 * One queued outbox operation, verbatim from the handset (§7). The
 * idempotency key is generated once at enqueue and kept across every retry
 * (§3.2); `dependsOn` names an EARLIER operation's `localId` and
 * short-circuits — a rejected parent returns its child `skipped`,
 * unattempted. `headers` carries the sparse extras a target route needs
 * (`If-Match` today); the server allowlists them.
 */
export const syncOperationSchema = z
  .object({
    localId: z.string().min(1).max(100),
    dependsOn: z.string().min(1).max(100).optional(),
    idempotencyKey: uuid,
    method: z.enum(['POST', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/v1/').max(500),
    body: z.unknown().optional(),
    headers: z.record(z.string()).optional(),
  })
  .strict();
export type SyncOperation = z.infer<typeof syncOperationSchema>;

/**
 * Per-operation result (§7). `duplicate` is a SUCCESS — the idempotency
 * layer replayed a stored response, the client marks the item done.
 * `status` is the HTTP status of the attempted call; 0 means the
 * operation was never attempted (`skipped` behind a failed dependency).
 */
export const syncOperationResultSchema = z
  .object({
    localId: z.string(),
    outcome: z.enum(['applied', 'duplicate', 'rejected', 'skipped']),
    status: z.number().int(),
    body: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .optional(),
  })
  .strict();
export type SyncOperationResult = z.infer<typeof syncOperationResultSchema>;

/** `POST /v1/sync/batch` — the outbox drain. Cap 50 (§7); larger queues page. */
export const SYNC_BATCH_MAX_OPERATIONS = 50;

export const syncBatchSchema = z
  .object({ operations: z.array(syncOperationSchema).max(SYNC_BATCH_MAX_OPERATIONS) })
  .strict();
export type SyncBatchRequest = z.infer<typeof syncBatchSchema>;

/** Always HTTP 200 if the envelope parsed — individual failures live in `results` (§7). */
export const syncBatchResponseSchema = z
  .object({
    results: z.array(syncOperationResultSchema),
    /** Carry this straight into `GET /v1/sync/delta` (§7: drain, then delta). */
    cursor: isoDateTime,
  })
  .strict();
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

// ── customers, stack and catalogue REST (§6.4) ──────────────────────────────
//
// The §6.4 endpoints answer with the same row shapes the mirror carries
// (§7) — the REST surface and the offline mirror showing two different
// shapes for one table is a sync bug waiting for a field to disagree
// about. The dispatcher's customer row is the one deliberate exception:
// `companyId` is absent from it, because company data is a field he
// cannot read (PLAN.md §5) — absent, never null-with-a-flag.

export const CustomerSchema = SyncCustomerSchema;
export type CustomerRecord = z.infer<typeof CustomerSchema>;

/** The dispatcher never sees company data (PLAN.md §5: `company_id` is an owner and rep field). */
export const CustomerDispatcherSchema = CustomerSchema.omit({ companyId: true }).strict();
export type CustomerDispatcher = z.infer<typeof CustomerDispatcherSchema>;

/** One unit standing at a site — active rows only (§3.3). */
export const CustomerStackItemSchema = SyncCustomerProductSchema;
export type CustomerStackItem = z.infer<typeof CustomerStackItemSchema>;

/** GET /v1/customers/:id — the site plus its active stack (§6.4). */
export const CustomerDetailSchema = CustomerSchema.extend({
  stack: z.array(CustomerStackItemSchema),
}).strict();
export const CustomerDetailDispatcherSchema = CustomerDispatcherSchema.extend({
  stack: z.array(CustomerStackItemSchema),
}).strict();
export type CustomerDetail = z.infer<typeof CustomerDetailSchema>;
export type CustomerDetailDispatcher = z.infer<typeof CustomerDetailDispatcherSchema>;

/**
 * PATCH /v1/customers/:id/stack/:itemId (§6.4) — the correction case: a
 * wrong serial, a warranty end, a miscounted quantity. Adding and
 * removing a unit are the POST and DELETE doors; the payload here is
 * exactly the three fields §6.4 names.
 */
export const stackItemPatchSchema = z
  .object({
    serialNumber: z.string().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(9999).optional(),
    warrantyExpiresOn: z.string().date().nullish(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type StackItemPatch = z.infer<typeof stackItemPatchSchema>;

/** The catalogue (§6.4): read by everyone, written only by the owner — the same rows the mirror carries. */
export const ProductSchema = SyncProductSchema;
export const ServiceSchema = SyncServiceSchema;
export type ProductRecord = z.infer<typeof ProductSchema>;
export type ServiceRecord = z.infer<typeof ServiceSchema>;

export const PRODUCT_CATEGORIES = ['ups', 'battery', 'inverter', 'accessory', 'spare'] as const;
export const productCategorySchema = z.enum(PRODUCT_CATEGORIES);

export const productCreateRequestSchema = z
  .object({
    sku: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    category: productCategorySchema,
    brand: z.string().max(200).optional(),
    modelNumber: z.string().max(200).optional(),
    capacityLabel: z.string().max(100).optional(),
    unit: z.string().max(20).optional(),
    defaultPrice: moneyString.optional(),
    warrantyMonths: z.number().int().min(0).max(1200).optional(),
  })
  .strict();
export type ProductCreateRequest = z.infer<typeof productCreateRequestSchema>;

/**
 * `sku` is deliberately absent — it is UNIQUE outright (§3.2), so a
 * correction goes through deactivation and a new SKU, never a rewrite of
 * a code that sales and completions already cite. Deactivation is
 * `isActive: false` — never a DELETE (§6.4).
 */
export const productPatchRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    brand: z.string().max(200).nullish(),
    modelNumber: z.string().max(200).nullish(),
    capacityLabel: z.string().max(100).nullish(),
    unit: z.string().max(20).nullish(),
    defaultPrice: moneyString.nullish(),
    warrantyMonths: z.number().int().min(0).max(1200).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type ProductPatchRequest = z.infer<typeof productPatchRequestSchema>;

export const serviceCreateRequestSchema = z
  .object({
    code: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    defaultCharge: moneyString.optional(),
  })
  .strict();
export type ServiceCreateRequest = z.infer<typeof serviceCreateRequestSchema>;

export const servicePatchRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullish(),
    defaultCharge: moneyString.nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type ServicePatchRequest = z.infer<typeof servicePatchRequestSchema>;

// ── sales cards (§3.5 data model, §5 `own` on sale, §11) ────────────────────

/**
 * `sales_cards.status` (migration 002 `sales_card_status`). Draft means no
 * number and no money; confirm allocates the number and moves the balance;
 * void is the reversal — owner only, reason required.
 */
export const saleStatusSchema = z.enum(['draft', 'confirmed', 'void']);
export type SaleStatus = z.infer<typeof saleStatusSchema>;

/**
 * One line of a sale as the CREATE/PATCH payload carries it (§11: items are
 * nested in the create payload). THE SNAPSHOT IS THE PAYLOAD'S JOB: the
 * picker on the device copies `productName`/`productSku`/`unitPrice` off the
 * product at add time, and the server stores what it received — a repricing
 * next quarter must not rewrite this sale (§3.5), so the server never
 * re-derives a line's name or price from `products`. `unitPrice` is editable
 * per line because a negotiated price is normal; `productId` is optional
 * (third-party kit) and kept for reporting joins only — it is never read for
 * display.
 */
export const saleItemInputSchema = z
  .object({
    productId: uuid.optional(),
    productName: z.string().min(1).max(200),
    productSku: z.string().max(100).optional(),
    /** numeric(10,2) with CHECK (quantity > 0) — the DB is the backstop. */
    quantity: z.number().min(0.01).max(99_999_999.99),
    /** numeric(12,2) with CHECK (unit_price >= 0) — a discount is a smaller positive price. */
    unitPrice: moneyString,
    serialNumbers: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();
export type SaleItemInput = z.infer<typeof saleItemInputSchema>;

/** POST /v1/sales (§11) — a draft; the number comes at confirm, so the payload carries none. */
export const saleCreateSchema = z
  .object({
    companyId: uuid,
    /** The IST business day the sale was MADE, chosen by the rep — never derived from the server clock (migration 017). */
    saleDate: z.string().date(),
    notes: z.string().max(2000).optional(),
    items: z.array(saleItemInputSchema).min(1).max(200),
  })
  .strict();
export type SaleCreate = z.infer<typeof saleCreateSchema>;

/**
 * PATCH /v1/sales/:id (§11: rep own, draft only — a confirmed card is
 * corrected by void, never edited). `items` rewrites the draft's lines in
 * full when sent; absent leaves them alone.
 */
export const salePatchSchema = z
  .object({
    saleDate: z.string().date().optional(),
    notes: z.string().max(2000).nullish(),
    items: z.array(saleItemInputSchema).min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type SalePatch = z.infer<typeof salePatchSchema>;

/** POST /v1/sales/:id/void (§11: OWNER ONLY) — a void without a reason is a balance that moved for nothing. */
export const saleVoidSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type SaleVoid = z.infer<typeof saleVoidSchema>;

/** One stored line, as every reader sees it: the snapshots, never a live product lookup. */
export const SaleItemSchema = z
  .object({
    lineNo: z.number().int().min(1),
    productId: uuid.nullable(),
    productName: z.string(),
    productSku: z.string().nullable(),
    /** Money and quantities cross the wire as decimal strings (numeric columns). */
    quantity: moneyString,
    unitPrice: moneyString,
    lineTotal: moneyString,
    serialNumbers: z.array(z.string()),
  })
  .strict();
export type SaleItem = z.infer<typeof SaleItemSchema>;

/**
 * One sales card. `saleNumber` is null while draft — the device shows
 * "Draft", never a fake local number (§3.5). `total` is the card's worth as
 * `v_sales_card_totals` defines it — the one definition, read from the view,
 * never recomputed here.
 */
export const SaleSchema = z
  .object({
    id: uuid,
    saleNumber: z.string().nullable(),
    companyId: uuid,
    salesRepId: uuid,
    saleDate: z.string().date(),
    status: saleStatusSchema,
    notes: z.string().nullable(),
    confirmedAt: isoDateTime.nullable(),
    voidedAt: isoDateTime.nullable(),
    voidReason: z.string().nullable(),
    total: moneyString,
    items: z.array(SaleItemSchema),
    version: z.number().int(),
  })
  .strict();
export type SaleRecord = z.infer<typeof SaleSchema>;

// ── payments (§3.5 data model, §5 `own` on payment = received_by, §11) ──────

/**
 * `payments.mode` (migration 002 `payment_mode`). Cash is the one mode
 * that passes through a person's hands — v_employee_expected_cash filters
 * on it — while UPI, card, cheque and bank transfer land in the company's
 * account and never create a handover expectation.
 */
export const paymentModeSchema = z.enum(['cash', 'upi', 'card', 'cheque', 'bank_transfer']);
export type PaymentMode = z.infer<typeof paymentModeSchema>;

/**
 * `payments.status` (migration 002). There is no 'pending' — DELIBERATELY:
 * pending is a view of dues (`v_company_balances WHERE balance > 0`), not a
 * row, and an intention to collect is not money (§3.5).
 */
export const paymentStatusSchema = z.enum(['collected', 'void']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * POST /v1/payments (§11). `salesCardId` is optional and its absence IS the
 * feature: an ON-ACCOUNT payment lands on the company balance without
 * pointing at a specific sale, which is how most collections actually work
 * (§3.5). `receivedAt` is the client's clamped instant — the money changed
 * hands at the customer's office, maybe offline — and the server generates
 * `business_date` from it in Asia/Kolkata, so cash received Monday lands on
 * Monday whenever the row syncs.
 */
export const paymentCreateSchema = z
  .object({
    companyId: uuid,
    salesCardId: uuid.optional(),
    /** numeric(12,2), CHECK (amount > 0) — refused here so the client sees why, not the DB. */
    amount: moneyString.refine((s) => Number(s) > 0, { message: 'An amount of zero is not a payment.' }),
    mode: paymentModeSchema,
    /** UPI txn id / cheque number; cash carries none. */
    referenceNo: z.string().min(1).max(200).optional(),
    receivedAt: isoDateTime,
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type PaymentCreate = z.infer<typeof paymentCreateSchema>;

/** POST /v1/payments/:id/void (§11: OWNER ONLY) — a void without a reason is a balance that moved for nothing. */
export const paymentVoidSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type PaymentVoid = z.infer<typeof paymentVoidSchema>;

/**
 * One payment, as every reader sees it. `paymentNumber` (`PM-2627-00042`)
 * is allocated at CREATE — the opposite of `sale_number` on purpose
 * (§3.5): payments are not drafted, so there is no pending state to
 * allocate at. Money crosses the wire as decimal strings.
 */
export const PaymentSchema = z
  .object({
    id: uuid,
    paymentNumber: z.string(),
    companyId: uuid,
    /** NULL = on-account. */
    salesCardId: uuid.nullable(),
    amount: moneyString,
    mode: paymentModeSchema,
    referenceNo: z.string().nullable(),
    receivedBy: uuid,
    receivedAt: isoDateTime,
    /** Generated from received_at in Asia/Kolkata — the day the money moved. */
    businessDate: z.string().date(),
    status: paymentStatusSchema,
    voidedAt: isoDateTime.nullable(),
    voidedBy: uuid.nullable(),
    voidReason: z.string().nullable(),
    notes: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();
export type PaymentRecord = z.infer<typeof PaymentSchema>;

// ── ledger and balances (§3.5 data model, §11, UI/plan-2 06-SALES-REP.md §S4) ──

/** What a ledger row is a document of — a sale or a payment (§S4's ledger). */
export const ledgerEntryKindSchema = z.enum(['sale', 'payment']);
export type LedgerEntryKind = z.infer<typeof ledgerEntryKindSchema>;

/**
 * One interleaved ledger row (GET /v1/companies/:id/ledger, §11). The
 * ledger shows documents, not effects: a VOIDED sale or payment still
 * appears — the document existed, the ledger says so — carrying its signed
 * `amount` exactly as written, with `voided` explaining why the running
 * balance stepped over it. The server computes `runningBalance` (§S4's
 * right-hand column): the rep's phone and the owner's desktop cannot
 * disagree about money. Newest first, so `runningBalance` counts this row
 * and every older one — at the newest row it equals the account's
 * `v_company_balances.balance` to the paisa, because both are the same sum
 * over the same rows.
 */
export const LedgerEntrySchema = z
  .object({
    kind: ledgerEntryKindSchema,
    id: uuid,
    /** `SL-2627-00018` / `PM-2627-00042` — allocated at confirm (sales) or create (payments); a void keeps its number. */
    number: z.string(),
    /** The day the row shows as — `sale_date` for a sale, `business_date` (Asia/Kolkata) for a payment. */
    date: z.string().date(),
    /** When the money moved — `confirmed_at` for a sale, `received_at` for a payment. The ledger's order key. */
    recordedAt: isoDateTime,
    /** UPI, cash, cheque, … for a payment; null for a sale (§S4: "Payment UPI"). */
    mode: paymentModeSchema.nullable(),
    /** Signed document amount — a sale positive, a payment negative. A voided row keeps its amount; it does not move the balance. */
    amount: signedMoneyString,
    voided: z.boolean(),
    voidReason: z.string().nullable(),
    /** Balance after this row and everything older — voided rows contribute nothing. */
    runningBalance: signedMoneyString,
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * GET /v1/companies/:id/ledger (§11) — the account's whole story. `balance`
 * is the header figure, read from `v_company_balances` in the same
 * statement that computes the entries, so the screen's largest number and
 * the column beside each row cannot disagree.
 */
export const CompanyLedgerSchema = z
  .object({
    companyId: uuid,
    balance: signedMoneyString,
    entries: z.array(LedgerEntrySchema),
  })
  .strict();
export type CompanyLedger = z.infer<typeof CompanyLedgerSchema>;

/**
 * One row of the Pending tab (GET /v1/companies/balances, §11). Read from
 * `v_company_balances`, never from a payments table — pending is a view of
 * dues, not a row. `balance` may be negative: the owner may scan for
 * credit balances with a `minBalance` below zero.
 */
export const CompanyBalanceSchema = z
  .object({
    companyId: uuid,
    name: z.string(),
    balance: signedMoneyString,
    lastSaleDate: z.string().date().nullable(),
    lastPaymentAt: isoDateTime.nullable(),
  })
  .strict();
export type CompanyBalance = z.infer<typeof CompanyBalanceSchema>;
