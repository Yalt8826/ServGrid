/**
 * Test seam for `@react-native-async-storage/async-storage` — an
 * in-memory map; nothing under `src/components/ui` persists, but the
 * stub keeps any accidental import harmless under vitest.
 */
const memory = new Map<string, string>();

export default {
  async getItem(key: string): Promise<string | null> {
    return memory.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    memory.set(key, String(value));
  },
  async removeItem(key: string): Promise<void> {
    memory.delete(key);
  },
  async clear(): Promise<void> {
    memory.clear();
  },
};
