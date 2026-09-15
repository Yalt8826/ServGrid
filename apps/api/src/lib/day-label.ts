/**
 * `14 Sep 2027` from a `YYYY-MM-DD` — the AMC sentences name dates the
 * dispatcher can act on ("doesn't cover 14 Sep 2027"), not ISO strings
 * he has to parse (decision 2026-09-15).
 */
export function dayLabel(iso: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y = '', m = '', d = ''] = iso.split('-');
  const month = MONTHS[Number(m) - 1] ?? m;
  return `${Number(d)} ${month} ${y}`;
}
