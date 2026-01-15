/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ConstantPool} from '@angular/compiler';
import ts from 'typescript';

import {ImportRewriter} from '../../imports';
import {AbsoluteFsPath} from '../../file_system';
import {Decorator, ReflectionHost} from '../../reflection';
import {
  ImportManager,
  presetImportManagerForceNamespaceImports,
  translateExpression,
  translateStatement,
} from '../../translator';

import {CompileResult} from './api';
import {TraitCompiler} from './compilation';

/**
 * Represents a mapping from a position in transformed source code
 * back to the original source position.
 */
export interface SourceMapping {
  /** Start position in the transformed source */
  transformedStart: number;
  /** End position in the transformed source */
  transformedEnd: number;
  /** Start position in the original source */
  originalStart: number;
  /** End position in the original source */
  originalEnd: number;
  /** The original source file */
  originalFile: ts.SourceFile;
}

/**
 * Result of transforming a source file.
 */
export interface TransformedSourceFile {
  /** The original source file */
  originalFile: ts.SourceFile;
  /** The transformed TypeScript text */
  transformedText: string;
  /** Mappings from transformed positions back to original positions */
  sourceMappings: SourceMapping[];
  /** Set of deferrable imports that were encountered */
  deferrableImports: Set<ts.ImportDeclaration>;
}

/**
 * Inline TCB content to be inserted into the source file during transformation.
 */
export interface InlineTcbInsert {
  /**
   * Position in the original source file where the TCB should be inserted.
   * This is typically right after a class declaration (classNode.end + 1).
   */
  originalPosition: number;

  /**
   * The TCB text to insert.
   */
  text: string;
}

/**
 * Configuration for the SourceFileTransformer.
 */
export interface SourceFileTransformerConfig {
  importRewriter: ImportRewriter;
  isCore: boolean;
  isClosureCompilerEnabled: boolean;
}

/**
 * Transforms Angular source files by converting decorator-based class definitions
 * into their compiled form with static fields.
 *
 * This is used for the pre-transformation approach where Angular classes are
 * transformed into plain TypeScript before TypeScript compilation, rather than
 * using emit-time transformers.
 */
export class SourceFileTransformer {
  private printer = ts.createPrinter({newLine: ts.NewLineKind.LineFeed});

  constructor(
    private reflector: ReflectionHost,
    private config: SourceFileTransformerConfig,
  ) {}

