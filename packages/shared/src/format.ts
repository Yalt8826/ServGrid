/**
 * Numbers and currency, locale `en-IN` (UI/plan-2/01-FOUNDATIONS.md §6).
 * Money: `₹` + Indian grouping, 2dp only when non-zero paise. In inputs:
 * no grouping while typing, grouping applied on blur.
 */

/**
 * Indian-digit grouping of an integer part: last group of 3, then every
 * group of 2 (`100000` → `1,00,000`, `10000000` → `1,00,00,000`).
 */
export function groupEnIN(digits: string): string {
  const d = digits.replace(/[^0-9]/g, '');
  if (d === '') return '';
  if (d.length <= 3) return d;
  const last3 = d.slice(-3);
  const rest = d.slice(0, -3);
  const groups: string[] = [];
  for (let i = rest.length; i > 0; i -= 2) {
    groups.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return [...groups, last3].join(',');
}

/**
 * Format a raw numeric string as Indian money **without** the `₹` (the
 * prefix sits outside the input): 2dp only when there is a non-zero
 * paise part (`4250` → `4,250`, `4250.5` → `4,250.50`).
 */
export function formatMoneyEnIN(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const [intRaw = '', decRaw = ''] = cleaned.split('.');
  const intPart = intRaw === '' ? '0' : intRaw;
  const grouped = groupEnIN(intPart);
  const paise = (decRaw + '0').slice(0, 2);
  const hasPaise = paise.replace(/0/g, '') !== '';
  return hasPaise ? `${grouped}.${paise}` : grouped;
}

/** Strip everything but digits and one dot — the typing transform. */
export function stripToNumeric(raw: string): string {
  let out = '';
  let seenDot = false;
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else if (ch === '.' && !seenDot) {
      out += ch;
      seenDot = true;
    }
  }
  return out;
}
