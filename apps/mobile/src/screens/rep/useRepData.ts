/**
 * Data seam for the rep's screens (T3.7). The screens are pure UI over
 * injected data (the handover/profile precedent); this module is the hook
 * layer the routes mount. The pure model lives beside it in
 * `./model.ts`, so the screens' tests never drag the API client into
 * their import graph.
 *
 * Reads go through the online API — the sales/payments/companies surface
 * (T3.2–T3.5) has no sync working set; the mirror stays the outbox's home
 * (PLAN-FRONTEND.md §4), and its pending count is what marks the
 * dashboard's figures stale. Writes run directly today exactly like the
 * cash-handover route's: the screens' `record`/`create` seams make
 * rewiring to enqueue a route-file change only.
 */
import { useCallback, useEffect, useState } from 'react';

import type {
  AuthMeResponse,
  Company,
  CompanyBalance,
  CompanyLedger,
  FeatureFlagState,
  PaymentRecord,
  SaleRecord,
} from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import type { RecordPaymentInput } from './PaymentsScreen';
import {
  companiesRowsOf,
  istMonthOf,
  istToday,
  outstandingOf,
  owesTheMostOf,
  renewalRowOf,
  sortSalesRows,
  soldThisMonthOf,
  type CompanyRow,
  type OwedRow,
  type PaymentRow,
  type RenewalRow,
  type RenewingContract,
  type SaleRow,
} from './model';
import { sumMoney } from './money';

// ── api helpers ────────────────────────────────────────────────────────────

/** GET that throws with the server's message — screens render it verbatim. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'The request could not be completed.');
  return res.data;
}

/** POST/PATCH that throws with the server's message. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await api.request<T>(method, path, { body, headers });
  if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'The request could not be completed.');
  return res.data;
}

interface ListEnvelope<T> {
  items: T[];
}

async function listOf<T>(path: string): Promise<T[]> {
  const envelope = await apiGet<ListEnvelope<T>>(path);
  return envelope.items;
}

// ── flags ──────────────────────────────────────────────────────────────────

export interface RepFlags {
  ready: boolean;
  cards: boolean;
  payments: boolean;
  cash: boolean;
}

/**
 * `sales.cards` / `sales.payments` / `sales.cash`, read process-wide. The
 * answer rides `GET /v1/auth/me` and is published to the feature-flag
 * store (the technician hook's rule): until an answer exists every flag
 * reads off — a screen is dark, never wrong — and a failed fetch keeps
 * the last known answer.
 */
export function useRepFlags(): RepFlags {
  const [flags, setFlagsState] = useState<FeatureFlagState | null>(cachedFeatureFlags());
  useEffect(() => {
    if (flags !== null) return;
    let alive = true;
    void (async () => {
      const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
      const next: FeatureFlagState = {
        ...defaultFeatureFlags(),
        ...(res.ok && res.data !== null ? res.data.featureFlags : {}),
      };
      setFeatureFlags(next);
      if (alive) setFlagsState(next);
    })();
    return () => {
      alive = false;
    };
  }, [flags]);
  return {
    ready: flags !== null,
    cards: flags?.['sales.cards'] ?? false,
    payments: flags?.['sales.payments'] ?? false,
    cash: flags?.['sales.cash'] ?? false,
  };
}

// ── S1 dashboard ───────────────────────────────────────────────────────────

export interface RepDashboardData {
  soldThisMonth: string;
  outstanding: string;
  owesTheMost: OwedRow[];
  renewingSoon: RenewalRow[];
  recentPayments: PaymentRow[];
}

export interface RepDashboardErrors {
  figures: string | null;
  payments: string | null;
  renewals: string | null;
}

export interface RepDashboard {
  data: RepDashboardData | null;
  errors: RepDashboardErrors;
  loading: boolean;
  reload: () => void;
  /** `sales.cards` off — sold this month has no source, honestly. */
  salesOff: boolean;
  /** `sales.payments` off — dues and collections have no source. */
  paymentsOff: boolean;
}

/**
 * S1's data. Reads skip when their flag is off (`sales.cards`,
 * `sales.payments`): the section renders "turned off", and no doomed
 * request fires. Failed reads stay honest: figures fail together (they
 * are the money), renewals and recent payments fail alone. `sold this
 * month` needs today's IST month — computed here, not the screen's.
 */
