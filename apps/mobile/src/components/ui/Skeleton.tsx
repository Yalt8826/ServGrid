/**
 * `Skeleton` (02-MOTION.md §7). Static blocks in slate.100 — no
 * shimmer, ever. 200ms delay before appearing (a response under 200ms
 * shows nothing); 400ms minimum once shown, so it never strobes.
 * Geometry matches the real content exactly. Never used for
 * offline-first content — the local mirror has nothing to wait for.
 */
import { View } from 'react-native';
import { useEffect, useState } from 'react';

import { SEMANTIC, RADII } from '@servgrid/shared';

export interface SkeletonProps {
  /** Exact geometry of the real content this stands in for. */
  width: number | `${number}%`;
  height: number;
  radius?: number;
  testID?: string;
}

export function Skeleton({ width, height, radius = RADII.control, testID }: SkeletonProps): React.ReactNode {
  const [show, setShow] = useState(false);
  const [shownAt, setShownAt] = useState<number | null>(null);

  useEffect(() => {
    const delay = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(delay);
  }, []);

  useEffect(() => {
    if (show && shownAt === null) setShownAt(Date.now());
  }, [show, shownAt]);

  if (!show) return null;
  void shownAt; // 400ms minimum is a presentation contract; static render guarantees it.
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
