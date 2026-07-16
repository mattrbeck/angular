/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// Vendored from the standalone `semantic_css_diff` tool (src/index.ts), with the
// Node-only file diffing / CLI pieces removed. Keep the canonicalization pipeline
// in sync with the original when updating either copy.

import postcss, {
  Rule,
  Declaration,
  Container,
  AtRule,
  ChildNode,
  Node as PostcssNode,
} from 'postcss';
import selectorParser, {
  Node as SelectorNode,
  Root as SelectorRoot,
  Container as SelectorContainer,
  Attribute as SelectorAttribute,
  Combinator as SelectorCombinator,
  Tag as SelectorTag,
  Pseudo as SelectorPseudo,
  Selector as SelectorSlice,
} from 'postcss-selector-parser';

// ============================================================================
// 1. TOP-LEVEL TYPE DEFINITIONS, INTERFACES & TYPE GUARDS
// ============================================================================

/** Represents simple compound selector target elements for conservative overlap verification. */
interface SelectorTarget {
  tag: string | null;
  id: string | null;
  pseudoElement: string | null;
}

// --- PostCSS AST Type Guards ---

/** Type guard to narrow a PostCSS node to a Rule. */
function isRule(node: PostcssNode | ChildNode | undefined): node is Rule {
  return node?.type === 'rule';
}

/** Type guard to narrow a PostCSS node to an AtRule. */
function isAtRule(node: PostcssNode | ChildNode | undefined): node is AtRule {
  return node?.type === 'atrule';
}

/** Type guard to narrow a PostCSS node to a Declaration. */
function isDeclaration(node: PostcssNode | ChildNode | undefined): node is Declaration {
  return node?.type === 'decl';
}

/** Type guard to check if a PostCSS node is a container with children (Rule, AtRule, Root). */
function isContainerNode(node: PostcssNode | ChildNode | undefined): node is Container {
  return node !== undefined && 'nodes' in node && Array.isArray((node as Container).nodes);
}

/** Type guard to check if a PostCSS node has child nodes (Rule, block AtRule, Root). */
function hasChildNodes(
  node: PostcssNode | ChildNode | undefined,
): node is (Container | Rule | AtRule) & {nodes: ChildNode[]} {
  return node !== undefined && 'nodes' in node && Array.isArray((node as Container).nodes);
}

// --- Selector Parser Built-in AST Type Guards ---

const {
  isContainer: isSelectorContainer,
  isAttribute: isSelectorAttribute,
  isCombinator: isSelectorCombinator,
  isPseudo: isSelectorPseudo,
  isTag: isSelectorTag,
  isSelector: isSelectorSlice,
  isPseudoElement: isSelectorPseudoElement,
  isIdentifier: isSelectorIdentifier,
} = selectorParser;

/** Type guard to check if a selector container node has initialized child nodes. */
function hasSelectorChildNodes(
  node: SelectorNode | undefined,
): node is (SelectorRoot | SelectorSlice | SelectorPseudo) & {nodes: SelectorNode[]} {
  return isSelectorContainer(node) && node.nodes !== undefined;
}

// ============================================================================
// 2. GLOBAL CONSTANTS & PRE-COMPILED REGEXES
// ============================================================================

/** Properties that preserve case sensitivity in values (e.g., grid areas, animation names, fonts). */
const CASE_SENSITIVE_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'animation-name',
  'animation',
  'grid-area',
  'grid-row',
  'grid-column',
  'grid-row-start',
  'grid-row-end',
  'grid-column-start',
  'grid-column-end',
  'grid-template-areas',
  'grid-template-rows',
  'grid-template-columns',
  'grid-template',
  'grid',
  'counter-reset',
  'counter-increment',
  'counter-set',
  'container-name',
  'container',
  'view-transition-name',
  'page',
  'list-style-type',
  'list-style',
  'will-change',
  'content',
  'font-family',
  'font',
  'anchor-name',
  'position-anchor',
  'anchor-scope',
  'scroll-timeline-name',
  'scroll-timeline',
  'view-timeline-name',
  'view-timeline',
  'timeline-scope',
  'animation-timeline',
  'position-try-options',
  'position-try',
  'page-transition-tag',
  'font-palette',
  'view-transition-class',
  'view-transition',
  'transition-property',
  'transition',
  'font-variant-alternates',
  'font-variant',
  'string-set',
  'color-scheme',
  'speak-as',
  'fallback',
  'system',
  'symbols',
  'additive-symbols',
  'pad',
  'negative',
  'range',
  'src',
]);

