/**
 * Harness for UI primitive tests (T0.12). react-test-renderer renders
 * the real component logic against the `react-native` host stubs
 * (`src/test-stubs/react-native.ts`); reanimated runs its vitest stub.
 * Handlers are invoked off the JSON tree inside act().
 */
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';

export { React, act, TestRenderer };

export type ReactTestRenderer = TestRenderer.ReactTestRenderer;

export async function create(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

export interface Node {
  type: string;
  props: Record<string, unknown> & {
    testID?: string;
    onPress?: (event?: unknown) => void;
    onChangeText?: (text: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onChange?: (value: string) => void;
    onToggle?: () => void;
    onDismiss?: () => void;
  };
  children?: (Node | string | null)[];
}

export const toJson = (r: TestRenderer.ReactTestRenderer): Node => r.toJSON() as unknown as Node;

export function findByTestID(root: Node | string | null, testID: string): Node | undefined {
  if (root === null || typeof root === 'string') return undefined;
  if (root.props.testID === testID) return root;
  for (const child of root.children ?? []) {
    const hit = findByTestID(child, testID);
    if (hit) return hit;
  }
  return undefined;
}

/** Every node matching a predicate, in render order. */
export function findAll(root: Node | string | null, match: (node: Node) => boolean): Node[] {
  if (root === null || typeof root === 'string') return [];
  const hit = match(root) ? [root] : [];
  for (const child of root.children ?? []) {
    hit.push(...findAll(child, match));
  }
  return hit;
}

export function findAllByTestID(root: Node | string | null, testID: string): Node[] {
  return findAll(root, (node) => node.props.testID === testID);
}

/** First node of a given host type inside a subtree (e.g. the input in a field). */
export function firstDescendantOfType(root: Node, type: string): Node | undefined {
  return findAll(root, (node) => node.type === type)[0];
}

/** All non-empty text strings in the tree, in order. */
export function allText(root: Node | string | null, acc: string[] = []): string[] {
  if (root === null || typeof root === 'string') return acc;
  for (const child of root.children ?? []) {
    if (typeof child === 'string') {
      if (child.trim() !== '') acc.push(child);
    } else {
      allText(child, acc);
    }
  }
  return acc;
}

/** First node whose type equals the host stub name (e.g. 'Text'). */
export function findByType(root: Node | string | null, type: string): Node | undefined {
  if (root === null || typeof root === 'string') return undefined;
  if (root.type === type) return root;
  for (const child of root.children ?? []) {
    const hit = findByType(child, type);
    if (hit) return hit;
  }
  return undefined;
}
