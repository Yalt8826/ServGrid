/**
 * Login (UI/plan-2/08-SHARED-SCREENS.md §X1). Worst moment: first
 * morning, a technician who has never used the app, a temporary
 * password written on paper, standing in the yard.
 *
 * The rules that shape it: username, not email (there is no email in
 * the schema); the password is VISIBLE by default and one tap masks it —
 * typing a temp password blind on a 6" screen in the sun is a real
 * failure; "Ask the owner" because it is the truth (no reset flow
 * exists); one banner for a failed attempt that never says which field
 * was wrong; the lockout names the actual minutes; and no animation on
 * arrival — the app opens and is usable.
 */
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import { LAYOUT, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, TextField } from '../components/ui';
import { textStyle } from '../fonts/textStyle';
import type { ApiResult, LoginResponse } from '../lib/apiClient';
import { SecureToggle } from './SecureToggle';

/** Where the route goes after a successful sign-in. */
export type PostLoginRoute = 'change-password' | 'consent' | 'landing';

/**
 * The routing decision a login result implies. Password change first
 * (§X2), then consent — and consent only for the tracked roles (§X3:
 * the screen is technician and sales rep, first login; it gates the
 * location task, which the office roles do not have).
 */
export function nextRouteFor(result: LoginResponse): PostLoginRoute {
  if (result.mustChangePassword) return 'change-password';
  const tracked = result.employee.role === 'technician' || result.employee.role === 'sales_rep';
  if (tracked && result.consent.required) return 'consent';
  return 'landing';
}

/** Field staff are Android only (PLAN-FRONTEND.md §5.1): background GPS exists only there. */
export const FIELD_ROLE_ON_WEB = 'Use the ServGrid app on your Android phone.';

/**
 * The web build is for the owner and dispatchers. A technician or sales rep
 * who signs in on web gets the sentence instead of a session. A product
 * boundary, not a security one — the server's permissions are unchanged.
 */
export function webRefusalFor(role: LoginResponse['employee']['role'], platform: string): string | null {
  return platform === 'web' && (role === 'technician' || role === 'sales_rep') ? FIELD_ROLE_ON_WEB : null;
}

/** `webRefusalFor` on the platform this bundle runs on — route files stay
 * platform-free (NavShell.test: the one layout branch lives in NavShell). */
export function fieldRoleRefusedHere(role: LoginResponse['employee']['role']): string | null {
  return webRefusalFor(role, Platform.OS);
}

const WRONG_CREDENTIALS = 'Username or password is wrong.';
const OFFLINE = 'No connection — sign-in needs one.';

/**
 * The one banner sentence for a failed sign-in (§X1 States). The wrong-
 * credentials case never says which field; the lockout case names the
 * actual minutes from the server's `Retry-After`; anything else shows
 * the server's own message verbatim (§X5 — the backend owns that copy).
 */
export function loginErrorBanner(result: ApiResult<LoginResponse>): string {
  if (result.status === 0 || result.error?.code === 'NETWORK') return OFFLINE;
  if (result.error?.code === 'RATE_LIMITED' && result.retryAfterSeconds !== undefined) {
    const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
    return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  if (result.error?.code === 'UNAUTHENTICATED') return WRONG_CREDENTIALS;
  return result.error?.message ?? 'Sign-in failed. Try again.';
}

export interface LoginScreenProps {
  /** Constructs the call — device identity is route business, not UI. */
  signIn: (username: string, password: string) => Promise<ApiResult<LoginResponse>>;
  /** Called once with the parsed response and the password just used. */
  onAuthenticated: (result: LoginResponse, password: string) => void;
  /** `Platform.OS` by default; injected by tests. */
  platform?: string;
  /** Throws away a session the platform refuses (field staff on web). */
  discardSession?: () => Promise<void>;
}

export function LoginScreen({
  signIn,
  onAuthenticated,
  platform = Platform.OS,
  discardSession,
}: LoginScreenProps): React.ReactNode {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // §X1: visible by default. The toggle masks it; the default is the
  // temporary password someone is typing from a piece of paper.
  const [visible, setVisible] = useState(true);
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const canSubmit = username.trim() !== '' && password !== '';

  async function submit(): Promise<void> {
    if (pending || !canSubmit) return;
    setPending(true);
    setBanner(null);
    try {
      const result = await signIn(username, password);
      if (result.ok && result.data !== null) {
        const refusal = webRefusalFor(result.data.employee.role, platform);
        if (refusal !== null) {
          await discardSession?.().catch(() => {});
          setBanner(refusal);
          return;
        }
        onAuthenticated(result.data, password);
      } else {
        setBanner(loginErrorBanner(result));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      testID="login-screen"
    >
      <Text style={styles.wordmark}>ServGrid</Text>

      {banner !== null ? <Banner tone="danger" message={banner} testID="login-banner" /> : null}

      <TextField
        label="Username"
        value={username}
        onChangeText={setUsername}
        disabled={pending}
        testID="login-username"
      />
      <View style={styles.gap} />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        disabled={pending}
        secureTextEntry={!visible}
        trailing={
          <SecureToggle
            visible={visible}
            onToggle={() => setVisible((v) => !v)}
            testID="login-password-toggle"
          />
        }
        testID="login-password"
      />

      <View style={styles.beforeSubmit} />
      <Button
        label="Sign in"
        onPress={() => void submit()}
        disabled={!canSubmit}
        disabledReason="Enter your username and password."
        loading={pending}
        fullwidth
        testID="login-submit"
      />

      <Text style={styles.forgot}>Forgot your password? Ask the owner.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: SPACE[4],
    // A form the width of a 1900px window is not a form. The cap is a
    // no-op on every handset (they are narrower than it) and is what
    // stops the owner's desktop build reading as a broken page.
    width: '100%',
    maxWidth: LAYOUT.formMaxWidth,
    alignSelf: 'center',
  },
  wordmark: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    textAlign: 'center',
    marginBottom: SPACE[7],
  },
  gap: { height: SPACE[3] },
  beforeSubmit: { height: SPACE[5] },
  forgot: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    textAlign: 'center',
    marginTop: SPACE[4],
  },
});
