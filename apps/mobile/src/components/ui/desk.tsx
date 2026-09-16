/**
 * The console's page furniture (OW.2, 2026-09-16) — the owner's web
 * build only.
 *
 * The complaint these answer: "no proper spacing… the whole thing looks
 * very dull". Both come from the same absence. Every owner screen painted
 * straight onto one flat page with the phone's 4pt rhythm, so nothing told
 * a section from the gap beside it and the eye had nowhere to rest. These
 * three give the console the layer it was missing — a page ground, a card
 * to sit content on, and one header shape every screen wears.
 *
 * **They are density-aware, not platform-aware.** At `desk` they paint the
 * console; at `field` and `console` they get out of the way and render
 * their children plainly, so a phone screen that imports one is unchanged.
 * That is what keeps this phase's promise that the field apps do not move.
 */
import type { ReactNode } from 'react';
import { Platform, Text, View, type ViewStyle } from 'react-native';

import { DESK, SEMANTIC, SPACE } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { useDensity } from './DensityProvider';

/** RNW takes `boxShadow` through style; native ignores it. One cast, here. */
function webShadow(shadow: string): ViewStyle {
  return Platform.OS === 'web' ? ({ boxShadow: shadow } as unknown as ViewStyle) : {};
}

/**
 * The scroll content style a console page wants: real page padding, the
 * console's rhythm between sections, and a measure cap so a 1900px window
 * does not stretch a table to the edges of the glass.
 */
export function pageContentStyle(desk: boolean): ViewStyle {
  if (!desk) {
    return { padding: SPACE[4], paddingBottom: SPACE[8], gap: SPACE[5] };
  }
  return {
    paddingHorizontal: DESK.page.padX,
    paddingTop: DESK.page.padY,
    paddingBottom: SPACE[12],
    gap: DESK.page.gap,
    maxWidth: DESK.page.maxWidth,
    width: '100%',
    alignSelf: 'center',
  };
}

export interface PageHeaderProps {
  title: string;
  /** One line under the title: what this page is for, or what it is showing. */
  subtitle?: string;
  /** Right-hand side — the page's actions, or its filters. */
  actions?: ReactNode;
  testID?: string;
}

/**
 * One header shape for every console page: the title, an optional line of
 * orientation, and the page's actions on the right. Screens used to open
 * with a bare `h1` and whatever spacing they chose, which is half of why
 * no two of them looked related.
 */
export function PageHeader({ title, subtitle, actions, testID }: PageHeaderProps): ReactNode {
  const desk = useDensity() === 'desk';
  return (
    <View
      testID={testID}
      style={{
        flexDirection: desk ? 'row' : 'column',
        alignItems: desk ? 'flex-end' : 'stretch',
        justifyContent: 'space-between',
        gap: SPACE[3],
        ...(desk
          ? { paddingBottom: SPACE[4], borderBottomWidth: 1, borderBottomColor: SEMANTIC.line.default }
          : {}),
      }}
    >
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={{ ...textStyle('h1'), color: SEMANTIC.text.primary }} testID={testID ? `${testID}-title` : undefined}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}>{subtitle}</Text>
        )}
      </View>
      {actions === undefined ? null : (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], flexWrap: 'wrap' }}
          testID={testID ? `${testID}-actions` : undefined}
        >
          {actions}
        </View>
      )}
    </View>
  );
}

export interface PanelProps {
  /** Fill the page's remaining height — what a table inside a card needs to scroll. */
  grow?: boolean;
  /** The section's name. Rendered as the card's own heading, so screens stop hand-rolling one. */
  title?: string;
  /** Right of the title — a range switcher, a filter, a link. */
  actions?: ReactNode;
  children: ReactNode;
  /** Tables bring their own padding; pass false and the body sits flush to the card's edge. */
  padded?: boolean;
  testID?: string;
}

/**
 * The card. On the desk it is white on the page's slate ground with a
 * hairline border, a soft shadow and radius 8 — the one deliberate
 * departure from §3.2's square corners, which belong to the job docket on
 * a phone, not to a 1400px console (the reasoning is in `DESK`).
 *
 * At phone densities it is a plain block: no card, no shadow, nothing to
 * relayout.
 */
export function Panel({ title, actions, children, padded = true, grow = false, testID }: PanelProps): ReactNode {
  const desk = useDensity() === 'desk';
  const header =
    title === undefined && actions === undefined ? null : (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: SPACE[3],
          marginBottom: desk ? SPACE[4] : SPACE[3],
          paddingHorizontal: desk && !padded ? DESK.card.pad : 0,
          paddingTop: desk && !padded ? DESK.card.pad : 0,
        }}
      >
        {title === undefined ? (
          <View />
        ) : (
          <Text
            testID={testID ? `${testID}-title` : undefined}
            style={{
              ...textStyle('caption'),
              color: SEMANTIC.text.secondary,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            {title}
          </Text>
        )}
        {actions === undefined ? null : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>{actions}</View>
        )}
      </View>
    );

  if (!desk) {
    return (
      <View testID={testID} style={grow ? { flex: 1 } : { gap: 0 }}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <View
      testID={testID}
      style={{
        backgroundColor: DESK.card.bg,
        borderWidth: 1,
        borderColor: DESK.card.border,
        borderRadius: DESK.card.radius,
        padding: padded ? DESK.card.pad : 0,
        // Clip ONLY when the card wraps something that must not spill past
        // its rounded corners — a table. A padded card holds forms, and a
        // form holds dropdowns: clipping there would cut the menu off at
        // the card's edge (OW.5).
        ...(padded ? {} : { overflow: 'hidden' as const }),
        ...(grow ? { flex: 1 } : {}),
        ...webShadow(DESK.card.webShadow),
      }}
    >
      {header}
      {children}
    </View>
  );
}

/**
 * A row of panels that share the width, wrapping when the window is too
 * narrow to hold them. The console's four stat cards and its side-by-side
 * charts are both this.
 */
export function PanelRow({ children, testID }: { children: ReactNode; testID?: string }): ReactNode {
  const desk = useDensity() === 'desk';
  return (
    <View
      testID={testID}
      style={{
        flexDirection: desk ? 'row' : 'column',
        gap: desk ? DESK.page.gap : SPACE[4],
        alignItems: 'stretch',
      }}
    >
      {children}
    </View>
  );
}

export interface DeskListShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  testID?: string;
}

/**
 * The frame every console LIST page wears (OW.2): page padding, the
 * measure cap, and one header — the thing whose absence made the console
 * look unfinished, because a table on the desk branch started at the
 * window's edge with no title above it and no ground beneath it.
 *
 * On a phone it renders its children and nothing else, so the same screen
 * keeps its phone layout exactly.
 */
export function DeskListShell({ title, subtitle, actions, children, testID }: DeskListShellProps): ReactNode {
  const desk = useDensity() === 'desk';
  if (!desk) return <View style={{ flex: 1 }} testID={testID}>{children}</View>;
  return (
    <View
      testID={testID}
      style={{
        flex: 1,
        paddingHorizontal: DESK.page.padX,
        paddingTop: DESK.page.padY,
        paddingBottom: DESK.page.padY,
        gap: DESK.page.gap,
        maxWidth: DESK.page.maxWidth,
        width: '100%',
        alignSelf: 'center',
      }}
    >
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {children}
    </View>
  );
}
