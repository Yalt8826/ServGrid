/**
 * Density provider (01-FOUNDATIONS.md §3.3). One provider, read by
 * every primitive. Screens never set density — `NavShell` (T0.13) will
 * set it from role and platform, exactly once; until then the gallery
 * and any screen-level usage set it explicitly. Default is `field`:
 * the technician's phone is the product's centre of gravity.
 */
import { createContext, useContext, type ReactNode } from 'react';

import { DENSITY, type Density } from '@servgrid/shared';

const DensityContext = createContext<Density>('field');

export function DensityProvider({
  density,
  children,
}: {
  density: Density;
  children: ReactNode;
}): ReactNode {
  return <DensityContext.Provider value={density}>{children}</DensityContext.Provider>;
}

export function useDensity(): Density {
  return useContext(DensityContext);
}

/** Resolved metrics for the active density. */
export function useDensityMetrics(): (typeof DENSITY)[Density] {
  return DENSITY[useDensity()];
}
