/**
 * Forced password change (UI/plan-2/08-SHARED-SCREENS.md §X2). Shown
 * when `mustChangePassword`. Not skippable, not dismissible, no back —
 * the hardware back button is swallowed along with any header gesture.
 *
 * The rules are stated BEFORE typing ("At least 8 characters." sits in
 * the field's helper text on arrival), not delivered as errors after.
 * On success: `NotificationSuccess`, then straight on — no
 * interstitial. The current (temporary) password rides from the login in
 * the session store, so the form asks only what §X2 specifies: new
 * password and confirm.
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
  /** The temporary password this session just signed in with. */
  currentPassword: string;
  /** Called after the server accepts the new password. */
  onComplete: () => void;
}

export function ChangePasswordScreen({
  api,
  currentPassword,
  onComplete,
}: ChangePasswordScreenProps): React.ReactNode {
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(true);
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // §X2: no back. A hardware back here must not land on a route that
  // pretends the password was already changed.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, []);

  async function submit(): Promise<void> {
    if (pending) return;
    setBanner(null);
    const short = newPassword.length < 8;
    setNewError(short ? LENGTH_ERROR : null);
    setConfirmError(confirm !== newPassword ? MISMATCH_ERROR : null);
    if (short || confirm !== newPassword) return;
    setPending(true);
    try {
      const result = await api.request('POST', '/v1/auth/password', {
        body: { currentPassword, newPassword },
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
        The password you were given is temporary. Pick one only you know — you will not be asked
        again.
      </Text>

      {banner !== null ? (
        <Banner tone="danger" message={banner} testID="change-password-banner" />
      ) : null}

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
});
