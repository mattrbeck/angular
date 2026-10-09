/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type {NgCompilerOptions} from '@angular/compiler-cli';

/**
 * Mirrors `DiagnosticCategoryLabel` in `ngtsc/core/api/src/public_options.ts`. The string
 * values are what appears in a tsconfig, so they are interchangeable with the upstream enum.
 */
export type DiagnosticCategoryLabel =
  | `${NonNullable<NonNullable<NgCompilerOptions['extendedDiagnostics']>['defaultCategory']>}`
  | NonNullable<NonNullable<NgCompilerOptions['extendedDiagnostics']>['defaultCategory']>;

/**
 * Mirrors `DiagnosticOptions['extendedDiagnostics']`. Upstream keys `checks` by
 * `ExtendedTemplateDiagnosticName`; only the checks the preprocessor reads are named here.
 */
export interface ExtendedDiagnosticsOptions {
  defaultCategory?: DiagnosticCategoryLabel;
  checks?: {
    controlFlowPreventingContentProjection?: DiagnosticCategoryLabel;
    unusedStandaloneImports?: DiagnosticCategoryLabel;
    readonly [name: string]: DiagnosticCategoryLabel | undefined;
  };
}

/**
 * Strips the `[prop: string]: any` index signature from `NgCompilerOptions` so that
 * `noPropertyAccessFromIndexSignature` does not flag property accesses with TS4111.
 */
type KnownNgCompilerOptions = {
  [
    K in keyof NgCompilerOptions as string extends K
      ? never
      : number extends K
        ? never
        : symbol extends K
          ? never
          : K
  ]: NgCompilerOptions[K];
};

/**
 * The compiler options the preprocessor consumes: the Angular-specific options from a
 * tsconfig's merged `angularCompilerOptions` (as read by `@angular/compiler-cli`'s
 * `readConfiguration`), plus the few TypeScript `compilerOptions` that ngtsc also
 * reads from the same merged object.
 */
export interface NgpCompilerOptions extends Omit<KnownNgCompilerOptions, 'extendedDiagnostics'> {
  // Diagnostics (`DiagnosticOptions`).
  extendedDiagnostics?: ExtendedDiagnosticsOptions;

  // `@internal` options stripped from `@angular/compiler-cli` public `.d.ts` files
  // and preprocessor-specific options.
  supportJitMode?: boolean;
  supportTestBed?: boolean;
  externalRuntimeStyles?: boolean;
  _enableHmr?: boolean;
  _enableSelectorless?: boolean;
  workspaceName?: string;
}
