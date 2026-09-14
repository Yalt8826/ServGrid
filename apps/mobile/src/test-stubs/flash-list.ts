/**
 * Vitest seam for `@shopify/flash-list` (T1.17). FlashList is a real
 * dependency on the handset (New-Architecture list virtualisation); in
 * component tests the seam renders every row into host-typed Views so
 * react-test-renderer sees the REAL row components — sorting, search
 * filtering, memoised items, empty states — with no native surface.
 *
 * Only what the screens use is modelled: `data` + `renderItem` +
 * `keyExtractor` + `estimatedItemSize` + separators. The estimate is
 * recorded, not obeyed — it is the device that recycles.
 */
import { createElement as h } from 'react';

// Host element name the rows render into — same string-typed seam as
// the react-native stub.
const View = 'View';

const renderedSizes: number[] = [];

// T4.7: sticky headers are the DEVICE's job (FlashList clones the sticky
// item into an overlay and drives it from scroll events — the T4.1 spike
// measured that machinery holding on RNW). The seam renders in order and
// records the indices so tests can assert the component handed the list
// its header, exactly as `estimatedItemSize` is recorded, not obeyed.
const stickyIndices: (readonly number[])[] = [];

export const FlashList = (props: {
  data: readonly unknown[];
  renderItem: (info: { item: unknown }) => React.ReactNode;
  keyExtractor?: (item: unknown, index: number) => string;
  estimatedItemSize?: number;
  stickyHeaderIndices?: readonly number[];
  ItemSeparatorComponent?: React.ComponentType | null;
  testID?: string;
  [key: string]: unknown;
}): React.ReactNode => {
  if (typeof props.estimatedItemSize === 'number') renderedSizes.push(props.estimatedItemSize);
  if (props.stickyHeaderIndices !== undefined) stickyIndices.push(props.stickyHeaderIndices);
  const children = props.data.map((item, index) => {
    const key = props.keyExtractor ? props.keyExtractor(item, index) : String(index);
    const row = props.renderItem({ item });
    return h(View, { key }, row);
  });
  const separator = props.ItemSeparatorComponent
    ? [h(props.ItemSeparatorComponent, { key: '__separator__' })]
    : [];
  // Interleave rows and separators the way the real list mounts them.
  const interleaved: React.ReactNode[] = [];
  children.forEach((child, index) => {
    interleaved.push(child);
    if (index < children.length - 1) {
      const sep = separator[0];
      if (sep !== undefined) interleaved.push(h(View, { key: `sep-${index}` }, sep));
    }
  });
  return h(View, { testID: props.testID }, interleaved);
};

/** The last estimate the screens passed — the test seam asserts it was
 * seeded, not guessed at zero. */
export function lastEstimatedItemSize(): number | undefined {
  return renderedSizes[renderedSizes.length - 1];
}

/** The last `stickyHeaderIndices` the list was handed (T4.7). */
export function lastStickyHeaderIndices(): readonly number[] | undefined {
  return stickyIndices[stickyIndices.length - 1];
}

export function __resetFlashListSeam(): void {
  renderedSizes.length = 0;
  stickyIndices.length = 0;
}
