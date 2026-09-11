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
} from './jobView';

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
 * Read everything the two screens need, in one pass over each table.
 * `completedAtById` dates a completion by the moment its optimistic
 * write was enqueued — the newest such row per job wins.
 */
export function readJobData(
  database: MirrorDatabase,
  employeeId: string,
): {
  views: JobView[];
  completedAtById: Record<string, string>;
  pendingCount: number;
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
    };
  });

  const pendingCount = outboxRows.filter((row) => row.status === 'queued' || row.status === 'inflight').length;

  return { views, completedAtById, pendingCount };
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