/** Tokenizer regex to split strings and url() calls from non-string CSS tokens. */
const STRING_OR_URL_TOKENIZER =
  /('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|url\((?:'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|[^)]*)\))/i;

/** Matches url(...) syntax for normalizing quotes inside URLs. */
const URL_MATCH_RE = /^url\((['"]?)(.*)\1\)$/is;

/** Matches 3-digit hex colors for normalization to 6 digits (e.g., #abc -> #aabbcc). */
const HEX_COLOR_RE = /#([0-9a-f])([0-9a-f])([0-9a-f])\b/gi;

/** Matches zero values with units for unit stripping (e.g., 0px -> 0). */
const ZERO_UNIT_RE =
  /\b0(?:\.0+)?(?:px|em|rem|%|vh|vw|vmin|vmax|pt|pc|in|cm|mm|ex|ch)(?![a-zA-Z%])/g;

/** Matches math, color, or shape function names at the end of a string slice before an opening parenthesis. */
const MATH_OR_COLOR_FUNCTION_RE =
  /(?:calc|min|max|clamp|hsl|hsla|rgb|rgba|color|color-mix|color-contrast|light-dark|hwb|lab|lch|oklab|oklch|xywh|rect|inset|polygon|circle|ellipse|matrix|matrix3d|rotate3d|translate3d|perspective|var|env|hypot|abs|sign|mod|rem|round|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|exp|log)\s*$/i;

/** Decimal and zero normalization regexes. */
const ZERO_DECIMAL_RE1 = /\b0+\.0+(?![a-zA-Z%])/g;
const ZERO_DECIMAL_RE2 = /(^|[\s,(/])\.(\d)/g;
const ZERO_DECIMAL_RE3 =
  /(\d+\.\d*?)0+(?=\s|,|;|$|[)\/]|px|em|rem|%|vh|vw|vmin|vmax|pt|pc|in|cm|mm|ex|ch)/gi;
const ZERO_DECIMAL_RE4 =
  /(\d+)\.(?=\s|,|;|$|[)\/]|px|em|rem|%|vh|vw|vmin|vmax|pt|pc|in|cm|mm|ex|ch)/gi;

/** Properties where 0px, 0em, 0rem, 0%, etc. can be safely canonicalized to unitless 0. */
const ZERO_UNIT_STRIP_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-block-start',
  'margin-block-end',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-block-start',
  'padding-block-end',
  'padding-inline',
  'padding-inline-start',
  'padding-inline-end',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'inline-size',
  'block-size',
  'min-inline-size',
  'min-block-size',
  'max-inline-size',
  'max-block-size',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-block-start',
  'inset-block-end',
  'inset-inline',
  'inset-inline-start',
  'inset-inline-end',
  'border',
  'border-width',
  'border-top',
  'border-top-width',
  'border-right',
  'border-right-width',
  'border-bottom',
  'border-bottom-width',
  'border-left',
  'border-left-width',
  'border-block',
  'border-block-width',
  'border-inline',
  'border-inline-width',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'border-start-start-radius',
  'border-start-end-radius',
  'border-end-start-radius',
  'border-end-end-radius',
  'outline',
  'outline-width',
  'outline-offset',
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'grid-row-gap',
  'grid-column-gap',
  'border-spacing',
  'box-shadow',
  'text-shadow',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-size',
]);

/** At-rules allowed to remain empty without being purged by ASTCleaner. */
const EMPTY_ALLOWED_AT_RULES: ReadonlySet<string> = new Set<string>([
  'layer',
  'keyframes',
  'counter-style',
  'property',
]);

/** At-rules that must not be deduplicated based solely on string representation. */
const NON_DEDUPLICABLE_AT_RULES: ReadonlySet<string> = new Set<string>([
  'layer',
  'font-face',
  'counter-style',
  'keyframes',
  'property',
  'import',
  'scope',
  'container',
  'media',
  'supports',
  'page',
]);

/** Pseudo-classes that contain sortable selector lists. */
const SORTABLE_PSEUDO_CONTAINERS: ReadonlySet<string> = new Set<string>([
  ':is',
  ':where',
  ':not',
  ':has',
  ':matches',
  ':-webkit-any',
  ':-moz-any',
]);

