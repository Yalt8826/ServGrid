/**
 * The reassignment sheet (§O5) — **the control that exists nowhere else
 * in the product.** One decision: who owns the account. Choosing
 * *Nobody* makes it a house account — every rep sees it — which is how
 * leave gets covered. The options are the sales reps plus the explicit
 * Nobody row; the owner himself is not an option (he is not a rep; the
 * accounts belong to the sales line).
 *
 * Pure UI over injected deps; the route owns PATCH /v1/companies/:id/owner.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS, SEMANTIC, SPACE } from '@servgrid/shared';
import { Button, Sheet } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';

/** A reassignment option: a rep, or the house account. */
export interface RepOption {
  id: string | null;
  /** The rep's name, or the literal house-account word. */
  name: string;
  username?: string;
}

export interface ReassignSheetProps {
  visible: boolean;
  /** The account being moved, named on the sheet. */
  companyName: string;
  /** Who holds it now, for the "from → to" line. */
  currentName: string | null;
  options: readonly RepOption[];
  busy: boolean;
  error: string | null;
  onConfirm: (ownerRepId: string | null) => void;
  onDismiss: () => void;
  testID?: string;
}

export function ReassignSheet(props: ReassignSheetProps): React.ReactNode {
  // The choice is keyed by the option's id — with the house option keyed
  // 'house' — because `null` (the house answer) must be distinguishable
  // from NO answer at all: the confirm stays disabled until the owner
  // has actually chosen, and then must accept Nobody.
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const chosen = props.options.find((o) => (o.id ?? 'house') === chosenKey);
  const ready = chosen !== undefined && !props.busy;
  return (
    <Sheet
      visible={props.visible}
      title="Reassign account"
      onDismiss={props.onDismiss}
      testID={props.testID ?? 'reassign-sheet'}
      actions={
        <Button
          label="Reassign"
          disabled={!ready}
          disabledReason="Choose who takes the account."
          loading={props.busy}
          onPress={() => {
            if (chosen !== undefined) props.onConfirm(chosen.id);
          }}
          fullwidth
          testID="reassign-confirm"
        />
      }
    >
      <Text style={styles.company} testID="reassign-company">
        {props.companyName}
      </Text>
      <Text style={styles.current} testID="reassign-current">
        {props.currentName === null ? 'Currently a house account' : `Currently ${props.currentName}`}
      </Text>

      {props.options.map((option) => {
        const selected = chosenKey === (option.id ?? 'house');
        return (
          <Pressable
            key={option.id ?? 'house'}
            accessibilityRole="button"
            onPress={() => setChosenKey(option.id ?? 'house')}
            style={[styles.option, selected && styles.optionSelected]}
            testID={`reassign-option-${option.id ?? 'house'}`}
          >
            <View style={styles.optionMain}>
              <Text style={styles.optionName}>{option.name}</Text>
              {option.username !== undefined ? <Text style={styles.optionMeta}>{option.username}</Text> : null}
              {option.id === null ? (
                <Text style={styles.optionMeta}>Every rep sees it — this is how leave gets covered.</Text>
              ) : null}
            </View>
            {selected ? <View style={styles.dot} testID={`reassign-dot-${option.id ?? 'house'}`} /> : null}
          </Pressable>
        );
      })}

      {props.error !== null ? (
        <Text style={styles.error} testID="reassign-error">
          {props.error}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  company: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  current: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[3],
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    marginBottom: SPACE[2],
  },
  optionSelected: { borderColor: COLORS.accent },
  optionMain: { flex: 1 },
  optionName: {
    ...textStyle('body'),
    color: SEMANTIC.text.primary,
  },
  optionMeta: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.accent,
  },
  error: {
    ...textStyle('caption'),
    color: SEMANTIC.feedback.danger,
    marginTop: SPACE[2],
  },
});
