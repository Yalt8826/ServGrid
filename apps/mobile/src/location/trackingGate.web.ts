/**
 * Web half of the tracking gate — a no-op stub, and the ONLY file the
 * web bundle resolves from the shared graph. The background location
 * task itself (`task.native.ts`) has no counterpart file here: owners
 * are not tracked, there is nothing to degrade gracefully, and the web
 * bundle never imports the task (PLAN-FRONTEND.md §6).
 *
 * The stub exists so the root layout and the ladder route — shared files
 * the router bundles for both platforms — can compile and run with one
 * call site each, exactly like the token-store seam in `lib/`.
 */
export function armLocationTracking(): void {
  // Web is never tracked; nothing to arm.
}

export async function ensureTrackingStarted(): Promise<boolean> {
  return false;
}
