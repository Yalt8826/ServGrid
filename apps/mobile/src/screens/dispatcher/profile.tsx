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

import { FRAME, RADII, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Button, SectionHeader, useDensity } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
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
  const density = useDensity();
  // The ScrollView carries the app's ground, not just the content: a navy
  // bar above a transparent scroll leaves a stripe where the content runs
  // out (found on the technician's profile, 2026-09-16).
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="dispatcher-profile-screen"
    >
      {/* The navy frame: who is signed in, on the console's own ground. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="dispatcher-profile-name">
          {deps.fullName}
        </Text>
        <Text style={styles.frameCaption} testID="dispatcher-profile-username">
          {`Dispatcher · ${deps.username}`}
        </Text>
      </View>

      <View style={styles.body}>
        <SectionHeader label="App" icon="info" />
        <View style={styles.panel}>
          <View style={styles.infoRow} testID="dispatcher-profile-app-version">
            <Icon name="info" size={16} color={SEMANTIC.text.secondary} />
            <Text style={[styles.infoLabel, textStyle('body', density)]}>App version</Text>
            <Text style={styles.infoValue}>{deps.appVersion}</Text>
          </View>
        </View>

        <View style={styles.account}>
          <SectionHeader label="Account" icon="key" />
          <View style={styles.actions}>
            <Button
              label="Change password"
              icon="key"
              variant="secondary"
              onPress={deps.changePassword}
              fullwidth
              testID="dispatcher-profile-change-password"
            />
            <Button
              label="Log out"
              icon="logout"
              variant="danger"
              onPress={deps.logout}
              fullwidth
              testID="dispatcher-profile-logout"
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: SEMANTIC.bg.app },
  content: { paddingBottom: SPACE[8] },
  frame: {
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[3],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  body: { paddingHorizontal: SPACE[4], paddingTop: SPACE[3] },
  panel: {
    alignSelf: 'stretch',
    marginTop: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  infoRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  infoLabel: { color: SEMANTIC.text.secondary, flex: 1 },
  infoValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  account: { marginTop: SPACE[5] },
  actions: {
    alignSelf: 'stretch',
    gap: SPACE[3],
    marginTop: SPACE[3],
  },
});
