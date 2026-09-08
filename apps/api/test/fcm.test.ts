import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

/**
 * Unit suite for the data-only FCM client (T0.15, PLAN-BACKEND.md
 * §12.1). The wire is module-mocked — the real send is exercised on
 * hardware in the T0.15 probe (runbook, step 6); what must be proven
 * here is the contract: data-only payload (no `notification` key, no
 * job content), permanent-vs-transient classification, `unregistered`
 * surfacing for the stale-token path (§8/§12.1), and no retry storms.
 *
 * The service account carries a real throwaway RSA key (generated
 * below) so the RS256 JWT signing path runs for real; `fetch` is
 * stubbed at the OAuth boundary, so no network call ever leaves the
 * suite and every flow scripts the token exchange first.
 */
import {
  __resetFcmForTests,
  initFcm,
  parseServiceAccount,
  sendDataOnly,
  type FcmSendResult,
} from '../src/lib/fcm.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const SERVICE_ACCOUNT = {
  project_id: 'servgrid-probe',
  client_email: 'firebase-adminsdk-abc123@servgrid-probe.iam.gserviceaccount.com',
  private_key: PRIVATE_KEY_PEM,
};

const realFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function errResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}
function oauthResponse(): Response {
  return okResponse({ access_token: 'test-access-token', expires_in: 3600 });
}

/** Queue [oauth, ...rest]; send-flows get the exchange scripted first. */
function script(responses: Response[]): void {
  fetchMock.mockReset();
  for (const res of [oauthResponse(), ...responses]) fetchMock.mockResolvedValueOnce(res);
}

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('fetch was never called');
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  initFcm(JSON.stringify(SERVICE_ACCOUNT));
  __resetFcmForTests();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('parseServiceAccount — fails with the field named, at boot', () => {
  it('accepts inline JSON and a file path', async () => {
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fcm-sa-'));
    const path = join(dir, 'sa.json');
    await writeFile(path, JSON.stringify(SERVICE_ACCOUNT));
    expect(parseServiceAccount(path)).toEqual(SERVICE_ACCOUNT);
    expect(await readFile(path, 'utf8')).toContain('servgrid-probe');
    expect(parseServiceAccount(JSON.stringify(SERVICE_ACCOUNT))).toEqual(SERVICE_ACCOUNT);
  });

  it('names the missing field', () => {
    const partial = { project_id: SERVICE_ACCOUNT.project_id, client_email: SERVICE_ACCOUNT.client_email };
    expect(() => parseServiceAccount(JSON.stringify(partial))).toThrow(/private_key/);
  });

  it('rejects non-JSON', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'fcm-sa-'));
    const path = join(dir, 'garbage.json');
    await writeFile(path, 'not json at all');
    expect(() => parseServiceAccount(path)).toThrow(/not valid service-account JSON/);
  });
});

describe('sendDataOnly — the §12.1 data-only contract', () => {
  it('sends token + data only: no notification key, no android.notification', async () => {
    script([okResponse({ name: 'projects/x/messages/1' })]);
    const res = await sendDataOnly({ token: 'tok-1', data: { type: 'data-only-sync' } });
    expect(res.ok).toBe(true);
    const body = lastBody();
    const message = body['message'] as Record<string, unknown>;
    expect(message['token']).toBe('tok-1');
    expect(message['data']).toEqual({ type: 'data-only-sync' });
    expect(JSON.stringify(body)).not.toContain('notification');
  });

  it('sends the OAuth bearer token FCM v1 requires', async () => {
    script([okResponse({ name: 'projects/x/messages/1b' })]);
    await sendDataOnly({ token: 'tok-1b' });
    const call = fetchMock.mock.calls.at(-1);
    const auth = (call?.[1]?.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe('Bearer test-access-token');
  });

  it('data values must be strings — FCM v1 rejects maps', async () => {
    script([okResponse({ name: 'projects/x/messages/2' })]);
    await sendDataOnly({ token: 'tok-2', data: { jobId: '123' } });
    expect((lastBody()['message'] as Record<string, unknown>)['data']).toEqual({ jobId: '123' });
  });

  it('surfaces `unregistered` for a stale token — the §12.1 clear-token signal', async () => {
    script([errResponse(404, 'Requested entity was not found.')]);
    const res = await sendDataOnly({ token: 'stale' });
    expect(res).toEqual({
      ok: false,
      permanent: true,
      unregistered: true,
      httpStatus: 404,
      error: 'Requested entity was not found.',
    } satisfies FcmSendResult);
    expect(fetchMock).toHaveBeenCalledTimes(2); // oauth + one send, never retried
  });

  it('429/5xx are transient: retried, then reported', async () => {
    script([
      errResponse(500, 'Internal failure.'),
      errResponse(500, 'Internal failure.'),
      okResponse({ name: 'projects/x/messages/3' }),
    ]);
    const res = await sendDataOnly({ token: 'tok-3' });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4); // oauth + three attempts
  });

  it('permanent failures are never retried', async () => {
    script([errResponse(400, 'Invalid data payload')]);
    const res = await sendDataOnly({ token: 'bad' });
    expect(res.permanent).toBe(true);
    expect(res.unregistered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // oauth + one send
  });

  it('a malformed token also counts as unregistered — clear the device row', async () => {
    script([errResponse(400, 'Invalid registration token')]);
    const res = await sendDataOnly({ token: 'garbage' });
    expect(res.permanent).toBe(true);
    expect(res.unregistered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network errors are transient by definition (correct with every push dropped)', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(oauthResponse());
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    const res = await sendDataOnly({ token: 'tok-4' });
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(false);
    expect(res.httpStatus).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // oauth + three attempts
  });

  it('unconfigured is a boot bug: throws FcmNotConfiguredError', async () => {
    vi.resetModules();
    const fresh = (await import('../src/lib/fcm.js')) as typeof import('../src/lib/fcm.js');
    // Message-based: resetModules creates a second module instance whose
    // error class is not identical to the one imported at the top.
    await expect(fresh.sendDataOnly({ token: 'x' })).rejects.toThrow(/FCM is not configured/);
  });
});
