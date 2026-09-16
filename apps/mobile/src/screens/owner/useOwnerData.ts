/**
 * Data seam for the owner's screens (T4.12, §O5–§O9). The screens are
 * pure UI over injected data; this module is the hook layer the routes
 * mount — the rep's `useRepData` precedent, unscoped (the owner's cells
 * are `all`; the server scopes, the client never does).
 *
 * Reads go through the online API. The owner is online-only: no mirror,
 * no outbox, no offline gate on these submits. Writes (void, reassign,
 * create, deactivate, catalogue deactivation) run directly with an
 * idempotency key per intent, the rep's rule.
 *
 * The contracts surface (§O6) is shared now — its hooks live in
 * `src/screens/contracts/useContracts.ts` (T2B.4), serving the owner and
 * the dispatcher from the same seam.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  Company,
  CompanyBalance,
  CompanyLedger,
  EmployeeAdmin,
  EmployeeDetail,
  PaymentRecord,
  ProductRecord,
  SaleRecord,
  ServiceRecord,
  TrackingHealth,
} from '@servgrid/shared';
import { api } from '../../lib/api';
import { itemsOf } from '../../lib/listShape';
import { uuid } from '../../lib/uuid';
import { sumMoney } from '../rep/money';
import type { BlockingRow, EmployeeListRow, OwnerCompanyRow, OwnerPaymentRow, OwnerSaleRow, SecondOwner } from './model';

// ── api helpers (the rep seam's rules) ─────────────────────────────────────

/** GET that throws with the server's message — screens render it verbatim. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'The request could not be completed.');
  return res.data;
}

/** POST/PATCH that throws with the server's message; one key per intent. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  opts?: { idempotencyKey?: string },
): Promise<T> {
  const res = await api.request<T>(method, path, { body, headers, idempotencyKey: opts?.idempotencyKey });
  if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'The request could not be completed.');
  return res.data;
}

interface ListEnvelope<T> {
  items: T[];
}

/**
 * A list read that accepts BOTH shapes the API answers with (OW.1,
 * 2026-09-16). `/v1/companies` and `/v1/contracts` return an envelope
 * `{ items, nextCursor }`; `/v1/employees`, `/v1/products` and
 * `/v1/services` return a bare array. Both are live contracts — the
 * dispatch form has always read the catalogue as arrays — and a reader
 * that knows only one of them is the bug: `envelope.items` came back
 * undefined and the `.map` below threw, which is why the owner's
 * Companies, Employees, Products and Services screens all showed an
 * error instead of their rows.
 */
async function listOf<T>(path: string): Promise<T[]> {
  return itemsOf(await apiGet<ListEnvelope<T> | T[]>(path));
}

/** The error a refused write leaves on the sheet, verbatim. */
function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message !== '' ? e.message : fallback;
}

// ── shared name resolution ─────────────────────────────────────────────────

interface NameSource {
  companies: Map<string, string>;
  employees: Map<string, string>;
}

async function loadNames(): Promise<NameSource> {
  const [companiesR, employeesR] = await Promise.allSettled([
    listOf<Company>('/v1/companies'),
    listOf<EmployeeAdmin>('/v1/employees'),
  ]);
  return {
    companies:
      companiesR.status === 'fulfilled' ? new Map(companiesR.value.map((c) => [c.id, c.name])) : new Map(),
    employees:
      employeesR.status === 'fulfilled' ? new Map(employeesR.value.map((e) => [e.id, e.fullName])) : new Map(),
  };
}

// ── O5 sales ───────────────────────────────────────────────────────────────

