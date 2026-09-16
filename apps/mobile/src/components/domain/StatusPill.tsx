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
import { Text, View } from 'react-native';

import { alpha, RADII, SEMANTIC, TINT, type JobStatus } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { statusPillOf } from '../../screens/technician/jobView';

export interface StatusPillProps {
  status: JobStatus;
  testID?: string;
}

export function StatusPill({ status, testID }: StatusPillProps): React.ReactNode {
  const pill = statusPillOf(status);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: alpha(pill.color, TINT.chipLine),
        borderRadius: RADII.control,
        backgroundColor: alpha(pill.color, TINT.chip),
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <View testID={testID ? `${testID}-dot` : undefined} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pill.color }} />
      <Text testID={testID ? `${testID}-word` : undefined} style={{ ...textStyle('label'), color: SEMANTIC.text.primary }}>
        {pill.label}
      </Text>
    </View>
  );
}
