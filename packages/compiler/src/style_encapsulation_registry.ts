/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/**
 * Signature of the postcss-based style encapsulation implementation,
 * mirroring `ShadowCss.shimCssText()`.
 */
export type StyleEncapsulationShim = (
  cssText: string,
  selector: string,
  hostSelector: string,
) => string;

/**
 * Marker comment that opts a stylesheet into the postcss-based style
 * encapsulation instead of ShadowCss, enabling progressive per-component
 * (per-stylesheet) adoption without any public API changes.
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
 * The registered implementation, if any.
 *
 * Note: the implementation is registered (as a side effect of loading
 * `style_encapsulation_shim.ts`) rather than imported directly so that the
 * compiler's module graph does not depend on postcss. Browser bundles of
 * `@angular/compiler` (JIT) only carry postcss when the implementation module
 * is explicitly loaded — and this repo's web-test bundler cannot process
 * postcss's Node-specific imports at all.
 */
let postcssStyleEncapsulation: StyleEncapsulationShim | null = null;

/** Registers (or clears) the postcss-based style encapsulation. */
export function setPostcssStyleEncapsulation(shim: StyleEncapsulationShim | null): void {
  postcssStyleEncapsulation = shim;
}

/**
 * Returns the postcss-based style encapsulation, throwing if no
 * implementation has been loaded.
 */
export function getPostcssStyleEncapsulation(): StyleEncapsulationShim {
  if (postcssStyleEncapsulation === null) {
    throw new Error(
      'A stylesheet opted into postcss-based style encapsulation via the ' +
        '"/*! use-postcss-encapsulation */" marker, but no implementation is loaded. ' +
        "Load '@angular/compiler/src/style_encapsulation_shim' before compiling components.",
    );
  }
  return postcssStyleEncapsulation;
}
