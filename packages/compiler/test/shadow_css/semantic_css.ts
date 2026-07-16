/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/**
 * A purpose-built CSS canonicalizer for comparing the output of style
 * encapsulation implementations (ShadowCss vs the postcss-based plugin).
 *
 * Two encapsulation implementations run over the same input produce the same
 * rules and declarations but may differ syntactically in how they write
 * selectors. This module canonicalizes exactly those degrees of freedom:
 *
 * - whitespace and formatting
 * - the order of simple selectors within a compound (`.foo[hosta]` vs
 *   `[hosta].foo`)
 * - the order (and exact duplicates) of selectors within a rule's selector
 *   list, e.g. differently-ordered `:host-context` permutations
 * - the order of selector arguments inside `:is()/:where()/:not()/:has()`
 * - insignificant whitespace in at-rule preludes
 *   (`@media (max-width:800px)` vs `@media (max-width: 800px)`)
 *
 * Unlike a general-purpose semantic CSS differ (see the `semantic_css_diff`
 * tool this was distilled from), it deliberately does NOT normalize
 * declaration values, merge or reorder rules, or remove empty rules — the
 * shadow_css fixtures are mostly empty-bodied, and removing empty rules
 * would make any two of them compare equal regardless of their selectors.
 */

import postcss, {AtRule, Comment, Node as PostcssNode, Rule} from 'postcss';
import selectorParser, {
  Node as SelectorNode,
  Pseudo as SelectorPseudo,
  Root as SelectorRoot,
  Selector as SelectorSlice,
} from 'postcss-selector-parser';

const {isCombinator, isPseudo, isSelector, isTag, isPseudoElement} = selectorParser;

/** Pseudo-classes containing selector lists whose order is insignificant. */
const SORTABLE_PSEUDO_CONTAINERS: ReadonlySet<string> = new Set([
  ':is',
  ':where',
  ':not',
  ':has',
  ':matches',
  ':-webkit-any',
  ':-moz-any',
]);

/**
 * Sorts simple selectors within a compound. The type selector must stay
 * first; everything else sorts by its string representation.
 */
function compareSimpleSelectors(a: SelectorNode, b: SelectorNode): number {
  if (isTag(a) && !isTag(b)) return -1;
  if (isTag(b) && !isTag(a)) return 1;
  return a.toString().localeCompare(b.toString());
}

/** Normalizes a single complex selector's nodes in place. */
function normalizeComplexSelector(selector: SelectorSlice): void {
  // Chunk into compounds separated by combinators, sorting each compound.
  // Nodes from the first pseudo-element on keep their order, since
  // pseudo-elements must remain at the end of a compound.
  const chunks: SelectorNode[][] = [];
  let current: SelectorNode[] = [];
  for (const node of selector.nodes) {
    if (isCombinator(node)) {
      chunks.push(current);
      chunks.push([node]);
      current = [];
    } else {
      current.push(node);
    }
  }
  chunks.push(current);

  for (const chunk of chunks) {
    if (chunk.length === 0 || isCombinator(chunk[0])) continue;
    const pseudoElementIndex = chunk.findIndex((node) => isPseudoElement(node));
    const sortable = pseudoElementIndex === -1 ? chunk : chunk.slice(0, pseudoElementIndex);
    const rest = pseudoElementIndex === -1 ? [] : chunk.slice(pseudoElementIndex);
    sortable.sort(compareSimpleSelectors);
    chunk.splice(0, chunk.length, ...sortable, ...rest);
  }

  selector.nodes = chunks.flat() as typeof selector.nodes;
  for (const node of selector.nodes) {
    node.parent = selector;
  }
}

