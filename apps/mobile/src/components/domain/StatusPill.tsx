/**
 * `StatusPill` (03-COMPONENTS.md, tinted 2026-09-16). The status **word**
 * in `slate.900`, on a ground tinted from the status colour, with the 8px
 * dot beside it in the full ink.
 *
 * It used to be an outlined chip on white, which made every status the
 * same shape on the same ground: a list of twelve jobs gave the eye
 * nothing to sort by, and the technician read twelve words to find the one
 * that mattered. The tint is the fix, and it stays inside the rule that
 * predates it: **the word is mandatory and the colour is redundant with
 * it.** The tint is a ground (`TINT.chip`), never an ink — the word keeps
 * `slate.900`, because no single ink clears 4.5:1 on all five status fills
 * (`01-FOUNDATIONS.md` §1.6), and this app is read outdoors.
 *
 * Read the pair together and the failure modes are gone: a colour-blind
 * technician reads the word, a technician in sunlight reads the word, and
 * a technician glancing at a list of twelve reads the colour.
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { alpha, FRAME, RADII, SEMANTIC, TINT, type JobStatus } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { statusPillOf } from '../../screens/technician/jobView';

export interface StatusPillProps {
  status: JobStatus;
  /**
   * On the navy frame (2026-09-16): the pill's ground goes solid light
   * instead of a tint of its own colour.
   *
   * A tint is `alpha(status, 0.14)` over *whatever is beneath it*, which
   * on white is a pale coloured chip and on slate.900 is a muddy wash —
   * the tint is derived from the status, not from the ground, so the one
   * thing the pill does (carry the status beside its word) stops working
   * the moment the ground changes. On the frame it takes the frame's own
   * light text colour as a solid ground, keeps the status dot in the full
   * ink, and keeps the word in slate.900: the same three parts, legible
   * on both grounds.
   */
  onFrame?: boolean;
  /**
   * Root-style override. The pill hugs its content by default
   * (`alignSelf: 'flex-start'`, which a column parent needs — otherwise
   * it stretches the full width), and `alignSelf` beats the parent's
   * `alignItems`, so a screen that wants it centred has to say so here
   * rather than from the outside. The job detail's navy bar centres the
   * status on the bar and passes that one property.
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function StatusPill({ status, onFrame = false, style, testID }: StatusPillProps): React.ReactNode {
  const pill = statusPillOf(status);
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          alignSelf: 'flex-start',
          borderWidth: 1,
          borderColor: onFrame ? FRAME.bgSoft : alpha(pill.color, TINT.chipLine),
          borderRadius: RADII.control,
          backgroundColor: onFrame ? FRAME.text : alpha(pill.color, TINT.chip),
          paddingHorizontal: 8,
          paddingVertical: 3,
        },
        style,
      ]}
    >
      <View testID={testID ? `${testID}-dot` : undefined} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pill.color }} />
      <Text testID={testID ? `${testID}-word` : undefined} style={{ ...textStyle('label'), color: SEMANTIC.text.primary }}>
        {pill.label}
      </Text>
    </View>
  );
}
