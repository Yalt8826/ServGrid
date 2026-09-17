/**
 * Password change (UI/plan-2/08-SHARED-SCREENS.md §X2), in two shapes.
 *
 * **Forced** — shown when `mustChangePassword`: not skippable, not
 * dismissible, no back (the hardware back button is swallowed), because
 * the password the session holds is temporary and the flow is not
 * finished until it is replaced. The current password rides from the
 * login in the session store, so the form asks only what §X2 specifies:
 * new password and confirm.
 *
 * **Voluntary** — reached from a profile (§T7/§D6/§O9 "Change password").
 * Here nobody holds the current password, so the form ASKS for it, the
 * lede stops claiming the old one was temporary, and back is allowed:
 * the person tapped a button and must be able to walk away. Profile
 * buttons used to push `/change-password`, which is the forced route — it
 * redirects to `/login` without a temporary password in the session, so
 * "Change password" signed the user out (reported on the handset,
 * 2026-09-17).
 *
 * The rules are stated BEFORE typing ("At least 8 characters." sits in
 * the field's helper text on arrival), not delivered as errors after.
 * On success: `NotificationSuccess`, then straight on — no interstitial.
 */
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';

import { LAYOUT, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, TextField } from '../components/ui';
import { haptic } from '../components/ui/haptics';
import { textStyle } from '../fonts/textStyle';
import type { ApiClient } from '../lib/apiClient';
import { SecureToggle } from './SecureToggle';

const LENGTH_RULE = 'At least 8 characters.';
const LENGTH_ERROR = 'Use at least 8 characters.';
const MISMATCH_ERROR = 'Passwords do not match.';

export interface ChangePasswordScreenProps {
  api: ApiClient;
  /**
   * The temporary password this session just signed in with. Omitted when
   * the change was started from a profile: the form asks for it instead.
   */
  currentPassword?: string;
  /** Called after the server accepts the new password. */
  onComplete: () => void;
  /**
   * The way out of the VOLUNTARY flow — a profile's own screen can be
   * left. Absent in the forced flow, which is not dismissible.
   */
  onCancel?: () => void;
}

const MISSING_CURRENT_ERROR = 'Enter the password you use now.';

export function ChangePasswordScreen({
  api,
  currentPassword,
  onComplete,
  onCancel,
}: ChangePasswordScreenProps): React.ReactNode {
  // The forced flow holds the temporary password; the voluntary one asks.
  const forced = currentPassword !== undefined;
  const [current, setCurrent] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(true);
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // §X2: no back in the forced flow. A hardware back here must not land on
  // a route that pretends the password was already changed.
  useEffect(() => {
    if (!forced) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [forced]);

  async function submit(): Promise<void> {
    if (pending) return;
    setBanner(null);
    const currentMissing = !forced && current === '';
    const short = newPassword.length < 8;
    setCurrentError(currentMissing ? MISSING_CURRENT_ERROR : null);
    setNewError(short ? LENGTH_ERROR : null);
    setConfirmError(confirm !== newPassword ? MISMATCH_ERROR : null);
    if (currentMissing || short || confirm !== newPassword) return;
    setPending(true);
    try {
      const result = await api.request('POST', '/v1/auth/password', {
        body: { currentPassword: forced ? currentPassword : current, newPassword },
      });
      if (result.ok) {
        haptic('passwordChanged');
        onComplete();
      } else {
        setBanner(result.error?.message ?? 'The password could not be changed. Try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Choose a new password</Text>
      <Text style={styles.lede}>
        {forced
          ? 'The password you were given is temporary. Pick one only you know — you will not be asked again.'
          : 'Pick one only you know. You stay signed in — nothing else changes.'}
      </Text>

      {banner !== null ? (
        <Banner tone="danger" message={banner} testID="change-password-banner" />
      ) : null}

      {forced ? null : (
        <>
          <TextField
            label="Current password"
            value={current}
            onChangeText={(v) => {
              setCurrent(v);
              if (currentError !== null) setCurrentError(null);
            }}
            errorText={currentError ?? undefined}
            disabled={pending}
            secureTextEntry={!visible}
            testID="change-password-current"
          />
          <View style={styles.gap} />
        </>
      )}

      <TextField
        label="New password"
        value={newPassword}
        onChangeText={(v) => {
          setNewPassword(v);
          if (newError !== null) setNewError(null);
        }}
        helperText={LENGTH_RULE}
        errorText={newError ?? undefined}
        disabled={pending}
        secureTextEntry={!visible}
        trailing={
          <SecureToggle
            visible={visible}
            onToggle={() => setVisible((v) => !v)}
            testID="change-password-toggle"
          />
        }
        testID="change-password-new"
      />
      <View style={styles.gap} />
      <TextField
        label="Confirm new password"
        value={confirm}
        onChangeText={(v) => {
          setConfirm(v);
          if (confirmError !== null) setConfirmError(null);
        }}
        errorText={confirmError ?? undefined}
        disabled={pending}
        secureTextEntry={!visible}
        testID="change-password-confirm"
      />

      <Button
        label="Save new password"
        onPress={() => void submit()}
        loading={pending}
        fullwidth
        testID="change-password-submit"
      />
      {onCancel === undefined ? null : (
        <View style={styles.cancelWrap}>
          <Button
            label="Cancel"
            variant="ghost"
            onPress={onCancel}
            disabled={pending}
            fullwidth
            testID="change-password-cancel"
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    padding: SPACE[4],
    width: '100%',
    maxWidth: LAYOUT.formMaxWidth,
    alignSelf: 'center',
  },
  heading: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    marginTop: SPACE[6],
    marginBottom: SPACE[2],
  },
  lede: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[5],
  },
  gap: { height: SPACE[3] },
  cancelWrap: { marginTop: SPACE[2] },
});
