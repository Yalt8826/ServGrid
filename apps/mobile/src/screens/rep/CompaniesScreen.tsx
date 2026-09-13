/**
 * S4 Companies — the list (UI/plan-2/06-SALES-REP.md §S4). Rows: company
 * · balance (mono, right) · last activity, sorted by balance descending.
 * House accounts carry a small `Shared` chip.
 *
 * **He sees his accounts plus house accounts. The UI never hints that
 * other accounts exist** — no greyed rows, no "12 more": the server
 * scopes the list (`owner_rep_id = him OR NULL`), and these tests prove
 * the rendered tree from an isolated fixture, not only the payload.
 *
 * **No reassign-owner control** — only the owner can move an account, and
 * a disabled button here would only invite the question. It is absent by
 * construction, not disabled.
 *
 * A negative balance renders through `creditView` — the word Credit in
 * `feedback.success`, never a minus sign in red.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, EmptyState } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView } from './money';
import { lastActivityOf, type CompanyRow } from './model';

export interface CompaniesScreenProps {
  rows: CompanyRow[];
  error: string | null;
  loading: boolean;
  onOpenCompany: (companyId: string) => void;
  onNewSale: () => void;
  onRetry: () => void;
  testID?: string;
}

/** The static `Shared` chip — a label, not a control. */
export function SharedChip({ testID }: { testID?: string }): React.ReactNode {
  return (
    <View style={chipStyles.shell} testID={testID}>
      <Text style={chipStyles.label}>Shared</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  shell: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.strong,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  label: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
});

export function CompaniesScreen(props: CompaniesScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();
  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'rep-companies'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="companies-error" />
      ) : null}

      {!props.loading && props.error === null && props.rows.length === 0 ? (
        <EmptyState message="No accounts yet." testID="companies-empty" />
      ) : (
        props.rows.map((row) => {
          const balance = row.balance === null ? null : creditView(row.balance);
          const lastActivity = lastActivityOf(row);
          return (
            <Pressable
              key={row.companyId}
              accessibilityRole="button"
              onPress={() => props.onOpenCompany(row.companyId)}
              style={styles.row}
              testID={`company-row-${row.companyId}`}
            >
              <View style={styles.main}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>{row.name}</Text>
                  {row.shared ? <SharedChip testID={`company-shared-chip-${row.companyId}`} /> : null}
                </View>
                <Text style={styles.activity}>
                  {lastActivity === null ? 'No activity yet' : `Last activity ${formatDateEnIN(lastActivity, nowYear)}`}
                </Text>
              </View>
              {balance !== null ? (
                <Text style={[styles.balance, { color: balance.color }]} testID={`company-balance-${row.companyId}`}>
                  {balance.text}
                </Text>
              ) : null}
            </Pressable>
          );
        })
      )}

      <Button label="+ New sale" variant="secondary" onPress={props.onNewSale} testID="companies-new-sale" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  main: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  name: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  activity: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  balance: {
    ...textStyle('mono'),
    fontVariant: ['tabular-nums'],
  },
});
