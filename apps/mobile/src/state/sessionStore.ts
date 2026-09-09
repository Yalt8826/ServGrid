/**
 * Session state (PLAN-FRONTEND.md §4, layer 1). Holds what the UI needs
 * between cold start and logout: whether a stored session existed, and
 * who it belongs to. The tokens themselves never live here — they stay
 * in the platform token store behind the API client.
 *
 * Two auth-flow extras ride along, both memory-only, both set by a fresh
 * login and cleared on logout (T0.14):
 * - `consent` — the consent state the login response carried, so the
 *   forced-change screen can route on to consent when both are owed.
 * - `tempPassword` — the password just used, when `mustChangePassword`
 *   forces a change now: §X2's form asks for new + confirm only, and the
 *   server still requires the current one (`POST /v1/auth/password`).
 *   It exists for the seconds between login and the change, never
 *   persists, and is dropped once the change succeeds.
 */
import { create } from 'zustand';
import type { LoginConsentState } from '../lib/apiClient';
import type { StoredActor } from '../lib/types';

export type SessionStatus =
  | 'boot' // cold start: the local store has not been read yet
  | 'anonymous' // no stored session — the login screen is the landing route
  | 'authenticated'; // stored session found; the role's landing route renders

export interface AuthFlowState {
  consent: LoginConsentState | null;
  tempPassword: string | null;
}

interface SessionState extends AuthFlowState {
  status: SessionStatus;
  actor: StoredActor | null;
  setAuthenticated: (actor: StoredActor, flow?: AuthFlowState) => void;
  setAnonymous: () => void;
  /** The forced-change screen consumed the temp password. */
  clearTempPassword: () => void;
}

const NO_FLOW: AuthFlowState = { consent: null, tempPassword: null };

export const useSessionStore = create<SessionState>((set) => ({
  status: 'boot',
  actor: null,
  ...NO_FLOW,
  setAuthenticated: (actor, flow) => set({ status: 'authenticated', actor, ...NO_FLOW, ...flow }),
  setAnonymous: () => set({ status: 'anonymous', actor: null, ...NO_FLOW }),
  clearTempPassword: () => set({ tempPassword: null }),
}));
