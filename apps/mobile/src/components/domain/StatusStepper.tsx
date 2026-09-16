/**
 * `StatusStepper` — the hero (03-COMPONENTS.md, 02-MOTION.md §5.1). The
 * ONE orchestrated moment in the product (`PLAN.md` §9), spent on the
 * thing a technician does most and cares about most: visible progress
 * through his day.
 *
 * Shape: horizontal, four nodes — Assigned → En route → In progress →
 * Completed — square, like every job object (the docket). Complete
 * segments fill in the status colour, pending stay `slate.200`, the
 * current node is ringed, and every node carries its word directly
 * beneath it: `in_progress` and `en_route` fail the 3:1 non-text floor
 * and are therefore NEVER colour without their word (`01-FOUNDATIONS.md`
 * §1.6).
 *
 * **A skipped `en_route` renders dimmed-but-present** (0.4, word in the
 * disabled ink) — a technician who went straight to work sees he skipped
 * a step, not a stepper that silently changed shape.
 *
 * **Cancelled is a fifth rendering, not a fifth node.** The line freezes
 * at the node the job reached, everything after goes `slate.200`, and a
 * cancelled-coloured terminal cap with the word **Cancelled** beneath it
 * closes the line. The frozen position IS the information. **No
 * animation** — nothing was achieved, so nothing fills.
 *
 * The advance choreography (§5.1), 520ms total, `transform` and
 * `opacity` only (§9), Reanimated worklets on the UI thread:
 *
 * - segment fill 0–320ms `enter` (scaleX from the leading edge)
 * - node pop 240–400ms `spring.press` (scale `1 → 1.15 → 1`)
 * - the label after the new position fades in 320–460ms
 * - (the job card's rail cross-fade 0–520ms lives on the screen that
 *   owns the rail — `JobDetailScreen` — which this component's
 *   `onAnimateStart` beat synchronises.)
 *
 * Haptics: `Light` on advance, `Success` on reaching Completed (§5.1).
 * Reduced motion removes the movement, never the feedback (§10): the
 * state still flips, the haptics still fire.
 *
 * Fires `onAnimateStart` exactly when an advance animation drives —
 * never on mount, never for a cancelled job. That is the test seam for
 * "no fill animation" and the screen's cue for its rail cross-fade.
 */
import { useEffect, useRef, Fragment } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { EASING, SEMANTIC, SPACE, SPRING, STATUS, type JobStatus } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { haptic } from '../ui/haptics';
import { easing } from '../ui/motion';
import { railColorOf } from '../../screens/technician/jobView';
import { stepperStateOf, type StepperNode } from '../../screens/technician/jobDetail';

const ENTER_EASING = easing(EASING.enter);

/** §5.1's choreography, in ms: fill 0–320, pop 240–400, label 320–460.
 * The rail (0–520) is the screen's; `DURATION.hero` is its total. */
const FILL_MS = 320;
const POP_DELAY_MS = 240;
const LABEL_DELAY_MS = 320;
const LABEL_MS = 460 - 320;

export interface StatusStepperProps {
  status: JobStatus;
  /** Statuses this device recorded for the job, in order — the skip
   * detector and the cancelled freeze point. */
  history?: readonly JobStatus[];
  /** Fires once per advance that animates. */
  onAnimateStart?: () => void;
  testID?: string;
}

