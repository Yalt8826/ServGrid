/**
 * Dispatcher job detail — the pure half (2026-09-17).
 *
 * The console's first job-shaped screen: until now every tap that should
 * show one job (a needs-attention card, a Job Logs row) landed on a bare
 * "Job detail" placeholder. This module holds the decisions with no React
 * and no fetch, so they are testable directly:
 *
 * - **what a status reads as** — the label and the ink, from the shared
 *   `STATUS` tokens. The dispatcher's copy of this map already lived in
 *   `job-logs.tsx` and `customer.tsx`; this is the third, and the three
 *   should become one shared helper the day a fourth appears.
 * - **what an event reads as** — `job_events.event_type` is a machine
 *   word (`status_changed`, `reassignment`); the timeline says it in the
 *   dispatcher's language.
 * - **money never appears.** `JobCardDispatcher` has no money column, and
 *   this module has no helper that could produce one — the type is the
 *   guarantee, and the screen test walks the tree for a currency symbol.
 */
import type { JobCardDispatcher, JobStatus, JobTimelineEvent } from '@servgrid/shared';
import { STATUS } from '@servgrid/shared';

/** A status as the console says it: the word and the ink beside it. */
export interface StatusTone {
  label: string;
  color: string;
}

/**
 * The dispatcher's status words. `assigned` shares `unassigned`'s slate —
 * both are "waiting", and the distinction the technician cares about (is
 * it mine) is not one the dispatcher's console draws.
 */
export function statusToneOf(status: JobStatus): StatusTone {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: STATUS.completed };
    case 'en_route':
      return { label: 'En route', color: STATUS.en_route };
    case 'in_progress':
      return { label: 'In progress', color: STATUS.in_progress };
    case 'cancelled':
      return { label: 'Cancelled', color: STATUS.cancelled };
    default:
      return { label: 'Assigned', color: STATUS.unassigned };
  }
}

/** The priority chip's word, or null when there is nothing to say. */
export function priorityLabelOf(priority: JobCardDispatcher['priority']): string | null {
  if (priority === 'urgent') return 'Urgent';
  if (priority === 'high') return 'High';
  if (priority === 'low') return 'Low';
  return null; // `normal` is the resting state — a chip for it is noise
}

/** The line under the title: the slot in the dispatcher's own words. */
export function slotLabelOf(card: JobCardDispatcher, now: Date): string {
  if (card.scheduledFor === null) return 'No date set';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(card.scheduledFor));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(card.scheduledFor));
  if (card.isOverdue) return `was due ${day} · ${time}`;
  if (day === today) return `today · ${time}`;
  return `${day} · ${time}`;
}

/** `YYYY-MM-DD HH:MM` in IST — the timeline's stamp, day included. */
export function eventStampOf(occurredAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(occurredAt));
}

/**
 * An event in the dispatcher's language. `status_changed` reads as the
 * move it made (`Assigned → En route`) because that is the fact; the
 * others name the act.
 */
export function eventLabelOf(event: JobTimelineEvent): string {
  switch (event.eventType) {
    case 'created':
      return 'Raised';
    case 'assigned':
      return 'Assigned';
    case 'reassigned':
      return 'Reassigned';
    case 'rescheduled':
      return 'Rescheduled';
    case 'completed':
      return 'Completed';
    case 'completion_amended':
      return 'Completion amended';
    case 'cancelled':
      return 'Cancelled';
    case 'attachment_added':
      return 'Photo attached';
    case 'stack_updated':
      return 'Site equipment updated';
    case 'status_changed':
      return event.toStatus === null
        ? 'Status changed'
        : `${event.fromStatus === null ? 'Set' : statusToneOf(event.fromStatus).label} → ${statusToneOf(event.toStatus).label}`;
    default:
      return 'Updated';
  }
}

/**
 * The assignee's name from the roster read — the card carries a uuid and
 * nothing else (`GET /v1/employees` is owner-only), so the console names
 * him the same way the load rows do. Null reads as "Unassigned"; an id
 * the roster does not know still reads as unassigned rather than as a
 * uuid nobody can act on.
 */
export function assigneeNameOf(
  assignedTo: string | null,
  roster: readonly { employeeId: string; name: string }[],
): string | null {
  if (assignedTo === null) return null;
  return roster.find((row) => row.employeeId === assignedTo)?.name ?? null;
}
