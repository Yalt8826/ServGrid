/**
 * Photos: getting one off the device, and filing it (2026-09-16).
 *
 * One module owns both halves because they are one concern and were
 * drifting apart: the rep's payment proof and the technician's completion
 * photos are the same request to `POST /v1/attachments` with a different
 * `ownerType`, and the checksum dance below is subtle enough that a second
 * copy would be a second set of bugs. It used to be called
 * `captureProof` and lived inside the rep's data hook.
 *
 * `takePhoto` is the camera, `choosePhoto` the library — the technician
 * asked for "take or attach", and a photo already on the phone (the
 * customer's own picture, a shot taken before the app was open) is a
 * legitimate attachment. Both return null when he backs out and throw when
 * the device refuses, so a screen can render an honest note rather than
 * pretending a photo exists.
 */
import type * as ImagePickerTypes from 'expo-image-picker';

import { api } from './api';

/** Where an attachment hangs. `job_card` is the "before" side of a job,
 * `job_completion` the "after" — the split migration 008 documents. */
export type AttachmentOwnerType = 'payment' | 'job_card' | 'job_completion';

/** What the file is. A signature is a photograph of a paper docket. */
export type AttachmentKind = 'photo' | 'signature' | 'document';

/** The camera. Returns the captured file's local URI, or null if he backed out. */
export async function takePhoto(): Promise<string | null> {
  const ImagePicker = await picker();
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera permission was refused.');
  }
  const result = await ImagePicker.launchCameraAsync({ quality: 0.7, exif: false });
  if (result.canceled || result.assets.length === 0) return null;
  return result.assets[0]!.uri;
}

/** The library. Returns the chosen file's local URI, or null if he backed out. */
export async function choosePhoto(): Promise<string | null> {
  const ImagePicker = await picker();
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library permission was refused.');
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.7,
    exif: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  return result.assets[0]!.uri;
}

export interface AttachmentUpload {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  kind: AttachmentKind;
  /** The device's local URI for the file. */
  fileUri: string;
  /** The multipart filename; a jpeg by default. */
  fileName?: string;
}

/**
 * File one photo. Returns the attachment's id.
 *
 * The server verifies sha256 over the file's RAW bytes. expo-crypto's
 * `digestStringAsync` UTF-8-encodes its input, which corrupts binary
 * strings at bytes ≥ 0x80 (found on device: every upload bounced with a
 * checksum mismatch), so decode the base64 to real bytes and hash with
 * js-sha256.
 */
export async function uploadAttachment(upload: AttachmentUpload): Promise<{ id: string }> {
  const base64 = await readAsBase64(upload.fileUri);
  const checksum = await sha256OverBytes(base64ToBytes(base64));
  const form = new FormData();
  form.append('ownerType', upload.ownerType);
  form.append('ownerId', upload.ownerId);
  form.append('kind', upload.kind);
  form.append('capturedAt', new Date().toISOString());
  form.append('fileChecksum', checksum);
  form.append('file', {
    uri: upload.fileUri,
    name: upload.fileName ?? 'photo.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);
  // The shared client rather than a screen's `apiSend`: this module is
  // imported BY the rep's data hook, so importing that hook's helper back
  // would be a cycle. Same client underneath, same thrown message.
  const res = await api.request<{ id: string }>('POST', '/v1/attachments', { body: form });
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The photo could not be uploaded.');
  }
  return res.data;
}

/**
 * Read the file as base64 — imports are lazy so this module stays loadable
 * under the vitest seam, where `expo-file-system` and `js-sha256` are
 * replaced by stubs and a static import would drag the native module in at
 * module scope.
 */
/** The picker module, loaded on demand — a static import pulls expo's
 * native module registry in at module scope, which the node test env
 * cannot satisfy (and which no test needs: the seams inject fakes). */
async function picker(): Promise<typeof ImagePickerTypes> {
  return import('expo-image-picker');
}

async function readAsBase64(fileUri: string): Promise<string> {
  const FileSystem = await import('expo-file-system/legacy');
  return FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
}

async function sha256OverBytes(bytes: Uint8Array): Promise<string> {
  const { sha256 } = await import('js-sha256');
  return sha256(bytes);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
