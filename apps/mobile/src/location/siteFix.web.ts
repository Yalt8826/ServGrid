/**
 * Web half of the on-site fix — always "no fix", and the ONLY file the
 * web bundle resolves from the shared graph.
 *
 * The owner's console is not a place: it is a desk, and the person
 * filing a completion from it is not standing at the site. Capturing
 * coordinates there would pin a customer to the office that typed it,
 * which is worse than leaving the pin empty. So the web build answers
 * null exactly as a refused permission does, and the completion is filed
 * without one.
 *
 * The stub exists so the completion route — one shared file the router
 * bundles for both platforms — compiles and runs with a single call
 * site, exactly like `trackingGate.web.ts` beside it.
 */
import type { SiteFix } from './siteFix';

export async function captureSiteFix(): Promise<SiteFix | null> {
  return null;
}
