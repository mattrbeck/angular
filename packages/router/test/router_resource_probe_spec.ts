/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
// TEMPORARY exploration probes for router resources. Not intended to land.

import {
  Component,
  Injectable,
  Input,
  input,
  resource,
  Resource,
  ɵpromiseWithResolvers as promiseWithResolvers,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
  provideRouter,
  Router,
  withRouterResources,
  withComponentInputBinding,
  withRouterConfig,
  nonBlocking,
  ActivatedRoute,
  ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
  DetachedRouteHandle,
  RouteReuseStrategy,
  RouterOutlet,
  Route,
  RouterFeatures,
  ResourceContext,
  ResourceResult,
} from '@angular/router';
import {RouterTestingHarness} from '../testing';
import {timeout, useAutoTick} from '../../private/testing/src/utils';

async function setupRouter(routes: Route[], ...features: RouterFeatures[]) {
  TestBed.configureTestingModule({
    providers: [provideRouter(routes, ...features, withRouterResources())],
  });
  const harness = await RouterTestingHarness.create();
  const router = TestBed.inject(Router);
  return {harness, router};
}

type ActivatedRouteInternal = ActivatedRoute & {resources?: ResourceResult};

@Component({template: ''})
class TargetCmp {}

@Component({template: '<router-outlet />', imports: [RouterOutlet]})
class OutletCmp {}

@Component({template: 'user:{{user()?.name}}'})
class UserCmp {
  user = input<any>();
}

