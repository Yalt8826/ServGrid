/**
 * Canonical JSON (PLAN-BACKEND.md §3.2): the client and the server must
 * agree on `request_hash` byte for byte, so this lives in packages/shared.
 *
 * sha256(canonicalJson(body)) is the `idempotency_keys.request_hash` that
 * turns a same-key-different-body replay into `422 IDEMPOTENCY_KEY_REUSED`.
 *
 * Rules: object keys sorted (code-unit order), no whitespace, numbers in
 * their shortest round-trip form, strings/booleans/null as JSON. Array
 * order is preserved — an array is a value, not a map. `undefined`
 * properties are dropped, exactly as they are from JSON.stringify input.
 */

export class CanonicalJsonError extends TypeError {}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(
      `cannot canonicalise non-finite number: ${value} (JSON has no representation)`,
    );
  }
  if (value === 0) return '0'; // collapses -0, which would otherwise hash differently
  return String(value); // ECMAScript Number::toString is the shortest round-trip form
}

function canonicalise(value: unknown, depth: number, inArray: boolean): string {
  if (depth > 512) {
    throw new CanonicalJsonError('input is nested deeper than 512 levels');
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value);
    case 'bigint':
      return value.toString();
    case 'undefined':
      if (inArray) {
        throw new CanonicalJsonError('undefined inside an array has no JSON representation');
      }
      return undefined as unknown as string; // dropped property — caller skips the entry
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalise(item, depth + 1, true));
        return `[${items.join(',')}]`;
      }
      if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const body = entries
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v, depth + 1, false)}`)
        .join(',');
      return `{${body}}`;
    }
    default:
      throw new CanonicalJsonError(
        `cannot canonicalise value of type ${typeof value} (functions, symbols)`,
      );
  }
}

/**
 * Serialise `value` with sorted keys, no whitespace and shortest-form
 * numbers. Deterministic across runtimes — the fixture hash in
 * `canonical.test.ts` pins Node and Hermes to the same bytes.
 */
export function canonicalJson(value: unknown): string {
  const out = canonicalise(value, 0, false);
  if (out === undefined) {
    throw new CanonicalJsonError('cannot canonicalise a top-level undefined');
  }
  return out;
}
