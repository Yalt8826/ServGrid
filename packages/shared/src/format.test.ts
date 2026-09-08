/**
 * en-IN money formatting tests (T0.12; FOUNDATIONS §6 + the MoneyField
 * contract in 03-COMPONENTS.md): `100000` groups as `1,00,000` on blur,
 * grouping is stripped while typing, 2dp only when non-zero paise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatMoneyEnIN, groupEnIN, stripToNumeric } from './format.ts';

describe('groupEnIN — Indian digit grouping', () => {
  it('groups 100000 as 1,00,000', () => {
    assert.equal(groupEnIN('100000'), '1,00,000');
  });
  it('groups 10000000 as 1,00,00,000', () => {
    assert.equal(groupEnIN('10000000'), '1,00,00,000');
  });
  it('leaves short numbers ungrouped', () => {
    assert.equal(groupEnIN('42'), '42');
    assert.equal(groupEnIN('100'), '100');
    assert.equal(groupEnIN('1000'), '1,000');
  });
  it('normalises pre-grouped input', () => {
    assert.equal(groupEnIN('1,00,000'), '1,00,000');
  });
});

describe('formatMoneyEnIN — money, 2dp only when non-zero paise', () => {
  it('formats whole rupees without paise', () => {
    assert.equal(formatMoneyEnIN('4250'), '4,250');
    assert.equal(formatMoneyEnIN('100000'), '1,00,000');
  });
  it('keeps non-zero paise at 2dp', () => {
    assert.equal(formatMoneyEnIN('4250.5'), '4,250.50');
    assert.equal(formatMoneyEnIN('4250.25'), '4,250.25');
  });
  it('drops zero paise', () => {
    assert.equal(formatMoneyEnIN('4250.00'), '4,250');
  });
  it('handles partial input', () => {
    assert.equal(formatMoneyEnIN(''), '0');
    assert.equal(formatMoneyEnIN('.'), '0');
    assert.equal(formatMoneyEnIN('0.5'), '0.50');
  });
});

describe('stripToNumeric — the typing transform', () => {
  it('strips grouping while typing', () => {
    assert.equal(stripToNumeric('1,00,000'), '100000');
  });
  it('keeps digits and the first dot only', () => {
    assert.equal(stripToNumeric('42a5.0.5x'), '425.05');
  });
});
