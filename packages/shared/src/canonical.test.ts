/**
 * Canonicalisation tests (T0.5): key order must not change the output,
 * nesting must be stable, and the sha256 of a fixed object must match a
 * checked-in fixture — the same value the client (Node) and the server
 * must produce, byte for byte (PLAN-BACKEND.md §3.2).
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, CanonicalJsonError } from './canonical.ts';

/** Checked-in fixture — the sha256 the client (Node) and the server must
 *  both produce for this object; recomputed only with a deliberate spec
 *  change. The input object is printed in the failure message so a drift
 *  is auditable by hand. */
const FIXTURE_OBJECT = {
  op: 'complete',
  jobId: '9f1c3b2a-1111-4e5a-8b2c-3d4e5f6a7b8c',
  amountCollected: '1250.50',
  cost: '4800',
  parts: [{ lineNo: 2, name: 'battery', qty: 1 }, { lineNo: 1, name: 'fuse', qty: 3 }],
  meta: { source: 'mobile', retry: false, nested: { z: 1, a: 2 } },
  note: null,
} as const;

/** sha256 of canonicalJson(FIXTURE_OBJECT) — pinned. */
const FIXTURE_SHA256 = '522fc223f3d1fb0931226e30f8ee2f6c2dace3686e200c1d78644be417d51ff9';

const fixtureJson = JSON.stringify(FIXTURE_OBJECT);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('canonicalJson (PLAN-BACKEND.md §3.2)', () => {
  it('key order in the input does not change the output', () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1}');
  });

  it('nested objects and arrays are stable', () => {
    const a = canonicalJson(FIXTURE_OBJECT);
    const reordered = canonicalJson({
      note: null,
      meta: { nested: { a: 2, z: 1 }, retry: false, source: 'mobile' },
      parts: [{ lineNo: 2, name: 'battery', qty: 1 }, { lineNo: 1, name: 'fuse', qty: 3 }],
      cost: '4800',
      amountCollected: '1250.50',
      jobId: '9f1c3b2a-1111-4e5a-8b2c-3d4e5f6a7b8c',
      op: 'complete',
    });
    assert.equal(a, reordered);
    assert.ok(a.startsWith('{"amountCollected":"1250.50"'));
    // Array order preserved (an array is a value, not a map); object keys
    // sorted at every depth.
    assert.ok(a.includes('[{"lineNo":2,"name":"battery","qty":1},{"lineNo":1,"name":"fuse","qty":3}]'));
    assert.ok(a.includes('"nested":{"a":2,"z":1}'));
  });

  it('produces no whitespace and sorts keys by code unit', () => {
    assert.equal(canonicalJson({ x: [1, { two: 2, one: 1 }], a: 'str' }), '{"a":"str","x":[1,{"one":1,"two":2}]}');
  });

  it('numbers take their shortest round-trip form', () => {
    assert.equal(canonicalJson({ a: 1.0 }), '{"a":1}');
    assert.equal(canonicalJson({ a: 1e21 }), '{"a":1e+21}');
    assert.equal(canonicalJson({ a: 123456789012345680000 }), '{"a":123456789012345680000}');
    assert.equal(canonicalJson({ a: -0 }), '{"a":0}'); // -0 must not hash differently from 0
    assert.equal(canonicalJson({ a: 0.1 + 0.2 }), '{"a":0.30000000000000004}');
  });

  it('undefined properties are dropped, null is kept', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson({ a: null }), '{"a":null}');
  });

  it('throws on undefined inside an array and on non-finite numbers — no silent NaN', () => {
    assert.throws(() => canonicalJson({ a: [undefined] }), CanonicalJsonError);
    assert.throws(() => canonicalJson({ a: NaN }), CanonicalJsonError);
    assert.throws(() => canonicalJson({ a: Infinity }), CanonicalJsonError);
  });

  it('same object serialised here matches the checked-in fixture sha256', () => {
    const canonical = canonicalJson(FIXTURE_OBJECT);
    const hash = sha256(canonical);
    assert.equal(
      hash,
      FIXTURE_SHA256,
      `canonical bytes drifted. canonical=${canonical} input=${fixtureJson}`,
    );
  });

  it('run-to-run determinism over 200 iterations', () => {
    const first = sha256(canonicalJson(FIXTURE_OBJECT));
    for (let i = 0; i < 200; i++) {
      assert.equal(sha256(canonicalJson(FIXTURE_OBJECT)), first);
    }
  });
});
