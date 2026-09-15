/**
 * Route-level wiring for the AMC screens (T2B.4, §D5/§O6). The screens
 * are pure over injected data; this module is the seam that feeds them —
 * online-only TanStack Query reads against the api client, exactly like
 * `useJobLogs` (the dispatcher never queues: PLAN-FRONTEND.md §4).
 *
 * Reads (PLAN-BACKEND.md §11.1):
 * - **sections** — three lists off one endpoint: `?filter=due` (the
 *   reminder: four months since the customer's last completed job, any
 *   job), `?filter=ending` (ends within 7 days) and `?filter=all` (the
 *   searchable ledger). Each section fails ALONE — a due-read failure
 *   never blanks the ending list beside it.
 * - **detail** — the AMC plus every job linked to it.
 * - **active-for-customer** — the one active AMC a customer holds; the
 *   dispatch form's checkbox reads it (decision 2).
 *
 * Writes: create and cancel are idempotent POSTs and go through an
 * intent writer (lib/intentWrite) — one key per submit intent, pinned
 * WITH its body so a retry after a dropped connection replays instead of
 * repeating (and an edited form is a NEW intent — the server would 422 a
 * changed body under an old key). Update rides `If-Match` (the version
 * guard the list showed), which makes it safe without a key.
 */
import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { Contract, ContractDetail, ContractListFilter } from '@servgrid/shared';
import { api } from '../../lib/api';
import { createIntentWriter, WriteNotSaved, type IntentRequest, type IntentWriter } from '../../lib/intentWrite';
import { patchOf, type AmcDraft } from './model';

/** The API client's request, as the intent writer calls it. */
export const intentRequest: IntentRequest = (method, path, options) => api.request(method, path, options);

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface ContractListEnvelope {
  items: Contract[];
  nextCursor: string | null;
}

// ── query keys ─────────────────────────────────────────────────────────────

/** Every contracts query hangs off this root — one write invalidates the
 * whole surface, so the tab, the detail and the dispatch form's option
 * cannot disagree after a save. */
export const CONTRACTS_KEY = ['contracts'] as const;

export const contractListKey = (filter: ContractListFilter, q: string) => ['contracts', 'list', filter, q] as const;

export const contractDetailKey = (id: string) => ['contracts', 'detail', id] as const;

export const customerActiveContractKey = (customerId: string) => ['contracts', 'customer-active', customerId] as const;

// ── reads ──────────────────────────────────────────────────────────────────

export interface ContractSections {
  due: Contract[] | null;
  ending: Contract[] | null;
  all: Contract[] | null;
  errors: { due: string | null; ending: string | null; all: string | null };
  loading: boolean;
  refetch(section: 'due' | 'ending' | 'all'): void;
}

/** The AMC tab's three sections. Each is its own query with its own
 * error — the screen renders what answered and a retry on what did not. */
