// import * as postcss from 'postcss';
import {default as postcss} from 'postcss';
// import {Rule, Declaration} from 'postcss';
import plugin from './style_encapsulation';
// const plugin = 5;

/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// const plugin = () => {
//   return {
//     postcssPlugin: 'to-red',
//     Rule(rule: Rule) {
//       console.log(rule.toString());
//     },
//     Declaration(decl: Declaration) {
//       console.log(decl.toString());
//       decl.value = 'red';
//     },
//   };
// };
// plugin.postcss = true;

export class ShadowCss {
  /*
   * Shim some cssText with the given selector. Returns cssText that can be included in the document
   *
   * The selector is the attribute added to all elements inside the host,
   * The hostSelector is the attribute added to the host itself.
   */
  shimCssText(cssText: string, selector: string, hostSelector: string = ''): string {
    // console.log(postcss);
    // console.log(plugin);
    const result = postcss([plugin({content: selector, host: hostSelector, legacy: false})])
      .process(cssText, {from: undefined})
      .sync();
    // if (result === undefined || result.css === undefined) {
    //   throw new Error(`Undefined result when shimming css!\n
    //     result: ${result}\n
    //     result.content: ${result.content}\n
    //     result.root: ${result.root}\n
    //     result.messages: ${result.messages}\n
    //     result.lastPlugin: ${result.lastPlugin}\n
    //     cssText: ${cssText}`);
    // }
    return result.root.toString();
    // return postcss([plugin]);
    // return 'cssText';
  }
}

export class CssRule {
  constructor(
    public selector: string,
    public content: string,
  ) {}
}

export function processRules(input: string, ruleCallback: (rule: CssRule) => CssRule): string {
  return 'processRules';
}

/**
 * Mutate the given `groups` array so that there are `multiples` clones of the original array
 * stored.
 *
 * For example `repeatGroups([a, b], 3)` will result in `[a, b, a, b, a, b]` - but importantly the
 * newly added groups will be clones of the original.
 *
 * @param groups An array of groups of strings that will be repeated. This array is mutated
 *     in-place.
 * @param multiples The number of times the current groups should appear.
 */
export function repeatGroups(groups: string[][], multiples: number): void {
  const length = groups.length;
  for (let i = 1; i < multiples; i++) {
    for (let j = 0; j < length; j++) {
      groups[j + i * length] = groups[j].slice(0);
    }
  }
}
