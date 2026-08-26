/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ErrorCode, ngErrorCode} from '@angular/compiler-cli';
import type ts from 'typescript';

import {CodeActionMeta, FixIdForCodeFixesAll} from './utils';

/**
 * Fix for [ambiguous pipe function call](https://angular.dev/extended-diagnostics/NG8110).
 * Adds `this.` prefix to explicitly target the component method.
 */
export const fixAmbiguousPipeFunctionCallMeta: CodeActionMeta = {
  errorCodes: [ngErrorCode(ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL)],
  getCodeActions({start, fileName}) {
    return [
      {
        fixName: FixIdForCodeFixesAll.FIX_AMBIGUOUS_PIPE_FUNCTION_CALL,
        fixId: FixIdForCodeFixesAll.FIX_AMBIGUOUS_PIPE_FUNCTION_CALL,
        fixAllDescription: "Add 'this.' to all ambiguous component method calls",
        description: "Add 'this.' to call component method",
        changes: [
          {
            fileName,
            textChanges: [
              {
                span: {
                  start,
                  length: 0,
                },
                newText: 'this.',
              },
            ],
          },
        ],
      },
    ];
  },
  fixIds: [FixIdForCodeFixesAll.FIX_AMBIGUOUS_PIPE_FUNCTION_CALL],
  getAllCodeActions({diagnostics}) {
    const fileNameToTextChangesMap = new Map<string, ts.TextChange[]>();
    for (const diag of diagnostics) {
      const fileName = diag.file?.fileName;
      if (fileName === undefined || diag.start === undefined) {
        continue;
      }

      if (!fileNameToTextChangesMap.has(fileName)) {
        fileNameToTextChangesMap.set(fileName, []);
      }
      const textChanges = fileNameToTextChangesMap.get(fileName)!;
      textChanges.push({
        span: {
          start: diag.start,
          length: 0,
        },
        newText: 'this.',
      });
    }

    const fileTextChanges: ts.FileTextChanges[] = [];
    for (const [fileName, textChanges] of fileNameToTextChangesMap) {
      fileTextChanges.push({
        fileName,
        textChanges,
      });
    }
    return {
      changes: fileTextChanges,
    };
  },
};
