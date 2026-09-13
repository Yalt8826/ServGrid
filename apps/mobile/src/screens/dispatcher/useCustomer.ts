/**
 * Route-level wiring for the dispatcher's D4 Customer screens (T2.10).
 * The screens are pure over injected data; this module is the seam that
 * feeds them — online-only reads against the api client, exactly like
 * `useDispatchForm` (the dispatcher never queues: PLAN-FRONTEND.md §4).
 *
 * Reads (§6.4, all live since T2.4):
 * - **search** — `GET /v1/customers?q=` over name and phone, debounced
 *   250ms so mid-call typing fires one request per pause, not per key.
 * - **detail** — `GET /v1/customers/:id`, the `CustomerDetailDispatcher`
 *   shape: no `companyId` exists on it to render, and the stack rides
 *   along. The catalogue read (`GET /v1/products`) labels the units so a
 *   stack row reads `UPS 850VA · SN LM8842219`.
 * - **history** — `GET /v1/jobs?customerId=` — the server orders by
 *   `created_at DESC`, so the site's newest job leads. The roster read
 *   (`GET /v1/technicians/load`) names the technician on each row —
 *   `GET /v1/employees` is owner-only.
 *
 * Writes (§6.4): `POST /v1/customers` to create and `PATCH
 * /v1/customers/:id` with the `If-Match` version the read returned to
 * correct. The bodies come from `customerForm.ts`, whose shapes carry no
 * `companyId` — the server's dispatcher schemas strip it again regardless
 * (§5 rule 3).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';

import type {
  CustomerDetailDispatcher,
  CustomerDispatcher,
  JobCardDispatcher,
  ProductRecord,
  TechnicianLoad,
} from '@servgrid/shared';
import { api } from '../../lib/api';
import { useIsOnline } from './useDispatcherDashboard';
import { unitLabelOf } from './dispatchForm';
import {
  customerCreateBody,
  customerFormOf,
  customerPatchBody,
  emptyCustomerForm,
  type CustomerFormFields,
} from './customerForm';
import type {
  CustomerDetailDeps,
  CustomerFormDeps,
  CustomerHistoryJob,
  CustomerSearchDeps,
  CustomerSearchRow,
  CustomerStackUnit,
} from './customer';

/** One keystroke pause worth of debounce — mid-call typing searches on
 * the pause, not on every character (the same debounce D3's search uses). */
const SEARCH_DEBOUNCE_MS = 250;
/** A phone-screen of results; the dispatcher is narrowing, not browsing. */
const SEARCH_LIMIT = 20;
/** A site's history in one page — the dispatcher scans it, never pages. */
const HISTORY_LIMIT = 100;

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

interface JobListEnvelope {
  items: JobCardDispatcher[];
  nextCursor: string | null;
}

function searchRowOf(row: CustomerDispatcher): CustomerSearchRow {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    addressLabel: row.addressLine1 ?? row.city ?? null,
  };
}

// ── /customers ───────────────────────────────────────────────────────────

export function useCustomerSearch(): CustomerSearchDeps {
  const router = useRouter();
  const offline = !useIsOnline();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchActive = debouncedQuery.trim() !== '';
  const search = useQuery({
    queryKey: ['dispatch', 'customer-search', debouncedQuery.trim()],
    queryFn: () =>
      fetchJson<CustomerListEnvelope>(
        `/v1/customers?q=${encodeURIComponent(debouncedQuery.trim())}&limit=${SEARCH_LIMIT}`,
      ),
    enabled: searchActive,
  });

  return {
    offline,
    query,
    results:
      !searchActive || search.data === undefined
        ? null
        : search.data.items.map(searchRowOf),
    error: search.isError ? (search.error?.message ?? 'The search did not go through. Try again.') : null,
    onQueryChange: setQuery,
    onRetry: () => {
      void search.refetch();
    },
    onOpenCustomer: (customerId) => router.push(`/customers/${customerId}`),
    onNewCustomer: () => router.push('/customers/new'),
  };
}

// ── /customers/[id] ──────────────────────────────────────────────────────

