/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import {NgtscCompilerHost, NodeJSFileSystem, setFileSystem} from '@angular/compiler-cli';
import {NgtscIsolatedPreprocessor} from '@angular/compiler-cli/src/ngtsc/preprocessor';
import {
  getOrCreateSyntheticNodeModules,
  resolvePackagePath,
  runPipeline,
  type TestFile,
} from './utils.js';

interface ComplianceCaseConfig {
  description: string;
  inputFiles?: string[];
  compilerOptions?: Record<string, any>;
  angularCompilerOptions?: Record<string, any>;
  compilationModeFilter?: string[];
}

function resolveComplianceTestCasesRoot(): string {
  if (process.env['BUILD_WORKSPACE_DIRECTORY']) {
    const candidate = path.join(
      process.env['BUILD_WORKSPACE_DIRECTORY'],
      'packages/compiler-cli/test/compliance/test_cases',
    );
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  const runfilesDir = process.env['JS_BINARY__RUNFILES'] || process.env['RUNFILES_DIR'];
  if (runfilesDir) {
    const candidates = [
      path.join(runfilesDir, '_main/packages/compiler-cli/test/compliance/test_cases'),
      path.join(runfilesDir, 'angular/packages/compiler-cli/test/compliance/test_cases'),
      path.join(runfilesDir, 'packages/compiler-cli/test/compliance/test_cases'),
    ];
    for (const c of candidates) {
      if (fsSync.existsSync(c)) {
        return c;
      }
    }
  }

  const relativeCandidates = [
    path.resolve(process.cwd(), 'packages/compiler-cli/test/compliance/test_cases'),
    path.resolve(import.meta.dirname, '../../test/compliance/test_cases'),
  ];
  for (const c of relativeCandidates) {
    if (fsSync.existsSync(c)) {
      return c;
    }
  }

  throw new Error('Could not find packages/compiler-cli/test/compliance/test_cases in runfiles');
}

/**
 * Reads a compliance source/template file, applying the same `\r\n` unescaping as ngtsc's
 * `monkeyPatchReadFile` in `packages/compiler-cli/test/compliance/test_helpers/compile_test.ts`
 * so `line_ending_normalization` fixtures contain real `\r\n` CRLF bytes.
 */
function readComplianceFileWithCrlf(absPath: string): string {
  const raw = fsSync.readFileSync(absPath, 'utf-8');
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n\n/g, '\r\n')
    .replace(/\\\\r\\\\n(\r?\n)/g, '\\r\\n$1');
}

function loadComplianceCaseFiles(relativeDir: string, caseDescription?: string): TestFile[] {
  const root = resolveComplianceTestCasesRoot();
  const caseDir = path.join(root, relativeDir);
  const testCasesJsonPath = path.join(caseDir, 'TEST_CASES.json');
  const parsed = JSON.parse(fsSync.readFileSync(testCasesJsonPath, 'utf-8')) as {
    cases: ComplianceCaseConfig | ComplianceCaseConfig[];
  };
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [parsed.cases];
  const matched = caseDescription ? cases.find((c) => c.description === caseDescription) : cases[0];
  if (!matched) {
    throw new Error(
      `Could not find compliance case "${caseDescription}" in ${relativeDir}/TEST_CASES.json`,
    );
  }

  const inputFiles = matched.inputFiles ?? ['test.ts'];
  const files: TestFile[] = [
    {
      path: '/tsconfig.json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'es2022',
          module: 'esnext',
          experimentalDecorators: true,
          emitDecoratorMetadata: false,
          moduleResolution: 'bundler',
          ...matched.compilerOptions,
        },
        files: inputFiles,
        angularCompilerOptions: {
          ...matched.angularCompilerOptions,
        },
      }),
    },
  ];

  // Include all inputFiles plus any sibling .html/.css resource files in the directory
  const included = new Set<string>();
  for (const rel of inputFiles) {
    const abs = path.join(caseDir, rel);
    files.push({
      path: '/' + rel.replace(/\\/g, '/'),
      content: readComplianceFileWithCrlf(abs),
    });
    included.add(rel);
  }

  for (const entry of fsSync.readdirSync(caseDir, {withFileTypes: true})) {
    if (!entry.isFile()) continue;
    if (
      (entry.name.endsWith('.html') || entry.name.endsWith('.css')) &&
      !included.has(entry.name)
    ) {
      files.push({
        path: '/' + entry.name,
        content: readComplianceFileWithCrlf(path.join(caseDir, entry.name)),
      });
    }
  }

  return files;
}

