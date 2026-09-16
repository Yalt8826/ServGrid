/**
 * Data seam for the owner's O4b customers screens (T4.11, §O4b). The
 * same layering as `useOwnerJobs`: pure screens, this hook owns the
 * online reads and writes.
 *
 * - **list** — `GET /v1/customers` (the OWNER envelope: `companyId` is
 *   on it — the dispatcher's response schema omits the field entirely),
 *   plus `GET /v1/companies` for names and `GET /v1/jobs` for the open
 *   jobs / last job columns. The units column reads each site's stack
 *   (`GET /v1/customers/:id/stack`) eight at a time — the api's 300/min
 *   actor budget carries a 200-site page fine, and an honest `…` sits
 *   in the cell until its read lands.
 * - **detail** — `GET /v1/customers/:id` (stack rides along) and the
 *   site's history, the same two reads the dispatcher's detail makes.
 * - **the correction path** — `PATCH /v1/customers/:id/stack/:itemId`
 *   under `If-Match` and `DELETE …/stack/:itemId` (soft — it releases
 *   the serial). THE PAYLOADS CARRY NO `source_job_id`: that absence is
 *   the signal the change did not come from work done (§6.4). The
 *   completion remains the only door that stamps one.
 * - **create / edit** — `POST /v1/customers` and `PATCH /v1/customers/:id`
 *   through the OWNER schemas (no strip): the company field is a field
 *   he can write, `null` detaching the site.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';

import type {
  Company,
  Customer,
  CustomerDetail,
  CustomerRecord,
  CustomerStackItem,
  JobCardOwner,
  ProductRecord,
  TechnicianLoad,
} from '@servgrid/shared';
import { api } from '../../lib/api';
import { uuid } from '../../lib/uuid';
import { useIsOnline } from '../dispatcher/useDispatcherDashboard';
import { unitLabelOf } from '../dispatcher/dispatchForm';
import type { CustomerHistoryJob, CustomerStackUnit } from '../dispatcher/customer';
import { customerFormOf, customerPatchBody, emptyCustomerForm, type CustomerFormFields } from '../dispatcher/customerForm';
import type { CustomerFormCompanyDeps } from '../dispatcher/customer';
import { isOpenStatus, lastJobLabelOf, shortCustomerJobNumber, type OwnerCustomerRow } from './customersModel';
import { itemsOf } from '../../lib/listShape';

const PAGE_LIMIT = 200;
/** Concurrent stack reads for the units column — well inside the 300/min actor budget. */
const STACK_CONCURRENCY = 8;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface CustomerListEnvelope {
  items: CustomerRecord[];
  nextCursor: string | null;
}

interface JobListEnvelope {
  items: JobCardOwner[];
  nextCursor: string | null;
}

/** Bounded-concurrency pool — the units column's reads, eight at a time. */
async function poolStackCounts(ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor++]!;
      try {
        const stack = await fetchJson<CustomerStackItem[]>(`/v1/customers/${id}/stack`);
        counts.set(id, stack.length);
      } catch {
        // The cell keeps its honest `…` — a failed read is unknown, not zero.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(STACK_CONCURRENCY, ids.length) }, worker));
  return counts;
}

/**
 * The site's address as one line: both street lines, then the
 * area/city/pincode tail, skipping whatever is empty. The console shows
 * it in a single cell, so the parts are joined once — here — rather than
 * inside the column's render.
 */
export function fullAddressOf(c: Customer): string | null {
  const tail = [c.area, c.city, c.pincode].filter((p): p is string => p !== null && p !== '');
  const parts = [c.addressLine1, c.addressLine2, tail.join(' ')]
    .map((p) => (p === null ? '' : p.trim()))
    .filter((p) => p !== '');
  return parts.length === 0 ? null : parts.join(', ');
}

/** "12.971600, 77.594600" — six decimals is ~10cm, so it is worth reading aloud. */
export function locationOf(c: Customer): string | null {
  return c.latitude === null || c.longitude === null
    ? null
    : `${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)}`;
}

function listErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

