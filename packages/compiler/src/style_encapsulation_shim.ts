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
import {setPostcssStyleEncapsulation} from './style_encapsulation_registry';

export {usesPostcssEncapsulation} from './style_encapsulation_registry';

/**
 * Shims the given css with the postcss-based style encapsulation, mirroring
 * the `ShadowCss.shimCssText()` API.
 *
 * Loading this module registers the implementation with the compiler's style
 * encapsulation registry; the compiler itself does not import postcss (see
 * `style_encapsulation_registry.ts`).
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

setPostcssStyleEncapsulation(shimStyleEncapsulation);
