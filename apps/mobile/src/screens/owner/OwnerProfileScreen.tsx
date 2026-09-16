/**
 * O9 Profile (UI/plan-2/07-OWNER.md §O9). Name, username, *Change
 * password*, *Log out*, app version — and the **second owner account
 * reminder**: a line stating who else holds owner access, because the
 * recovery story depends on that account existing and being remembered.
 *
 * **No tracking chip. Owners are not tracked** — this module does not
 * import `TrackingHealthChip` or `PendingBadge`; the absence starts at
 * the import list, so no refactor can quietly put them back (the
 * dispatcher profile's rule). profile.test.tsx holds that line.
 *
 * The phone's Profile group carries three routes (Profile · Products ·
 * Services — the phone grouping puts the catalogue here because the
 * owner edits a price a few times a year), so the screen links to the
 * two settings tables the rail spreads out on desktop.
 *
 * Pure UI over injected seams; the route owns the session end.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Button } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { secondOwnerLine, type SecondOwner } from './model';

export interface OwnerProfileScreenProps {
  fullName: string;
  username: string;
  appVersion: string;
  /** Every OTHER owner account — the reminder's content. */
  otherOwners: readonly SecondOwner[];
  changePassword: () => void;
  logout: () => void;
  /** The catalogue lives under Profile in the phone grouping. */
  onOpenProducts?: () => void;
  onOpenServices?: () => void;
  testID?: string;
}

export function OwnerProfileScreen(props: OwnerProfileScreenProps): React.ReactNode {
  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'owner-profile'}>
      <Text style={styles.heading} testID="owner-profile-name">
        {props.fullName}
      </Text>
      <Text style={styles.caption} testID="owner-profile-username">
        {`Owner · ${props.username}`}
      </Text>

      <View style={styles.reminder} testID="owner-profile-second-owner">
        <Text style={styles.reminderText} testID="owner-profile-second-owner-line">
          {secondOwnerLine(props.otherOwners)}
        </Text>
      </View>

      <View style={styles.infoRow} testID="owner-profile-app-version">
        <Text style={styles.infoLabel}>App version</Text>
        <Text style={styles.infoValue}>{props.appVersion}</Text>
      </View>

      {props.onOpenProducts !== undefined || props.onOpenServices !== undefined ? (
        <View style={styles.settingsGroup} testID="owner-profile-settings">
          <Text style={styles.groupLabel}>CATALOGUE</Text>
          {props.onOpenProducts !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onOpenProducts}
              style={styles.groupRow}
              testID="owner-profile-products"
            >
              <Text style={styles.groupRowLabel}>Products</Text>
            </Pressable>
          ) : null}
          {props.onOpenServices !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onOpenServices}
              style={styles.groupRow}
              testID="owner-profile-services"
            >
              <Text style={styles.groupRowLabel}>Services</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Change password"
          variant="secondary"
          onPress={props.changePassword}
          fullwidth
          testID="owner-profile-change-password"
        />
        <Button label="Log out" variant="danger" onPress={props.logout} fullwidth testID="owner-profile-logout" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    // A form reads at a sentence's measure: centred and capped on the
    // desk instead of stretching fields edge to edge (a phone never
    // reaches the cap).
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[1],
  },
  caption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[4],
  },
  reminder: {
    alignSelf: 'stretch',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    padding: SPACE[3],
    marginBottom: SPACE[4],
  },
  reminderText: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
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
  settingsGroup: {
    alignSelf: 'stretch',
    marginTop: SPACE[4],
  },
  groupLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[1],
  },
  groupRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  groupRowLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  actions: {
    alignSelf: 'stretch',
    gap: SPACE[3],
    marginTop: SPACE[5],
  },
});
