import { describe, expect, it, vi } from 'vitest';

import { act } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { CompanyFormScreen } from './CompanyFormScreen';

function deps(overrides: Partial<Parameters<typeof CompanyFormScreen>[0]> = {}) {
  return {
    create: vi.fn(async () => 'c1000000-0000-4000-8000-000000000009'),
    online: true,
    onCreated: vi.fn(),
    ...overrides,
  };
}

async function type(renderer: ReactTestRenderer, testID: string, text: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID)!;
  const input = findAll(node, (n) => n.type === 'TextInput')[0]!;
  await act(async () => {
    input.props.onChangeText?.(text);
  });
}

describe('CompanyFormScreen (§S4 write side)', () => {
  it('the name is the one requirement; everything else is optional', async () => {
    const d = deps();
    const r = await create(<CompanyFormScreen {...d} />);
    const submit = findAll(findByTestID(toJson(r), 'company-form-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    expect(allText(toJson(r)).join('\n')).toContain('Enter the company name.');
  });

  it('the create sends the trimmed fields and opens the new account — the server owns ownership', async () => {
    const d = deps();
    const r = await create(<CompanyFormScreen {...d} />);
    await type(r, 'company-form-name', '  Sree Ganesh Generators  ');
    await type(r, 'company-form-phone', '+91 98450 44444');

    const submit = findAll(findByTestID(toJson(r), 'company-form-submit')!, (n) => n.type === 'Pressable')[0]!;
    await act(async () => {
      submit.props.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(d.create).toHaveBeenCalledWith({
      name: 'Sree Ganesh Generators',
      phone: '+91 98450 44444',
    });
    expect(d.onCreated).toHaveBeenCalledWith('c1000000-0000-4000-8000-000000000009');
  });

  it('offline, the create is disabled and says so', async () => {
    const d = deps({ online: false });
    const r = await create(<CompanyFormScreen {...d} />);
    await type(r, 'company-form-name', 'Sree Ganesh Generators');
    const submit = findAll(findByTestID(toJson(r), 'company-form-submit')!, (n) => n.type === 'Pressable')[0]!;
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    expect(allText(toJson(r)).join('\n')).toContain("You're offline — creating needs a connection.");
  });
});
