/**
 * `_dev/gallery` — the component gallery (T0.12). Every primitive, the
 * eight states, all three densities. Dev-only: the route always exists
 * (expo-router has no build-time file exclusion), but `__DEV__` guards
 * make it render a dead end and skip its imports in production bundles
 * — Metro's minifier drops the unreachable `require`s (dead-code
 * elimination on the constant false branch), so no gallery code ships
 * in a release APK.
 */
import { ScrollView, Text, View } from 'react-native';
import { useState } from 'react';

import { DENSITY, SEMANTIC, SPACE, STATES, type ComponentState, type Density } from '@servgrid/shared';
import { textStyle } from '../../src/fonts/textStyle';
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DatePicker,
  DensityProvider,
  EmptyState,
  MoneyField,
  Select,
  Sheet,
  Skeleton,
  TextField,
} from '../../src/components/ui';

const DENSITIES: Density[] = ['field', 'console', 'desk'];

function SectionTitle({ children }: { children: string }): React.ReactNode {
  return (
    <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.primary, marginTop: SPACE[6], marginBottom: SPACE[2] }}>
      {children}
    </Text>
  );
}

/** The generic state a primitive is shown in, labelled. */
function StateBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{ marginBottom: SPACE[3] }}>
      <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary, marginBottom: 2 }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function ButtonStates(): React.ReactNode {
  return (
    <View>
      {STATES.map((s) => (
        <StateBlock key={s} label={s}>
          {s === 'disabled' ? (
            <Button label="Save" disabled disabledReason="No connection — kept on device" testID={`g-button-${s}`} />
          ) : s === 'loading' ? (
            <Button label="Save" loading testID={`g-button-${s}`} />
          ) : s === 'stale' ? (
            <Button label="Save" stale testID={`g-button-${s}`} />
          ) : s === 'error' ? (
            <Button label="Retry sync" variant="danger" testID={`g-button-${s}`} />
          ) : s === 'empty' ? (
            <Button label="Add the first job" variant="secondary" testID={`g-button-${s}`} />
          ) : (
            <Button label="Save" testID={`g-button-${s}`} />
          )}
        </StateBlock>
      ))}
      <StateBlock label="danger (outlined, never filled)">
        <Button label="Void job" variant="danger" />
      </StateBlock>
      <StateBlock label="ghost">
        <Button label="Skip for now" variant="ghost" />
      </StateBlock>
    </View>
  );
}

function FieldStates(): React.ReactNode {
  return (
    <View>
      {(['default', 'error', 'disabled', 'stale'] as ComponentState[]).map((s) => (
        <StateBlock key={s} label={s}>
          <TextField
            label="Username"
            value={s === 'disabled' ? 'tech01' : ''}
            onChangeText={() => {}}
            disabled={s === 'disabled'}
            errorText={s === 'error' ? 'Username or password is wrong.' : undefined}
            helperText={s === 'default' ? 'Your login name' : undefined}
            stale={s === 'stale'}
            testID={`g-text-${s}`}
          />
        </StateBlock>
      ))}
      <StateBlock label="focused (border line.focus)">
        <TextField label="Username" value="tech01" onChangeText={() => {}} />
      </StateBlock>
      <StateBlock label="loading">
        <TextField label="Username" value="" onChangeText={() => {}} loading />
      </StateBlock>
    </View>
  );
}

function MoneyStates(): React.ReactNode {
  return (
    <View>
      <StateBlock label="default (₹1,00,000 — grouping on blur)">
        <MoneyField label="Amount collected" value="100000" onChangeText={() => {}} testID="g-money-default" />
      </StateBlock>
      <StateBlock label="error">
        <MoneyField label="Amount collected" value="" onChangeText={() => {}} errorText="Enter the amount collected" testID="g-money-error" />
      </StateBlock>
      <StateBlock label="stale">
        <MoneyField label="Amount collected" value="4250.5" onChangeText={() => {}} stale testID="g-money-stale" />
      </StateBlock>
    </View>
  );
}

function PickerStates(): React.ReactNode {
  const opts = [
    { value: 'a', label: 'Assigned' },
    { value: 'b', label: 'En route' },
  ];
  return (
    <View>
      <StateBlock label="default (no selection)">
        <Select label="Status" value={null} options={opts} onSelect={() => {}} testID="g-sel-default" />
      </StateBlock>
      <StateBlock label="chosen">
        <Select label="Status" value="a" options={opts} onSelect={() => {}} testID="g-sel-chosen" />
      </StateBlock>
      <StateBlock label="error / disabled / stale">
        <Select label="Status" value={null} options={opts} onSelect={() => {}} errorText="Pick one" testID="g-sel-error" />
        <Select label="Status" value={null} options={opts} onSelect={() => {}} disabled testID="g-sel-disabled" />
        <Select label="Status" value="a" options={opts} onSelect={() => {}} stale testID="g-sel-stale" />
      </StateBlock>
      <StateBlock label="DatePicker — D MMM / D MMM YYYY">
        <DatePicker label="Service date" value="2026-03-14" onChange={() => {}} testID="g-dp-thisyear" />
        <DatePicker label="Service date" value="2027-03-14" onChange={() => {}} testID="g-dp-otheryear" />
        <DatePicker label="Service date" value={null} onChange={() => {}} testID="g-dp-empty" />
      </StateBlock>
    </View>
  );
}

