/**
 * `SectionHeader` (mobile UI overhaul, 2026-09-16).
 *
 * The app separates sections with a 13px grey word and nothing else, so
 * `NEXT`, `CONTACT`, `TIMELINE` and `Tracking permissions` all read at the
 * same weight as the content beneath them — the eye has to read them to
 * find them. This is that separation made visible, in the four parts a
 * section marker needs and no more:
 *
 *   `[glyph] LABEL ───────────────────────────  (count)`
 *
 * - The **glyph chip** is a navy-tinted square: it says "new section"
 *   before a word is read, and it is the frame's tint, not a status
 *   colour — a section is not a state.
 * - The **rule** is what actually separates. It is the app's one
 *   horizontal hairline at `line.default`, running to the trailing edge so
 *   the header reads as a full-width band rather than a floating label.
 * - The **count** is optional and never decorative: it exists when the
 *   number tells him something the list below does not make obvious at a
 *   glance.
 *
 * Labels are uppercased here so call sites write the words they mean
 * (`'Later today'`), and tracking is applied so a short label still reads
 * as a marker rather than a heading.
 */
import { Text, View } from 'react-native';

import { alpha, SEMANTIC, SLATE, SPACE, TINT } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { Icon, type IconName } from './icons';

export interface SectionHeaderProps {
  label: string;
  /** The glyph that names the section's object. Omitted for a bare rule. */
  icon?: IconName;
  /** A count for the list below — omit unless the number earns its place. */
  count?: number;
  /** Trailing control (a filter, a "See all"); sits where the rule ends. */
  action?: React.ReactNode;
  testID?: string;
}

export function SectionHeader({ label, icon, count, action, testID }: SectionHeaderProps): React.ReactNode {
  return (
    <View
      testID={testID}
      style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], alignSelf: 'stretch' }}
    >
      {icon === undefined ? null : (
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 4,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(SLATE[900], TINT.band),
          }}
        >
          <Icon name={icon} size={14} color={SEMANTIC.text.secondary} />
        </View>
      )}
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.primary, letterSpacing: 0.8 }}>
        {label.toUpperCase()}
      </Text>
      {/* The rule does the separating; it is never the only marker, so it
          can stay as quiet as line.default. */}
      <View style={{ flex: 1, height: 1, backgroundColor: SEMANTIC.line.default, marginLeft: SPACE[1] }} />
      {count === undefined ? null : (
        <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}>{String(count)}</Text>
      )}
      {action ?? null}
    </View>
  );
}
