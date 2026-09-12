/**
 * `MoneyGate` (03-COMPONENTS.md, domain components). Renders children
 * only if `permit(role, 'job.money', action) !== 'none'`.
 *
 * **The action is a required prop, never defaulted to `read`.** That is
 * the trap the component exists to prevent: a technician's `job.money`
 * is write-once at completion with no read afterwards (PLAN.md §5), so
 * `permit('technician', 'job.money', 'read')` is `none` — and a gate
 * that assumed `read` would hide the amount field on the complete
 * sheet (T4), from the one person who has to fill it in, while looking
 * correct in review. `<MoneyGate action="create">` wraps the complete
 * sheet's amount and collection mode; `<MoneyGate action="read">`
 * wraps anything that reads a figure back.
 *
 * Belt-and-braces over the API's schema separation — the server already
 * will not send what it will not send — this makes the absence visible
 * in code review rather than implicit.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { permit, type Action, type Role } from '@servgrid/shared';

export interface MoneyGateProps {
  /** Whose eyes decide what renders — the session actor's role. */
  role: Role;
  /** REQUIRED. The action the wrapped surface needs on `job.money`. */
  action: Action;
  children?: ReactNode;
  testID?: string;
}

export function MoneyGate({ role, action, children, testID }: MoneyGateProps): ReactNode {
  if (permit(role, 'job.money', action) === 'none') return null;
  return (
    <View testID={testID} style={{ alignSelf: 'stretch' }}>
      {children}
    </View>
  );
}
