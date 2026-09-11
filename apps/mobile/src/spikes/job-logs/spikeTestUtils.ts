/**
 * T1.22 spike test utilities — small traversal helpers for the spike's
 * own tests. They exist for one reason: `FilterBar` renders a Fragment
 * (bar + option sheet), and react-test-renderer's `toJSON` represents a
 * multi-child fragment root as an ARRAY, which the shared
 * `components/ui/testing` finder (single-root) cannot walk. These
 * helpers accept either shape. Throwaway with the spike.
 */
import { act } from 'react';
import { expect } from 'vitest';

import { findAll, findByTestID, toJson, type Node } from '../../components/ui/testing';

export type Tree = ReturnType<typeof toJson>;

/** Every root of a (possibly fragment-rooted) JSON tree. */
function rootsOf(tree: Tree): Node[] {
  return (Array.isArray(tree) ? tree : [tree]) as Node[];
}

/** testID lookup that walks fragment-rooted (array) trees too. */
export function findID(tree: Tree, testID: string): Node | undefined {
  for (const root of rootsOf(tree)) {
    const hit = findByTestID(root, testID);
    if (hit) return hit;
  }
  return undefined;
}

/** Predicate search that walks fragment-rooted (array) trees too. */
export function allInTree(tree: Tree, match: (node: Node) => boolean): Node[] {
  return rootsOf(tree).flatMap((root) => findAll(root, match));
}

/** Handlers live under `props` on the harness Node; press inside act. */
export function press(node: Node): void {
  expect(typeof node.props.onPress).toBe('function');
  act(() => {
    node.props.onPress?.();
  });
}

/** The stub preserves `style` verbatim — often an array. Flatten it. */
export function flatStyle(node: Node): Record<string, unknown> {
  const style = node.props.style as Record<string, unknown> | Record<string, unknown>[];
  if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean));
  return style ?? {};
}

/** Stable handler identity — the memo contract compares onPress. */
export function noop(): void {}