export function StatusStepper({ status, history, onAnimateStart, testID }: StatusStepperProps): React.ReactNode {
  const model = stepperStateOf(status, history ?? []);
  const reducedMotion = useReducedMotion();

  // The hero's shared values. They rest at 1 (final state) so a mount
  // renders the standing position with no motion; only an advance while
  // mounted drives them.
  const fill = useSharedValue(1);
  const pop = useSharedValue(1);
  const nextLabel = useSharedValue(1);
  const previousIndex = useRef<number | null>(null);

  useEffect(() => {
    const index = model.reachedIndex;
    const previous = previousIndex.current;
    previousIndex.current = index;
    // Mount, terminal stillness, and anything that is not a forward
    // advance never animate. Cancelled especially: nothing was achieved,
    // so nothing fills.
    if (previous === null || model.cancelled || index <= previous) return;

    onAnimateStart?.();
    haptic('jobStatusAdvanced');
    if (model.nodes[index]?.key === 'completed') haptic('completionSynced');

    if (reducedMotion) {
      // Movement removed, feedback kept (§10): instant state flip.
      fill.value = 1;
      pop.value = 1;
      nextLabel.value = 1;
      return;
    }
    fill.value = 0;
    fill.value = withTiming(1, { duration: FILL_MS, easing: ENTER_EASING });
    pop.value = withDelay(
      POP_DELAY_MS,
      withSequence(withSpring(1.15, SPRING.press), withSpring(1, SPRING.press)),
    );
    nextLabel.value = 0;
    nextLabel.value = withDelay(LABEL_DELAY_MS, withTiming(1, { duration: LABEL_MS, easing: ENTER_EASING }));
  }, [model, reducedMotion, onAnimateStart, fill, pop, nextLabel]);

  return (
    <View testID={testID} style={{ alignSelf: 'stretch', marginVertical: SPACE[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        {model.nodes.map((node, index) => (
          <Fragment key={node.key}>
            {index > 0 ? (
              <Segment
                target={node}
                animatedFill={index === model.reachedIndex && !model.cancelled ? fill : null}
                testID={testID ? `${testID}-segment-${node.key}` : undefined}
              />
            ) : null}
            <NodeColumn
              node={node}
              nextLabelProgress={index === model.reachedIndex + 1 && !model.cancelled ? nextLabel : null}
              popScale={!model.cancelled && node.current ? pop : null}
              testID={testID ? `${testID}-node-${node.key}` : undefined}
            />
          </Fragment>
        ))}
        {model.cancelled ? <Cap testID={testID ? `${testID}-cap` : undefined} /> : null}
      </View>
    </View>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

/**
 * The node columns share the row evenly (2026-09-16). A fixed 76pt column
 * held five nodes 380pt wide — wider than the 379pt a 411pt phone leaves
 * inside its gutters, so the segments between them collapsed to nothing
 * and the last label sat against the edge. Flexible columns with a fixed
 * segment put every node on the same rhythm and keep both gutters.
 */
const NODE_COLUMN_WIDTH = 76;
const SEGMENT_WIDTH = 18;
/**
 * The node square and the ring that marks the current one (2026-09-16:
 * 14 and 22, up from 12 and 20). On the handset the twelve-pixel square
 * read as a speck beside its own label — the status of the job he is
 * standing in front of is not a detail, and the stepper is the screen's
 * hero.
 */
const NODE_SIZE = 14;
const NODE_RING = 22;

/** One node plus its word. Every colour renders DIRECTLY beside its word
 * (§1.6): the node square sits above the label, always. */
function NodeColumn({
  node,
  nextLabelProgress,
  popScale,
  testID,
}: {
  node: StepperNode;
  nextLabelProgress: SharedValue<number> | null;
  popScale: SharedValue<number> | null;
  testID?: string;
}): React.ReactNode {
  const colour = railColorOf(node.key);
  const reachedInk = !node.reached && !node.current;

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: popScale?.value ?? 1 }] }));

  const labelStyle = useAnimatedStyle(() => {
    if (nextLabelProgress === null) {
      return { color: reachedInk ? SEMANTIC.text.disabled : SEMANTIC.text.primary };
    }
    return {
      color: interpolateColor(
        nextLabelProgress.value,
        [0, 1],
        [SEMANTIC.text.disabled, SEMANTIC.text.primary],
      ),
    };
  });

  const nodeBox = (
    <View
      testID={testID ? `${testID}-dot` : undefined}
      style={{
        width: NODE_SIZE,
        height: NODE_SIZE,
        backgroundColor: node.reached ? colour : SEMANTIC.line.default, // pending: slate.200
      }}
    />
  );

  return (
    <View
      testID={testID}
      accessibilityLabel={node.current ? `${node.label}, current` : node.label}
      style={{
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        alignItems: 'center',
        // Dimmed-but-present: the skipped step keeps its shape and its
        // word, at under half strength.
        opacity: node.dimmed ? 0.4 : 1,
      }}
    >
      {node.current ? (
        <View
          style={{
            width: NODE_RING,
            height: NODE_RING,
            borderWidth: 2,
            borderColor: colour,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Animated.View style={[popStyle, { alignItems: 'center', justifyContent: 'center' }]}>{nodeBox}</Animated.View>
        </View>
      ) : (
        <View style={{ width: NODE_RING, height: NODE_RING, alignItems: 'center', justifyContent: 'center' }}>
          {nodeBox}
        </View>
      )}
      <Animated.Text
        numberOfLines={2}
        style={[{ ...textStyle('label'), textAlign: 'center' }, labelStyle]}
      >
        {node.label}
      </Animated.Text>
    </View>
  );
}

/** The segment leading INTO a node: `slate.200` track, the target's
 * colour filling left-to-right. Fill is `scaleX` from the leading edge —
 * transform only, never width (§9). */
function Segment({
  target,
  animatedFill,
  testID,
}: {
  target: StepperNode;
  animatedFill: SharedValue<number> | null;
  testID?: string;
}): React.ReactNode {
  const filled = target.reached; // a dimmed (skipped) target is never filled
  const fillStyle = useAnimatedStyle(() => {
    const scale = animatedFill === null ? (filled ? 1 : 0) : animatedFill.value;
    return { transform: [{ scaleX: scale }], transformOrigin: 'left' };
  });
  return (
    <View
      testID={testID}
      style={{
        width: SEGMENT_WIDTH,
        height: 3,
        borderRadius: 1.5,
        marginTop: 9.5, // centres the 3pt bar on the 22pt node ring
        backgroundColor: SEMANTIC.line.default,
        overflow: 'hidden',
      }}
    >
      <Animated.View style={[{ flex: 1, backgroundColor: railColorOf(target.key) }, fillStyle]} />
    </View>
  );
}

/**
 * The terminal cap — a fifth rendering, not a fifth node. The trailing
 * segment becomes a short `cancelled`-red bar closing on a red square,
 * and the word **Cancelled** sits beneath it in the body ink (the pill's
 * arithmetic: the colour marks the place, the word carries the meaning).
 * Static by construction: nothing here reads a shared value.
 */
function Cap({ testID }: { testID?: string }): React.ReactNode {
  return (
    <View testID={testID} style={{ width: NODE_COLUMN_WIDTH, alignItems: 'center' }}>
      <View style={{ width: NODE_RING, height: NODE_RING, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 8, height: 4, backgroundColor: STATUS.cancelled }} />
        <View style={{ width: NODE_SIZE, height: NODE_SIZE, backgroundColor: STATUS.cancelled }} />
      </View>
      <Text testID={testID ? `${testID}-label` : undefined} style={{ ...textStyle('label'), color: SEMANTIC.text.primary, textAlign: 'center' }}>
        Cancelled
      </Text>
    </View>
  );
}
