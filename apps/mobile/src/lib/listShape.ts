/**
 * One reader for the two list shapes the API answers with (OW.1,
 * 2026-09-16).
 *
 * `/v1/companies`, `/v1/contracts`, `/v1/jobs` and `/v1/customers` return
 * a cursor envelope `{ items, nextCursor }`; `/v1/employees`,
 * `/v1/products` and `/v1/services` return a bare array — small,
 * slow-moving tables with no pagination to carry. Both are deliberate and
 * both are live contracts.
 *
 * The owner's screens read every one of them through a single helper, and
 * that helper knew only the envelope: `envelope.items` was `undefined` for
 * three endpoints and the `.map` that followed threw, which is why
 * Companies, Employees, Products and Services all rendered an error
 * instead of their rows. Normalising here means a screen never has to know
 * which shape it asked for.
 */
export interface ListEnvelope<T> {
  items: T[];
  nextCursor?: string | null;
}

export function itemsOf<T>(body: ListEnvelope<T> | T[] | null | undefined): T[] {
  if (Array.isArray(body)) return body;
  return body?.items ?? [];
}
