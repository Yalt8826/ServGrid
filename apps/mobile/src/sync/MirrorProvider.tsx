/**
 * The mirror's session provider (T1.15, PLAN-FRONTEND.md §4 "provider
 * setup", §5.1). The cold-start bootstrap (T0.11) has already read the
 * token store and set the actor when this mounts; what was missing is
 * the bridge from that actor to the mirror T1.13 built and the drain
 * T1.14 built. This provider is the bridge — and nothing in it is ever
 * awaited by a render:
 *
 * - For an offline role (`ROLE_CAPABILITIES[role].offline`) it opens the
 *   SQLite mirror once per employee session — the capability check inside
 *   `openMirror` runs BEFORE the dynamic import, so for a dispatcher or
 *   owner `expo-sqlite` is never even loaded.
 * - It runs the sync cycle in the background: on the first cycle after a
 *   fresh mirror (`cursor === null`) it fetches `GET /v1/sync/bootstrap`
 *   and applies the working set atomically; every cycle then drains the
 *   outbox and pulls the delta, exactly as T1.14's manager defines them.
 *   Offline, the bootstrap is a status-0 result that is skipped and
 *   retried on the next trigger — a failed sync is never a logout.
 * - It wires the drain's `auth-lost` event to the session store: only a
 *   COMPLETED refresh refusal logs anyone out (§5.1), and when that
 *   happens the API client has already cleared the credential store —
 *   flipping the store here is what moves the UI to the login screen.
 * - For the session's lifetime it registers the push handler's sync
 *   executor (T2.6, `notifications/handler`): a data-only FCM wake runs
 *   this provider's own cycle and raises local notifications from the
 *   job rows the delta delivered — never a second drain, never a second
 *   SQLite writer. The registration is cleared the moment the session
 *   ends or switches.
 * - On session end or user switch it clears the mirror: its lifetime is
 *   "until logout" (§4), not until app close. An app teardown leaves the
 *   working set on disk so the NEXT cold start — possibly with no radio —
 *   renders yesterday's jobs. The outbox is not touched here: T1.14
 *   filters it by `employee_id` and preserves rejected rows by contract.
 *
 * `send` and `triggers` are injected by `(app)/_layout.tsx` (which owns
 * the platform seams: the API client and `systemTriggers`, Metro-resolved
 * to `triggers.native.ts` on the handset) so this file stays importable
 * under vitest with fakes.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SyncBootstrapResponse } from '@servgrid/shared';

import type { Mirror } from '../db/mirror';
import { applyBootstrap, clearMirror, openMirror, readCursor, roleHasMirror } from '../db/mirror';
import { pendingSyncCount } from './outbox';
import { createDrainManager, type DrainManager, type DrainSend, type DrainTriggers } from './drain';
import { setPushSyncExecutor, type PushJobRow } from '../notifications/handler';
import { useSessionStore } from '../state/sessionStore';

/** What a screen with a local working set consumes. Null for online
 * roles — their failure mode is a clear error state, not a queue. */
export interface MirrorSession {
  readonly mirror: Mirror;
  /** The employee this session is scoped to — every outbox read and drain
   * is filtered by him (§5; a handset may be shared). */
  readonly employeeId: string;
  /** The drain manager — `drainNow` is the manual *Retry now*. */
  readonly drain: DrainManager;
  /** Queued + inflight rows for this employee — the PendingBadge's count
   * and the profile logout gate's. */
  readonly pendingCount: number;
  /** Bumped after every background sync cycle so mirror readers re-read. */
  readonly revision: number;
  /** Manual trigger: pull-to-refresh, *Retry now*. Bootstraps if the
   * mirror is still empty, then drains — one cycle. */
  readonly syncNow: () => void;
}

const MirrorSessionContext = createContext<MirrorSession | null>(null);

/** The app's mirror session, or null before it is open / for online roles. */
export function useMirrorSession(): MirrorSession | null {
  return useContext(MirrorSessionContext);
}

export interface MirrorProviderProps {
  children: ReactNode;
  /** The API client's `request` — the 401 contract lives there, nowhere else. */
  send: DrainSend;
  /** Platform drain triggers; the real ones are native-only (`triggers.native.ts`). */
  triggers: DrainTriggers;
}

interface OpenSession {
  mirror: Mirror;
  employeeId: string;
  drain: DrainManager;
  syncNow: () => void;
}

/** The mirror's job rows for the push handler's before/after diff (T2.6).
 * SQL stays on this side of the seam — the handler composes
 * notifications, it does not know the mirror's schema. */
function readJobRows(mirror: Mirror): PushJobRow[] {
  return mirror.database
    .getAllSync<Record<string, unknown>>(
      'SELECT id, job_number, title, status, priority, scheduled_for, contact_name, version FROM jobs',
    )
    .map((row) => ({
      id: String(row.id),
      jobNumber: String(row.job_number),
      title: String(row.title),
      status: String(row.status),
      priority: String(row.priority),
      scheduledFor: row.scheduled_for === null || row.scheduled_for === undefined ? null : String(row.scheduled_for),
      contactName: row.contact_name === null || row.contact_name === undefined ? null : String(row.contact_name),
      version: Number(row.version),
    }));
}

