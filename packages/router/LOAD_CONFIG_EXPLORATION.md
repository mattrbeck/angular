# Exploration: `Route.loadConfig`

This branch implements a `loadConfig` option on the Angular `Route`, modelled on
TanStack Router's `createLazyFileRoute` / React Router's `route.lazy`, in order to
answer three questions:

1. Would it be useful?
2. How would it work?
3. Is it any better than `loadChildren` returning an empty-path route that holds
   the "lazy config"?

## What was built

`Route.loadConfig` lazily loads everything on a route except what URL matching
needs. The static route keeps `path`, `matcher`, `pathMatch`, `outlet`,
`redirectTo`, `canMatch` and `canLoad`. The loaded object (typed as
`LazyRouteConfig`, usable with `satisfies`) may contain `component`,
`loadComponent`, `children`, `loadChildren`, `canActivate`, `canActivateChild`,
`canDeactivate`, `resolve`, `resources`, `data`, `title`, `providers` and
`runGuardsAndResolvers`.

```ts
// app.routes.ts
export const routes: Routes = [
  {
    path: 'admin/:id',
    canMatch: [isAdminUser],
    loadConfig: () => import('./admin/admin.config'),
  },
];

// admin/admin.config.ts
export default {
  component: AdminComponent,
  canActivate: [adminGuard],
  resolve: {user: userResolver},
  providers: [AdminService],
  children: [{path: 'settings', component: AdminSettingsComponent}],
} satisfies LazyRouteConfig;
```

Mechanics, in roughly 120 lines of runtime code:

- **Hook point.** `Recognizer.matchSegmentAgainstRoute` calls
  `RouterConfigLoader.loadConfig` right after the route's `canMatch` guards pass
  and before child matching. A rejected match never downloads the chunk.
- **Merge in place.** The loaded object is run through `standardizeConfig`,
  validated, and `Object.assign`ed onto the `Route`. After that, every
  downstream reader of `route.children`, `route.canActivate`, etc. works
  untouched. This is what keeps the change small.
- **Providers.** If the loaded config has `providers`, the route injector is
  created immediately so child matching, guards and resolvers see it. The
  loader itself runs in the injection context of the static route.
- **Preloader.** `RouterPreloader` loads the config first, then preloads
  whatever the loaded config contains (`children`, `loadChildren`,
  `loadComponent`).
- **Dev-mode validation.** Errors for matching properties inside the lazy
  object, for redefining a property already set statically, for
  non-standalone components, and for a loaded config with nothing to render.
- **Events.** Reuses `RouteConfigLoadStart` / `RouteConfigLoadEnd`.

Files touched: `src/models.ts`, `src/router_config_loader.ts`,
`src/recognize.ts`, `src/router_preloader.ts`, `src/utils/config.ts`,
`src/index.ts`, the public API golden, tests in `test/config.spec.ts`,
`test/router_preloader.spec.ts` and `test/integration/lazy_loading.spec.ts`,
and a section in `adev/src/content/guide/routing/loading-strategies.md`.

Verification: `//packages/router/test:test` (1203 specs), `//packages/router:router_api`
and `//packages/router:router_errors` all pass.

## Is it useful? Mostly sugar, with one real difference

The bundle-size outcome is identical to the workaround:

```ts
{
  path: 'admin/:id',
  canMatch: [isAdminUser],
  loadChildren: () => import('./admin/admin.routes'), // [{path: '', component, canActivate, ...}]
}
```

Both put the same code in the same chunk. What differs is tree shape and
ergonomics.

### Where the workaround is genuinely worse

- **An extra `ActivatedRoute` node.** Params and data still inherit correctly
  under the default `emptyOnly` strategy, but `ActivatedRoute.parent`,
  `pathFromRoot`, DevTools, and custom `RouteReuseStrategy` logic all see a
  phantom level whose `routeConfig.path` is `''`. The integration test asserts
  that with `loadConfig` the child's parent is the `lazy/:id` route itself.
- **Empty-path routes are the router's most bug-prone corner.** Named outlets,
  `mergeEmptyPathMatches`, `pathMatch: 'full'` interplay, and the
  `ɵEmptyOutletComponent` wrapper element all come from empty-path handling.
  `loadConfig` adds none of that.
- **Typed authoring.** A `satisfies LazyRouteConfig` file is closer to
  TanStack's `createLazyFileRoute` or React Router's `route.lazy` than an
  untyped "wrap everything in `[{path: ''}]`" convention.

### Where the workaround is strictly more expressive

- The loaded children are full routes, so they can carry `canMatch`,
  `matcher`, `redirectTo`, or several empty-path alternatives. `loadConfig`
  cannot lazily load anything that participates in matching, by construction.

### Real costs of adding it

- **A third overlapping primitive.** Docs have to explain `loadComponent` vs
  `loadChildren` vs `loadConfig`.
- **The ecosystem must learn it.** The comment in `router_config_loader.ts`
  notes that the `loadChildren` contract is consumed by prerender route
  discovery in `@angular/ssr`. That extractor, DevTools' route tree, and any
  schematic that walks `Route` objects would silently miss children hidden
  behind `loadConfig` until updated.
- **In-place mutation.** `router.config` changes shape after the first match.
  The router already mutates routes with private `_loaded*` fields, but
  `component` and `children` appearing later is more visible. The alternative,
  routing every property read through an accessor, is far more invasive.
- **Small semantic corners.** `canLoad` is ignored for `loadConfig` (only
  `canMatch` gates it), and a route with both `loadConfig` and a lazy
  `loadComponent` emits two `RouteConfigLoadStart` / `End` pairs.

## Recommendation

It is cheap and clean enough to ship if the team wants "one lazy chunk per
route" as a first-class idea, and the tree-shape difference is a real, if
modest, correctness benefit. If not, the honest answer is to document the
`loadChildren` + empty-path pattern and move on.
