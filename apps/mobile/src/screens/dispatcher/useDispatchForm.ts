/**
 * Route-level wiring for the dispatcher's D3 Dispatch Job (T2.9). The
 * screen is pure over injected data; this hook is the seam that feeds
 * it — online-only reads against the api client, exactly like
 * `useJobLogs` (the dispatcher never queues: PLAN-FRONTEND.md §4).
 *
 * Reads (§6.4, all live since T2.4):
 * - **search** — `GET /v1/customers?q=` over name and phone, debounced
 *   250ms so mid-call typing fires one request per pause, not per key.
 * - **stack** — `GET /v1/customers/:id/stack` for the chosen site, the
 *   unit picker's options, labelled through the catalogue read
 *   (`GET /v1/products`) so a unit reads `UPS 850VA · SN LM8842219`.
 * - **services** — `GET /v1/services` (read: all, write: owner — §6.4).
 * - **roster** — `GET /v1/technicians/load` joined with
 *   `GET /v1/location/health` via the dashboard's `loadRowsOf`, so the
 *   picker's availability reads the same source D1 does.
 *
 * Submit (PLAN-BACKEND.md §6.3): `POST /v1/jobs` — dispatcher, owner;
 * the server allocates the `JC-…` number — and, when the dispatcher
 * named a technician, `POST /v1/jobs/:id/assign` with the `If-Match`
 * version the create just returned. Both doors on this one screen; the
 * toast carries the allocated number either way it ends. NOTE: the
 * create door is the one §6.3 endpoint not yet built api-side ("later
 * tasks on the same module" — jobs/routes.ts); the request/response
 * here is the shape the table and the endpoint table already fix:
 * `job_cards` columns in, `JobCardDispatcher` out.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';

import type {
  CustomerDispatcher,
  CustomerStackItem,
  JobCardDispatcher,
  ProductRecord,
  ServiceRecord,
  TechnicianLoad,
  TrackingHealth,
} from '@servgrid/shared';
import { api } from '../../lib/api';
import { istBusinessDate, loadRowsOf, useIsOnline } from './useDispatcherDashboard';
import {
  unitLabelOf,
  type DispatchCustomerOption,
  type DispatchJobFields,
  type DispatchServiceOption,
  type DispatchTechnician,
  type DispatchUnitOption,
} from './dispatchForm';
import type { DispatchJobDeps } from './dispatch';

/** One keystroke pause worth of debounce — mid-call typing searches on
 * the pause, not on every character. */
const SEARCH_DEBOUNCE_MS = 250;
/** A phone-screen of results; the dispatcher is narrowing, not browsing. */
const SEARCH_LIMIT = 20;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface CustomerListEnvelope {
  items: CustomerDispatcher[];
  nextCursor: string | null;
}

function customerOptionOf(row: CustomerDispatcher): DispatchCustomerOption {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    addressLabel: row.addressLine1 ?? row.city ?? null,
  };
}

