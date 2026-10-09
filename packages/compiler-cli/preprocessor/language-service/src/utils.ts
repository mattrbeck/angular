/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getDirectiveMatchesForElementTag,
  getDirectiveMatchesForAttribute,
  makeElementSelector,
  isTemplateNode,
  isTemplateNodeWithKeyAndValue,
  getTextSpanOfNode,
  isWithin,
  isBoundEventWithSyntheticHandler,
} from '@angular/language-service/private';

export {
  getDirectiveMatchesForElementTag,
  getDirectiveMatchesForAttribute,
  makeElementSelector,
  isTemplateNode,
  isTemplateNodeWithKeyAndValue,
  getTextSpanOfNode,
  isWithin,
  isBoundEventWithSyntheticHandler,
};

export interface ClassMetadata {
  hostBindings?: Array<{
    decoratorSpan?: {start: number; end: number};
  }>;
  hostListeners?: Array<{
    decoratorSpan?: {start: number; end: number};
  }>;
  component?: {
    hostProperties?: Array<{
      key: {sourceSpan?: {start: number; end: number}};
      value: {sourceSpan?: {start: number; end: number}};
    }>;
  };
  directive?: {
    hostProperties?: Array<{
      key: {sourceSpan?: {start: number; end: number}};
      value: {sourceSpan?: {start: number; end: number}};
    }>;
  };
}

export function isPositionInHostBinding(c: ClassMetadata, offset: number): boolean {
  for (const hb of c.hostBindings ?? []) {
    if (hb.decoratorSpan && offset >= hb.decoratorSpan.start && offset <= hb.decoratorSpan.end) {
      return true;
    }
  }

  for (const hl of c.hostListeners ?? []) {
    if (hl.decoratorSpan && offset >= hl.decoratorSpan.start && offset <= hl.decoratorSpan.end) {
      return true;
    }
  }

  // TODO(cleanup): Unify component and directive hostProperties in ClassMetadata.
  const hostProps = c.component?.hostProperties || c.directive?.hostProperties || [];
  for (const hp of hostProps) {
    if (hp.key.sourceSpan && offset >= hp.key.sourceSpan.start && offset <= hp.key.sourceSpan.end) {
      return true;
    }
    if (
      hp.value.sourceSpan &&
      offset >= hp.value.sourceSpan.start &&
      offset <= hp.value.sourceSpan.end
    ) {
      return true;
    }
  }

  return false;
}

export async function canonicalizePath(filePath: string): Promise<string> {
  try {
    const p = filePath.replace(/\\/g, '/');
    try {
      return (await fs.realpath(p)).replace(/\\/g, '/');
    } catch {
      const dir = path.dirname(p);
      try {
        const realDir = (await fs.realpath(dir)).replace(/\\/g, '/');
        return path.join(realDir, path.basename(p)).replace(/\\/g, '/');
      } catch {
        return p;
      }
    }
  } catch {
    return filePath;
  }
}
