# PostCSS-based style encapsulation: findings and status

_Last updated: 2026-07-16_

## Summary

`packages/compiler/src/style_encapsulation.ts` is a PostCSS plugin for emulated
style encapsulation shared with ACX. An `isAngular` option makes it reproduce
Angular's `ShadowCss` behavior (attribute selectors, `:host`/`:host-context`
conversion, `::ng-deep`, keyframes scoping, etc.), verified against the entire
`shadow_css` test suite via a semantic CSS comparison: **250 of 254 valid
harvested inputs produce semantically equivalent output**; the remaining 4 are
deliberate, documented divergences (see below).

Stylesheets opt in per component with a `/*! use-postcss-encapsulation */`
marker comment, routed at the `compileStyles()`/`encapsulateStyle()` seam in
`render3/view/compiler.ts`. AOT and JIT share that code path, so behavior is
identical in both modes.

## Bundle size and dependency cost

Measured with `esbuild --bundle --minify` (postcss 8.5.16,
postcss-selector-parser 7.1.4):

| artifact                                   | minified    | gzip       |
| ------------------------------------------ | ----------- | ---------- |
| plugin + postcss + postcss-selector-parser | 123 KB      | 35 KB      |
| `shadow_css.ts` alone                      | 9 KB        | 3.8 KB     |
| **net cost over ShadowCss**                | **+114 KB** | **+31 KB** |
| postcss-safe-parser (error tolerance)      | +2.4 KB     |            |

This cost applies to any bundle carrying the JIT compiler (`@angular/compiler`
in the browser). Both packages bundle cleanly for browsers with no Node shims.
New transitive npm dependencies: postcss (nanoid, picocolors, source-map-js),
postcss-selector-parser (cssesc, util-deprecate), postcss-safe-parser (none).
Note that `@angular/compiler` previously had no runtime dependencies besides
tslib.

## Performance

Median of warm runs (Node 24, Apple Silicon). `pc-safe` = with
postcss-safe-parser.

| shape                   | bytes | ShadowCss | postcss  | pc-safe  | ratio |
| ----------------------- | ----- | --------- | -------- | -------- | ----- |
| simple 2KB              | 2.0K  | 0.22 ms   | 0.89 ms  | 0.49 ms  | 4.1x  |
| complex-selectors 2KB   | 1.9K  | 0.67 ms   | 2.02 ms  | 2.13 ms  | 3.0x  |
| keyframes 2KB           | 2.0K  | 0.52 ms   | 0.39 ms  | 0.36 ms  | 0.8x  |
| media-nested 2KB        | 2.0K  | 0.27 ms   | 0.52 ms  | 0.53 ms  | 1.9x  |
| declaration-heavy 2KB   | 1.9K  | 0.11 ms   | 0.16 ms  | 0.17 ms  | 1.5x  |
| simple 200KB            | 209K  | 17.2 ms   | 55.9 ms  | 49.8 ms  | 3.2x  |
| complex-selectors 200KB | 204K  | 37.1 ms   | 181.2 ms | 177.8 ms | 4.9x  |
| keyframes 200KB         | 206K  | 17.4 ms   | 33.9 ms  | 32.0 ms  | 2.0x  |
| media-nested 200KB      | 209K  | 23.1 ms   | 50.5 ms  | 52.6 ms  | 2.2x  |
| declaration-heavy 200KB | 202K  | 10.9 ms   | 12.7 ms  | 15.7 ms  | 1.2x  |
| Material prebuilt theme | 111K  | 5.8 ms    | 6.6 ms   | 6.5 ms   | 1.1x  |

Takeaways: worst case is ~5x on pathologically selector-dense CSS (the
selector parser dominates); declaration-dominated real-world CSS is near
parity. A typical component stylesheet (≤2 KB) costs well under 2 ms absolute.
AOT build impact is negligible; JIT dev-mode with hundreds of components is
the scenario to keep an eye on. The safe parser adds no measurable overhead.

## Invalid CSS policy

The parser is a per-invocation postcss option, so the policy is chosen at the
call site without touching the shared plugin: Angular's adapter
(`style_encapsulation_shim.ts`) uses postcss-safe-parser while ACX keeps the
standard strict parser.

With the safe parser, invalid-CSS behavior matches ShadowCss remarkably well:
recovery stashes unparseable text in raws rather than inventing rules, so the
valid parts are shimmed and the garbage passes through byte-identically to
ShadowCss (verified for the corpus, e.g. `one {color: red;}garbage` →
`one[contenta] {color: red;}garbage`). One difference: unclosed blocks are
auto-closed (`div { color: red` gains a trailing `}`).

A stricter long-term option: the strict parser produces exact line/column
diagnostics, which would be a real DX improvement over today's silent
passthrough — a possible follow-up once adoption is complete.

## Sourcemap / line fidelity

The property Angular relies on is that shimming never shifts line numbers, so
sourcemaps produced by earlier tooling (Sass, etc.) remain valid. Measured
over the 271-input corpus plus synthetic multi-line inputs:

- **The plugin preserves line counts on 270/271 inputs.** The single gap:
  multi-line selectors that are structurally rebuilt during `:host`-inside-
  `:not()` conversion collapse their internal newlines (shifting subsequent
  rules up). Rare shape; fixable by carrying whitespace raws through the
  conversion.
- **ShadowCss itself changes line counts on 21/271 inputs — every one caused
  by the `.trim()` at the end of `_scopeCssText`.** Any stylesheet starting
  with newlines (common for template-literal `styles:` arrays) has all of its
  line mappings shifted up today. The plugin preserves leading/trailing
  whitespace exactly.
- Comment handling (kept sourceMappingURL comments, newline-preserving removal
  of other comments) is byte-identical between the two implementations.

