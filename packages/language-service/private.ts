/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

export * from './src/template_target';
export {
  getDirectiveMatchesForElementTag,
  getDirectiveMatchesForAttribute,
  makeElementSelector,
  isTemplateNode,
  isTemplateNodeWithKeyAndValue,
  getTextSpanOfNode,
  toTextSpan,
  isWithin,
  isBoundEventWithSyntheticHandler,
} from './src/utils';
export {findTightestNode, getParentClassDeclaration} from './src/utils/ts_utils';
export {BUILT_IN_NAMES_TO_DOC_MAP, isDollarAny} from './src/quick_info_built_ins';
export {
  AttributeCompletionKind,
  AsciiSortPriority,
  getStructuralAttributes,
  buildSnippet,
} from './src/attribute_completions';
