/**
 * `StatusPill` (03-COMPONENTS.md). A 8px dot in the status colour · the
 * status **word** in `slate.900` · 1px `line.default` border · `surface`
 * ground · radius 4. Reads the status colour map via `statusPillOf`;
 * never a raw hex, never a filled fill, never colour without the word —
 * the dot is decoration beside a word rather than the carrier of meaning
 * (`01-FOUNDATIONS.md` §1.6: no single ink works across the five status
 * fills, and the failure lands outdoors).
 */
import { Text, View } from 'react-native';

import { RADII, SEMANTIC, type JobStatus } from '@servgrid/shared';
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
        borderColor: SEMANTIC.line.default,
        borderRadius: RADII.control,
        backgroundColor: SEMANTIC.bg.raised,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <View testID={testID ? `${testID}-dot` : undefined} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pill.color }} />
      <Text testID={testID ? `${testID}-word` : undefined} style={{ ...textStyle('label'), color: SEMANTIC.text.primary }}>
        {pill.label}
      </Text>
    </View>
  );
}
