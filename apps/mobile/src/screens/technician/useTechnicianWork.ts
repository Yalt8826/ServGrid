/**
 * Route-level wiring for the technician's screens (PLAN-FRONTEND.md §4–§5).
 * The screens are pure over injected data; this module is the seam that
 * feeds them, now straight from the server — the app stores nothing
 * (decision 2026-09-15):
 *
 * - **flags** — `tech.jobs` gates the screens, evaluated from
 *   `GET /v1/auth/me`. Until an answer exists the flag reads its default,
 *   off: the screen is dark without it.
 * - **data** — `GET /v1/technician/work`, a TanStack query held in memory
 *   and refetched on pull, after every write and on a push wake.
 * - **writes** — *Start job* / *Arrive* call `POST /v1/jobs/:id/status`
 *   directly. Each intent pins its key and its body (`lib/intentWrite`),
 *   so a retry after a dropped connection replays instead of repeating.
 *   While a write is in flight the job reads `pending`; when the server
 *   refuses, its sentence lands on the job as `rejectedMessage`.
 * - **health** — the tracking chip's view data, fetched best-effort.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthMeResponse, FeatureFlagState, JobStatus, JobTimelineDispatcherResponse, TechnicianWork, TrackingHealth } from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { createIntentWriter, messageOfWriteError, type IntentRequest, type IntentWriter } from '../../lib/intentWrite';
import type { StoredActor } from '../../lib/types';
import { setFeatureFlags } from '../../state/featureFlags';
import { timelineFromEvents, type JobTimelineEntry } from './jobDetail';
import { primaryActionOf, statusChangeOp, type JobView } from './jobView';
import { buildJobViews } from './workData';

export const TECHNICIAN_WORK_KEY = ['technician', 'work'] as const;

export function jobEventsKey(jobId: string): readonly ['technician', 'events', string] {
  return ['technician', 'events', jobId];
}

/** The API client's request, as the intent writer calls it. */
export const intentRequest: IntentRequest = (method, path, options) => api.request(method, path, options);

async function fetchWork(): Promise<TechnicianWork> {
  const res = await api.request<TechnicianWork>('GET', '/v1/technician/work');
  if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'Your jobs could not be loaded.');
  return res.data;
}

/** The work query's options — shared with the push wake so both read one cache entry. */
export function technicianWorkQuery() {
  return { queryKey: TECHNICIAN_WORK_KEY, queryFn: fetchWork, staleTime: 30_000 };
}

// ── flags ────────────────────────────────────────────────────────────────────

let cachedFlags: FeatureFlagState | null = null;

async function loadFlags(): Promise<FeatureFlagState> {
  if (cachedFlags !== null) return cachedFlags;
  const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
  cachedFlags = {
    ...defaultFeatureFlags(),
    ...(res.ok && res.data !== null ? res.data.featureFlags : {}),
  };
  // Publish process-wide: the location task's tech.location gate reads the same answer.
  setFeatureFlags(cachedFlags);
  return cachedFlags;
}

export interface TechnicianScreenFlags {
  flagsReady: boolean;
  flagOn: boolean;
}

