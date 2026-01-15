/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Type} from '@angular/compiler';
import ts from 'typescript';

import {ImportRewriter, ReferenceEmitter} from '../../imports';
import {ClassDeclaration, ReflectionHost} from '../../reflection';
import {
  ImportManager,
  presetImportManagerForceNamespaceImports,
  translateType,
} from '../../translator';

import {DtsTransform} from './api';

/**
 * Keeps track of `DtsTransform`s per source file, so that it is known which source files need to
 * have their declaration file transformed.
 */
export class DtsTransformRegistry {
  // Use file path as key instead of source file node reference to support
  // pre-transformation mode where the ts.Program is recreated
  private ivyDeclarationTransforms = new Map<string, IvyDeclarationDtsTransform>();

  getIvyDeclarationTransform(sf: ts.SourceFile): IvyDeclarationDtsTransform {
    const key = sf.fileName;
    if (!this.ivyDeclarationTransforms.has(key)) {
      this.ivyDeclarationTransforms.set(key, new IvyDeclarationDtsTransform());
    }
    return this.ivyDeclarationTransforms.get(key)!;
  }

  /**
   * Gets the dts transforms to be applied for the given source file, or `null` if no transform is
   * necessary.
   */
  getAllTransforms(sf: ts.SourceFile): DtsTransform[] | null {
    // No need to transform if it's not a declarations file, or if no changes have been requested
    // to the input file. Due to the way TypeScript afterDeclarations transformers work, the
    // `ts.SourceFile` path is the same as the original .ts. The only way we know it's actually a
    // declaration file is via the `isDeclarationFile` property.
    if (!sf.isDeclarationFile) {
      return null;
    }
    const originalSf = ts.getOriginalNode(sf) as ts.SourceFile;
    const key = originalSf.fileName;

    let transforms: DtsTransform[] | null = null;
    if (this.ivyDeclarationTransforms.has(key)) {
      transforms = [];
      transforms.push(this.ivyDeclarationTransforms.get(key)!);
    }
    return transforms;
  }
}

export function declarationTransformFactory(
  transformRegistry: DtsTransformRegistry,
  reflector: ReflectionHost,
  refEmitter: ReferenceEmitter,
  importRewriter: ImportRewriter,
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const transformer = new DtsTransformer(context, reflector, refEmitter, importRewriter);
    return (fileOrBundle) => {
      if (ts.isBundle(fileOrBundle)) {
        // Only attempt to transform source files.
        return fileOrBundle;
      }
      const transforms = transformRegistry.getAllTransforms(fileOrBundle);
      if (transforms === null) {
        return fileOrBundle;
      }
      return transformer.transform(fileOrBundle, transforms);
    };
  };
}

/**
 * Processes .d.ts file text and adds static field declarations, with types.
 */
class DtsTransformer {
  constructor(
    private ctx: ts.TransformationContext,
    private reflector: ReflectionHost,
    private refEmitter: ReferenceEmitter,
    private importRewriter: ImportRewriter,
  ) {}

  /**
   * Transform the declaration file and add any declarations which were recorded.
   */
  transform(sf: ts.SourceFile, transforms: DtsTransform[]): ts.SourceFile {
    const imports = new ImportManager({
      ...presetImportManagerForceNamespaceImports,
      rewriter: this.importRewriter,
    });

    const visitor: ts.Visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (ts.isClassDeclaration(node)) {
        return this.transformClassDeclaration(node, transforms, imports);
      } else {
        // Otherwise return node as is.
        return ts.visitEachChild(node, visitor, this.ctx);
      }
    };

    // Recursively scan through the AST and process all nodes as desired.
    sf = ts.visitNode(sf, visitor, ts.isSourceFile) || sf;

    // Update/insert needed imports.
    return imports.transformTsFile(this.ctx, sf);
  }

  private transformClassDeclaration(
    clazz: ts.ClassDeclaration,
    transforms: DtsTransform[],
    imports: ImportManager,
  ): ts.ClassDeclaration {
    let newClazz: ts.ClassDeclaration = clazz;

    for (const transform of transforms) {
      if (transform.transformClass !== undefined) {
        newClazz = transform.transformClass(
          newClazz,
          newClazz.members,
          this.reflector,
          this.refEmitter,
          imports,
        );
      }
    }

    return newClazz;
  }
}

export interface IvyDeclarationField {
  name: string;
  type: Type;
}

/**
 * Creates a unique key for a class declaration based on its file path and class name.
 * This allows looking up declaration fields by identity rather than node reference,
 * which is essential for pre-transformation mode where the ts.Program is recreated.
 */
function getClassKey(clazz: ClassDeclaration | ts.ClassDeclaration): string {
  const fileName = clazz.getSourceFile().fileName;
  const className = clazz.name?.text ?? '<anonymous>';
  return `${fileName}#${className}`;
}

export class IvyDeclarationDtsTransform implements DtsTransform {
  // Map keyed by "filePath#className" to support pre-transformation mode
  // where node references don't match across different ts.Program instances
  private declarationFields = new Map<string, IvyDeclarationField[]>();
  // Keep original source files for type translation context
  private originalSourceFiles = new Map<string, ts.SourceFile>();

  addFields(decl: ClassDeclaration, fields: IvyDeclarationField[]): void {
    const key = getClassKey(decl);
    this.declarationFields.set(key, fields);
    // Store the original source file for use in translateType
    this.originalSourceFiles.set(key, decl.getSourceFile());
  }

  transformClass(
    clazz: ts.ClassDeclaration,
    members: ReadonlyArray<ts.ClassElement>,
    reflector: ReflectionHost,
    refEmitter: ReferenceEmitter,
    imports: ImportManager,
  ): ts.ClassDeclaration {
    // Use ts.getOriginalNode to handle transformed nodes, then get the key
    const originalClazz = ts.getOriginalNode(clazz) as ts.ClassDeclaration;
    const key = getClassKey(originalClazz);

    if (!this.declarationFields.has(key)) {
      return clazz;
    }
    const fields = this.declarationFields.get(key)!;
    // Use the original source file stored during addFields for proper type translation
    const contextSourceFile = this.originalSourceFiles.get(key) ?? originalClazz.getSourceFile();

    const newMembers = fields.map((decl) => {
      const modifiers = [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)];
      const typeRef = translateType(
        decl.type,
        contextSourceFile,
        reflector,
        refEmitter,
        imports,
      );
      markForEmitAsSingleLine(typeRef);
      return ts.factory.createPropertyDeclaration(
        /* modifiers */ modifiers,
        /* name */ decl.name,
        /* questionOrExclamationToken */ undefined,
        /* type */ typeRef,
        /* initializer */ undefined,
      );
    });

    return ts.factory.updateClassDeclaration(
      /* node */ clazz,
      /* modifiers */ clazz.modifiers,
      /* name */ clazz.name,
      /* typeParameters */ clazz.typeParameters,
      /* heritageClauses */ clazz.heritageClauses,
      /* members */ [...members, ...newMembers],
    );
  }
}

function markForEmitAsSingleLine(node: ts.Node) {
  ts.setEmitFlags(node, ts.EmitFlags.SingleLine);
  ts.forEachChild(node, markForEmitAsSingleLine);
}
