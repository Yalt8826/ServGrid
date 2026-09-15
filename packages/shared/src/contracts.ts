import { z } from 'zod';

import { isoDateTime, jobStatusSchema, moneyString, uuid } from './schemas.ts';

/**
 * AMC contracts on the wire (PLAN-BACKEND.md §11.1, decision 2026-09-15).
 * A contract is read from v_contracts: its state and reminders are derived
 * server-side, so no screen recomputes "due" or "ending" from a phone clock.
 */
export const CONTRACT_STATES = ['upcoming', 'active', 'expired', 'cancelled'] as const;
export const contractStateSchema = z.enum(CONTRACT_STATES);
export type ContractState = z.infer<typeof contractStateSchema>;

export const CONTRACT_LIST_FILTERS = ['all', 'due', 'ending'] as const;
export const contractListFilterSchema = z.enum(CONTRACT_LIST_FILTERS);
export type ContractListFilter = z.infer<typeof contractListFilterSchema>;

/** Days before its end an active AMC shows under "Ending within 7 days" (decision 7). */
export const CONTRACT_ENDING_WINDOW_DAYS = 7;
/** Months after the last completed job a customer is due (decision 4). */
export const CONTRACT_VISIT_GAP_MONTHS = 4;
/** The default term the form proposes (decision 6). */
export const CONTRACT_TERM_MONTHS = 12;

export const ContractOpenJobSchema = z
  .object({ id: uuid, jobNumber: z.string(), scheduledFor: isoDateTime.nullable() })
  .strict();

export const ContractSchema = z
  .object({
    id: uuid,
    contractNumber: z.string(),
    customerId: uuid,
    customerName: z.string(),
    startDate: z.string().date(),
    endDate: z.string().date(),
    contractValue: moneyString,
    notes: z.string().nullable(),
    createdBy: uuid,
    createdByName: z.string(),
    createdAt: isoDateTime,
    cancelledAt: isoDateTime.nullable(),
    cancelReason: z.string().nullable(),
    state: contractStateSchema,
    lastServiceDate: z.string().date().nullable(),
    nextVisitDue: z.string().date(),
    openJob: ContractOpenJobSchema.nullable(),
    daysToEnd: z.number().int(),
    isVisitDue: z.boolean(),
    isEndingSoon: z.boolean(),
    version: z.number().int(),
  })
  .strict();
export type Contract = z.infer<typeof ContractSchema>;

export const ContractJobSchema = z
  .object({
    id: uuid,
    jobNumber: z.string(),
    title: z.string(),
    status: jobStatusSchema,
    scheduledFor: isoDateTime.nullable(),
    closedAt: isoDateTime.nullable(),
    assignedToName: z.string().nullable(),
  })
  .strict();
export type ContractJob = z.infer<typeof ContractJobSchema>;

export const ContractDetailSchema = z
  .object({ contract: ContractSchema, jobs: z.array(ContractJobSchema) })
  .strict();
export type ContractDetail = z.infer<typeof ContractDetailSchema>;

export const contractListEnvelopeSchema = z
  .object({ items: z.array(ContractSchema), nextCursor: z.string().nullable() })
  .strict();
export type ContractListEnvelope = z.infer<typeof contractListEnvelopeSchema>;

export const contractListQuerySchema = z
  .object({
    filter: contractListFilterSchema.default('all'),
    customerId: uuid.optional(),
    state: contractStateSchema.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ContractListQuery = z.infer<typeof contractListQuerySchema>;

const TERM_MESSAGE = 'The end date cannot be before the start date.';

export const contractCreateSchema = z
  .object({
    customerId: uuid,
    startDate: z.string().date(),
    endDate: z.string().date(),
    contractValue: moneyString,
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, { message: TERM_MESSAGE, path: ['endDate'] });
export type ContractCreate = z.infer<typeof contractCreateSchema>;

export const contractPatchSchema = z
  .object({
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    contractValue: moneyString.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.endDate >= v.startDate, {
    message: TERM_MESSAGE,
    path: ['endDate'],
  });
export type ContractPatch = z.infer<typeof contractPatchSchema>;

export const contractCancelSchema = z
  .object({ reason: z.string().trim().min(1, 'Say why the AMC is cancelled.').max(500) })
  .strict();
export type ContractCancel = z.infer<typeof contractCancelSchema>;
