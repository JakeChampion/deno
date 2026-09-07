# Import Map Hot Reload - implementation plan

Make the import map Deno resolved at startup invalidatable at runtime,
regenerated from its source on demand, and exposed to user code only through a
`Deno[Deno.internal]` method.

- Branch: `jake/import-map`
- Base: `main` @ 5d5600f8b4
- Date: 2026-08-25
- Status: implemented on this branch (see "Implementation status" below)

Line references were read from the working tree on the date above; deno_graph
0.110.1 and import_map 0.25.0 references are to the cargo registry sources.

## Motivating use case

Netlify Edge Functions run Deno inside a Unikraft Firecracker MicroVM, where
booting Deno costs hundreds of milliseconds. The goal is to snapshot the MicroVM
after Deno and the bootstrap have started but before any customer-specific file
has been read, then resume per site, make the site's bundle visible, reload the
import map, and import the customer's functions.

How production works today (`edge-functions-bootstrap`,
`runtimes/launcher/main.go`):

- The launcher overlays the function ROM on top of the platform ROM at
  `/platform` and execs
  `deno run --no-check --no-prompt --cached-only --config=/platform/deno.json --vendor --allow-read=/ ... /platform/platform/bootstrap/index-dynamic.ts`
  with cwd `/platform`.
- `/platform/deno.json` comes from the customer bundle. edge-bundler's tarball
  format (`packages/edge-bundler/node/formats/tarball.ts`) writes it as the
  import map itself: inline `imports`/`scopes`, including the `netlify:edge`
  internal entries and the `.netlify-npm-vendor/` prefixes. There is no separate
  import map file and no `importMap` reference.
- `index-dynamic.ts` imports `/platform/___netlify-edge-functions.json` (the
  bundle manifest) at module top level, then dynamically imports each function
  file, either at boot (when the ROM carries env vars) or on first request.

Consequences for the design:

- The reload must re-read inline `imports` from `deno.json`; that is why D2 was
  widened (see Implementation status). A placeholder `/platform/deno.json` has
  to exist at boot because `--config` is loaded eagerly; the customer's file
  then replaces it at the same path before `reloadImportMap()`.
- The V8 "frozen import edges" limit does not apply, because only the bootstrap
  is instantiated at reload time. But the manifest import and the ROM env-var
  injection in `index-dynamic.ts` are customer-specific and would have to move
  after the resume point too.
- Everything else read from the `Workspace` at boot (other deno.json settings,
  package.json, lockfile, cwd) is baked into the snapshot. For edge-bundler
  bundles deno.json is only the import map, so this is fine.
- The `--vendor` cache reads `vendor/manifest.json` once at construction
  (`libs/cache_dir/local.rs`). `reloadImportMap()` now re-reads it too, so a
  vendor directory swapped in before the call works, including entries that only
  resolve through the manifest (redirects, content-type overrides, hashed file
  names).
- Workers spawned before the snapshot must reload themselves (D5); workers
  spawned after the reload need nothing.
- The bootstrap counterpart exists (uncommitted in the
  `edge-functions-bootstrap` checkout): a template boot is detected by the
  bundle manifest being absent, everything customer-specific is deferred to the
  first request, which calls `reloadImportMap()` (via
  `src/bootstrap/import_map.ts`, no-op with a warning on stock Deno) before
  importing the manifest and functions; the manifest is threaded through
  `serve`/`handleRequest` as a lazy getter resolved at routing time. Still
  outstanding on the infra side: launcher/Unikraft support for booting without a
  function ROM (with a placeholder `/platform/deno.json`) and for attaching the
  bundle on resume.
- Customer imports after the reload are genuinely dynamic imports and need read
  permission for their files; the launcher already passes `--allow-read=/`.
- The explicit-value form (`reloadImportMap({ baseUrl, importMap })`, open
  question 2) is no longer needed for this flow now that deno.json is re-read,
  but remains a cheap addition if the bootstrap ever holds the map in memory
  instead of on disk.

## Implementation status

Phases 1 to 4 are implemented on `jake/import-map` (uncommitted at the time of
writing). Deviations from the plan below:

- The op lives in the existing, already-snapshotted `deno_runtime` extension
  (`runtime/ops/runtime.rs`) rather than a new extension, so no changes to
  `runtime/shared.rs` or `runtime/web_worker.rs` were needed.
- The trait is `deno_runtime::ops::runtime::ImportMapReloader` with a single
  `async fn reload(&self)`; the CLI implementation is `CliImportMapReloader` in
  `cli/module_loader.rs`, handed to `OpState` through a new
  `CreateModuleLoaderResult::import_map_reloader` field.
