/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import postcss from 'postcss';

import {ShadowCss} from '../../src/shadow_css';
import styleEncapsulation from '../../src/style_encapsulation';
import {canonicalizeCss} from './semantic_css';

export function shim(css: string, contentAttr: string, hostAttr: string = '') {
  const shadowCss = new ShadowCss();
  return shadowCss.shimCssText(css, contentAttr, hostAttr);
}

/**
 * Shims the given css with the PostCSS-based style encapsulation, mirroring
 * the ShadowCss.shimCssText() API used by `shim()`.
 */
export function shimPostcss(css: string, contentAttr: string, hostAttr: string = '') {
  return (
    postcss([styleEncapsulation({content: contentAttr, host: hostAttr, isAngular: true})])
      // `prev: false` prevents postcss from consuming (and crashing on)
      // sourceMappingURL comments in the input; `annotation: false` prevents it
      // from appending its own sourcemap annotation.
      .process(css, {from: undefined, map: {prev: false, annotation: false}}).css
  );
}

const shadowCssMatchers: jasmine.CustomMatcherFactories = {
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

beforeEach(function () {
  jasmine.addMatchers(shadowCssMatchers);
});

declare global {
  namespace jasmine {
    interface Matchers<T> {
      /**
       * Expect the actual css value to be equal to the expected css,
       * for this comparison extra spacing and newlines are ignored so
       * that only the core css content is being compared.
       */
      toEqualCss(expected: string): void;
    }
  }
}