/** Progressive enhancement fallback detection regexes. */
const VENDOR_PREFIX_RE = /-(?:webkit|moz|ms|o|khtml|apple)-/i;
const MODERN_URL_RE = /\burl\(/i;
const MODERN_IMAGE_RE =
  /(?:image-set|cross-fade|paint|element|radial-gradient|conic-gradient|repeating-)/i;
const MODERN_CLIP_RE = /(?:path|xywh)\(/i;
const MODERN_FEATURES_RE =
  /(?:color|color-mix|lch|oklch|lab|oklab|hwb|light-dark|color-contrast|clamp|min|max|fit-content|anchor|anchor-size|linear-gradient|var|env|calc|hypot|abs|sign|mod|rem|round|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|exp|log|attr|rgba|hsla|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia)\(|(?:\b\d+(?:\.\d+)?(?:dvh|dvw|lvh|lvw|svh|svw|dvi|dvb|lvi|lvb|svi|svb|cqi|cqw|cqh|cqb|cqmin|cqmax)\b)/i;
const MODERN_KEYWORDS_RE =
  /\b(?:grid|inline-grid|flex|inline-flex|contents|flow-root|subgrid|masonry|sticky|fit-content|max-content|min-content|stretch|clip|break-spaces|balance|pretty|canvas|canvastext|accentcolor|buttonface|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolortext|text|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)\b/i;

// ============================================================================
// 3. TARGET & SELECTOR ANALYSIS LAYER
// ============================================================================

class SelectorAnalyzer {
  private static extractTargetsCache = new Map<string, SelectorTarget[]>();

  /**
   * Extracts simple target elements (tag, id, pseudoElement) from a selector string.
   * Caches results in a module-scoped Map to avoid repetitive selector parsing.
   */
  public static extractTargets(selectorString: string): SelectorTarget[] {
    const cached = this.extractTargetsCache.get(selectorString);
    if (cached) {
      return cached;
    }

    const targets: SelectorTarget[] = [];
    try {
      selectorParser((root: SelectorRoot) => {
        root.nodes.forEach((selector: SelectorNode) => {
          const lastCompound: SelectorNode[] = [];
          if (hasSelectorChildNodes(selector)) {
            for (let i = selector.nodes.length - 1; i >= 0; i--) {
              const node = selector.nodes[i];
              if (node && isSelectorCombinator(node)) {
                break;
              }
              if (node) lastCompound.push(node);
            }
          }

          let tag: string | null = null;
          let id: string | null = null;
          const pseudoElements: string[] = [];

          lastCompound.forEach((node: SelectorNode) => {
            if (isSelectorTag(node)) tag = node.value || null;
            if (isSelectorIdentifier(node)) id = node.value || null;
            if (isSelectorPseudoElement(node) && node.value) {
              pseudoElements.push(node.value.replace(/^::/, ':'));
            }
          });

          targets.push({
            tag,
            id,
            pseudoElement: pseudoElements.length ? pseudoElements.join('') : null,
          });
        });
      }).processSync(selectorString);
    } catch {
      targets.push({tag: null, id: null, pseudoElement: null});
    }

    this.extractTargetsCache.set(selectorString, targets);
    return targets;
  }

  /**
   * Evaluates whether two PostCSS Rule nodes could target the same DOM element by comparing
   * their extracted target tags, IDs, and pseudo-elements. Conservatively ignores classes and attributes.
   */
  public static rulesOverlap(ruleA: Rule, ruleB: Rule): boolean {
    const targetsA = this.extractTargets(ruleA.selector);
    const targetsB = this.extractTargets(ruleB.selector);

    for (const a of targetsA) {
      for (const b of targetsB) {
        let overlap = true;

        if (a.tag && b.tag && a.tag !== b.tag && a.tag !== '*' && b.tag !== '*') {
          overlap = false;
        }
        if (a.id && b.id && a.id !== b.id) {
          overlap = false;
        }
        if (a.pseudoElement && b.pseudoElement && a.pseudoElement !== b.pseudoElement) {
          overlap = false;
        }

        if (overlap) return true;
      }
    }
    return false;
  }
}

// ============================================================================
// 4. VALUE & PROPERTY CANONICALIZATION LAYER
// ============================================================================

class ValueCanonicalizer {
  /**
   * Canonicalizes declaration values by standardizing quotes, hex colors, zero units, and decimals.
   * Skips custom properties and properties where case sensitivity is required.
   */
  public static normalizeValue(prop: string, value: string): string {
    if (prop.startsWith('--') || prop.startsWith('$') || prop.startsWith('@')) {
      return value;
    }
    const parts = value.split(STRING_OR_URL_TOKENIZER);
    let normalized = parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const urlMatch = part.match(URL_MATCH_RE);
          if (urlMatch) {
            let inner = urlMatch[2];
            if (!/[\s'"()]/.test(inner)) {
              return `url(${inner})`;
            }
            inner = inner.replace(/\\"/g, '"').replace(/'/g, "\\'");
            return `url('${inner}')`;
          }
          if (part.startsWith('"') && part.endsWith('"')) {
            let inner = part.slice(1, -1);
            inner = inner.replace(/\\"/g, '"').replace(/'/g, "\\'");
            return `'${inner}'`;
          }
          if (part.startsWith("'") && part.endsWith("'")) {
            const inner = part.slice(1, -1);
            return `'${inner}'`;
          }
          return part;
        }

        let lower =
          CASE_SENSITIVE_PROPERTIES.has(prop) ||
          part.startsWith('--') ||
          part.startsWith('$') ||
          part.startsWith('@')
            ? part
            : part.toLowerCase();

        lower = lower.replace(HEX_COLOR_RE, (_match, r, g, b) => {
          return `#${r}${r}${g}${g}${b}${b}`;
        });

        if (ZERO_UNIT_STRIP_PROPERTIES.has(prop)) {
          lower = lower.replace(ZERO_UNIT_RE, (match, offset, fullStr) => {
            let depth = 0;
            for (let j = offset - 1; j >= 0; j--) {
              if (fullStr[j] === ')') depth++;
              else if (fullStr[j] === '(') {
                if (depth > 0) {
                  depth--;
                } else {
                  const funcMatch = fullStr.slice(0, j).match(MATH_OR_COLOR_FUNCTION_RE);
                  if (funcMatch) {
                    return match;
                  }
                  break;
                }
              }
            }
            return '0';
          });
        }

        lower = lower.replace(ZERO_DECIMAL_RE1, '0');
        lower = lower.replace(ZERO_DECIMAL_RE2, '$10.$2');
        lower = lower.replace(ZERO_DECIMAL_RE3, '$1');
        lower = lower.replace(ZERO_DECIMAL_RE4, '$1');
        return lower;
      })
      .join('');

    if (prop === 'font-weight') {
      if (normalized === 'bold') normalized = '700';
      if (normalized === 'normal') normalized = '400';
    }

    return normalized;
  }

  /**
   * Checks if two declarations for the same property represent modern CSS fallbacks
   * (e.g., vendor prefixes, url(), modern color/math functions, or keywords).
   */
  public static isProgressiveEnhancementFallback(existingVal: string, declVal: string): boolean {
    if (existingVal === declVal) return false;
    const hasVendorPrefix = (val: string) => VENDOR_PREFIX_RE.test(val);
    if (hasVendorPrefix(existingVal) || hasVendorPrefix(declVal)) return true;
    if (!MODERN_URL_RE.test(existingVal) && MODERN_URL_RE.test(declVal)) return true;
    if (!MODERN_IMAGE_RE.test(existingVal) && MODERN_IMAGE_RE.test(declVal)) return true;
    if (!MODERN_CLIP_RE.test(existingVal) && MODERN_CLIP_RE.test(declVal)) return true;
    if (!MODERN_FEATURES_RE.test(existingVal) && MODERN_FEATURES_RE.test(declVal)) return true;
    if (!MODERN_KEYWORDS_RE.test(existingVal) && MODERN_KEYWORDS_RE.test(declVal)) return true;
    return false;
  }
}

// ============================================================================
// 5. SELECTOR NORMALIZATION LAYER
// ============================================================================

class SelectorNormalizer {
  private static compareSelectorNodes(a: SelectorNode, b: SelectorNode): number {
    if (isSelectorTag(a) && !isSelectorTag(b)) return -1;
    if (isSelectorTag(b) && !isSelectorTag(a)) return 1;
    return a.toString().localeCompare(b.toString());
  }

  private static processor = selectorParser((selectorsRoot: SelectorRoot) => {
    selectorsRoot.walk((node: SelectorNode) => {
      node.spaces = {before: '', after: ''};
      if ('raws' in node && node.raws && typeof node.raws === 'object' && 'spaces' in node.raws) {
        delete (node.raws as Record<string, unknown>)['spaces'];
      }
      if (isSelectorCombinator(node)) {
        const val = node.value ? node.value.trim() : '';
        if (val === '') {
          node.value = ' ';
          node.spaces = {before: '', after: ''};
        } else {
          node.value = val;
          node.spaces = {before: ' ', after: ' '};
        }
      }
      if (isSelectorAttribute(node)) {
        const raws = node.raws as {insensitive?: string; insensitiveFlag?: string} | undefined;
        const hasFlag =
          node.insensitive || Boolean(raws?.insensitiveFlag) || Boolean(raws?.insensitive);
        node.spaces = {
          before: '',
          after: '',
          attribute: {before: '', after: ''},
          operator: {before: '', after: ''},
          value: {before: '', after: hasFlag ? ' ' : ''},
        };
        if (raws?.insensitiveFlag) {
          raws.insensitiveFlag = raws.insensitiveFlag.toLowerCase();
        }
        if (raws?.insensitive) {
          raws.insensitive = raws.insensitive.toLowerCase();
        }
      }
    });

    selectorsRoot.walk((node: SelectorNode) => {
      if (isSelectorSlice(node) && hasSelectorChildNodes(node)) {
        const selector = node;
        const chunks: SelectorNode[][] = [];
        let currentChunk: SelectorNode[] = [];

        selector.nodes.forEach((child: SelectorNode) => {
          if (isSelectorCombinator(child)) {
            chunks.push(currentChunk);
            chunks.push([child]);
            currentChunk = [];
          } else {
            currentChunk.push(child);
          }
        });
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }

        chunks.forEach((chunk: SelectorNode[]) => {
          if (chunk.length === 0 || isSelectorCombinator(chunk[0])) return;

          chunk.forEach((n: SelectorNode) => {
            if (isSelectorTag(n) && n.value) n.value = n.value.toLowerCase();
            if (isSelectorAttribute(n)) {
              if (n.insensitive && n.value) {
                n.value = n.value.toLowerCase();
              }
            }
            if (isSelectorPseudo(n) && n.value) {
              n.value = n.value.toLowerCase();
              if (
                n.value === ':before' ||
                n.value === ':after' ||
                n.value === ':first-letter' ||
                n.value === ':first-line'
              ) {
                n.value = ':' + n.value;
              }
            }
          });

          const firstPseudoIdx = chunk.findIndex((n) => isSelectorPseudoElement(n));
          if (firstPseudoIdx !== -1) {
            const beforePseudo = chunk.slice(0, firstPseudoIdx);
            const afterPseudo = chunk.slice(firstPseudoIdx);
            beforePseudo.sort((a, b) => SelectorNormalizer.compareSelectorNodes(a, b));
            chunk.splice(0, chunk.length, ...beforePseudo, ...afterPseudo);
          } else {
            chunk.sort((a, b) => SelectorNormalizer.compareSelectorNodes(a, b));
          }
        });

        selector.removeAll();
        chunks.forEach((chunk: SelectorNode[]) => {
          chunk.forEach((n: SelectorNode) => {
            if (!isSelectorSlice(n)) {
              selector.append(n);
            }
          });
        });
      }
    });

    const pseudoContainers: ((SelectorRoot | SelectorSlice | SelectorPseudo) & {
      nodes: SelectorNode[];
    })[] = [];
    selectorsRoot.walk((node: SelectorNode) => {
      if (
        isSelectorPseudo(node) &&
        hasSelectorChildNodes(node) &&
        node.value &&
        SORTABLE_PSEUDO_CONTAINERS.has(node.value)
      ) {
        pseudoContainers.push(node);
      }
    });
    for (let i = pseudoContainers.length - 1; i >= 0; i--) {
      pseudoContainers[i].nodes.sort((a, b) => a.toString().localeCompare(b.toString()));
    }

    selectorsRoot.nodes.sort((a: SelectorNode, b: SelectorNode) =>
      a.toString().localeCompare(b.toString()),
    );
  });

  /** Normalizes a Rule's selector using the static selectorParser processor. */
  public static normalizeRuleSelector(rule: Rule): void {
    rule.selector = this.processor.processSync(rule.selector);
  }
}

