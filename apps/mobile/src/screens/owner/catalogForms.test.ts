/**
 * Adding to the catalogue (OW.3). The rules worth pinning are the ones a
 * strict server schema makes unforgiving: an empty optional field must be
 * ABSENT from the payload, not an empty string, and a price typed as
 * words must be caught on this side with a sentence rather than sent and
 * refused.
 */
import { describe, expect, it } from 'vitest';

import {
  emptyProductDraft,
  emptyServiceDraft,
  productPayload,
  servicePayload,
  validateProduct,
  validateService,
} from './CatalogFormScreens';

describe('a new product', () => {
  it('needs an SKU and a name, and says which is missing', () => {
    const problems = validateProduct(emptyProductDraft());
    expect(problems.sku).toContain('SKU');
    expect(problems.name).toBeDefined();
    expect(problems.defaultPrice).toBeUndefined();
  });

  it('accepts a price and a warranty, or neither', () => {
    const draft = { ...emptyProductDraft(), sku: 'UPS-1', name: 'UPS 850VA' };
    expect(validateProduct(draft)).toEqual({});
    expect(validateProduct({ ...draft, defaultPrice: '8400.50', warrantyMonths: '24' })).toEqual({});
  });

  it('refuses a price that is not one, and a warranty that is not months', () => {
    const draft = { ...emptyProductDraft(), sku: 'UPS-1', name: 'UPS', defaultPrice: 'eight thousand' };
    expect(validateProduct(draft).defaultPrice).toContain('8400');
    expect(validateProduct({ ...draft, defaultPrice: '', warrantyMonths: '2 years' }).warrantyMonths).toContain(
      'months',
    );
  });

  it('sends only what was filled in — the schema is strict, and "" is not an absent field', () => {
    const payload = productPayload({ ...emptyProductDraft(), sku: ' UPS-1 ', name: ' UPS 850VA ' });
    expect(payload).toEqual({ sku: 'UPS-1', name: 'UPS 850VA', category: 'ups' });
  });

  it('sends the warranty as a number, because the schema asks for one', () => {
    const payload = productPayload({
      ...emptyProductDraft(),
      sku: 'B-1',
      name: 'Battery',
      warrantyMonths: '24',
      defaultPrice: '5000',
      brand: 'Exide',
    });
    expect(payload).toMatchObject({ warrantyMonths: 24, defaultPrice: '5000', brand: 'Exide' });
  });
});

describe('a new service', () => {
  it('needs a code and a name', () => {
    const problems = validateService(emptyServiceDraft());
    expect(problems.code).toContain('code');
    expect(problems.name).toBeDefined();
  });

  it('shouts the code, because that is how the catalogue reads', () => {
    const payload = servicePayload({ ...emptyServiceDraft(), code: 'batt-swap', name: 'Battery swap' });
    expect(payload).toEqual({ code: 'BATT-SWAP', name: 'Battery swap' });
  });

  it('keeps a description and a charge when they are given', () => {
    const payload = servicePayload({
      code: 'AMC',
      name: 'AMC visit',
      description: ' Annual maintenance ',
      defaultCharge: '1500',
    });
    expect(payload).toEqual({
      code: 'AMC',
      name: 'AMC visit',
      description: 'Annual maintenance',
      defaultCharge: '1500',
    });
  });

  it('refuses a charge that is not a number', () => {
    expect(validateService({ code: 'A', name: 'B', description: '', defaultCharge: 'free' }).defaultCharge).toBeDefined();
  });
});
