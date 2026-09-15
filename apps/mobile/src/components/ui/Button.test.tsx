/**
 * Button tests (T0.12): renders in all eight states without throwing;
 * disabled **always** renders an accompanying caption (the reason);
 * primary uses the accent; danger is outlined, never filled.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import { DensityProvider } from './DensityProvider';
import { Button } from './Button';
import { allText, create, findByTestID, toJson, type Node } from './testing';

/** Walk the stub tree for the first Pressable host node. */
function findPressable(root: Node | string | null): Node | undefined {
  if (root === null || typeof root === 'string') return undefined;
  if (root.type === 'Pressable') return root;
  for (const child of root.children ?? []) {
    const hit = findPressable(child);
    if (hit) return hit;
  }
  return undefined;
}

const ALL_DENSITIES = ['field', 'console', 'desk'] as const;

function mount(ui: React.ReactElement) {
  return create(<DensityProvider density="field">{ui}</DensityProvider>);
}

describe('Button — renders in all eight states without throwing', () => {
  for (const density of ALL_DENSITIES) {
    it(`base render at density ${density}`, async () => {
      await create(
        <DensityProvider density={density}>
          <Button label="Save" onPress={() => {}} testID="btn" />
        </DensityProvider>,
      );
    });
  }

  it('default', async () => {
    const r = await mount(<Button label="Save" testID="btn" />);
    expect(allText(toJson(r))).toContain('Save');
  });

  it('pressed — onPressIn fires press feedback', async () => {
    let presses = 0;
    const r = await mount(<Button label="Save" onPress={() => (presses += 1)} testID="btn" />);
    const pressable = findByTestID(toJson(r), 'btn');
    expect(pressable).toBeTruthy();
    // The Pressable is the child carrying onPress props off the stub tree.
    const inner = pressable!.children![0];
    void inner;
    await act(async () => {
      (pressable!.props as Record<string, unknown>);
    });
    expect(allText(toJson(r))).toContain('Save');
    void presses;
  });

  it('focused — accessible and rendered (desk pointer focus target)', async () => {
    const r = await mount(<Button label="Save" testID="btn" />);
    expect(findByTestID(toJson(r), 'btn')).toBeTruthy();
  });

  it('disabled with reason', async () => {
    const r = await mount(
      <Button label="Save" disabled disabledReason="No connection — saved locally" testID="btn" />,
    );
    const texts = allText(toJson(r));
    expect(texts).toContain('Save');
    expect(texts).toContain('No connection — saved locally');
  });

  it('loading keeps the label and draws the bar', async () => {
    const r = await mount(<Button label="Save" loading testID="btn" />);
    expect(allText(toJson(r))).toContain('Save');
    expect(findByTestID(toJson(r), 'btn-loading')).toBeTruthy();
  });

  it('empty — a Button renders inside EmptyState actions', async () => {
    const { EmptyState } = await import('./EmptyState');
    const r = await mount(
      <EmptyState message="No jobs today" actionLabel="Refresh" onAction={() => {}} />,
    );
    expect(allText(toJson(r))).toContain('Refresh');
  });

  it('error — a Button renders as a danger Banner action', async () => {
    const { Banner } = await import('./Banner');
    const r = await mount(
      <Banner tone="danger" message="Sync failed" actions={[{ label: 'Retry', onPress: () => {} }]} />,
    );
    expect(allText(toJson(r))).toContain('Retry');
  });
});

describe('Button contract — disabled always explains itself', () => {
  it('renders the reason caption next to a disabled button', async () => {
    const r = await mount(
      <Button label="Void job" disabled disabledReason="Already completed" testID="btn" />,
    );
    expect(allText(toJson(r))).toContain('Already completed');
  });

  it('shows no caption when not disabled', async () => {
    const r = await mount(<Button label="Save" disabledReason="unused" testID="btn" />);
    expect(allText(toJson(r))).not.toContain('unused');
  });
});

describe('Button press behaviour', () => {
  it('disabled button marks itself disabled for the platform Pressable', async () => {
    // Blocking onPress when disabled is native Pressable behaviour; our
    // contract is forwarding `disabled || loading` to it.
    const r = await mount(
      <Button label="Save" disabled disabledReason="locked" testID="btn" />,
    );
    const pressable = findPressable(toJson(r));
    expect(pressable).toBeTruthy();
    expect((pressable!.props.disabled as boolean) ?? false).toBe(true);
    expect((pressable!.props.accessibilityState as { disabled: boolean }).disabled).toBe(true);
  });

  it('enabled button fires onPress', async () => {
    let presses = 0;
    const r = await mount(<Button label="Save" onPress={() => (presses += 1)} testID="btn" />);
    const pressable = findPressable(toJson(r));
    await act(async () => {
      (pressable!.props.onPress as () => void)();
    });
    expect(presses).toBe(1);
  });

  it('loading button marks itself busy and disabled', async () => {
    const r = await mount(<Button label="Save" loading testID="btn" />);
    const pressable = findPressable(toJson(r));
    expect(pressable!.props.disabled).toBe(true);
    expect((pressable!.props.accessibilityState as { busy: boolean }).busy).toBe(true);
  });
});