  /**
   * Transforms a source file by compiling all Angular decorated classes
   * and generating new source text.
   *
   * @param sourceFile The source file to transform
   * @param compilation The TraitCompiler containing analyzed traits
   * @param inlineTcbs Optional inline TCBs to insert into the transformed source
   * @returns The transformed source file, or null if no transformation was needed
   */
  transform(
    sourceFile: ts.SourceFile,
    compilation: TraitCompiler,
    inlineTcbs?: InlineTcbInsert[],
  ): TransformedSourceFile | null {
    // Skip declaration files
    if (sourceFile.isDeclarationFile) {
      return null;
    }

    const constantPool = new ConstantPool(this.config.isClosureCompilerEnabled);
    const importManager = new ImportManager({
      ...presetImportManagerForceNamespaceImports,
      rewriter: this.config.importRewriter,
    });

    // Collect all class transformations needed
    const classTransformations = new Map<ts.ClassDeclaration, ClassTransformation>();
    const allDeferrableImports = new Set<ts.ImportDeclaration>();

    // Visit all classes and collect compilation results
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node)) {
        const result = compilation.compile(node, constantPool);
        if (result !== null && result.length > 0) {
          const transformation = this.prepareClassTransformation(
            sourceFile,
            node,
            result,
            compilation,
            importManager,
          );
          classTransformations.set(node, transformation);

          // Collect deferrable imports
          for (const compileResult of result) {
            if (compileResult.deferrableImports !== null) {
              compileResult.deferrableImports.forEach((imp) => allDeferrableImports.add(imp));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // If no transformations needed and no inline TCBs, return null
    if (classTransformations.size === 0 && (!inlineTcbs || inlineTcbs.length === 0)) {
      return null;
    }

    // Generate the transformed source text
    const {transformedText, sourceMappings} = this.generateTransformedText(
      sourceFile,
      classTransformations,
      constantPool,
      importManager,
      allDeferrableImports,
      inlineTcbs,
    );

    return {
      originalFile: sourceFile,
      transformedText,
      sourceMappings,
      deferrableImports: allDeferrableImports,
    };
  }

  /**
   * Prepares the transformation data for a single class.
   */
  private prepareClassTransformation(
    sourceFile: ts.SourceFile,
    node: ts.ClassDeclaration,
    compileResults: CompileResult[],
    compilation: TraitCompiler,
    importManager: ImportManager,
  ): ClassTransformation {
    const members: GeneratedMember[] = [];
    const statements: ts.Statement[] = [];

    for (const field of compileResults) {
      // Type-only member - skip
      if (field.initializer === null) {
        continue;
      }

      // Translate the initializer expression to TypeScript AST
      let exprNode = translateExpression(sourceFile, field.initializer, importManager, {
        annotateForClosureCompiler: this.config.isClosureCompilerEnabled,
      });

      // In pre-transformation mode, generated Angular fields need type assertions
      // because the generated code may not match the expected type signatures.
      // For example:
      // - Factory functions have __ngFactoryType__ parameter but type expects () => T
      // - Component definitions have template functions with untyped rf/ctx parameters
      // Adding 'as any' prevents TypeScript type errors for these generated patterns.
      const angularStaticFields = new Set([
        'ɵcmp', 'ɵdir', 'ɵmod', 'ɵpipe', 'ɵprov', 'ɵfac', 'ɵinj',
      ]);
      if (angularStaticFields.has(field.name)) {
        exprNode = ts.factory.createAsExpression(exprNode, ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword));
      }

      // Create a static property declaration
      // Type annotations are added later by the declaration transform for .d.ts files
      const property = ts.factory.createPropertyDeclaration(
        [ts.factory.createToken(ts.SyntaxKind.StaticKeyword)],
        field.name,
        undefined,
        undefined,
        exprNode,
      );

      members.push({
        name: field.name,
        property,
      });

      // Translate any additional statements
      for (const stmt of field.statements) {
        const tsStmt = translateStatement(sourceFile, stmt, importManager, {
          annotateForClosureCompiler: this.config.isClosureCompilerEnabled,
        });
        statements.push(tsStmt);
      }
    }

    // Get decorators to remove
    const decoratorsToRemove = compilation.decoratorsFor(node);

    return {
      node,
      members,
      statements,
      decoratorsToRemove,
    };
  }

  /**
   * Generates the transformed source text for the entire file.
   *
   * This method collects all text modifications first, then applies them
   * in a single pass from end to start to avoid position shifting issues.
   */
  private generateTransformedText(
    sourceFile: ts.SourceFile,
    classTransformations: Map<ts.ClassDeclaration, ClassTransformation>,
    constantPool: ConstantPool,
    importManager: ImportManager,
    deferrableImports: Set<ts.ImportDeclaration>,
    inlineTcbs?: InlineTcbInsert[],
  ): {transformedText: string; sourceMappings: SourceMapping[]} {
    const sourceMappings: SourceMapping[] = [];
    let result = sourceFile.getFullText();

    // Collect all modifications as {start, end, newText} operations
    // We'll apply them in reverse order (by start position) to avoid position shifts
    interface TextModification {
      start: number;
      end: number;
      newText: string;
    }
    const modifications: TextModification[] = [];

    // Collect class member additions and decorator removals
    for (const [classNode, transformation] of classTransformations) {
      const {members, statements, decoratorsToRemove} = transformation;

      // Add new static members before the closing brace
      if (members.length > 0) {
        const membersText = members
          .map((m) => {
            const markerStart = `/*@ng:${classNode.getStart()},${classNode.getEnd()}*/`;
            const memberText = this.printer.printNode(ts.EmitHint.Unspecified, m.property, sourceFile);
            if (this.config.isClosureCompilerEnabled) {
              return `  /** @nocollapse */ ${markerStart}${memberText}`;
            }
            return `  ${markerStart}${memberText}`;
          })
          .join('\n');

        const closingBracePos = classNode.getEnd() - 1;
        modifications.push({
          start: closingBracePos,
          end: closingBracePos,
          newText: '\n' + membersText + '\n',
        });
      }

      // Add statements after the class
      if (statements.length > 0) {
        const statementsText = statements
          .map((stmt) => this.printer.printNode(ts.EmitHint.Unspecified, stmt, sourceFile))
          .join('\n');

        modifications.push({
          start: classNode.getEnd(),
          end: classNode.getEnd(),
          newText: '\n' + statementsText,
        });
      }

      // Remove Angular decorators from the class
      for (const decorator of decoratorsToRemove) {
        const start = decorator.getFullStart();
        const end = decorator.getEnd();
        // Also remove trailing whitespace/newline after the decorator
        const afterEnd = result.slice(end).match(/^[\s]*/)?.[0]?.length ?? 0;
        modifications.push({
          start,
          end: end + afterEnd,
          newText: '',
        });
      }

      // Remove Angular decorators from class members
      for (const member of classNode.members) {
        const decorators = this.reflector.getDecoratorsOfDeclaration(member);
        if (decorators === null) continue;
        for (const decorator of decorators) {
          if (this.isAngularCoreDecorator(decorator)) {
            const node = decorator.node as ts.Decorator;
            const start = node.getFullStart();
            const end = node.getEnd();
            const afterEnd = result.slice(end).match(/^[\s]*/)?.[0]?.length ?? 0;
            modifications.push({
              start,
              end: end + afterEnd,
              newText: '',
            });
          }
        }
      }

      // Check constructor parameters for decorators
      const ctor = classNode.members.find(ts.isConstructorDeclaration);
      if (ctor) {
        for (const param of ctor.parameters) {
          const decorators = this.reflector.getDecoratorsOfDeclaration(param);
          if (decorators === null) continue;
          for (const decorator of decorators) {
            if (this.isAngularCoreDecorator(decorator)) {
              const node = decorator.node as ts.Decorator;
              const start = node.getFullStart();
              const end = node.getEnd();
              const afterEnd = result.slice(end).match(/^[\s]*/)?.[0]?.length ?? 0;
              modifications.push({
                start,
                end: end + afterEnd,
                newText: '',
              });
            }
          }
        }
      }
    }

    // Collect deferrable import removals
    for (const importDecl of deferrableImports) {
      modifications.push({
        start: importDecl.getFullStart(),
        end: importDecl.getEnd(),
        newText: '',
      });
    }

    // Collect inline TCB insertions
    // Inline TCBs are inserted at their original position (typically classNode.end + 1)
    if (inlineTcbs && inlineTcbs.length > 0) {
      for (const tcb of inlineTcbs) {
        modifications.push({
          start: tcb.originalPosition,
          end: tcb.originalPosition,
          newText: '\n' + tcb.text,
        });
      }
    }

    // Finalize imports and generate import declarations
    const {newImports, updatedImports, deletedImports} = importManager.finalize();

    // Collect deleted import removals
    for (const importDecl of deletedImports) {
      modifications.push({
        start: importDecl.getFullStart(),
        end: importDecl.getEnd(),
        newText: '',
      });
    }

    // Collect updated imports
    for (const [oldBindings, newBindings] of updatedImports) {
      const newText = this.printer.printNode(ts.EmitHint.Unspecified, newBindings, sourceFile);
      modifications.push({
        start: oldBindings.getStart(),
        end: oldBindings.getEnd(),
        newText,
      });
    }

    // Generate constant pool statements and new imports
    const constantStatements = constantPool.statements.map((stmt) =>
      translateStatement(sourceFile, stmt, importManager, {
        annotateForClosureCompiler: this.config.isClosureCompilerEnabled,
      }),
    );
    const newImportDecls = newImports.get(sourceFile.fileName) ?? [];

    if (newImportDecls.length > 0 || constantStatements.length > 0) {
      const insertPosition = this.findImportInsertPosition(sourceFile);
      const newImportText = newImportDecls
        .map((decl) => this.printer.printNode(ts.EmitHint.Unspecified, decl, sourceFile))
        .join('\n');
      const constantText = constantStatements
        .map((stmt) => this.printer.printNode(ts.EmitHint.Unspecified, stmt, sourceFile))
        .join('\n');

      // Add leading newline since we insert right after the last import statement
      const insertText =
        '\n' +
        (newImportText ? newImportText + '\n' : '') +
        (constantText ? constantText + '\n' : '');

      modifications.push({
        start: insertPosition,
        end: insertPosition,
        newText: insertText,
      });
    }

    // Sort modifications by start position (descending) and apply from end to start
    // This ensures position shifts don't affect other modifications
    modifications.sort((a, b) => b.start - a.start);

    // Merge overlapping or adjacent modifications
    // (Some modifications might overlap, e.g., removing a decorator that's on the same line)
    const mergedMods: TextModification[] = [];
    for (const mod of modifications) {
      if (mergedMods.length === 0) {
        mergedMods.push({...mod}); // Clone to avoid mutation issues
      } else {
        const prev = mergedMods[mergedMods.length - 1];
        // If this modification ends where the previous starts (or overlaps), merge them
        if (mod.end >= prev.start) {
          // Merge: the range becomes [mod.start, max(prev.end, mod.end)] with combined text
          prev.end = Math.max(prev.end, mod.end);
          prev.start = mod.start;
          prev.newText = mod.newText + prev.newText;
        } else {
          mergedMods.push({...mod}); // Clone to avoid mutation issues
        }
      }
    }

    // Apply all modifications
    for (const mod of mergedMods) {
      result = result.slice(0, mod.start) + mod.newText + result.slice(mod.end);
    }

    return {transformedText: result, sourceMappings};
  }

  /**
   * Checks if a decorator is from @angular/core.
   */
  private isAngularCoreDecorator(decorator: Decorator): boolean {
    return (
      this.config.isCore || (decorator.import !== null && decorator.import.from === '@angular/core')
    );
  }

  /**
   * Finds the position where new imports should be inserted.
   *
   * Returns the position right after the last import statement (at the end of its text,
   * before any trailing whitespace). The caller is responsible for adding appropriate
   * newlines/whitespace.
   */
  private findImportInsertPosition(sourceFile: ts.SourceFile): number {
    // Find the last import statement
    let lastImport: ts.ImportDeclaration | null = null;
    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        lastImport = statement;
      } else if (!ts.isImportEqualsDeclaration(statement)) {
        // Stop at first non-import statement
        break;
      }
    }

    if (lastImport !== null) {
      // Insert right after the last import statement (no trailing whitespace skipping)
      // This ensures we don't accidentally insert inside a decorator's full range
      return lastImport.getEnd();
    }

    // No imports found, insert at the beginning (after any leading comments)
    let insertPos = 0;
    const leadingComments = ts.getLeadingCommentRanges(sourceFile.getFullText(), 0);
    if (leadingComments && leadingComments.length > 0) {
      insertPos = leadingComments[leadingComments.length - 1].end;
      // Skip any whitespace after comments
      while (insertPos < sourceFile.getFullText().length) {
        const char = sourceFile.getFullText()[insertPos];
        if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
          insertPos++;
        } else {
          break;
        }
      }
    }

    return insertPos;
  }
}

/**
 * Internal representation of a generated member to add to a class.
 */
interface GeneratedMember {
  name: string;
  property: ts.PropertyDeclaration;
}

/**
 * Internal representation of all transformations needed for a class.
 */
interface ClassTransformation {
  node: ts.ClassDeclaration;
  members: GeneratedMember[];
  statements: ts.Statement[];
  decoratorsToRemove: ts.Decorator[];
}
