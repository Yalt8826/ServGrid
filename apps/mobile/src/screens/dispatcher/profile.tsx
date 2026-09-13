/**
 * D6 Profile (T2.10, UI/plan-2/05-DISPATCHER.md §D6) — self only. Name,
 * username, *Change password*, *Log out*, app version.
 *
 * **No pending badge, no sync state, no tracking chip.** Dispatchers
 * hold no device state and are not tracked; showing them a sync UI
 * would imply an offline capability they do not have and should not
 * rely on. This module does not even import `PendingBadge` or
 * `TrackingHealthChip` — the absence starts at the import list, so no
 * refactor can quietly put them back on this screen.
 *
 * **Logout is immediate** — there is nothing queued to lose. No dialog
 * exists on this screen: the technician's logout is a gated handover
 * (PLAN-FRONTEND.md §5), and the dispatcher's is the deliberate
 * opposite, because the dispatcher's session holds nothing of his own.
 *
 * Pure UI over injected seams (`DispatcherProfileDeps`); the route owns
 * the session end, exactly as the technician's profile route does.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Button } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

export interface DispatcherProfileDeps {
  /** The employee's full name, degrading to the username — the same
   * resolve-into-state rule the technician's profile uses. */
  fullName: string;
  username: string;
  appVersion: string;
  changePassword: () => void;
  /** Called the moment *Log out* is tapped — no confirmation, nothing
   * to lose (§D6). The route ends the session behind this seam. */
  logout: () => void;
}

export function DispatcherProfileScreen(deps: DispatcherProfileDeps): React.ReactNode {
  return (
    <ScrollView contentContainerStyle={styles.content} testID="dispatcher-profile-screen">
      <Text style={styles.heading} testID="dispatcher-profile-name">
        {deps.fullName}
      </Text>
      <Text style={styles.caption} testID="dispatcher-profile-username">
        {`Dispatcher · ${deps.username}`}
      </Text>

      <View style={styles.infoRow} testID="dispatcher-profile-app-version">
        <Text style={styles.infoLabel}>App version</Text>
        <Text style={styles.infoValue}>{deps.appVersion}</Text>
      </View>

      <View style={styles.actions}>
        <Button
          label="Change password"
          variant="secondary"
          onPress={deps.changePassword}
          fullwidth
          testID="dispatcher-profile-change-password"
        />
        <Button label="Log out" variant="danger" onPress={deps.logout} fullwidth testID="dispatcher-profile-logout" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[1],
  },
  caption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[5],
  },
  infoRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  infoLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  infoValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    alignSelf: 'stretch',
    gap: SPACE[3],
    marginTop: SPACE[5],
  },
});