function SurfaceStates(): React.ReactNode {
  return (
    <View>
      <StateBlock label="Sheet (64pt of the screen stays visible)">
        <OverlayPreview label="Open the sheet" testID="g-open-sheet">
          {(visible, close) => (
            <Sheet visible={visible} title="Complete job" onDismiss={close} hasUnsavedInput testID="g-sheet">
              <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>Scrollable content; the action bar never scrolls away.</Text>
            </Sheet>
          )}
        </OverlayPreview>
      </StateBlock>
      {(['danger', 'warning', 'success', 'info'] as const).map((tone) => (
        <StateBlock key={tone} label={`Banner ${tone}`}>
          <Banner tone={tone} message="The server's message, verbatim." testID={`g-banner-${tone}`} />
        </StateBlock>
      ))}
      <StateBlock label="Banner stale">
        <Banner tone="warning" message="Created offline" stale testID="g-banner-stale" />
      </StateBlock>
      <StateBlock label="Skeleton (exact geometry, 200ms delay, no shimmer)">
        <Skeleton width={'100%' as const} height={16} testID="g-sk-block" />
        <View style={{ height: 8 }} />
        <Skeleton width={200} height={16} testID="g-sk-200" />
      </StateBlock>
    </View>
  );
}

function FeedbackStates(): React.ReactNode {
  return (
    <View>
      <StateBlock label="Chip — unselected / selected (slate.900, never accent)">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip label="In warranty" testID="g-chip" />
          <Chip label="AMC 3 of 4" selected testID="g-chip-selected" />
        </View>
      </StateBlock>
      <StateBlock label="EmptyState (one line, one action, no illustration)">
        <EmptyState message="Nothing needs attention" actionLabel="Refresh" onAction={() => {}} testID="g-es" />
      </StateBlock>
      <StateBlock label="EmptyState — informational only">
        <EmptyState message="Nothing needs attention" testID="g-es-info" />
      </StateBlock>
      <StateBlock label="ConfirmDialog (irreversible only, destructive right)">
        <OverlayPreview label="Open the dialog" testID="g-open-cd">
          {(visible, close) => (
            <ConfirmDialog
              visible={visible}
              title="Void job?"
              message="This cannot be undone."
              confirmLabel="Void job"
              onCancel={close}
              onConfirm={close}
              testID="g-cd"
            />
          )}
        </OverlayPreview>
      </StateBlock>
    </View>
  );
}

function DensitySection({ density }: { density: Density }): React.ReactNode {
  const m = DENSITY[density];
  return (
    <View style={{ marginBottom: SPACE[8] }}>
      <Text style={{ ...textStyle('h1'), color: SEMANTIC.text.primary }}>
        {density} — row {m.rowHeight} · tap {m.tapTarget} · body {m.bodySize} · gutter {m.gutter}
      </Text>
      <SectionTitle>Button</SectionTitle>
      <ButtonStates />
      <SectionTitle>TextField</SectionTitle>
      <FieldStates />
      <SectionTitle>MoneyField</SectionTitle>
      <MoneyStates />
      <SectionTitle>Select & DatePicker</SectionTitle>
      <PickerStates />
      <SectionTitle>Sheet, Banner, Skeleton</SectionTitle>
      <SurfaceStates />
      <SectionTitle>Chip, EmptyState, ConfirmDialog</SectionTitle>
      <FeedbackStates />
    </View>
  );
}

function Gallery(): React.ReactNode {
  return (
    <ScrollView style={{ backgroundColor: SEMANTIC.bg.app }} contentContainerStyle={{ padding: SPACE[4] }}>
      <Text style={{ ...textStyle('display'), color: SEMANTIC.text.primary }}>Component gallery</Text>
      <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary, marginBottom: SPACE[4] }}>
        Every primitive × eight states × three densities. Dev-only (T0.12).
      </Text>
      {DENSITIES.map((d) => (
        <DensitySection key={d} density={d} />
      ))}
    </ScrollView>
  );
}

/**
 * Dev-gate: in release builds `__DEV__` is a compile-time constant, the
 * false branch minifies away, and the gallery module never loads.
 */
/**
 * Overlays open on demand rather than rendering permanently.
 *
 * `Sheet` and `ConfirmDialog` are real `Modal`s. Rendered `visible` in a
 * gallery they each throw a full-screen scrim over everything below,
 * which dims every other component on the page and buries the rest of
 * the list — the gallery is the one artefact that has to stay readable,
 * since it is what stops `stale` and `error` being reinvented per screen.
 *
 * A button that opens the real component beats a non-modal replica:
 * a replica is a second implementation, and it drifts.
 */
function OverlayPreview({
  label,
  testID,
  children,
}: {
  label: string;
  testID: string;
  children: (visible: boolean, close: () => void) => React.ReactNode;
}): React.ReactNode {
  const [visible, setVisible] = useState(false);
  return (
    <View>
      <Button label={label} variant="secondary" onPress={() => setVisible(true)} testID={testID} />
      {children(visible, () => setVisible(false))}
    </View>
  );
}

export default function GalleryRoute(): React.ReactNode {
  if (!__DEV__) {
    return (
      <View style={{ padding: SPACE[4] }}>
        <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
          Not available in release builds.
        </Text>
      </View>
    );
  }
  return (
    <DensityProvider density="field">
      <Gallery />
    </DensityProvider>
  );
}
