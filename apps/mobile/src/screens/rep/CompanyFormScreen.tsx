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

import { FRAME, SEMANTIC, SPACE } from '@servgrid/shared';
import { SectionHeader, Banner, Button, TextField } from '../../components/ui';
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID={props.testID ?? 'company-form'}>
      {/* The navy frame: what is being created, and whose it is. */}
      <View style={styles.frame}>
        <Text style={styles.frameTitle} testID="company-form-title">
          New account
        </Text>
        <Text style={styles.frameCaption}>
          The account is yours to collect from the moment it is created.
        </Text>
      </View>

      {error !== null ? <Banner tone="danger" message={error} testID="company-form-error" /> : null}

      <View style={styles.sectionWrap}>
        <SectionHeader label="The account" icon="business" />
      </View>
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
        icon="check"
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
  /** The page's own ground on the scroll itself, under the frame. */
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: {
    paddingBottom: SPACE[8],
    paddingTop: SPACE[2],
    paddingHorizontal: SPACE[4],
    gap: SPACE[3],
  },
  frame: {
    backgroundColor: FRAME.bg,
    marginTop: SPACE[2] * -1,
    marginHorizontal: SPACE[4] * -1,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[4],
    gap: 2,
  },
  frameTitle: { ...textStyle('h1'), color: FRAME.text },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  sectionWrap: { marginTop: SPACE[3] },
  block: { gap: SPACE[3] },
});