export function MirrorProvider({ children, send, triggers }: MirrorProviderProps): ReactNode {
  const actor = useSessionStore((s) => s.actor);
  // The session key. Both values change together (they read the same store
  // row); the effect keys on the pair so a user switch rebuilds and a
  // token rotation — which touches neither — does not.
  const mirrorRole = actor !== null && roleHasMirror(actor.role) ? actor.role : null;
  const employeeId = actor !== null && mirrorRole !== null ? actor.id : null;

  const [session, setSession] = useState<OpenSession | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [revision, setRevision] = useState(0);
  // The mirror opened for the CURRENT employee. Cleared the moment the
  // session ends or switches — never on unmount (an app close must leave
  // the working set for the next cold start, §5.1's whole premise).
  const activeMirrorRef = useRef<Mirror | null>(null);
  // The live session's trigger subscriptions. Stopped on switch AND on
  // unmount — a manager that kept its 60-second timer after logout would
  // keep draining a session that no longer exists.
  const stopTriggersRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Switch (React runs the previous effect's cleanup first) and unmount:
    // stop the previous session's triggers either way.
    stopTriggersRef.current?.();
    stopTriggersRef.current = null;
    // A push arriving between sessions must not drive a sync for a mirror
    // that no longer exists (T2.6): the handler degrades to no
    // notification and the next foreground recovers.
    setPushSyncExecutor(null);

    // Session ended or switched employees: clear the previous working set
    // (mirror lifetime is "until logout", §4). The outbox survives —
    // filtered by employee_id, never wiped (T1.14).
    const previous = activeMirrorRef.current;
    if (previous !== null) {
      activeMirrorRef.current = null;
      try {
        clearMirror(previous);
      } catch {
        // A clearing failure must not take down the new session's start.
      }
    }
    setSession(null);
    setPendingCount(0);

    if (mirrorRole === null || employeeId === null) return;

    let alive = true;
    let bootstrapInFlight = false;

    const refreshCounts = (mirror: Mirror): void => {
      if (!alive) return;
      setPendingCount(pendingSyncCount(mirror.database, employeeId));
      setRevision((r) => r + 1);
    };

    // One sync cycle: bootstrap the fresh mirror (cursor null) if the
    // network allows, then the drain's own two passes + delta. Offline,
    // both are status-0 no-ops that the next trigger retries — neither
    // is ever awaited by a render (§5.1).
    const syncCycle = async (mirror: Mirror, drain: DrainManager): Promise<void> => {
      if (bootstrapInFlight) return;
      bootstrapInFlight = true;
      try {
        if (readCursor(mirror) === null) {
          const res = await send<SyncBootstrapResponse>('GET', '/v1/sync/bootstrap');
          if (res.ok && res.data !== null) applyBootstrap(mirror, res.data);
        }
        await drain.drainNow();
      } catch {
        // A cycle that throws must not kill the triggers; the next one retries.
      } finally {
        bootstrapInFlight = false;
        refreshCounts(mirror);
      }
    };

    void (async () => {
      let mirror: Mirror;
      try {
        mirror = await openMirror(mirrorRole);
      } catch {
        return; // storage failure: screens render their empty states, no crash
      }
      if (!alive) return; // the session ended while the open was in flight

      const drain = createDrainManager({
        mirror,
        send,
        employeeId,
        onEvent: (event) => {
          if (event.type === 'auth-lost') {
            // A COMPLETED refresh refusal — the one logout that is not a
            // network failure (§5.1). The API client already cleared the
            // credential store; this moves the UI to the login screen.
            useSessionStore.getState().setAnonymous();
          }
        },
      });
      const stopTriggers = drain.start(triggers);
      stopTriggersRef.current = stopTriggers;

      activeMirrorRef.current = mirror;
      // The push handler's sync seam (T2.6): for the lifetime of this
      // employee session, a data-only FCM wake runs THIS cycle — the
      // same bootstrap-or-drain cycle every other trigger runs — through
      // the drain's own single-flight, and diffs the mirror's job rows
      // around it to raise local notifications from what arrived.
      setPushSyncExecutor({
        sync: () => syncCycle(mirror, drain),
        readJobs: () => readJobRows(mirror),
      });
      setSession({
        mirror,
        employeeId,
        drain,
        syncNow: () => void syncCycle(mirror, drain),
      });
      refreshCounts(mirror);
      // Launch fires one cycle (the foreground trigger only fires on
      // CHANGE, so a cold start would otherwise wait 60 seconds for the
      // timer). Fire-and-forget: offline it fails into backoff and the
      // session stands.
      void syncCycle(mirror, drain);
    })();

    return () => {
      alive = false;
      // Unmount: stop the triggers. The mirror is deliberately NOT
      // cleared here — an app close leaves the working set for the next
      // cold start (clearing happens at the START of the next effect,
      // which only runs when the session actually changed).
      stopTriggersRef.current?.();
      stopTriggersRef.current = null;
    };
    // `send`/`triggers` are stable app singletons; the session key is the
    // employee id pair alone.
  }, [mirrorRole, employeeId, send, triggers]);

  const value = useMemo<MirrorSession | null>(
    () => (session === null ? null : { ...session, pendingCount, revision }),
    [session, pendingCount, revision],
  );

  return <MirrorSessionContext.Provider value={value}>{children}</MirrorSessionContext.Provider>;
}
