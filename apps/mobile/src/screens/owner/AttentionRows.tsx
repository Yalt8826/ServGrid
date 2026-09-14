/**
 * The attention feed as rows (T4.8, UI/plan-2/07-OWNER.md §O1) — the
 * phone presentation of "needs attention", and the shape every density
 * degrades to when the desk table is not available. A row is a row, not
 * a card grid: severity on the leading rail, the trouble in `bodyStrong`,
 * the specifics beneath, the flag word right-aligned — the scannable left
 * edge the role's screens share. The row itself is the tap target; it
 * pushes the thing (`target`), never a list the thing lives in.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import type { AttentionRowVm } from './model';

export function AttentionRows({
  rows,
  onOpen,
  testIDPrefix,
}: {
  rows: AttentionRowVm[];
  onOpen: (target: string) => void;
  testIDPrefix: string;
}): React.ReactNode {
  return (
    <View testID="owner-attention-rows">
      {rows.map((row, index) => (
        <Pressable
          key={row.key}
          testID={`${testIDPrefix}-${index}`}
          accessibilityRole="button"
          accessibilityLabel={`${row.title} — ${row.note}`}
          onPress={() => onOpen(row.target)}
          style={styles.row}
        >
          <View
            testID={`${testIDPrefix}-${index}-rail`}
            style={[styles.rail, { backgroundColor: row.severity === 'danger' ? SEMANTIC.feedback.danger : SEMANTIC.feedback.warning }]}
          />
          <View style={styles.body}>
            <Text numberOfLines={1} style={[textStyle('bodyStrong'), styles.title]}>
              {row.title}
            </Text>
            <Text numberOfLines={1} style={[textStyle('caption'), styles.meta]}>
              {row.meta}
            </Text>
          </View>
          <Text numberOfLines={1} style={[textStyle('caption'), styles.note, { color: row.severity === 'danger' ? SEMANTIC.feedback.danger : SEMANTIC.feedback.warning }]}>
            {row.note}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    gap: 12,
    paddingVertical: 8,
  },
  rail: {
    width: 3,
    alignSelf: 'stretch',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: SEMANTIC.text.primary,
  },
  meta: {
    color: SEMANTIC.text.secondary,
  },
  note: {
    maxWidth: 150,
    textAlign: 'right',
  },
});
