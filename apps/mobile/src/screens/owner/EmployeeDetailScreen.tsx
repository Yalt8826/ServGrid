/**
 * O7 Employees — the detail (UI/plan-2/07-OWNER.md §O7). Identity, role,
 * the tracking health chip, and **device diagnostics**: manufacturer ·
 * model · OS · app version · location permission · battery-optimisation
 * exemption · autostart confirmed · notifications enabled — all eight,
 * per install. **This is an equipment record, not a profile page**: OEM
 * task-killing is the project's dominant risk, and the per-handset
 * record of which mitigations were completed is the evidence base for
 * the Phase 5 investigation.
 *
 * **Deactivation:** the 409 renders as BlockingRows — the linked list of
 * blocking rows — not an error message.
 *
 * Pure UI over injected deps; the route owns the PATCH and the routes
 * the links open.
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DeviceDiagnostic, TrackingHealth } from '@servgrid/shared';
import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, ConfirmDialog } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { TrackingHealthChip } from '../../components/domain/TrackingHealthChip';
import { BlockingRows } from './BlockingRows';
import { diagnosticRowsOf, type BlockingRow, type DiagnosticRow } from './model';

export interface OwnerEmployeeDetailScreenProps {
  identity: {
    fullName: string;
    username: string;
    role: string;
    phone: string | null;
    isActive: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  };
  /** The roster's health word for this employee, if the read landed. */
  health: TrackingHealth | null;
  devices: DeviceDiagnostic[];
  error: string | null;
  /** The 409's blocking rows — null until a refused deactivation. */
  blocking: BlockingRow[] | null;
  busy: boolean;
  onDeactivate: () => void;
  onConfirmDeactivate: () => void;
  onCancelDeactivate: () => void;
  deactivateDialogOpen: boolean;
  onOpenLink: (route: string) => void;
  /** The health chip's fix tap — the owner cannot fix a handset that is
   * not his; the route decides (usually nothing). */
  onHealthFix?: (target: 1 | 2 | 3 | 4 | 'notifications') => void;
  onRetry: () => void;
  testID?: string;
}

export function OwnerEmployeeDetailScreen(props: OwnerEmployeeDetailScreenProps): React.ReactNode {
  const nowYear = new Date().getFullYear();
  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'owner-employee-detail'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-employee-error" />
      ) : null}

      <View testID="employee-identity">
        <Text style={styles.name} testID="employee-detail-name">
          {props.identity.fullName}
        </Text>
        <Text style={styles.meta} testID="employee-detail-username">
          {`${props.identity.username} · ${props.identity.role}`}
        </Text>
        {props.identity.phone !== null ? (
          <Text style={styles.meta} testID="employee-detail-phone">
            {props.identity.phone}
          </Text>
        ) : null}
        <Text style={styles.meta} testID="employee-detail-active">
          {props.identity.isActive ? 'Active' : 'Deactivated'}
        </Text>
        <Text style={styles.meta} testID="employee-detail-last-login">
          {`Last login ${props.identity.lastLoginAt === null ? 'never' : formatDateEnIN(props.identity.lastLoginAt.slice(0, 10), nowYear)}`}
        </Text>
      </View>

      {props.health !== null ? (
        <TrackingHealthChip health={props.health} onFix={props.onHealthFix} testID="employee-health-chip" />
      ) : null}

      <Text style={styles.sectionLabel}>DEVICE DIAGNOSTICS</Text>
      {props.devices.length === 0 ? (
        <Text style={styles.emptyLine} testID="employee-devices-empty">
          No device has reported for this account. The mitigations below are unknown because no handset ever checked in.
        </Text>
      ) : (
        props.devices.map((device, deviceIndex) => {
          const rows: DiagnosticRow[] = diagnosticRowsOf(device);
          return (
            <View key={device.id} style={styles.device} testID={`device-${device.id}`}>
              <Text style={styles.deviceTitle} testID={`device-title-${device.id}`}>
                {`Device ${deviceIndex + 1}${device.manufacturer !== null || device.model !== null ? ` · ${device.manufacturer ?? '?'} ${device.model ?? ''}`.trimEnd() : ''}`}
              </Text>
              {rows.map((row) => (
                <View key={row.key} style={styles.diagRow} testID={`diagnostic-${row.key}`}>
                  <Text style={styles.diagLabel}>{row.label}</Text>
                  <Text
                    style={[
                      styles.diagValue,
                      row.ok === false ? { color: SEMANTIC.feedback.danger } : null,
                      row.ok === null ? { color: SEMANTIC.text.secondary } : null,
                    ]}
                    testID={`diagnostic-value-${row.key}`}
                  >
                    {row.value}
                  </Text>
                </View>
              ))}
              <Text style={styles.deviceMeta} testID={`device-last-seen-${device.id}`}>
                {`Last seen ${device.lastSeenAt === null ? 'never' : formatDateEnIN(device.lastSeenAt.slice(0, 10), nowYear)} · ${device.isActive ? 'active' : 'inactive'}`}
              </Text>
            </View>
          );
        })
      )}

      {props.blocking !== null ? <BlockingRows rows={props.blocking} onOpen={props.onOpenLink} testID="deactivate-blocking" /> : null}

      {props.identity.isActive ? (
        <Button
          label="Deactivate"
          variant="danger"
          disabled={props.busy}
          loading={props.busy}
          onPress={props.onDeactivate}
          fullwidth
          testID="employee-deactivate"
        />
      ) : null}

      <ConfirmDialog
        visible={props.deactivateDialogOpen}
        title="Deactivate"
        message="Every session ends, the roster drops him, and his devices mark inactive. Open work blocks it — the list will name it."
        confirmLabel="Deactivate"
        onCancel={props.onCancelDeactivate}
        onConfirm={props.onConfirmDeactivate}
        testID="employee-deactivate-dialog"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  name: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
  },
  meta: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[3],
    marginBottom: SPACE[1],
  },
  device: {
    alignSelf: 'stretch',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    padding: SPACE[3],
    gap: SPACE[1],
    marginBottom: SPACE[2],
  },
  deviceTitle: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    marginBottom: SPACE[1],
  },
  diagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    gap: SPACE[3],
  },
  diagLabel: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    flex: 1,
  },
  diagValue: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    textAlign: 'right',
  },
  deviceMeta: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[1],
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
});
