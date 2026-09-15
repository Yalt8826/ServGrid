/**
 * The push wake's seam, filled from the technician's work query
 * (PLAN-FRONTEND.md §5). A data-only FCM wake runs `handlePushWake`, which
 * needs two things: a way to read the server again, and the job rows
 * before and after, to announce exactly what arrived. Both come from the
 * one in-memory cache entry the screens already read.
 *
 * Registered only once the first work read has answered: before that
 * there is no "before" to diff against, and every job would announce
 * itself as new. A wake before then — or with the app not running —
 * raises nothing, and the next open refetches anyway.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { TechnicianWork } from '@servgrid/shared';
import { TECHNICIAN_WORK_KEY, technicianWorkQuery } from '../screens/technician/useTechnicianWork';
import { useSessionStore } from '../state/sessionStore';
import { setPushSyncExecutor, type PushJobRow } from './handler';

export function pushRowsOf(work: TechnicianWork | undefined): PushJobRow[] {
  return (work?.jobs ?? []).map((job) => ({
    id: job.id,
    jobNumber: job.jobNumber,
    title: job.title,
    status: job.status,
    priority: job.priority,
    scheduledFor: job.scheduledFor,
    contactName: job.contactName,
    version: job.version,
  }));
}

export function PushWakeBridge(): null {
  const technician = useSessionStore((s) => s.actor?.role === 'technician');
  const client = useQueryClient();
  const work = useQuery({ ...technicianWorkQuery(), enabled: technician });
  const ready = technician && work.data !== undefined;

  useEffect(() => {
    if (!ready) return;
    setPushSyncExecutor({
      sync: async () => {
        await client.refetchQueries({ queryKey: TECHNICIAN_WORK_KEY });
      },
      readJobs: () => pushRowsOf(client.getQueryData<TechnicianWork>(TECHNICIAN_WORK_KEY)),
    });
    return () => setPushSyncExecutor(null);
  }, [ready, client]);

  return null;
}
