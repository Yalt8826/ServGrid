/**
 * Cold-load flag hydration for routes that gate on `isFlagOn` before any
 * screen hook has run — the contracts and owner routes, whose screens
 * answer a bare placeholder when the gate reads dark. The flag cache is
 * process-local: a hard browser load starts empty and `isFlagOn` falls
 * back to "every flag off", so the owner who opened /contracts directly
 * found his own AMC tab walled off until he logged in again (2026-09-16
 * console walk).
 *
 * The read itself — the `/v1/auth/me` request, the flag cache it fills,
 * and the session teardown that clears it — is [[useAuthMe]]'s, so a
 * screen that needs both the flags and the employee's name makes ONE
 * request. This hook is only the "is the answer known yet" half.
 */
import { useAuthMe } from './useAuthMe';

export function useFlagsReady(): boolean {
  return useAuthMe().ready;
}
