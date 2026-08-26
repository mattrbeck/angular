/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Tree} from '@angular-devkit/schematics';
import {dirname, join} from 'path';
import ts from 'typescript';

import {migrateTemplatePipeSyntax, PipeMigrationResult} from './util';

export interface MigrationSummary {
  filesChanged: number;
  pipesMigrated: number;
  conflictsResolved: number;
}

/**
 * Traverses a TypeScript AST, finds Angular `@Component` decorators, extracts template & member info,
 * and updates templates to use function-call pipe syntax.
 */
export function migrateSourceFile(
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  tree: Tree,
  basePath: string,
): MigrationSummary {
  let filesChanged = 0;
  let pipesMigrated = 0;
  let conflictsResolved = 0;

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const decorators = ts.getDecorators(node);
      if (decorators) {
        for (const decorator of decorators) {
          if (
            ts.isCallExpression(decorator.expression) &&
            ts.isIdentifier(decorator.expression.expression) &&
            decorator.expression.expression.text === 'Component'
          ) {
            const args = decorator.expression.arguments;
            if (args.length > 0 && ts.isObjectLiteralExpression(args[0])) {
              const compObj = args[0];

              // Collect member names on the component class
              const memberNames = new Set<string>();
              for (const member of node.members) {
                if (member.name && ts.isIdentifier(member.name)) {
                  memberNames.add(member.name.text);
                }
              }

              // Collect imported / declared pipe names from imports/declarations
              const pipeNames = new Set<string>();
              for (const prop of compObj.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                  if (
                    prop.name.text === 'imports' &&
                    ts.isArrayLiteralExpression(prop.initializer)
                  ) {
                    for (const elem of prop.initializer.elements) {
                      if (ts.isIdentifier(elem)) {
                        // Conventional pipe names / suffixes or registered identifier
                        pipeNames.add(elem.text);
                      }
                    }
                  }
                }
              }

              // Handle inline template
              for (const prop of compObj.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                  if (prop.name.text === 'template' && ts.isStringLiteralLike(prop.initializer)) {
                    const templateText = prop.initializer.text;
                    const res = migrateTemplatePipeSyntax(templateText, memberNames, pipeNames);
                    if (res.hasChanges) {
                      const updatedFile =
                        sourceFile.text.slice(0, prop.initializer.getStart() + 1) +
                        res.migratedContent +
                        sourceFile.text.slice(prop.initializer.getEnd() - 1);

                      tree.overwrite(sourceFile.fileName, updatedFile);
                      filesChanged++;
                      pipesMigrated += res.pipeCount;
                      conflictsResolved += res.conflictCount;
                    }
                  } else if (
                    prop.name.text === 'templateUrl' &&
                    ts.isStringLiteralLike(prop.initializer)
                  ) {
                    // Handle external template file
                    const templateUrl = prop.initializer.text;
                    const templatePath = join(dirname(sourceFile.fileName), templateUrl);
                    if (tree.exists(templatePath)) {
                      const content = tree.readText(templatePath);
                      const res = migrateTemplatePipeSyntax(content, memberNames, pipeNames);
                      if (res.hasChanges) {
                        tree.overwrite(templatePath, res.migratedContent);
                        filesChanged++;
                        pipesMigrated += res.pipeCount;
                        conflictsResolved += res.conflictCount;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {filesChanged, pipesMigrated, conflictsResolved};
}