// ============================================================================
// 6. AST PRUNING & DEDUPLICATION LAYER
// ============================================================================

class ASTCleaner {
  /**
   * Iteratively traverses container nodes to remove empty Rule and AtRule nodes,
   * excluding specific structural at-rules such as @layer and @keyframes.
   */
  public static removeEmptyNodes(container: Container): void {
    let changed: boolean;
    do {
      changed = false;
      container.walkRules((rule: Rule) => {
        if (rule.nodes && rule.nodes.length === 0) {
          rule.remove();
          changed = true;
        }
      });
      container.walkAtRules((atRule: AtRule) => {
        if (!EMPTY_ALLOWED_AT_RULES.has(atRule.name) && atRule.nodes && atRule.nodes.length === 0) {
          atRule.remove();
          changed = true;
        }
      });
    } while (changed);
  }
}

class AtRuleParamsNormalizer {
  /**
   * Normalizes insignificant whitespace inside at-rule preludes, e.g.
   * `@media screen and (max-width:800px)` and `@media screen and (max-width: 800px)`
   * are semantically identical. Params containing quotes (e.g. `@import "a.css"`)
   * are left untouched since whitespace inside strings is significant.
   */
  public static normalizeAll(root: Container): void {
    root.walkAtRules((atRule: AtRule) => {
      if (!atRule.params || atRule.params.includes('"') || atRule.params.includes("'")) {
        return;
      }
      atRule.params = atRule.params
        .replace(/\s+/g, ' ')
        .replace(/\s*([:,])\s*/g, '$1 ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .trim();
    });
  }
}

class RuleSplitter {
  /**
   * Step 0: Splits rules with comma-separated selectors into individual cloned rules.
   * A two-phase staging array is required because inserting or removing child rules
   * during an active walkRules traversal in PostCSS causes infinite loops or undefined behavior.
   */
  public static splitCommaSelectors(root: Container): void {
    const toSplit: Rule[] = [];
    root.walkRules((rule: Rule) => {
      if (rule.selectors && rule.selectors.length > 1) {
        toSplit.push(rule);
      }
    });
    toSplit.forEach((rule) => {
      rule.selectors.forEach((sel) => {
        rule.cloneBefore({selectors: [sel]});
      });
      rule.remove();
    });
  }
}

class DeclarationOptimizer {
  /**
   * Step 2: Removes overridden properties and exact duplicate declarations while preserving
   * stylesheet order, !important precedence, and progressive enhancement fallbacks.
   */
  public static optimizeAll(root: Container): void {
    this.optimizeContainer(root);
    root.walkRules((rule: Rule) => {
      this.optimizeContainer(rule);
    });
    root.walkAtRules((atRule: AtRule) => {
      this.optimizeContainer(atRule);
    });
  }

