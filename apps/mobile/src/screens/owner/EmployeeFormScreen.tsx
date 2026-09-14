/**
 * O7 Employees — create (UI/plan-2/07-OWNER.md §O7). Username, name,
 * phone, role, temporary password. **`must_change_password` is automatic
 * and stated on the screen**: "<Name> will be asked to set his own
 * password at first login." — the sentence uses the name as typed, so
 * the owner reads the promise about HIS new hire before he commits it.
 *
 * Pure UI over injected deps; the route owns the POST.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, Select, TextField } from '../../components/ui';
import type { SelectOption } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

export interface EmployeeFormDeps {
  roles?: readonly SelectOption[];
  busy: boolean;
  error: string | null;
  create: (input: { username: string; fullName: string; phone: string | null; role: string; tempPassword: string }) => Promise<void>;
  onDone: () => void;
  testID?: string;
}

const ROLE_OPTIONS = [
  { value: 'technician', label: 'Technician' },
  { value: 'dispatcher', label: 'Dispatcher' },
  { value: 'sales_rep', label: 'Sales rep' },
  { value: 'owner', label: 'Owner' },
];

export function EmployeeFormScreen(deps: EmployeeFormDeps): React.ReactNode {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState('');

  const usernameOk = /^[a-z0-9._-]{3,32}$/.test(username);
  const passwordOk = tempPassword.length >= 8;
  const complete = usernameOk && fullName.trim().length > 0 && role !== null && passwordOk && !deps.busy;

  return (
    <ScrollView contentContainerStyle={styles.content} testID={deps.testID ?? 'employee-form'}>
      <TextField
        label="Username"
        value={username}
        onChangeText={setUsername}
        placeholder="ravi.k"
        helperText="3–32 characters: a-z, 0-9, dots, dashes, underscores."
        errorText={username.length > 0 && !usernameOk ? 'Use 3-32 characters: a-z, 0-9, dots, dashes, underscores.' : undefined}
        testID="employee-form-username"
      />
      <TextField label="Full name" value={fullName} onChangeText={setFullName} placeholder="Ravi Kumar" testID="employee-form-name" />
      <TextField
        label="Phone"
        value={phone}
        onChangeText={setPhone}
        placeholder="+91 98400 00000"
        testID="employee-form-phone"
      />
      <Select
        label="Role"
        value={role}
        options={[...(deps.roles ?? ROLE_OPTIONS)]}
        onSelect={setRole}
        testID="employee-form-role"
      />
      <TextField
        label="Temporary password"
        value={tempPassword}
        onChangeText={setTempPassword}
        placeholder="At least 8 characters"
        helperText="Hand it over in person — never in a message."
        errorText={tempPassword.length > 0 && !passwordOk ? 'Use at least 8 characters.' : undefined}
        secureTextEntry
        testID="employee-form-password"
      />

      {fullName.trim().length > 0 ? (
        <View style={styles.statement} testID="employee-form-password-statement">
          <Text style={styles.statementText}>
            {`${fullName.trim()} will be asked to set his own password at first login.`}
          </Text>
        </View>
      ) : null}

      {deps.error !== null ? (
        <Text style={styles.error} testID="employee-form-error">
          {deps.error}
        </Text>
      ) : null}

      <Button
        label="Create account"
        disabled={!complete}
        disabledReason="Fill every field — the username and password have floors."
        loading={deps.busy}
        onPress={() => {
          void deps
            .create({
              username,
              fullName: fullName.trim(),
              phone: phone.trim() === '' ? null : phone.trim(),
              role: role ?? '',
              tempPassword,
            })
            .then(deps.onDone)
            .catch(() => {});
        }}
        fullwidth
        testID="employee-form-submit"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[3],
  },
  statement: {
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    padding: SPACE[3],
  },
  statementText: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  error: {
    ...textStyle('caption'),
    color: SEMANTIC.feedback.danger,
  },
});
