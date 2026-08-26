/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  AST,
  BindingPipe,
  Call,
  ImplicitReceiver,
  Interpolation,
  parseTemplate,
  PropertyRead,
  RecursiveAstVisitor,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstBoundText,
  TmplAstNode,
  TmplAstRecursiveVisitor,
  TmplAstTemplate,
} from '@angular/compiler';

export interface PipeMigrationResult {
  migratedContent: string;
  hasChanges: boolean;
  pipeCount: number;
  conflictCount: number;
}

interface Replacement {
  start: number;
  end: number;
  replacementText: string;
}

/**
 * Rewrites traditional pipe bindings (`exp | pipe:arg1:arg2`) to function-call syntax (`pipe(exp, arg1, arg2)`),
 * and automatically prefixes ambiguous component method calls (`conflictingMethod(...)`) with `this.`.
 */
export function migrateTemplatePipeSyntax(
  templateContent: string,
  componentMemberNames: Set<string>,
  pipeNames: Set<string>,
): PipeMigrationResult {
  const parsed = parseTemplate(templateContent, 'template.html', {preserveWhitespaces: true});
  if (parsed.errors && parsed.errors.length > 0) {
    return {migratedContent: templateContent, hasChanges: false, pipeCount: 0, conflictCount: 0};
  }

  const replacements: Replacement[] = [];
  let pipeCount = 0;
  let conflictCount = 0;

  class TemplateVisitor extends TmplAstRecursiveVisitor {
    override visitBoundText(text: TmplAstBoundText) {
      if (text.value instanceof AST) {
        this.visitExpression(text.value, templateContent);
      }
    }

    override visitBoundAttribute(attr: TmplAstBoundAttribute) {
      if (attr.value instanceof AST) {
        this.visitExpression(attr.value, templateContent);
      }
    }

    override visitBoundEvent(event: TmplAstBoundEvent) {
      if (event.handler instanceof AST) {
        this.visitExpression(event.handler, templateContent);
      }
    }

    override visitTemplate(template: TmplAstTemplate) {
      for (const attr of template.templateAttrs) {
        if (attr.value instanceof AST) {
          this.visitExpression(attr.value, templateContent);
        }
      }
      super.visitTemplate(template);
    }

    private visitExpression(rootAst: AST, source: string) {
      const visitedPipes = new Set<BindingPipe>();

      class ExpressionVisitor extends RecursiveAstVisitor {
        override visitPipe(ast: BindingPipe, context: any): any {
          // If we already visited this pipe as part of an outer pipe transformation, skip
          if (visitedPipes.has(ast)) {
            return;
          }

          // Count all nested pipes in this chain
          function markNestedPipes(curr: AST) {
            if (curr instanceof BindingPipe) {
              visitedPipes.add(curr);
              pipeCount++;
              markNestedPipes(curr.exp);
              curr.args.forEach(markNestedPipes);
            }
          }
          markNestedPipes(ast);

          const functionalSyntax = printAstWithPipes(ast, source);

          replacements.push({
            start: ast.sourceSpan.start,
            end: ast.sourceSpan.end,
            replacementText: functionalSyntax,
          });
        }

        override visitCall(ast: Call, context: any): any {
          super.visitCall(ast, context);

          // Check if this is an ambiguous bare call: foo(...) where foo is both a component member and an imported pipe
          if (
            ast.receiver instanceof PropertyRead &&
            ast.receiver.receiver instanceof ImplicitReceiver
          ) {
            const methodName = ast.receiver.name;
            if (componentMemberNames.has(methodName) && pipeNames.has(methodName)) {
              // Automatically prefix with `this.` to preserve component method target
              const fullSource = source.substring(ast.sourceSpan.start, ast.sourceSpan.end).trim();
              const resolvedCall = `this.${fullSource}`;

              replacements.push({
                start: ast.sourceSpan.start,
                end: ast.sourceSpan.end,
                replacementText: resolvedCall,
              });
              conflictCount++;
            }
          }
        }
      }

      rootAst.visit(new ExpressionVisitor());
    }
  }

  for (const node of parsed.nodes) {
    node.visit(new TemplateVisitor());
  }

  if (replacements.length === 0) {
    return {migratedContent: templateContent, hasChanges: false, pipeCount: 0, conflictCount: 0};
  }

  // Sort replacements from end to start to preserve index offsets during string mutation
  replacements.sort((a, b) => b.start - a.start);

  let result = templateContent;
  for (const rep of replacements) {
    result = result.slice(0, rep.start) + rep.replacementText + result.slice(rep.end);
  }

  return {
    migratedContent: result,
    hasChanges: true,
    pipeCount,
    conflictCount,
  };
}

/** Recursively renders AST expressions, transforming nested pipes into nested function calls. */
function printAstWithPipes(ast: AST, source: string): string {
  if (ast instanceof BindingPipe) {
    const expText = printAstWithPipes(ast.exp, source);
    const argTexts = ast.args.map((a) => printAstWithPipes(a, source));
    const allArgs = [expText, ...argTexts].join(', ');
    return `${ast.name}(${allArgs})`;
  }
  if (ast.sourceSpan && ast.sourceSpan.start >= 0 && ast.sourceSpan.end <= source.length) {
    return source.substring(ast.sourceSpan.start, ast.sourceSpan.end).trim();
  }
  return '';
}
