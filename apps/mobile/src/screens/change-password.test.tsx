/**
 * Forced password change tests (T0.14, UI/plan-2/08-SHARED-SCREENS.md
 * §X2). The rule is stated before typing (helper text on arrival);
 * a mismatching or short pair never reaches the API; an accepted change
 * posts the current (temporary) password from this login plus the new
 * one, fires `NotificationSuccess`, and moves on — no interstitial.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import * as hapticsStub from '../test-stubs/expo-haptics';
import { allText, create, findByTestID, firstDescendantOfType, type Node } from '../components/ui/testing';
import type { ApiClient } from '../lib/apiClient';
import { ChangePasswordScreen } from './ChangePasswordScreen';

function fakeApi(): { api: ApiClient; calls: Array<{ method: string; path: string; opts?: { body?: unknown } }> } {
  const calls: Array<{ method: string; path: string; opts?: { body?: unknown } }> = [];
  const api = {
    request: async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, opts });
      return { ok: true, status: 200, data: { ok: true }, error: null };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

function rendererJson(r: { toJSON: () => unknown }): Node {
  return r.toJSON() as unknown as Node;
}

async function typeInto(r: { toJSON: () => unknown }, testID: string, text: string): Promise<void> {
  const field = findByTestID(rendererJson(r), testID);
  if (!field) throw new Error(`no field ${testID}`);
  const input = firstDescendantOfType(field, 'TextInput');
  if (!input) throw new Error(`no input in ${testID}`);
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

async function press(r: { toJSON: () => unknown }, testID: string): Promise<void> {
  const holder = findByTestID(rendererJson(r), testID);
  if (!holder) throw new Error(`no ${testID}`);
  const button = firstDescendantOfType(holder, 'Pressable');
  if (!button) throw new Error(`no pressable in ${testID}`);
  await act(async () => {
    button.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChangePasswordScreen (§X2)', () => {
  it('the rule is stated before typing — helper text on a fresh screen', async () => {
    const { api, calls } = fakeApi();
    const r = await create(
      <ChangePasswordScreen api={api} currentPassword="paper-temp" onComplete={() => {}} />,
    );
    expect(allText(rendererJson(r))).toContain('At least 8 characters.');
    expect(calls).toHaveLength(0);
  });

  it('a short password or a mismatch is refused locally — nothing is posted', async () => {
    const onDone = vi.fn();
    const { api, calls } = fakeApi();
    const r = await create(
      <ChangePasswordScreen api={api} currentPassword="paper-temp" onComplete={onDone} />,
    );
    await typeInto(r, 'change-password-new', 'short');
    await typeInto(r, 'change-password-confirm', 'short-but-different');
    await press(r, 'change-password-submit');

    const tree = rendererJson(r);
    expect(findByTestID(tree, 'change-password-new-error')).toBeTruthy();
    expect(findByTestID(tree, 'change-password-confirm-error')).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('success posts once with the temp password, fires NotificationSuccess, moves on', async () => {
    hapticsStub.__reset();
    const onDone = vi.fn();
    const { api, calls } = fakeApi();
    const r = await create(
      <ChangePasswordScreen api={api} currentPassword="paper-temp" onComplete={onDone} />,
    );
    await typeInto(r, 'change-password-new', 'a-real-new-password');
    await typeInto(r, 'change-password-confirm', 'a-real-new-password');
    await press(r, 'change-password-submit');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/auth/password');
    expect(calls[0]!.opts?.body).toEqual({
      currentPassword: 'paper-temp',
      newPassword: 'a-real-new-password',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(hapticsStub.__fired()).toContain('notification:notificationSuccess');
  });
});

/**
 * The voluntary shape (2026-09-17): a profile's "Change password" used to
 * push the FORCED route, which — with no temporary password in the session
 * — redirects to `/login`, so the button signed the user out. The profile
 * now has its own route; this is the screen it renders: it asks for the
 * current password (nobody holds it here), offers a way back, and posts
 * what was typed.
 */
describe('ChangePasswordScreen — from a profile', () => {
  it('asks for the current password, and posts what was typed with the new one', async () => {
    const onDone = vi.fn();
    const { api, calls } = fakeApi();
    const r = await create(<ChangePasswordScreen api={api} onComplete={onDone} onCancel={() => {}} />);

    // A field nobody had to fill in the forced flow.
    expect(findByTestID(rendererJson(r), 'change-password-current')).toBeTruthy();
    expect(allText(rendererJson(r)).join(' ')).not.toContain('temporary');

    await typeInto(r, 'change-password-new', 'a-real-new-password');
    await typeInto(r, 'change-password-confirm', 'a-real-new-password');
    await press(r, 'change-password-submit');

    // The current password is required, not assumed: nothing was posted.
    expect(calls).toHaveLength(0);
    expect(findByTestID(rendererJson(r), 'change-password-current-error')).toBeTruthy();

    await typeInto(r, 'change-password-current', 'the-one-i-use');
    await press(r, 'change-password-submit');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts?.body).toEqual({
      currentPassword: 'the-one-i-use',
      newPassword: 'a-real-new-password',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('can be walked away from — the way back is a button, not a gesture', async () => {
    const onCancel = vi.fn();
    const { api } = fakeApi();
    const r = await create(<ChangePasswordScreen api={api} onComplete={() => {}} onCancel={onCancel} />);
    await press(r, 'change-password-cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
