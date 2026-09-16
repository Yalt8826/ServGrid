/**
 * Opening a captured site location in the platform's map (2026-09-17).
 *
 * One definition, because two screens offer it — the owner's console and
 * the dispatcher's phone — and a URL built in two places is a URL that
 * drifts. It answers the whole point of capturing the coordinates: the
 * technician who has to *reach* the site wants a pin to follow, not six
 * decimals to retype.
 *
 * The coordinates are written with six decimals, the same precision the
 * screens display, so what a user reads on screen and what the map opens
 * are the same point rather than two roundings of it.
 */
import { Linking } from 'react-native';

/** The map URL for a captured site. Exported for the test and for display. */
export function mapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

/**
 * Opens the site in the platform's default handler. The failure is
 * swallowed on purpose: a device with no map app cannot open one, and
 * that must not surface as an error over a working screen — the
 * coordinates stay readable beside the link either way.
 */
export async function openSiteInMaps(latitude: number, longitude: number): Promise<void> {
  try {
    await Linking.openURL(mapsUrl(latitude, longitude));
  } catch {
    // No map handler; the numbers on screen are still the answer.
  }
}
