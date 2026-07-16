/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ShadowCss} from '../../src/shadow_css';

export function shim(css: string, contentAttr: string, hostAttr: string = '') {
  const shadowCss = new ShadowCss();
  return shadowCss.shimCssText(css, contentAttr, hostAttr);
}

// Note: this textual comparison is upgraded to a semantic one for the node
// test run by ./node_only_utils.ts, which cannot be loaded in web tests
// since its postcss dependency cannot be bundled by the web-test pipeline.
const shadowCssMatchers: jasmine.CustomMatcherFactories = {
  toEqualCss: function (): jasmine.CustomMatcher {
    return {
      compare: function (actual: string, expected: string): jasmine.CustomMatcherResult {
        const actualCss = extractCssContent(actual);
        const expectedCss = extractCssContent(expected);
        const passes = actualCss === expectedCss;
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
       * Expect the actual css value to be equal to the expected css. In web
       * tests extra spacing and newlines are ignored so that only the core
       * css content is compared; in node tests the comparison is semantic
       * (see ./node_only_utils.ts and ./semantic_css.ts).
       */
      toEqualCss(expected: string): void;
    }
  }
}
