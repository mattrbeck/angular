/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// postcss-safe-parser@7 ships no type declarations.
declare module 'postcss-safe-parser' {
  import {Parser, Root} from 'postcss';
  const safeParser: Parser<Root>;
  export default safeParser;
}
