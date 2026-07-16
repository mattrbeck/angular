/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import postcss from 'postcss';
import safeParser from 'postcss-safe-parser';

import styleEncapsulation from './style_encapsulation';

/**
 * Marker comment that opts a stylesheet into the postcss-based style
 * encapsulation instead of ShadowCss, enabling progressive per-component
 * (per-stylesheet) adoption without any public API changes. It works
 * identically for AOT and JIT compilation since both run the same style
 * compilation path.
 *
 * The `/*!` form survives CSS preprocessors and minifiers that strip regular
 * comments. The marker itself is removed from the emitted styles (it is
 * handled like any other non-sourcemap comment).
 */
const POSTCSS_ENCAPSULATION_MARKER = /\/\*!\s*use-postcss-encapsulation\s*\*\//;

/** Whether the stylesheet opts into the postcss-based style encapsulation. */
export function usesPostcssEncapsulation(cssText: string): boolean {
  return POSTCSS_ENCAPSULATION_MARKER.test(cssText);
}

/**
 * Shims the given css with the postcss-based style encapsulation, mirroring
 * the `ShadowCss.shimCssText()` API.
 *
 * @param cssText the css text to shim.
 * @param selector the attribute added to all elements inside the host.
 * @param hostSelector the attribute added to the host itself.
 */
export function shimStyleEncapsulation(
  cssText: string,
  selector: string,
  hostSelector: string = '',
): string {
  return postcss([
    styleEncapsulation({content: selector, host: hostSelector, isAngular: true}),
  ]).process(cssText, {
    from: undefined,
    // The fault-tolerant parser matches ShadowCss's tolerance of invalid
    // CSS: unparseable text passes through (with the valid parts shimmed)
    // instead of throwing. This is a per-invocation option, so other
    // consumers of the shared plugin (ACX) keep the standard strict parser.
    parser: safeParser,
    // `prev: false` prevents postcss from consuming sourceMappingURL
    // comments in the input; `annotation: false` prevents it from
    // appending its own sourcemap annotation.
    map: {prev: false, annotation: false},
  }).css;
}
