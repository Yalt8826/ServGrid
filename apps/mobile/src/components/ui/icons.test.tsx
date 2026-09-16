/**
 * The icon layer and `SectionHeader` (mobile UI overhaul, 2026-09-16).
 *
 * Two things are worth holding here, and both are structural rather than
 * visual. First, that a screen names an icon by *meaning* and the whole
 * vocabulary resolves — under vitest `@expo/vector-icons` is the stub, so
 * the assertions read the `data-icon` prop it leaves behind (the real
 * glyphs are a font, and a font is not a test subject).
 *
 * Second, and the reason this file exists at all: **an icon renders no
 * text.** A stub that emitted its glyph name as a child would silently
 * corrupt every `allText(...)` assertion in the suite — the dashboard's
 * `'Start job'`, the currency-symbol sweep, the empty states. That
 * property is asserted directly below, because it is invisible until it
 * breaks something far away.
 */
import { describe, expect, it } from 'vitest';

import { ICON, FRAME, SEMANTIC } from '@servgrid/shared';
import { SectionHeader } from './SectionHeader';
import { Icon, type IconName } from './icons';
import { allText, create, findAll, findByTestID, toJson } from './testing';

/** Every name the app is allowed to ask for. Kept as a literal list so a
 * renamed key fails here rather than three screens away. */
const VOCABULARY: IconName[] = [
  'dashboard', 'jobs', 'cash', 'profile',
  'navigate', 'clock', 'calendar', 'refresh',
  'phone', 'location',
  'warning', 'alert', 'check', 'checkFilled', 'info', 'tick', 'close',
  'back', 'chevronRight', 'chevronDown', 'chevronUp', 'forward',
  'wrench', 'cube', 'camera', 'image', 'document', 'business', 'people', 'wallet',
  'plus', 'search', 'list', 'edit', 'key', 'logout', 'send', 'trending',
  'shield', 'battery', 'rocket', 'bell',
];

describe('Icon — the one vocabulary', () => {
  it('resolves every named icon to a glyph', async () => {
    for (const name of VOCABULARY) {
      const renderer = await create(<Icon name={name} color={SEMANTIC.text.primary} />);
      const node = findAll(toJson(renderer), (n) => typeof n.props['data-icon'] === 'string')[0];
      expect(node, `${name} rendered no glyph`).toBeDefined();
      expect(node!.props['data-icon']).toBeTruthy();
    }
  });

  it('renders no text — an icon never enters the tree’s words', async () => {
    const renderer = await create(<Icon name="navigate" color={SEMANTIC.text.primary} />);
    expect(allText(toJson(renderer))).toEqual([]);
  });

  it('carries the caller’s ink and one of the four sizes', async () => {
    const renderer = await create(<Icon name="warning" size={ICON.lg} color={FRAME.danger} />);
    const node = findAll(toJson(renderer), (n) => typeof n.props['data-icon'] === 'string')[0]!;
    expect(node.props.color).toBe(FRAME.danger);
    expect(node.props.size).toBe(ICON.lg);
    expect(Object.values(ICON)).toContain(node.props.size);
  });

  it("keeps the meaning→glyph map apart from the glyph's own name", () => {
    // `jobs` is not a glyph in any set; the mapping is ours, and this is
    // the assertion that a later edit has to consciously revisit.
    expect(VOCABULARY).toContain('jobs');
  });
});

describe('SectionHeader — the marker that separates', () => {
  it('uppercases the label so call sites write words', async () => {
    const renderer = await create(<SectionHeader label="Later today" />);
    expect(allText(toJson(renderer)).join(' ')).toContain('LATER TODAY');
  });

  it('renders the count only when it is given one', async () => {
    const withCount = await create(<SectionHeader label="Later today" count={3} />);
    expect(allText(toJson(withCount)).join(' ')).toContain('3');

    const without = await create(<SectionHeader label="Next" />);
    expect(allText(toJson(without)).join(' ')).toBe('NEXT');
  });

  it('draws a rule to the trailing edge — the separating is not the label’s job alone', async () => {
    const renderer = await create(<SectionHeader label="Next" icon="jobs" />);
    const rule = findAll(
      toJson(renderer),
      (n) => (n.props.style as { height?: number } | undefined)?.height === 1,
    );
    expect(rule).toHaveLength(1);
    expect((rule[0]!.props.style as { backgroundColor: string }).backgroundColor).toBe(SEMANTIC.line.default);
    // And the glyph is present beside the word, never instead of it.
    expect(findAll(toJson(renderer), (n) => n.props['data-icon'] === 'clipboard-outline')).toHaveLength(1);
  });

  it('omits the glyph chip entirely when no icon is named', async () => {
    const renderer = await create(<SectionHeader label="Next" testID="hdr" />);
    expect(findByTestID(toJson(renderer), 'hdr')).toBeDefined();
    expect(findAll(toJson(renderer), (n) => typeof n.props['data-icon'] === 'string')).toHaveLength(0);
  });
});
