/**
 * `PendingBadge` (PLAN-FRONTEND.md §5, UI/plan-2/03-COMPONENTS.md). The
 * persistent count of queued + inflight outbox rows, in the header on
 * every screen for offline roles. It answers the technician's one quiet
 * question — "is my work queued or lost?" — and doubles as the fastest
 * field diagnostic there is: a badge that only goes up is a sync failure,
 * visible without anyone opening a log.
 *
 * The count reads `mono` (Plex Sans tabular) so it does not jitter as it
 * changes. It renders NOTHING at zero — the drained state is quiet, per
 * the component spec ("disappears" when the queue empties) and per the
 * dashboard rule that permanent chrome trains people to ignore it. The
 * drain's per-item tick and exit motion are T1.17's polish; this is the
 * load-bearing minimum T1.15's offline cold start asserts on.
 */
import { Text, View } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';

export interface PendingBadgeProps {
  /** Queued + inflight rows for this employee (`pendingSyncCount`). */
  count: number;
  testID?: string;
}

export function PendingBadge({ count, testID }: PendingBadgeProps): React.ReactNode {
  if (count <= 0) return null;
  return (
    <View
      testID={testID}
      accessibilityLabel={`${count} ${count === 1 ? 'item' : 'items'} waiting to sync`}
      style={{
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        minHeight: 36,
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderBottomColor: SEMANTIC.line.default,
        backgroundColor: SEMANTIC.bg.dense,
      }}
    >
      <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary }} testID={testID ? `${testID}-count` : undefined}>
        {count} pending
      </Text>
    </View>
  );
}
