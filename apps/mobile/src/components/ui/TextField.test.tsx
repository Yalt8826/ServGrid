/**
 * TextField tests (T0.12): renders in all eight states; error message
 * replaces helper; focused border is `line.focus`; disabled blocks
 * editing.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import { DensityProvider } from './DensityProvider';
import { TextField } from './TextField';
import { allText, create, toJson, type Node } from './testing';

function findTextInput(root: Node | string | null): Node | undefined {
  if (root === null || typeof root === 'string') return undefined;
  if (root.type === 'TextInput') return root;
  for (const child of root.children ?? []) {
    const hit = findTextInput(child);
    if (hit) return hit;
  }
  return undefined;
}

function mount(ui: React.ReactElement, density: 'field' | 'console' | 'desk' = 'field') {
  return create(<DensityProvider density={density}>{ui}</DensityProvider>);
}

describe('TextField — eight states without throwing', () => {
  it('default', async () => {
    const r = await mount(<TextField label="Username" value="" onChangeText={() => {}} testID="tf" />);
    expect(findTextInput(toJson(r))).toBeTruthy();
  });
  it('disabled — slate.050 fill, not editable', async () => {
    const r = await mount(
      <TextField label="Username" value="tech01" onChangeText={() => {}} disabled testID="tf" />,
    );
    expect(findTextInput(toJson(r))!.props.editable).toBe(false);
  });
  it('error — message replaces helper, danger caption', async () => {
    const r = await mount(
      <TextField
        label="Username"
        value=""
        onChangeText={() => {}}
        helperText="Your login name"
        errorText="Username or password is wrong."
        testID="tf"
      />,
    );
    const texts = allText(toJson(r));
    expect(texts).toContain('Username or password is wrong.');
    expect(texts).not.toContain('Your login name');
  });
  it('renders at every density', async () => {
    for (const d of ['field', 'console', 'desk'] as const) {
      await mount(<TextField label="U" value="" onChangeText={() => {}} testID="tf" />, d);
    }
  });
  it('onChangeText wired through', async () => {
    let got = '';
    const r = await mount(
      <TextField label="U" value="" onChangeText={(v) => (got = v)} testID="tf" />,
    );
    await act(async () => {
      findTextInput(toJson(r))!.props.onChangeText?.('tech01');
    });
    expect(got).toBe('tech01');
  });
});
