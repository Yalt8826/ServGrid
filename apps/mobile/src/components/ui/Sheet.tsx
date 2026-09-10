/**
 * `Sheet` (03-COMPONENTS.md). Grab handle 32×4 slate.400, optional
 * title row, scrollable content, fixed bottom action bar (72) that
 * never scrolls away. Never full-screen — at least 64pt of the screen
 * stays visible behind.
 *
 * **Motion pending.** The rise (`considered` 300ms, spring.sheet, from the
 * control that opened it) and drag-to-dismiss (spring.snap, velocity-aware)
 * are specified in 02-MOTION.md §5.2 and are **not implemented here**. Both
 * belong with the completion sheet in Phase 1 (T1.19), which is the first
 * screen that opens one and the only place the from-the-button origin can
 * be wired. `motion.ts` carries `useArrival`, which is the rise half.
 * Never dismiss on scrim tap when the sheet holds unsaved input — ask.
 */
import { Pressable, Text, View } from 'react-native';

import { ELEVATION, RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { captionStyle } from './uiBase';

export interface SheetProps {
  visible: boolean;
  title?: string;
  children?: React.ReactNode;
  /** Bottom action bar content — primary action lives here. */
  actions?: React.ReactNode;
  /** Set when the sheet holds unsaved input: scrim tap asks, not dismisses. */
  hasUnsavedInput?: boolean;
  onDismiss: () => void;
  testID?: string;
}

export function Sheet({
  visible,
  title,
  children,
  actions,
  hasUnsavedInput = false,
  onDismiss,
  testID,
}: SheetProps): React.ReactNode {
  if (!visible) return null;
  return (
    <View testID={testID} style={{ alignSelf: 'stretch' }}>
      <Pressable
        testID={testID ? `${testID}-scrim` : undefined}
        accessibilityLabel={hasUnsavedInput ? 'Sheet holds unsaved input' : 'Close sheet'}
        onPress={() => {
          if (!hasUnsavedInput) onDismiss();
        }}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: ELEVATION.overlay.scrim,
        }}
      />
      <View
        style={{
          marginTop: 64,
          backgroundColor: SEMANTIC.bg.raised,
          borderTopLeftRadius: RADII.control,
          borderTopRightRadius: RADII.control,
          borderWidth: 1,
          borderColor: SEMANTIC.line.default,
          overflow: 'hidden',
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ width: 32, height: 4, borderRadius: 2, backgroundColor: SEMANTIC.line.stale }} />
        </View>
        {title ? (
          <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary, paddingHorizontal: SPACE[4], paddingVertical: SPACE[2] }}>
            {title}
          </Text>
        ) : null}
        <View style={{ paddingHorizontal: SPACE[4], paddingVertical: SPACE[3] }}>{children}</View>
        <View
          style={{
            minHeight: TAP.thumbBar,
            borderTopWidth: 1,
            borderTopColor: SEMANTIC.line.default,
            paddingHorizontal: SPACE[4],
            paddingVertical: SPACE[3],
            justifyContent: 'center',
          }}
        >
          {actions}
        </View>
      </View>
      <Text style={[captionStyle.caption, { paddingHorizontal: SPACE[4], paddingTop: 4 }]} testID={testID ? `${testID}-unsaved` : undefined}>
        {hasUnsavedInput ? 'Unsaved changes — confirm to close' : ''}
      </Text>
    </View>
  );
}
