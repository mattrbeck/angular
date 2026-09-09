/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {
  createEnvironmentInjector,
  runInInjectionContext,
  Resource,
  effect,
  DestroyRef,
  EnvironmentInjector,
} from '@angular/core';
import {OperatorFunction, pipe} from 'rxjs';
import {ResourceContext, ResourceResult} from '../models';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRoute, initializeActivatedRoute, ParamsInheritanceStrategy} from '../router_state';
import {TreeNode} from '../utils/tree';
import {
  BLOCKING_SYMBOL,
  InternalRouterResource,
  routerResource,
  SOURCE_RESOURCE_SYMBOL,
} from '../router_resource';
import {switchTap} from './switch_tap';

export function setupAndRunResources(
  abortSignal: AbortSignal,
  paramsInheritanceStrategy: ParamsInheritanceStrategy,
): OperatorFunction<NavigationTransition, NavigationTransition> {
  return pipe(
    switchTap(({newlyCreatedRoutes, targetRouterState}) => {
      if (!newlyCreatedRoutes || !targetRouterState || abortSignal.aborted) {
        return;
      }

      const blockingResources: BlockingEntry[] = [];

      // Routes are set up parent-first: a route's `resources` function only runs once its
      // parent's has completed (including an async parent). Siblings and separate branches still
      // run concurrently, and resource *loading* is not serialized, only setup.
      const setupTree = async (
        stateNode: TreeNode<ActivatedRoute>,
        parent: ActivatedRoute | null,
      ): Promise<void> => {
        const route = stateNode.value;
        initializeActivatedRoute(route);
        ensureResourceContext(route, parent, paramsInheritanceStrategy);

        if (newlyCreatedRoutes.has(route)) {
          await setupNewRouterResources(route, abortSignal, blockingResources);
        } else {
          updateExistingResources(route, blockingResources);
        }
        if (abortSignal.aborted) {
          return;
        }
        await Promise.all(stateNode.children.map((child) => setupTree(child, route)));
      };

      const rootInjector = targetRouterState._root.value._futureSnapshot._environmentInjector;
      return setupTree(targetRouterState._root, null).then(() =>
        waitForBlockingResources(blockingResources, rootInjector, abortSignal),
      );
    }),
  );
}

/**
 * Creates the `ResourceContext` for a route the first time the route is seen. The context (and
 * the `resources` map it carries) lives as long as the `ActivatedRoute` does.
 *
 * Resources are inherited from the parent following `paramsInheritanceStrategy`, with the same
 * rules used for `params` and `data` in `getInherited`.
 */
function ensureResourceContext(
  route: ActivatedRoute,
  parent: ActivatedRoute | null,
  paramsInheritanceStrategy: ParamsInheritanceStrategy,
): ResourceContext {
  const parentContext = parent?._resourceContext ?? null;
  const inherits =
    parent !== null &&
    parentContext !== null &&
    (paramsInheritanceStrategy === 'always' ||
      route.routeConfig?.path === '' ||
      (!parent.component && !parent.routeConfig?.loadComponent));
  const inherited = inherits ? parentContext.resources : {};

  const existing = route._resourceContext;
  if (existing) {
    if (existing.parent !== parentContext) {
      // The route was re-attached (RouteReuseStrategy) under a different parent instance whose
      // resources may differ from the ones this route inherited before. Recompute the inherited
      // entries in place so the map's identity stays stable.
      for (const key of Object.keys(existing.resources)) {
        delete existing.resources[key];
      }
      Object.assign(existing.resources, inherited, route._ownResources);
      existing.parent = parentContext;
    }
    return existing;
  }

  // Note: this object is mutated exactly once, when the route's own resources are added after its
  // `resources` function returns. Its identity is stable afterwards (see the note on
  // `ActivatedRoute.resources`).
  const resources: ResourceResult = {...inherited};

  const context: ResourceContext = {
    params: route.paramsSignal,
    queryParams: route.queryParamsSignal,
    fragment: route.fragmentSignal,
    data: route.dataSignal,
    resources,
    parent: parentContext,
    get injector(): EnvironmentInjector {
      return getOrCreateLocalInjector(route);
    },
  };

  route._resourceContext = context;
  route.resources = resources;
  return context;
}

function getOrCreateLocalInjector(route: ActivatedRoute): EnvironmentInjector {
  if (!route._localInjector) {
    const parentInjector = route._futureSnapshot._environmentInjector;
    route._localInjector = createEnvironmentInjector([], parentInjector);
  }
  return route._localInjector;
}

interface BlockingEntry {
  route: ActivatedRoute;
  resource: InternalRouterResource;
}