- D2 was widened after reading the edge-functions bootstrap: edge-bundler writes
  the customer's import map as inline `imports`/`scopes` in the bundle's
  `deno.json`, which Deno reads via `--config=/platform/deno.json`. The reload
  therefore re-reads the root deno.json from disk (`ConfigFile::from_specifier`)
  and uses it in place of the workspace's cached copy when rebuilding the map,
  so inline `imports`/`scopes` and a changed `importMap` path are both picked
  up. The workspace is still not re-discovered (other deno.json settings,
  members and package.json files stay as at boot).
- The vendor manifest follow-up is implemented too: `LocalCacheManifest` keeps
  its `use_reverse_mapping` flag and gained `reload()`,
  `LocalHttpCache::reload_manifest()` exposes it, and
  `ResolverFactory::reload_import_map()` calls it when the HTTP cache is
  vendor-local. Redirects, content-type overrides and hashed file names in a
  swapped-in vendor directory resolve after the reload.
- The optional explicit-value form (`reloadImportMap({ baseUrl, importMap })`)
  was not implemented; the method takes no arguments and re-reads the sources.
- `maybe_import_map()` now returns `Option<ImportMapRc>` (an `Arc<ImportMap>`),
  not a wrapper with diagnostics; diagnostics are returned owned from
  `diagnostics()`.
- Behaviour found while testing: after a reload the isolate's graph is empty, so
  a dynamic `import("alias")` that used to be statically analysable is now a
  genuinely dynamic import of a file outside the static graph and needs
  `--allow-read` like any other dynamic import of a local file. Programs that
  call `reloadImportMap()` should run with read permission for the mapped
  targets.

Verified: `cargo check -p deno -p denort -p deno_lib`, clippy and the JS lint,
the three new resolver unit tests plus the existing 25 in `workspace::test` (run
with `cargo test -p deno_resolver --features sys_traits/getrandom`; the crate's
test build otherwise fails on unrelated `disk_cache` tests), the five
`tests/specs/run/import_map_reload` cases,
`tests/specs/compile/import_map_reload_unsupported` and `unit::internals_test`
through the spec/unit harnesses.

## Summary

