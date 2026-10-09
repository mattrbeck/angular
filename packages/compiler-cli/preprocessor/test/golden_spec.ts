/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/**
 * Golden tests for the ng-hybrid-preprocessor pipeline
 *
 * Each test case is a directory in test/golden/ containing:
 * - source.md: Input files in markdown format
 * - golden.md: Expected output (local compilation mode)
 * - golden.opt.md: Expected output (optimized compilation mode) - optional
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'path';
import {
  parseMarkdownTestCase,
  runPipeline,
  compareOutputs,
  mergeGolden,
  writeMarkdownTestCase,
} from './utils.js';
import {resolveGoldenRoot, collectGoldenCasesSync, pipelineOptionsFor} from './golden_cases.js';

const testCases = collectGoldenCasesSync();
const isUpdating =
  process.env['UPDATE_GOLDENS'] === 'true' || process.env['VITEST_UPDATE_SNAPSHOT'] === 'true';

describe('Golden Tests', () => {
  if (testCases.length === 0) {
    it('no golden tests found', () => {
      expect(true).toBe(true);
    });
    return;
  }

  const goldenRoot = resolveGoldenRoot();

  for (const testCase of testCases) {
    describe(testCase, () => {
      const testDir = path.join(goldenRoot, testCase);
      const sourcePath = path.join(testDir, 'source.md');
      const goldenPath = path.join(testDir, 'golden.md');
      const goldenOptPath = path.join(testDir, 'golden.opt.md');
      const hasGolden = fsSync.existsSync(goldenPath);
      const hasGoldenOpt = fsSync.existsSync(goldenOptPath);

      // Standard mode test
      if (hasGolden || (isUpdating && !hasGoldenOpt)) {
        it('standard mode', async () => {
          const [source, expected] = await Promise.all([
            parseMarkdownTestCase(sourcePath),
            hasGolden ? parseMarkdownTestCase(goldenPath) : Promise.resolve([]),
          ]);

          const errors: string[] = [];
          const actual = await runPipeline(source, {
            ...pipelineOptionsFor(testCase, 'standard'),
            errors,
          });
          if (expected.length > 0 && !testCase.endsWith('_unexported_declaration')) {
            expect(errors).toEqual([]);
          }

          try {
            compareOutputs(actual, expected);
          } catch (e) {
            if (isUpdating) {
              const merged = await mergeGolden(actual, expected);
              await fs.writeFile(goldenPath, writeMarkdownTestCase(merged));
              // tslint:disable-next-line:no-console
              console.log(`Updated ${goldenPath}`);
            } else {
              throw e;
            }
          }
        });
      }

      // Optimize mode test
      if (hasGoldenOpt) {
        it('optimize mode', async () => {
          const [source, expected] = await Promise.all([
            parseMarkdownTestCase(sourcePath),
            parseMarkdownTestCase(goldenOptPath),
          ]);

          const errors: string[] = [];
          const actual = await runPipeline(source, {
            ...pipelineOptionsFor(testCase, 'optimize'),
            errors,
          });
          if (expected.length > 0 && !testCase.endsWith('_unexported_declaration')) {
            expect(errors).toEqual([]);
          }

          try {
            compareOutputs(actual, expected);
          } catch (e) {
            if (isUpdating) {
              const merged = await mergeGolden(actual, expected);
              await fs.writeFile(goldenOptPath, writeMarkdownTestCase(merged));
              // tslint:disable-next-line:no-console
              console.log(`Updated ${goldenOptPath}`);
            } else {
              throw e;
            }
          }
        });
      }
    });
  }
});
