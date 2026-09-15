/**
 * `JobCard` (UI/plan-2/03-COMPONENTS.md "field density", §T1 NEXT card,
 * §T2 list card). The most-seen object in the product: 4px square status
 * rail at the leading edge — the card's REAL status, always · customer +
 * area (`h2`) · job number (`mono`, right) · title (`body`) · scheduled
 * time (`mono`) · status pill (word + colour, never colour alone). 88
 * tall minimum, 1px border, no shadow, radius 0 — the docket.
 *
 * Two states this file owns the correctness of:
 *
 * - **Sending** (`pending`): a status write is on its way to the server —
 *   the dashed 2px `slate.400` inset plus `Sending…` in place of the job
 *   number. The rail keeps its status colour: the data is real.
 * - **Rejected** (§T2): the card **keeps its real status rail** and takes
 *   the stale dashed inset in `feedback.danger`, plus the server's
 *   one-line reason verbatim. The rail is NOT repainted red — `cancelled`
 *   is already `#B3261E`, and a red rail on a rejected card would read as
 *   an office cancellation, which a colour cannot tell apart from the
 *   opposite. Rail and inset are separate leading layers so the dashed
 *   inset never repaints the rail.
 *
 * Motion (02-MOTION.md §4.3): lists never animate on mount. The one
 * exception is a card arriving from a sync — `arrivedFromSync` fades it
 * in over 140ms (`quick`, `enter`; opacity + a 16pt rise, transform and
 * opacity only per §9). Under reduced motion it appears without movement.
 */
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { DURATION, EASING, RADII, SEMANTIC, SPACE, STALE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../ui/motion';
import { istTimeLabel, railColorOf, statusPillOf, type JobView } from '../../screens/technician/jobView';

export const RAIL_WIDTH = 4;

/** The contract chip from the job card's contract context (§T3:
 * "visit n of m" — the card carries `visitsRemaining`; the remaining
 * count is the load-bearing half, so that is what reads). */
export function contractChipLabel(visitsRemaining: number | null): string | null {
  if (visitsRemaining === null) return null;
  return `AMC · ${visitsRemaining} visit${visitsRemaining === 1 ? '' : 's'} left`;
}

export interface JobCardProps {
  view: JobView;
  /** Compact rows under LATER TODAY (§T1); the full card everywhere else. */
  compact?: boolean;
  onPress?: () => void;
  /** Inline actions for the NEXT card — *Navigate* + the primary. */
  actions?: React.ReactNode;
  /** A card the sync has just delivered: the list's one 140ms entrance. */
  arrivedFromSync?: boolean;
  testID?: string;
}

/** The arriving curve — `enter`, emphasised decelerate (§2). */
const ENTER_EASING = easing(EASING.enter);

/** Hoisted + memoised for FlashList (`02-MOTION.md` §9.3: renderItem is
 * never an inline arrow; a scroll never re-renders unchanged rows). */
export const MemoisedJobCard = memo(JobCard);

export function JobCard({ view, compact = false, onPress, actions, arrivedFromSync = false, testID }: JobCardProps): React.ReactNode {
  const { job } = view;
  const pill = statusPillOf(job.status);
  const rail = railColorOf(job.status);
  const rejected = view.rejectedMessage !== null;
  const contract = contractChipLabel(job.contract?.visitsRemaining ?? null);

  // The 140ms sync entrance — opacity + a 16pt rise. Runs once on mount,
  // and only when the list flags the row as genuinely new.
  const reducedMotion = useReducedMotion();
  const animateEntrance = arrivedFromSync && !reducedMotion;
  const entrance = useSharedValue(animateEntrance ? 0 : 1);
  if (animateEntrance) {
    entrance.value = withTiming(1, { duration: DURATION.quick, easing: ENTER_EASING });
  }
  const entranceStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateY: (1 - entrance.value) * 16 }],
  }));

  const numberText =
    view.pending && !rejected ? (
      <Text
        style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}
        testID={testID ? `${testID}-sending` : undefined}
      >
        Sending…
      </Text>
    ) : (
      <Text
        style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, textAlign: 'right' }}
        testID={testID ? `${testID}-number` : undefined}
      >
        {job.jobNumber}
      </Text>
    );

  return (
    <Animated.View
      testID={testID}
      style={[
        entranceStyle,
        {
          alignSelf: 'stretch',
          flexDirection: 'row',
          borderRadius: RADII.none,
          borderWidth: 1,
          borderColor: SEMANTIC.line.default,
          backgroundColor: SEMANTIC.bg.raised,
        },
      ]}
    >
      {/* Layer 1 — the real status rail, kept under every state (§T2). */}
      <View
        testID={testID ? `${testID}-rail` : undefined}
        style={{ width: RAIL_WIDTH, backgroundColor: rail }}
      />
      {/* Layer 2 — the stale/rejected dashed inset (§X5), slate for
          pending, `feedback.danger` for a rejection. A separate layer so
          its dash pattern never repaints the rail beside it. */}
      {view.pending || rejected ? (
        <View
          testID={testID ? `${testID}-inset` : undefined}
          style={{
            width: STALE.insetWidth,
            borderLeftWidth: STALE.insetWidth,
            borderLeftColor: rejected ? SEMANTIC.feedback.danger : STALE.insetColor,
            borderStyle: 'dashed',
            backgroundColor: SEMANTIC.bg.raised,
          }}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${view.customerName}, ${job.title}, ${pill.label}`}
        onPress={onPress}
        disabled={onPress === undefined}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: compact ? 56 : 88,
          padding: SPACE[3],
          backgroundColor: pressed ? SEMANTIC.bg.pressed : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[2] }}>
          <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary, flex: 1 }} numberOfLines={1}>
            {view.area === '' ? view.customerName : `${view.customerName} · ${view.area}`}
          </Text>
          {numberText}
        </View>
        {!compact ? (
          <Text
            style={{ ...textStyle('body'), color: SEMANTIC.text.primary, marginTop: SPACE[1] }}
            numberOfLines={2}
            testID={testID ? `${testID}-title` : undefined}
          >
            {job.title}
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: SPACE[2],
            marginTop: compact ? SPACE[1] : SPACE[2],
          }}
        >
          <Text
            style={{ ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}
            testID={testID ? `${testID}-time` : undefined}
          >
            {job.scheduledFor === null ? 'No time' : istTimeLabel(job.scheduledFor)}
          </Text>
          {!compact && contract !== null ? (
            <Text
              style={{
                ...textStyle('label'),
                color: SEMANTIC.text.secondary,
                borderWidth: 1,
                borderColor: SEMANTIC.line.default,
                borderRadius: RADII.control,
                paddingHorizontal: 8,
                paddingVertical: 2,
              }}
            >
              {contract}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: compact ? 0 : SPACE[2] }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: pill.color,
              marginRight: 6,
            }}
          />
          <Text style={{ ...textStyle('label'), color: SEMANTIC.text.primary }} testID={testID ? `${testID}-status` : undefined}>
            {pill.label}
          </Text>
        </View>
        {rejected ? (
          <Text
            style={{ ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: SPACE[2] }}
            numberOfLines={2}
            testID={testID ? `${testID}-rejected` : undefined}
          >
            {view.rejectedMessage}
          </Text>
        ) : null}
        {actions ?? null}
      </Pressable>
    </Animated.View>
  );
}
