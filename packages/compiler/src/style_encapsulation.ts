import type {
  AtRule,
  Comment,
  Root as CssRoot,
  Declaration,
  PluginCreator,
  ProcessOptions,
  Rule,
} from 'postcss';
import type {
  Base,
  Combinator,
  Container,
  Node,
  Pseudo,
  Root,
  Selector,
  Tag,
} from 'postcss-selector-parser';
import parser from 'postcss-selector-parser';

// Note: destructured from the default export rather than imported as named
// imports since postcss-selector-parser is a CommonJS module whose named
// exports aren't statically detectable when loaded from an ES module in Node.
const {
  attribute,
  className,
  combinator,
  isCombinator,
  isComment,
  isPseudo,
  isPseudoElement,
  isRoot,
  isTag,
  isUniversal,
  pseudo,
  selector,
} = parser;

interface StyleEncapsulationOptions extends ProcessOptions {
  /**
   * The name of the class to use for scoping content.
   *
   * E.g. `.foo` becomes `.foo.content`.
   */
  readonly content?: string;
  /**
   * The name of the class to use for scoping the :host.
   *
   * E.g. `:host(.foo)` becomes `.foo.host`.
   */
  readonly host?: string;
  /**
   * Whether to emulate ACX's legacy style encapsulation behavior.
   *
   * When enabled, selectors after :host or :host-context are not encapsulated.
   */
  readonly legacy?: boolean;
  /**
   * Whether to emulate Angular's emulated style encapsulation behavior.
   *
   * When enabled, `content` and `host` are treated as attribute names rather
   * than class names, and selectors are scoped with attribute selectors.
   *
   * E.g. `.foo` becomes `.foo[content]` instead of `.foo.content`.
   */
  readonly isAngular?: boolean;
}

// LINT.IfChange

// The code in this IFTTT block is ripped from Angular's style encapsulation. It
// would be nice to share this code more directly some day, but for now it's
// just copied. It's not 100% spec-compliant, but making it 100% compliant is
// high-effort and would be inconsistent with Angular's implementation.

/**
 * Unescape all quotes present in a string, but only if the string was actually already
 * quoted.
 *
 * This generates a "canonical" representation of strings which can be used to match strings
 * which would otherwise only differ because of differently escaped quotes.
 *
 * For example it converts the string (assumed to be quoted):
 *  `this \\"is\\" a \\'\\\\'test`
 * to:
 *  `this "is" a '\\\\'test`
 * (note that the latter backslashes are not removed as they are not actually escaping the single
 * quote)
 *
 *
 * @param str the string possibly containing escaped quotes.
 * @param isQuoted boolean indicating whether the string was quoted inside a bigger string (if not
 * then it means that it doesn't represent an inner string and thus no unescaping is required)
 *
 * @return the string in the "canonical" representation without escaped quotes.
 */