/** /customers — the owner's table. */
export function useOwnerCustomers(query = ''): {
  offline: boolean;
  loading: boolean;
  error: string | null;
  rows: OwnerCustomerRow[];
  companyNames: Map<string, string>;
  reload(): void;
} {
  const offline = !useIsOnline();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // The search is the SERVER's (`?q=` over name and phone, §6.4), not a
  // filter over the page already fetched: the table caps at PAGE_LIMIT
  // rows, and a client-side filter would quietly search only those.
  const trimmed = query.trim();
  const search = trimmed === '' ? '' : `&q=${encodeURIComponent(trimmed)}`;
  const customers = useQuery({
    queryKey: ['owner', 'customers', tick, trimmed],
    queryFn: () => fetchJson<CustomerListEnvelope>(`/v1/customers?limit=${PAGE_LIMIT}${search}`),
  });
  const companies = useQuery({
    queryKey: ['owner', 'companies'],
    // `/v1/companies` answers a cursor envelope, not a bare array (the
    // same mismatch OW.1 fixed on the owner's other lists): read as an
    // array it threw inside the mapper and took the whole screen down.
    queryFn: async () => itemsOf(await fetchJson<{ items: Company[] } | Company[]>('/v1/companies')),
  });
  const jobs = useQuery({
    queryKey: ['owner', 'customer-jobs'],
    queryFn: () => fetchJson<JobListEnvelope>(`/v1/jobs?limit=${PAGE_LIMIT}`),
  });

  const items = customers.data?.items ?? [];
  const [stackCounts, setStackCounts] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (customers.data === undefined) return;
    let alive = true;
    void poolStackCounts(items.map((c) => c.id)).then((counts) => {
      if (alive) setStackCounts(counts);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers.data]);

  const rows: OwnerCustomerRow[] = useMemo(() => {
    const nameOf = new Map((companies.data ?? []).map((c) => [c.id, c.name] as const));
    const nowYear = new Date().getFullYear();
    const byCustomer = new Map<string, JobCardOwner[]>();
    for (const job of jobs.data?.items ?? []) {
      const bucket = byCustomer.get(job.customerId);
      if (bucket === undefined) byCustomer.set(job.customerId, [job]);
      else bucket.push(job);
    }
    return items.map((c) => {
      const siteJobs = byCustomer.get(c.id) ?? [];
      const open = siteJobs.filter((j) => isOpenStatus(j.status));
      // "last job": the newest by schedule with a date; a scheduled-less row still names its card.
      const withDate = siteJobs.filter((j) => j.scheduledFor !== null).sort((a, b) => (a.scheduledFor! < b.scheduledFor! ? 1 : -1));
      const last = withDate[0] ?? siteJobs[0] ?? null;
      return {
        id: c.id,
        name: c.name,
        area: c.area,
        address: fullAddressOf(c),
        location: locationOf(c),
        phone: c.phone,
        companyId: c.companyId,
        companyName: c.companyId === null ? null : (nameOf.get(c.companyId) ?? null),
        units: stackCounts.get(c.id) ?? null,
        openJobs: open.length,
        lastJob:
          last === null
            ? null
            : lastJobLabelOf(last.jobNumber, last.scheduledFor, nowYear),
      } satisfies OwnerCustomerRow;
    });
  }, [items, companies.data, jobs.data, stackCounts]);

  return {
    offline,
    loading: customers.isLoading,
    error: customers.isError ? listErrorMessage(customers.error, 'The customers could not be read. Try again.') : null,
    rows,
    companyNames: new Map((companies.data ?? []).map((c) => [c.id, c.name] as const)),
    reload,
  };
}

/** The labelled stack for the detail body. */
function useLabelledStack(detail: CustomerDetail | undefined): CustomerStackUnit[] | null {
  const products = useQuery({
    queryKey: ['owner', 'catalogue-products'],
    queryFn: () => fetchJson<ProductRecord[]>('/v1/products'),
  }).data;
  return useMemo(() => {
    if (detail === undefined) return null;
    const nameOf = new Map((products ?? []).map((p) => [p.id, p.name] as const));
    return detail.stack.map((item) => ({
      id: item.id,
      label: unitLabelOf({
        productName: item.productId === null ? null : (nameOf.get(item.productId) ?? null),
        freeTextName: item.freeTextName,
        serialNumber: item.serialNumber,
      }),
    }));
  }, [detail, products]);
}

/** The correction sheet's subject, resolved from the detail's stack. */
export interface StackEditing {
  id: string;
  label: string;
  serialNumber: string;
  quantity: number;
  warrantyExpiresOn: string | null;
  version: number;
}