export function useRepDashboard(
  loadRenewals: () => Promise<RenewingContract[]> = async () => [],
): RepDashboard {
  const flags = useRepFlags();
  const [data, setData] = useState<RepDashboardData | null>(null);
  const [errors, setErrors] = useState<RepDashboardErrors>({ figures: null, payments: null, renewals: null });
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!flags.ready) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      const month = istMonthOf(istToday());
      const paymentsOn = flags.payments;
      const cardsOn = flags.cards;
      const nextErrors: RepDashboardErrors = { figures: null, payments: null, renewals: null };
      const [balancesR, salesR, paymentsR, companiesR, renewalsR] = await Promise.allSettled([
        paymentsOn ? listOf<CompanyBalance>('/v1/companies/balances') : Promise.resolve(null),
        cardsOn ? listOf<SaleRecord>('/v1/sales') : Promise.resolve(null),
        paymentsOn ? listOf<PaymentRecord>('/v1/payments') : Promise.resolve(null),
        listOf<Company>('/v1/companies'),
        loadRenewals(),
      ]);
      const balances = balancesR.status === 'fulfilled' ? balancesR.value : null;
      const sales = salesR.status === 'fulfilled' ? salesR.value : null;
      const payments = paymentsR.status === 'fulfilled' ? paymentsR.value : null;
      const companyRows = companiesR.status === 'fulfilled' ? companiesR.value : [];
      const names = new Map(companyRows.map((c) => [c.id, c.name]));
      if ((paymentsOn && balances === null) || (cardsOn && sales === null)) {
        nextErrors.figures =
          balancesR.status === 'rejected'
            ? balancesR.reason instanceof Error
              ? balancesR.reason.message
              : 'The figures could not be loaded.'
            : salesR.status === 'rejected' && salesR.reason instanceof Error
              ? salesR.reason.message
              : 'The figures could not be loaded.';
      }
      if (paymentsOn && payments === null) {
        nextErrors.payments =
          paymentsR.status === 'rejected' && paymentsR.reason instanceof Error
            ? paymentsR.reason.message
            : 'Recent payments could not be loaded.';
      }
      if (renewalsR.status === 'rejected') {
        nextErrors.renewals =
          renewalsR.reason instanceof Error ? renewalsR.reason.message : 'Renewals could not be loaded.';
      }
      if (!alive) return;
      setData({
        soldThisMonth: sales === null ? '0' : soldThisMonthOf(sales, month),
        outstanding: balances === null ? '0' : outstandingOf(balances),
        owesTheMost: balances === null ? [] : owesTheMostOf(balances),
        renewingSoon:
          renewalsR.status === 'fulfilled'
            ? renewalsR.value.map((c) => renewalRowOf(c, istToday()))
            : [],
        recentPayments:
          payments === null
            ? []
            : payments.slice(0, 5).map((p) => ({
                id: p.id,
                paymentNumber: p.paymentNumber,
                companyId: p.companyId,
                companyName: names.get(p.companyId) ?? p.companyId,
                amount: p.amount,
                mode: p.mode,
                businessDate: p.businessDate,
              })),
      });
      setErrors(nextErrors);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick, loadRenewals, flags.ready, flags.cards, flags.payments]);

  return {
    data,
    errors,
    loading,
    reload,
    salesOff: flags.ready && !flags.cards,
    paymentsOff: flags.ready && !flags.payments,
  };
}

// ── S4 companies ───────────────────────────────────────────────────────────

