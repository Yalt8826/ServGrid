/**
 * The no-connection gate (PLAN-FRONTEND.md §5, decision 2026-09-15). The
 * app is online-only for every role, so a lost connection covers the whole
 * authenticated stack with one plain screen.
 *
 * **An overlay, never a replacement.** The stack stays mounted underneath,
 * so a half-typed completion, sale or payment is exactly as it was when the
 * connection returns — the owner chose "keep what was typed" and "full
 * screen" together, and only a sibling overlay gives both. Swapping the
 * children out for this screen would unmount them and throw the input away.
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../fonts/textStyle';
import { useIsOnline } from '../lib/network';

export const NO_CONNECTION_TITLE = 'No connection';
export const NO_CONNECTION_BODY = "ServGrid needs the internet. You'll be right back where you were.";

export interface NoConnectionGateProps {
  children: ReactNode;
  /** Injected by tests; the app reads the device's reachability. */
  online?: boolean;
}

export function NoConnectionGate({ children, online }: NoConnectionGateProps): ReactNode {
  const reachable = useIsOnline();
  const isOnline = online ?? reachable;
  return (
    <View style={{ flex: 1 }}>
      {children}
      {isOnline ? null : (
        <View
          testID="no-connection"
          accessibilityRole="alert"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            alignItems: 'center',
            justifyContent: 'center',
            padding: SPACE[5],
            backgroundColor: SEMANTIC.bg.app,
          }}
        >
          <Text style={{ ...textStyle('h1'), color: SEMANTIC.text.primary, textAlign: 'center' }}>{NO_CONNECTION_TITLE}</Text>
          <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary, textAlign: 'center', marginTop: SPACE[2] }}>
            {NO_CONNECTION_BODY}
          </Text>
        </View>
      )}
    </View>
  );
}
