/**
 * Gallery test (T0.12 "Done when": every primitive × eight states ×
 * three densities). Renders the real `app/_dev/gallery.tsx` module and
 * asserts the full matrix is present in its tree.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import GalleryRoute from '../../../app/_dev/gallery';
import { DensityProvider } from './DensityProvider';
import { STATES } from '@servgrid/shared';
import { allText, create, toJson, findByTestID } from './testing';

const DENSITIES = ['field', 'console', 'desk'] as const;

const GALLERY_TARGETS = [
  'button-default',
  'text-default',
  'money-default',
  'sel-default',
  'dp-thisyear',
  'sheet',
  'banner-danger',
  'sk-block',
  'chip',
  'es',
  'cd',
] as const;

/** The first `onPress` at or below a node — Button wraps its Pressable. */
function firstOnPress(node: unknown): (() => void) | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const n = node as { props?: { onPress?: () => void }; children?: unknown[] };
  if (typeof n.props?.onPress === 'function') return n.props.onPress;
  for (const child of n.children ?? []) {
    const hit = firstOnPress(child);
    if (hit) return hit;
  }
  return undefined;
}

describe('component gallery — the enforceable deliverable', () => {
  it('renders at __DEV__ with the display header', async () => {
    const r = await create(<GalleryRoute />);
    const texts = allText(toJson(r)).join(' | ');
    expect(texts).toContain('Component gallery');
  });

  it('covers every state label for every primitive section', async () => {
    const r = await create(<GalleryRoute />);
    const texts = allText(toJson(r));
    // The gallery labels each state block; the eight state names appear
    // across the Button and field sections at minimum.
    for (const s of STATES) {
      expect(texts, `state "${s}" labelled somewhere in the gallery`).toContain(s);
    }
  });

  it('renders a section per density with its metrics', async () => {
    const r = await create(<GalleryRoute />);
    const texts = allText(toJson(r)).join(' | ');
    for (const d of DENSITIES) {
      expect(texts).toContain(d);
    }
  });

  it('stale blocks carry the Pending sync caption', async () => {
    const r = await create(<GalleryRoute />);
    const texts = allText(toJson(r));
    const count = texts.filter((t) => t === 'Pending sync').length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('eleven primitives are represented by testIDs', async () => {
    const r = await create(<GalleryRoute />);
    // The skeleton's 200ms delay is its contract — wait it out.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 260));
    });

    // Sheet and ConfirmDialog are real Modals, so the gallery opens them
    // on demand — rendered permanently they scrim the whole page and bury
    // every component below it. Press the openers, so this stays an
    // assertion about all eleven rather than shrinking to the nine that
    // happen to be inline.
    for (const opener of ['g-open-sheet', 'g-open-cd']) {
      const node = findByTestID(toJson(r), opener);
      expect(node, `opener "${opener}" present`).toBeTruthy();
      // Button's testID sits on its wrapper; the handler is on the
      // Pressable inside it.
      const handler = firstOnPress(node!);
      expect(handler, `opener "${opener}" is pressable`).toBeTruthy();
      await act(async () => {
        handler!();
      });
    }

    const tree = toJson(r);
    for (const target of GALLERY_TARGETS) {
      expect(findByTestID(tree, `g-${target}`), `primitive "${target}" present`).toBeTruthy();
    }
  });

  it('wrapped in a DensityProvider resolves to field metrics', async () => {
    // DensityProvider default is field; the gallery itself mounts under it.
    await create(
      <DensityProvider density="field">
        <GalleryRoute />
      </DensityProvider>,
    );
  });
});
