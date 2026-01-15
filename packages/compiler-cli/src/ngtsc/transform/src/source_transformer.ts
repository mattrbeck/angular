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
   * @returns The transformed source file, or null if no transformation was needed
   */
  transform(
    sourceFile: ts.SourceFile,
    compilation: TraitCompiler,
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

    // If no transformations needed, return null
    if (classTransformations.size === 0) {
      return null;
    }

    // Generate the transformed source text
    const {transformedText, sourceMappings} = this.generateTransformedText(
      sourceFile,
      classTransformations,
      constantPool,
      importManager,
      allDeferrableImports,
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
      const exprNode = translateExpression(sourceFile, field.initializer, importManager, {
        annotateForClosureCompiler: this.config.isClosureCompilerEnabled,
      });

      // Create a static property declaration
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
   */
  private generateTransformedText(
    sourceFile: ts.SourceFile,
    classTransformations: Map<ts.ClassDeclaration, ClassTransformation>,
    constantPool: ConstantPool,
    importManager: ImportManager,
    deferrableImports: Set<ts.ImportDeclaration>,
  ): {transformedText: string; sourceMappings: SourceMapping[]} {
    const sourceMappings: SourceMapping[] = [];
    let result = sourceFile.getFullText();

    // Sort transformations by position (reverse order to avoid position shifts)
    const sortedTransformations = Array.from(classTransformations.entries()).sort(
      ([a], [b]) => b.getStart() - a.getStart(),
    );

    // Apply class transformations in reverse order
    for (const [classNode, transformation] of sortedTransformations) {
      result = this.applyClassTransformation(
        result,
        sourceFile,
        classNode,
        transformation,
        sourceMappings,
      );
    }

    // Remove deferrable imports
    const sortedImports = Array.from(deferrableImports).sort(
      (a, b) => b.getStart() - a.getStart(),
    );
    for (const importDecl of sortedImports) {
      const start = importDecl.getFullStart();
      const end = importDecl.getEnd();
      result = result.slice(0, start) + result.slice(end);
    }

    // Generate constant pool statements
    const constantStatements = constantPool.statements.map((stmt) =>
      translateStatement(sourceFile, stmt, importManager, {
        annotateForClosureCompiler: this.config.isClosureCompilerEnabled,
      }),
    );

    // Finalize imports and generate import declarations
    const {newImports, updatedImports, deletedImports} = importManager.finalize();

    // Handle deleted imports
    const sortedDeletedImports = Array.from(deletedImports).sort(
      (a, b) => b.getStart() - a.getStart(),
    );
    for (const importDecl of sortedDeletedImports) {
      const start = importDecl.getFullStart();
      const end = importDecl.getEnd();
      result = result.slice(0, start) + result.slice(end);
    }

    // Handle updated imports
    for (const [oldBindings, newBindings] of updatedImports) {
      const start = oldBindings.getStart();
      const end = oldBindings.getEnd();
      const newText = this.printer.printNode(ts.EmitHint.Unspecified, newBindings, sourceFile);
      result = result.slice(0, start) + newText + result.slice(end);
    }

    // Add new imports at the top of the file (after any leading comments/directives)
    const newImportDecls = newImports.get(sourceFile.fileName) ?? [];
    if (newImportDecls.length > 0 || constantStatements.length > 0) {
      const insertPosition = this.findImportInsertPosition(sourceFile);
      const newImportText = newImportDecls
        .map((decl) => this.printer.printNode(ts.EmitHint.Unspecified, decl, sourceFile))
        .join('\n');
      const constantText = constantStatements
        .map((stmt) => this.printer.printNode(ts.EmitHint.Unspecified, stmt, sourceFile))
        .join('\n');

      const insertText =
        (newImportText ? newImportText + '\n' : '') + (constantText ? constantText + '\n' : '');

      result = result.slice(0, insertPosition) + insertText + result.slice(insertPosition);
    }

    return {transformedText: result, sourceMappings};
  }

  /**
   * Applies a class transformation to the source text.
   */
  private applyClassTransformation(
    text: string,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration,
    transformation: ClassTransformation,
    sourceMappings: SourceMapping[],
  ): string {
    const {members, statements, decoratorsToRemove} = transformation;

    // Generate text for new members
    const membersText = members
      .map((m) => {
        // Add source mapping marker
        const markerStart = `/*@ng:${classNode.getStart()},${classNode.getEnd()}*/`;
        const memberText = this.printer.printNode(ts.EmitHint.Unspecified, m.property, sourceFile);

        // Add @nocollapse annotation for Closure Compiler
        if (this.config.isClosureCompilerEnabled) {
          return `  /** @nocollapse */ ${markerStart}${memberText}`;
        }
        return `  ${markerStart}${memberText}`;
      })
      .join('\n');

    // Find the position to insert new members (just before the closing brace)
    const classText = classNode.getFullText();
    const closingBracePos = classNode.getEnd() - 1;

    // Insert new members
    if (membersText) {
      text = text.slice(0, closingBracePos) + '\n' + membersText + '\n' + text.slice(closingBracePos);
    }

    // Add statements after the class
    if (statements.length > 0) {
      const statementsText = statements
        .map((stmt) => this.printer.printNode(ts.EmitHint.Unspecified, stmt, sourceFile))
        .join('\n');
      const classEnd = classNode.getEnd();
      text = text.slice(0, classEnd) + '\n' + statementsText + text.slice(classEnd);
    }

    // Remove Angular decorators from the class
    text = this.removeDecorators(text, sourceFile, classNode, decoratorsToRemove);

    // Remove Angular decorators from class members
    text = this.removeAngularDecoratorFromMembers(text, sourceFile, classNode);

    return text;
  }

  /**
   * Removes specified decorators from the class declaration.
   */
  private removeDecorators(
    text: string,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration,
    decoratorsToRemove: ts.Decorator[],
  ): string {
    // Sort decorators by position (reverse order)
    const sortedDecorators = [...decoratorsToRemove].sort(
      (a, b) => b.getStart() - a.getStart(),
    );

    for (const decorator of sortedDecorators) {
      const start = decorator.getFullStart();
      const end = decorator.getEnd();
      // Remove the decorator and any trailing whitespace/newline
      const afterEnd = text.slice(end).match(/^[\s]*/)?.[0]?.length ?? 0;
      text = text.slice(0, start) + text.slice(end + afterEnd);
    }

    return text;
  }

  /**
   * Removes Angular decorators from class members (properties, methods, etc.).
   */
  private removeAngularDecoratorFromMembers(
    text: string,
    sourceFile: ts.SourceFile,
    classNode: ts.ClassDeclaration,
  ): string {
    // Get all decorators to remove from members
    const memberDecoratorsToRemove: ts.Decorator[] = [];

    for (const member of classNode.members) {
      const decorators = this.reflector.getDecoratorsOfDeclaration(member);
      if (decorators === null) continue;

      for (const decorator of decorators) {
        if (this.isAngularCoreDecorator(decorator)) {
          memberDecoratorsToRemove.push(decorator.node as ts.Decorator);
        }
      }
    }

    // Also check constructor parameters
    const ctor = classNode.members.find(ts.isConstructorDeclaration);
    if (ctor) {
      for (const param of ctor.parameters) {
        const decorators = this.reflector.getDecoratorsOfDeclaration(param);
        if (decorators === null) continue;

        for (const decorator of decorators) {
          if (this.isAngularCoreDecorator(decorator)) {
            memberDecoratorsToRemove.push(decorator.node as ts.Decorator);
          }
        }
      }
    }

    // Sort and remove
    const sortedDecorators = memberDecoratorsToRemove.sort(
      (a, b) => b.getStart() - a.getStart(),
    );

    for (const decorator of sortedDecorators) {
      const start = decorator.getFullStart();
      const end = decorator.getEnd();
      const afterEnd = text.slice(end).match(/^[\s]*/)?.[0]?.length ?? 0;
      text = text.slice(0, start) + text.slice(end + afterEnd);
    }

    return text;
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
   */
  private findImportInsertPosition(sourceFile: ts.SourceFile): number {
    let insertPos = 0;

    // Skip past any leading comments (like license headers)
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

    // Find the last import statement to insert after it
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
      insertPos = lastImport.getEnd();
      // Skip any trailing newlines
      while (insertPos < sourceFile.getFullText().length) {
        const char = sourceFile.getFullText()[insertPos];
        if (char === '\n' || char === '\r') {
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