export interface OwnerSalesData {
  rows: OwnerSaleRow[];
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useOwnerSales(): OwnerSalesData {
  const [rows, setRows] = useState<OwnerSaleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [salesR, namesR] = await Promise.allSettled([listOf<SaleRecord>('/v1/sales'), loadNames()]);
      if (!alive) return;
      const sales = salesR.status === 'fulfilled' ? salesR.value : [];
      const names = namesR.status === 'fulfilled' ? namesR.value : { companies: new Map(), employees: new Map() };
      setRows(
        sales.map((s) => ({
          id: s.id,
          saleNumber: s.saleNumber,
          companyId: s.companyId,
          companyName: names.companies.get(s.companyId) ?? s.companyId,
          repName: names.employees.get(s.salesRepId) ?? null,
          saleDate: s.saleDate,
          total: s.total,
          status: s.status,
        })),
      );
      setError(
        salesR.status === 'rejected'
          ? salesR.reason instanceof Error
            ? salesR.reason.message
            : 'The sales could not be loaded.'
          : null,
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, error, loading, reload };
}

/** The void write — one key per open sheet intent. */
export function useVoidSale(onDone: () => void): {
  voidBusy: boolean;
  voidError: string | null;
  voidSale: (saleId: string, reason: string) => Promise<void>;
} {
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const voidSale = useCallback(
    async (saleId: string, reason: string) => {
      if (keyRef.current === null) keyRef.current = await uuid();
      setVoidBusy(true);
      setVoidError(null);
      try {
        await apiSend('POST', `/v1/sales/${saleId}/void`, { reason }, undefined, { idempotencyKey: keyRef.current });
        keyRef.current = null;
        setVoidBusy(false);
        onDone();
      } catch (e) {
        setVoidBusy(false);
        setVoidError(messageOf(e, 'The sale could not be voided. Try again.'));
        throw e;
      }
    },
    [onDone],
  );
  return { voidBusy, voidError, voidSale };
}

// ── O5 payments ────────────────────────────────────────────────────────────

export interface OwnerPaymentsData {
  rows: OwnerPaymentRow[];
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useOwnerPayments(): OwnerPaymentsData {
  const [rows, setRows] = useState<OwnerPaymentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [paymentsR, namesR] = await Promise.allSettled([listOf<PaymentRecord>('/v1/payments'), loadNames()]);
      if (!alive) return;
      const payments = paymentsR.status === 'fulfilled' ? paymentsR.value : [];
      const names = namesR.status === 'fulfilled' ? namesR.value : { companies: new Map(), employees: new Map() };
      setRows(
        payments.map((p) => ({
          id: p.id,
          paymentNumber: p.paymentNumber,
          companyId: p.companyId,
          companyName: names.companies.get(p.companyId) ?? p.companyId,
          repName: names.employees.get(p.receivedBy) ?? null,
          businessDate: p.businessDate,
          amount: p.amount,
          mode: p.mode,
          status: p.status === 'void' ? 'void' : 'confirmed',
        })),
      );
      setError(
        paymentsR.status === 'rejected'
          ? paymentsR.reason instanceof Error
            ? paymentsR.reason.message
            : 'The payments could not be loaded.'
          : null,
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, error, loading, reload };
}

export function useVoidPayment(onDone: () => void): {
  voidBusy: boolean;
  voidError: string | null;
  voidPayment: (paymentId: string, reason: string) => Promise<void>;
} {
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const voidPayment = useCallback(
    async (paymentId: string, reason: string) => {
      if (keyRef.current === null) keyRef.current = await uuid();
      setVoidBusy(true);
      setVoidError(null);
      try {
        await apiSend('POST', `/v1/payments/${paymentId}/void`, { reason }, undefined, { idempotencyKey: keyRef.current });
        keyRef.current = null;
        setVoidBusy(false);
        onDone();
      } catch (e) {
        setVoidBusy(false);
        setVoidError(messageOf(e, 'The payment could not be voided. Try again.'));
        throw e;
      }
    },
    [onDone],
  );
  return { voidBusy, voidError, voidPayment };
}

// ── O5 companies ───────────────────────────────────────────────────────────

export interface OwnerReps {
  reps: { id: string; name: string; username: string }[];
  error: string | null;
}

/** The sales reps — the reassignment options (§O5). */
export function useOwnerReps(): OwnerReps {
  const [reps, setReps] = useState<{ id: string; name: string; username: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void listOf<EmployeeAdmin>('/v1/employees?role=sales_rep')
      .then((rows) => {
        if (alive) setReps(rows.map((r) => ({ id: r.id, name: r.fullName, username: r.username })));
      })
      .catch((e) => {
        if (alive) setError(messageOf(e, 'The reps could not be loaded.'));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { reps, error };
}

export interface OwnerCompaniesData {
  rows: OwnerCompanyRow[];
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Every account, both reps', plus the house accounts, balance
 * descending; a balances failure degrades the column, not the screen. */
export function useOwnerCompanies(): OwnerCompaniesData {
  const [rows, setRows] = useState<OwnerCompanyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [companiesR, balancesR, employeesR] = await Promise.allSettled([
        listOf<Company>('/v1/companies'),
        listOf<CompanyBalance>('/v1/companies/balances'),
        listOf<EmployeeAdmin>('/v1/employees'),
      ]);
      if (!alive) return;
      const companies = companiesR.status === 'fulfilled' ? companiesR.value : [];
      const balances = balancesR.status === 'fulfilled' ? balancesR.value : null;
      const byId = new Map(balances?.map((b) => [b.companyId, b]));
      const empNames = new Map(
        employeesR.status === 'fulfilled' ? employeesR.value.map((e) => [e.id, e.fullName] as const) : [],
      );
      setRows(
        companies.map((c) => ({
          companyId: c.id,
          name: c.name,
          balance: byId.get(c.id)?.balance ?? null,
          ownerRepId: c.ownerRepId,
          ownerRepName: c.ownerRepId === null ? null : (empNames.get(c.ownerRepId) ?? null),
          shared: c.ownerRepId === null,
        })),
      );
      setError(
        companiesR.status === 'rejected'
          ? companiesR.reason instanceof Error
            ? companiesR.reason.message
            : 'The accounts could not be loaded.'
          : null,
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, error, loading, reload };
}

export function useReassignCompany(onDone: () => void): {
  reassignBusy: boolean;
  reassignError: string | null;
  reassign: (companyId: string, ownerRepId: string | null) => Promise<void>;
} {
  const [reassignBusy, setReassignBusy] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const reassign = useCallback(
    async (companyId: string, ownerRepId: string | null) => {
      setReassignBusy(true);
      setReassignError(null);
      try {
        await apiSend('PATCH', `/v1/companies/${companyId}/owner`, { ownerRepId });
        setReassignBusy(false);
        onDone();
      } catch (e) {
        setReassignBusy(false);
        setReassignError(messageOf(e, 'The account could not be reassigned. Try again.'));
        throw e;
      }
    },
    [onDone],
  );
  return { reassignBusy, reassignError, reassign };
}

/** The owner's copy of the §S4 ledger — identical, unscoped. The owner
 * rep's NAME resolves here (the Company wire carries only his id), so
 * the detail's header and its reassignment sheet render people. */
export function useOwnerCompanyLedger(companyId: string): {
  company: Company | null;
  ownerRepName: string | null;
  shared: boolean;
  ledger: CompanyLedger | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [company, setCompany] = useState<Company | null>(null);
  const [ownerRepName, setOwnerRepName] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [ledger, setLedger] = useState<CompanyLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [companyR, ledgerR, employeesR] = await Promise.allSettled([
        apiGet<Company>(`/v1/companies/${companyId}`),
        apiGet<CompanyLedger>(`/v1/companies/${companyId}/ledger`),
        listOf<EmployeeAdmin>('/v1/employees'),
      ]);
      if (!alive) return;
      const companyRow = companyR.status === 'fulfilled' ? companyR.value : null;
      setCompany(companyRow);
      setLedger(ledgerR.status === 'fulfilled' ? ledgerR.value : null);
      const empNames =
        employeesR.status === 'fulfilled' ? new Map(employeesR.value.map((e) => [e.id, e.fullName] as const)) : new Map();
      setShared(companyRow === null ? false : companyRow.ownerRepId === null);
      setOwnerRepName(
        companyRow === null || companyRow.ownerRepId === null ? null : (empNames.get(companyRow.ownerRepId) ?? null),
      );
      setError(
        companyR.status === 'rejected'
          ? companyR.reason instanceof Error
            ? companyR.reason.message
            : 'The account could not be loaded.'
          : ledgerR.status === 'rejected'
            ? ledgerR.reason instanceof Error
              ? ledgerR.reason.message
              : 'The ledger could not be loaded.'
            : null,
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [companyId, tick]);

  return { company, ownerRepName, shared, ledger, error, loading, reload };
}

// ── O6 contracts ───────────────────────────────────────────────────────────
// The old O6 hooks (the contract list and detail reads) are gone: the AMC
// surface is shared — `src/screens/contracts/useContracts.ts` (T2B.4)
// serves the owner and the dispatcher from one seam.

// ── O7 employees ───────────────────────────────────────────────────────────

export function useOwnerEmployees(): {
  rows: EmployeeListRow[];
  /** The roster read's full rows — the detail's health chip renders the
   * real view data, not the list's word. */
  healthRows: TrackingHealth[];
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [rows, setRows] = useState<EmployeeListRow[]>([]);
  const [healthRows, setHealthRows] = useState<TrackingHealth[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [employeesR, healthR] = await Promise.allSettled([
        listOf<EmployeeAdmin>('/v1/employees'),
        listOf<TrackingHealth>('/v1/location/health'),
      ]);
      if (!alive) return;
      const employees = employeesR.status === 'fulfilled' ? employeesR.value : [];
      const healthRowsOut = healthR.status === 'fulfilled' ? healthR.value : [];
      const health = new Map(healthRowsOut.map((h) => [h.employeeId, h.health] as const));
      setRows(
        employees.map((e) => ({
          id: e.id,
          username: e.username,
          fullName: e.fullName,
          role: e.role,
          isActive: e.isActive,
          lastLoginAt: e.lastLoginAt,
          health: health.get(e.id) ?? 'untracked_role',
        })),
      );
      setError(
        employeesR.status === 'rejected'
          ? employeesR.reason instanceof Error
            ? employeesR.reason.message
            : 'The employees could not be loaded.'
          : null,
      );
      setHealthRows(healthRowsOut);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, healthRows, error, loading, reload };
}

export function useOwnerEmployeeDetail(employeeId: string): {
  detail: EmployeeDetail | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [detail, setDetail] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void apiGet<EmployeeDetail>(`/v1/employees/${employeeId}`)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setDetail(null);
        setError(messageOf(e, 'The employee could not be loaded.'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [employeeId, tick]);

  return { detail, error, loading, reload };
}

export function useCreateEmployee(): {
  busy: boolean;
  error: string | null;
  create: (input: { username: string; fullName: string; phone: string | null; role: string; tempPassword: string }) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useCallback(
    async (input: { username: string; fullName: string; phone: string | null; role: string; tempPassword: string }) => {
      setBusy(true);
      setError(null);
      try {
        await apiSend('POST', '/v1/employees', input);
        setBusy(false);
      } catch (e) {
        setBusy(false);
        setError(messageOf(e, 'The account could not be created. Try again.'));
        throw e;
      }
    },
    [],
  );
  return { busy, error, create };
}

/**
 * Deactivation under `If-Match`. A refusal (409 EMPLOYEE_HAS_OPEN_WORK)
 * carries the blocking rows in the error envelope's details — read off
 * the RAW response here, because the throw-on-error helper keeps only
 * the message and the 409's body IS the work list.
 */
export function useDeactivateEmployee(): {
  busy: boolean;
  blocking: BlockingRow[] | null;
  deactivate: (employeeId: string, version: number) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [blocking, setBlocking] = useState<BlockingRow[] | null>(null);
  const deactivate = useCallback(async (employeeId: string, version: number): Promise<boolean> => {
    setBusy(true);
    setBlocking(null);
    try {
      const res = await api.request<{ id: string }>('PATCH', `/v1/employees/${employeeId}`, {
        body: { isActive: false },
        headers: { 'If-Match': String(version) },
      });
      if (res.ok) {
        setBusy(false);
        return true;
      }
      const details = (res.error as unknown as { details?: unknown } | null)?.details;
      setBlocking(Array.isArray(details) ? (details as BlockingRow[]) : []);
      setBusy(false);
      return false;
    } catch {
      // A transport failure is not a refusal: no blocking rows to show.
      setBlocking([]);
      setBusy(false);
      return false;
    }
  }, []);
  return { busy, blocking, deactivate };
}

// ── O8 catalogue ───────────────────────────────────────────────────────────

export function useOwnerProducts(): {
  rows: (ProductRecord & { isActive: boolean })[];
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [rows, setRows] = useState<(ProductRecord & { isActive: boolean })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listOf<ProductRecord>('/v1/products')
      .then((wire) => {
        if (!alive) return;
        setRows(wire.map((p) => ({ ...p, isActive: true })));
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(messageOf(e, 'The catalogue could not be loaded.'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, error, loading, reload };
}

export function useOwnerServices(): {
  rows: (ServiceRecord & { isActive: boolean })[];
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [rows, setRows] = useState<(ServiceRecord & { isActive: boolean })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listOf<ServiceRecord>('/v1/services')
      .then((wire) => {
        if (!alive) return;
        setRows(wire.map((s) => ({ ...s, isActive: true })));
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(messageOf(e, 'The catalogue could not be loaded.'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  return { rows, error, loading, reload };
}

/** The catalogue deactivation — PATCH `isActive: false` under `If-Match`. */
export function useDeactivateCatalogItem(kind: 'products' | 'services', onDone: () => void): {
  busyId: string | null;
  deactivate: (id: string, version: number) => Promise<void>;
} {
  const [busyId, setBusyId] = useState<string | null>(null);
  const deactivate = useCallback(
    async (id: string, version: number) => {
      setBusyId(id);
      try {
        await apiSend('PATCH', `/v1/${kind}/${id}`, { isActive: false }, { 'If-Match': String(version) });
        setBusyId(null);
        onDone();
      } catch (e) {
        setBusyId(null);
        throw e;
      }
    },
    [kind, onDone],
  );
  return { busyId, deactivate };
}

// ── O9 profile ─────────────────────────────────────────────────────────────

/** Every OTHER owner — the second-owner reminder's content (§O9). */
export function useOtherOwners(): {
  others: SecondOwner[];
  error: string | null;
} {
  const [others, setOthers] = useState<SecondOwner[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void listOf<EmployeeAdmin>('/v1/employees?role=owner')
      .then((rows) => {
        if (!alive) return;
        // "Who ELSE holds owner access" — the caller knows his own line.
        setOthers(rows.filter((e) => e.isActive).map((e) => ({ id: e.id, fullName: e.fullName, username: e.username })));
      })
      .catch(() => {
        if (alive) setError('The owners could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, []);
  return { others, error };
}

/** Re-exported for the routes' running-total footers, if they need it. */
export { sumMoney };
