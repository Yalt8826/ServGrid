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

import { FRAME, ICON, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, EmptyState } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { creditView } from './money';
import { lastActivityOf, type CompanyRow } from './model';

export interface CompaniesScreenProps {
  rows: CompanyRow[];
  error: string | null;
  loading: boolean;
  onOpenCompany: (companyId: string) => void;
  onNewSale: () => void;
  /** The rep's own create — the server stamps him as the owner. */
  onNewCompany: () => void;
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
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'rep-companies'}>
      {/* The frame (2026-09-18): what this is, how many accounts, and the
          two doors — a new account, or a sale against one of them. */}
      <View style={styles.frame}>
        <View style={styles.frameHead}>
          <View style={styles.frameBody}>
            <Text style={styles.frameTitle}>Companies</Text>
            <Text style={styles.frameCaption}>
              {`${props.rows.length} ${props.rows.length === 1 ? 'account' : 'accounts'}`}
            </Text>
          </View>
        </View>
        <View style={styles.frameActions}>
          <View style={styles.frameAction}>
            <Button label="New sale" icon="plus" variant="secondary" onPress={props.onNewSale} fullwidth testID="companies-new-sale" />
          </View>
          <View style={styles.frameAction}>
            <Button label="New account" icon="plus" variant="primary" onPress={props.onNewCompany} fullwidth testID="companies-new-company" />
          </View>
        </View>
      </View>

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
              style={styles.card}
              testID={`company-row-${row.companyId}`}
            >
              {/* The rail says the account's state the way the dashboard's
                  owed cards do: money to collect is danger, money held is
                  success, an account with no history is neutral. The balance
                  TEXT keeps `creditView`'s own rule (a credit is coloured,
                  a debt is plain) — the rail is the glance, the text is the
                  figure (2026-09-18). */}
              <View
                style={[
                  styles.rail,
                  {
                    backgroundColor:
                      row.balance === null
                        ? SEMANTIC.line.strong
                        : Number(row.balance) > 0
                          ? SEMANTIC.feedback.danger
                          : SEMANTIC.feedback.success,
                  },
                ]}
              />
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
              <Icon name="chevronRight" size={ICON.sm} color={SEMANTIC.text.secondary} />
            </Pressable>
          );
        })
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
  },
  frame: {
    backgroundColor: FRAME.bg,
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    marginBottom: SPACE[4],
    gap: SPACE[3],
  },
  frameHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE[3] },
  frameBody: { flex: 1, gap: 2 },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  /** The two create doors share the frame's second line. */
  frameActions: { flexDirection: 'row', gap: SPACE[2] },
  frameAction: { flex: 1 },
  /** A row is a card: air between, hairline round, the rail leading. */
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    marginTop: SPACE[2],
    paddingRight: SPACE[3],
    paddingVertical: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rail: { alignSelf: 'stretch', width: 4 },
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