describe('PROBE router resources', () => {
  useAutoTick();

  // ===================== Issue 1: parent/child setup race =====================
  it('P1a: child sees parent resources at setup when parent setup is SYNC', async () => {
    let seen: ResourceResult | undefined = 'unset' as any;
    const {harness} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [
          {
            path: 'c',
            component: TargetCmp,
            resources: (ctx) => {
              seen = ctx.parent?.resources;
              return {};
            },
          },
        ],
      },
    ]);
    await harness.navigateByUrl('/p/c');
    expect(seen).toBeDefined();
    expect(seen && (seen as any)['user']).toBeDefined();
  });

  it('P1b: child sees parent resources at setup when parent setup is ASYNC', async () => {
    let seen: ResourceResult | undefined = 'unset' as any;
    const {harness} = await setupRouter([
      {
        path: 'p',
        resources: async () => {
          const user = nonBlocking(resource({loader: async () => 'u'}));
          await timeout(5);
          return {user};
        },
        children: [
          {
            path: 'c',
            component: TargetCmp,
            resources: (ctx) => {
              seen = ctx.parent?.resources;
              return {};
            },
          },
        ],
      },
    ]);
    await harness.navigateByUrl('/p/c');
    expect(seen).toBeDefined();
    expect(seen && (seen as any)['user']).toBeDefined();
  });

  it('P1c: new child under REUSED parent sees parent resources at setup', async () => {
    let seen: ResourceResult | undefined = 'unset' as any;
    const {harness} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [
          {path: 'a', component: TargetCmp},
          {
            path: 'b',
            component: TargetCmp,
            resources: (ctx) => {
              seen = ctx.parent?.resources;
              return {};
            },
          },
        ],
      },
    ]);
    await harness.navigateByUrl('/p/a');
    await harness.navigateByUrl('/p/b');
    expect(seen).toBeDefined();
    expect(seen && (seen as any)['user']).toBeDefined();
  });

  it('P1d: blocking child depending on parent via chain() keeps nav blocked until child resolves', async () => {
    const parent = promiseWithResolvers<any>();
    const child = promiseWithResolvers<any>();
    const {harness, router} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: resource({loader: () => parent.promise})}),
        children: [
          {
            path: 'c',
            component: TargetCmp,
            resources: (ctx) => {
              const user = ctx.parent!.resources['user'];
              return {
                details: resource({
                  params: ({chain}) => (chain(user) as any).role,
                  loader: () => child.promise,
                }),
              };
            },
          },
        ],
      },
    ]);
    const nav = harness.navigateByUrl('/p/c');
    await timeout(10);
    expect(router.url).not.toBe('/p/c');
    parent.resolve({role: 'admin'});
    await timeout(10);
    expect(router.url).withContext('after parent resolved, child still loading').not.toBe('/p/c');
    child.resolve('details');
    await nav;
    expect(router.url).toBe('/p/c');
  });

  it('P1e: blocking child depending on parent via naive .value() — does nav wait for child?', async () => {
    const parent = promiseWithResolvers<any>();
    const child = promiseWithResolvers<any>();
    const {harness, router} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: resource({loader: () => parent.promise})}),
        children: [
          {
            path: 'c',
            component: TargetCmp,
            resources: (ctx) => {
              const user = ctx.parent!.resources['user'];
              return {
                details: resource({
                  params: () => (user.hasValue() ? (user.value() as any).role : undefined),
                  loader: () => child.promise,
                }),
              };
            },
          },
        ],
      },
    ]);
    const nav = harness.navigateByUrl('/p/c');
    await timeout(10);
    expect(router.url).not.toBe('/p/c');
    parent.resolve({role: 'admin'});
    await timeout(10);
    expect(router.url).withContext('after parent resolved, child still loading').not.toBe('/p/c');
    child.resolve('details');
    await nav;
    expect(router.url).toBe('/p/c');
  });

  // ===================== Issue 2: inheritance =====================
  it('P2a: empty-path child inherits parent resources on ActivatedRoute & snapshot', async () => {
    const {harness, router} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [{path: '', component: TargetCmp}],
      },
    ]);
    await harness.navigateByUrl('/p');
    const childRoute = router.routerState.root.firstChild!.firstChild as ActivatedRouteInternal;
    expect(childRoute.routeConfig?.path).toBe('');
    expect(childRoute.resources?.['user']).withContext('ActivatedRoute.resources').toBeDefined();
    expect(childRoute.snapshot.resources?.['user'])
      .withContext('ActivatedRouteSnapshot.resources')
      .toBeDefined();
  });

  it('P2b: child under componentless parent inherits parent resources', async () => {
    const {harness, router} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [{path: 'c', component: TargetCmp}],
      },
    ]);
    await harness.navigateByUrl('/p/c');
    const childRoute = router.routerState.root.firstChild!.firstChild as ActivatedRouteInternal;
    expect(childRoute.resources?.['user']).withContext('ActivatedRoute.resources').toBeDefined();
  });

  it('P2c: component input binding on child gets parent BLOCKING resource value', async () => {
    @Component({template: '', standalone: false})
    class DecCmp {
      @Input() user?: any;
    }
    const {harness} = await setupRouter(
      [
        {
          path: 'p',
          resources: () => ({user: resource({loader: async () => ({name: 'Ann'})})}),
          children: [{path: '', component: DecCmp}],
        },
      ],
      withComponentInputBinding(),
    );
    const instance = await harness.navigateByUrl('/p', DecCmp);
    await harness.fixture.whenStable();
    expect(instance.user).toEqual({name: 'Ann'});
  });

  it('P1f: docs pattern - resource() created AFTER an await without ctx.injector throws NG0203', async () => {
    const {harness} = await setupRouter([
      {
        path: 't',
        component: TargetCmp,
        resources: async (ctx) => {
          await Promise.resolve();
          return {data: nonBlocking(resource({loader: async () => 'x'}))};
        },
      },
    ]);
    await expectAsync(harness.navigateByUrl('/t')).toBeRejectedWithError(/NG0203/);
  });

  it('P2e: resolver inheritance with decorator input', async () => {
    @Component({template: '', standalone: false})
    class DecCmp {
      @Input() user?: any;
    }
    const {harness} = await setupRouter(
      [
        {
          path: 'p',
          resolve: {user: () => ({name: 'Ann'})},
          children: [{path: '', component: DecCmp}],
        },
      ],
      withComponentInputBinding(),
    );
    const instance = await harness.navigateByUrl('/p', DecCmp);
    expect(instance.user).toEqual({name: 'Ann'});
  });

  // ===================== Issue 3: snapshot in context =====================
  it('P3a: async setup can create resources after an await via ctx.injector', async () => {
    const {harness, router} = await setupRouter([
      {
        path: 't',
        component: TargetCmp,
        resources: async (ctx) => {
          await Promise.resolve();
          return {data: nonBlocking(resource({injector: ctx.injector, loader: async () => 'x'}))};
        },
      },
    ]);
    await harness.navigateByUrl('/t');
    expect(router.url).toBe('/t');
    const route = router.routerState.root.firstChild as ActivatedRouteInternal;
    await harness.fixture.whenStable();
    expect(route.resources?.['data'].value()).toBe('x');
  });

  it('P3b: ctx.resources is the same object as ActivatedRoute.resources and contains inherited + own', async () => {
    let childCtx: ResourceContext | undefined;
    let keysAtSetup: string[] = [];
    const {harness, router} = await setupRouter([
      {
        path: 'p',
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [
          {
            path: '',
            component: TargetCmp,
            resources: (ctx) => {
              childCtx = ctx;
              keysAtSetup = Object.keys(ctx.resources);
              return {extra: nonBlocking(resource({loader: async () => 'e'}))};
            },
          },
        ],
      },
    ]);
    await harness.navigateByUrl('/p');
    const child = router.routerState.root.firstChild!.firstChild as ActivatedRouteInternal;
    expect(keysAtSetup).toEqual(['user']);
    expect(childCtx!.resources).toBe(child.resources!);
    expect(Object.keys(child.resources!)).toEqual(['user', 'extra']);
    expect(child.snapshot.resources).toBe(child.resources!);
  });

  it('P2f: with emptyOnly strategy, a non-empty child under a component parent does NOT inherit', async () => {
    const {harness, router} = await setupRouter(
      [
        {
          path: 'p',
          component: TargetCmp,
          resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
          children: [{path: 'c', component: TargetCmp}],
        },
      ],
      withRouterConfig({paramsInheritanceStrategy: 'emptyOnly'}),
    );
    await harness.navigateByUrl('/p/c');
    const child = router.routerState.root.firstChild!.firstChild as ActivatedRouteInternal;
    expect(child.resources?.['user']).toBeUndefined();
    expect(child.parent!.resources?.['user']).toBeDefined();
  });

  it("P4: re-attached child under a NEW parent gets the new parent's inherited resources", async () => {
    @Injectable({providedIn: 'root'})
    class DetachChildStrategy extends BaseRouteReuseStrategy {
      handles = new Map<Route, DetachedRouteHandle>();
      override shouldDetach(route: ActivatedRouteSnapshot) {
        return route.routeConfig?.path === '';
      }
      override store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null) {
        if (route.routeConfig && handle) this.handles.set(route.routeConfig, handle);
      }
      override shouldAttach(route: ActivatedRouteSnapshot) {
        return !!route.routeConfig && this.handles.has(route.routeConfig);
      }
      override retrieve(route: ActivatedRouteSnapshot) {
        return (route.routeConfig && this.handles.get(route.routeConfig)) || null;
      }
    }
    TestBed.configureTestingModule({
      providers: [{provide: RouteReuseStrategy, useExisting: DetachChildStrategy}],
    });
    const {harness, router} = await setupRouter([
      {
        path: 'a',
        component: OutletCmp,
        resources: () => ({user: nonBlocking(resource({loader: async () => 'u'}))}),
        children: [{path: '', component: TargetCmp}],
      },
      {path: 'b', component: TargetCmp},
    ]);
    await harness.navigateByUrl('/a');
    const a1 = router.routerState.root.firstChild as ActivatedRouteInternal;
    const child1 = a1.firstChild as ActivatedRouteInternal;
    const oldUser = a1.resources!['user'];
    expect(child1.resources!['user']).toBe(oldUser);

    await harness.navigateByUrl('/b');
    await harness.navigateByUrl('/a');
    const a2 = router.routerState.root.firstChild as ActivatedRouteInternal;
    const child2 = a2.firstChild as ActivatedRouteInternal;
    expect(a2).not.toBe(a1);
    expect(child2).withContext('child re-attached').toBe(child1);
    expect(a2.resources!['user']).not.toBe(oldUser);
    expect(child2.resources!['user'])
      .withContext('inherited from NEW parent')
      .toBe(a2.resources!['user']);
    expect(child2.resources).withContext('map identity stable').toBe(child1.resources);
  });
});