/** The detail + correction path, for the side detail and the pushed screen. */
export function useOwnerCustomerDetail(customerId: string | null): {
  detail: CustomerDetail | null;
  loading: boolean;
  detailError: string | null;
  companyName: string | null;
  stack: CustomerStackUnit[] | null;
  history: CustomerHistoryJob[] | null;
  historyError: string | null;
  editing: StackEditing | null;
  savingStack: boolean;
  stackError: string | null;
  onEditStackItemOpen(unitId: string): void;
  onCloseSheet(): void;
  onSaveStackItem(itemId: string, version: number, patch: { serialNumber?: string; quantity?: number; warrantyExpiresOn?: string | null }): void;
  onRemoveStackItem(itemId: string): void;
  onCall(phone: string): void;
  onOpenJob(jobId: string): void;
  reload(): void;
} {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingStack, setSavingStack] = useState(false);
  const [stackError, setStackError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['owner', 'customer-detail', customerId, tick],
    queryFn: () => fetchJson<CustomerDetail>(`/v1/customers/${customerId ?? ''}`),
    enabled: customerId !== null,
  });
  const history = useQuery({
    queryKey: ['owner', 'customer-history', customerId],
    queryFn: () => fetchJson<JobListEnvelope>(`/v1/jobs?customerId=${customerId ?? ''}&limit=${PAGE_LIMIT}`),
    enabled: customerId !== null,
  });
  const roster = useQuery({
    queryKey: ['owner', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  });
  const stack = useLabelledStack(detail.data);

  const companyNameQuery = useQuery({
    queryKey: ['owner', 'company-name', detail.data?.companyId],
    // `/v1/companies` answers a cursor envelope, not a bare array (the
    // same mismatch OW.1 fixed on the owner's other lists): read as an
    // array it threw inside the mapper and took the whole screen down.
    queryFn: async () => itemsOf(await fetchJson<{ items: Company[] } | Company[]>('/v1/companies')),
    enabled: detail.data?.companyId != null,
  });

  const editing: StackEditing | null = useMemo(() => {
    if (editingId === null || detail.data === undefined) return null;
    const item = detail.data.stack.find((s) => s.id === editingId);
    if (item === undefined) return null;
    const label = stack?.find((s) => s.id === editingId)?.label ?? item.serialNumber;
    return {
      id: item.id,
      label,
      serialNumber: item.serialNumber,
      quantity: item.quantity,
      warrantyExpiresOn: item.warrantyExpiresOn,
      version: item.version,
    };
  }, [editingId, detail.data, stack]);

  const historyRows: CustomerHistoryJob[] | null = useMemo(() => {
    if (history.data === undefined) return null;
    const nameOf = new Map((roster.data ?? []).map((row) => [row.employeeId, row.technicianName] as const));
    return history.data.items.map((card) => ({
      id: card.id,
      jobNumber: shortCustomerJobNumber(card.jobNumber),
      title: card.title,
      status: card.status,
      scheduledFor: card.scheduledFor,
      technicianName: card.assignedTo === null ? null : (nameOf.get(card.assignedTo) ?? null),
    }));
  }, [history.data, roster.data]);

  const afterStackWrite = useCallback(() => {
    setSavingStack(false);
    setEditingId(null);
    reload();
  }, [reload]);

  const onSaveStackItem = useCallback(
    (itemId: string, version: number, patch: { serialNumber?: string; quantity?: number; warrantyExpiresOn?: string | null }): void => {
      if (customerId === null || Object.keys(patch).length === 0) {
        setEditingId(null);
        return;
      }
      setSavingStack(true);
      setStackError(null);
      void (async () => {
        try {
          const res = await api.request('PATCH', `/v1/customers/${customerId}/stack/${itemId}`, {
            body: patch,
            headers: { 'If-Match': String(version) },
            idempotencyKey: await uuid(),
          });
          if (!res.ok || res.data === null) {
            setSavingStack(false);
            setStackError(res.error?.message ?? 'The correction could not be saved. Try again.');
            return;
          }
          afterStackWrite();
        } catch (error) {
          setSavingStack(false);
          setStackError(error instanceof Error ? error.message : 'The correction could not be saved. Try again.');
        }
      })();
    },
    [customerId, afterStackWrite],
  );

  const onRemoveStackItem = useCallback(
    (itemId: string): void => {
      if (customerId === null) return;
      setSavingStack(true);
      setStackError(null);
      void (async () => {
        try {
          const res = await api.request('DELETE', `/v1/customers/${customerId}/stack/${itemId}`, {
            idempotencyKey: await uuid(),
          });
          if (!res.ok || res.data === null) {
            setSavingStack(false);
            setStackError(res.error?.message ?? 'The unit could not be removed. Try again.');
            return;
          }
          afterStackWrite();
        } catch (error) {
          setSavingStack(false);
          setStackError(error instanceof Error ? error.message : 'The unit could not be removed. Try again.');
        }
      })();
    },
    [customerId, afterStackWrite],
  );

  return {
    detail: detail.data ?? null,
    loading: detail.isLoading,
    detailError: detail.isError ? listErrorMessage(detail.error, 'The site could not be loaded. Try again.') : null,
    companyName:
      detail.data?.companyId != null
        ? (companyNameQuery.data?.find((c) => c.id === detail.data?.companyId)?.name ?? null)
        : null,
    stack,
    history: historyRows,
    historyError: history.isError ? listErrorMessage(history.error, 'The job history could not be loaded. Try again.') : null,
    editing,
    savingStack,
    stackError,
    onEditStackItemOpen: setEditingId,
    onCloseSheet: () => setEditingId(null),
    onSaveStackItem,
    onRemoveStackItem,
    onCall: (phone) => {
      void Linking.openURL(`tel:${phone}`);
    },
    onOpenJob: (jobId) => router.push(`/jobs/${jobId}`),
    reload,
  };
}

