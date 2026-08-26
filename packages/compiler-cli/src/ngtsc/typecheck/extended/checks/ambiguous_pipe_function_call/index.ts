/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {AST, Call, ImplicitReceiver, PropertyRead, SafeCall, TmplAstNode} from '@angular/compiler';
import ts from 'typescript';

import {ErrorCode, ExtendedTemplateDiagnosticName} from '../../../../diagnostics';
import {NgTemplateDiagnostic, SymbolKind} from '../../../api';
import {
  TemplateCheckFactory,
  TemplateCheckWithVisitor,
  TemplateContext,
  formatExtendedError,
} from '../../api';

/**
 * Ensures that bare function calls in templates do not ambiguously match both an in-scope Pipe
 * and a component class member.
 */
class AmbiguousPipeFunctionCallCheck extends TemplateCheckWithVisitor<ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL> {
  override code = ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL as const;

  override visitNode(
    ctx: TemplateContext<ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL>,
    component: ts.ClassDeclaration,
    node: TmplAstNode | AST,
  ): NgTemplateDiagnostic<ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL>[] {
    if (node instanceof Call || node instanceof SafeCall) {
      if (
        node.receiver instanceof PropertyRead &&
        node.receiver.receiver instanceof ImplicitReceiver
      ) {
        const name = node.receiver.name;
        const potentialPipes = ctx.templateTypeChecker.getPotentialPipes(component);
        const hasMatchingPipe = potentialPipes.some((pipe) => pipe.name === name);

        if (hasMatchingPipe) {
          const hasMatchingMember = component.members.some(
            (member) => member.name && ts.isIdentifier(member.name) && member.name.text === name,
          );

          if (hasMatchingMember) {
            const errorString = formatExtendedError(
              ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL,
              `Ambiguous call to '${name}()': '${name}' is both an imported Pipe and a member on component '${component.name?.text ?? 'Anonymous'}'. ` +
                `If you intended to call the component member, use 'this.${name}()' instead.`,
            );

            const symbol = ctx.templateTypeChecker.getSymbolOfNode(node, component);
            if (symbol !== null && symbol.kind === SymbolKind.Expression) {
              const templateMapping = ctx.templateTypeChecker.getSourceMappingAtTcbLocation(
                symbol.tcbLocation,
              );
              if (templateMapping) {
                return [ctx.makeTemplateDiagnostic(templateMapping.span, errorString)];
              }
            }
          }
        }
      }
    }

    return [];
  }
}

export const factory: TemplateCheckFactory<
  ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL,
  ExtendedTemplateDiagnosticName.AMBIGUOUS_PIPE_FUNCTION_CALL
> = {
  code: ErrorCode.AMBIGUOUS_PIPE_FUNCTION_CALL,
  name: ExtendedTemplateDiagnosticName.AMBIGUOUS_PIPE_FUNCTION_CALL,
  create: () => new AmbiguousPipeFunctionCallCheck(),
};
