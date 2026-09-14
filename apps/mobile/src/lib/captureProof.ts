/**
 * The rep's proof-photo capture (owner decision 2026-09-14: the photo is
 * the ONE payment evidence — the bank/transaction reference field is
 * gone). Launches the camera and returns the captured file's local URI,
 * or null when the rep backed out. Throws when the camera cannot be
 * used, so the sheet renders an honest note instead of pretending.
 */
import * as ImagePicker from 'expo-image-picker';

export async function captureProofPhoto(): Promise<string | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera permission was refused.');
  }
  const result = await ImagePicker.launchCameraAsync({ quality: 0.7, exif: false });
  if (result.canceled || result.assets.length === 0) return null;
  return result.assets[0]!.uri;
}
