/**
 * O9 Profile tests (UI/plan-2/07-OWNER.md §O9). The one the spec names:
 * **the second-owner account reminder** — a line stating who else holds
 * owner access, because the recovery story depends on that account
 * existing and being remembered.
 *
 * And the one the spec forbids: **no tracking chip. Owners are not
 * tracked** — asserted on the rendered tree and on the module's import
 * list, where the absence must start (the dispatcher profile's rule).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { allText, create, findByTestID, toJson } from '../../components/ui/testing';
import { OwnerProfileScreen } from './OwnerProfileScreen';

const HERE = fileURLToPath(new URL('./', import.meta.url).href as unknown as string);

const base = {
  fullName: 'Yashas',
  username: 'yashas',
  appVersion: '1.4.2',
  changePassword: () => {},
  logout: () => {},
};

describe('Owner profile — the second-owner account reminder (§O9)', () => {
  it('names the other owner account and why the line exists', async () => {
    const r = await create(
      <OwnerProfileScreen
        {...base}
        otherOwners={[{ id: 'e1000000-0000-4000-8000-000000000009', fullName: 'Lakshmi Iyer', username: 'lakshmi.i' }]}
      />,
    );
    const tree = toJson(r);
    const reminder = findByTestID(tree, 'owner-profile-second-owner-line');
    expect(reminder).toBeDefined();
    const line = allText(reminder!).join(' ');
    expect(line).toContain('Lakshmi Iyer');
    expect(line).toContain('lakshmi.i');
    expect(line).toContain('owner access');
    expect(line).toContain('Recovery');
  });

  it('no other owner — the line says so and demands the account be created', async () => {
    const r = await create(<OwnerProfileScreen {...base} otherOwners={[]} />);
    const line = allText(findByTestID(toJson(r), 'owner-profile-second-owner-line')!).join(' ');
    expect(line).toContain('No other account holds owner access');
  });

  it('carries name, username, change password, logout and app version', async () => {
    const r = await create(<OwnerProfileScreen {...base} otherOwners={[]} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'owner-profile-name')).toBeDefined();
    expect(findByTestID(tree, 'owner-profile-username')).toBeDefined();
    expect(findByTestID(tree, 'owner-profile-change-password')).toBeDefined();
    expect(findByTestID(tree, 'owner-profile-logout')).toBeDefined();
    expect(findByTestID(tree, 'owner-profile-app-version')).toBeDefined();
    expect(allText(findByTestID(tree, 'owner-profile-app-version')!).join(' ')).toContain('1.4.2');
  });
});

describe('Owner profile — no tracking chip (§O9: owners are not tracked)', () => {
  it('renders no tracking health chip and no pending badge', async () => {
    const r = await create(
      <OwnerProfileScreen {...base} otherOwners={[{ id: 'e1000000-0000-4000-8000-000000000009', fullName: 'L', username: 'l' }]} />,
    );
    const tree = toJson(r);
    expect(findByTestID(tree, 'employee-health-chip')).toBeUndefined();
    const text = allText(tree).join(' ');
    expect(text).not.toContain('Tracking');
    expect(text).not.toContain('Pending sync');
  });

  it('the module never imports the chip or the badge — the absence starts at the import list', () => {
    const src = readFileSync(join(HERE, 'OwnerProfileScreen.tsx'), 'utf8');
    // Code only — the header comment may NAME the rule it enforces.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('TrackingHealthChip');
    expect(code).not.toContain('PendingBadge');
    expect(code).not.toContain('useMirrorSession');
  });
});
