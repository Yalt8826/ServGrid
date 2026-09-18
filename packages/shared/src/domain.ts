/**
 * Domain types mirroring the schema (PLAN-DATA-MODEL.md §3). Shape notes
 * carry the parts a TypeScript reader would otherwise re-derive from SQL:
 * the money-is-numeric rule, the generated columns, and the constraints
 * the service layer relies on. Identity is `uuid` end to end; money is
 * `numeric(12,2)` in the DB and crosses the wire as a decimal *string*
 * (a JS number loses cents above ~9e12).
 */

import type { JobStatus } from './status.ts';

export type EmployeeRole = 'owner' | 'dispatcher' | 'technician' | 'sales_rep';

export interface Employee {
  id: string;
  username: string; // ^[a-z0-9._-]{3,32}$, citext UNIQUE
  fullName: string;
  phone: string;
  role: EmployeeRole; // DB enum employee_role
  isActive: boolean;
  mustChangePassword: boolean;
  createdBy: string | null;
  lastLoginAt: string | null; // timestamptz → ISO string
}

export interface Device {
  id: string;
  employeeId: string;
  installId: string; // UNIQUE (employee_id, install_id)
  platform: 'android' | 'ios' | 'web';
  appVersion: string;
  osVersion: string;
  manufacturer: string;
  model: string;
  fcmToken: string | null;
  locationPermission: 'none' | 'foreground' | 'background';
  batteryOptExempt: boolean;
  autostartConfirmed: boolean;
  notificationsEnabled: boolean;
  lastSeenAt: string | null;
}

export interface Company {
  id: string;
  name: string; // case-insensitive unique among active rows
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  /** The premises. `GET /v1/companies` has always sent these — the
   * service maps every row through `CompanySchema` — and the rep's sale
   * form reads `city` off the list to caption an account with where it
   * is, so a search can find it by the locality. */
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  notes: string | null;
  /** NULL = house account, visible to every rep (PLAN-GAPS.md G3). */
  ownerRepId: string | null;
  isActive: boolean;
  version: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string; // NOT NULL
  altPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  /** The locality — "Rajajinagar", "HSR Layout" (migration 021). */
  area: string | null;
  city: string | null;
  pincode: string | null;
  notes: string | null;
  /** Paired with longitude — CHECK ((latitude IS NULL) = (longitude IS NULL)). */
  latitude: number | null;
  longitude: number | null;
  /** Owner and rep field; stripped from dispatcher payloads (PLAN-BACKEND §5 rule 3). */
  companyId: string | null;
  version: number;
}

export interface Product {
  id: string;
  sku: string; // UNIQUE
  name: string;
  category: 'ups' | 'battery' | 'inverter' | 'accessory' | 'spare';
  brand: string | null;
  modelNumber: string | null;
  /** Display-only: "850VA", "150Ah". */
  capacityLabel: string | null;
  unit: string | null;
  defaultPrice: string;
  warrantyMonths: number | null;
  isActive: boolean;
}

export interface Service {
  id: string;
  code: string; // UNIQUE — INSTALL, AMC, BATT-SWAP
  name: string;
  description: string | null;
  defaultCharge: string;
  isActive: boolean;
}

export interface CustomerProduct {
  id: string;
  customerId: string;
  productId: string | null;
  /** Required when productId IS NULL — third-party kit. */
  freeTextName: string | null;
  serialNumber: string | null;
  quantity: number;
  installedOn: string | null;
  warrantyExpiresOn: string | null;
  installedBy: string | null;
  /** Set when the change came through a completion; absence = a standalone correction. */
  sourceJobId: string | null;
  isActive: boolean;
  version: number;
}

export interface JobCard {
  id: string;
  /** `JC-2627-00042`; allocated at create, NOT NULL. */
  jobNumber: string;
  customerId: string;
  serviceId: string;
  customerProductId: string | null;
  contractVisitId: string | null;
  title: string;
  description: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: JobStatus; // DB enum job_status
  assignedTo: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  scheduledFor: string | null;
  /** Generated from scheduled_for in Asia/Kolkata. */
  scheduledDate: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdBy: string;
  closedAt: string | null;
  version: number;
}

/** No money columns — the load-bearing decision (PLAN-DATA-MODEL.md §3.3). */
export interface JobCompletion {
  jobCardId: string; // 1:1, PK is job_card_id
  completedBy: string;
  completedAt: string;
  /** Generated from completed_at in Asia/Kolkata. */
  businessDate: string;
  workSummary: string;
  cost: string | null;
  discountAmount: string | null;
  discountReason: string | null; // a discount requires a reason (DB CHECK)
  amountCollected: string | null;
  collectionMode: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'none';
  paymentReference: string | null;
  customerSigned: boolean;
  latitude: number | null;
  longitude: number | null;
  version: number;
}

export type JobEventType =
  | 'created'
  | 'assigned'
  | 'reassigned'
  | 'status_changed'
  | 'rescheduled'
  | 'completed'
  | 'completion_amended'
  | 'cancelled'
  | 'attachment_added'
  | 'stack_updated';

