/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import path from 'node:path';
import fsSync from 'node:fs';

/** Bazel target that produces the wasm engine and its sibling `package.json`. */
export const WASM_BUILD_TARGET = '//packages/compiler-cli/preprocessor/ng-analyze:wasm';

/**
 * Fail-fast check that verifies the Bazel-built wasm binding exists before running tests
 * and pins `NG_EXP_COMPILER_WASM_BINDING` for the test process and any child processes it spawns.
 */
export function ensureWasmBinding(repoRoot) {
  const existing = process.env['NG_EXP_COMPILER_WASM_BINDING'] || process.env['NGP_WASM_BINDING'];
  if (existing && fsSync.existsSync(existing)) {
    process.env['NG_EXP_COMPILER_WASM_BINDING'] = existing;
    return existing;
  }
  const rel = 'packages/compiler-cli/preprocessor/ng-analyze/ng_analyze_wasm/ng_analyze_wasm.js';
  const runfiles = process.env['JS_BINARY__RUNFILES'] || process.env['RUNFILES_DIR'];
  const candidates = [
    ...(runfiles ? [path.join(runfiles, '_main', rel), path.join(runfiles, 'angular', rel)] : []),
    path.join(repoRoot, 'dist/bin', rel),
  ];
  const wasmBinding =
    candidates.find((c) => fsSync.existsSync(c)) ?? candidates[candidates.length - 1];
  if (!fsSync.existsSync(wasmBinding)) {
    throw new Error(
      `Could not find the ng-analyze wasm binding at ${wasmBinding}.\n` +
        `Build it first with: pnpm bazel build ${WASM_BUILD_TARGET}\n` +
        `or point NGP_WASM_BINDING / NG_EXP_COMPILER_WASM_BINDING at a wasm-bindgen build.`,
    );
  }
  process.env['NG_EXP_COMPILER_WASM_BINDING'] = wasmBinding;
  return wasmBinding;
}
