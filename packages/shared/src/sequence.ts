/**
 * Business-number format (PLAN-DATA-MODEL.md §3.9): `JC-2627-00042`, where
 * `2627` is fiscal year 2026–27 and the numeric part is zero-padded to five
 * digits from `next_in_sequence(scope)` — the doc's own example is five
 * digits wide. The per-fiscal-year reset and the
 * prefix live in the `sequences` scope key (`job:2627`, `sale:2627`,
 * `payment:2627`, `contract:2627`).
 *
 * Drafts carry no number by design: `sales_cards.sale_number` and
 * `service_contracts.contract_number` are NULL while draft (§3.5, §3.10),
 * so `parseBusinessNumber` accepts `null`/`undefined` — absence is the
 * draft state, not a parse failure.
 */

export const NUMBER_PREFIXES = ['JC', 'SL', 'PM', 'CT'] as const;
export type NumberPrefix = (typeof NUMBER_PREFIXES)[number];

export const SEQUENCE_SCOPES = ['job', 'sale', 'payment', 'contract'] as const;
export type SequenceScope = (typeof SEQUENCE_SCOPES)[number];

export const SEQUENCE_WIDTH = 5;

const PREFIX_BY_SCOPE: Readonly<Record<SequenceScope, NumberPrefix>> = {
  job: 'JC',
  sale: 'SL',
  payment: 'PM',
  contract: 'CT',
};

export function prefixForScope(scope: SequenceScope): NumberPrefix {
  return PREFIX_BY_SCOPE[scope];
}

/** `job`, FY 2026–27, value 42 → `JC-2627-00042`. The doc's own example is five digits wide. */
export function formatBusinessNumber(
  scope: SequenceScope,
  fiscalYear: number,
  value: number,
): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`sequence value must be a non-negative integer, got ${value}`);
  }
  const fiscal = formatFiscalYear(fiscalYear);
  return `${PREFIX_BY_SCOPE[scope]}-${fiscal}-${String(value).padStart(SEQUENCE_WIDTH, '0')}`;
}

/** Fiscal years are written as the concatenated start/end short years: 2026–27 → `2627`. */
export function formatFiscalYear(fiscalYear: number): string {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 0 || fiscalYear > 99) {
    throw new RangeError(`fiscalYear must be a two-digit integer, got ${fiscalYear}`);
  }
  const start = String(fiscalYear).padStart(2, '0');
  const end = String((fiscalYear + 1) % 100).padStart(2, '0');
  return `${start}${end}`;
}

const NUMBER_RE = /^(JC|SL|PM|CT)-(\d{4})-(\d{5,})$/;

/** Parsed parts of a business number. `value` is not zero-padded. */
export interface ParsedBusinessNumber {
  prefix: NumberPrefix;
  fiscalYear: number;
  value: number;
}

/**
 * Parse `JC-2627-00042`. Returns `null` for anything else, including the
 * `null`/`undefined` a draft carries — callers treat that as "no number
 * yet", never as a malformed input.
 */
export function parseBusinessNumber(
  raw: string | null | undefined,
): ParsedBusinessNumber | null {
  if (raw == null) return null;
  const m = NUMBER_RE.exec(raw);
  if (!m) return null;
  // The regex guarantees all three groups are present.
  const prefix = m[1] as NumberPrefix;
  const fiscalText = m[2]!;
  const valueText = m[3]!;
  const start = Number.parseInt(fiscalText.slice(0, 2), 10);
  const end = Number.parseInt(fiscalText.slice(2), 10);
  // Fiscal pairs must be consecutive short years (`2627`, not `2600`).
  if (end !== (start + 1) % 100) return null;
  return { prefix, fiscalYear: start, value: Number.parseInt(valueText, 10) };
}
