import _traverse from '@babel/traverse';
import type { Node, TraverseOptions } from '@babel/traverse';

/** The shape we actually call `traverse` with — a small slice of its full overload set. */
type TraverseFn = (parent: Node, opts: TraverseOptions) => void;

/**
 * @babel/traverse ships as CJS (`module.exports = traverse; traverse.default = traverse`). Under
 * Node's native ESM loader (this package is "type": "module"), a default import binds to the
 * whole CJS module.exports object rather than the unwrapped function, so every caller would
 * otherwise need its own `.default` reach-through. Centralized here once so ast/*.ts modules get
 * a directly-callable function. The explicit TraverseFn annotation (rather than `typeof
 * _traverse`) sidesteps a known @types/babel__traverse + NodeNext interop quirk where the
 * default import's inferred type resolves to the whole module namespace instead of the callable
 * `traverse` value.
 */
export const traverse = ((_traverse as unknown as { default?: TraverseFn }).default ??
  (_traverse as unknown as TraverseFn)) as TraverseFn;
