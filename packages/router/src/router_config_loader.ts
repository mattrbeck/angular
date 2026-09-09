/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  Compiler,
  EnvironmentInjector,
  inject,
  InjectionToken,
  Injector,
  ɵmaybeUnwrapDefaultExport as maybeUnwrapDefaultExport,
  NgModuleFactory,
  ɵresolveComponentResources as resolveComponentResources,
  runInInjectionContext,
  Service,
  Type,
} from '@angular/core';

import {standardizeConfig} from './components/empty_outlet';
import {LazyRouteConfig, LoadedRouterConfig, Route, Routes} from './models';
import {wrapIntoPromise} from './utils/collection';
import {
  assertStandalone,
  assertValidLazyRouteConfig,
  getOrCreateRouteInjectorIfNeeded,
  validateConfig,
} from './utils/config';

/**
 * The DI token for a router configuration.
 *
 * `ROUTES` is a low level API for router configuration via dependency injection.
 *
 * We recommend that in almost all cases to use higher level APIs such as `RouterModule.forRoot()`,
 * `provideRouter`, or `Router.resetConfig()`.
 *
 * @publicApi
 */
export const ROUTES = new InjectionToken<Route[][]>(
  typeof ngDevMode !== 'undefined' && ngDevMode ? 'ROUTES' : '',
);

@Service()
export class RouterConfigLoader {
  private componentLoaders = new WeakMap<Route, Promise<Type<unknown>>>();
  private childrenLoaders = new WeakMap<Route, Promise<LoadedRouterConfig>>();
  private configLoaders = new WeakMap<Route, Promise<void>>();
  onLoadStartListener?: (r: Route) => void;
  onLoadEndListener?: (r: Route) => void;
  private readonly compiler = inject(Compiler);

  async loadComponent(injector: EnvironmentInjector, route: Route): Promise<Type<unknown>> {
    if (this.componentLoaders.get(route)) {
      return this.componentLoaders.get(route)!;
    } else if (route._loadedComponent) {
      return Promise.resolve(route._loadedComponent);
    }

    if (this.onLoadStartListener) {
      this.onLoadStartListener(route);
    }
    const loader = (async () => {
      try {
        const loaded = await wrapIntoPromise(
          runInInjectionContext(injector, () => route.loadComponent!()),
        );
        const component = await maybeResolveResources(maybeUnwrapDefaultExport(loaded));

        if (this.onLoadEndListener) {
          this.onLoadEndListener(route);
        }
        (typeof ngDevMode === 'undefined' || ngDevMode) &&
          assertStandalone(route.path ?? '', component);
        route._loadedComponent = component;
        return component;
      } finally {
        this.componentLoaders.delete(route);
      }
    })();
    this.componentLoaders.set(route, loader);
    return loader;
  }

  /**
   * Executes `route.loadConfig` and merges the result into the `route`.
   *
   * After this resolves, the `route` looks exactly like a statically configured route: the lazily
   * loaded `component`, `children`, guards, resolvers, etc. are all available directly on the
   * `Route` object and a providers injector is created if the loaded config has `providers`.
   */
  loadConfig(injector: EnvironmentInjector, route: Route): Promise<void> {
    if (this.configLoaders.get(route)) {
      return this.configLoaders.get(route)!;
    } else if (route._loadedConfig) {
      return Promise.resolve();
    }

    if (this.onLoadStartListener) {
      this.onLoadStartListener(route);
    }
    const loader = (async () => {
      try {
        const loaded = await wrapIntoPromise(
          runInInjectionContext(injector, () => route.loadConfig!()),
        );
        const config = await maybeResolveResources(maybeUnwrapDefaultExport(loaded));
        if (this.onLoadEndListener) {
          this.onLoadEndListener(route);
        }
        mergeLazyRouteConfig(route, config);
        // The loaded config may have `providers`. Create the route injector now so that it's
        // available for the rest of the navigation (child matching, guards, resolvers, etc.).
        getOrCreateRouteInjectorIfNeeded(route, injector);
      } finally {
        this.configLoaders.delete(route);
      }
    })();
    this.configLoaders.set(route, loader);
    return loader;
  }

