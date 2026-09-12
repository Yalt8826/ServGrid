/**
 * Mirror → view: the one read both technician screens are built on
 * (T1.17). Takes the opened mirror's database and the employee id and
 * returns the joined, outbox-annotated `JobView[]` plus the completion
 * instants the outbox kept — the exact shapes `DashboardScreen` and
 * `JobsScreen` render. No React, no react-native: pure data over the
 * `MirrorDatabase` seam, so the tests run it against the real
 * node:sqlite engine (the repo's "no mocked database" rule).
 *
 * The join is the point: the technician's job card names the customer
 * (`JobCardTechnician` carries only `customerId`), and *Navigate*
 * needs the site's coordinates from the customer row. The outbox gives
 * each job its local truth — pending (queued/inflight → the stale
 * inset) and its newest rejection message verbatim — and the instant
 * its completion left the device, which dates "done today" and sorts
 * Completed newest-first.
 */
import type { MirrorDatabase } from '../../db/mirror';
import { rowsForEmployee } from '../../sync/outbox';
import type { JobStatus, JobCardTechnician } from '@servgrid/shared';
import {
  annotateWithOutbox,
  type JobView,
  type UnitView,
} from './jobView';
import { timelineByJob, type JobTimelineEntry } from './jobDetail';

/** A job row as the mirror stores it (snake_case, contract flattened). */
interface JobRecord {
  id: string;
  job_number: string;
  title: string;
  status: string;
  priority: string;
  scheduled_for: string | null;
  customer_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  description: string | null;
  contract_number: string | null;
  contract_billing: string | null;
  contract_visits_remaining: number | null;
  version: number;
}

