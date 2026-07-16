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

    it('should match ShadowCss output for pseudo selector functions', () => {
      // :where() and :is() have their inner selectors scoped individually.
      expectMatchesShadowCss(':where(.one) {}');
      expectMatchesShadowCss(':where(div.one span.two) {}');
      expectMatchesShadowCss(':where(.one) .two {}');
      expectMatchesShadowCss(':where(:host) {}');
      expectMatchesShadowCss(':where(:host) .one {}');
      expectMatchesShadowCss(':where(.one) :where(:host) {}');
      expectMatchesShadowCss(':where(.one :host) {}');
      expectMatchesShadowCss('div :where(.one) {}');
      expectMatchesShadowCss(':host :where(.one .two) {}');
      expectMatchesShadowCss(':where(.one, .two) {}');
      expectMatchesShadowCss(':where(.one > .two) {}');
      expectMatchesShadowCss(':where(> .one) {}');
      expectMatchesShadowCss(':where(:not(.one) ~ .two) {}');
      expectMatchesShadowCss(':where([foo]) {}');
      expectMatchesShadowCss(':where(a):where(b) {}');
      expectMatchesShadowCss('div:is(.foo) {}');
      expectMatchesShadowCss(':is(.dark :host) {}');
      expectMatchesShadowCss(':is(.dark) :is(:host) {}');
      expectMatchesShadowCss(':host:is(.foo) {}');
      expectMatchesShadowCss(':is(.foo) {}');
      expectMatchesShadowCss(':is(.foo, .bar, .baz) {}');
      expectMatchesShadowCss(':is(.foo, .bar) :host {}');
      expectMatchesShadowCss(
        ':is(.foo, .bar) :is(.baz) :where(.one, .two) :host :where(.three:first-child) {}',
      );
      expectMatchesShadowCss(':where(:is(a)) {}');
      expectMatchesShadowCss(':where(:is(a, b)) {}');
      expectMatchesShadowCss(':where(:host:is(.one, .two)) {}');
      expectMatchesShadowCss(':where(:host :is(.one, .two)) {}');
      expectMatchesShadowCss(':where(:is(a, b) :is(.one, .two)) {}');
      expectMatchesShadowCss(
        ':where(:where(a:has(.foo), b) :is(.one, .two:where(.foo > .bar))) {}',
      );
      expectMatchesShadowCss(':where(.two):first-child {}');
      expectMatchesShadowCss(':first-child:where(.two) {}');
      expectMatchesShadowCss(':where(.two):nth-child(3) {}');
      expectMatchesShadowCss('table :where(td, th):hover { color: lime; }');
      expectMatchesShadowCss(':nth-child(3n of :not(p, a), :is(.foo)) {}');

      // :not() and :has() keep their inner selectors unscoped, but :host
      // inside them is converted.
      expectMatchesShadowCss('.header:not(.admin) {}');
      expectMatchesShadowCss('.header:is(:host > .toolbar, :host ~ .panel) {}');
      expectMatchesShadowCss('.header:where(:host > .toolbar, :host ~ .panel) {}');
      expectMatchesShadowCss('.header:not(.admin, :host.super .header) {}');
      expectMatchesShadowCss('.header:not(.admin, :host.super .header, :host.mega .header) {}');
      expectMatchesShadowCss('.one :where(.two, :host) {}');
      expectMatchesShadowCss('.one :where(:host, .two) {}');
      expectMatchesShadowCss(':is(.foo):is(:host):is(.two) {}');
      expectMatchesShadowCss(':where(.one, :host .two):first-letter {}');
      expectMatchesShadowCss(':first-child:where(.one, :host .two) {}');
      expectMatchesShadowCss(':where(.one, :host .two):nth-child(3):is(.foo, a:where(.bar)) {}');
      expectMatchesShadowCss('div:has(a) {}');
      expectMatchesShadowCss('div:has(a) :host {}');
      expectMatchesShadowCss(':has(a) :host :has(b) {}');
      expectMatchesShadowCss('div:has(~ .one) {}');
      expectMatchesShadowCss(':has(a) :has(b) {}');
      expectMatchesShadowCss(':has(a, b) {}');
      expectMatchesShadowCss(':has(a, b:where(.foo), :is(.bar)) {}');
      expectMatchesShadowCss(':has(a, b:where(.foo), :is(.bar):first-child):first-letter {}');
      expectMatchesShadowCss(':where(a, b:where(.foo), :has(.bar):first-child) {}');
      expectMatchesShadowCss(':has(.one :host, .two) {}');
      expectMatchesShadowCss(':has(.one, :host) {}');
      expectMatchesShadowCss('.foo:not(:host) {}');
      expectMatchesShadowCss(':host:not(:host.foo) {}');
      expectMatchesShadowCss(':host:not(.foo:host) {}');
      expectMatchesShadowCss(':host:not(:host.foo, :host.bar) {}');
      expectMatchesShadowCss(':host:not(:host.foo, .bar :host) {}');

      // Multi-argument :host is left as-is, like ShadowCss.
      expectMatchesShadowCss(':host(.a, .b) {}');
      expectMatchesShadowCss('.outer :host(.a, .b) .inner {}');
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

    it('should match ShadowCss output for :host-context', () => {
      expectMatchesShadowCss(':host-context(.one):host-context(.two) {}');
      expectMatchesShadowCss(':host-context(.X):host-context(.Y):host-context(.Z) {}');
      expectMatchesShadowCss(':host-context(.one,.two) .inner {}');
      expectMatchesShadowCss(':host-context(div):host(.x) > .y {}');
      expectMatchesShadowCss(':host-context(.one) :host {}');
      expectMatchesShadowCss(':host-context(div) :host(.x) > .y {}');
      expectMatchesShadowCss(':host-context(div) > :host(.x) > .y {}');
      expectMatchesShadowCss(':host-context(outer1) :host(bar) {}');
    });

    it('should match ShadowCss output for :host-context nested in :is/:where', () => {
      expectMatchesShadowCss(':where(:host-context(backdrop)) {}');
      expectMatchesShadowCss(':where(:host-context(outer1)) :host(bar) {}');
      expectMatchesShadowCss(':where(:host-context(.one)) :where(:host-context(.two)) {}');
      expectMatchesShadowCss(':where(:host-context(backdrop)) .foo ~ .bar {}');
      expectMatchesShadowCss(':where(:host-context(backdrop)) :host {}');
      expectMatchesShadowCss('div:where(:host-context(backdrop)) :host {}');
    });

    describe('known divergences from ShadowCss', () => {
      // ShadowCss's regex-based :host-context handling emits accidental
      // artifacts in some degenerate cases (doubled host markers that only
      // change specificity, or dangling bare `:host-context` prefixes that
      // match nothing). The postcss implementation intentionally produces
      // cleaner selectors matching the same elements.
      it('should produce a single host marker for :host followed by :host-context', () => {
        // ShadowCss: `.one[hosta][hosta], .one [hosta]`.
        expect(shimPostcss(':host:host-context(.one) {}', 'contenta', 'hosta')).toEqualCss(
          '.one[hosta], .one [hosta] {}',
        );
      });

      // postcss-selector-parser is spec-compliant for hex escapes terminated
      // by a space (the space is part of the escape), while ShadowCss splits
      // `.\fc ker` into two compound selectors when the character following
      // the space is not a hex digit.
      it('should treat a space terminating a hex escape as part of the escape', () => {
        expect(shimPostcss('.\\fc ber {}', 'contenta')).toEqualCss('.\\fc ber[contenta] {}');
        expect(shimPostcss('.\\fc ker {}', 'contenta')).toEqualCss('.\\fc ker[contenta] {}');
      });
    });
  });
});
