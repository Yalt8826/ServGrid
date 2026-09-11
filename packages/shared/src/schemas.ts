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
import { z } from 'zod';

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

/** The dispatcher form: `companyId` absent — and stripped server-side even if sent. */
export const DispatcherCustomerCreateSchema = CustomerCreateSchema.omit({ companyId: true }).strict();

export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;
export type DispatcherCustomerCreate = z.infer<typeof DispatcherCustomerCreateSchema>;

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

// ── sync (§7) ───────────────────────────────────────────────────────────────

export const syncOperationSchema = z.object({
  localId: z.string().min(1),
  dependsOn: z.string().optional(),
  idempotencyKey: uuid,
  method: z.enum(['POST', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/v1/'),
  body: z.unknown().optional(),
});

export const syncBatchSchema = z.object({ operations: z.array(syncOperationSchema).max(50) });
export type SyncOperation = z.infer<typeof syncOperationSchema>;