/** /customers/new and /customers/[id]/edit — the owner's form save. The
 * body carries `companyId` (the owner schema keeps it; the dispatcher's
 * strip does not apply) and the same shared form renders the field. */
export function useOwnerCustomerForm(customerId?: string): {
  offline: boolean;
  mode: 'create' | 'edit';
  initial: CustomerFormFields | null;
  saving: boolean;
  submitError: string | null;
  company: CustomerFormCompanyDeps;
  onSave(fields: CustomerFormFields): void;
  onCancel(): void;
} {
  const router = useRouter();
  const offline = !useIsOnline();
  const editing = customerId !== undefined;

  const detail = useQuery({
    queryKey: ['owner', 'customer-detail-edit', customerId],
    queryFn: () => fetchJson<CustomerDetail>(`/v1/customers/${customerId ?? ''}`),
    enabled: editing,
  });
  const companies = useQuery({
    queryKey: ['owner', 'companies'],
    // `/v1/companies` answers a cursor envelope, not a bare array (the
    // same mismatch OW.1 fixed on the owner's other lists): read as an
    // array it threw inside the mapper and took the whole screen down.
    queryFn: async () => itemsOf(await fetchJson<{ items: Company[] } | Company[]>('/v1/companies')),
  });

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  useEffect(() => {
    if (detail.data !== undefined && selectedCompanyId === null && detail.data.companyId !== null) {
      setSelectedCompanyId(detail.data.companyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onSave = useCallback(
    (fields: CustomerFormFields): void => {
      setSaving(true);
      setSubmitError(null);
      void (async () => {
        try {
          if (!editing) {
            const created = await api.request<{ id: string }>('POST', '/v1/customers', {
              body: { ...fields, companyId: selectedCompanyId },
              idempotencyKey: await uuid(),
            });
            if (!created.ok || created.data === null) {
              setSubmitError(created.error?.message ?? 'The customer could not be saved. Try again.');
              return;
            }
            router.replace(`/customers/${created.data.id}`);
            return;
          }
          const current = detail.data;
          if (current === undefined) {
            setSubmitError('The site has not finished loading. Try again.');
            return;
          }
          const changed = customerPatchBody(customerFormOf(current), fields);
          const companyChanged = selectedCompanyId !== current.companyId;
          if (changed === null && !companyChanged) {
            setSubmitError('Nothing to change.');
            return;
          }
          const body = { ...(changed ?? {}), ...(companyChanged ? { companyId: selectedCompanyId } : {}) };
          const patched = await api.request('PATCH', `/v1/customers/${customerId}`, {
            body,
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
    [customerId, detail.data, editing, router, selectedCompanyId],
  );

  return {
    offline,
    mode: editing ? 'edit' : 'create',
    initial:
      editing && detail.data !== undefined
        ? customerFormOf(detail.data)
        : editing
          ? null
          : emptyCustomerForm(),
    saving,
    submitError,
    company: {
      companies: (companies.data ?? []).map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
      selectedCompanyId,
      onSelectCompany: setSelectedCompanyId,
      disabled: saving,
    },
    onSave: onSave,
    onCancel: () => router.back(),
  };
}