interface JoinedRecord extends JobRecord {
  customer_name: string | null;
  address_line2: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

const JOB_SELECT = `
SELECT j.id, j.job_number, j.title, j.status, j.priority, j.scheduled_for,
       j.customer_id, j.contact_name, j.contact_phone, j.description,
       j.contract_number, j.contract_billing, j.contract_visits_remaining, j.version,
       c.name AS customer_name, c.address_line2 AS address_line2, c.city AS city,
       c.latitude AS latitude, c.longitude AS longitude
FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
ORDER BY j.job_number`;

/**
 * The unit line (§T3): THE UNIT with serial and warranty expiry. The
 * technician's job-card contract carries no `customer_product_id`, so a
 * job cannot name its unit; the mirror's `customer_products` are the
 * site's ACTIVE units, and a customer with exactly one makes the job's
 * unit unambiguous. A customer with five UPS units names nothing here —
 * the section is omitted rather than guessed.
 */
const UNIT_SELECT = `
SELECT cp.id, cp.customer_id, cp.free_text_name, cp.serial_number, cp.warranty_expires_on,
       p.name AS product_name, p.brand AS product_brand, p.capacity_label AS capacity_label
FROM customer_products cp LEFT JOIN products p ON p.id = cp.product_id`;

interface UnitRecord {
  id: string;
  customer_id: string;
  free_text_name: string | null;
  serial_number: string;
  warranty_expires_on: string | null;
  product_name: string | null;
  product_brand: string | null;
  capacity_label: string | null;
}

function toUnitView(record: UnitRecord): UnitView {
  const descriptor = [record.product_name, record.capacity_label]
    .filter((part): part is string => part !== null)
    .join(' ');
  return {
    name: descriptor !== '' ? descriptor : (record.free_text_name ?? 'Unit'),
    brand: record.product_brand,
    serialNumber: record.serial_number,
    warrantyExpiresOn: record.warranty_expires_on,
  };
}

function toJobStatus(raw: string): JobStatus {
  // The mirror only ever holds values the sync contract's enum wrote;
  // an unreadable row is a corrupted database, not a render concern.
  if (raw !== 'unassigned' && raw !== 'assigned' && raw !== 'en_route' && raw !== 'in_progress' && raw !== 'completed' && raw !== 'cancelled') {
    throw new Error(`Mirror job has an unreadable status "${raw}" — the schema was violated.`);
  }
  return raw;
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

function toJobCard(record: JoinedRecord): JobCardTechnician {
  const priority = (PRIORITIES as readonly string[]).includes(record.priority)
    ? (record.priority as (typeof PRIORITIES)[number])
    : 'normal';
  return {
    id: record.id,
    jobNumber: record.job_number,
    title: record.title,
    status: toJobStatus(record.status),
    priority,
    scheduledFor: record.scheduled_for,
    customerId: record.customer_id,
    contactName: record.contact_name,
    contactPhone: record.contact_phone,
    description: record.description,
    contract:
      record.contract_number !== null && record.contract_billing !== null
        ? {
            number: record.contract_number,
            billing: record.contract_billing === 'upfront' ? 'upfront' : 'per_visit',
            visitsRemaining: record.contract_visits_remaining ?? 0,
          }
        : null,
    version: record.version,
  };
}

/**
 * Read everything the technician's screens need, in one pass over each
 * table. `completedAtById` dates a completion by the moment its optimistic
 * write was enqueued — the newest such row per job wins. `eventsByJobId`
 * folds the outbox into each job's local timeline (§T3; see `jobDetail`).
 */
export function readJobData(
  database: MirrorDatabase,
  employeeId: string,
): {
  views: JobView[];
  completedAtById: Record<string, string>;
  pendingCount: number;
  eventsByJobId: Record<string, JobTimelineEntry[]>;
  /** The catalogue the complete sheet's parts picker offers (T1.19). */
  products: Array<{ id: string; name: string; category: string }>;
} {
  const records = database.getAllSync<JoinedRecord>(JOB_SELECT);
  const outboxRows = rowsForEmployee(database, employeeId);

  const annotate = annotateWithOutbox(outboxRows, (row) =>
    row.entityType === 'job' ? row.entityLocalId : null,
  );

  const completedAtById: Record<string, string> = {};
  for (const row of outboxRows) {
    if (row.entityType === 'job' && row.path.endsWith('/completions')) {
      const previous = completedAtById[row.entityLocalId];
      if (previous === undefined || previous < row.createdAt) {
        completedAtById[row.entityLocalId] = row.createdAt;
      }
    }
  }

  // Units per customer; only an unambiguous single unit is named.
  const unitsByCustomer = new Map<string, UnitRecord[]>();
  for (const record of database.getAllSync<UnitRecord>(UNIT_SELECT)) {
    const units = unitsByCustomer.get(record.customer_id) ?? [];
    units.push(record);
    unitsByCustomer.set(record.customer_id, units);
  }
  const loneUnitByCustomer = new Map<string, UnitView>();
  for (const [customerId, units] of unitsByCustomer) {
    if (units.length === 1) loneUnitByCustomer.set(customerId, toUnitView(units[0]!));
  }

  const eventsByJobId = timelineByJob(outboxRows);

  const views: JobView[] = records.map((record) => {
    const state = annotate(record.id);
    return {
      job: toJobCard(record),
      customerName: record.customer_name ?? 'Customer',
      area: record.address_line2 ?? record.city ?? '',
      coordinates:
        record.latitude !== null && record.longitude !== null
          ? { latitude: record.latitude, longitude: record.longitude }
          : null,
      pending: state.pending,
      rejectedMessage: state.rejectedMessage,
      unit: loneUnitByCustomer.get(record.customer_id) ?? null,
    };
  });

  const pendingCount = outboxRows.filter((row) => row.status === 'queued' || row.status === 'inflight').length;

  // The parts catalogue (T1.19): the mirror's products, name order —
  // the same rows the sync working set upserts, so the picker is local
  // truth like everything else on this screen.
  const products = database
    .getAllSync<{ id: string; name: string; category: string }>('SELECT id, name, category FROM products ORDER BY name')
    .map((product) => ({ id: product.id, name: product.name, category: product.category }));

  return { views, completedAtById, pendingCount, eventsByJobId, products };
}

/**
 * The optimistic half of *Start job* / *Arrive* (§T1): move the mirror
 * row FIRST — the screen already shows the new state — then let the
 * caller enqueue the outbox row. Returns the row's previous status so a
 * failed enqueue can be reverted: a mirror that ran ahead of a queue
 * that does not exist is silent data loss, the exact failure the outbox
 * exists to prevent.
 *
 * Returns null when the job is not in the mirror (nothing to move).
 */
export function moveJobStatus(
  database: MirrorDatabase,
  jobId: string,
  to: JobStatus,
): { from: JobStatus; version: number } | null {
  const before = database.getFirstSync<{ status: string; version: number }>(
    'SELECT status, version FROM jobs WHERE id = ?',
    jobId,
  );
  if (before === null) return null;
  database.runSync('UPDATE jobs SET status = ?, version = version + 1 WHERE id = ?', to, jobId);
  return { from: toJobStatus(before.status), version: before.version };
}

/** Revert an optimistic move whose enqueue failed. */
export function revertJobStatus(
  database: MirrorDatabase,
  jobId: string,
  previous: { from: JobStatus; version: number },
): void {
  database.runSync('UPDATE jobs SET status = ?, version = ? WHERE id = ?', previous.from, previous.version, jobId);
}
