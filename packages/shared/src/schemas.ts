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
