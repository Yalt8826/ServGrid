/**
 * Platform-neutral runtime configuration for the mobile app. Values come
 * from app.json `extra` via expo-constants, overridable by Expo public
 * env vars for local development.
 */
import Constants from 'expo-constants';

function readExtra(): Record<string, unknown> {
  const extra = Constants.expoConfig?.extra;
  return typeof extra === 'object' && extra !== null ? (extra as Record<string, unknown>) : {};
}

function apiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '');
  const fromExtra = readExtra().apiBaseUrl;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra.replace(/\/+$/, '');
  return 'http://localhost:8787';
}

/** True in a browser (document exists) — the owner's desktop build. */
function isWebBuild(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    window.document?.nodeType === 9 // DOCUMENT_NODE — not a test shim
  );
}

/** `X-Source` header value: `mobile` on native, `web` in the browser. */
export function sourceHeader(): 'mobile' | 'web' {
  return isWebBuild() ? 'web' : 'mobile';
}

/** True when running as the desktop-web owner build. */
export function isWeb(): boolean {
  return sourceHeader() === 'web';
}

export const config = {
  get apiBaseUrl(): string {
    return apiBaseUrl();
  },
  source: sourceHeader(),
} as const;