export interface RepCompanies {
  rows: CompanyRow[];
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** S4's list: companies joined with balances, balance descending. A
 * balances failure degrades the column, not the screen — the account
 * list itself is not flag-gated. */
export function useRepCompanies(): RepCompanies {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [companiesR, balancesR] = await Promise.allSettled([
        listOf<Company>('/v1/companies'),
        listOf<CompanyBalance>('/v1/companies/balances'),
      ]);
      if (!alive) return;
      const companies = companiesR.status === 'fulfilled' ? companiesR.value : [];
      const balances = balancesR.status === 'fulfilled' ? balancesR.value : null;
      setRows(companiesRowsOf(companies, balances));
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

// ── S2 sales ───────────────────────────────────────────────────────────────

export interface RepSales {
  rows: SaleRow[];
  companies: Company[];
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** S2's list: his cards with company names, drafts first. */
export function useRepSales(): RepSales {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [salesR, companiesR] = await Promise.allSettled([
        listOf<SaleRecord>('/v1/sales'),
        listOf<Company>('/v1/companies'),
      ]);
      if (!alive) return;
      const sales = salesR.status === 'fulfilled' ? salesR.value : [];
      const companyRows = companiesR.status === 'fulfilled' ? companiesR.value : [];
      const names = new Map(companyRows.map((c) => [c.id, c.name]));
      setCompanies(companyRows);
      setRows(
        sortSalesRows(
          sales.map((s) => ({
            id: s.id,
            saleNumber: s.saleNumber,
            companyId: s.companyId,
            companyName: names.get(s.companyId) ?? s.companyId,
            saleDate: s.saleDate,
            total: s.total,
            status: s.status,
          })),
        ),
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

  return { rows, companies, error, loading, reload };
}

// ── S3 payments ────────────────────────────────────────────────────────────

export interface RepPayments {
  owed: OwedRow[];
  collected: PaymentRow[];
  companies: Company[];
  /** Confirmed sales — the *Against* select's specific-sale options. */
  openSales: SaleRow[];
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** The optimistic half (§S3 motion): a recorded payment moves the
   * company's row on the previous screen BEFORE the sheet closes. */
  applyOptimisticPayment: (companyId: string, amount: string) => void;
}

/** S3's data: the Owed tab (a view of dues) and the Collected tab. */
export function useRepPayments(): RepPayments {
  const [owed, setOwed] = useState<OwedRow[]>([]);
  const [collected, setCollected] = useState<PaymentRow[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [openSales, setOpenSales] = useState<SaleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [balancesR, paymentsR, companiesR, salesR] = await Promise.allSettled([
        listOf<CompanyBalance>('/v1/companies/balances'),
        listOf<PaymentRecord>('/v1/payments'),
        listOf<Company>('/v1/companies'),
        listOf<SaleRecord>('/v1/sales'),
      ]);
      if (!alive) return;
      const balances = balancesR.status === 'fulfilled' ? balancesR.value : null;
      const payments = paymentsR.status === 'fulfilled' ? paymentsR.value : [];
      const companyRows = companiesR.status === 'fulfilled' ? companiesR.value : [];
      const sales = salesR.status === 'fulfilled' ? salesR.value : [];
      const names = new Map(companyRows.map((c) => [c.id, c.name]));
      setOwed(
        (balances ?? [])
          .filter((b) => Number(b.balance) > 0)
          .sort((a, b) => Number(b.balance) - Number(a.balance))
          .map((b) => ({ companyId: b.companyId, name: b.name, balance: b.balance })),
      );
      setCollected(
        payments.map((p) => ({
          id: p.id,
          paymentNumber: p.paymentNumber,
          companyId: p.companyId,
          companyName: names.get(p.companyId) ?? p.companyId,
          amount: p.amount,
          mode: p.mode,
          businessDate: p.businessDate,
        })),
      );
      setCompanies(companyRows);
      setOpenSales(
        sortSalesRows(
          sales
            .filter((s) => s.status === 'confirmed')
            .map((s) => ({
              id: s.id,
              saleNumber: s.saleNumber,
              companyId: s.companyId,
              companyName: names.get(s.companyId) ?? s.companyId,
              saleDate: s.saleDate,
              total: s.total,
              status: s.status,
            })),
        ),
      );
      setError(
        balancesR.status === 'rejected'
          ? balancesR.reason instanceof Error
            ? balancesR.reason.message
            : 'The dues could not be loaded.'
          : null,
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  const applyOptimisticPayment = useCallback((companyId: string, amount: string) => {
    setOwed((rows) =>
      rows
        .map((row) =>
          row.companyId === companyId
            ? { ...row, balance: sumMoney([row.balance, `-${amount}`]) }
            : row,
        )
        .filter((row) => Number(row.balance) > 0),
    );
  }, []);

  return { owed, collected, companies, openSales, error, loading, reload, applyOptimisticPayment };
}

// ── S4 ledger detail ───────────────────────────────────────────────────────

export interface RepCompanyLedger {
  company: Company | null;
  ledger: CompanyLedger | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** S4's detail: the account and its interleaved ledger with the
 * server-computed running balance. */
export function useRepCompanyLedger(companyId: string): RepCompanyLedger {
  const [company, setCompany] = useState<Company | null>(null);
  const [ledger, setLedger] = useState<CompanyLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const [companyR, ledgerR] = await Promise.allSettled([
        apiGet<Company>(`/v1/companies/${companyId}`),
        apiGet<CompanyLedger>(`/v1/companies/${companyId}/ledger`),
      ]);
      if (!alive) return;
      setCompany(companyR.status === 'fulfilled' ? companyR.value : null);
      setLedger(ledgerR.status === 'fulfilled' ? ledgerR.value : null);
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

  return { company, ledger, error, loading, reload };
}

// ── the record-payment write seam ──────────────────────────────────────────

export interface PendingRecord {
  busy: boolean;
  error: string | null;
}

/**
 * The route-owned POST /v1/payments (T3.4's surface, `sales.payments`).
 * Runs directly today, exactly like the cash-handover route's calls; the
 * sheet's `record` seam makes rewiring to enqueue an outbox row a
 * route-file change only. The proof photo (a local URI) would travel as
 * an attachment row after its parent — the capture seam is not wired in
 * this build, so no URI ever arrives here yet.
 */
export function useRecordPayment(): { pendingRecord: PendingRecord; record: (input: RecordPaymentInput) => Promise<void> } {
  const [pendingRecord, setPendingRecord] = useState<PendingRecord>({ busy: false, error: null });

  const record = useCallback(async (input: RecordPaymentInput) => {
    setPendingRecord({ busy: true, error: null });
    try {
      await apiSend<PaymentRecord>('POST', '/v1/payments', {
        companyId: input.companyId,
        ...(input.salesCardId !== null ? { salesCardId: input.salesCardId } : {}),
        amount: input.amount,
        mode: input.mode,
        ...(input.referenceNo !== null ? { referenceNo: input.referenceNo } : {}),
        receivedAt: new Date().toISOString(),
      });
      setPendingRecord({ busy: false, error: null });
    } catch (e) {
      const message = e instanceof Error && e.message !== '' ? e.message : 'The payment could not be recorded. Try again.';
      setPendingRecord({ busy: false, error: message });
      throw e;
    }
  }, []);

  return { pendingRecord, record };
}
