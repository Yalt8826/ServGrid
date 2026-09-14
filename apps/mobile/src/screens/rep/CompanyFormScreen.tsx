/**
 * New company (§S4 write side, field feedback 2026-09-14): the rep's own
 * account creation. The server stamps `owner_rep_id` to the creating rep
 * (PLAN-BACKEND §11) — the payload carries no owner field, the server
 * decides, never the caller. A name that already exists comes back as
 * 409 DUPLICATE_ENTITY with the server's own sentence, rendered verbatim.
 * Pure over injected data; the route owns the POST.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, TextField } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

export interface CompanyFormScreenProps {
  /** POST /v1/companies — returns the created company's id. */
  create: (input: { name: string; contactPerson?: string; phone?: string; city?: string; notes?: string }) => Promise<string>;
  online: boolean;
  /** Called with the new company's id — the route opens its ledger. */
  onCreated: (companyId: string) => void;
  testID?: string;
}

export function CompanyFormScreen(props: CompanyFormScreenProps): React.ReactNode {
  const [name, setName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameReady = name.trim().length > 0;
  const canCreate = props.online && nameReady && !busy;

  async function submit(): Promise<void> {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = (raw: string): string => raw.trim();
      const id = await props.create({
        name: trimmed(name),
        ...(trimmed(contactPerson) !== '' ? { contactPerson: trimmed(contactPerson) } : {}),
        ...(trimmed(phone) !== '' ? { phone: trimmed(phone) } : {}),
        ...(trimmed(city) !== '' ? { city: trimmed(city) } : {}),
        ...(trimmed(notes) !== '' ? { notes: trimmed(notes) } : {}),
      });
      props.onCreated(id);
    } catch (e) {
      setError(e instanceof Error && e.message !== '' ? e.message : 'The account could not be created. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} testID={props.testID ?? 'company-form'}>
      <Text style={styles.heading} testID="company-form-title">
        New account
      </Text>
      <Text style={styles.sub}>The account is yours to collect from the moment it is created.</Text>

      {error !== null ? <Banner tone="danger" message={error} testID="company-form-error" /> : null}

      <View style={styles.block}>
        <TextField label="Company name" value={name} onChangeText={setName} placeholder="Trading name" testID="company-form-name" />
        <TextField
          label="Contact person"
          value={contactPerson}
          onChangeText={setContactPerson}
          placeholder="Optional"
          testID="company-form-contact"
        />
        <TextField label="Phone" value={phone} onChangeText={setPhone} placeholder="Optional" testID="company-form-phone" />
        <TextField label="City" value={city} onChangeText={setCity} placeholder="Optional" testID="company-form-city" />
        <TextField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Anything the office should know"
          multiline
          rows={2}
          testID="company-form-notes"
        />
      </View>

      <Button
        label="Create account"
        onPress={() => void submit()}
        loading={busy}
        disabled={!canCreate}
        disabledReason={
          !props.online
            ? "You're offline — creating needs a connection."
            : 'Enter the company name.'
        }
        fullwidth
        testID="company-form-submit"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE[4], gap: SPACE[3], backgroundColor: SEMANTIC.bg.app },
  heading: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  sub: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  block: { gap: SPACE[3] },
});
