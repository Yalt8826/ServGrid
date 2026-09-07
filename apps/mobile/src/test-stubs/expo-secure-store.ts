// Vitest seam: a real, observable SecureStore stand-in. Entries can be
// poisoned mid-test (deleteItemAsync only flagged) to prove that the
// clear-then-fail path rethrows, exactly as a lost keystore would.
const poisoned = new Set<string>();
const map = new Map<string, string>();

type Options = Record<string, unknown> | undefined;

export function getItemAsync(key: string, _options?: Options): Promise<string | null> {
  return Promise.resolve(map.get(key) ?? null);
}

export function setItemAsync(key: string, value: string, _options?: Options): Promise<void> {
  map.set(key, value);
  poisoned.delete(key);
  return Promise.resolve();
}

export function deleteItemAsync(key: string, _options?: Options): Promise<void> {
  if (poisoned.has(key)) {
    // Degenerate device: the entry survives and the call rejects.
    return Promise.reject(new Error('SecureStore: keystore write failed'));
  }
  map.delete(key);
  return Promise.resolve();
}

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 2;

/** Test helper: the next delete of `key` fails without clearing the entry. */
export function __poisonNextDelete(key: string): void {
  poisoned.add(key);
}

/** Test helper: reset the store between tests. */
export function __reset(): void {
  map.clear();
  poisoned.clear();
}