const selectorProcessor = selectorParser((root: SelectorRoot) => {
  // Normalize whitespace on every node.
  root.walk((node: SelectorNode) => {
    node.spaces = {before: '', after: ''};
    const raws = (node as {raws?: {spaces?: unknown}}).raws;
    if (raws && typeof raws === 'object' && 'spaces' in raws) {
      delete raws.spaces;
    }
    if (isCombinator(node)) {
      const value = node.value ? node.value.trim() : '';
      if (value === '') {
        node.value = ' ';
      } else {
        node.value = value;
        node.spaces = {before: ' ', after: ' '};
      }
    }
  });

  // Sort simple selectors within each compound (deepest first, so inner
  // normalization is reflected in the outer sort keys).
  const selectors: SelectorSlice[] = [];
  root.walk((node: SelectorNode) => {
    if (isSelector(node)) {
      selectors.push(node);
    }
  });
  for (let i = selectors.length - 1; i >= 0; i--) {
    normalizeComplexSelector(selectors[i]);
  }

  // Sort the selector-list arguments of :is()/:where()/:not()/:has().
  const pseudoContainers: SelectorPseudo[] = [];
  root.walk((node: SelectorNode) => {
    if (isPseudo(node) && node.value && SORTABLE_PSEUDO_CONTAINERS.has(node.value.toLowerCase())) {
      pseudoContainers.push(node);
    }
  });
  for (let i = pseudoContainers.length - 1; i >= 0; i--) {
    pseudoContainers[i].nodes.sort((a, b) => a.toString().localeCompare(b.toString()));
  }

  // Sort the top-level selector list and drop exact duplicates (identical
  // selectors within one list are equivalent to a single occurrence).
  root.nodes.sort((a, b) => a.toString().localeCompare(b.toString()));
  const seen = new Set<string>();
  for (const node of [...root.nodes]) {
    const key = node.toString();
    if (seen.has(key)) {
      node.remove();
    } else {
      seen.add(key);
    }
  }
});

/**
 * Normalizes insignificant whitespace inside at-rule preludes. Params
 * containing quotes are left untouched since whitespace inside strings is
 * significant.
 */
function normalizeAtRuleParams(atRule: AtRule): void {
  if (!atRule.params || atRule.params.includes('"') || atRule.params.includes("'")) {
    return;
  }
  atRule.params = atRule.params
    .replace(/\s+/g, ' ')
    .replace(/\s*([:,])\s*/g, '$1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Formats all nodes with deterministic whitespace. */
function format(node: PostcssNode, depth: number): void {
  const indent = '  '.repeat(depth);
  if (node.type === 'rule') {
    node.raws = {before: '\n' + indent, between: ' ', after: '\n' + indent, semicolon: true};
  } else if (node.type === 'decl') {
    node.raws = {before: '\n' + indent, between: ': '};
  } else if (node.type === 'atrule') {
    const atRule = node as AtRule;
    atRule.raws =
      atRule.nodes !== undefined
        ? {
            before: '\n' + indent,
            between: ' ',
            afterName: atRule.params ? ' ' : '',
            after: '\n' + indent,
            semicolon: true,
          }
        : {before: '\n' + indent, between: '', afterName: ' '};
  }
}

/**
 * Canonicalizes a stylesheet for comparison. Rule order, declaration order,
 * declaration values, and empty rules are preserved; see the module docs for
 * what is normalized.
 */
export function canonicalizeCss(css: string): string {
  const root = postcss.parse(css);

  // Comments have no semantics; drop them for comparison purposes.
  root.walkComments((comment: Comment) => {
    comment.remove();
  });

  root.walkAtRules((atRule: AtRule) => {
    normalizeAtRuleParams(atRule);
  });

  root.walkRules((rule: Rule) => {
    const parent = rule.parent;
    if (parent?.type === 'atrule' && /keyframes$/i.test((parent as AtRule).name)) {
      // Keyframe step qualifiers (from/to/percentages) are not selectors.
      rule.selector = rule.selector.replace(/\s+/g, ' ').trim();
      return;
    }
    rule.selector = selectorProcessor.processSync(rule.selector);
  });

  let depth = 0;
  const walkFormat = (container: PostcssNode & {nodes?: PostcssNode[]}) => {
    for (const child of container.nodes ?? []) {
      format(child, depth);
      if ('nodes' in child && (child as {nodes?: PostcssNode[]}).nodes) {
        depth++;
        walkFormat(child as PostcssNode & {nodes?: PostcssNode[]});
        depth--;
      }
    }
  };
  walkFormat(root);
  root.raws = {};

  return root.toString().trim() + '\n';
}
