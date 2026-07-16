/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {shim, shimPostcss} from './utils';

/**
 * Expects the PostCSS-based encapsulation to produce output semantically
 * equivalent to Angular's ShadowCss for the given input.
 */
function expectMatchesShadowCss(css: string, contentAttr = 'contenta', hostAttr = 'hosta') {
  expect(shimPostcss(css, contentAttr, hostAttr)).toEqualCss(shim(css, contentAttr, hostAttr));
}

describe('style encapsulation (postcss)', () => {
  describe('with isAngular enabled', () => {
    it('should handle empty string', () => {
      expect(shimPostcss('', 'contenta')).toEqualCss('');
    });

    it('should add an attribute to every rule', () => {
      const css = 'one {color: red;}two {color: red;}';
      const expected = 'one[contenta] {color:red;}two[contenta] {color:red;}';
      expect(shimPostcss(css, 'contenta')).toEqualCss(expected);
    });

    it('should add an attribute to every selector', () => {
      const css = 'one, two {color: red;}';
      const expected = 'one[contenta], two[contenta] {color:red;}';
      expect(shimPostcss(css, 'contenta')).toEqualCss(expected);
    });

    it('should handle complicated selectors', () => {
      expect(shimPostcss('one::before {}', 'contenta')).toEqualCss('one[contenta]::before {}');
      expect(shimPostcss('one two {}', 'contenta')).toEqualCss('one[contenta] two[contenta] {}');
      expect(shimPostcss('one > two {}', 'contenta')).toEqualCss(
        'one[contenta] > two[contenta] {}',
      );
      expect(shimPostcss('one + two {}', 'contenta')).toEqualCss(
        'one[contenta] + two[contenta] {}',
      );
      expect(shimPostcss('one ~ two {}', 'contenta')).toEqualCss(
        'one[contenta] ~ two[contenta] {}',
      );
      expect(shimPostcss('.one.two > three {}', 'contenta')).toEqualCss(
        '.one.two[contenta] > three[contenta] {}',
      );
      expect(shimPostcss('one[attr="value"] {}', 'contenta')).toEqualCss(
        'one[attr="value"][contenta] {}',
      );
      expect(shimPostcss('[attr] {}', 'contenta')).toEqualCss('[attr][contenta] {}');
    });

    it('should handle :host', () => {
      expect(shimPostcss(':host {}', 'contenta', 'hosta')).toEqualCss('[hosta] {}');
      expect(shimPostcss(':host(.foo) {}', 'contenta', 'hosta')).toEqualCss('.foo[hosta] {}');
      expect(shimPostcss(':host .bar {}', 'contenta', 'hosta')).toEqualCss(
        '[hosta] .bar[contenta] {}',
      );
    });

    it('should scope keyframes and animations', () => {
      expect(
        shimPostcss('@keyframes foo {to {transform: none;}} .box {animation: foo 1s;}', 'contenta'),
      ).toEqualCss(
        '@keyframes contenta_foo {to {transform: none;}} .box[contenta] {animation: contenta_foo 1s;}',
      );
    });

    it('should scope selectors inside media queries', () => {
      expect(
        shimPostcss('@media screen and (max-width: 800px) {div {font-size: 50px;}}', 'contenta'),
      ).toEqualCss('@media screen and (max-width: 800px) {div[contenta] {font-size: 50px;}}');
    });

    describe('comments', () => {
      // Comments should be kept in the same position as otherwise inline
      // sourcemaps break due to shift in lines. These mirror the ShadowCss
      // comment tests and intentionally compare exact text.
      it('should remove inline comments without adding extra lines', () => {
        expect(shimPostcss('/* b {} */ b {}', 'contenta')).toBe(' b[contenta] {}');
      });

      it('should preserve internal newlines from multiline comments', () => {
        expect(shimPostcss('/* b {}\n */ b {}', 'contenta')).toBe('\n b[contenta] {}');
      });

      it('should remove multiple inline comments without adding extra lines', () => {
        expect(shimPostcss('/* b {} */ b {} /* a {} */ a {}', 'contenta')).toBe(
          ' b[contenta] {}  a[contenta] {}',
        );
      });

      it('should keep sourceMappingURL comments', () => {
        expect(shimPostcss('b {} /*# sourceMappingURL=data:x */', 'contenta')).toBe(
          'b[contenta] {} /*# sourceMappingURL=data:x */',
        );
        expect(shimPostcss('b {}/* #sourceMappingURL=data:x */', 'contenta')).toBe(
          'b[contenta] {}/* #sourceMappingURL=data:x */',
        );
      });

      it('should handle adjacent comments', () => {
        expect(shimPostcss('/* comment 1 */ /* comment 2 */ b {}', 'contenta')).toBe(
          '  b[contenta] {}',
        );
      });
    });

    it('should match ShadowCss output for basic cases', () => {
      expectMatchesShadowCss('one {color: red;}two {color: red;}');
      expectMatchesShadowCss('one, two {color: red;}');
      expectMatchesShadowCss('one::before {}');
      expectMatchesShadowCss('.one.two > three {}');
      expectMatchesShadowCss(':host {color: red;}');
      expectMatchesShadowCss(':host(.foo) {}');
      expectMatchesShadowCss(':host .bar {}');
      expectMatchesShadowCss('@media screen and (max-width: 800px) {div {font-size: 50px;}}');
      expectMatchesShadowCss('@keyframes foo {to {transform: none;}} .box {animation: foo 1s;}');
      expectMatchesShadowCss(':host ::ng-deep .foo {}');
    });

    it('should match ShadowCss output for deprecated shadow-piercing combinators', () => {
      expectMatchesShadowCss('x >>> y {}');
      expectMatchesShadowCss('x /deep/ y {}');
      expectMatchesShadowCss('x ::ng-deep y {}');
      expectMatchesShadowCss('cmp:host >>> {}');
      expectMatchesShadowCss('cmp:host >>> child {}');
      expectMatchesShadowCss('cmp :host >>> {}');
      expectMatchesShadowCss('cmp :host >>> child {}');
      expectMatchesShadowCss(':host >>> .x > .y {}');
    });

    it('should match ShadowCss output for @font-face and @page rules', () => {
      expectMatchesShadowCss('@font-face { font-family {} }');
      expectMatchesShadowCss('@font-face { :host ::ng-deep font-family{} }');
      expectMatchesShadowCss(
        '@supports (display: flex) { @font-face { :host ::ng-deep font-family{} } }',
      );
      expectMatchesShadowCss('@page { :host ::ng-deep @top-left { content:"Hamlet";}}');
      expectMatchesShadowCss('@page { div {} }');
    });

    it('should match ShadowCss output for :host-context without a valid argument', () => {
      expectMatchesShadowCss(':host-context .inner {}');
      expectMatchesShadowCss(':host-context() .inner {}');
      expectMatchesShadowCss(':host-context(.foo) .bar {}');
    });
  });
});
