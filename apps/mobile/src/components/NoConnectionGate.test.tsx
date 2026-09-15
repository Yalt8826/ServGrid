/**
 * The no-connection gate (PLAN-FRONTEND.md §5). Two promises: a lost
 * connection covers the screen for every role, and whatever was typed
 * underneath is still there when the connection returns — proven by a
 * stateful child whose value survives offline → online, which it cannot
 * if the gate ever unmounts it.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { TextInput } from 'react-native';

import { act, allText, create, findByTestID, firstDescendantOfType, toJson } from './ui/testing';
import { NO_CONNECTION_BODY, NO_CONNECTION_TITLE, NoConnectionGate } from './NoConnectionGate';

vi.mock('expo-network', () => ({
  getNetworkStateAsync: () => Promise.resolve({ isInternetReachable: true }),
  addNetworkStateListener: () => ({ remove: () => {} }),
}));

function Draft(): React.ReactNode {
  const [text, setText] = useState('');
  return <TextInput testID="draft" value={text} onChangeText={setText} />;
}

describe('NoConnectionGate', () => {
  it('online: renders the screen and nothing over it', async () => {
    const r = await create(
      <NoConnectionGate online>
        <Draft />
      </NoConnectionGate>,
    );
    expect(findByTestID(toJson(r), 'no-connection')).toBeUndefined();
    expect(findByTestID(toJson(r), 'draft')).toBeDefined();
  });

  it('offline: covers the screen with the one plain sentence', async () => {
    const r = await create(
      <NoConnectionGate online={false}>
        <Draft />
      </NoConnectionGate>,
    );
    const cover = findByTestID(toJson(r), 'no-connection');
    expect(cover).toBeDefined();
    const text = allText(cover!).join(' ');
    expect(text).toContain(NO_CONNECTION_TITLE);
    expect(text).toContain(NO_CONNECTION_BODY);
  });

  it('a half-typed form survives offline → online — the gate never unmounts what it covers', async () => {
    const r = await create(
      <NoConnectionGate online>
        <Draft />
      </NoConnectionGate>,
    );
    const input = firstDescendantOfType(findByTestID(toJson(r), 'draft')!, 'TextInput') ?? findByTestID(toJson(r), 'draft')!;
    await act(async () => {
      input.props.onChangeText?.('Replaced two batteries, load tes');
    });

    await act(async () => {
      r.update(
        <NoConnectionGate online={false}>
          <Draft />
        </NoConnectionGate>,
      );
    });
    expect(findByTestID(toJson(r), 'no-connection')).toBeDefined();
    expect(findByTestID(toJson(r), 'draft')!.props.value).toBe('Replaced two batteries, load tes');

    await act(async () => {
      r.update(
        <NoConnectionGate online>
          <Draft />
        </NoConnectionGate>,
      );
    });
    expect(findByTestID(toJson(r), 'no-connection')).toBeUndefined();
    expect(findByTestID(toJson(r), 'draft')!.props.value).toBe('Replaced two batteries, load tes');
  });
});