export function useDispatchForm(): DispatchJobDeps {
  const router = useRouter();
  const offline = useIsOnline();

  // The one field that is both search and create (§D3).
  const [customerQuery, setCustomerQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<DispatchCustomerOption | null>(null);

  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(customerQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [customerQuery]);

  const searchActive = selectedCustomer === null && debouncedQuery.trim() !== '';

  const search = useQuery({
    queryKey: ['dispatch', 'customer-search', debouncedQuery.trim()],
    queryFn: () =>
      fetchJson<CustomerListEnvelope>(
        `/v1/customers?q=${encodeURIComponent(debouncedQuery.trim())}&limit=${SEARCH_LIMIT}`,
      ),
    enabled: searchActive,
  });

  const stack = useQuery({
    queryKey: ['dispatch', 'customer-stack', selectedCustomer?.id],
    queryFn: () => fetchJson<CustomerStackItem[]>(`/v1/customers/${selectedCustomer!.id}/stack`),
    enabled: selectedCustomer !== null,
  });

  // Small, slow-moving tables (§6.4): the whole active catalogue, no
  // pagination — the picker labels and the service picker read them.
  const products = useQuery({
    queryKey: ['dispatch', 'catalogue-products'],
    queryFn: () => fetchJson<ProductRecord[]>('/v1/products'),
  });
  const services = useQuery({
    queryKey: ['dispatch', 'catalogue-services'],
    queryFn: () => fetchJson<ServiceRecord[]>('/v1/services'),
  });

  const roster = useQuery({
    queryKey: ['dispatch', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  });
  const health = useQuery({
    queryKey: ['dispatch', 'roster-health'],
    queryFn: () => fetchJson<TrackingHealth[]>('/v1/location/health'),
  });

  const technicians: DispatchTechnician[] = useMemo(
    () =>
      roster.data === undefined
        ? []
        : loadRowsOf(roster.data, health.data ?? []).map((row) => ({
            employeeId: row.employeeId,
            name: row.name,
            openTotal: row.load,
            health: row.health,
          })),
    [roster.data, health.data],
  );

  const stackUnits: DispatchUnitOption[] | null = useMemo(() => {
    if (stack.data === undefined) return null; // still loading
    const nameOf = new Map((products.data ?? []).map((product) => [product.id, product.name] as const));
    return stack.data.map((item) => ({
      id: item.id,
      label: unitLabelOf({
        productName: item.productId === null ? null : (nameOf.get(item.productId) ?? null),
        freeTextName: item.freeTextName,
        serialNumber: item.serialNumber,
      }),
    }));
  }, [stack.data, products.data]);

  const serviceOptions: DispatchServiceOption[] = useMemo(
    () => (services.data ?? []).map((service) => ({ id: service.id, name: service.name })),
    [services.data],
  );

  // ── submit: raise, then assign — both without leaving the screen ────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ jobNumber: string; technicianName: string | null } | null>(null);

  const submit = useCallback(
    async (fields: DispatchJobFields): Promise<void> => {
      if (selectedCustomer === null || fields.serviceId === null) return;
      setSubmitting(true);
      setSubmitError(null);
      setSubmitted(null);
      try {
        const created = await api.request<JobCardDispatcher>('POST', '/v1/jobs', {
          body: {
            customerId: selectedCustomer.id,
            serviceId: fields.serviceId,
            customerProductId: fields.unitId,
            priority: fields.priority,
            scheduledFor: fields.scheduledFor,
            contactName: fields.contactName === '' ? null : fields.contactName,
            contactPhone: fields.contactPhone === '' ? null : fields.contactPhone,
            description: fields.notes === '' ? null : fields.notes,
          },
        });
        if (!created.ok || created.data === null) {
          setSubmitError(created.error?.message ?? 'The job could not be raised. Try again.');
          return;
        }
        const card = created.data;
        let assigneeName: string | null = null;
        if (fields.technicianId !== null) {
          // §6.3: assign carries the `If-Match` version the create just
          // returned — the same guard the queue's assign uses.
          const assigned = await api.request<JobCardDispatcher>('POST', `/v1/jobs/${card.id}/assign`, {
            body: { technicianId: fields.technicianId },
            headers: { 'If-Match': String(card.version) },
          });
          if (!assigned.ok || assigned.data === null) {
            setSubmitError(
              `JC raised as ${card.jobNumber}, but the assignment was refused: ${assigned.error?.message ?? 'try again from the job card.'}`,
            );
            return;
          }
          assigneeName = technicians.find((technician) => technician.employeeId === fields.technicianId)?.name ?? null;
        }
        setSubmitted({ jobNumber: card.jobNumber, technicianName: assigneeName });
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'The job could not be raised. Try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [selectedCustomer, technicians],
  );

  return {
    offline,
    customerQuery,
    customers: search.data === undefined ? null : (search.data.items.map(customerOptionOf) as DispatchCustomerOption[]),
    customerError: search.isError ? (search.error?.message ?? 'The search did not go through. Try again.') : null,
    selectedCustomer,
    stack: selectedCustomer === null ? null : stackUnits,
    services: serviceOptions,
    technicians,
    todayIso: istBusinessDate(new Date()),
    submitting,
    submitError,
    submitted,
    onCustomerQueryChange: setCustomerQuery,
    onSelectCustomer: (customer) => {
      setSelectedCustomer(customer);
      setCustomerQuery('');
    },
    onNewCustomer: () => router.push('/customers/new'),
    onClearCustomer: () => setSelectedCustomer(null),
    onSubmit: (fields) => void submit(fields),
    onDismissToast: () => {
      setSubmitted(null);
      setSubmitError(null);
    },
  };
}