async function setupNewRouterResources(
  route: ActivatedRoute,
  abortSignal: AbortSignal,
  blockingResources: BlockingEntry[],
) {
  const context = route._resourceContext!;
  const resourcesFn = route.routeConfig?.resources;
  if (!resourcesFn) {
    // Nothing of its own, but the route may still carry inherited resources.
    route._futureSnapshot.resources = route.resources;
    return;
  }

  const childInjector = context.injector as EnvironmentInjector;

  const resourceResultRaw = runInInjectionContext(childInjector, () => resourcesFn(context));
  let resourceResult: ResourceResult;
  if (resourceResultRaw instanceof Promise) {
    resourceResult = await resourceResultRaw;
    // Bail out if the router cancelled the navigation (and destroyed our injector!)
    // while we were waiting.
    if (abortSignal.aborted) return;
  } else {
    resourceResult = resourceResultRaw as ResourceResult;
  }

  if (!resourceResult) return;

  const ownResources: ResourceResult = {};
  for (const [key, res] of Object.entries(resourceResult)) {
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      if (
        !res ||
        typeof res !== 'object' ||
        typeof (res as Partial<Resource<unknown>>).snapshot !== 'function'
      ) {
        throw new Error(
          `Invalid resource returned for key "${key}". Expected a Resource, but got ${res === null ? 'null' : typeof res}.`,
        );
      }
    }

    ownResources[key] = runInInjectionContext(childInjector, () => routerResource(res));
  }

  // Own resources override inherited ones with the same key, like `data`.
  Object.assign(context.resources, ownResources);
  route._ownResources = ownResources;
  route._futureSnapshot.resources = route.resources;
  collectBlocking(route, ownResources, blockingResources);
}

function updateExistingResources(route: ActivatedRoute, blockingResources: BlockingEntry[]) {
  // This route is reused. The context signals are already updated (pending) so that resources
  // can react and fetch new data during the pending navigation.
  route._futureSnapshot.resources = route.resources;
  const ownResources = route._ownResources;
  if (!ownResources) {
    return;
  }

  // Only this route's own resources are retried and awaited; inherited ones are handled by the
  // route that owns them.
  Object.values(ownResources).forEach((r) => {
    const underlyingRes = (r as InternalRouterResource)[SOURCE_RESOURCE_SYMBOL];
    if (underlyingRes.status() === 'error') {
      // If a resource previously failed and the route is reused identically,
      // the parameter signals won't change, meaning the internal effect won't automatically refetch.
      // We must manually trigger a reload to ensure the new navigation attempts a retry.
      (underlyingRes as unknown as {reload?: () => boolean}).reload?.();
    }
  });

  collectBlocking(route, ownResources, blockingResources);
}

function collectBlocking(
  route: ActivatedRoute,
  resourceResult: ResourceResult,
  blockingResources: BlockingEntry[],
) {
  for (const r of Object.values(resourceResult)) {
    const resource = r as InternalRouterResource;
    if (resource[BLOCKING_SYMBOL] !== false) {
      blockingResources.push({route, resource});
    }
  }
}

/**
 * Resolves once no blocking resource in the target state is loading, or rejects with the first
 * resource error.
 *
 * All blocking resources are observed together in a single effect rather than one promise per
 * resource. This matters for dependent resources: when a parent resource resolves, a child whose
 * `params` derive from it flips from `idle` to `loading` in the same reactive propagation. Checking
 * the whole set again at that point keeps the navigation blocked on the child, whereas a
 * per-resource promise for the child would already have resolved while it was idle.
 */
function waitForBlockingResources(
  entries: BlockingEntry[],
  injector: EnvironmentInjector,
  abortSignal: AbortSignal,
): Promise<void> {
  if (entries.length === 0 || abortSignal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const unregisterOnDestroy: Array<() => void> = [];

    const cleanup = () => {
      settled = true;
      blockingEffect.destroy();
      unregisterOnDestroy.forEach((fn) => fn());
      abortSignal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    abortSignal.addEventListener('abort', onAbort, {once: true});

    const blockingEffect = effect(
      () => {
        if (settled) {
          return;
        }
        let anyLoading = false;
        for (const {resource} of entries) {
          const underlyingRes = resource[SOURCE_RESOURCE_SYMBOL];
          if (underlyingRes.status() === 'error') {
            cleanup();
            reject(underlyingRes.error());
            return;
          }
          anyLoading ||= underlyingRes.isLoading();
        }
        if (!anyLoading) {
          cleanup();
          resolve();
        }
      },
      {injector, manualCleanup: true},
    );

    // If any owning route's injector is destroyed while waiting, stop waiting.
    for (const {route} of entries) {
      const localInjector = route._localInjector;
      if (localInjector) {
        unregisterOnDestroy.push(
          localInjector.get(DestroyRef).onDestroy(() => {
            if (!settled) {
              cleanup();
              resolve();
            }
          }),
        );
      }
    }
  });
}
