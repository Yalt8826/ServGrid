/**
 * `EmptyState` (03-COMPONENTS.md). One line of `body` stating the
 * situation, one `secondary` button offering the next action. **No
 * illustration, no mascot, no exclamation mark.** Empty is not always
 * failure — "Nothing needs attention" should read as good news.
 */
import { Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Button } from './Button';

export interface EmptyStateProps {
  /** States the situation plainly, for the person looking at it. */
  message: string;
  /** The next action — optional: an informational empty has none. */
  actionLabel?: string;
  onAction?: () => void;
  /** The empty view reflects rows the server has not confirmed. */
  stale?: boolean;
  testID?: string;
}

export function EmptyState({ message, actionLabel, onAction, stale = false, testID }: EmptyStateProps): React.ReactNode {
  return (
    <View testID={testID} style={{ alignItems: 'center', paddingVertical: SPACE[8], paddingHorizontal: SPACE[4] }}>
      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, textAlign: 'center' }}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <View style={{ marginTop: SPACE[4] }}>
          <Button label={actionLabel} variant="secondary" onPress={onAction} />
        </View>
      ) : null}
      {stale ? (
        <Text style={{ marginTop: SPACE[2], ...textStyle('caption'), color: SEMANTIC.text.secondary }}>
          Pending sync
        </Text>
      ) : null}
    </View>
  );
}
