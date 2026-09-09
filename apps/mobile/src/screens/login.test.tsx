/**
 * Login screen tests (T0.14, UI/plan-2/08-SHARED-SCREENS.md §X1). The
 * three §-marked cases are the spec's: password visible by default with
 * a working toggle; wrong credentials render ONE banner that never says
 * which field; offline renders the one sentence that admits sign-in
 * needs a connection. The lockout case pins "with the actual number".
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { ApiResult, LoginResponse } from '../lib/apiClient';
import { allText, create, findAllByTestID, findByTestID, firstDescendantOfType, toJson, type Node } from '../components/ui/testing';
import { LoginScreen, loginErrorBanner, nextRouteFor } from './LoginScreen';

const OK_RESULT: ApiResult<LoginResponse> = {
  ok: true,
  status: 200,
  data: {
    accessToken: 'at',
    refreshToken: 'rt',
    employee: { id: 'e1', role: 'technician', username: 'ravi' },
    mustChangePassword: false,
    consent: { required: true, version: '2026-09-01' },
  },
  error: null,
};

function failResult(code: string, status: number, message: string): ApiResult<LoginResponse> {
  return { ok: false, status, data: null, error: { code: code as never, message, requestId: 'req-1' } };
}

async function typeInto(
  renderer: ReactTestRenderer,
  testID: string,
  text: string,
): Promise<void> {
  const field = findByTestID(toJson(renderer), testID);
  if (!field) throw new Error(`no field ${testID}`);
  const input = firstDescendantOfType(field, 'TextInput');
  if (!input) throw new Error(`no input in ${testID}`);
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

async function press(
  renderer: ReactTestRenderer,
  testID: string,
): Promise<void> {
  const holder = findByTestID(toJson(renderer), testID);
  if (!holder) throw new Error(`no ${testID}`);
  const button = firstDescendantOfType(holder, 'Pressable');
  if (!button) throw new Error(`no pressable in ${testID}`);
  await act(async () => {
    button.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LoginScreen (§X1)', () => {
  it('§ password is visible by default; the toggle masks it and reveals it again', async () => {
    const r = await create(
      <LoginScreen signIn={async () => OK_RESULT} onAuthenticated={() => {}} />,
    );
    const inputOf = (): Node =>
      firstDescendantOfType(findByTestID(toJson(r), 'login-password')!, 'TextInput')!;
    expect(inputOf().props.secureTextEntry).toBe(false);

    const pressToggle = async (): Promise<void> => {
      const toggle = findByTestID(toJson(r), 'login-password-toggle')!;
      await act(async () => {
        toggle.props.onPress?.();
      });
    };

    await pressToggle();
    expect(inputOf().props.secureTextEntry).toBe(true);
    await pressToggle();
    expect(inputOf().props.secureTextEntry).toBe(false);
  });

  it('§ wrong credentials render one banner and never name the field', async () => {
    const onAuthenticated = vi.fn();
    const r = await create(
      <LoginScreen
        signIn={async () => failResult('UNAUTHENTICATED', 401, 'Username or password is not correct.')}
        onAuthenticated={onAuthenticated}
      />,
    );
    await typeInto(r, 'login-username', 'ravi');
    await typeInto(r, 'login-password', 'from-the-paper');
    await press(r, 'login-submit');

    const texts = allText(toJson(r));
    expect(texts).toContain('Username or password is wrong.');
    // The server's own wording never leaks through, and neither field is
    // marked as the wrong one.
    expect(texts).not.toContain('Username or password is not correct.');
    expect(findAllByTestID(toJson(r), 'login-banner')).toHaveLength(1);
    expect(findByTestID(toJson(r), 'login-username-error')).toBeUndefined();
    expect(findByTestID(toJson(r), 'login-password-error')).toBeUndefined();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('§ offline renders the no-connection banner — sign-in genuinely blocks', async () => {
    const r = await create(
      <LoginScreen
        signIn={async () => ({ ok: false, status: 0, data: null, error: { code: 'NETWORK' as never, message: 'Network request failed', requestId: '' } })}
        onAuthenticated={() => {}}
      />,
    );
    await typeInto(r, 'login-username', 'ravi');
    await typeInto(r, 'login-password', 'x');
    await press(r, 'login-submit');

    expect(allText(toJson(r))).toContain('No connection — sign-in needs one.');
  });

  it('lockout names the actual minutes from Retry-After', async () => {
    const r = await create(
      <LoginScreen
        signIn={async () => ({
          ...failResult('RATE_LIMITED', 429, 'Too many sign-in attempts. Wait a minute and try again.'),
          retryAfterSeconds: 180,
        })}
        onAuthenticated={() => {}}
      />,
    );
    await typeInto(r, 'login-username', 'ravi');
    await typeInto(r, 'login-password', 'x');
    await press(r, 'login-submit');

    expect(allText(toJson(r))).toContain('Too many attempts. Try again in 3 minutes.');
    // And the rounding: a 60-second window reads as one minute, not zero.
    expect(
      loginErrorBanner({
        ...failResult('RATE_LIMITED', 429, 'x'),
        retryAfterSeconds: 60,
      }),
    ).toBe('Too many attempts. Try again in 1 minute.');
  });

  it('a successful sign-in hands the result and the password used to the route', async () => {
    const onAuthenticated = vi.fn();
    const r = await create(
      <LoginScreen signIn={async () => OK_RESULT} onAuthenticated={onAuthenticated} />,
    );
    await typeInto(r, 'login-username', 'ravi');
    await typeInto(r, 'login-password', 'from-the-paper');
    await press(r, 'login-submit');

    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).toHaveBeenCalledWith(OK_RESULT.data, 'from-the-paper');
  });
});

describe('nextRouteFor — the post-login routing decision', () => {
  const base = OK_RESULT.data!;

  it('forced password change comes first, even when consent is also owed', () => {
    expect(
      nextRouteFor({ ...base, mustChangePassword: true, consent: { required: true, version: '2026-09-01' } }),
    ).toBe('change-password');
  });

  it('tracked roles with consent owed go to consent', () => {
    for (const role of ['technician', 'sales_rep'] as const) {
      expect(
        nextRouteFor({ ...base, employee: { ...base.employee, role }, consent: { required: true, version: '2026-09-01' } }),
      ).toBe('consent');
    }
  });

  it('consent already given, or an untracked role, goes straight to landing', () => {
    expect(nextRouteFor({ ...base, consent: { required: false, version: '2026-09-01' } })).toBe('landing');
    for (const role of ['dispatcher', 'owner'] as const) {
      expect(
        nextRouteFor({ ...base, employee: { ...base.employee, role }, consent: { required: true, version: '2026-09-01' } }),
      ).toBe('landing');
    }
  });
});
