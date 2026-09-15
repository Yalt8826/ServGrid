// Rule 4 control — the same storage use, in a file the rule allows by
// name (the login token's web store). Must lint clean.
declare const localStorage: { getItem(key: string): string | null };

export function readSession(): string | null {
  return localStorage.getItem('servgrid.session');
}
