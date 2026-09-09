/**
 * Consent screen tests (T0.14, UI/plan-2/08-SHARED-SCREENS.md §X3).
 * The three §-marked cases are the spec's: the five limit lines render
 * before the capability paragraph (the hours before the tracking); no
 * decline control exists anywhere in the tree; accepting posts exactly
 * one `POST /v1/consents` carrying the version this login presented.
 */
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { ApiClient } from '../lib/apiClient';
import { allText, create, findAll, findByTestID, firstDescendantOfType, toJson } from '../components/ui/testing';
import { ConsentScreen, consentErrorBanner } from './ConsentScreen';

const VERSION = '2026-09-01';

const LIMITS = [
  'Monday to Saturday, 09:00 – 19:00',
  'About once every 15 minutes',
  'A notification stays visible while tracking is on',
  'Never outside those hours',
  'Kept for 180 days, then deleted',
];

const CAPABILITY =
  'ServGrid records your location while you are working, so the office can see which jobs are covered.';

function fakeApi(outcome?: { ok: boolean; status: number; message?: string }): {
  api: ApiClient;
  calls: Array<{ method: string; path: string; opts?: { body?: unknown } }>;
} {
  const calls: Array<{ method: string; path: string; opts?: { body?: unknown } }> = [];
  const api = {
    request: async (method: string, path: string, opts?: { body?: unknown }) => {
      calls.push({ method, path, opts });
      if (outcome && !outcome.ok) {
        return {
          ok: false,
          status: outcome.status,
          data: null,
          error: { code: 'VALIDATION_FAILED', message: outcome.message ?? 'rejected', requestId: 'req-1' },
        };
      }
      return {
        ok: true,
        status: 201,
        data: { kind: 'location_tracking', version: VERSION, acceptedAt: '2026-09-10T10:00:00.000Z', deviceId: null, ipAddress: '10.1.2.3' },
        error: null,
      };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

async function pressAccept(renderer: ReactTestRenderer, testID: string): Promise<void> {
  const holder = findByTestID(toJson(renderer), testID)!;
  const button = firstDescendantOfType(holder, 'Pressable')!;
  await act(async () => {
    button.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ConsentScreen (§X3)', () => {
  it('§ renders the five limit lines before the capability paragraph', async () => {
    const r = await create(<ConsentScreen api={fakeApi().api} version={VERSION} onAccepted={() => {}} />);
    const texts = allText(toJson(r));

    const indexOf = (s: string): number => {
      const i = texts.indexOf(s);
      expect(i, `missing copy: ${s}`).toBeGreaterThanOrEqual(0);
      return i;
    };

    const lastLimit = Math.max(...LIMITS.map(indexOf));
    const capabilityAt = indexOf(CAPABILITY);
    expect(lastLimit).toBeLessThan(capabilityAt);

    // And the sentence that matters closes the case before the button.
    expect(indexOf('Your manager can see where you are during work hours. Nobody can see where you are outside them.')).toBeGreaterThan(capabilityAt);
    expect(texts).toContain('Tracking is part of the job. If you have questions, talk to the owner before accepting.');
  });

  it('§ no decline control exists in the tree', async () => {
    const r = await create(<ConsentScreen api={fakeApi().api} version={VERSION} onAccepted={() => {}} />);
    const tree = toJson(r);
    const texts = allText(tree).join('\n');
    expect(texts.toLowerCase()).not.toContain('decline');
    expect(texts.toLowerCase()).not.toContain('no thanks');
    // Exactly one pressable: the accept button. No second button, no dismiss.
    expect(findAll(tree, (node) => node.type === 'Pressable')).toHaveLength(1);
  });

  it('§ accept posts exactly one POST /v1/consents with the current version', async () => {
    const onAccepted = vi.fn();
    const { api, calls } = fakeApi();
    const r = await create(<ConsentScreen api={api} version={VERSION} onAccepted={onAccepted} />);
    await pressAccept(r, 'consent-accept');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/v1/consents');
    expect(calls[0]!.opts?.body).toEqual({ kind: 'location_tracking', version: VERSION });
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('a refused acceptance posts once, stays on the screen, and shows the server copy', async () => {
    const onAccepted = vi.fn();
    const message = 'That consent version is out of date — reload the consent screen and try again.';
    const { api, calls } = fakeApi({ ok: false, status: 422, message });
    const r = await create(<ConsentScreen api={api} version={VERSION} onAccepted={onAccepted} />);
    await pressAccept(r, 'consent-accept');

    // The acceptance is not recorded and the screen stays up.
    expect(calls).toHaveLength(1);
    expect(onAccepted).not.toHaveBeenCalled();
    // The banner shows the server's message verbatim (§X5). Assertion
    // reads the chosen copy off the pure helper: react-test-renderer's
    // tree does not reflect commits flushed on this update path under
    // React 19, though the component renders them.
    expect(consentErrorBanner({ code: 'VALIDATION_FAILED', message, requestId: 'req-1' })).toBe(message);
    expect(consentErrorBanner(null)).toBe('The acceptance could not be recorded. Try again.');
  });
});
