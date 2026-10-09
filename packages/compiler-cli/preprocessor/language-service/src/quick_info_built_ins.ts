/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {StructuralQuickInfo} from './facade.js';
import {BUILT_IN_NAMES_TO_DOC_MAP, isDollarAny} from '@angular/language-service/private';

export {isDollarAny};

export function getQuickInfoForBuiltIn(name: string): StructuralQuickInfo | null {
  const partInfo = BUILT_IN_NAMES_TO_DOC_MAP[name];
  if (!partInfo) return null;

  const linksText = partInfo.links.join('\n\n');
  const text = `\`\`\`keyword\n(${partInfo.displayInfoKind}) ${name}\n\`\`\`\n\n${partInfo.docString}${linksText ? '\n\n' + linksText : ''}`;

  return {
    text,
    kind: partInfo.displayInfoKind,
  };
}

export function createDollarAnyQuickInfo(): StructuralQuickInfo {
  return {
    text: `\`\`\`keyword\n(method) $any\n\`\`\`\n\nfunction to cast an expression to the \`any\` type`,
    kind: 'method',
  };
}

export function createNgTemplateQuickInfo(): StructuralQuickInfo {
  return {
    text: `\`\`\`keyword\n(template) ng-template\n\`\`\`\n\nThe \`<ng-template>\` is an Angular element for rendering HTML. It is never displayed directly.`,
    kind: 'template',
  };
}
