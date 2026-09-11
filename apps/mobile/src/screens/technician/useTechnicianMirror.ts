/**
 * Route-level wiring for the technician's two mirror screens (T1.17).
 * The screens are pure over injected data; this hook is the seam that
 * feeds them (the same division as the ladder/handover routes, shared by
 * both of this task's routes so their wiring cannot drift):
 *
 * - **flags** — `tech.jobs` gates both screens, evaluated from
 *   `GET /v1/auth/me` (PLAN-EXECUTION.md §3). The response is cached for
 *   the process; until an answer exists the flag reads its default,
 *   off — the screen is dark without it. A failed fetch keeps the last
 *   known answer (offline must not flip a live screen dark), and the
 *   fetch failure itself raises nothing: offline renders no banner.
 * - **data** — one read of the mirror + outbox (`readJobData`) after the
 *   mirror opens; re-read after every drain. No fetch behind the
 *   figures — the mirror is the source (PLAN-FRONTEND.md §4).
 * - **drain** — T1.14's manager created once per employee; pull to
 *   refresh is `drainNow()` (§5's manual trigger). The system triggers
 *   (reconnect, foreground, timer) stay with T1.15's cold-start wiring —
 *   this hook only drives the manual cycle.
 * - **health** — the tracking chip's view data, fetched best-effort; the
 *   last known value survives a failure, and nothing known degrades to
 *   the chip's own "never reported" state.
 */
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';

import type { AuthMeResponse, FeatureFlagState, TrackingHealth } from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { openMirror, type Mirror } from '../../db/mirror';
import { api } from '../../lib/api';
import { createDrainManager, type DrainManager, type DrainResult } from '../../sync/drain';
import { enqueue } from '../../sync/outbox';
import type { StoredActor } from '../../lib/types';
import { moveJobStatus, readJobData, revertJobStatus } from './jobData';
import { primaryActionOf, statusChangeOp, type JobView } from './jobView';
import type { JobTimelineEntry } from './jobDetail';

// Process-level session cache: the mirror, the drain and the flag answer
// are per-employee singletons — the screens re-render, the plumbing does
// not re-open. A different employee re-opens the mirror (the switch
// itself — clearMirror, outbox filtering — is the user-switch contract,
// not this hook's).
let cachedFlags: FeatureFlagState | null = null;
let cachedHealth: TrackingHealth | null = null;
let mirrorFor: { employeeId: string; mirror: Promise<Mirror> } | null = null;
let drainFor: { employeeId: string; manager: DrainManager } | null = null;

async function ensureMirror(employeeId: string): Promise<Mirror> {
  if (mirrorFor === null || mirrorFor.employeeId !== employeeId) {
    mirrorFor = { employeeId, mirror: openMirror('technician') };
  }
  return mirrorFor.mirror;
}

function ensureDrain(employeeId: string, mirror: Mirror): DrainManager {
  if (drainFor === null || drainFor.employeeId !== employeeId) {
    drainFor = {
      employeeId,
      manager: createDrainManager({ mirror, send: api.request, employeeId }),
    };
  }
  return drainFor.manager;
}

async function loadFlags(): Promise<FeatureFlagState> {
  if (cachedFlags !== null) return cachedFlags;
  const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
  // Missing flag reads false (flags.ts) — including the offline case,
  // where the fetch failed and there is no cached answer yet.
  cachedFlags = {
    ...defaultFeatureFlags(),
    ...(res.ok && res.data !== null ? res.data.featureFlags : {}),
  };
  return cachedFlags;
}

export interface TechnicianScreenFlags {
  flagsReady: boolean;
  flagOn: boolean;
}

/** `tech.jobs` — the flag both of this task's screens ship behind. */
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

export interface TechnicianMirrorState {
  views: JobView[];
  completedAtById: Record<string, string>;
  pendingCount: number;
  /** Each job's local timeline (outbox-derived, §T3) — the detail reads it. */
  eventsByJobId: Record<string, JobTimelineEntry[]>;
}

