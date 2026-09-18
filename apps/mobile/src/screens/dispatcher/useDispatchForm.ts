/**
 * Route-level wiring for the dispatcher's D3 Dispatch Job (T2.9). The
 * screen is pure over injected data; this hook is the seam that feeds
 * it — online-only reads against the api client, exactly like
 * `useJobLogs` (the dispatcher never queues: PLAN-FRONTEND.md §4).
 *
 * Reads (§6.4, all live since T2.4):
 * - **search** — `GET /v1/customers?q=` over name and phone, debounced
 *   250ms so mid-call typing fires one request per pause, not per key
 *   (the search itself lives in `useCustomerSearch`, shared with the
 *   AMC form).
 * - **stack** — `GET /v1/customers/:id/stack` for the chosen site, the
 *   unit picker's options, labelled through the catalogue read
 *   (`GET /v1/products`) so a unit reads `UPS 850VA · SN LM8842219`.
 * - **services** — `GET /v1/services` (read: all, write: owner — §6.4).
 * - **roster** — `GET /v1/technicians/load` joined with
 *   `GET /v1/location/health` via the dashboard's `loadRowsOf`, so the
 *   picker's availability reads the same source D1 does.
 * - **the customer's AMC** — `GET /v1/contracts?…&limit=1` for the
 *   chosen customer, while `contracts.manage` is on (decision 2: the
 *   form OFFERS the AMC option, already ticked; decision 3's reminder
 *   gap is the server's word, not this hook's).
 *
 * Submit (PLAN-BACKEND.md §6.3): `POST /v1/jobs` — dispatcher, owner;
 * the server allocates the `JC-…` number; the body carries
 * `contractId` when the customer has an active AMC and the box is
 * ticked — through an intent writer (lib/intentWrite), one key per
 * submit intent pinned WITH its body, so a retry after a dropped
 * connection replays instead of repeating (an edited form is a new
 * intent — the server would 422 a changed body under an old key). And,
 * when the dispatcher named a technician, `POST /v1/jobs/:id/assign`
 * with the `If-Match` version the create just returned. Both doors on
 * this one screen; the toast carries the allocated number either way it
 * ends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';

import type {
  CustomerStackItem,
  JobCardDispatcher,
  ProductRecord,
  ServiceRecord,
  TechnicianLoad,
} from '@servgrid/shared';
import { api } from '../../lib/api';
import {
  CONTRACTS_KEY,
  useActiveContractFor,
} from '../contracts/useContracts';
import { amcOptionLabel } from '../contracts/model';
import { createIntentWriter, type IntentWriter } from '../../lib/intentWrite';
import { isFlagOn } from '../../state/featureFlags';
import { istBusinessDate, loadRowsOf, useIsOnline } from './useDispatcherDashboard';
import { useCustomerSearch } from './useCustomerSearch';
import {
  unitLabelOf,
  type DispatchJobFields,
  type DispatchServiceOption,
  type DispatchTechnician,
  type DispatchUnitOption,
} from './dispatchForm';
import type { DispatchJobDeps } from './dispatch';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

/** One pinned submit intent: the writer holds the key, the JSON holds
 * the body it was minted for. */
interface PinnedSubmit {
  writer: IntentWriter;
  bodyJson: string;
}