  loadChildren(parentInjector: Injector, route: Route): Promise<LoadedRouterConfig> {
    if (this.childrenLoaders.get(route)) {
      return this.childrenLoaders.get(route)!;
    } else if (route._loadedRoutes) {
      return Promise.resolve({routes: route._loadedRoutes, injector: route._loadedInjector});
    }

    if (this.onLoadStartListener) {
      this.onLoadStartListener(route);
    }
    const loader = (async () => {
      try {
        const result = await loadChildren(
          route,
          this.compiler,
          parentInjector,
          this.onLoadEndListener,
        );
        route._loadedRoutes = result.routes;
        route._loadedInjector = result.injector;
        route._loadedNgModuleFactory = result.factory;
        return result;
      } finally {
        this.childrenLoaders.delete(route);
      }
    })();
    this.childrenLoaders.set(route, loader);
    return loader;
  }
}

/**
 * Executes a `route.loadChildren` callback and converts the result to an array of child routes and
 * an injector if that callback returned a module.
 *
 * This function is used for the route discovery during prerendering
 * in @angular-devkit/build-angular. If there are any updates to the contract here, it will require
 * an update to the extractor.
 */
export async function loadChildren(
  route: Route,
  compiler: Compiler,
  parentInjector: Injector,
  onLoadEndListener?: (r: Route) => void,
): Promise<LoadedRouterConfig> {
  const loaded = await wrapIntoPromise(
    runInInjectionContext(parentInjector, () => route.loadChildren!()),
  );
  const t = await maybeResolveResources(maybeUnwrapDefaultExport(loaded));

  let factoryOrRoutes: NgModuleFactory<any> | Routes;
  if (t instanceof NgModuleFactory || Array.isArray(t)) {
    factoryOrRoutes = t;
  } else {
    factoryOrRoutes = await compiler.compileModuleAsync(t);
  }

  if (onLoadEndListener) {
    onLoadEndListener(route);
  }
  // This injector comes from the `NgModuleRef` when lazy loading an `NgModule`. There is
  // no injector associated with lazy loading a `Route` array.
  let injector: EnvironmentInjector | undefined;
  let rawRoutes: Route[];
  let requireStandaloneComponents = false;
  let factory: NgModuleFactory<unknown> | undefined = undefined;
  if (Array.isArray(factoryOrRoutes)) {
    rawRoutes = factoryOrRoutes;
    requireStandaloneComponents = true;
  } else {
    injector = factoryOrRoutes.create(parentInjector).injector;
    factory = factoryOrRoutes;
    // When loading a module that doesn't provide `RouterModule.forChild()` preloader
    // will get stuck in an infinite loop. The child module's Injector will look to
    // its parent `Injector` when it doesn't find any ROUTES so it will return routes
    // for it's parent module instead.
    rawRoutes = injector.get(ROUTES, [], {optional: true, self: true}).flat();
  }
  const routes = rawRoutes.map(standardizeConfig);
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    validateConfig(routes, route.path, requireStandaloneComponents);
  return {routes, injector, factory};
}

/**
 * Merges the configuration returned from `route.loadConfig` into the `route` itself.
 *
 * The `route` is mutated in place so that its identity is preserved. Route identity matters for
 * route reuse, `ActivatedRoute.routeConfig` comparisons and the loader caches.
 */
function mergeLazyRouteConfig(route: Route, loaded: LazyRouteConfig): void {
  (typeof ngDevMode === 'undefined' || ngDevMode) && assertValidLazyRouteConfig(route, loaded);
  // `standardizeConfig` copies the loaded `children` so that the user's objects are not mutated by
  // the router and adds the empty outlet component for componentless named outlet routes.
  const merged = standardizeConfig({...route, ...loaded, _loadedConfig: loaded});
  // Lazily loaded components cannot be declared in an NgModule that the router knows about, so
  // they must be standalone (same as `loadComponent` and `loadChildren` with a `Routes` array).
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    validateConfig([merged], undefined, /* requireStandaloneComponents */ true);
  Object.assign(route, merged);
}

async function maybeResolveResources<T>(value: T): Promise<T> {
  // In JIT mode we usually resolve the resources of components on bootstrap, however
  // that won't have happened for lazy-loaded. Attempt to load any pending
  // resources again here.
  if ((typeof ngJitMode === 'undefined' || ngJitMode) && typeof fetch === 'function') {
    try {
      await resolveComponentResources(fetch);
    } catch (error) {
      console.error(error);
    }
  }

  return value;
}