export function useCustomerDetail(customerId: string): CustomerDetailDeps {
  const router = useRouter();
  const offline = !useIsOnline();

  const detail = useQuery({
    queryKey: ['dispatch', 'customer-detail', customerId],
    queryFn: () => fetchJson<CustomerDetailDispatcher>(`/v1/customers/${customerId}`),
  });

  // Small, slow-moving table (§6.4): labels the stack's units.
  const products = useQuery({
    queryKey: ['dispatch', 'catalogue-products'],
    queryFn: () => fetchJson<ProductRecord[]>('/v1/products'),
  });

  // The site's jobs, newest first (the server orders `created_at DESC`).
  const history = useQuery({
    queryKey: ['dispatch', 'customer-history', customerId],
    queryFn: () =>
      fetchJson<JobListEnvelope>(`/v1/jobs?customerId=${customerId}&limit=${HISTORY_LIMIT}`),
  });

  // Names for the history rows — the roster read, not `GET /v1/employees`
  // (owner-only), the same source D1's attention rows use.
  const roster = useQuery({
    queryKey: ['dispatch', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  });

  const stack: CustomerStackUnit[] | null = useMemo(() => {
    if (detail.data === undefined) return null;
    const nameOf = new Map((products.data ?? []).map((product) => [product.id, product.name] as const));
    return detail.data.stack.map((item) => ({
      id: item.id,
      label: unitLabelOf({
        productName: item.productId === null ? null : (nameOf.get(item.productId) ?? null),
        freeTextName: item.freeTextName,
        serialNumber: item.serialNumber,
      }),
    }));
  }, [detail.data, products.data]);

  const historyRows: CustomerHistoryJob[] | null = useMemo(() => {
    if (history.data === undefined) return null;
    const nameOf = new Map((roster.data ?? []).map((row) => [row.employeeId, row.technicianName] as const));
    return history.data.items.map((card) => ({
      id: card.id,
      jobNumber: card.jobNumber,
      title: card.title,
      status: card.status,
      scheduledFor: card.scheduledFor,
      technicianName: card.assignedTo === null ? null : (nameOf.get(card.assignedTo) ?? null),
    }));
  }, [history.data, roster.data]);

  const retry = useCallback((): void => {
    void detail.refetch();
    void history.refetch();
  }, [detail, history]);

  return {
    offline,
    detail: detail.data ?? null,
    stack,
    history: historyRows,
    detailError: detail.isError ? (detail.error?.message ?? "The site could not be loaded. Try again.") : null,
    historyError: history.isError ? (history.error?.message ?? 'The job history could not be loaded. Try again.') : null,
    onCall: (phone) => {
      void Linking.openURL(`tel:${phone}`);
    },
    onEdit: () => router.push(`/customers/${customerId}/edit`),
    onOpenJob: (jobId) => router.push(`/jobs/${jobId}`),
    onRetry: retry,
  };
}

// ── /customers/new and /customers/[id]/edit ──────────────────────────────

export function useCustomerForm(customerId?: string): CustomerFormDeps {
  const router = useRouter();
  const offline = !useIsOnline();
  const editing = customerId !== undefined;

  const detail = useQuery({
    queryKey: ['dispatch', 'customer-detail', customerId],
    queryFn: () => fetchJson<CustomerDetailDispatcher>(`/v1/customers/${customerId ?? ''}`),
    enabled: editing,
  });

  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const save = useCallback(
    (fields: CustomerFormFields): void => {
      setSaving(true);
      setSubmitError(null);
      void (async () => {
        try {
          if (!editing) {
            const created = await api.request<{ id: string }>('POST', '/v1/customers', {
              body: customerCreateBody(fields),
            });
            if (!created.ok || created.data === null) {
              setSubmitError(created.error?.message ?? 'The customer could not be saved. Try again.');
              return;
            }
            // Land on the site the dispatcher just created — the call is
            // still going and the detail is what comes next.
            router.replace(`/customers/${created.data.id}`);
            return;
          }
          const current = detail.data;
          if (current === undefined) {
            setSubmitError('The site has not finished loading. Try again.');
            return;
          }
          const body = customerPatchBody(customerFormOf(current), fields);
          if (body === null) {
            // Nothing changed: the api would refuse the empty patch with
            // exactly this sentence — show it without the round trip.
            setSubmitError('Nothing to change.');
            return;
          }
          const patched = await api.request('PATCH', `/v1/customers/${customerId}`, {
            body,
            // §6.4: the optimistic-concurrency guard — the version the
            // read returned; a stale edit comes back 409 naming it.
            headers: { 'If-Match': String(current.version) },
          });
          if (!patched.ok || patched.data === null) {
            setSubmitError(patched.error?.message ?? 'The change could not be saved. Try again.');
            return;
          }
          router.back();
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : 'The change could not be saved. Try again.');
        } finally {
          setSaving(false);
        }
      })();
    },
    [customerId, detail.data, editing, router],
  );

  return {
    offline,
    mode: editing ? 'edit' : 'create',
    initial: editing && detail.data !== undefined ? customerFormOf(detail.data) : editing ? null : emptyCustomerForm(),
    saving,
    submitError,
    onSave: save,
    onCancel: () => router.back(),
  };
}
