/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// This file (and everything it imports) depends on postcss, which cannot be
// bundled by the web-test pipeline; it is only part of the node test library
// (see the NODE_ONLY list in ../BUILD.bazel).

import {shimStyleEncapsulation} from '../../src/style_encapsulation_shim';
import {canonicalizeCss} from './semantic_css';

/**
 * Shims the given css with the PostCSS-based style encapsulation, mirroring
 * the ShadowCss.shimCssText() API used by `shim()` from `./utils`.
 */
export function shimPostcss(css: string, contentAttr: string, hostAttr: string = '') {
  return shimStyleEncapsulation(css, contentAttr, hostAttr);
}

const semanticCssMatchers: jasmine.CustomMatcherFactories = {
  toEqualCss: function (): jasmine.CustomMatcher {
    return {
      compare: function (actual: string, expected: string): jasmine.CustomMatcherResult {
        // Prefer a semantic comparison so that equivalent output that differs
        // only syntactically (e.g. `.foo[hosta]` vs `[hosta].foo`) is treated
        // as equal. Fall back to a whitespace-insensitive textual comparison
        // when either side is not parseable as standalone CSS (some tests use
        // intentionally invalid CSS or placeholder markers).
        let passes: boolean;
        let actualCss: string;
        let expectedCss: string;
        try {
          actualCss = canonicalizeCss(actual);
          expectedCss = canonicalizeCss(expected);
        } catch {
          actualCss = extractCssContent(actual);
          expectedCss = extractCssContent(expected);
        }
        passes = actualCss === expectedCss;
        return {
          pass: passes,
          message: passes
            ? 'CSS equals as expected'
            : `Expected '${actualCss}' to equal '${expectedCss}'`,
        };
      },
    };
  },
};

function extractCssContent(css: string): string {
  return css
    .replace(/^\n\s+/, '')
    .replace(/\n\s+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/:\s/g, ':')
    .replace(/ }/g, '}');
}

// Upgrade the textual toEqualCss matcher (registered by ./utils) to the
// semantic comparison for the whole node test run. The web test run never
// loads this file and keeps the textual matcher.
beforeEach(function () {
  jasmine.addMatchers(semanticCssMatchers);
});