Net: the plugin slightly _improves_ sourcemap fidelity relative to ShadowCss.

## Nested CSS

Angular's support today is essentially nonexistent. `ShadowCss.processRules`
escapes every `{...}` body into an opaque `%BLOCK%` placeholder and only
descends into a hardcoded at-rule allowlist (`@media`, `@supports`,
`@container`, `@scope`, `@starting-style`, `@layer`, `@document`).
Consequences:

- Nested rule selectors are never scoped: `.a { .b { } }` →
  `.a[contenta] { .b { } }`. This "works" only because nested selectors are
  implicitly relative to the scoped parent — but it silently matches
  _projected content and dynamically-inserted elements_, which don't carry
  the scoping attribute, i.e. nested selectors have weaker encapsulation than
  top-level ones.
- Selectors inside _unknown_ at-rules are likewise left unscoped.
- **Bug:** `@keyframes` declared inside `@media`/`@supports` are never
  name-scoped, so keyframe names leak between components for responsive
  animations.

The postcss plugin scopes nested selectors and nested keyframes (its at-rule
handling is structural rather than an allowlist). Whether scope-everything is
the desired nesting semantics is deliberately left open; there is no existing
ShadowCss behavior to preserve beyond "leave nested bodies alone."

## Known divergences from ShadowCss

Asserted in `style_encapsulation_spec.ts` ("known divergences" block):

1. Degenerate `:host-context` inputs where ShadowCss's regex mangling emits
   accidental artifacts — doubled host markers (`.one[hosta][hosta]`, changes
   only specificity) or dangling bare `:host-context` prefixes (match
   nothing). The plugin emits cleaner selectors matching the same elements.
2. Hex escapes terminated by a space (`.\fc ker`): postcss follows the CSS
   spec (the space is part of the escape); ShadowCss splits into two
   selectors when the next character isn't a hex digit.
3. Unclosed blocks are auto-closed by the safe parser (see above).
4. Nested CSS / unknown at-rules (see above).

## Testing approach

- `toEqualCss` in the shadow_css suite compares canonicalized CSS via
  `semantic_css.ts`, a purpose-built ~230-line selector-equivalence
  comparator (distilled from the general `semantic_css_diff` tool). It
  normalizes exactly the degrees of freedom on which two correct
  encapsulation implementations may differ: whitespace, ordering of simple
  selectors within a compound, ordering/duplicates in selector lists,
  `:is()/:where()/:not()/:has()` argument order, and at-rule prelude
  whitespace. It deliberately preserves declaration values, rule order, and
  empty rules (most fixtures are empty-bodied; removing empty rules would
  make any two compare equal regardless of their selectors).
- A differential harness harvests every CSS string literal from the
  shadow_css specs, runs both implementations, and compares canonical forms;
  this drove the porting work and is how equivalence claims here were
  measured.

## Adoption mechanism

Components opt in per component with `encapsulation:
ViewEncapsulation.Emulated2` (experimental, value `5`). Routing happens in
`compileStyles()`/`encapsulateStyle()` (`render3/view/compiler.ts`). At
runtime `Emulated2` behaves exactly like `Emulated` (same scoping
attributes; `EmulatedEncapsulationDomRenderer2` handles both), only the
compile-time shimming differs. Migration completion is a codemod flipping
`Emulated2` back to `Emulated` (or making it the `Emulated` behavior) plus
deleting the routing branch.

An earlier iteration used a `/*! use-postcss-encapsulation */` marker
comment in the stylesheet to avoid public API changes, but build tooling may
strip comments before the compiler sees styles, making the comment an
unreliable signal; the enum is authoritative. The `ViewEncapsulation` enum
is mirrored in four places that must stay in sync: `core/src/metadata/view.ts`,
`compiler/src/core.ts`, and the two `compiler_facade_interface.ts` copies.

The compiler references the implementation through a postcss-free registry
(`style_encapsulation_registry.ts`); loading
`style_encapsulation_shim.ts` registers it as a side effect, and compiling a
marked stylesheet without it loaded throws an actionable error. This
indirection is required because putting postcss into the module graph of
`@angular/compiler` broke every web-test bundle in this repo: the bazel
esbuild sandbox plugin (`aspect_rules_esbuild`) cannot round-trip
resolutions that postcss's `browser` field maps to `false` (`path`, `url`,
`fs`), failing bundles at build time. Real-world bundlers handle the browser
field correctly (verified with stock esbuild), so this is a repo-tooling
limitation, not a browser incompatibility.

**Open packaging decision:** how the shim gets loaded in production. AOT
needs compiler-cli to load it (a deep `@angular/compiler/src/...` import
works for bazel source builds but not for published fesm-only artifacts);
JIT needs it in the browser bundle. The likely answer is a secondary entry
point of `@angular/compiler` (note `ng_package` currently sets
`use_no_sub = True`), imported by compiler-cli and — for JIT apps — by the
application. Until then, the node test suites load it explicitly.

## Open items

- Packaging/loading of the shim for AOT (compiler-cli) and JIT (see above).
- Line fidelity of rebuilt multi-line selectors (single known gap above).
- Nesting semantics decision (scope-everything vs ShadowCss's leave-alone).
- Strict-parser diagnostics as a post-adoption follow-up.
- `namespaceCssVariables` remains a separate, untouched pass.
- ACX `legacy` mode is orthogonal to `isAngular` and not exercised by the
  Angular tests.
- Upstreaming to the shared ACX source: the `isAngular` flag itself, the
  bare-`:host-context` crash guard, `:host-context(a, b)` comma-list support
  (ACX currently drops all but the first argument), and comment newline
  preservation.
