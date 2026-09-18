/**
 * Route-level wiring for the dispatcher's job detail (2026-09-17) — the
 * seam that feeds the pure screen, online-only against the api client
 * like every other dispatcher read.
 *
 * Three reads, and one of them is already in the cache:
 *
 * - **the card** — `GET /v1/jobs/:id`, the dispatcher's own shape
 *   (`JobCardDispatcher`: no money column exists on it).
 * - **the trail** — `GET /v1/jobs/:id/events`, whose dispatcher response
 *   carries the events and nothing else: no completion block, and the
 *   service redacts payloads that could carry money history.
 * - **the roster** — the same `GET /v1/technicians/load` the dashboard
 *   reads, under the same query key, so the assignee's name costs no
 *   request when the console has already been open.
 *
 * The site's contact details come from `GET /v1/customers/:id` — the
 * dispatcher's own customer shape, which is how this screen can offer
 * *Call* without the job card carrying a phone number it deliberately
 * does not have.
 */
import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type {
  CustomerDetailDispatcher,
  JobCardDispatcher,
  TechnicianLoad,
} from '@servgrid/shared';
import { jobTimelineDispatcherResponseSchema } from '@servgrid/shared';
import { api } from '../../lib/api';
import { istBusinessDate } from '../cash/handoverModel';
import type { DispatcherJobDetailDeps } from './jobDetail';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

/** The address as one line for the site panel: street, locality, city. */
function addressLabelOf(customer: CustomerDetailDispatcher): string | null {
  const parts = [
    customer.addressLine1,
    customer.addressLine2,
    customer.area,
    customer.city,
    customer.pincode,
  ].filter((part): part is string => part !== null && part.trim() !== '');
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The three writes, each under the precondition the API demands.
 *
 * `If-Match` is not ceremony here: three dispatchers work the same queue
 * every morning, so the version the operator was looking at rides the
 * request and a lost race comes back as a conflict rather than an
 * overwrite. The version comes from the card this screen rendered — the
 * one the dispatcher actually saw.
 *
 * A refusal is a sentence and nothing else: the sheet stays open with the
 * choice intact, and the card is re-read so the next attempt carries the
 * version the server now holds.
 */
function useJobActions(version: number | null, onWritten: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (call: (ifMatch: string) => Promise<unknown>) => {
      if (version === null) {
        setError('This job is still loading — try again in a moment.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await call(String(version));
        onWritten();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'That change did not go through.');
        onWritten(); // the world may have moved; read it again
      } finally {
        setBusy(false);
      }
    },
    [onWritten, version],
  );

  return { busy, error, run, clearError: () => setError(null) };
}

export function useDispatcherJobDetail(jobId: string, onBack: () => void): DispatcherJobDetailDeps {
  const card = useQuery({
    queryKey: ['dispatch', 'job', jobId],
    queryFn: () => fetchJson<JobCardDispatcher>(`/v1/jobs/${jobId}`),
  });
  const events = useQuery({
    queryKey: ['dispatch', 'job-events', jobId],
    queryFn: async () => {
      const res = await fetchJson<unknown>(`/v1/jobs/${jobId}/events`);
      // The dispatcher's shape, parsed here so a redaction regression is
      // loud rather than something the screen renders half of.
      return jobTimelineDispatcherResponseSchema.parse(res).events;
    },
  });
  const roster = useQuery({
    queryKey: ['dispatch', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  });
  const customerId = card.data?.customerId ?? null;
  const customer = useQuery({
    queryKey: ['dispatch', 'customer', customerId],
    enabled: customerId !== null,
    queryFn: () => fetchJson<CustomerDetailDispatcher>(`/v1/customers/${customerId}`),
  });

  const retry = useCallback(() => {
    void card.refetch();
    void events.refetch();
    void customer.refetch();
  }, [card, events, customer]);

  const addressLabel = customer.data === undefined ? null : addressLabelOf(customer.data);

  // A written job changes the card and its trail: both are re-read, and
  // the roster too (a reassignment moves two technicians' loads).
  const reloadAll = useCallback(() => {
    void card.refetch();
    void events.refetch();
    void roster.refetch();
  }, [card, events, roster]);
  const actions = useJobActions(card.data?.version ?? null, reloadAll);

  /** PATCH/POST that throws the server's sentence — the screens render it verbatim. */
  const write = useCallback(
    async (method: 'POST' | 'PATCH', path: string, body: unknown, ifMatch: string) => {
      const res = await api.request(method, path, { body, headers: { 'If-Match': ifMatch } });
      if (!res.ok || res.data === null) {
        throw new Error(res.error?.message ?? 'That change did not go through.');
      }
      return res.data;
    },
    [],
  );

  return {
    card: card.data ?? null,
    contact:
      customer.data === undefined
        ? null
        : { name: customer.data.name, phone: customer.data.phone, addressLabel },
    roster: (roster.data ?? []).map((row) => ({ employeeId: row.employeeId, name: row.technicianName })),
    events: events.data ?? null,
    loading: card.isLoading || events.isLoading,
    error:
      card.isError || events.isError
        ? ((card.error ?? events.error) as Error).message
        : null,
    onRetry: retry,
    onBack,
    onCall: () => {
      const phone = customer.data?.phone;
      if (phone !== undefined && phone.trim() !== '') void Linking.openURL(`tel:${phone}`);
    },
    onNavigate: () => {
      const lat = customer.data?.latitude;
      const lng = customer.data?.longitude;
      if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
        void Linking.openURL(`google.navigation:q=${lat},${lng}`);
      }
    },
    todayIso: istBusinessDate(new Date()),
    now: new Date(),
    candidates: (roster.data ?? [])
      .map((row) => ({ employeeId: row.employeeId, name: row.technicianName, openTotal: row.openTotal }))
      .sort((a, b) => a.openTotal - b.openTotal),
    actionBusy: actions.busy,
    actionError: actions.error,
    onReassign: (technicianId) => {
      void actions.run((ifMatch) => write('POST', `/v1/jobs/${jobId}/assign`, { technicianId }, ifMatch));
    },
    onReschedule: (scheduledFor) => {
      void actions.run((ifMatch) => write('PATCH', `/v1/jobs/${jobId}`, { scheduledFor }, ifMatch));
    },
    onCancelJob: (body) => {
      void actions.run((ifMatch) => write('POST', `/v1/jobs/${jobId}/cancel`, body, ifMatch));
    },
  };
}
