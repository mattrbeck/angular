/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {TransformedSourceFile, SourceMapping} from '../../transform';

/**
 * Marker pattern used to embed original source positions in transformed code.
 * Format: /*@ng:startPos,endPos* /
 */
const SOURCE_MARKER_PATTERN = /\/\*@ng:(\d+),(\d+)\*\//g;

/**
 * Maps diagnostics from transformed source files back to their original positions.
 *
 * When source files are transformed (e.g., Angular decorators converted to static fields),
 * TypeScript may report errors at positions in the transformed code. This mapper translates
 * those positions back to the original source for accurate error reporting.
 */
export class DiagnosticMapper {
  /** Cache of parsed source markers for each transformed file */
  private markerCache = new Map<string, ParsedMarker[]>();

  constructor(
    private transformedFiles: Map<string, TransformedSourceFile>,
    private getCanonicalFileName: (fileName: string) => string = (f) => f,
  ) {}

  /**
   * Maps a diagnostic from transformed source positions to original positions.
   *
   * @param diagnostic The diagnostic to map
   * @returns A new diagnostic with mapped positions, or the original if no mapping is needed
   */
  mapDiagnostic(diagnostic: ts.Diagnostic): ts.Diagnostic {
    // Only process diagnostics with file and position information
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return diagnostic;
    }

    const fileName = this.getCanonicalFileName(diagnostic.file.fileName);
    const transformed = this.transformedFiles.get(fileName);

    // If this file wasn't transformed, return as-is
    if (transformed === undefined) {
      return diagnostic;
    }

    // Try to find a source marker that contains this diagnostic position
    const mappedPosition = this.findOriginalPosition(
      transformed,
      diagnostic.start,
      diagnostic.length ?? 0,
    );

    if (mappedPosition === null) {
      // No mapping found - the diagnostic is in generated code without a marker
      // Return the diagnostic pointing to the class declaration as a fallback
      return this.createFallbackDiagnostic(diagnostic, transformed);
    }

    // Create a new diagnostic with the mapped position
    return {
      ...diagnostic,
      file: transformed.originalFile,
      start: mappedPosition.start,
      length: mappedPosition.length,
    };
  }

  /**
   * Maps an array of diagnostics.
   */
  mapDiagnostics(diagnostics: readonly ts.Diagnostic[]): ts.Diagnostic[] {
    return diagnostics.map((d) => this.mapDiagnostic(d));
  }

  /**
   * Finds the original source position for a position in transformed code.
   */
  private findOriginalPosition(
    transformed: TransformedSourceFile,
    transformedStart: number,
    transformedLength: number,
  ): {start: number; length: number} | null {
    // First, check the explicit source mappings from the transformer
    for (const mapping of transformed.sourceMappings) {
      if (
        transformedStart >= mapping.transformedStart &&
        transformedStart + transformedLength <= mapping.transformedEnd
      ) {
        // Calculate the offset within the transformed range
        const offset = transformedStart - mapping.transformedStart;
        const originalStart = mapping.originalStart + offset;
        const originalLength = Math.min(
          transformedLength,
          mapping.originalEnd - originalStart,
        );

        return {start: originalStart, length: originalLength};
      }
    }

    // Parse and search for inline markers in the transformed text
    const markers = this.getMarkersForFile(transformed);

    for (const marker of markers) {
      // Check if the diagnostic position is within or after this marker
      if (transformedStart >= marker.markerEnd) {
        // Use the most recent marker as the reference point
        return {
          start: marker.originalStart,
          length: Math.min(transformedLength, marker.originalEnd - marker.originalStart),
        };
      }
    }

    return null;
  }

  /**
   * Parses and caches source markers from transformed file content.
   */
  private getMarkersForFile(transformed: TransformedSourceFile): ParsedMarker[] {
    const fileName = this.getCanonicalFileName(transformed.originalFile.fileName);

    if (this.markerCache.has(fileName)) {
      return this.markerCache.get(fileName)!;
    }

    const markers: ParsedMarker[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state
    SOURCE_MARKER_PATTERN.lastIndex = 0;

    while ((match = SOURCE_MARKER_PATTERN.exec(transformed.transformedText)) !== null) {
      markers.push({
        markerStart: match.index,
        markerEnd: match.index + match[0].length,
        originalStart: parseInt(match[1], 10),
        originalEnd: parseInt(match[2], 10),
      });
    }

    this.markerCache.set(fileName, markers);
    return markers;
  }

  /**
   * Creates a fallback diagnostic pointing to a reasonable location in the original file.
   */
  private createFallbackDiagnostic(
    diagnostic: ts.Diagnostic,
    transformed: TransformedSourceFile,
  ): ts.Diagnostic {
    // Try to find any class declaration in the original file to point to
    const originalFile = transformed.originalFile;
    let fallbackStart = 0;
    let fallbackLength = 0;

    const findClass = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        fallbackStart = node.name.getStart();
        fallbackLength = node.name.getWidth();
        return;
      }
      ts.forEachChild(node, findClass);
    };

    findClass(originalFile);

    return {
      ...diagnostic,
      file: originalFile,
      start: fallbackStart,
      length: fallbackLength,
      messageText: this.augmentMessageText(diagnostic.messageText, 'in generated code'),
    };
  }

  /**
   * Augments a diagnostic message with additional context.
   */
  private augmentMessageText(
    messageText: string | ts.DiagnosticMessageChain,
    suffix: string,
  ): string | ts.DiagnosticMessageChain {
    if (typeof messageText === 'string') {
      return `${messageText} (${suffix})`;
    }

    return {
      ...messageText,
      messageText: `${messageText.messageText} (${suffix})`,
    };
  }
}

/**
 * Represents a parsed source marker from transformed code.
 */
interface ParsedMarker {
  /** Start position of the marker comment in transformed text */
  markerStart: number;
  /** End position of the marker comment in transformed text */
  markerEnd: number;
  /** Start position in the original source */
  originalStart: number;
  /** End position in the original source */
  originalEnd: number;
}

/**
 * Creates a DiagnosticMapper from a map of transformed files.
 */
export function createDiagnosticMapper(
  transformedFiles: Map<string, TransformedSourceFile>,
  getCanonicalFileName?: (fileName: string) => string,
): DiagnosticMapper {
  return new DiagnosticMapper(transformedFiles, getCanonicalFileName);
}
