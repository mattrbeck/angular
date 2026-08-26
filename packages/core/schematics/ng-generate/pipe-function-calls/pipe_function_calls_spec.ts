/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {migrateTemplatePipeSyntax} from './util';

describe('pipe-function-calls schematic utils', () => {
  it('should migrate a single argument pipe', () => {
    const template = '<div>{{ name | uppercase }}</div>';
    const result = migrateTemplatePipeSyntax(template, new Set(), new Set(['uppercase']));
    expect(result.hasChanges).toBe(true);
    expect(result.migratedContent).toBe('<div>{{ uppercase(name) }}</div>');
    expect(result.pipeCount).toBe(1);
  });

  it('should migrate a multi-argument pipe', () => {
    const template = "<div>{{ birthday | date:'yyyy-MM-dd':'UTC' }}</div>";
    const result = migrateTemplatePipeSyntax(template, new Set(), new Set(['date']));
    expect(result.hasChanges).toBe(true);
    expect(result.migratedContent).toBe("<div>{{ date(birthday, 'yyyy-MM-dd', 'UTC') }}</div>");
    expect(result.pipeCount).toBe(1);
  });

  it('should migrate chained pipes in correct evaluation order', () => {
    const template = '<div>{{ user.name | trim | uppercase }}</div>';
    const result = migrateTemplatePipeSyntax(template, new Set(), new Set(['trim', 'uppercase']));
    expect(result.hasChanges).toBe(true);
    expect(result.migratedContent).toBe('<div>{{ uppercase(trim(user.name)) }}</div>');
    expect(result.pipeCount).toBe(2);
  });

  it('should automatically prefix conflicting component method calls with this.', () => {
    const template = '<div>{{ format(user.date) }} {{ name | uppercase }}</div>';
    const componentMembers = new Set(['format']);
    const inScopePipes = new Set(['format', 'uppercase']);

    const result = migrateTemplatePipeSyntax(template, componentMembers, inScopePipes);
    expect(result.hasChanges).toBe(true);
    expect(result.migratedContent).toBe(
      '<div>{{ this.format(user.date) }} {{ uppercase(name) }}</div>',
    );
    expect(result.conflictCount).toBe(1);
    expect(result.pipeCount).toBe(1);
  });
});
