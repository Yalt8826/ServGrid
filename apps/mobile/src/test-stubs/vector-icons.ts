/**
 * Test seam for `@expo/vector-icons` (mobile UI overhaul, 2026-09-16).
 *
 * The real set renders a font glyph through `expo-font`, which needs a
 * native module registry — no part of which exists under `react-test-renderer`
 * in Node. This stub is the same bargain the `react-native` stub makes:
 * the REAL component logic runs, the paint does not.
 *
 * It renders the `Text` host stub with **no children**, and that is
 * load-bearing rather than lazy: assertions across the suite read the
 * tree's text (`allText(...).join(' ')`) and several expect an exact
 * string — a button whose label must read `'Start job'`, a card that must
 * not contain a currency symbol. A stub that emitted its own glyph name
 * as text would silently break all of them.
 *
 * The glyph is instead exposed as a `data-icon` prop, so a test that wants
 * to prove an icon is present can — `findAll(tree, (n) => n.props['data-icon'] === 'navigate')` —
 * without ever polluting text.
 */
import React from 'react';

function makeIconStub(family: string) {
  return function IconStub(props: { name?: string; size?: number; color?: string; testID?: string }) {
    return React.createElement('Text', {
      'data-icon': props.name,
      'data-icon-family': family,
      // Size and ink pass through as authored: a test that asserts an
      // icon took the caller's colour is asserting real component
      // behaviour, not this stub's.
      size: props.size,
      color: props.color,
      ...(props.testID === undefined ? {} : { testID: props.testID }),
    });
  };
}

export const Ionicons = makeIconStub('ionicons');
export const MaterialCommunityIcons = makeIconStub('material-community');
export const MaterialIcons = makeIconStub('material');
export const FontAwesome = makeIconStub('font-awesome');

export default { Ionicons, MaterialCommunityIcons, MaterialIcons, FontAwesome };
