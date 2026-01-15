/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {AbsoluteFsPath} from '../../file_system';
import {TransformedSourceFile} from '../../transform';
import {ExtendedTsCompilerHost} from '../api';

import {DelegatingCompilerHost} from './host';

/**
 * A CompilerHost that wraps a delegate host and serves transformed source files.
 *
 * When `getSourceFile` is called for a file that has been transformed, this host
 * returns a new `ts.SourceFile` parsed from the transformed text instead of the
 * original source.
 *
 * This is used in the pre-transformation compilation flow where Angular decorators
 * are converted to plain TypeScript before TypeScript compilation.
 */
export class TransformedCompilerHost
  extends DelegatingCompilerHost
  implements ts.CompilerHost
{
  /** Cache of transformed source files, keyed by file path */
  private transformedSourceFiles = new Map<string, ts.SourceFile>();

  /** Cache mapping original file names to transformed content */
  private transformedContent = new Map<string, TransformedSourceFile>();

  /** Cache for TCB shim content, keyed by shim file path */
  private tcbShimContent = new Map<string, string>();

  // Override readFile as a property (matching DelegatingCompilerHost pattern)
  override readFile: (fileName: string) => string | undefined;

  constructor(
    delegate: ExtendedTsCompilerHost,
    transformedFiles: Map<AbsoluteFsPath, TransformedSourceFile>,
    tcbShims?: Map<AbsoluteFsPath, string>,
  ) {
    super(delegate);

    // Index transformed files by their original file path
    for (const [path, transformed] of transformedFiles) {
      this.transformedContent.set(path, transformed);
    }

    // Index TCB shim content
    if (tcbShims) {
      for (const [path, content] of tcbShims) {
        this.tcbShimContent.set(path, content);
      }
    }

    // Override readFile to return transformed content
    this.readFile = (fileName: string): string | undefined => {
      const normalizedPath = this.normalizeFilePath(fileName);

      // Check transformed files
      const transformed = this.transformedContent.get(normalizedPath);
      if (transformed !== undefined) {
        return transformed.transformedText;
      }

      // Check TCB shims
      const tcbContent = this.tcbShimContent.get(normalizedPath);
      if (tcbContent !== undefined) {
        return tcbContent;
      }

      // Delegate
      return delegate.readFile(fileName);
    };
  }

  /**
   * Returns a source file for the given file name.
   *
   * If the file has been transformed, returns a new source file parsed from
   * the transformed text. Otherwise, delegates to the underlying host.
   */
  getSourceFile(
    fileName: string,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
    onError?: (message: string) => void,
    shouldCreateNewSourceFile?: boolean,
  ): ts.SourceFile | undefined {
    // Check if this file has been transformed
    const normalizedPath = this.normalizeFilePath(fileName);
    const transformed = this.transformedContent.get(normalizedPath);

    if (transformed !== undefined) {
      // Return cached transformed source file if available
      if (this.transformedSourceFiles.has(normalizedPath)) {
        return this.transformedSourceFiles.get(normalizedPath);
      }

      // Create a new source file from the transformed text
      const languageVersion =
        typeof languageVersionOrOptions === 'number'
          ? languageVersionOrOptions
          : languageVersionOrOptions.languageVersion;

      const transformedSourceFile = ts.createSourceFile(
        fileName,
        transformed.transformedText,
        languageVersion,
        /* setParentNodes */ true,
      );

      // Cache and return
      this.transformedSourceFiles.set(normalizedPath, transformedSourceFile);
      return transformedSourceFile;
    }

    // Check if this is a TCB shim file
    const tcbContent = this.tcbShimContent.get(normalizedPath);
    if (tcbContent !== undefined) {
      // Return cached TCB source file if available
      if (this.transformedSourceFiles.has(normalizedPath)) {
        return this.transformedSourceFiles.get(normalizedPath);
      }

      const languageVersion =
        typeof languageVersionOrOptions === 'number'
          ? languageVersionOrOptions
          : languageVersionOrOptions.languageVersion;

      const tcbSourceFile = ts.createSourceFile(
        fileName,
        tcbContent,
        languageVersion,
        /* setParentNodes */ true,
      );

      this.transformedSourceFiles.set(normalizedPath, tcbSourceFile);
      return tcbSourceFile;
    }

    // Delegate to the underlying host
    return this.delegate.getSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  }

  /**
   * Checks if a file exists.
   *
   * Returns true for files that have been transformed, TCB shim files,
   * or files that exist in the delegate host.
   */
  fileExists(fileName: string): boolean {
    const normalizedPath = this.normalizeFilePath(fileName);

    // Check transformed files
    if (this.transformedContent.has(normalizedPath)) {
      return true;
    }

    // Check TCB shims
    if (this.tcbShimContent.has(normalizedPath)) {
      return true;
    }

    // Delegate to underlying host
    return this.delegate.fileExists(fileName);
  }

  /**
   * Gets the TransformedSourceFile for a given file path, if available.
   * This is useful for retrieving source mappings for diagnostic translation.
   */
  getTransformedSourceFile(fileName: string): TransformedSourceFile | undefined {
    const normalizedPath = this.normalizeFilePath(fileName);
    return this.transformedContent.get(normalizedPath);
  }

  /**
   * Gets all file paths that have been transformed.
   */
  getTransformedFilePaths(): string[] {
    return Array.from(this.transformedContent.keys());
  }

  /**
   * Gets a map of all transformed files for diagnostic mapping.
   */
  getTransformedFilesMap(): Map<string, TransformedSourceFile> {
    return this.transformedContent;
  }

  /**
   * Normalizes a file path for consistent lookup.
   */
  private normalizeFilePath(fileName: string): string {
    // Use the canonical file name for consistent comparison
    if (this.delegate.getCanonicalFileName) {
      return this.delegate.getCanonicalFileName(fileName);
    }
    return fileName;
  }
}
