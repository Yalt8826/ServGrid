/**
 * One submit intent, one idempotency key (PLAN-FRONTEND.md §5,
 * implementation README §9 rule 4). The app is online-only, so a write is
 * a direct call — and the one thing that makes a retry safe is the server's
 * idempotency guard seeing the SAME key for the same intent.
 *
 * The key is minted on the first attempt and kept:
 *
 * - **until the server accepts** — cleared, so the next intent is new;
 * - **across an ambiguous failure** — no response, or a 5xx: the request
 *   may have landed, and the retry must replay it, not repeat it;
 * - **but not across a definite refusal** (a 4xx the server answered):
 *   nothing was saved, so the next attempt — perhaps with an edited form —
 *   is a new intent with a new key.
 *
 * The caller owns the body: a retry under the same key must carry the same
 * body, or the server refuses it (422 — same key, different request).
 */
import type { ApiResult } from './apiClient';
import { uuid } from './uuid';

/** What a network failure says — never a spinner, never a guess about whether it saved. */
export const NOT_REACHED_MESSAGE = "Couldn't reach the server — nothing was saved yet. Try again.";

/** The sentence when the server refused without one of its own. */
const REFUSED_MESSAGE = 'The office could not accept this. Try again.';

export type IntentRequest = (
  method: 'POST' | 'PATCH',
  path: string,
  options: { body?: unknown; idempotencyKey?: string },
) => Promise<ApiResult<unknown>>;

/** A write that did not go through, carrying the sentence to show. */
export class WriteNotSaved extends Error {
  constructor(
    message: string,
    /** 0 when the server was never reached. */
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'WriteNotSaved';
  }
}

export interface IntentWriter {
  /** Send the intent; resolves with the server's body, rejects with `WriteNotSaved`. */
  send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<unknown>;
  /** The key the next attempt will carry, or null when none is pinned (test seam). */
  pendingKey(): string | null;
}

export function createIntentWriter(request: IntentRequest): IntentWriter {
  let key: string | null = null;
  return {
    async send(method, path, body) {
      key ??= await uuid();
      const res = await request(method, path, { body, idempotencyKey: key });
      if (res.ok) {
        key = null;
        return res.data;
      }
      if (res.status === 0 || res.status >= 500 || res.error?.code === 'NETWORK') {
        throw new WriteNotSaved(res.status === 0 || res.error?.code === 'NETWORK' ? NOT_REACHED_MESSAGE : REFUSED_MESSAGE, res.status, res.error?.code ?? null);
      }
      key = null;
      throw new WriteNotSaved(res.error?.message ?? REFUSED_MESSAGE, res.status, res.error?.code ?? null);
    },
    pendingKey: () => key,
  };
}

/** The sentence for any thrown write failure. */
export function messageOfWriteError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : NOT_REACHED_MESSAGE;
}
