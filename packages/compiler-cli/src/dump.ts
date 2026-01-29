/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import yargs from 'yargs';

import {NgtscProgram} from './ngtsc/program';
import {exitCodeFromResult, formatDiagnostics, readConfiguration} from './perform_compile';
import * as api from './transformers/api';
import * as ng from './transformers/entry_points';

interface CapturedFile {
  fileName: string;
  content: string;
}

export async function mainDump(
  args: string[],
  consoleError: (s: string) => void = console.error,
): Promise<number> {
  const parsedArgs = yargs(args)
    .parserConfiguration({'strip-aliased': true})
    .option('project', {
      alias: 'p',
      type: 'string',
      description: 'Path to the tsconfig.json file',
      default: '.',
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json'] as const,
      default: 'text',
      description: 'Output format (text or json)',
    })
    .option('files', {
      type: 'string',
      choices: ['emit', 'typecheck', 'source', 'all'] as const,
      default: 'emit',
      description:
        'Which files to dump: emit (compiled JS), typecheck (.ngtypecheck.ts shims), source (input .ts), or all',
    })
    .help()
    .parseSync();

  const project = parsedArgs.project;
  const format = parsedArgs.format as 'text' | 'json';
  const filesOption = parsedArgs.files as 'emit' | 'typecheck' | 'source' | 'all';

  // Read the configuration
  const config = readConfiguration(project);
  if (config.errors.length) {
    return reportErrorsAndExit(config.errors, config.options, consoleError);
  }

  const {rootNames, options} = config;

  // Create compiler host and program
  const host = ng.createCompilerHost({options});
  const program = ng.createProgram({rootNames, host, options}) as NgtscProgram;

  // Gather diagnostics (this also triggers type-check shim generation)
  const allDiagnostics: ts.Diagnostic[] = [];

  // Option diagnostics
  allDiagnostics.push(...program.getTsOptionDiagnostics());
  allDiagnostics.push(...program.getNgOptionDiagnostics());

  // Syntactic diagnostics
  allDiagnostics.push(...program.getTsSyntacticDiagnostics());

  // Semantic diagnostics
  allDiagnostics.push(...program.getTsSemanticDiagnostics());
  allDiagnostics.push(...program.getNgStructuralDiagnostics());

  // Angular semantic diagnostics - this triggers type-check shim generation
  allDiagnostics.push(...program.getNgSemanticDiagnostics());

  // Check for errors
  const errors = allDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    return reportErrorsAndExit(allDiagnostics, options, consoleError);
  }

  const capturedFiles: CapturedFile[] = [];

  // Collect source files if requested
  if (filesOption === 'source' || filesOption === 'all') {
    const tsProgram = program.getTsProgram();
    for (const sf of tsProgram.getSourceFiles()) {
      // Skip declaration files and node_modules
      if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) {
        continue;
      }
      capturedFiles.push({
        fileName: sf.fileName,
        content: sf.getFullText(),
      });
    }
  }

  // Collect type-check shim files if requested
  if (filesOption === 'typecheck' || filesOption === 'all') {
    // Get the current program which includes type-check shims after diagnostics
    const currentProgram = program.compiler.getCurrentProgram();
    for (const sf of currentProgram.getSourceFiles()) {
      if (sf.fileName.includes('.ngtypecheck.')) {
        capturedFiles.push({
          fileName: sf.fileName,
          content: sf.getFullText(),
        });
      }
    }
  }

  // Collect emitted files if requested
  if (filesOption === 'emit' || filesOption === 'all') {
    const writeFile: ts.WriteFileCallback = (
      fileName: string,
      content: string,
      _writeByteOrderMark: boolean,
      _onError?: (message: string) => void,
      _sourceFiles?: readonly ts.SourceFile[],
    ) => {
      capturedFiles.push({fileName, content});
    };

    // Emit with custom writeFile callback
    const emitResult = program.emit({
      emitCallback: ({
        program: tsProgram,
        targetSourceFile,
        writeFile: defaultWriteFile,
        cancellationToken,
        emitOnlyDtsFiles,
        customTransformers,
      }) => {
        return tsProgram.emit(
          targetSourceFile,
          writeFile,
          cancellationToken,
          emitOnlyDtsFiles,
          customTransformers,
        );
      },
    });

    // Check for emit errors
    if (emitResult.diagnostics.length) {
      allDiagnostics.push(...emitResult.diagnostics);
      const emitErrors = emitResult.diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      if (emitErrors.length) {
        return reportErrorsAndExit(allDiagnostics, options, consoleError);
      }
    }
  }

  // Output the captured files
  if (format === 'json') {
    const output = capturedFiles.map((f) => ({
      fileName: f.fileName,
      content: f.content,
    }));
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Text format
    for (const file of capturedFiles) {
      console.log(`${'='.repeat(80)}`);
      console.log(`File: ${file.fileName}`);
      console.log(`${'='.repeat(80)}`);
      console.log(file.content);
      console.log();
    }
  }

  return 0;
}

function getFormatDiagnosticsHost(options?: api.CompilerOptions): ts.FormatDiagnosticsHost {
  const basePath = options ? options.basePath : undefined;
  return {
    getCurrentDirectory: () => basePath || ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (fileName) => fileName.replace(/\\/g, '/'),
    getNewLine: () => {
      if (options && options.newLine !== undefined) {
        return options.newLine === ts.NewLineKind.LineFeed ? '\n' : '\r\n';
      }
      return ts.sys.newLine;
    },
  };
}

function reportErrorsAndExit(
  allDiagnostics: ReadonlyArray<ts.Diagnostic>,
  options?: api.CompilerOptions,
  consoleError: (s: string) => void = console.error,
): number {
  const errorsAndWarnings = allDiagnostics.filter(
    (d) => d.category !== ts.DiagnosticCategory.Message,
  );
  if (errorsAndWarnings.length) {
    const formatHost = getFormatDiagnosticsHost(options);
    consoleError(formatDiagnostics(errorsAndWarnings, formatHost));
  }
  return exitCodeFromResult(allDiagnostics);
}
