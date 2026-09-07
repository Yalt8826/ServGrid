/**
 * Query configuration that needs no role (PLAN-FRONTEND.md §4).
 * `staleTime` 30s for lists, 0 for a job detail being actively worked.
 */
/** Route classes the spec calls out by name; everything else is a list. */
export function staleTimeFor(path: string): number {
  if (/^\/v1\/jobs\/[^/]+\/?$/.test(path)) return 0; // a job detail being actively worked
  return 30_000; // lists
}
