/**
 * The customer search, extracted at T2B.4 from `useDispatchForm` so the
 * AMC form (§D5) and the dispatch form (§D3) run ONE search: the same
 * 250 ms debounce, the same `GET /v1/customers?q=…&limit=20`, the same
 * option shape. `initialCustomerId` preselects a customer — the due
 * list's Dispatch deep-link (`/jobs/new?customerId=…`) lands with the
 * customer already chosen and the AMC option, if he has one, already
 * showing.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { CustomerDetailDispatcher, CustomerDispatcher } from '@servgrid/shared';
import { api } from '../../lib/api';
import {
  type DispatchCustomerOption,
} from './dispatchForm';

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

/** `addressLine1`, or the city when the line is missing — one line. */
export function customerOptionOf(row: CustomerDispatcher): DispatchCustomerOption {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    addressLabel: row.addressLine1 ?? row.city ?? null,
  };
}

export interface CustomerSearch {
  query: string;
  setQuery(q: string): void;
  /** The search's answers, or null while the search runs. */
  results: DispatchCustomerOption[] | null;
  error: string | null;
  selected: DispatchCustomerOption | null;
  select(customer: DispatchCustomerOption): void;
  clear(): void;
}

export function useCustomerSearch(options?: { initialCustomerId?: string | null }): CustomerSearch {
  const initialCustomerId = options?.initialCustomerId ?? null;

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DispatchCustomerOption | null>(null);

  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchActive = selected === null && debouncedQuery.trim() !== '';

  const search = useQuery({
    queryKey: ['dispatch', 'customer-search', debouncedQuery.trim()],
    queryFn: () =>
      fetchJson<CustomerListEnvelope>(
        `/v1/customers?q=${encodeURIComponent(debouncedQuery.trim())}&limit=${SEARCH_LIMIT}`,
      ),
    enabled: searchActive,
  });

  // The deep-linked preselect: one read, selected once — a later clear
  // must not re-pick him from a cache that has not moved on.
  const initial = useQuery({
    queryKey: ['dispatch', 'customer-initial', initialCustomerId],
    queryFn: () => fetchJson<CustomerDetailDispatcher>(`/v1/customers/${initialCustomerId ?? ''}`),
    enabled: initialCustomerId !== null,
    // CustomerDetailDispatcher is the site plus its stack; the option
    // reads the same four fields the search rows do.
    select: (detail: CustomerDetailDispatcher) => customerOptionOf(detail),
  });
  useEffect(() => {
    if (initial.data !== undefined && selected === null) {
      setSelected(initial.data);
    }
    // Runs on the initial customer's arrival and on clears — exactly the
    // two moments a preselect may fill the slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.data]);

  return {
    query,
    setQuery,
    results: search.data === undefined ? null : (search.data.items.map(customerOptionOf) as DispatchCustomerOption[]),
    error: search.isError ? (search.error?.message ?? 'The search did not go through. Try again.') : null,
    selected,
    select: (customer) => {
      setSelected(customer);
      setQuery('');
    },
    clear: () => setSelected(null),
  };
}
