/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Routes} from '../src';
import {PRIMARY_OUTLET} from '../src/shared';
import {assertValidLazyRouteConfig, validateConfig} from '../src/utils/config';

describe('config', () => {
  describe('assertValidLazyRouteConfig', () => {
    const route = {path: 'a', loadConfig: () => ({})};

    it('should accept properties that can be lazily loaded', () => {
      expect(() =>
        assertValidLazyRouteConfig(route, {
          component: ComponentA,
          children: [],
          providers: [],
          data: {},
          title: 'a',
        }),
      ).not.toThrow();
    });

    it('should reject properties that are used for matching', () => {
      for (const key of ['path', 'matcher', 'pathMatch', 'outlet', 'redirectTo', 'canMatch']) {
        expect(() => assertValidLazyRouteConfig(route, {[key]: 'x'} as any)).toThrowError(
          new RegExp(`'${key}' is used to match the URL and cannot be lazily loaded`),
        );
      }
    });

    it('should reject overriding a property defined on the route', () => {
      expect(() =>
        assertValidLazyRouteConfig({...route, data: {a: 1}}, {data: {b: 2}}),
      ).toThrowError(/'data' is defined both on the route and in the configuration loaded/);
    });

    it('should reject results that are not objects', () => {
      expect(() => assertValidLazyRouteConfig(route, [] as any)).toThrowError(
        /loadConfig must resolve to an object/,
      );
      expect(() => assertValidLazyRouteConfig(route, undefined as any)).toThrowError(
        /loadConfig must resolve to an object/,
      );
    });
  });

  describe('validateConfig', () => {
    it('should not throw when no errors', () => {
      expect(() =>
        validateConfig([
          {path: 'a', redirectTo: 'b'},
          {path: 'b', component: ComponentA},
        ]),
      ).not.toThrow();
    });

    it('should not throw for a route with loadConfig', () => {
      expect(() =>
        validateConfig([{path: 'a', loadConfig: () => ({component: ComponentA})}]),
      ).not.toThrow();
    });

    it('should not throw for a componentless named outlet route with loadConfig', () => {
      expect(() =>
        validateConfig([{path: 'a', outlet: 'aux', loadConfig: () => ({children: []})}]),
      ).not.toThrow();
    });

    it('should throw when loadConfig is used with redirectTo', () => {
      expect(() =>
        validateConfig([{path: 'a', redirectTo: 'b', loadConfig: () => ({})}]),
      ).toThrowError(/redirectTo and loadConfig cannot be used together/);
    });

    it('should not throw when a matcher is provided', () => {
      expect(() => validateConfig([{matcher: () => null, component: ComponentA}])).not.toThrow();
    });

    it('should throw for undefined route', () => {
      expect(() => {
        validateConfig([
          {path: 'a', component: ComponentA},
          ,
          {path: 'b', component: ComponentB},
        ] as Routes);
      }).toThrowError(/Invalid configuration of route ''/);
    });

    it('should throw for undefined route in children', () => {
      expect(() => {
        validateConfig([
          {
            path: 'a',
            children: [{path: 'b', component: ComponentB}, ,],
          },
        ] as Routes);
      }).toThrowError(/Invalid configuration of route 'a'/);
    });

    it('should throw when Array is passed', () => {
      expect(() => {
        validateConfig([
          {path: 'a', component: ComponentA},
          [
            {path: 'b', component: ComponentB},
            {path: 'c', component: ComponentC},
          ],
        ] as Routes);
      }).toThrowError();
    });

    it('should throw when redirectTo and children are used together', () => {
      expect(() => {
        validateConfig([
          {path: 'a', redirectTo: 'b', children: [{path: 'b', component: ComponentA}]},
        ]);
      }).toThrowError();
    });

    it('should validate children and report full path', () => {
      expect(() => validateConfig([{path: 'a', children: [{path: 'b'}]}])).toThrowError();
    });

    it('should properly report deeply nested path', () => {
      expect(() =>
        validateConfig([
          {path: 'a', children: [{path: 'b', children: [{path: 'c', children: [{path: 'd'}]}]}]},
        ]),
      ).toThrowError();
    });

    it('should throw when redirectTo and loadChildren are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', redirectTo: 'b', loadChildren: jasmine.createSpy('value')}]);
      }).toThrowError();
    });

    it('should throw when children and loadChildren are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', children: [], loadChildren: jasmine.createSpy('value')}]);
      }).toThrowError();
    });

    it('should throw when component and redirectTo are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', component: ComponentA, redirectTo: 'b'}]);
      }).toThrowError(
        new RegExp(
          `Invalid configuration of route 'a': redirectTo and component/loadComponent cannot be used together`,
        ),
      );
    });

    it('should throw when redirectTo and loadComponent are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', redirectTo: 'b', loadComponent: () => ComponentA}]);
      }).toThrowError();
    });

    it('should throw when component and loadComponent are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', component: ComponentA, loadComponent: () => ComponentA}]);
      }).toThrowError();
    });

    it('should throw when canActivate and redirectTo are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', redirectTo: 'b', canActivate: []}]);
      }).toThrowError();
    });

    it('should throw when path and matcher are used together', () => {
      expect(() => {
        validateConfig([{path: 'a', matcher: () => null, children: []}]);
      }).toThrowError();
    });

    it('should throw when path and matcher are missing', () => {
      expect(() => {
        validateConfig([{redirectTo: 'b'}]);
      }).toThrowError();
    });

    it('should throw when none of component and children or direct are missing', () => {
      expect(() => {
        validateConfig([{path: 'a'}]);
      }).toThrowError();
    });

    it('should throw when path starts with a slash', () => {
      expect(() => {
        validateConfig([{path: '/a', redirectTo: 'b'}]);
      }).toThrowError();
    });

    it('should throw when emptyPath is used with redirectTo without explicitly providing matching', () => {
      expect(() => {
        validateConfig([{path: '', redirectTo: 'b'}]);
      }).toThrowError(/Invalid configuration of route '{path: "", redirectTo: "b"}'/);
    });

    it('should throw when path/outlet combination is invalid', () => {
      expect(() => {
        validateConfig([{path: 'a', outlet: 'aux'}]);
      }).toThrowError(
        /Invalid configuration of route 'a': a componentless route without children or loadChildren cannot have a named outlet set/,
      );
      expect(() => validateConfig([{path: 'a', outlet: '', children: []}])).not.toThrow();
      expect(() =>
        validateConfig([{path: 'a', outlet: PRIMARY_OUTLET, children: []}]),
      ).not.toThrow();
    });

    it('should not throw when path/outlet combination is valid', () => {
      expect(() => {
        validateConfig([{path: 'a', outlet: 'aux', children: []}]);
      }).not.toThrow();
      expect(() => {
        validateConfig([{path: 'a', outlet: 'aux', loadChildren: jasmine.createSpy('child')}]);
      }).not.toThrow();
    });

    it('should not throw when outlet has redirectTo', () => {
      expect(() => {
        validateConfig([{path: '', pathMatch: 'prefix', outlet: 'aux', redirectTo: 'main'}]);
      }).not.toThrow();
    });
  });
});

class ComponentA {}
class ComponentB {}
class ComponentC {}
