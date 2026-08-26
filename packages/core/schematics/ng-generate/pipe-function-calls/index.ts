/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Rule, SchematicContext, SchematicsException, Tree} from '@angular-devkit/schematics';
import {join} from 'path';

import {canMigrateFile, createMigrationProgram} from '../../utils/typescript/compiler_host';
import {getProjectTsConfigPaths} from '../../utils/project_tsconfig_paths';
import {normalizePath} from '../../utils/change_tracker';
import {migrateSourceFile} from './migration';

interface Options {
  path?: string;
  format?: boolean;
}

export function migrate(options: Options): Rule {
  return async (tree: Tree, context: SchematicContext) => {
    let allPaths: string[] = [];
    const basePath = process.cwd();
    let pathToMigrate: string | undefined;

    if (options.path) {
      if (options.path.startsWith('..')) {
        throw new SchematicsException(
          'Cannot run pipe function calls migration outside of the current project.',
        );
      }
      pathToMigrate = normalizePath(join(basePath, options.path));
      if (pathToMigrate.trim() !== '') {
        allPaths.push(pathToMigrate);
      }
    } else {
      const {buildPaths, testPaths} = await getProjectTsConfigPaths(tree);
      allPaths = [...buildPaths, ...testPaths];
    }

    if (!allPaths.length) {
      context.logger.warn(
        'Could not find any tsconfig file. Cannot run the pipe function calls migration.',
      );
      return;
    }

    let totalPipes = 0;
    let totalConflicts = 0;
    let totalFiles = 0;

    for (const tsconfigPath of allPaths) {
      const program = createMigrationProgram(tree, tsconfigPath, basePath);
      const typeChecker = program.getTypeChecker();
      const sourceFiles = program
        .getSourceFiles()
        .filter((sf) => canMigrateFile(basePath, sf, program));

      for (const sf of sourceFiles) {
        const summary = migrateSourceFile(sf, typeChecker, tree, basePath);
        totalFiles += summary.filesChanged;
        totalPipes += summary.pipesMigrated;
        totalConflicts += summary.conflictsResolved;
      }
    }

    context.logger.info(
      `Pipe Function Calls Migration complete!\n` +
        `  - Files updated: ${totalFiles}\n` +
        `  - Pipes converted: ${totalPipes}\n` +
        `  - Collisions automatically resolved with 'this.': ${totalConflicts}`,
    );
  };
}