  public static optimizeContainer(container: Container): void {
    if (!container.nodes) return;

    const decls = container.nodes.filter(isDeclaration);
    const keptDecls = new Map<string, Declaration[]>();

    decls.forEach((decl) => {
      if (!decl.prop.startsWith('--')) {
        decl.prop = decl.prop.toLowerCase();
      }
      decl.value = ValueCanonicalizer.normalizeValue(decl.prop, decl.value);

      const list = keptDecls.get(decl.prop) || [];
      const nextList: Declaration[] = [];
      let isIgnored = false;

      for (const existing of list) {
        if (existing.important && !decl.important) {
          isIgnored = true;
          nextList.push(existing);
          continue;
        }
        if (existing.value === decl.value && existing.important === decl.important) {
          continue;
        }
        if (ValueCanonicalizer.isProgressiveEnhancementFallback(existing.value, decl.value)) {
          nextList.push(existing);
        }
      }
      if (!isIgnored) {
        nextList.push(decl);
      }
      keptDecls.set(decl.prop, nextList);
    });

    const allKept = new Set<Declaration>();
    for (const list of keptDecls.values()) {
      for (const d of list) allKept.add(d);
    }

    decls.forEach((decl) => {
      if (!allKept.has(decl)) {
        decl.remove();
      }
    });
  }
}

class RuleDeduplicator {
  /**
   * Step 4: Removes exact duplicate rules and eligible at-rules in reverse order.
   * Reverse iteration ensures that later rules in stylesheet order (which take cascade precedence)
   * survive while earlier duplicates are removed. Excludes special at-rules (e.g. @layer, @import)
   * whose duplicates or ordering have structural cascade meaning.
   */
  public static deduplicateAll(root: Container): void {
    this.deduplicateContainer(root);
    root.walkAtRules((atRule: AtRule) => {
      this.deduplicateContainer(atRule);
    });
  }