Today the import map is computed exactly once.
`WorkspaceResolver::from_workspace` builds a synthetic map from the
`--import-map` file (or `deno.json`'s `importMap` / inline `imports`), stores it
by value in an immutable struct, and that struct is captured behind write-once
`OnceCell`s and shared as `Arc<CliResolver>` by the module loader, the graph
builder, and every web worker. Nothing downstream has an invalidation API; the
only ways to pick up a changed map are a `--watch` restart or the LSP's full
resolver rebuild.

The proposal has three parts, one per crate layer:

1. **libs/resolver**: put the import map behind an `RwLock` inside
   `WorkspaceResolver`, mirroring the existing `set_compiler_options_resolver`
   seam, and add `ResolverFactory::reload_import_map()` which re-runs the same
   derivation the constructor uses. Every existing `Arc` holder stays valid;
   nothing is rebuilt.
2. **cli**: make the import-map provider re-readable (bypass its two caches),
   and add a per-isolate reload handler that swaps the map and then drops that
   isolate's `ModuleGraph`, which is where resolved edges are actually cached.
3. **runtime**: a snapshotted extension with one async op,
   `op_reload_import_map`, that calls whatever handler the embedder put in
   `OpState`, and a JS shim `Deno[Deno.internal].reloadImportMap()`.

**The one hard limit.** V8 freezes a module's import edges at instantiation and
never asks the loader again. A reloaded map therefore affects only resolutions
that have not happened yet: dynamic `import()` of a specifier the referrer has
not imported before, `import.meta.resolve()`, and the entry modules of new
workers. Already-evaluated modules keep their old edges, and a dynamic import
that resolves to an already-loaded URL returns the existing instance. This is
inherent to ES modules, not to Deno, and the plan does not try to work around
it.

## How resolution works today

Three layers cache resolution results. The import map is consulted only at the
bottom, and only when the two layers above miss.

| Layer        | What                                                                                                                                                                                                                                                                 | Where                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V8           | Module records. `HostResolveModuleCallback` runs once per import edge at instantiation; the result is stored in the module record.                                                                                                                                   | `libs/core/modules/map.rs:1451` (`resolve_callback`)                                                                                                               |
| core         | `ModuleMapData::by_name`: resolved URL -> module id, append-only. Dynamic imports whose resolved URL is already here return the existing namespace without calling `prepare_load`.                                                                                   | `libs/core/modules/module_map_data.rs:195`, `libs/core/modules/map/dynamic.rs:64-105`                                                                              |
| core         | `ModuleMap::resolve` has no cache of its own; it calls the loader every time. `import.meta.resolve` likewise.                                                                                                                                                        | `libs/core/modules/map.rs:1344`, `libs/core/runtime/bindings.rs:1588`                                                                                              |
| cli          | `CliModuleLoaderInner::inner_resolve` is the single funnel for static, dynamic and `import.meta.resolve` resolution. It calls `resolver.resolve_with_graph(graph, ...)`.                                                                                             | `cli/module_loader.rs:1206`, `:1270-1286`                                                                                                                          |
| **graph**    | `resolve_with_graph`: if the referrer is in the `ModuleGraph` and has a `dependencies[raw_specifier]` edge, that edge is returned (including cached _failures_). Only `Resolution::None` falls through to the resolver. **This is the primary cache to invalidate.** | `libs/resolver/graph.rs:275-306`; graph stored in `cli/graph_container.rs:45` (`Arc<RwLock<Arc<ModuleGraph>>>`), one per web worker at `cli/module_loader.rs:2039` |
| cli          | `prepare_load` for a dynamic import: if the specifier is already in the graph and roots are non-empty, it logs "Skipping prepare module load" and does no graph build.                                                                                               | `cli/module_loader.rs:1686-1723`                                                                                                                                   |
| **resolver** | `DenoResolver::resolve` -> `RawDenoResolver::resolve` -> `WorkspaceResolver::resolve`, which finally reads `maybe_import_map`. **This is the value to swap.**                                                                                                        | `libs/resolver/graph.rs:449`, `libs/resolver/lib.rs:358`, `libs/resolver/workspace.rs:1366`                                                                        |

### Where the map comes from

The derivation is `CliSpecifiedImportMapProvider::get()`
(`cli/factory.rs:194-247`) feeding `WorkspaceResolver::from_workspace`
(`libs/resolver/workspace.rs:856`), whose inner `resolve_import_map`
(`workspace.rs:860-1119`) layers the specified map (or the root deno.json's
inline map) with workspace-member scopes, expands `catalog:` entries, optionally
rewrites `jsr:` to npm, and parses with `import_map::parse_from_value`.

The provider has two caches a reload must bypass:

- `WorkspaceExternalImportMapLoader`'s `OnceCell`
  (`libs/resolver/import_map.rs:22`) for a deno.json `importMap` path.
- The HTTP cache behind `file_fetcher.fetch_bypass_permissions` for remote
  `--import-map` URLs.

### Ownership that constrains the design

- `WorkspaceResolver.maybe_import_map` is a plain
  `Option<ImportMapWithDiagnostics>` (`workspace.rs:845`). The struct already
  has one interior-mutable field,
  `compiler_options_resolver: MaybeArc<RwLock<..>>`, with a `&self` setter
  (`workspace.rs:837-839`, `:1325-1330`) used through an `Arc` by both the
  factory (`libs/resolver/factory.rs:1311`) and the LSP
  (`cli/lsp/resolver.rs:663`).
- `ResolverFactory.workspace_resolver`, `raw_deno_resolver`, `deno_resolver` are
  `async_once_cell::OnceCell`s (`libs/resolver/factory.rs:744`, `:779`, `:781`);
  `CliFactory`'s cells are `once_cell::unsync::OnceCell` (`cli/factory.rs:255`).
  None can be reset.
- `Arc<CliResolver>` is held by `SharedCliModuleLoaderState`
  (`cli/module_loader.rs:377`), `ModuleGraphBuilder` (`cli/graph_util.rs:809`),
  the REPL, bundler, jupyter and LSP. Rebuilding it means rebuilding all of
  them.
- `deno run` and `deno serve` create the main worker via
  `create_main_worker_with_unconfigured_runtime` (`cli/tools/run/mod.rs:232`,
  `cli/tools/serve.rs:96`). On that path `WorkerOptions.extensions` is never
  applied (`runtime/worker.rs:523-536`), so a CLI-only `custom_extensions` op
  would silently not exist. Service objects reach the isolate through
  `lazy_init_extensions(vec![...::args(...)])` (`runtime/worker.rs:616-685`),
  which runs on both paths.
- deno_graph 0.110.1 is an external crate. `ModuleGraph.module_slots` is
  `pub(crate)` and `modules()` yields `&Module`, so resolved edges cannot be
  reset in place. The only eviction primitive is
  `ModuleGraph::reload(specifiers)`, which re-fetches and re-analyzes ("naive"
  per its own docs).
- `SpecifiedImportMapProvider` is `MaybeSend + MaybeSync`
  (`libs/resolver/factory.rs:191`); the CLI builds `deno_resolver` with the
  `sync` feature, so the provider and the resolver factory are `Send + Sync` and
  usable from worker threads. The `get()` future is `?Send`, which is fine for
  an op awaited on the isolate thread.
- `deno_core`, `deno_config`, `deno_resolver`, `node_resolver` are in-tree under
  `libs/`; only `import_map` and `deno_graph` are external.

## Design decisions

### D1. Swap the map in place; do not rebuild the resolver chain

**Pick:** change `WorkspaceResolver.maybe_import_map` to
`MaybeArc<RwLock<Option<MaybeArc<ImportMapWithDiagnostics>>>>` with a `&self`
setter, exactly like `compiler_options_resolver`.

The alternative (LSP-style: build a fresh `WorkspaceResolver`,
`RawDenoResolver`, `DenoResolver` and re-thread the `Arc` into every holder)
touches `CliFactory`, `ResolverFactory`, `SharedCliModuleLoaderState`,
`ModuleGraphBuilder` and every live loader, and requires resettable cells that
do not exist. Interior mutability leaves all existing `Arc` clones valid because
every reader already goes through `&self`.

The cost is a signature change on `maybe_import_map()` (currently returns
`Option<&ImportMap>`), which has 12 callers outside workspace.rs: 7 in the LSP
(`cli/lsp/resolver.rs` x4, `analysis.rs`, `completions.rs`, `diagnostics.rs`), 2
in `cli/standalone/binary.rs`, 2 in `cli/tools/pm/cache_deps.rs`, 1 in
`cli/tools/publish/unfurl.rs`. Returning a cloned `Arc` rather than a lock guard
keeps callers simple and keeps `resolve()` from holding a read lock across the
import-map lookup.

### D2. Regenerate from the original source; optionally accept an explicit value

**Pick:** re-run the exact derivation used at startup (same
`SpecifiedImportMapProvider`, same `Workspace`, same layering), with one
substitution: the root deno.json is re-read from disk and used in place of the
workspace's cached copy. The `Workspace` object itself is not re-discovered.

What gets picked up: a rewritten `--import-map` file (local or remote), a
rewritten root deno.json's inline `imports`/`scopes`, and a rewritten file
pointed to by the (fresh) root deno.json's `importMap`.

What does **not** get picked up: other root deno.json settings
(`compilerOptions`, `nodeModulesDir`, `unstable`, ...), workspace-member
deno.json files, package.json files, or the lockfile, because those live in the
already-parsed `Workspace`. Re-discovering the workspace ripples into compiler
options, node_modules mode, lockfile and npm resolution and is out of scope; see
Open questions.

Because `reload_import_map` takes an `Option<SpecifiedImportMap>` anyway,
accepting an explicit `{ imports, scopes }` object plus base URL from JS is a
small addition. It is listed as optional in Phase 3 so the core can land first.

### D3. Invalidate the graph by replacing it with an empty one

**Pick:** under the container's update permit, replace the isolate's
`ModuleGraph` with `ModuleGraph::new(kind)`.

Surgically clearing `Dependency.maybe_code` on every module would be ideal but
deno_graph gives no mutable access (a follow-up PR to deno_graph could add it).
`ModuleGraph::reload(all specifiers)` re-fetches and re-analyzes every module.
An empty graph is cheap and correct: the next dynamic import finds no edge,
resolves through the new map, and because `graph.roots` is empty the "skip
prepare" path is not taken, so `prepare_module_load` builds a fresh subgraph
from that import.

Side effects to be aware of: with `--check`, `has_type_checked`
(`cli/module_loader.rs:247`) becomes false so the new subgraph is type-checked
once more; and `prepare_module_load` may write the lockfile (and will error
under `--frozen`) if the new map introduces dependencies, which is already how
dynamic imports of new specifiers behave.

Taking the update permit matters: `MainModuleGraphUpdatePermit` clones the graph
on acquisition and `commit()` overwrites the container
(`cli/graph_container.rs:152-170`). Resetting without the permit would race an
in-flight `prepare_module_load`, whose commit would put the old edges back.

### D4. Op lives in a snapshotted runtime extension; behaviour is injected via OpState

**Pick:** define `op_reload_import_map` in `runtime/ops/` alongside a trait
`ImportMapReloadHandler`; the CLI implements the trait and deno_lib puts an
`Rc<dyn ImportMapReloadHandler>` into `OpState` at worker creation. The op does
`state.try_borrow::<Rc<dyn ...>>()` and returns a clear error when absent.

This is the same shape as `CronHandler` (`Rc<dyn>` in OpState, re-put after
`hydrate`, `runtime/worker.rs:528-535`) and `LoaderHookRegistry` (returned from
`CreateModuleLoaderResult` and put by `cli/lib/worker.rs:556` and `:790`). It
works on the unconfigured-runtime fast path, which a `custom_extensions`
approach would not, and it keeps `runtime` free of CLI types. `deno compile`
binaries and `deno_rt` simply do not put a handler, so the method rejects with
"not supported in this runtime".

### D5. Per-isolate scope, shared map

**Pick:** the handler swaps the _shared_ import map (one `WorkspaceResolver` per
process) and resets _only the calling isolate's_ graph. Web workers that want
fresh resolution call the method themselves.

There is no registry of live worker graph containers (each is an `Rc` inside its
own `CliModuleLoaderInner`), and resetting a worker graph from another thread is
not possible. A generation counter on `SharedCliModuleLoaderState` that each
loader checks in `inner_resolve` would let non-calling workers self-reset
lazily; it is a follow-up rather than v1 because the sync reset it needs cannot
take the async update permit.

### D6. Failure leaves the old map in place

**Pick:** if fetching or parsing the new map fails, `reload_import_map` returns
the error, the promise rejects, and the previous map and graph are untouched.
Import-map diagnostics (non-fatal) are logged exactly as at startup
(`libs/resolver/factory.rs:1313-1326`).

## Phase 1: swappable import map in `libs/resolver`

Goal: make the import map replaceable through `&self` without changing who owns
what. Pure Rust, unit-testable, no CLI or runtime changes.

### `libs/resolver/workspace.rs`

- Hoist the inner `fn resolve_import_map` (lines 860-1119, including
  `expand_catalog_specifiers` and `child_import_map_config`) to a module-level
  `pub(crate) fn build_workspace_import_map(sys, workspace, specified)
  -> Result<Option<ImportMapWithDiagnostics>, WorkspaceResolverCreateError>`.
  `from_workspace` calls it unchanged.
- Add
  `type ImportMapCellRc = MaybeArc<RwLock<Option<MaybeArc<ImportMapWithDiagnostics>>>>`
  next to `CompilerOptionsResolverCellRc` (line 837). Change the field at line
  845; update `from_workspace`, `new_raw` (1165) and `try_from_serializable`
  (1270) to wrap.
- `maybe_import_map(&self) -> Option<MaybeArc<ImportMapWithDiagnostics>>` (line
  1332). Callers use `.import_map`.
- Add `set_import_map(&self, Option<ImportMapWithDiagnostics>)` and
  `reload_import_map(&self, workspace: &Workspace, specified: Option<SpecifiedImportMap>)
  -> Result<(), WorkspaceResolverCreateError>`
  that calls `build_workspace_import_map` and writes the cell only on success
  (D6). `WorkspaceResolver` does not currently keep `sys` directly (it is inside
  `CachedMetadataFs`), so either store a clone or take `sys` as a parameter.
- `resolve()` (1366): clone the `Arc` out of a short read lock, then resolve.
  `diagnostics()` (1339) and `to_serializable()` (1228) read through the cell.
- Add `clear_fs_cache(&self)` on `SloppyImportsResolver` / `CachedMetadataFs`
  (line 313; the DashMap has `clear()`) so a map that now points at freshly
  written files is not defeated by a cached "does not exist" probe. Call it from
  `reload_import_map`.

### `libs/resolver/import_map.rs`

Replace the `OnceCell<Option<ExternalImportMap>>` (line 22) with
`RwLock<Option<Option<ExternalImportMap>>>` (or keep the cell and add
`load_fresh()`). Add `reload(&self)` that re-reads the deno.json `importMap`
path. This loader is also used by `WorkspaceFactory`, so keep `get_or_load()`
semantics identical.

### `libs/resolver/factory.rs`

- Extend `SpecifiedImportMapProvider` (line 191) with
  `async fn get_fresh(&self) -> Result<Option<SpecifiedImportMap>>`,
  default-implemented as `self.get().await`. The LSP's provider and any tests
  keep compiling.
- Add `pub async fn reload_import_map(&self) -> Result<(), anyhow::Error>`:
  requires `workspace_resolver()` already initialised (return an error otherwise
  rather than initialising on the reload path); calls
  `options.specified_import_map.get_fresh()`; calls
  `workspace_resolver.reload_import_map(&directory.workspace, specified)`; logs
  diagnostics with the same `log::warn!` block as line 1313; clears
  `NodeResolutionThreadLocalCache` and `PackageJsonThreadLocalCache` as the LSP
  does (`cli/lsp/documents.rs:1290-1291`).

### Callers of `maybe_import_map()`

`cli/lsp/resolver.rs` (4), `cli/lsp/analysis.rs`, `cli/lsp/completions.rs`,
`cli/lsp/diagnostics.rs`, `cli/standalone/binary.rs` (2),
`cli/tools/pm/cache_deps.rs` (2), `cli/tools/publish/unfurl.rs`. Mechanical:
bind the `Arc` to a local, use `.import_map`.

### Tests (`libs/resolver/workspace.rs`)

- `set_import_map` changes `resolve()` output.
- `reload_import_map` with a bad value returns `Err` and the previous map still
  resolves.
- `to_serializable` reflects the swapped map.
- Existing tests that build resolvers via `new_raw` (around lines 2995, 3150,
  3274) still pass.

## Phase 2: CLI reload handler and graph reset

Goal: give each isolate an object that knows how to swap the shared map and
throw away its own resolution cache, and hand that object to the runtime through
`OpState`.

### `cli/factory.rs`

- Implement `get_fresh()` on `CliSpecifiedImportMapProvider` (line 194):
  - `--import-map` specifier: use
    `file_fetcher.fetch_with_options(FetchOptions
    { maybe_cache_setting: Some(&CacheSetting::ReloadAll), .. })`
    (`libs/resolver/file_fetcher.rs:255`) so a remote map is re-downloaded.
    `data:` URLs are immutable and can share the `get()` path. The eszip branch
    keeps returning the embedded value.
  - deno.json `importMap` branch: call
    `workspace_external_import_map_loader.reload()`.
- Expose the resolver factory to the module loader:
  `create_module_loader_factory()` (line 1226) already has
  `self.resolver_factory()?`; pass an `Arc<CliResolverFactory>` (or a narrower
  `Arc<dyn Fn>`) into `CliModuleLoaderFactory::new`.

### `cli/module_loader.rs`

- Add `resolver_factory: Arc<CliResolverFactory>` to
  `SharedCliModuleLoaderState` (line 356) and its constructor (442).
- Add `struct CliImportMapReloadHandler<TGraphContainer>` holding
  `shared: Arc<SharedCliModuleLoaderState>`, the isolate's `graph_container`, a
  handle to `loaded_files` (or a `Weak` to the loader inner), the optional
  `hook_registry`, and `graph_kind`. Implements the runtime trait from Phase 3.
  `reload()`:
  1. `shared.resolver_factory.reload_import_map().await?`
  2. `let mut permit = graph_container.acquire_update_permit().await;
     *permit.graph_mut() = ModuleGraph::new(kind); permit.commit();`
  3. clear `loaded_files` (line 610) so mtime-based dynamic reload logic starts
     fresh
  4. clear the hook registry's `resolved_attributes` (keyed by resolved URL,
     harmless but stale)
