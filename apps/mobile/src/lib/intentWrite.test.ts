/**
 * One intent, one key (PLAN-FRONTEND.md §5). The easiest mistake in this
 * codebase is a fresh key per request: three taps on a frozen frame became
 * three payments on a handset in Phase 3. These pin the rule the online
 * writes now depend on.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ApiResult } from './apiClient';
import { NOT_REACHED_MESSAGE, WriteNotSaved, createIntentWriter, type IntentRequest } from './intentWrite';

const OK: ApiResult<unknown> = { ok: true, status: 200, data: { id: 'j1' }, error: null };
const NETWORK: ApiResult<unknown> = { ok: false, status: 0, data: null, error: { code: 'NETWORK' as never, message: 'Network request failed', requestId: '' } };
const SERVER_ERROR: ApiResult<unknown> = { ok: false, status: 503, data: null, error: { code: 'INTERNAL' as never, message: 'down', requestId: 'r' } };
const CLOSED: ApiResult<unknown> = {
  ok: false,
  status: 409,
  data: null,
  error: { code: 'JOB_ALREADY_CLOSED' as never, message: 'This job was cancelled by the office at 14:32.', requestId: 'r' },
};

function requestReturning(...results: ApiResult<unknown>[]) {
  const request = vi.fn<IntentRequest>(async () => results.shift() ?? OK);
  return request;
}

function keyOf(request: ReturnType<typeof requestReturning>, call: number): string | undefined {
  return request.mock.calls[call]?.[2].idempotencyKey;
}

describe('createIntentWriter', () => {
  it('sends with a key, returns the body, and forgets the key once accepted', async () => {
    const request = requestReturning(OK);
    const writer = createIntentWriter(request);
    await expect(writer.send('POST', '/v1/jobs/j1/complete', { workSummary: 'done' })).resolves.toEqual({ id: 'j1' });
    expect(keyOf(request, 0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(writer.pendingKey()).toBeNull();
  });

  it('a network failure keeps the key: the retry carries the SAME one, so a request that landed replays', async () => {
    const request = requestReturning(NETWORK, OK);
    const writer = createIntentWriter(request);
    await expect(writer.send('POST', '/v1/payments', { amount: '1200.00' })).rejects.toThrow(NOT_REACHED_MESSAGE);
    expect(writer.pendingKey()).toBe(keyOf(request, 0));
    await writer.send('POST', '/v1/payments', { amount: '1200.00' });
    expect(keyOf(request, 1)).toBe(keyOf(request, 0));
    expect(writer.pendingKey()).toBeNull();
  });

  it('a 5xx keeps the key too — the server may have saved it before failing', async () => {
    const request = requestReturning(SERVER_ERROR, OK);
    const writer = createIntentWriter(request);
    await expect(writer.send('POST', '/v1/sales', {})).rejects.toBeInstanceOf(WriteNotSaved);
    await writer.send('POST', '/v1/sales', {});
    expect(keyOf(request, 1)).toBe(keyOf(request, 0));
  });

  it('a definite refusal shows the server’s sentence, and the next attempt is a new intent', async () => {
    const request = requestReturning(CLOSED, OK);
    const writer = createIntentWriter(request);
    const refusal = await writer.send('POST', '/v1/jobs/j1/complete', {}).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(WriteNotSaved);
    expect((refusal as WriteNotSaved).message).toBe('This job was cancelled by the office at 14:32.');
    expect((refusal as WriteNotSaved).code).toBe('JOB_ALREADY_CLOSED');
    expect(writer.pendingKey()).toBeNull();
    await writer.send('POST', '/v1/jobs/j1/complete', {});
    expect(keyOf(request, 1)).not.toBe(keyOf(request, 0));
  });
});