/** Append-only, never updated, never deleted. */
export interface JobEvent {
  id: number; // bigint identity
  jobCardId: string;
  eventType: JobEventType;
  /** NULL for system (the contract-visit generator). */
  actorId: string | null;
  occurredAt: string;
  recordedAt: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus | null;
  source: 'mobile' | 'web' | 'system';
  idempotencyKey: string | null;
  payload: unknown;
}

export interface SalesCard {
  id: string;
  /** Allocated at *confirm*; NULL while draft — draft means no number (§3.5). */
  saleNumber: string | null;
  companyId: string;
  salesRepId: string;
  saleDate: string;
  status: 'draft' | 'confirmed' | 'void';
  notes: string | null;
  confirmedAt: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  version: number;
}

export interface SalesCardItem {
  id: string;
  salesCardId: string;
  lineNo: number;
  productId: string | null;
  /** Snapshots — a price edit later must not rewrite history. */
  productName: string;
  productSku: string | null;
  quantity: number;
  unitPrice: string;
  /** Migration 019: the list price and percent off it — null for a typed price. */
  listPrice: string | null;
  discountPct: string | null;
  /** Generated: round(quantity * unit_price, 2). */
  lineTotal: string;
  serialNumbers: string[];
}

/** Allocated at create, NOT NULL — the opposite of sale_number on purpose (§3.5). */
export interface Payment {
  id: string;
  paymentNumber: string;
  companyId: string;
  /** NULL = on-account. */
  salesCardId: string | null;
  amount: string; // > 0 (DB CHECK)
  mode: 'cash' | 'upi' | 'card' | 'cheque' | 'bank_transfer';
  referenceNo: string | null;
  receivedBy: string;
  receivedAt: string;
  /** Generated from received_at in Asia/Kolkata. */
  businessDate: string;
  status: 'collected' | 'void';
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  notes: string | null;
  version: number;
}

export interface ServiceContract {
  id: string;
  /** Nullable while draft — allocated at activation (§3.10). */
  contractNumber: string | null;
  customerId: string;
  serviceId: string;
  startDate: string;
  endDate: string; // CHECK (end_date > start_date)
  visitsIncluded: number; // > 0
  visitIntervalDays: number;
  contractValue: string;
  billing: 'upfront' | 'per_visit';
  status: 'draft' | 'active' | 'expired' | 'cancelled';
  soldBy: string;
  notes: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  version: number;
}

export type VisitStatus = 'scheduled' | 'job_created' | 'completed' | 'skipped';

export interface ContractVisit {
  id: string;
  contractId: string;
  seqNo: number;
  dueDate: string;
  status: VisitStatus; // skipped requires skipped_reason (DB CHECK)
  skippedReason: string | null;
}

/** `status ≠ 'skipped' OR skipped_reason IS NOT NULL` lives in the DB. */
export interface JobCancellation {
  id: string;
  jobCardId: string;
  cancelledBy: string;
  cancelledAt: string;
  reasonCode:
    | 'customer_unavailable'
    | 'customer_cancelled'
    | 'duplicate'
    | 'wrong_details'
    | 'no_access'
    | 'parts_unavailable'
    | 'rescheduled_by_office'
    | 'contract_cancelled'
    | 'other';
  /** Required when reason_code is `other` (DB CHECK). */
  reasonNote: string | null;
  replacementJobId: string | null;
}

export interface CashReconciliation {
  id: string;
  employeeId: string;
  businessDate: string; // UNIQUE (employee_id, business_date)
  declaredAmount: string;
  declaredAt: string;
  employeeNote: string | null;
  status: 'submitted' | 'confirmed' | 'disputed';
  confirmedAmount: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  ownerNote: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
}

export interface Attachment {
  id: string;
  ownerType:
    | 'job_card'
    | 'job_completion'
    | 'payment'
    | 'sales_card'
    | 'customer'
    | 'employee'
    | 'service_contract';
  ownerId: string;
  kind: 'photo' | 'signature' | 'document';
  storageKey: string; // UNIQUE — {ownerType}/{yyyy}/{mm}/{uuid}.{ext}
  mimeType: string;
  sizeBytes: number; // capped 15 MB
  width: number | null;
  height: number | null;
  checksumSha256: string;
  caption: string | null;
  uploadedBy: string;
  capturedAt: string | null;
  uploadedAt: string;
}

export interface LocationPing {
  id: number; // bigint identity
  employeeId: string;
  deviceId: string;
  recordedAt: string; // device clock; UNIQUE (employee_id, recorded_at)
  receivedAt: string; // server clock
  /** Generated from recorded_at in Asia/Kolkata — money and presence land on the day taken. */
  businessDate: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  batteryPct: number | null;
  isMoving: boolean | null;
  source: 'scheduled' | 'on_demand' | 'live' | 'manual';
}

export interface Consent {
  employeeId: string;
  kind: 'location_tracking';
  /** The date string of the copy revision — bumping it re-prompts every employee. */
  version: string;
  acceptedAt: string;
  deviceId: string | null;
  ipAddress: string | null; // recorded by the server; a client-sent value is ignored (DPDP evidence)
}
