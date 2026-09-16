/**
 * `EmptyState` (03-COMPONENTS.md, glyph added 2026-09-16). One line of
 * `body` stating the situation, one `secondary` button offering the next
 * action. **No illustration, no mascot, no exclamation mark.** Empty is
 * not always failure — "Nothing needs attention" should read as good news.
 *
 * The optional `icon` is a single glyph naming the *object* that is
 * absent (a calendar for "nothing scheduled", a list for "no jobs"), never
 * a mood about it: it answers "what is missing here" at a glance on a
 * screen that is otherwise one grey sentence floating in white. An
 * illustration would say something; this says which list is empty. It
 * renders in `slate.300` — present enough to hold the space, quiet enough
 * that the sentence is still what is read.
 */
import { Text, View } from 'react-native';

import { ICON, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Button } from './Button';
import { Icon, type IconName } from './icons';

export interface EmptyStateProps {
  /** States the situation plainly, for the person looking at it. */
  message: string;
  /** The object that is absent — see the note above. Omitted, this is text alone. */
  icon?: IconName;
  /** The next action — optional: an informational empty has none. */
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}

export function EmptyState({ message, icon, actionLabel, onAction, testID }: EmptyStateProps): React.ReactNode {
  return (
    <View testID={testID} style={{ alignItems: 'center', paddingVertical: SPACE[8], paddingHorizontal: SPACE[4] }}>
      {icon === undefined ? null : (
        <Icon name={icon} size={ICON.xl} color={SEMANTIC.text.disabled} testID={testID ? `${testID}-icon` : undefined} />
      )}
      <Text
        style={{
          ...textStyle('body'),
          color: SEMANTIC.text.primary,
          textAlign: 'center',
          marginTop: icon === undefined ? 0 : SPACE[3],
        }}
      >
        {message}
      </Text>
      {actionLabel && onAction ? (
        <View style={{ marginTop: SPACE[4] }}>
          <Button label={actionLabel} variant="secondary" onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}