function unescapeQuotes(str: string, isQuoted: boolean): string {
  return !isQuoted ? str : str.replace(/((?:^|[^\\])(?:\\\\)*)\\(?=['"])/g, '$1');
}

/**
 * Function used to scope a keyframes name (obtained from an animation declaration)
 * using an existing set of unscopedKeyframes names to discern if the scoping needs to be
 * performed (keyframes names of keyframes not defined in the component's css need not to be
 * scoped).
 *
 * @param keyframe the keyframes name to check.
 * @param scopeSelector the component's scope selector.
 * @param unscopedKeyframesSet the set of unscoped keyframes names.
 *
 * @return the scoped name of the keyframe, or the original name is the name need not to be
 * scoped.
 */
function scopeAnimationKeyframe(
  keyframe: string,
  scopeSelector: string,
  unscopedKeyframesSet: ReadonlySet<string>,
): string {
  return keyframe.replace(/^(\s*)(['"]?)(.+?)\2(\s*)$/, (_, spaces1, quote, name, spaces2) => {
    name = `${
      unscopedKeyframesSet.has(unescapeQuotes(name, quote)) ? scopeSelector + '_' : ''
    }${name}`;
    return `${spaces1}${quote}${name}${quote}${spaces2}`;
  });
}

const animationDeclarationKeyframesRe =
  /(^|\s+|,)(?:(?:(['"])((?:\\\\|\\\2|(?!\2).)+)\2)|(-?[A-Za-z][\w\-]*))(?=[,\s]|$)/g;

/**
 * The following set contains all keywords that can be used in the animation css shorthand
 * property and is used during the scoping of keyframes to make sure such keywords
 * are not modified.
 */
const animationKeywords = new Set([
  // global values
  'inherit',
  'initial',
  'revert',
  'unset',
  // animation-direction
  'alternate',
  'alternate-reverse',
  'normal',
  'reverse',
  // animation-fill-mode
  'backwards',
  'both',
  'forwards',
  'none',
  // animation-play-state
  'paused',
  'running',
  // animation-timing-function
  'ease',
  'ease-in',
  'ease-in-out',
  'ease-out',
  'linear',
  'step-start',
  'step-end',
  // `steps()` function
  'end',
  'jump-both',
  'jump-end',
  'jump-none',
  'jump-start',
  'start',
]);

// LINT.ThenChange(//depot/google3/third_party/javascript/angular2/rc/packages/compiler/src/shadow_css.ts)

/**
 * Splits a comma-separated string into an array of strings, respecting quotes.
 *
 * Commas that are inside of single or double quotes are not treated as
 * separators.
 *
 * For example:
 * 'foo, bar' => ['foo', ' bar']
 * 'foo, "bar, baz", qux' => ['foo', ' "bar, baz"', ' qux']
 */
function splitRepeatedQuoteAware(str: string): string[] {
  const names = [];
  let currentQuoteChar = undefined;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '\\') {
      i++;
    } else if (currentQuoteChar) {
      if (char === currentQuoteChar) {
        currentQuoteChar = undefined;
      }
    } else if (char === '"' || char === "'") {
      currentQuoteChar = char;
    } else if (char === ',') {
      names.push(str.substring(start, i));
      start = i + 1;
    }
  }
  names.push(str.substring(start));
  return names;
}

const plugin: PluginCreator<StyleEncapsulationOptions> = (opts = {}) => {
  const {content = 'content', host = 'host', legacy = false, isAngular = false} = opts;
  return {
    postcssPlugin: 'postcss-style-encapsulation',
    // tslint:disable-next-line:enforce-name-casing
    Once(root: CssRoot) {
      const keyframesNames = new Set<string>();
      root.walkAtRules(/^(-webkit-)?keyframes$/, (rule: AtRule) => {
        rule.params = rule.params.replace(/^(['"]?)(.*)\1$/, (_, quote, keyframesName) => {
          keyframesNames.add(unescapeQuotes(keyframesName, quote));
          return `${quote}${content}_${keyframesName}${quote}`;
        });
      });
      root.walkDecls(/^(-webkit-)?animation(-name)?/, (decl: Declaration) => {
        if (decl.prop.endsWith('animation')) {
          decl.value = decl.value.replace(
            animationDeclarationKeyframesRe,
            (
              original: string,
              leadingSpaces: string,
              quote = '',
              quotedName: string,
              nonQuotedName: string,
            ) => {
              if (quotedName) {
                return `${leadingSpaces}${scopeAnimationKeyframe(
                  `${quote}${quotedName}${quote}`,
                  content,
                  keyframesNames,
                )}`;
              } else {
                return animationKeywords.has(nonQuotedName)
                  ? original
                  : `${leadingSpaces}${scopeAnimationKeyframe(
                      nonQuotedName,
                      content,
                      keyframesNames,
                    )}`;
              }
            },
          );
        } else if (decl.prop.endsWith('animation-name')) {
          decl.value = splitRepeatedQuoteAware(decl.value)
            .map((keyframesName) => scopeAnimationKeyframe(keyframesName, content, keyframesNames))
            .join(',');
        }
      });

      const comments: Comment[] = [];
      root.walkComments((comment: Comment) => {
        comments.push(comment);
      });
      for (const comment of comments) {
        removeComment(comment, isAngular);
      }
      root.walkRules((rule: Rule) => {
        const parent = rule.parent;
        if (parent?.type === 'atrule' && atRulesToSkip.has(parent.name)) {
          // Some at-rules are special. For example, @keyframes are defined with
          // a rule-list yet can only contain keyframe-selector qualifiers.
          // https://drafts.csswg.org/css-animations/#typedef-keyframe-selector
          return;
        }
        if (isAngular && hasUnscopableAtRuleAncestor(rule)) {
          // Rules inside @font-face or @page cannot be scoped. Such rules are
          // usually authoring errors (e.g. `:host ::ng-deep` applied to
          // imported styles containing @font-face); Angular strips the
          // scoping selectors from them instead of encapsulating.
          rule.selector = parser((selectorList: Root) => {
            stripScopingSelectors(selectorList);
          }).processSync(rule.selector, {lossless: true});
          return;
        }
        rule.selector = parser((selectorList: Root) => {
          rewriteHostContext(selectorList, isAngular);
          selectorList.each((selector) => {
            shimSelector(
              selector,
              content,
              host,
              legacy,
              isAngular,
              selector.nodes.some((node) => isPseudo(node) && node.value === ':host'),
            );
          });
        }).processSync(rule.selector, {lossless: true});
      });
    },
  };
};
plugin.postcss = true;
export default plugin;

/** Matches comments carrying sourcemap information, e.g. `/*# sourceMappingURL=...`. */
const sourceMapCommentRe = /^\/\*\s*#\s*source(Mapping)?URL=/;

/**
 * Removes a comment from the stylesheet.
 *
 * In Angular mode, comments carrying sourcemap information are kept, and the
 * newlines of removed comments are preserved (transferred to the following
 * node) so that removal does not shift line numbers, which would break
 * component sourcemaps.
 */
function removeComment(comment: Comment, isAngular: boolean): void {
  if (isAngular) {
    // Reconstruct the comment as written, excluding any preceding whitespace
    // captured in raws.before.
    const text = `/*${comment.raws.left ?? ''}${comment.text}${comment.raws.right ?? ''}*/`;
    if (sourceMapCommentRe.test(text)) {
      return;
    }
    const newlines = text.match(/\r?\n/g)?.join('') ?? '';
    const removedRaws = (comment.raws.before ?? '') + newlines;
    const next = comment.next();
    const parent = comment.parent;
    const nextBefore = next?.raws.before ?? '';
    // Note: raws are restored after removal since Root.removeChild() rewrites
    // the next node's raws.before when the first child is removed.
    comment.remove();
    if (next) {
      next.raws.before = removedRaws + nextBefore;
    } else if (parent) {
      parent.raws.after = removedRaws + (parent.raws.after ?? '');
    }
    return;
  }
  comment.remove();
}

/** Helper type to unwrap the child type of Container. */
type UnwrapContainerChild<T> = T extends Container<infer Value, infer Child> ? Child : never;
/** All nodes that can be children of a Selector. */
type SelectorChild = UnwrapContainerChild<Selector>;
type CombinatorOrPseudo = Combinator | Pseudo;

const atRulesToSkip = new Set(['keyframes', '-webkit-keyframes']);

/** At-rules whose contents cannot contain scoped selectors, e.g. @font-face. */
const unscopableAtRules = new Set(['font-face', 'page']);

/** Whether the rule is inside an at-rule that cannot contain scoped selectors. */
function hasUnscopableAtRuleAncestor(rule: Rule): boolean {
  type Ancestor = {type: string; name?: string; parent?: Ancestor} | undefined;
  for (let parent = rule.parent as Ancestor; parent; parent = parent.parent) {
    if (
      parent.type === 'atrule' &&
      parent.name !== undefined &&
      unscopableAtRules.has(parent.name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Removes scoping selectors (:host, :host-context, ::ng-deep and the
 * shadow-piercing combinators) from the given selector list. Used for rules
 * that cannot be encapsulated, such as those inside @font-face.
 */
function stripScopingSelectors(selectorList: Root): void {
  selectorList.each((selector: Selector) => {
    selector.each((node: Node) => {
      if (isCombinator(node) && (node.value === '>>>' || node.value === '/deep/')) {
        node.value = ' ';
      } else if (
        isPseudo(node) &&
        (node.value === ':host' || node.value === ':host-context' || node.value === '::ng-deep')
      ) {
        node.remove();
      }
    });
  });
}

/**
 * Rewrites :host-context selectors into their equivalent :host selectors and
 * rewrites :-acx-global-context as :UNSCOPED.
 */
function rewriteHostContext(selectorList: Root, isAngular: boolean): void {
  selectorList.each((selector: Selector) => {
    const hostContextNodes: Pseudo[] = [];
    let currentCompoundIndex = 0;
    // The index of the compound containing :host-context(). Note: This assumes
    // all :host-context() are in the same compound selector. Bad input is UB.
    let hostContextIndex: number | undefined;
    selector.each((node: Node, index: number) => {
      if (isCombinator(node)) {
        currentCompoundIndex = index + 1;
      }
      if (!isPseudo(node)) return;

      if (node.value === ':-acx-global-context') {
        // Replaces the :-acx-global-context with :UNSCOPED so that subsequent
        // steps don't need to account for both.
        node.value = ':UNSCOPED';
      } else if (node.value === ':host-context') {
        if (isAngular && (node.length === 0 || node.first.length === 0)) {
          // Angular only converts :host-context with a non-empty argument.
          // Bare `:host-context` and `:host-context()` are left as-is and
          // scoped like any other pseudo-class.
          return;
        }
        hostContextNodes.push(node);
        hostContextIndex ??= currentCompoundIndex;
        node.replaceWith(hostPseudo());
      }
    });

    if (hostContextIndex !== undefined) {
      // Create every permutation of :host-context arguments.
      const nodePermutations = getNodePermutations(hostContextNodes);
      const replacementSelectors = createSelectorsFromPermutations(
        selector,
        nodePermutations,
        hostContextIndex,
      );
      selector.replaceWith(...replacementSelectors);
    }
  });
}

/**
 * Returns every permutation of nodes that should be placed for the given
 * :host-context nodes.
 *
 * For example, given :host-context(.x):host-context(.y):host-context(.z), this
 * will return:
 *
 * ```
 * [
 *   ['.x', ' ', '.y', ' ', '.z'],
 *   ['.x', ' ', '.y', '.z'],
 *   ['.x', '.y', ' ', '.z'],
 *   ['.y', ' ', '.z', ' ', '.x'],
 *   ...
 * ]
 * ```
 *
 * The sequence produced by this function is modeled by Ordered Bell Numbers, or
 * Fubini numbers. https://oeis.org/A000670
 */
function getNodePermutations(hostContextNodes: Pseudo[]): CombinatorOrPseudo[][] {
  if (hostContextNodes.length === 0) return [];
  // Get the argument for each :host-context(<arg>).
  const hostContextArgs = hostContextNodes.map((node) => node.first);
  // Kickstart the permutations list with one of the arguments. Each array of
  // selectors in `permutations` represents a compound selector in a complex
  // selector to be joined by descendant combinators.
  let permutations: Selector[][] = [[hostContextArgs.pop()!]];
  // For each additional argument, create a new permutation for each possible
  // placement within each existing permutation.
  for (const hostContextArg of hostContextArgs) {
    const nextPermutations: Selector[][] = [];
    for (const compoundSelectors of permutations) {
      for (let i = 0; i < compoundSelectors.length; i++) {
        // Place the argument before the current compound selector.
        nextPermutations.push(
          cloneNodes([
            ...compoundSelectors.slice(0, i),
            hostContextArg,
            ...compoundSelectors.slice(i),
          ]),
        );
        // Place the argument inside the current compound selector.
        const clone = cloneNodes(compoundSelectors);
        safeInsertAll(clone[i].first, hostContextArg);
        nextPermutations.push(clone);
      }
      // Place the argument after the last compound selector.
      nextPermutations.push(cloneNodes([...compoundSelectors, hostContextArg]));
    }
    permutations = nextPermutations;
  }

  // Convert each array of compound selectors in `permutations` into an array of
  // nodes joined by descendant combinators.
  const permutationsWithCombinators: CombinatorOrPseudo[][] = [];
  for (const compoundSelectors of permutations) {
    const permutationWithCombinators: CombinatorOrPseudo[] = [];
    for (const compoundSelector of compoundSelectors) {
      // Place compound in an :UNSCOPED since it represents the host's context.
      permutationWithCombinators.push(unscoped(compoundSelector));
      permutationWithCombinators.push(descendantCombinator());
    }
    permutationWithCombinators.pop(); // Remove the trailing combinator.
    permutationsWithCombinators.push(permutationWithCombinators);
  }
  return permutationsWithCombinators;
}

/**
 * Insert each permutation of nodes into a clone of the given selector at the
 * hostContextIndex. Do this both with the remaining nodes on the same element
 * and as a descendant.
 */
function createSelectorsFromPermutations(
  selector: Selector,
  permutations: CombinatorOrPseudo[][],
  hostContextIndex: number,
): Selector[] {
  if (permutations.length === 0) return [selector];
  const replacementSelectors: Selector[] = [];
  for (const permutation of permutations) {
    const nodesBeforeHostContext = selector.nodes.slice(0, hostContextIndex);
    const nodesAfterHostContext = selector.nodes.slice(hostContextIndex);

    // Create a selector with the existing selector as a descendant of the
    // replacement nodes.
    // For permutation `['.x', ' ', '.y']` and selector `:host`, this becomes
    // `.x .y :host`.
    replacementSelectors.push(
      selectorFromNodes([
        ...nodesBeforeHostContext,
        ...permutation,
        descendantCombinator(),
        ...nodesAfterHostContext,
      ]),
    );

    // Create a selector with the existing nodes on the most local of the
    // replacement nodes.
    // For permutation `['.x', ' ', '.y']` and selector `:host`, this becomes
    // `.x .y:host`.
    const selectorWithoutCombinator = selector.clone();
    const lastNode = permutation.pop() as Pseudo; // :UNSCOPED()
    safeInsertAll(selectorWithoutCombinator.at(hostContextIndex), lastNode.first);
    for (const node of permutation) {
      node.parent = selectorWithoutCombinator;
    }
    selectorWithoutCombinator.nodes.splice(hostContextIndex, 0, ...permutation);
    replacementSelectors.push(selectorWithoutCombinator);
  }
  return replacementSelectors;
}

/**
 * Creates a simple selector node used to scope selectors. This is a class
 * selector (`.name`) by default, or an attribute selector (`[name]`) when
 * targeting Angular's emulated encapsulation.
 */
function scopeNode(name: string, isAngular: boolean): SelectorChild {
  return isAngular
    ? attribute({attribute: name, value: undefined, raws: {}})
    : className({value: name});
}

/**
 * Scopes the selector with the given content and host classes following a few
 * rules:
 * - :host is rewritten as .hostClass. :host-context is assumed to be absent.
 * - Selectors after ::ng-deep are not scoped. ::ng-deep is removed.
 * - Selectors before :host are not scoped. They're implicitly global.
 * - All other selectors have .contentClass appended.
 */
function shimSelector(
  selector: Selector,
  contentClass: string,
  hostClass: string,
  legacy: boolean,
  isAngular: boolean,
  containsHostPseudo: boolean,
) {
  let seenDeep = false;
  let seenHost = false;
  // Selectors before a :host are implicitly global.
  let needsContentClass = !containsHostPseudo;
  selector.each((node: Node, index: number) => {
    if (isCombinator(node)) {
      if (isAngular && (node.value === '>>>' || node.value === '/deep/')) {
        // The deprecated shadow-piercing combinators act like ::ng-deep:
        // selectors after them are not scoped. They're replaced with a
        // descendant combinator.
        seenDeep = true;
        node.value = ' ';
      }
      seenDeep ||= legacy && seenHost; // Don't scope after :host in legacy mode
      needsContentClass = !seenDeep && containsHostPseudo === seenHost;
      return;
    }
    if (isPseudo(node)) {
      if (node.value === ':host') {
        seenHost = true;
        needsContentClass = false;
        if (node.length > 0) {
          // Add `arg` to the node's container, e.g. `<arg>:host(<arg>)`.
          safeInsertAll(node, node.first);
        }

        if (!seenDeep) {
          // While it _should_ be illegal to write `::ng-deep :host`, some tests
          // rely on the fact that `::ng-deep` escapes `:host` shimming.
          safeInsert(node, scopeNode(hostClass, isAngular));
          node.remove();
        }
      } else if (node.value === ':UNSCOPED') {
        needsContentClass = false;
        node.replaceWith(node.first);
      } else if (node.value === '::ng-deep') {
        seenDeep = true;
        needsContentClass = false;
        touchupCombinatorsAroundNgDeep(node);
        node.remove();
      } else if (node.value === ':root') {
        needsContentClass = false;
      }
    }

    if (needsContentClass) {
      // Add a .content class if this is the last place we can without changing
      // scoped element.
      const next = node.next();
      if (
        !next ||
        isCombinator(next) ||
        isPseudoElement(next) ||
        (!node.prev() && isPseudoElement(node))
      ) {
        safeInsert(node, scopeNode(contentClass, isAngular));
        needsContentClass = false;
      }
    }
  });
}

/**
 * Throws an error for the given node, or more generally if the root node is not
 * found.
 */
function throwFor(node: Base, message: string): never {
  let count = 0;
  let current: Base | undefined = node;
  while (!isRoot(current)) {
    if (!current || count++ > 100) {
      // Arbitrarily high number to prevent infinite loops when the Node isn't
      // a child of the Root.
      throw new Error(message);
    }
    current = current?.parent;
  }
  throw (current as Root).error(message, {
    index: node.sourceIndex,
    word: node.value,
  });
}

/**
 * Inserts all of the nodes from toInsert into the compound selector containing
 * node. Asserts that toInsert doesn't contain a combinator.
 */
function safeInsertAll(node: Node, toInsert: Selector) {
  const container = node.parent!;
  if (container === toInsert) return;
  if (toInsert.length === 0) return;

  const nodesToInsert = toInsert.nodes;

  // Insert the first node and use it as an anchor for the rest.
  let nodeToInsertAfter = nodesToInsert[0];
  safeInsert(node, nodeToInsertAfter);
  const firstIsTag = isTag(nodeToInsertAfter);

  for (let i = 1; i < nodesToInsert.length; i++) {
    const nodeToInsert = nodesToInsert[i];

    if (isCombinator(nodeToInsert)) {
      throwFor(nodeToInsert, `Can't insert "${toInsert}" because it contains a combinator.`);
    }
    if (isPseudoElement(nodeToInsert) && isPseudoElement(nodeToInsertAfter.next())) {
      // Since insertAfterNode was inserted with safeInsert, we know its next
      // node is either a combinator or a pseudo-element. Assert that it's not a
      // pseudo-element.
      throwFor(
        nodeToInsert,
        `Can't insert "${toInsert}" because "${container}" already contains a pseudo-element.`,
      );
    }

    if (i === 1 && firstIsTag) {
      // If the first node is a tag, we should find a new anchor node in case
      // `toInsert` contains a pseudo-element.
      safeInsert(nodeToInsertAfter, nodeToInsert);
    } else {
      // Insert the node after the previous node.
      container.insertAfter(nodeToInsertAfter, nodeToInsert);
    }
    nodeToInsertAfter = nodeToInsert;
  }
}

/**
 * Inserts toInsert into the compound selector containing node. Tries to place
 * it as far into the compound as possible. Asserts that the compound doesn't
 * contain a pseudo-element if the toInsert also contains one.
 */
function safeInsert(node: Node, toInsert: SelectorChild) {
  if (isCombinator(toInsert) || isComment(toInsert)) {
    throwFor(toInsert, `Cannot insert a ${toInsert.type}.`);
  }
  if (isTag(toInsert)) {
    // TODO(b/372324802): Do we need to account for sub-pseudo-elements?
    // https://drafts.csswg.org/selectors/#sub-pseudo-elements
    safeInsertTag(node, toInsert);
    return;
  }

  // The node to insert before, if any. This will be a combinator, pseudo
  // element, or undefined.
  let insertBeforeNode: Node | undefined = node;
  while (
    insertBeforeNode &&
    !isCombinator(insertBeforeNode) &&
    !isPseudoElement(insertBeforeNode)
  ) {
    insertBeforeNode = insertBeforeNode.next();
  }

  // Either insert or append the node into the container.
  const container = node.parent!;
  if (insertBeforeNode) {
    if (isPseudoElement(insertBeforeNode) && isPseudoElement(toInsert)) {
      throwFor(
        toInsert,
        `Can't insert "${toInsert}" because "${container}" already contains a pseudo-element.`,
      );
    }
    container.insertBefore(insertBeforeNode, toInsert);
  } else {
    container.append(toInsert);
  }
}

/**
 * Inserts the given toInsert tag into the compound selector containing node.
 * Asserts that the compound doesn't already contain a tag, but allows replacing
 * a universal selector.
 */
function safeInsertTag(node: Node, toInsert: Tag) {
  const container = node.parent!;
  let insertAfterNode: Node | undefined = node;
  while (insertAfterNode) {
    if (isCombinator(insertAfterNode)) {
      container.insertAfter(insertAfterNode, toInsert);
      return;
    } else if (isTag(insertAfterNode)) {
      throwFor(
        toInsert,
        `Can't insert "${toInsert}" because "${container}" already contains a tag.`,
      );
    } else if (isUniversal(insertAfterNode)) {
      insertAfterNode.replaceWith(toInsert);
      return;
    }
    insertAfterNode = insertAfterNode.prev();
  }
  container.prepend(toInsert);
}

/**
 * Creates a new selector with clones of the given nodes.
 */
function selectorFromNodes(nodes: SelectorChild[]): Selector {
  const parent = selector({nodes: [], value: ''});
  for (const node of nodes) {
    const clonedNode = node.clone();
    clonedNode.parent = parent;
    parent.append(clonedNode);
  }
  return parent;
}

/**
 * Creates a new :UNSCOPED pseudo-element that wraps the given selector.
 */
function unscoped(selector: Selector): Pseudo {
  const unscopedPseudo = pseudo({
    value: ':UNSCOPED',
    nodes: [selector],
  });
  selector.parent = unscopedPseudo;
  return unscopedPseudo;
}

function descendantCombinator(): Combinator {
  return combinator({value: ' '});
}

function hostPseudo(): Pseudo {
  return pseudo({value: ':host'});
}

/**
 * Maps the array to a new array with each node cloned.
 */
function cloneNodes<T extends Node>(nodes: T[]): T[] {
  return nodes.map((node) => node.clone() as T);
}

/**
 * Remove unnecessary combinators around ::ng-deep.
 *
 * We don't really need to mess with the combinators here. This makes the
 * resulting list of nodes a bit cleaner, but should be removed if it ever shows
 * up in the profiler.
 */
function touchupCombinatorsAroundNgDeep(node: Node) {
  const prev = node.prev();
  const next = node.next();
  if (isCombinator(prev) && isCombinator(next)) {
    if (prev.value === ' ') {
      prev.remove();
    } else if (next.value === ' ') {
      next.remove();
    }
  }
}