  public static deduplicateContainer(container: Container): void {
    if (!container.nodes) return;
    const seen = new Set<string>();
    [...container.nodes].reverse().forEach((node: ChildNode) => {
      if (isRule(node) || (isAtRule(node) && !NON_DEDUPLICABLE_AT_RULES.has(node.name))) {
        const oldRaws = node.raws;
        node.raws = {};
        if (hasChildNodes(node)) {
          node.walk((child: PostcssNode) => {
            child.raws = {};
          });
        }
        const str = node.toString();

        if (seen.has(str)) {
          node.remove();
        } else {
          seen.add(str);
        }
        node.raws = oldRaws;
      }
    });
  }
}

// ============================================================================
// 7. RULE MERGING LAYER
// ============================================================================

class RuleMerger {
  /**
   * Step 5: Merges declarations of rules sharing identical selectors if no intervening
   * overlapping rule or at-rule exists between them in the cascade.
   */
  public static mergeAll(root: Container): void {
    this.mergeContainer(root);
    root.walkAtRules((atRule: AtRule) => {
      this.mergeContainer(atRule);
    });
  }

  private static canSafelyMerge(
    nodes: ChildNode[],
    idxI: number,
    idxJ: number,
    ruleI: Rule,
  ): boolean {
    for (let k = idxI + 1; k < idxJ; k++) {
      const nodeK = nodes[k];
      if (!nodeK.parent) continue; // Skip removed nodes

      if (isAtRule(nodeK)) {
        return false;
      }
      if (isRule(nodeK) && SelectorAnalyzer.rulesOverlap(ruleI, nodeK)) {
        return false;
      }
    }
    return true;
  }