export function useContractSections(q: string): ContractSections {
  const query = q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`;
  const due = useQuery({
    queryKey: contractListKey('due', query),
    queryFn: () => fetchJson<ContractListEnvelope>(`/v1/contracts?filter=due&limit=100${query}`),
    select: (envelope: ContractListEnvelope) => envelope.items,
  });
  const ending = useQuery({
    queryKey: contractListKey('ending', query),
    queryFn: () => fetchJson<ContractListEnvelope>(`/v1/contracts?filter=ending&limit=100${query}`),
    select: (envelope: ContractListEnvelope) => envelope.items,
  });
  const all = useQuery({
    queryKey: contractListKey('all', query),
    queryFn: () => fetchJson<ContractListEnvelope>(`/v1/contracts?filter=all&limit=200${query}`),
    select: (envelope: ContractListEnvelope) => envelope.items,
  });

  const messageOf = (error: unknown): string =>
    error instanceof Error && error.message !== '' ? error.message : 'The request did not go through. Try again.';

  return {
    due: due.data ?? null,
    ending: ending.data ?? null,
    all: all.data ?? null,
    errors: {
      due: due.isError ? messageOf(due.error) : null,
      ending: ending.isError ? messageOf(ending.error) : null,
      all: all.isError ? messageOf(all.error) : null,
    },
    loading: due.isLoading || ending.isLoading || all.isLoading,
    refetch: (section) => {
      if (section === 'due') void due.refetch();
      else if (section === 'ending') void ending.refetch();
      else void all.refetch();
    },
  };
}

/** The AMC plus every job linked to it — the detail screen's read. */
export function useContractDetail(id: string): {
  detail: ContractDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const detail = useQuery({
    queryKey: contractDetailKey(id),
    queryFn: () => fetchJson<ContractDetail>(`/v1/contracts/${id}`),
    enabled: id !== '',
  });
  return {
    detail: detail.data ?? null,
    loading: detail.isLoading,
    error: detail.isError ? (detail.error?.message ?? 'The AMC could not be loaded. Try again.') : null,
    refetch: () => void detail.refetch(),
  };
}

/** The customer's one ACTIVE AMC, or null — the dispatch form's AMC
 * checkbox reads this while the dispatcher is still on the phone. */
export function useActiveContractFor(customerId: string | null, enabled: boolean): Contract | null {
  const active = useQuery({
    queryKey: customerActiveContractKey(customerId ?? ''),
    queryFn: () =>
      fetchJson<ContractListEnvelope>(
        `/v1/contracts?filter=all&state=active&customerId=${encodeURIComponent(customerId ?? '')}&limit=1`,
      ),
    enabled: enabled && customerId !== null,
    select: (envelope: ContractListEnvelope) => envelope.items[0] ?? null,
  });
  return active.data ?? null;
}

// ── the writes ─────────────────────────────────────────────────────────────

/** One pinned intent: the writer holds the key, the JSON holds the body
 * it was minted FOR. A retry with an edited form starts a new intent. */
interface PinnedIntent {
  writer: IntentWriter;
  bodyJson: string;
}

/** The create body as the wire wants it — the draft's blank notes clear. */
export interface ContractCreateBody {
  customerId: string;
  startDate: string;
  endDate: string;
  contractValue: string;
  notes: string | null;
}

export function useSaveContract(): {
  create(draft: ContractCreateBody): Promise<Contract>;
  update(original: Contract, draft: AmcDraft): Promise<Contract>;
  cancel(id: string, reason: string): Promise<Contract>;
  saving: boolean;
  error: WriteNotSaved | null;
} {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<WriteNotSaved | null>(null);
  const createIntent = useRef<PinnedIntent | null>(null);
  const cancelIntent = useRef<PinnedIntent | null>(null);

  const create = useCallback(
    async (body: ContractCreateBody): Promise<Contract> => {
      const bodyJson = JSON.stringify(body);
      if (createIntent.current === null || createIntent.current.bodyJson !== bodyJson) {
        createIntent.current = { writer: createIntentWriter(intentRequest), bodyJson };
      }
      const pinned = createIntent.current;
      setSaving(true);
      setError(null);
      try {
        const saved = (await pinned.writer.send('POST', '/v1/contracts', body)) as Contract;
        createIntent.current = null;
        await queryClient.invalidateQueries({ queryKey: CONTRACTS_KEY });
        return saved;
      } catch (e) {
        const refusal =
          e instanceof WriteNotSaved
            ? e
            : new WriteNotSaved(e instanceof Error ? e.message : 'The AMC could not be saved. Try again.', 0, null);
        // A definite refusal is a finished intent; a dropped connection keeps it for the retry.
        if (pinned.writer.pendingKey() === null) createIntent.current = null;
        setError(refusal);
        throw refusal;
      } finally {
        setSaving(false);
      }
    },
    [queryClient],
  );

  const update = useCallback(
    async (original: Contract, draft: AmcDraft): Promise<Contract> => {
      setSaving(true);
      setError(null);
      try {
        const res = await api.request<Contract>('PATCH', `/v1/contracts/${original.id}`, {
          body: patchOf(original, draft),
          headers: { 'If-Match': String(original.version) },
        });
        if (!res.ok || res.data === null) {
          throw new WriteNotSaved(
            res.error?.message ?? 'The AMC could not be saved. Try again.',
            res.status,
            res.error?.code ?? null,
            res.error?.details ?? null,
          );
        }
        await queryClient.invalidateQueries({ queryKey: CONTRACTS_KEY });
        return res.data;
      } catch (e) {
        const refusal =
          e instanceof WriteNotSaved
            ? e
            : new WriteNotSaved(e instanceof Error ? e.message : 'The AMC could not be saved. Try again.', 0, null);
        setError(refusal);
        throw refusal;
      } finally {
        setSaving(false);
      }
    },
    [queryClient],
  );

  const cancel = useCallback(
    async (id: string, reason: string): Promise<Contract> => {
      const body = { reason };
      const bodyJson = JSON.stringify(body);
      if (cancelIntent.current === null || cancelIntent.current.bodyJson !== bodyJson) {
        cancelIntent.current = { writer: createIntentWriter(intentRequest), bodyJson };
      }
      const pinned = cancelIntent.current;
      setSaving(true);
      setError(null);
      try {
        const saved = (await pinned.writer.send('POST', `/v1/contracts/${id}/cancel`, body)) as Contract;
        cancelIntent.current = null;
        await queryClient.invalidateQueries({ queryKey: CONTRACTS_KEY });
        return saved;
      } catch (e) {
        const refusal =
          e instanceof WriteNotSaved
            ? e
            : new WriteNotSaved(e instanceof Error ? e.message : 'The AMC could not be cancelled. Try again.', 0, null);
        if (pinned.writer.pendingKey() === null) cancelIntent.current = null;
        setError(refusal);
        throw refusal;
      } finally {
        setSaving(false);
      }
    },
    [queryClient],
  );

  return { create, update, cancel, saving, error };
}