function collectTestCaseJsonPaths(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fsSync.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestCaseJsonPaths(full));
    } else if (entry.name === 'TEST_CASES.json') {
      results.push(full);
    }
  }
  return results;
}

describe('Live ngtsc Compliance & Differential Parity Suite', () => {
  it('discovers live TEST_CASES.json files from packages/compiler-cli/test/compliance/test_cases', () => {
    const root = resolveComplianceTestCasesRoot();
    const configs = collectTestCaseJsonPaths(root);
    expect(configs.length).toBeGreaterThan(20);
  });

  describe('upstream compliance cases (optimize: true and optimize: false)', () => {
    for (const optimize of [true, false]) {
      const modeName = optimize ? 'optimize: true' : 'optimize: false';

      describe(modeName, () => {
        it('compiles r3_view_compiler/operators.ts including postfix and prefix ++/--', async () => {
          const files = loadComplianceCaseFiles(
            'r3_view_compiler',
            'should handle binary and unary operators',
          );
          const outputs = await runPipeline(files, {
            optimize,
            complianceMode: true,
            format: false,
          });
          const emitted = outputs.find((f) => f.path === '/out/operators.ts')?.content;
          expect(emitted).toBeDefined();

          // Verify binary, unary, assignment, and update (++ / --) operators
          expect(emitted).toContain('ctx.number += 1');
          expect(emitted).toContain('ctx.number -= 1');
          expect(emitted).toContain('ctx.number *= 1');
          expect(emitted).toContain('ctx.number /= 1');
          expect(emitted).toContain('ctx.number %= 1');
          expect(emitted).toContain('ctx.number **= 1');
          expect(emitted).toContain('ctx.number &&= 1');
          expect(emitted).toContain('ctx.number ||= 1');
          expect(emitted).toContain('ctx.number ??= 1');
          expect(emitted).toContain('ctx.number++');
          expect(emitted).toContain('ctx.number--');
          expect(emitted).toContain('++ctx.number');
          expect(emitted).toContain('--ctx.number');
          expect(emitted).toMatch(/['"]bar['"] in ctx\.foo/);
          expect(emitted).toContain('ctx.bar instanceof ctx.Bar');
        });

        it('compiles r3_view_compiler_deferred viewport triggers with scrollMargin option', async () => {
          for (const [desc, fileName, instruction] of [
            [
              'should generate a defer block with a `on viewport` trigger that has options',
              'deferred_on_viewport_with_options.ts',
              'ɵɵdeferOnViewport',
            ],
            [
              'should generate a defer block with a `prefetch on viewport` trigger that has options',
              'deferred_prefetch_on_viewport_with_options.ts',
              'ɵɵdeferPrefetchOnViewport',
            ],
            [
              'should generate a defer block with a `hydrate on viewport` trigger that has options',
              'deferred_hydrate_on_viewport_with_options.ts',
              'ɵɵdeferHydrateOnViewport',
            ],
          ] as const) {
            const files = loadComplianceCaseFiles('r3_view_compiler_deferred', desc);
            const outputs = await runPipeline(files, {
              optimize,
              complianceMode: true,
              format: false,
            });
            const emitted = outputs.find((f) => f.path === `/out/${fileName}`)?.content;
            expect(emitted).toBeDefined();
            expect(emitted).toContain(instruction);
            expect(emitted).toMatch(/rootMargin:\s*['"]123px['"]/);
            expect(emitted).toMatch(/scrollMargin:\s*['"]456px['"]/);
            expect(emitted).toContain('threshold: 59');
          }
        });

        it('compiles r3_view_compiler_control_flow/if_namespaced_root_node.ts with SVG and MathML namespaces', async () => {
          const files = loadComplianceCaseFiles(
            'r3_view_compiler_control_flow',
            'should generate an if block with namespaced element root nodes',
          );
          const outputs = await runPipeline(files, {
            optimize,
            complianceMode: true,
            format: false,
          });
          const emitted = outputs.find(
            (f) => f.path === '/out/if_namespaced_root_node.ts',
          )?.content;
          expect(emitted).toBeDefined();
          expect(emitted).toContain('ɵɵnamespaceSVG()');
          expect(emitted).toContain('ɵɵnamespaceMathML()');
          expect(emitted).toMatch(
            /ɵɵconditionalCreate\(0,\s*MyApp_Conditional_0_Template,\s*1,\s*0,\s*['"]svg['"],\s*0\)\(1,\s*MyApp_Conditional_1_Template,\s*1,\s*0,\s*['"]math['"],\s*1\)/,
          );
        });

        it('compiles r3_view_compiler_deferred/defer_extends_clause.ts preserving BaseCmp import', async () => {
          const files = loadComplianceCaseFiles(
            'r3_view_compiler_deferred',
            'should not drop static import when a sibling symbol is referenced in a class extends clause',
          );
          const outputs = await runPipeline(files, {
            optimize,
            complianceMode: true,
            format: false,
          });
          const emitted = outputs.find((f) => f.path === '/out/defer_extends_clause.ts')?.content;
          expect(emitted).toBeDefined();
          expect(emitted).toContain('BaseCmp');
          expect(emitted).toContain('./defer_extends_clause_deps');
          expect(emitted).toContain('export class MyApp extends BaseCmp');
        });

        it('compiles r3_view_compiler_i18n/many_i18n_elements.ts and many_i18n_attributes.ts with extracted i18n helper functions', async () => {
          for (const [desc, fileName] of [
            ['should handle a component with many i18n elements', 'many_i18n_elements.ts'],
            ['should handle a component with many i18n attributes', 'many_i18n_attributes.ts'],
          ] as const) {
            const files = loadComplianceCaseFiles('r3_view_compiler_i18n', desc);
            const outputs = await runPipeline(files, {
              optimize,
              complianceMode: true,
              format: false,
            });
            const emitted = outputs.find((f) => f.path === `/out/${fileName}`)?.content;
            expect(emitted).toBeDefined();
            expect(emitted).toContain('function i18n_299');
            expect(emitted).toContain('function i18n_300');
            expect(emitted).toContain('function i18n_999');
            expect(emitted).toContain('i18n_299()');
            expect(emitted).toContain('i18n_999()');
          }
        });

        it('compiles inline_object_literal_access.ts with pureFunction0 indexed by signal call', async () => {
          const files = loadComplianceCaseFiles(
            'r3_compiler_compliance/components_and_directives/value_composition',
            'should support inline access of an object literal',
          );
          const outputs = await runPipeline(files, {
            optimize,
            complianceMode: true,
            format: false,
          });
          const emitted = outputs.find(
            (f) => f.path === '/out/inline_object_literal_access.ts',
          )?.content;
          expect(emitted).toBeDefined();
          expect(emitted).toMatch(/one:\s*['"]Hello['"],\s*two:\s*['"]Hola['"]/);
          expect(emitted).toMatch(/ɵɵpureFunction0\(1,\s*_c0\)\[ctx\.type\(\)\]/);
        });

        it('compiles r3_view_compiler_i18n/line_ending_normalization preserving real CRLF line endings', async () => {
          const normalizedExternal = loadComplianceCaseFiles(
            'r3_view_compiler_i18n/line_ending_normalization',
            'should compute normalized legacy ids for messages in external templates where i18nNormalizeLineEndingsInICUs is true',
          );
          const nonNormalizedExternal = loadComplianceCaseFiles(
            'r3_view_compiler_i18n/line_ending_normalization',
            'should compute non-normalized legacy ids for messages in external templates where i18nNormalizeLineEndingsInICUs is false',
          );

          // Confirm the loaded template.html actually contains real \r\n bytes
          const templateFile = nonNormalizedExternal.find((f) => f.path === '/template.html');
          expect(templateFile?.content).toContain('\r\n');

          const normOutputs = await runPipeline(normalizedExternal, {
            optimize,
            complianceMode: true,
            format: false,
          });
          const nonNormOutputs = await runPipeline(nonNormalizedExternal, {
            optimize,
            complianceMode: true,
            format: false,
          });

          const normEmitted = normOutputs.find(
            (f) => f.path === '/out/external_template_legacy_normalized.ts',
          )?.content;
          const nonNormEmitted = nonNormOutputs.find(
            (f) => f.path === '/out/external_template_legacy_non_normalized.ts',
          )?.content;

          expect(normEmitted).toBeDefined();
          expect(nonNormEmitted).toBeDefined();

          // Normalized external template uses LF-normalized legacy SHA1 IDs
          expect(normEmitted).toContain('47e6af99f2e9137a977cf8c7bf39d091d339ae3a');
          expect(normEmitted).toContain('23ea0658f9e9f6c61c9e2798fff0f4b11c509fae');

          // Non-normalized external template preserves \r\n in ICU legacy SHA1 IDs
          expect(nonNormEmitted).toContain('ed275132ef4cf80cbcf817e66b74c384e68340b1');
          expect(nonNormEmitted).toContain('55d63b098ee4cce61944f086cdd9b60c6bcef20b');
        });
      });
    }
  });

  describe('differential comparison against NgtscIsolatedPreprocessor and tsc type-checking', () => {
    const REPRESENTATIVE_SOURCE = `
import {Component, Directive, EventEmitter, Input, Output, Pipe, PipeTransform, input, output} from '@angular/core';

@Directive({
  selector: '[highlightDir]',
  exportAs: 'hl',
})
export class HighlightDir {
  @Input() highlightDir = 'yellow';
  @Output() highlighted = new EventEmitter<string>();
}

@Pipe({
  name: 'exclaim',
})
export class ExclaimPipe implements PipeTransform {
  transform(value: string, suffix = '!'): string {
    return value + suffix;
  }
}

@Component({
  selector: 'app-card',
  imports: [HighlightDir, ExclaimPipe],
  template: \`
    @let greeting = (title() | exclaim:'!!');
    @if (show()) {
      <div [highlightDir]="color" #hlRef="hl" (highlighted)="onHighlight($event)">
        <span>{{ greeting }}</span>
        @for (item of items; track item.id) {
          <button (click)="count++">{{ item.label }} ({{ count }})</button>
        }
      </div>
    }
  \`,
})
export class CardComponent {
  readonly title = input.required<string>();
  readonly show = input(true);
  readonly selected = output<string>();
  color = 'blue';
  count = 0;
  items: Array<{id: number; label: string}> = [{id: 1, label: 'One'}];

  onHighlight(val: string): void {
    this.selected.emit(val);
  }
}
`;

    it('matches NgtscIsolatedPreprocessor definitions and produces valid TypeScript for .ts and .ngtypecheck.ts', async () => {
      const tmpRoot = process.env['TEST_TMPDIR'] || os.tmpdir();
      const dir = await fs.mkdtemp(path.join(tmpRoot, 'ngp-diff-parity-'));

      try {
        const compFile = path.join(dir, 'card.ts');
        const tsconfigFile = path.join(dir, 'tsconfig.json');
        const tsconfigContent = JSON.stringify({
          compilerOptions: {
            target: 'es2022',
            module: 'esnext',
            moduleResolution: 'bundler',
            experimentalDecorators: true,
            strict: true,
          },
          files: ['card.ts'],
          angularCompilerOptions: {
            strictTemplates: true,
          },
        });

        await fs.writeFile(compFile, REPRESENTATIVE_SOURCE);
        await fs.writeFile(tsconfigFile, tsconfigContent);

        // Link @angular/core and @angular/common into dir/node_modules/@angular
        const syntheticNm = getOrCreateSyntheticNodeModules();
        if (syntheticNm) {
          await fs.symlink(syntheticNm, path.join(dir, 'node_modules'), 'dir');
        }

        // 1. Run HybridCompiler via runPipeline
        const ngpOutputs = await runPipeline(
          [
            {path: '/tsconfig.json', content: tsconfigContent},
            {path: '/card.ts', content: REPRESENTATIVE_SOURCE},
          ],
          {optimize: true, complianceMode: true, format: false},
        );

        const ngpTs = ngpOutputs.find((f) => f.path === '/out/card.ts')?.content;
        const ngpTcb = ngpOutputs.find((f) => f.path === '/out/card.ngtypecheck.ts')?.content;
        expect(ngpTs).toBeDefined();
        expect(ngpTcb).toBeDefined();

        // 2. Run NgtscIsolatedPreprocessor on the same source file
        setFileSystem(new NodeJSFileSystem());
        const ngFs = new NodeJSFileSystem();
        const corePkgPath =
          resolvePackagePath('core') ?? path.resolve(process.cwd(), 'packages/core');
        const ngOptions = {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          experimentalDecorators: true,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          rootDir: dir,
          baseUrl: dir,
          paths: {
            '@angular/core': [corePkgPath, path.join(corePkgPath, 'index.d.ts')],
          },
          strictTemplates: true,
          _enableTemplateTypeChecker: true,
        };
        const ngHost = new NgtscCompilerHost(ngFs, ngOptions);
        const ngPreprocessor = new NgtscIsolatedPreprocessor([compFile], ngOptions, ngHost);
        const ngTransformed = ngPreprocessor.transformAndPrint();

        const ngtscTs = ngTransformed.find((f) => f.fileName.endsWith('/card.ts'))?.content;
        const ngtscTcb = ngTransformed.find((f) =>
          f.fileName.endsWith('/card.ngtypecheck.ts'),
        )?.content;
        expect(ngtscTs).toBeDefined();
        expect(ngtscTcb).toBeDefined();

        // Both compilers must emit the same Ivy declarations and instructions
        for (const token of [
          'ɵɵdefineDirective',
          'ɵɵdefinePipe',
          'ɵɵdefineComponent',
          'HighlightDir',
          'ExclaimPipe',
          'CardComponent',
          'ɵɵconditionalCreate',
          'ɵɵrepeaterCreate',
          'ɵɵpipeBind2',
          'ctx_r1.count++',
        ]) {
          expect(ngpTs).toContain(token);
          expect(ngtscTs).toContain(token);
        }

        // Both TCBs must typecheck the template bindings, pipe, directive exportAs, and @for loop
        for (const token of ['HighlightDir', 'ExclaimPipe', 'CardComponent', 'onHighlight']) {
          expect(ngpTcb).toContain(token);
          expect(ngtscTcb).toContain(token);
        }

        // 3. Type-check HybridCompiler's emitted card.ts + card.ngtypecheck.ts with ts.createProgram
        const outDir = path.join(dir, 'out');
        await fs.mkdir(outDir, {recursive: true});
        const emittedTsPath = path.join(outDir, 'card.ts');
        const emittedTcbPath = path.join(outDir, 'card.ngtypecheck.ts');
        await fs.writeFile(emittedTsPath, ngpTs!);
        await fs.writeFile(emittedTcbPath, ngpTcb!);

        const program = ts.createProgram([emittedTsPath, emittedTcbPath], {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          experimentalDecorators: true,
          strict: true,
          noImplicitAny: false,
          skipLibCheck: true,
          noEmit: true,
          ignoreDeprecations: '6.0',
          paths: {
            '@angular/core': [corePkgPath, path.join(corePkgPath, 'index.d.ts')],
          },
        });

        const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
          const where =
            d.file && d.start !== undefined
              ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: `
              : '';
          return `${where}TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
        });

        expect(diagnostics).toEqual([]);
      } finally {
        await fs.rm(dir, {recursive: true, force: true});
      }
    });
  });
});
