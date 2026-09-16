/**
 * The bug this helper ends (OW.1): the owner's Companies, Employees,
 * Products and Services screens all showed an error because their one
 * list reader assumed a cursor envelope, and three of the endpoints they
 * read answer with a bare array. Both shapes are live contracts, so the
 * reader has to know both.
 */
import { describe, expect, it } from 'vitest';

import { itemsOf } from './listShape';

interface Row {
  id: string;
}

const ROWS: Row[] = [{ id: 'a' }, { id: 'b' }];

describe('itemsOf — one reader, both list shapes', () => {
  it('takes the rows out of a cursor envelope (/v1/companies, /v1/contracts)', () => {
    expect(itemsOf<Row>({ items: ROWS, nextCursor: null })).toEqual(ROWS);
  });

  it('passes a bare array straight through (/v1/employees, /v1/products, /v1/services)', () => {
    expect(itemsOf<Row>(ROWS)).toEqual(ROWS);
  });

  it('an empty answer of either shape is an empty list, never a throw', () => {
    expect(itemsOf<Row>([])).toEqual([]);
    expect(itemsOf<Row>({ items: [] })).toEqual([]);
  });

  it('a null or undefined body is an empty list — the screen renders its empty state, not an error', () => {
    expect(itemsOf<Row>(null)).toEqual([]);
    expect(itemsOf<Row>(undefined)).toEqual([]);
  });

  it('an envelope whose items are missing is empty rather than undefined — the exact shape that threw', () => {
    expect(itemsOf<Row>({} as { items: Row[] })).toEqual([]);
  });
});
