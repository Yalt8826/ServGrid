/**
 * The record seam's idempotency discipline (the duplicate-charge hole the
 * device smoke found: three taps of one enabled button minted three PM
 * numbers, because the key was fresh per request). The key is the
 * collection INTENT — the open sheet — so re-presses while a POST is in
 * flight carry the SAME key and the server's idempotency replay collapses
 * them into one payment. A failure keeps the key (an ambiguous timeout
 * must replay, not re-charge; the plugin frees a failed claim so an
 * edited retry still executes); a success clears it — the next sheet is
 * a new intent.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import { create } from 'react-test-renderer';

const { request, uuid } = vi.hoisted(() => ({
  request: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ api: { request } }));
vi.mock('../../lib/uuid', () => ({ uuid }));
// The hook module imports expo-network for the rep's online gate; the
// node test environment has no ExpoGlobal behind it, and this test never
// exercises the gate.
vi.mock('expo-network', () => ({
  getNetworkStateAsync: vi.fn(async () => ({ isInternetReachable: true })),
}));
vi.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: vi.fn(async () => 'ZmFrZWJhc2U2NA=='),
  EncodingType: { Base64: 'base64' },
}));
vi.mock('expo-crypto', () => ({
  CryptoEncoding: { SHA256: 'SHA256', HEX: 'hex' },
  digestStringAsync: vi.fn(async () => 'aa'.repeat(32)),
  getRandomBytesAsync: vi.fn(async () => new Uint8Array(16).fill(1)),
}));

import { useRecordPayment } from './useRepData';
import type { RecordPaymentInput } from './PaymentsScreen';

const INPUT: RecordPaymentInput = {
  companyId: 'c1000000-0000-4000-8000-000000000001',
  amount: '3000',
  salesCardId: null,
  mode: 'cash',
  referenceNo: null,
  proofPhotoUri: null,
};

let current: ReturnType<typeof useRecordPayment>;

function Probe(): null {
  current = useRecordPayment();
  return null;
}

function keyOf(call: number): string | undefined {
  const opts = request.mock.calls[call]?.[2] as { idempotencyKey?: string } | undefined;
  return opts?.idempotencyKey;
}

describe('useRecordPayment — the idempotency intent pin', () => {
  it('re-presses while the first POST is in flight carry the SAME key; success mints a fresh one', async () => {
    let release: (value: { ok: boolean; data: unknown }) => void = () => {};
    request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    uuid.mockImplementation(async () => `intent-key-${uuid.mock.calls.length}`);

    await act(async () => {
      create(<Probe />);
    });

    let first!: Promise<void>;
    await act(async () => {
      first = current.record(INPUT).catch(() => {});
    });
    await act(async () => {
      await current.record(INPUT).catch(() => {});
    });
    expect(keyOf(0)).toBe(keyOf(1));

    await act(async () => {
      release({ ok: true, data: { id: 'p1000000-0000-4000-8000-000000000001' } });
      await first;
    });

    // The sheet closed on success; the next collection is a new intent.
    request.mockResolvedValue({ ok: true, data: { id: 'p1000000-0000-4000-8000-000000000002' } });
    await act(async () => {
      await current.record(INPUT);
    });
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('a failed record keeps the key — the retry replays instead of re-charging', async () => {
    request
      .mockResolvedValueOnce({ ok: false, data: null, error: { message: 'The network dropped.' } })
      .mockResolvedValueOnce({ ok: true, data: { id: 'p1000000-0000-4000-8000-000000000003' } });

    await act(async () => {
      create(<Probe />);
    });
    await act(async () => {
      await current.record(INPUT).catch(() => {});
    });
    expect(keyOf(0)).toBeDefined();
    await act(async () => {
      await current.record(INPUT).catch(() => {});
    });
    expect(keyOf(1)).toBe(keyOf(0));
  });
});
