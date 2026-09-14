/**
 * The location console's map — NATIVE counterpart (T4.10). Renders
 * nothing, deliberately: the map is "the only map in the system"
 * (UI/plan-2/07-OWNER.md §O3) and lives only on the owner's web desk.
 * This stub is what Metro resolves on Android/iOS and what vitest
 * resolves under test, so neither the APK nor the test graph ever
 * pulls `maplibre-gl` — the real implementation is `locationMap.web.tsx`
 * alone, exactly how `DataTable.web.tsx` stays out of the APK.
 */
import type { TrailStop } from './locationModel';
import type { RosterRow } from './locationModel';

export interface LocationMapProps {
  /** Every tracked employee's latest position — the dots. */
  rows: RosterRow[];
  /** The selected employee, whose day trail draws below. */
  selectedEmployeeId: string | null;
  /** The selected employee's trail vertices worth a time label. */
  trailStops: TrailStop[];
  /** Arms the selected dot's slow pulse (five-minute live window). */
  pulseActive: boolean;
}

export function LocationMap(_props: LocationMapProps): React.ReactNode {
  return null;
}
