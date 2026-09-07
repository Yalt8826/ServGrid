/**
 * Session state (PLAN-FRONTEND.md §4, layer 1). Holds what the UI needs
 * between cold start and logout: whether a stored session existed, and
 * who it belongs to. The tokens themselves never live here — they stay
 * in the platform token store behind the API client.
 */
import { create } from 'zustand';
import type { StoredActor } from '../lib/types';

export type SessionStatus =
  | 'boot' // cold start: the local store has not been read yet
  | 'anonymous' // no stored session — the login screen is the landing route
  | 'authenticated'; // stored session found; the role's landing route renders

interface SessionState {
  status: SessionStatus;
  actor: StoredActor | null;
  setAuthenticated: (actor: StoredActor) => void;
  setAnonymous: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'boot',
  actor: null,
  setAuthenticated: (actor) => set({ status: 'authenticated', actor }),
  setAnonymous: () => set({ status: 'anonymous', actor: null }),
}));