  public static mergeContainer(container: Container): void {
    if (!container.nodes) return;

    const rules = container.nodes.filter(isRule);
    if (rules.length < 2) return;

    const rulesBySelector = new Map<string, Rule[]>();
    rules.forEach((r) => {
      const sel = r.selector;
      const existing = rulesBySelector.get(sel);
      if (existing) {
        existing.push(r);
      } else {
        rulesBySelector.set(sel, [r]);
      }
    });

    let merged = true;
    while (merged) {
      merged = false;

      for (const sameSelectorRules of rulesBySelector.values()) {
        if (sameSelectorRules.length < 2) continue;

        for (let i = 0; i < sameSelectorRules.length; i++) {
          for (let j = i + 1; j < sameSelectorRules.length; j++) {
            const ruleI = sameSelectorRules[i];
            const ruleJ = sameSelectorRules[j];

            if (!container.nodes) break;
            const nodeIdxI = container.nodes.indexOf(ruleI);
            const nodeIdxJ = container.nodes.indexOf(ruleJ);

            if (this.canSafelyMerge(container.nodes, nodeIdxI, nodeIdxJ, ruleI)) {
              ruleJ.walkDecls((decl: Declaration) => {
                ruleI.walkDecls((existing: Declaration) => {
                  if (
                    existing.prop === decl.prop &&
                    existing.important === decl.important &&
                    !ValueCanonicalizer.isProgressiveEnhancementFallback(existing.value, decl.value)
                  ) {
                    existing.remove();
                  }
                });
                ruleI.append(decl.clone());
              });
              ruleJ.remove();

              sameSelectorRules.splice(j, 1);
              merged = true;
              break;
            }
          }
          if (merged) break;
        }
        if (merged) break;
      }
    }
  }
}

// ============================================================================
// 8. RULE SORTING LAYER
// ============================================================================

class RuleSorter {
  /**
   * Step 7: Topologically sorts consecutive runs of rules within a container.
   */
  public static sortAll(root: Container): void {
    this.sortContainer(root);
    root.walkAtRules((atRule: AtRule) => {
      this.sortContainer(atRule);
    });
  }

  public static sortContainer(container: Container): void {
    if (!container.nodes || !container.nodes.some(isRule)) return;

    const runs = this.splitIntoRuns(container.nodes);
    runs.forEach((run) => {
      this.sortRun(run, container);
    });
  }

  /**
   * Partitions container children into consecutive runs of Rule nodes.
   * Comments and at-rules break runs, placing rules into separate runs that cannot be
   * reordered across the comment or at-rule blockade.
   */
  private static splitIntoRuns(nodes: ChildNode[]): Rule[][] {
    let currentRun: Rule[] = [];
    const runs: Rule[][] = [];

    nodes.forEach((n: ChildNode) => {
      if (isRule(n)) {
        currentRun.push(n);
      } else {
        if (currentRun.length > 1) runs.push(currentRun);
        currentRun = [];
      }
    });
    if (currentRun.length > 1) runs.push(currentRun);

    return runs;
  }

