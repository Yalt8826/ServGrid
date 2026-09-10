/**
 * Motion (02-MOTION.md §6, §7, §10). These assert the layer that was
 * described in the primitives' docstrings and driven by nothing: press
 * scale, arrival, and the two skeleton timings.
 *
 * The reanimated stub resolves `with*` to their target and runs
 * `useAnimatedStyle` inline, so a render sees **settled** state. That is
 * the right seam for "does this component carry a transform at all" —
 * the question the gap was — and the wrong one for easing curves, which
 * belong to the Phase 5 frame-budget matrix on real handsets.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SPRING, DURATION, EASING } from '@servgrid/shared';
import { Button } from './Button';
import { Chip } from './Chip';
import { Banner } from './Banner';
import { SKELETON_DELAY_MS, SKELETON_MIN_MS, useSkeleton } from './Skeleton';

afterEach(() => {
  vi.useRealTimers();
});

function render(node: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(node);
  });
  return r;
}

/** Every transform this system applies, flattened out of a style prop. */
function transformsIn(tree: unknown): Record<string, number>[] {
  const found: Record<string, number>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const node = n as { props?: { style?: unknown }; children?: unknown };
    const styles = Array.isArray(node.props?.style) ? node.props?.style : [node.props?.style];
    for (const s of styles) {
      const t = (s as { transform?: Record<string, number>[] } | undefined)?.transform;
      if (Array.isArray(t)) found.push(...t);
    }
    if (node.children) walk(node.children);
  };
  walk(tree);
  return found;
}

describe('press feedback — scale 0.97 on touch-down (§6)', () => {
  it('Button carries a scale transform, at rest 1', () => {
    const tree = render(<Button label="Complete job" onPress={() => {}} />).toJSON();
    const scales = transformsIn(tree).filter((t) => 'scale' in t);
    expect(scales.length, 'Button renders an animated scale wrapper').toBeGreaterThan(0);
    expect(scales[0]!.scale).toBe(1);
  });

  it('Chip carries one too — a chip is a control', () => {
    const tree = render(<Chip label="Today" onToggle={() => {}} />).toJSON();
    expect(transformsIn(tree).filter((t) => 'scale' in t).length).toBeGreaterThan(0);
  });

  it('a disabled Button does not answer a press it will not act on', () => {
    const tree = render(
      <Button label="Save" disabled disabledReason="No connection — kept on device" />,
    ).toJSON();
    // The wrapper still exists (layout is identical); it just never moves.
    expect(transformsIn(tree).filter((t) => 'scale' in t)[0]!.scale).toBe(1);
  });
});

describe('arrival — the banner drops with weight (§5.6)', () => {
  it('Banner renders a translateY and settles at 0', () => {
    const tree = render(<Banner tone="danger" message="This job was cancelled by the office at 14:32." />).toJSON();
    const ty = transformsIn(tree).filter((t) => 'translateY' in t);
    expect(ty.length, 'Banner arrives rather than appearing').toBeGreaterThan(0);
    expect(ty[0]!.translateY).toBe(0);
  });
});

describe('motion tokens are the source, never a retyped number', () => {
  it('no spring has damping below 15 — bounce reads as toy, this is equipment (§3)', () => {
    for (const [name, s] of Object.entries(SPRING)) {
      expect(s.damping, `SPRING.${name} damping >= 15`).toBeGreaterThanOrEqual(15);
    }
  });

  it('durations skip 320–520: a transition wanting 400ms is a decision, not a number (§1)', () => {
    const between = Object.values(DURATION).filter((d) => d > 320 && d < DURATION.hero);
    expect(between).toEqual([]);
  });

  it('there are exactly six durations, four easings, three springs', () => {
    expect(Object.keys(DURATION)).toHaveLength(6);
    expect(Object.keys(EASING)).toHaveLength(4);
    expect(Object.keys(SPRING)).toHaveLength(3);
  });
});

describe('useSkeleton — both timings, because the parent owns the unmount (§7)', () => {
  function Probe({ loading }: { loading: boolean }): React.ReactElement {
    return <>{useSkeleton(loading) ? 'skeleton' : 'content'}</>;
  }

  it('shows nothing for a response faster than 200ms — the best skeleton is one nobody sees', () => {
    vi.useFakeTimers();
    const r = render(<Probe loading />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => {
      r.update(<Probe loading={false} />);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(r.toJSON()).toBe('content');
  });

  it('appears after 200ms', () => {
    vi.useFakeTimers();
    const r = render(<Probe loading />);
    expect(r.toJSON()).toBe('content');
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(r.toJSON()).toBe('skeleton');
  });

  it('once shown it holds 400ms — a load resolving at 250ms must not flash', () => {
    vi.useFakeTimers();
    const r = render(<Probe loading />);
    act(() => {
      vi.advanceTimersByTime(SKELETON_DELAY_MS);
    });
    expect(r.toJSON()).toBe('skeleton');

    // Data lands 50ms after the skeleton appeared.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      r.update(<Probe loading={false} />);
    });
    expect(r.toJSON(), 'still held — 50ms of the 400ms floor has passed').toBe('skeleton');

    act(() => {
      vi.advanceTimersByTime(SKELETON_MIN_MS - 50);
    });
    expect(r.toJSON()).toBe('content');
  });
});
