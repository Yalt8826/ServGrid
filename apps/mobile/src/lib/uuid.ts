/**
 * RFC 4122 v4 UUID from `expo-crypto`'s CSPRNG (`getRandomBytesAsync`
 * works on native and web, and — unlike Web Crypto's `randomUUID` — is
 * not gated on a secure context, so an owner opening the app over LAN
 * http still gets a key). Used for `Idempotency-Key` and the install id.
 */
import * as Crypto from 'expo-crypto';

export async function uuid(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x40; // version 4
  bytes[8] = (b8 & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0'));
  const h = hex as string[] & Record<number, string>;
  return [
    h.slice(0, 4).join(''),
    h.slice(4, 6).join(''),
    h.slice(6, 8).join(''),
    h.slice(8, 10).join(''),
    h.slice(10, 16).join(''),
  ].join('-');
}
