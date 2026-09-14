/**
 * The deactivation 409, rendered (§O7): **a list of the blocking rows
 * with links, not an error message.** The owner's next action is to
 * reassign them, and the screen hands him that work rather than
 * describing it — jobs link to the job, companies to the account whose
 * reassignment control lives on the owner's companies screens, cash to
 * the reconciliation queue. Only an undrained outbox row renders
 * unlinked, because there is no screen that drains it — the evidence
 * says wait.
 *
 * The three deactivation conditions are the first three kinds; the
 * fourth (outbox) rides only on a role change out of an offline role.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import {
  blockingRowLabel,
  blockingRowRoute,
  blockingRowSection,
  type BlockingRow,
} from './model';

export interface BlockingRowsProps {
  rows: readonly BlockingRow[];
  onOpen: (route: string) => void;
  testID?: string;
}

export function BlockingRows({ rows, onOpen, testID }: BlockingRowsProps): React.ReactNode {
  // Group by section, in first-appearance order — jobs, then accounts,
  // then cash, then outbox, matching the server's collection order.
  const sections: { title: string; rows: BlockingRow[] }[] = [];
  for (const row of rows) {
    const title = blockingRowSection(row);
    let section = sections.find((s) => s.title === title);
    if (section === undefined) {
      section = { title, rows: [] };
      sections.push(section);
    }
    section.rows.push(row);
  }

  return (
    <View style={styles.root} testID={testID ?? 'blocking-rows'}>
      <Text style={styles.headline} testID="blocking-rows-headline">
        Deactivation is blocked — clear these first:
      </Text>
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.rows.map((row, index) => {
            const route = blockingRowRoute(row);
            const label = blockingRowLabel(row);
            const rowTestID = `blocking-row-${row.kind}-${row.id}`;
            return route !== null ? (
              <Pressable
                key={`${row.kind}-${row.id}-${index}`}
                accessibilityRole="link"
                onPress={() => onOpen(route)}
                style={styles.row}
                testID={rowTestID}
              >
                <Text style={styles.rowLink}>{label}</Text>
                <Text style={styles.rowAction}>{'Open'}</Text>
              </Pressable>
            ) : (
              <View key={`${row.kind}-${row.id}-${index}`} style={styles.row} testID={rowTestID}>
                <Text style={styles.rowPlain}>{label}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignSelf: 'stretch',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.feedback.danger,
    padding: SPACE[3],
    gap: SPACE[1],
  },
  headline: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.feedback.danger,
    marginBottom: SPACE[1],
  },
  section: {
    marginBottom: SPACE[2],
  },
  sectionTitle: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: SPACE[2],
  },
  rowLink: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
    textDecorationLine: 'underline',
  },
  rowAction: {
    ...textStyle('label'),
    color: SEMANTIC.feedback.danger,
  },
  rowPlain: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
    flex: 1,
  },
});