- Construct it in `create_with_lib` (around 494-554) next to the hook registry
  so `create_for_main` (560) and `create_for_worker` (574) both produce one.
  Mind the `Weak` pattern already used at line 518 so the handler does not
  create a cycle that keeps the loader alive across `--watch` restarts
  (denoland/deno#35664).
- `EszipModuleLoader` (2220) returns no handler.

### `cli/lib/worker.rs`

Add `import_map_reload_handler: Option<Rc<dyn ImportMapReloadHandler>>` to
`CreateModuleLoaderResult` (line 63). Put it into `OpState` at both sites that
put `hook_registry`: the web-worker path (556) and the main-worker path (790).

### `cli/rt/run.rs`

`StandaloneModuleLoaderFactory` (1176, 1222) returns `None`; the import map is
baked into the binary. No behaviour change.

### `cli/lsp/`

No functional change beyond the `maybe_import_map()` callers in Phase 1. The LSP
keeps its rebuild-and-replace strategy.

## Phase 3: runtime op and the `Deno[Deno.internal]` method

Goal: a tiny, always-present extension so the op is in the snapshot and
available on the unconfigured-runtime path. Behaviour is entirely delegated to
the handler from Phase 2.

### `runtime/ops/import_map.rs` (new)

```rust
pub trait ImportMapReloadHandler {
  fn reload(
    self: Rc<Self>,
    // optional (D2): explicit map value + base URL supplied from JS
    explicit: Option<(Url, serde_json::Value)>,
  ) -> Pin<Box<dyn Future<Output = Result<(), JsErrorBox>>>>;
}

deno_core::extension!(deno_import_map, ops = [op_reload_import_map]);

#[op2(async)]
async fn op_reload_import_map(
  state: Rc<RefCell<OpState>>,
  #[string] base_url: Option<String>,
  #[serde] value: Option<serde_json::Value>,
) -> Result<(), JsErrorBox> {
  let handler = state
    .borrow()
    .try_borrow::<Rc<dyn ImportMapReloadHandler>>()
    .cloned()
    .ok_or_else(|| {
      JsErrorBox::generic("Import map reload is not supported in this runtime")
    })?;
  handler.reload(/* .. */).await
}
```

Register in `runtime/ops/mod.rs`. The trait object is `Rc`, not `Arc`, because
it wraps a per-isolate graph container (D5).

### `runtime/worker.rs`

Add `ops::import_map::deno_import_map::lazy_init()` to `common_extensions`
(1199-1250, next to `deno_worker_host::lazy_init()` at 1243). Nothing to add to
the `lazy_init_extensions(vec![...])` block since the extension has no options;
the handler arrives via `OpState` after construction.

### `runtime/web_worker.rs`

Add the extension to the worker extension list (around 619 where
`deno_bundle_runtime::init` is).

### `runtime/shared.rs`

Add `deno_import_map` to the `runtime_extensions!` / snapshot list (lines 9-24)
so the op is snapshotted; otherwise the pre-warmed isolate will not have it.

### `runtime/js/99_main.js`

Import `op_reload_import_map` from `ext:core/ops` and attach next to the
existing `ObjectAssign(internals, { core: userVisibleCore })` at line 759:

```js
internals.reloadImportMap = (options = undefined) =>
  op_reload_import_map(options?.baseUrl, options?.importMap);
```

Keep it a plain data property (not a lazy accessor) so
`Deno[Deno.internal].reloadImportMap` is enumerable and cheap.

### `cli/tsc/dts/lib.deno.ns.d.ts`

No change. `Deno.internal` is deliberately untyped; do not document the method
in public types.

### Proposed JS surface

`Deno[Deno.internal].reloadImportMap(): Promise<void>` re-derives the map from
its original source and resets this isolate's resolution cache.

Optional:
`reloadImportMap({ baseUrl: string, importMap: { imports?, scopes? } })` uses
the given value as the specified map instead of re-reading the source.

Rejects if the new map cannot be fetched or parsed (old map kept), or if the
runtime has no handler (`deno compile`).

## Phase 4: tests

Spec tests under `tests/specs/run/import_map_reload/` with one `__test__.jsonc`
and several steps; each step is a fresh process so the on-disk fixtures can be
rewritten by the script itself (`--allow-write`).

| Test                           | Asserts                                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag_file_rewritten`          | `deno run --allow-read --allow-write --import-map=map.json main.ts`. `main.ts` does `await import("alias")` (resolves to `a.ts`), rewrites `map.json` so `alias` points at `b.ts`, calls `reloadImportMap()`, imports `"alias"` again and gets `b.ts`. Output shows `a` then `b`. |
| `import_meta_resolve`          | `import.meta.resolve("alias")` before and after reload returns the two different URLs. Exercises the `is_import_meta` branch of `inner_resolve`.                                                                                                                                  |
| `deno_json_import_map_path`    | Same as the first, but the map is referenced from `deno.json` `"importMap": "./map.json"`, proving the `WorkspaceExternalImportMapLoader` cache is bypassed.                                                                                                                      |
| `identity_preserved`           | After reload, `import("./a.ts")` returns the same module namespace object as before (documents the V8 / `by_name` behaviour so nobody files it as a bug).                                                                                                                         |
| `invalid_map_keeps_old`        | Rewrite `map.json` to invalid JSON, `reloadImportMap()` rejects with the parse error, `import("alias")` still resolves to the old target.                                                                                                                                         |
| `worker_scope`                 | Main thread reloads; a running `Worker` that then imports `"alias"` for the first time gets the _new_ target (shared map, empty worker edge), while a worker that had already imported `"alias"` keeps the old edge until it calls `reloadImportMap()` itself. Pins down D5.      |
| `compile_unsupported`          | In `tests/specs/compile/`: a compiled binary calling `reloadImportMap()` rejects with the "not supported" message.                                                                                                                                                                |
| `tests/unit/internals_test.ts` | Add `reloadImportMap` to the presence assertions if the test enumerates names.                                                                                                                                                                                                    |

Rust unit coverage lives in Phase 1. If the optional explicit-value form ships,
add one spec step passing `{ baseUrl, importMap }` without touching disk.

## Phase 5: verification before the PR

Fast loop:

```
cargo check -p deno_resolver -p deno_runtime
cargo test -p deno_resolver workspace
cargo build --bin deno
cargo test specs::run::import_map_reload
```

Before pushing:

```
cargo test specs::run
cargo test specs::compile
cargo test unit::internals_test
cargo test -p deno lsp          # the maybe_import_map callers
./tools/format.js && ./tools/lint.js
```

Also confirm the snapshot rebuilds cleanly from a clean `target/` since a new
runtime extension is added.

Suggested commit split, one PR: (1) resolver interior mutability + callers; (2)
provider `get_fresh` and CLI handler; (3) runtime op + JS; (4) tests. All squash
on merge per the repo workflow, but the split keeps review focused.

## Cache inventory

| Cache                                                             | Where                                                               | Plan                                                                                                               | Result   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| V8 module records (import edges)                                  | `libs/core/modules/map.rs:1451`                                     | Not addressable. Documented limit.                                                                                 | stays    |
| `ModuleMapData::by_name` (resolved URL -> module id)              | `libs/core/modules/module_map_data.rs:195`                          | Not addressable without tearing down the realm. Correct behaviour: same URL is the same module.                    | stays    |
| `ModuleGraph` resolved edges and `module_slots`                   | `cli/graph_container.rs:45`, per worker `cli/module_loader.rs:2039` | Replaced with an empty graph under the update permit, per calling isolate (D3, D5).                                | cleared  |
| `WorkspaceResolver.maybe_import_map`                              | `libs/resolver/workspace.rs:845`                                    | Swapped in place (D1).                                                                                             | swapped  |
| `WorkspaceExternalImportMapLoader` OnceCell                       | `libs/resolver/import_map.rs:22`                                    | `reload()` re-reads the file.                                                                                      | cleared  |
| HTTP cache for remote `--import-map`                              | `libs/resolver/file_fetcher.rs`                                     | `CacheSetting::ReloadAll` on the fresh fetch.                                                                      | bypassed |
| `--vendor` `LocalCacheManifest` (vendor/manifest.json)            | `libs/cache_dir/local.rs`                                           | Re-read on reload via `LocalHttpCache::reload_manifest()`.                                                         | cleared  |
| `CachedMetadataFs` (sloppy-import probes)                         | `libs/resolver/workspace.rs:313`                                    | Cleared on reload.                                                                                                 | cleared  |
| `NodeResolutionThreadLocalCache`, `PackageJsonThreadLocalCache`   | `libs/node_resolver/cache.rs:41`, `package_json.rs:50`              | Cleared on reload, matching the LSP.                                                                               | cleared  |
| `CliModuleLoaderInner::loaded_files`                              | `cli/module_loader.rs:610`                                          | Cleared with the graph.                                                                                            | cleared  |
| `LoaderHookRegistry.resolved_attributes`                          | `cli/module_loader.rs:1388`                                         | Cleared; keyed by resolved URL so harmless either way.                                                             | cleared  |
| `DenoResolver` / `RawDenoResolver` Arcs, factory `OnceCell`s      | `libs/resolver/factory.rs:744,779,781`                              | Untouched; they read the swapped map through `&self`.                                                              | valid    |
| `NpmResolutionCell` snapshot                                      | `libs/resolver/npm/managed/resolution.rs:26`                        | Untouched. New `npm:` mappings resolve and install on the next `prepare_module_load`, as dynamic imports do today. | lazy     |
| `TypeCheckCache` hash                                             | `cli/type_checker.rs:282-335`                                       | Untouched; an empty graph forces one re-check of the new subgraph under `--check`.                                 | lazy     |
| Other worker isolates' graphs                                     | per `CliModuleLoaderInner`                                          | Stale until that worker calls the method (D5). Generation counter is a follow-up.                                  | stale    |
| `ParsedSourceCache`, `ModuleInfoCache`, emit cache, V8 code cache | various                                                             | Keyed by source content, not by resolution. Safe.                                                                  | n/a      |

## Semantics and limits

- **What changes after a reload:** resolution of any `(referrer, specifier)`
  pair that has no edge in the calling isolate's graph. In practice: first-time
  dynamic imports, `import.meta.resolve`, and new `Worker` entry modules created
  from this isolate.
- **What does not change:** static imports of modules already instantiated; a
  dynamic import whose new resolution is a URL already loaded (same instance is
  returned); anything in other isolates until they reload.
- **Source of truth:** the same files Deno read at startup: the `--import-map`
  file if given, and the root deno.json (re-read from disk, so inline
  `imports`/`scopes` and its `importMap` path are current). Other deno.json
  settings and the rest of the workspace are not re-read (D2).
- **Atomicity:** a failed reload leaves the previous map and graph intact and
  rejects the promise. Two concurrent reloads in one isolate serialise on the
  graph update permit; the map swap itself is a single `RwLock` write.
- **Side effects:** the next `prepare_module_load` may install npm packages and
  write the lockfile (errors under `--frozen`) and may re-run type checking
  under `--check`. These are the normal consequences of importing something new.
- **Permissions:** the reload runs with `fetch_bypass_permissions`, exactly as
  the startup load does. The method is behind `Deno.internal` and is not a
  supported public API.
- **Unsupported runtimes:** `deno compile` output and `deno_rt` reject with a
  clear message; the LSP is unaffected.

## Open questions and follow-ups

1. **Vendor manifest** - implemented (see Implementation status); no longer
   open.
2. **Explicit value from JS** (D2 optional form). Trivial to add on top; decide
   whether the method should accept it in v1 or stay a pure "re-read" call.
3. **Non-calling workers.** A `resolution_generation: AtomicU64` on
   `SharedCliModuleLoaderState`, checked in `inner_resolve`, would let other
   isolates reset lazily. It needs a sync reset of the worker graph container
   (its permit is async), so it is deferred until there is a concrete need.
4. **deno_graph upstream.** A `ModuleGraph::clear_resolutions()` (or
   `modules_mut()`) would let us keep analysed modules and drop only edges,
   avoiding re-analysis after reload. Worth a small upstream PR once the CLI
   side has landed and proved the shape.
5. **Naming.** `reloadImportMap` is the working name; confirm before the JS shim
   lands since renaming an internal is cheap but noisy.
