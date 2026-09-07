/**
 * Contract tests for the platform-split token store (PHASE-0 spec,
 * T0.11). The native and web implementations are different files — the
 * point of this suite is that they are the SAME interface: every test
 * below runs against both.
 *
 * Vitest resolves `expo-secure-store` and `expo-crypto` to the stubs in
 * `src/test-stubs/` (vitest.config.ts), which mirror Metro's platform
 * seam: app code imports the bare name, the platform picks the file.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as SecureStoreStub from '../test-stubs/expo-secure-store';
import type { StoredSession, TokenStore } from './tokenStore';
import { parseStoredSession } from './tokenStore';
import { impl as nativeStore } from './tokenStore.impl.native';
import { impl as webStore } from './tokenStore.impl.web';

const SESSION_KEY = 'servgrid.session.v1';
const INSTALL_ID_KEY = 'servgrid.installId.v1';

const SESSION: StoredSession = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  actor: { id: '11111111-1111-4111-8111-111111111111', role: 'technician', username: 'ravi' },
};

/** Minimal localStorage stand-in for the node test environment. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return (Array.from(this.map.keys())[index] as string | undefined) ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

/** Wraps a storage whose next removeItem fails without removing — the
 * degenerate device case where clearing the credentials does not take. */
class FailingRemoveStorage {
  private inner = new MemoryStorage();
  private armed = false;
  get backing(): MemoryStorage {
    return this.inner;
  }
  failNextRemove(): void {
    this.armed = true;
  }
  get length(): number {
    return this.inner.length;
  }
  clear(): void {
    this.inner.clear();
  }
  getItem(key: string): string | null {
    return this.inner.getItem(key);
  }
  key(index: number): string | null {
    return this.inner.key(index);
  }
  removeItem(key: string): void {
    if (this.armed) {
      this.armed = false;
      throw new Error('localStorage write failed');
    }
    this.inner.removeItem(key);
  }
  setItem(key: string, value: string): void {
    this.inner.setItem(key, value);
  }
}

interface Harness {
  store: TokenStore;
  /** Plant raw junk under the session key, bypassing save(). */
  plantRaw(raw: string): Promise<void>;
  /** Make the NEXT clear() fail without removing the entry. */
  failNextClear(): void;
  reset(): void;
}

function nativeHarness(): Harness {
  return {
    store: nativeStore,
    async plantRaw(raw) {
      await SecureStoreStub.setItemAsync(SESSION_KEY, raw);
    },
    failNextClear() {
      SecureStoreStub.__poisonNextDelete(SESSION_KEY);
    },
    reset() {
      SecureStoreStub.__reset();
    },
  };
}

function webHarness(): Harness {
  let storage: FailingRemoveStorage | null = null;
  return {
    store: webStore,
    async plantRaw(raw) {
      (storage as FailingRemoveStorage).backing.setItem(SESSION_KEY, raw);
    },
    failNextClear() {
      (storage as FailingRemoveStorage).failNextRemove();
    },
    reset() {
      storage = new FailingRemoveStorage();
      globalThis.window = { localStorage: storage } as unknown as Window & typeof globalThis;
    },
  };
}

const harnesses: Array<[string, () => Harness]> = [
  ['native (expo-secure-store)', nativeHarness],
  ['web (localStorage)', webHarness],
];

describe.each(harnesses)('tokenStore contract — %s', (_name, makeHarness) => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    h.reset();
  });

  it('load() returns null when nothing is stored', async () => {
    await expect(h.store.load()).resolves.toBeNull();
  });

  it('save() then load() round-trips the session', async () => {
    await h.store.save(SESSION);
    await expect(h.store.load()).resolves.toEqual(SESSION);
  });

  it('save() replaces a previous session', async () => {
    await h.store.save(SESSION);
    const next: StoredSession = { ...SESSION, accessToken: 'at-2', refreshToken: 'rt-2' };
    await h.store.save(next);
    await expect(h.store.load()).resolves.toEqual(next);
  });

  it('load() returns null on corrupt JSON rather than throwing', async () => {
    await h.plantRaw('{{{ not json');
    await expect(h.store.load()).resolves.toBeNull();
  });

  it('load() returns null when the session fails validation', async () => {
    await h.plantRaw(JSON.stringify({ accessToken: 'x', refreshToken: '', actor: null }));
    await expect(h.store.load()).resolves.toBeNull();
  });

  it('clear() removes the session and is idempotent', async () => {
    await h.store.save(SESSION);
    await h.store.clear();
    await expect(h.store.load()).resolves.toBeNull();
    await expect(h.store.clear()).resolves.toBeUndefined();
  });

  it('a failed clear() rethrows and the stored session survives', async () => {
    // The load-bearing half of the contract: a caller that treats a
    // failed clear as a logout has logged a technician out of a session
    // the keystore still holds.
    await h.store.save(SESSION);
    h.failNextClear();
    await expect(h.store.clear()).rejects.toThrow();
    await expect(h.store.load()).resolves.toEqual(SESSION);
  });

  it('installId() is stable across calls and survives clear()', async () => {
    const first = await h.store.installId();
    const second = await h.store.installId();
    expect(second).toBe(first);
    await h.store.save(SESSION);
    await h.store.clear();
    await expect(h.store.installId()).resolves.toBe(first);
  });

  it('installId() is UUID-shaped', async () => {
    expect(await h.store.installId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('the install id key never collides with the session key', async () => {
    await h.store.save(SESSION);
    const installId = await h.store.installId();
    expect(installId).not.toBeNull();
    await expect(h.store.load()).resolves.toEqual(SESSION); // untouched
    expect(INSTALL_ID_KEY).not.toBe(SESSION_KEY);
  });
});

describe('parseStoredSession rejects malformed payloads', () => {
  it.each([
    ['not an object', 'null'],
    ['a string', '"x"'],
    ['missing refreshToken', JSON.stringify({ accessToken: 'a', actor: { id: '1', role: 'technician', username: 'u' } })],
    ['bad role', JSON.stringify({ accessToken: 'a', refreshToken: 'r', actor: { id: '1', role: 'admin', username: 'u' } })],
    ['missing actor', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })],
  ])('%s', (_label, raw) => {
    expect(parseStoredSession(JSON.parse(raw))).toBeNull();
  });
});
