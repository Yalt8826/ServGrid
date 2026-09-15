/**
 * `Skeleton` (02-MOTION.md §7). Static blocks in slate.100 — no
 * shimmer, ever.
 *
 * **The two timings live in `useSkeleton`, not here.** 200ms delay before
 * appearing (a response under 200ms shows nothing) and 400ms minimum once
 * shown (so it never strobes) are both decisions about *whether to render
 * a skeleton at all* — and the parent owns that, because the parent is
 * what unmounts this component when the data lands. A minimum enforced
 * inside the block cannot work: at 250ms the parent swaps in real content
 * and the block is gone, having flashed for 50ms, which is precisely what
 * the floor exists to prevent. So this is a dumb rectangle and the hook
 * carries the contract.
 * Geometry matches the real content exactly.
 */
import { View } from 'react-native';
import { useEffect, useRef, useState } from 'react';

import { SEMANTIC, RADII } from '@servgrid/shared';

export interface SkeletonProps {
  /** Exact geometry of the real content this stands in for. */
  width: number | `${number}%`;
  height: number;
  radius?: number;
  testID?: string;
}

/** 02-MOTION.md §7. Exported so the numbers are asserted, not retyped. */
export const SKELETON_DELAY_MS = 200;
export const SKELETON_MIN_MS = 400;

/**
 * Whether to render a skeleton for `loading`, applying both timings:
 * nothing for the first 200ms, and once shown it stays for at least
 * 400ms even if the data arrives at 250ms.
 *
 * Use it in the parent, which is the thing that knows when loading ends:
 *
 * ```tsx
 * const showSkeleton = useSkeleton(query.isLoading);
 * return showSkeleton ? <Skeleton height={88} /> : <JobCard job={data} />;
 * ```
 *
 * Every role reads the server since the app went online-only
 * (2026-09-15), so any screen waiting on a first read may use it (§7).
 */
export function useSkeleton(loading: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      if (visible) return;
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, SKELETON_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (!visible) return;
    // Shown already: hold the floor out from when it appeared.
    const elapsed = shownAt.current === null ? SKELETON_MIN_MS : Date.now() - shownAt.current;
    const remaining = Math.max(0, SKELETON_MIN_MS - elapsed);
    const t = setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, remaining);
    return () => clearTimeout(t);
  }, [loading, visible]);

  return visible;
}

export function Skeleton({ width, height, radius = RADII.control, testID }: SkeletonProps): React.ReactNode {
  const [show, setShow] = useState(false);

  // Standalone use (the gallery) still gets the delay, so a block dropped
  // into a screen without the hook never flashes on a fast render.
  useEffect(() => {
    const delay = setTimeout(() => setShow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(delay);
  }, []);

  if (!show) return null;
  return (
    <View
      testID={testID}
      style={{
        width: width as number | `${number}%`,
        height,
        borderRadius: radius,
        backgroundColor: SEMANTIC.bg.dense,
      }}
    />
  );
}
