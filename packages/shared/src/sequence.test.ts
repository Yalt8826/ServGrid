/**
 * Number format tests (T0.5) — the `JC-2627-00042` shape from
 * PLAN-DATA-MODEL.md §3.9, and the draft-carries-no-number rule from §3.5.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatBusinessNumber,
  formatFiscalYear,
  parseBusinessNumber,
  prefixForScope,
} from './sequence.ts';

describe('business number format', () => {
  it('formats the canonical shape JC-2627-00042 (five-digit pad, per the doc example)', () => {
    assert.equal(formatBusinessNumber('job', 26, 42), 'JC-2627-00042');
    assert.equal(formatBusinessNumber('sale', 26, 1), 'SL-2627-00001');
    assert.equal(formatBusinessNumber('payment', 26, 12345), 'PM-2627-12345');
    assert.equal(formatBusinessNumber('contract', 27, 0), 'AMC-2728-00000');
  });

  it('pads to five digits and leaves larger values alone', () => {
    assert.equal(formatBusinessNumber('job', 26, 7), 'JC-2627-00007');
    assert.equal(formatBusinessNumber('job', 26, 999999), 'JC-2627-999999');
  });

  it('prefixForScope matches the sequences scope keys', () => {
    assert.equal(prefixForScope('job'), 'JC');
    assert.equal(prefixForScope('sale'), 'SL');
    assert.equal(prefixForScope('payment'), 'PM');
    assert.equal(prefixForScope('contract'), 'AMC');
  });

  it('parses what it formats', () => {
    const parsed = parseBusinessNumber('JC-2627-00042');
    assert.deepEqual(parsed, { prefix: 'JC', fiscalYear: 26, value: 42 });
    assert.equal(parseBusinessNumber(formatBusinessNumber('payment', 27, 999))?.prefix, 'PM');
  });

  it('drops the padding in the parsed value', () => {
    assert.equal(parseBusinessNumber('SL-2627-00001')?.value, 1);
  });

  it('null/undefined/empty parse to null — a draft has no number by design (§3.5)', () => {
    assert.equal(parseBusinessNumber(null), null);
    assert.equal(parseBusinessNumber(undefined), null);
    assert.equal(parseBusinessNumber(''), null);
  });

  it('rejects malformed strings and impossible fiscal pairs', () => {
    assert.equal(parseBusinessNumber('XC-2627-00042'), null);
    assert.equal(parseBusinessNumber('JC-2627-0042'), null); // numeric part must be ≥ 5 digits
    assert.equal(parseBusinessNumber('JC-2726-00042'), null); // fiscal years must run forwards
    assert.equal(parseBusinessNumber('JC-26-00042'), null);
    assert.equal(parseBusinessNumber('jc-2627-00042'), null); // prefixes are uppercase
    assert.equal(parseBusinessNumber('JC-2627-00042 '), null);
  });

  it('formatFiscalYear builds the concatenated short-year pair', () => {
    assert.equal(formatFiscalYear(26), '2627');
    assert.equal(formatFiscalYear(7), '0708'); // both halves two digits
    assert.equal(formatFiscalYear(99), '9900'); // wraps — modulo 100 on the end year
    assert.throws(() => formatFiscalYear(100));
    assert.throws(() => formatBusinessNumber('job', 26, -1));
    assert.throws(() => formatBusinessNumber('job', 26, 1.5));
  });
});