  /**
   * Sorts a single run of rules using Kahn's Topological Sort algorithm.
   * Why topological sort? In CSS, cascade order must be preserved when two rules overlap
   * in selector targets (e.g. `.foo` and `.foo.bar`). We construct a dependency directed
   * acyclic graph (DAG) where an edge run[i] -> run[j] exists if rules overlap and have
   * differing declarations.
   * Rules with inDegree === 0 (no unresolved dependencies) are sorted alphabetically
   * by canonical string representation to guarantee deterministic output.
   */
  private static sortRun(run: Rule[], container: Container): void {
    const canonStrMap = new WeakMap<Rule, string>();

    run.forEach((rule) => {
      rule.raws = {};
      rule.nodes.forEach((decl) => {
        decl.raws = {};
      });
      canonStrMap.set(rule, rule.toString());
    });

    const inDegree = new Map<Rule, number>();
    const adj = new Map<Rule, Rule[]>();
    run.forEach((r) => {
      inDegree.set(r, 0);
      adj.set(r, []);
    });

    for (let i = 0; i < run.length; i++) {
      for (let j = i + 1; j < run.length; j++) {
        if (SelectorAnalyzer.rulesOverlap(run[i], run[j])) {
          const declsI = run[i].nodes
            .filter(isDeclaration)
            .map((n) => n.toString())
            .join(';');
          const declsJ = run[j].nodes
            .filter(isDeclaration)
            .map((n) => n.toString())
            .join(';');
          if (declsI !== declsJ) {
            const adjI = adj.get(run[i]);
            if (adjI) adjI.push(run[j]);
            inDegree.set(run[j], (inDegree.get(run[j]) || 0) + 1);
          }
        }
      }
    }

    const sortedRun: Rule[] = [];
    const available: Rule[] = [];
    run.forEach((r) => {
      if (inDegree.get(r) === 0) available.push(r);
    });

    while (available.length > 0) {
      available.sort((a, b) => (canonStrMap.get(a) || '').localeCompare(canonStrMap.get(b) || ''));
      const nextRule = available.shift()!;
      sortedRun.push(nextRule);

      const neighbors = adj.get(nextRule) || [];
      neighbors.forEach((neighbor) => {
        const deg = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, deg);
        if (deg === 0) {
          available.push(neighbor);
        }
      });
    }

    const anchor = run[run.length - 1].next();
    run.forEach((r) => r.remove());
    if (anchor && anchor.parent) {
      sortedRun.forEach((r) => container.insertBefore(anchor, r));
    } else {
      sortedRun.forEach((r) => container.append(r));
    }
  }
}

// ============================================================================
// 9. AST FORMATTING LAYER
// ============================================================================

class ASTFormatter {
  /**
   * Step 8: Standardizes whitespace, indentation (2 spaces per AST depth level),
   * newlines, colons, and semicolons across all nodes.
   */
  public static format(root: Container): void {
    root.walk((node: PostcssNode) => {
      const depth = this.getDepth(node);
      const indent = '  '.repeat(depth);

      if (isRule(node)) {
        node.raws = {
          before: '\n' + indent,
          between: ' ',
          after: '\n' + indent,
          semicolon: true,
        };
      } else if (isDeclaration(node)) {
        node.raws = {
          before: '\n' + indent,
          between: ': ',
        };
      } else if (isAtRule(node)) {
        if (node.nodes !== undefined) {
          node.raws = {
            before: '\n' + indent,
            between: ' ',
            afterName: node.params ? ' ' : '',
            after: '\n' + indent,
            semicolon: true,
          };
        } else {
          node.raws = {
            before: '\n' + indent,
            between: '',
            afterName: ' ',
          };
        }
      }
    });
    root.raws = {};
  }

  private static getDepth(node: PostcssNode): number {
    let depth = 0;
    let parent = node.parent;
    while (parent && parent.type !== 'root') {
      depth++;
      parent = parent.parent;
    }
    return depth;
  }
}

// ============================================================================
// 10. CORE PIPELINE ORCHESTRATOR & DIFF UTILITIES
// ============================================================================

export function canonicalizeCss(css: string): string {
  const root = postcss.parse(css);

  AtRuleParamsNormalizer.normalizeAll(root);
  RuleSplitter.splitCommaSelectors(root);
  root.walkRules((rule: Rule) => SelectorNormalizer.normalizeRuleSelector(rule));
  DeclarationOptimizer.optimizeAll(root);
  ASTCleaner.removeEmptyNodes(root);
  RuleDeduplicator.deduplicateAll(root);
  RuleMerger.mergeAll(root);
  ASTCleaner.removeEmptyNodes(root);
  RuleSorter.sortAll(root);
  ASTFormatter.format(root);

  return root.toString().trim() + '\n';
}
