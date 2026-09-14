/**
 * Route-level wiring for the O3 location console (T4.10). The screen is
 * pure over injected data (the house seam); this module is the seam
 * that feeds it. The owner is ONLINE-ONLY (PLAN-FRONTEND.md §4 — no
 * mirror, no outbox), so the seam is react-query reads against the api
 * client:
 *
 * - **roster** — `GET /v1/location/employees`, the owner-only read
 *   (T4.4) that carries health AND position. Refreshes on a slow beat,
 *   faster while a live window is open, never while the screen is
 *   blurred (the pulse stops and so does the polling — nothing a
 *   background tab cannot see is worth a background tab's timers).
 * - **trail** — `GET /v1/location/employees/:id/trail?date=<IST today>`,
 *   for the selected employee's day line.
 * - **locate-now** — `POST /v1/location/requests` persists the request
 *   server-side; this hook POLLS `GET /v1/location/requests/:id` every
 *   three seconds until the row reports a terminal state. No spinner,
 *   no optimistic guessing: the row is the truth, and expiry is a
 * *statement* rendered by the screen ("device has not answered" + why).
 * - **flags** — `owner.location` gates the console, from `/v1/auth/me`
 *   like every flag (PLAN-EXECUTION.md §3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthMeResponse, FeatureFlagState } from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import { haptic } from '../../components/ui/haptics';
import {
  istBusinessDate,
  liveWindowOpen,
  trailStops as labelStops,
  type LocateRequest,
  type RosterRow,
  type TrailPoint,
} from './locationModel';
import type { LocationConsoleDeps } from './location';

/** Locate-now poll cadence while the window is open. */
const POLL_MS = 3_000;
/** Roster refresh while idle-focused, and while a live window is open. */
const ROSTER_REFRESH_MS = 30_000;
const LIVE_REFRESH_MS = 10_000;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

/** `owner.location`, evaluated from `/v1/auth/me` like every flag.
 * Until an answer exists it reads off — the console is dark, never
 * half-lit. A failed fetch keeps the last known answer. */
export function useOwnerLocationFlag(): boolean {
  const cached = cachedFeatureFlags();
  const [on, setOn] = useState(() => cached?.['owner.location'] ?? false);
  useEffect(() => {
    if (cachedFeatureFlags() !== null) return;
    let alive = true;
    void (async (): Promise<FeatureFlagState | null> => {
      const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
      if (!res.ok || res.data === null) return null;
      const flags = { ...defaultFeatureFlags(), ...res.data.featureFlags };
      setFeatureFlags(flags);
      return flags;
    })()
      .then((flags) => {
        if (alive && flags !== null) setOn(flags['owner.location']);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cached]);
  return on;
}

export interface UseLocationConsoleOptions {
  /** Desk presentation from the route (density), passed through. */
  desk: boolean;
  /** The screen's focus state — the route owns `useFocusEffect`. While
   * false: no polling, no pulse, no elapsed-seconds ticking. */
  focused: boolean;
  /** Deep-link preselection (`/location/[employeeId]`). */
  initialEmployeeId?: string;
}

export function useLocationConsole(opts: UseLocationConsoleOptions): LocationConsoleDeps {
  const queryClient = useQueryClient();
  const flagOn = useOwnerLocationFlag();

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(opts.initialEmployeeId ?? null);
  const [request, setRequest] = useState<LocateRequest | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const live = liveWindowOpen(request, now);
  const requestOpen = request !== null && (request.status === 'requested' || request.status === 'pushed');

  // The roster: health + last-seen + position, worst first by the time
  // the screen sorts it.
  const roster = useQuery({
    queryKey: ['owner', 'location', 'roster'],
    queryFn: () => fetchJson<RosterRow[]>('/v1/location/employees'),
    enabled: flagOn,
    refetchInterval: opts.focused ? (live ? LIVE_REFRESH_MS : ROSTER_REFRESH_MS) : false,
  });

  // The selected employee's day trail, in today's IST business date.
  const trail = useQuery({
    queryKey: ['owner', 'location', 'trail', selectedEmployeeId, istBusinessDate(now)],
    queryFn: () =>
      fetchJson<TrailPoint[]>(
        `/v1/location/employees/${selectedEmployeeId ?? ''}/trail?date=${istBusinessDate(now)}`,
      ),
    enabled: flagOn && selectedEmployeeId !== null,
    refetchInterval: opts.focused && live ? LIVE_REFRESH_MS : false,
  });

  // The clock: one tick a second while something on screen is counting
  // (an open request's elapsed seconds, a live window closing), silent
  // the moment nothing is.
  const counting = opts.focused && (requestOpen || live);
  useEffect(() => {
    if (!counting) return;
    const t: ReturnType<typeof setInterval> = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [counting]);

  // The locate-now poll. Every three seconds the ROW is asked, not
  // guessed at; the terminal states close the loop and the roster and
  // trail re-read so the dot move and the trail extension are the
  // fulfilment's visible form.
  const fulfilledSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!opts.focused || request === null || !requestOpen) return;
    let alive = true;
    const id: ReturnType<typeof setInterval> = setInterval(() => {
      void (async () => {
        const res = await api.request<LocateRequest>('GET', `/v1/location/requests/${request.id}`);
        if (!alive || !res.ok || res.data === null) return;
        setRequest(res.data);
        setNow(Date.now());
        if (res.data.status === 'fulfilled' && fulfilledSeenRef.current !== res.data.id) {
          fulfilledSeenRef.current = res.data.id;
          haptic('completionSynced'); // the `Success` haptic where supported (§O3)
          void queryClient.invalidateQueries({ queryKey: ['owner', 'location'] });
        }
        if (res.data.status === 'expired' || res.data.status === 'failed') {
          void queryClient.invalidateQueries({ queryKey: ['owner', 'location', 'roster'] });
        }
      })();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [opts.focused, queryClient, request, requestOpen]);

  // A new selection invalidates the previous request's statement — the
  // status line answers the SELECTED employee, never a stale one.
  const onSelectEmployee = useCallback((employeeId: string) => {
    setRequest(null);
    setActionError(null);
    setSelectedEmployeeId(employeeId);
  }, []);

  const onLocate = useCallback(
    (mode: 'fix' | 'live') => {
      if (selectedEmployeeId === null) return;
      setRequestBusy(true);
      setActionError(null);
      void (async () => {
        try {
          const res = await api.request<LocateRequest>('POST', '/v1/location/requests', {
            body: { employeeId: selectedEmployeeId, mode },
          });
          if (!res.ok || res.data === null) {
            setActionError(res.error?.message ?? 'The request did not go through. Try again.');
            return;
          }
          setNow(Date.now());
          setRequest(res.data); // the row, not a hope — status may already be failed
        } finally {
          setRequestBusy(false);
        }
      })();
    },
    [selectedEmployeeId],
  );

  const stops = useMemo(() => (trail.data !== undefined ? labelStops(trail.data) : null), [trail.data]);

  return {
    now,
    desk: opts.desk,
    flagOn,
    rows: roster.data ?? null,
    error:
      roster.isError && roster.error instanceof Error
        ? roster.error.message
        : null,
    actionError,
    selectedEmployeeId,
    onSelectEmployee,
    trailStops: stops,
    trailCount: trail.data?.length ?? 0,
    trailLoading: trail.isLoading,
    request,
    requestBusy,
    pulseActive: opts.focused && live,
    onLocateNow: () => onLocate('fix'),
    onLive: () => onLocate('live'),
    onRetry: () => void roster.refetch(),
  };
}
