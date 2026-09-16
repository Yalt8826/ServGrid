/**
 * The signed-in employee, once per process — `GET /v1/auth/me`.
 *
 * Three consumers want the same answer and used to ask for it
 * separately: the feature-flag cache (this read is where every flag comes
 * from), the profile screens' full name (the session store carries only a
 * username), and — since 2026-09-17 — the dashboard's welcome. One cache,
 * one request, one place the answer dies.
 *
 * The failure rule is the flag cache's own: a failed read leaves the
 * answer null and the screen degrades to what the session store has. It
 * never blocks a screen and never flips a live one dark.
 */
import { useEffect, useState } from 'react';

import { defaultFeatureFlags, type AuthMeResponse } from '@servgrid/shared';
import { api } from '../lib/api';
import { cachedAuthMe, setAuthMe } from './authMe';
import { cachedFeatureFlags, setFeatureFlags } from './featureFlags';
import { useSessionStore } from './sessionStore';

/** One in-flight request shared by every mounting consumer — the dashboard
 * mounts the flag reader and the name reader together. */
let inFlight: Promise<void> | null = null;

function loadOnce(): Promise<void> {
  if (inFlight !== null) return inFlight;
  inFlight = (async (): Promise<void> => {
    const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
    if (!res.ok || res.data === null) return;
    setAuthMe(res.data);
    setFeatureFlags({ ...defaultFeatureFlags(), ...res.data.featureFlags });
  })()
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export interface AuthMeState {
  /**
   * Whether an answer exists (cached, fetched, or fetched by any other
   * consumer). A FAILED read also resolves true, with `me` still null —
   * a screen waiting on this must not wait forever for a network that is
   * down; the next mount that needs it tries again.
   */
  ready: boolean;
  me: AuthMeResponse | null;
}

export function useAuthMe(): AuthMeState {
  const [me, setMe] = useState<AuthMeResponse | null>(cachedAuthMe());
  const [ready, setReady] = useState<boolean>(cachedAuthMe() !== null || cachedFeatureFlags() !== null);

  useEffect(() => {
    if (cachedAuthMe() !== null) {
      setMe(cachedAuthMe());
      setReady(true);
      return;
    }
    let alive = true;
    void loadOnce().then(() => {
      if (!alive) return;
      setMe(cachedAuthMe());
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, me };
}

/**
 * The employee's full name, degrading to the session's username until the
 * read lands — the resolve-into-state rule the profile screens already
 * used, now stated once.
 */
export function useFullName(): string {
  const actor = useSessionStore((s) => s.actor);
  const { me } = useAuthMe();
  // The cache can be warm before this hook's effect runs (an earlier
  // screen fetched it), so prefer the live answer over the state copy.
  return (me ?? cachedAuthMe())?.employee.fullName ?? actor?.username ?? '';
}