export interface TechnicianMirrorDeps extends TechnicianMirrorState {
  /** Tracking health, last known; null before the first answer. */
  health: TrackingHealth | null;
  draining: boolean;
  /** Pull to refresh: drains the outbox, then re-reads the mirror. */
  refresh: () => void;
  /** The NEXT card's primary action: optimistic move + one outbox row. */
  startJob: (view: JobView) => void;
  /** *Navigate*: deep-links to `google.navigation:q=lat,lng` (§T3). */
  navigate: (view: JobView) => void;
}

/** Feed the screens from the mirror. Null until the mirror has opened —
 * or when there is no technician session, in which case the hook never
 * opens anything (a dispatcher's session must not open a mirror). */
export function useTechnicianMirror(actor: StoredActor | null): TechnicianMirrorDeps | null {
  const employeeId = actor?.role === 'technician' ? actor.id : null;
  const [state, setState] = useState<TechnicianMirrorState | null>(null);
  const [health, setHealth] = useState<TrackingHealth | null>(cachedHealth);
  const [draining, setDraining] = useState(false);

  const reload = useCallback(async (): Promise<TechnicianMirrorState | null> => {
    if (employeeId === null) return null;
    const mirror = await ensureMirror(employeeId);
    const next = readJobData(mirror.database, employeeId);
    setState(next);
    return next;
  }, [employeeId]);

  useEffect(() => {
    if (employeeId === null) return;
    let alive = true;
    void (async () => {
      await reload();
      // Best-effort health: a failure keeps the last known value and
      // raises nothing — offline renders no banner (§T1).
      try {
        const res = await api.request<TrackingHealth>('GET', '/v1/location/health/me');
        if (res.ok && res.data !== null) {
          cachedHealth = res.data;
          if (alive) setHealth(res.data);
        }
      } catch {
        // Still no health known — the chip degrades, the screen doesn't.
      }
    })();
    return () => {
      alive = false;
    };
  }, [employeeId, reload]);

  const refresh = useCallback(() => {
    if (employeeId === null) return;
    void (async () => {
      const mirror = await ensureMirror(employeeId);
      const manager = ensureDrain(employeeId, mirror);
      setDraining(true);
      let result: DrainResult;
      try {
        result = await manager.drainNow();
      } finally {
        await reload();
        setDraining(false);
      }
      // A fully drained outbox earns the Success haptic (02-MOTION.md
      // §8) — owned by the badge's tick-down, fired by the drain event
      // stream when T1.18/19 wire it; the count here re-reads silently.
      void result;
    })();
  }, [employeeId, reload]);

  const startJob = useCallback(
    (view: JobView) => {
      if (employeeId === null) return;
      void (async () => {
        const primary = primaryActionOf(view.job.status);
        if (primary === null) return;
        const mirror = await ensureMirror(employeeId);
        // §5: the mirror moves first (the screen already shows it), the
        // row goes in the outbox second; a failed enqueue is reverted.
        const previous = moveJobStatus(mirror.database, view.job.id, primary.to);
        if (previous === null) return;
        try {
          const op = statusChangeOp(view.job.id, primary.to, new Date());
          await enqueue(mirror.database, {
            employeeId,
            method: 'POST',
            path: op.path,
            body: op.body,
            entityType: 'job',
            entityLocalId: view.job.id,
          });
        } catch {
          revertJobStatus(mirror.database, view.job.id, previous);
        }
        await reload();
      })();
    },
    [employeeId, reload],
  );

  const navigate = useCallback((view: JobView) => {
    if (view.coordinates === null) return;
    const { latitude, longitude } = view.coordinates;
    void Linking.openURL(`google.navigation:q=${latitude},${longitude}`);
  }, []);

  if (employeeId === null || state === null) return null;
  return { ...state, health, draining, refresh, startJob, navigate };
}