export function useDispatchForm(options?: {
  initialCustomerId?: string | null;
  /**
   * Called once the job is RAISED — and assigned, when a technician was
   * named. The form's exit (Yashas, 2026-09-19: "when the dispatch job
   * form is done and created and assigned it should close the form").
   *
   * Deliberately not called when the raise succeeds and the ASSIGN is
   * refused: the job exists, the dispatcher has to read why, and the form
   * is where he retries from.
   */
  onCreated?: () => void;
}): DispatchJobDeps {
  const router = useRouter();
  const queryClient = useQueryClient();
  const offline = !useIsOnline();

  // The one field that is both search and create (§D3) — shared with the
  // AMC form; `initialCustomerId` preselects the deep-linked customer.
  const customerSearch = useCustomerSearch(options);
  const selectedCustomer = customerSearch.selected;

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
  // No tracking-health read here (owner, 2026-09-17): the picker compares
  // loads, and the dispatcher does not consume the technicians'
  // location-reporting state.
  const technicians: DispatchTechnician[] = useMemo(
    () =>
      roster.data === undefined
        ? []
        : loadRowsOf(roster.data).map((row) => ({
            employeeId: row.employeeId,
            name: row.name,
            openTotal: row.load,
          })),
    [roster.data],
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

  // ── the AMC option (decision 2) ─────────────────────────────────────────
  const contractsOn = isFlagOn('contracts.manage');
  const activeAmc = useActiveContractFor(selectedCustomer?.id ?? null, contractsOn);
  const [amcTicked, setAmcTicked] = useState(true);
  // Ticked for every NEWLY picked customer — the reset rides the
  // customer's id alone, so a manual untick survives any other re-render.
  useEffect(() => {
    setAmcTicked(true);
  }, [selectedCustomer?.id]);

  // The close seam, held in a ref: the route passes a fresh arrow each
  // render, and listing `options` in the submit callback's deps would
  // rebuild it for nothing.
  const onCreatedRef = useRef(options?.onCreated);
  onCreatedRef.current = options?.onCreated;

  // ── submit: raise, then assign, then LEAVE ─────────────────────────────
  // It used to end on the screen with a success banner. The dispatcher's
  // next act is the next call, not a confirmation he already knows.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ jobNumber: string; technicianName: string | null } | null>(null);
  const submitIntent = useRef<PinnedSubmit | null>(null);

  const submit = useCallback(
    async (fields: DispatchJobFields): Promise<void> => {
      if (selectedCustomer === null || fields.serviceId === null) return;
      const body = {
        customerId: selectedCustomer.id,
        serviceId: fields.serviceId,
        customerProductId: fields.unitId,
        priority: fields.priority,
        scheduledFor: fields.scheduledFor,
        contactName: fields.contactName === '' ? null : fields.contactName,
        contactPhone: fields.contactPhone === '' ? null : fields.contactPhone,
        description: fields.notes === '' ? null : fields.notes,
        contractId: activeAmc !== null && amcTicked ? activeAmc.id : null,
      };
      const bodyJson = JSON.stringify(body);
      if (submitIntent.current === null || submitIntent.current.bodyJson !== bodyJson) {
        submitIntent.current = { writer: createIntentWriter((method, path, opts) => api.request(method, path, opts)), bodyJson };
      }
      const pinned = submitIntent.current;
      setSubmitting(true);
      setSubmitError(null);
      setSubmitted(null);
      try {
        const created = (await pinned.writer.send('POST', '/v1/jobs', body)) as JobCardDispatcher;
        if (created === null || created === undefined) {
          setSubmitError('The job could not be raised. Try again.');
          return;
        }
        submitIntent.current = null; // accepted — the next submit is a new intent
        // The customer now has an open job — the AMC tab's due list must
        // let him go the next time it reads.
        void queryClient.invalidateQueries({ queryKey: CONTRACTS_KEY });
        let assigneeName: string | null = null;
        if (fields.technicianId !== null) {
          // §6.3: assign carries the `If-Match` version the create just
          // returned — the same guard the queue's assign uses.
          const assigned = await api.request<JobCardDispatcher>('POST', `/v1/jobs/${created.id}/assign`, {
            body: { technicianId: fields.technicianId },
            headers: { 'If-Match': String(created.version) },
          });
          if (!assigned.ok || assigned.data === null) {
            setSubmitError(
              `JC raised as ${created.jobNumber}, but the assignment was refused: ${assigned.error?.message ?? 'try again from the job card.'}`,
            );
            return;
          }
          assigneeName = technicians.find((technician) => technician.employeeId === fields.technicianId)?.name ?? null;
        }
        setSubmitted({ jobNumber: created.jobNumber, technicianName: assigneeName });
        // Raised, and assigned if he named someone: the dispatch is done, so
        // the form closes. A caller without a router (tests) leaves it out
        // and keeps the banner.
        onCreatedRef.current?.();
      } catch (error) {
        // A definite refusal is a finished intent; a dropped connection
        // keeps it, so the retry replays under the same key.
        if (pinned.writer.pendingKey() === null) submitIntent.current = null;
        setSubmitError(error instanceof Error ? error.message : 'The job could not be raised. Try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [selectedCustomer, technicians, activeAmc, amcTicked, queryClient],
  );

  return {
    offline,
    customerQuery: customerSearch.query,
    customers: customerSearch.results,
    customerError: customerSearch.error,
    selectedCustomer,
    stack: selectedCustomer === null ? null : stackUnits,
    services: serviceOptions,
    technicians,
    todayIso: istBusinessDate(new Date()),
    submitting,
    submitError,
    submitted,
    amc: activeAmc === null ? null : { contractId: activeAmc.id, label: amcOptionLabel(activeAmc) },
    amcTicked,
    onCustomerQueryChange: customerSearch.setQuery,
    onSelectCustomer: (customer) => customerSearch.select(customer),
    onNewCustomer: () => router.push('/customers/new'),
    onClearCustomer: () => customerSearch.clear(),
    onToggleAmc: () => setAmcTicked((t) => !t),
    onSubmit: (fields) => void submit(fields),
    onDismissToast: () => {
      setSubmitted(null);
      setSubmitError(null);
    },
  };
}