/** `tech.jobs` — the flag the technician's screens ship behind. */
export function useTechJobsFlag(): TechnicianScreenFlags {
  const [state, setState] = useState<TechnicianScreenFlags>(() =>
    cachedFlags === null ? { flagsReady: false, flagOn: false } : { flagsReady: true, flagOn: cachedFlags['tech.jobs'] },
  );
  useEffect(() => {
    if (cachedFlags !== null) return;
    let alive = true;
    void loadFlags().then((flags) => {
      if (alive) setState({ flagsReady: true, flagOn: flags['tech.jobs'] });
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// ── the work ─────────────────────────────────────────────────────────────────

export interface TechnicianWorkDeps {
  views: JobView[];
  /** Job id → when the server closed a completed job. */
  completedAtById: Record<string, string>;
  /** The product catalogue — the complete sheet's parts picker. */
  products: Array<{ id: string; name: string; category: string }>;
  /** Tracking health, last known; null before the first answer. */
  health: TrackingHealth | null;
  /** A refetch is running (pull to refresh). */
  refreshing: boolean;
  /** Pull to refresh: clears refusals and reads the server again. */
  refresh: () => void;
  /** The NEXT card's primary action: one status write, straight to the server. */
  startJob: (view: JobView) => void;
  /** *Navigate*: deep-links to `google.navigation:q=lat,lng` (§T3). */
  navigate: (view: JobView) => void;
}

interface StatusIntent {
  writer: IntentWriter;
  /** Pinned with the key: a retry must carry the same body. */
  body: { to: JobStatus; occurredAt: string };
  path: string;
}

/** Feed the screens from the server. Null until the first answer — or when
 * there is no technician session, in which case nothing is fetched. */
export function useTechnicianWork(actor: StoredActor | null): TechnicianWorkDeps | null {
  const employeeId = actor?.role === 'technician' ? actor.id : null;
  const queryClient = useQueryClient();
  const work = useQuery({ ...technicianWorkQuery(), enabled: employeeId !== null });
  const [health, setHealth] = useState<TrackingHealth | null>(null);
  const [inFlight, setInFlight] = useState<Record<string, true>>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const intents = useRef(new Map<string, StatusIntent>());

  useEffect(() => {
    if (employeeId === null) return;
    let alive = true;
    void (async () => {
      try {
        const res = await api.request<TrackingHealth>('GET', '/v1/location/health/me');
        if (alive && res.ok && res.data !== null) setHealth(res.data);
      } catch {
        // No health known — the chip degrades to "never reported", the screen doesn't.
      }
    })();
    return () => {
      alive = false;
    };
  }, [employeeId]);

  const built = useMemo(() => (work.data === undefined ? null : buildJobViews(work.data)), [work.data]);

  const refresh = useCallback(() => {
    setRefusals({});
    void work.refetch();
  }, [work]);

  const startJob = useCallback(
    (view: JobView) => {
      const primary = primaryActionOf(view.job.status);
      if (primary === null) return;
      const jobId = view.job.id;
      const intentId = `${jobId}:${primary.to}`;
      let intent = intents.current.get(intentId);
      if (intent === undefined) {
        const op = statusChangeOp(jobId, primary.to, new Date());
        intent = { writer: createIntentWriter(intentRequest), body: op.body, path: op.path };
        intents.current.set(intentId, intent);
      }
      const pinned = intent;
      setInFlight((current) => ({ ...current, [jobId]: true }));
      setRefusals(({ [jobId]: _cleared, ...rest }) => rest);
      void (async () => {
        try {
          await pinned.writer.send('POST', pinned.path, pinned.body);
          intents.current.delete(intentId);
          void queryClient.invalidateQueries({ queryKey: jobEventsKey(jobId) });
          await queryClient.invalidateQueries({ queryKey: TECHNICIAN_WORK_KEY });
        } catch (error) {
          // A definite refusal is a finished intent; a dropped connection keeps it for the retry.
          if (pinned.writer.pendingKey() === null) intents.current.delete(intentId);
          setRefusals((current) => ({ ...current, [jobId]: messageOfWriteError(error) }));
        } finally {
          setInFlight(({ [jobId]: _done, ...rest }) => rest);
        }
      })();
    },
    [queryClient],
  );

  const navigate = useCallback((view: JobView) => {
    if (view.coordinates === null) return;
    const { latitude, longitude } = view.coordinates;
    void Linking.openURL(`google.navigation:q=${latitude},${longitude}`);
  }, []);

  const views = useMemo(
    () =>
      built === null
        ? null
        : built.views.map((view) => ({
            ...view,
            pending: inFlight[view.job.id] === true,
            rejectedMessage: refusals[view.job.id] ?? null,
          })),
    [built, inFlight, refusals],
  );

  if (employeeId === null || built === null || views === null) return null;
  return {
    views,
    completedAtById: built.completedAtById,
    products: built.products,
    health,
    refreshing: work.isFetching,
    refresh,
    startJob,
    navigate,
  };
}

// ── the timeline ─────────────────────────────────────────────────────────────

/** His job's trail, from the server (`GET /v1/jobs/:id/events`, money-free). */
export function useJobTimeline(jobId: string | null): JobTimelineEntry[] {
  const events = useQuery({
    queryKey: jobEventsKey(jobId ?? ''),
    enabled: jobId !== null,
    queryFn: async () => {
      const res = await api.request<JobTimelineDispatcherResponse>('GET', `/v1/jobs/${jobId}/events`);
      if (!res.ok || res.data === null) throw new Error(res.error?.message ?? 'The job history could not be loaded.');
      return timelineFromEvents(res.data.events);
    },
  });
  return events.data ?? [];
}
