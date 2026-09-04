# Bucket: `typescript`

Canonical guides — link, do not restate:

- TypeScript Handbook — <https://www.typescriptlang.org/docs/handbook/intro.html>
- `tsconfig` reference — <https://www.typescriptlang.org/tsconfig>
- `typescript-eslint` rules — <https://typescript-eslint.io/rules/>

Apply these checks to `*.ts` files and `tsconfig*.json`. Components
under `*.tsx` belong to the `react` bucket — do not review them here.

## Checks

1. **Strict mode is on.** `tsconfig.json` has `"strict": true` (or the
   equivalent flag set: `strictNullChecks`, `noImplicitAny`,
   `strictFunctionTypes`, `strictBindCallApply`,
   `strictPropertyInitialization`, `alwaysStrict`,
   `useUnknownInCatchVariables`). Flag missing flags.
2. **`any` is rare and justified.** Flag bare `: any` on exported
   public APIs and on function parameters that cross trust boundaries.
   `unknown` is the right escape hatch — narrow it with type guards.
3. **Exhaustive switches.** When a `switch` discriminates on a
   discriminated-union tag, the `default` branch must call an
   `assertNever(x: never)` helper so a future variant breaks the
   compile. Flag missing exhaustiveness checks.
4. **Discriminated unions for state.** Use a tagged union (e.g.
   `{ ok: true; value: T } | { ok: false; error: E }`) over optional
   fields with implicit invariants. The project's own `Result` type
   is the canonical shape — prefer it for new error-handling code.
5. **Async/await error handling.** Every `await` on a fallible
   operation is either wrapped in `try`/`catch`, returned as a
   `Result`, or handled by an ancestor catch. Flag bare top-level
   awaits with no error path.
6. **No floating promises.** Every promise is awaited, returned, or
   explicitly handled with `.catch(...)`. Flag function calls that
   return a promise but ignore it (a common bug source — they fail
   silently). Enable `@typescript-eslint/no-floating-promises` in CI.
7. **Explicit return types on exported functions.** Inferred return
   types are fine inside a module; on `export`s, write them so the
   public contract is stable across refactors.
8. **No unsafe non-null assertions.** Flag `!` (the non-null
   assertion operator) on values that the compiler cannot prove
   non-null without it, especially on function parameters and on
   array index access.

## Supply-chain hardening (npm / pnpm / Yarn / JSR)

These checks apply to `package.json`, `pnpm-workspace.yaml`,
`deno.json`, `import_map.json`, and the matching lockfile
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `deno.lock`).
Each finding must cite the manifest / lockfile path and line range.

9. **Exact version pins in release manifests.** A library or
   application published from this repo pins exact versions
   (`"axios": "1.7.4"`) — not `^` or `~` ranges. Flag `^`/`~` ranges
   in the `dependencies` block of a `package.json` that ships to
   production. (Dev-only deps may keep ranges.)
10. **Lockfile committed and matches manifest.** The repo commits a
    lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or
    `deno.lock`) and CI runs `npm ci --ignore-scripts` (or the
    equivalent `pnpm install --frozen-lockfile --ignore-scripts`)
    rather than `npm install`. Flag missing lockfiles and flag CI
    that runs `npm install`.
11. **`--ignore-scripts` is the default install posture.** Lifecycle
    scripts (`postinstall`, `preinstall`, `prepare`) on transitive
    deps were the pivot for Shai-Hulud and Axios. The repo's CI and
    `engines.npm`-pinned local tooling pass `--ignore-scripts` by
    default and allowlist the small set of packages that genuinely
    need a build step. Flag CI that runs `npm ci` without
    `--ignore-scripts`.
12. **Phantom transitive deps in lockfile diff.** When the most
    recent commit touched the lockfile, every new transitive
    package can be traced to a declared dep in `package.json`. Flag
    lockfile additions with no path back to a declared dep — that
    is the Axios `plain-crypto-js` shape.
13. **Dormant package republishes.** Flag any direct or transitive
    dep whose previous published version is more than 12 months old
    and whose latest version is less than 30 days old (the
    node-ipc shape). Cite the package, the gap, and any maintainer-
    account change across the gap. Tools: `npm view <pkg> time` or
    the registry's `/-/v1/search` endpoint.
14. **Typosquats and slopsquats.** Flag dependency names that
    differ from a popular package by one character, contain a
    homoglyph, or are "AI-hallucinated" names with no registry
    presence prior to the last few months. Cite the suspect dep and
    the popular package it shadows.
15. **Dependency confusion.** Flag any internal-scope name
    (`@stsoftwareau/*` or any private scope) that is also resolvable
    on the public registry without a prior reservation. Confirm
    `.npmrc` / `pnpm-workspace.yaml` scopes the internal name to a
    private registry — otherwise a public publish silently wins.
16. **Provenance is necessary but not sufficient.** Releases published
    from this repo include npm provenance / Sigstore attestation
    (`npm publish --provenance` in CI). The repo's policy for
    *consuming* deps does **not** treat provenance as the sole gate —
    the TanStack May 2026 incident emitted a valid provenance for a
    hijacked CI artefact. Flag a consumption policy that gates only
    on provenance presence.
17. **No direct git+ or tarball-URL deps in release manifests.** Flag
    `git+https://...`, `git://...`, or raw `https://.../foo.tgz`
    specifiers in `package.json` / `deno.json` import maps for
    production deps — they bypass registry integrity checks.

## Deno-repo regression checks

A Deno repo is one whose root contains any of `deno.json`,
`deno.jsonc`, or `deno.lock`. **If none of those markers exist, skip
this entire section** — Node-only repos stay Node and these flags do
not apply.

When the repo is a Deno repo, every regression below is filed at
`severity:high`. Each finding must cite the offending path and a line
range (e.g. `.github/workflows/ci.yml:38-44`); a generic claim without
a citation is dropped. Use the standard `BP-<12 hex>` stable-id recipe
(the title slug plus the primary file) so re-runs deduplicate against
the known-open list. The suggested fix on every check must point at
the Deno-native equivalent (`deno test`, `deno run`, `deno task`,
`deno bundle`, `deno fmt`, `deno lint`) rather than just "remove the
Node thing".

18. **`package.json` declares runtime `dependencies` in a Deno repo.**
    Flag a non-empty `dependencies` block in the root `package.json`
    when Deno markers are present. `devDependencies` is acceptable —
    Node tooling parity during transition is allowed, only runtime
    deps are a regression. Cite `package.json` and the offending
    `dependencies` block. Suggested fix: port the runtime dep to its
    JSR equivalent or to `npm:` / `jsr:` specifiers in `deno.json`
    imports and remove the entry from `package.json`.

19. **`node_modules/` committed in a Deno repo.** Flag a tracked
    `node_modules/` directory or any `node_modules/**` path that is
    not ignored by `.gitignore`. Cite a representative path and the
    `.gitignore` line range that *should* exclude it. Suggested fix:
    add `node_modules/` to `.gitignore`, run `git rm -r --cached
    node_modules`, and rely on Deno's per-module cache.

20. **CI workflows invoke `npm`, `pnpm`, `yarn`, or `npx` to run
    application code in a Deno repo.** Inspect `.github/workflows/*.yml`
    for `run:` steps that call `npm test`, `npm run …`, `pnpm …`,
    `yarn …`, or `npx …` to execute application or test code where
    `deno run` / `deno test` / `deno task` would suffice. Cite the
    workflow path and the exact line range of the offending `run:`
    step. Suggested fix: replace the invocation with the Deno
    equivalent (e.g. "replace `npm test` with `deno test --allow-all`
    in `.github/workflows/ci.yml:42`"). Invocations that exist purely
    to drive Node-side tooling parity (`npm ci --ignore-scripts` to
    install dev tooling) are acceptable — flag only steps that run
    application logic.

21. **`tsconfig.json` overrides Deno's compiler options.** Deno reads
    `compilerOptions` from `deno.json` / `deno.jsonc`. A root
    `tsconfig.json` whose `compilerOptions` field overlaps with the
    `compilerOptions` block in `deno.json` causes silent skew between
    the editor / build view and the Deno runtime view. Flag a root
    `tsconfig.json` whose `compilerOptions` is non-empty when Deno
    markers are present. Cite `tsconfig.json` and the offending
    `compilerOptions` line range. Suggested fix: move the settings
    into `deno.json`'s `compilerOptions`, then delete `tsconfig.json`
    (or scope it to a Node sub-directory).

22. **Node-only bundler configs sit next to Deno's native bundler.**
    Flag the presence of Webpack, Vite, or esbuild config files at
    the root of a Deno repo: `webpack.config.{js,ts,cjs,mjs}`,
    `vite.config.{js,ts,cjs,mjs}`, `esbuild.config.{js,ts,cjs,mjs}`,
    or an `esbuild` runtime invocation in `package.json` scripts.
    Cite the config path. Suggested fix: replace with `deno bundle`
    (or `deno task bundle` calling the same), or — if the bundler is
    genuinely required for a Node-only sub-package — relocate the
    config and the package it builds into a clearly scoped
    sub-directory so the root stays Deno-pure.

**Node-only repos are silent.** A repo with no Deno markers (no
`deno.json`, `deno.jsonc`, or `deno.lock`) is a Node repo, and these
checks file nothing — they exist to prevent Deno repos from
regressing, not to migrate Node repos.

## Dead dependencies

A "dead dependency" is a package declared in a manifest that no real
source code imports. Dead deps inflate install time, expand the
supply-chain attack surface, and mislead audits — they should be
removed.

**Hard constraint — static evidence only.** This check greps the source
tree for import references. The scanner **does not** invoke `npm`,
`pnpm`, `yarn`, `deno`, `tsc`, or any build/test command. A finding
must cite the manifest path and the line range of the offending
declaration (e.g. `package.json:14-19`).

23. **Declared dep with no source import.** Inspect:
    - `package.json` — the `dependencies` block (production deps).
      `devDependencies` and `peerDependencies` are out of scope for
      this check.
    - `deno.json` / `deno.jsonc` — the `imports` map.

    For each declared name, grep the source tree for a real import
    reference:
    - `import … from "<name>"` / `import "<name>"`
    - `import("<name>")` (dynamic import)
    - `require("<name>")`
    - `import.meta.resolve("<name>")`

    Search paths: `src/`, `lib/`, `worker/`, `tests/`, plus any
    additional roots declared in `tsconfig.json` `compilerOptions.paths`
    or `deno.json` `imports`. **Honour TypeScript path aliases** — a
    dep referenced only via a `paths` alias is in use, not dead.
    Sub-path imports (`import x from "<name>/sub"`) count as usage of
    `<name>`. Type-only `import type` references also count.

    Suggested fix: remove the entry from `package.json` /
    `deno.json`, then run the project's lockfile-refresh task
    (`npm install`, `pnpm install`, `deno cache --reload`, or the
    equivalent `bump-deps.sh` invocation) to regenerate the lockfile,
    and commit the manifest + lockfile change together. File at
    `severity:low` (hygiene) — bump to `severity:medium` only if the
    dead dep is itself a known-vulnerable package that the repo no
    longer needs.

## Deprecated config on framework bump

Config that survives a TypeScript version bump but is no longer
supported produces silent skew: the compiler ignores the removed option
(or errors on it), and the project drifts from the contract the author
believed they had. This check flags `tsconfig.json` `compilerOptions`
that the project's installed TypeScript version has deprecated or
removed.

**Hard constraint — static evidence only.** This check reads
`tsconfig*.json` and the TypeScript version pinned in `package.json` /
`deno.json` / the lockfile. The scanner **does not** invoke `tsc`,
`npm`, `pnpm`, or any build command. **Read the manifest to confirm the
project is actually on the version that removed the option — do not
guess.** Every finding is filed at `severity:medium` (silent skew after
a bump is the canonical risk) and must cite the `tsconfig.json` path and
the offending `compilerOptions` line range (e.g. `tsconfig.json:8-12`).
Use the standard `BP-<12 hex>` stable-id recipe (title slug plus the
primary file) so re-runs deduplicate.

24. **Deprecated / removed `compilerOptions` for the installed TS
    version.** Inspect `tsconfig*.json` `compilerOptions` and flag:
    - `suppressImplicitAnyIndexErrors` / `suppressExcessPropertyErrors`
      — **removed in TS 5.5**. Suggested fix: delete the option and
      address the underlying index / excess-property errors with
      explicit index signatures or types.
    - `importsNotUsedAsValues` / `preserveValueImports` — **superseded
      by `verbatimModuleSyntax` in TS 5.0**. Suggested fix: replace both
      with `"verbatimModuleSyntax": true`.
    - `keyofStringsOnly` — **removed in TS 5.5**. Suggested fix: delete
      it; `keyof` includes `number` and `symbol` keys by default.
    - `charset`, `out`, `noStrictGenericChecks`, `noImplicitUseStrict`,
      `prepend` — **long removed**. Suggested fix: delete `charset`
      (files are read as UTF-8); replace `out` with `outFile`; drop the
      remaining no-longer-honoured flags.
    - `baseUrl` paired with `paths` on TS 5.4+: since TS 5.4 `paths`
      resolves relative to `tsconfig.json` without `baseUrl`, and a
      stray `baseUrl` changes bare-specifier resolution in ways that
      surprise. Flag a `baseUrl` whose only purpose is to anchor
      `paths`. Suggested fix: drop `baseUrl` and keep `paths` (entries
      become relative to the config file), or scope `baseUrl` only if
      bare-import resolution genuinely needs it.

## Test classification — unit, integration, benchmark

A unit test is behavioural and parallel-safe, and it runs on every
change; a test that is slow or cannot run alongside its neighbours is
an integration test or a benchmark. `CODING-STANDARDS.md` holds the
normative unit / integration / benchmark definition — read it and cite
it rather than restating the taxonomy here. What it costs to classify a
test wrongly is measured, not hypothetical: on the repository that
maintains this scan the same Deno suite ran 42+ minutes sequentially,
against a 45-minute phase budget, and 2m23s under `--parallel` — an
18x difference held back entirely by tests that mutate process-wide
state.

**Hard constraint — static evidence only.** These checks read
`*_test.ts` sources and the `deno.json` tasks and workflow steps that
run them. The scanner **does not** invoke `deno test`, `deno bench`, or
any other command, and never times a test to decide that it is slow.
Every finding cites the test file and the line range of the offending
call, and uses the standard `BP-<12 hex>` recipe (title slug plus the
primary file) so re-runs deduplicate. File at `severity:low`, or
`severity:medium` when the test sits in the suite the repo runs on
every change.

**Already-tracked debt is silent.** Where the repo keeps a shrink-only
list of its known parallel-unsafe test files, or a manifest of the
integration tests its every-change suite excludes, a file on either
list is debt already accepted and bounded — do not re-file it. The
finding worth filing is the test that is recorded in neither.

**How a test asserts is not this bucket's business.** An absolute
wall-clock threshold inside a test is a `test-audit` finding — do not
file both. These checks are about where a test lives and what process
state it touches.

25. **Unit test mutates process-wide state.** Flag a `*_test.ts` file
    that calls `Deno.env.set`, `Deno.env.delete`, or `Deno.chdir`,
    whether inside a `Deno.test` body or at module scope. Deno's
    `--parallel` workers share one process, so the mutation races
    every other test running at that moment; the failure it produces
    is intermittent and lands on somebody else's unrelated change,
    which is the worst shape a gate failure can take. A `try` /
    `finally` that restores the previous value does not make it safe —
    the window between the two is exactly the race.

    Suggested fix: take the value as a parameter or an injected seam
    instead of mutating the process. A worked example, taken from the
    repository that maintains this scan rather than from the repo
    under review: `resolveDiskFloors` and `HostDiskMonitor` in
    `worker/deno/lib/host_disk.ts` each take an
    `env: (name: string) => string | undefined` reader, so the test
    supplies a lookup and mutates nothing:

        -Deno.env.set("VIBE_HOST_DISK_LOW_FLOOR_GB", "12");
        -const floors = resolveDiskFloors();
        +const floors = resolveDiskFloors((name) =>
        +  name === "VIBE_HOST_DISK_LOW_FLOOR_GB" ? "12" : undefined);

    `findIssuesByLabel` in `worker/deno/lib/find_issues_by_label.ts`
    is the same practice one level out: its GitHub command runner
    arrives as `options.ghCommandFn`, so the test hands it a stub
    rather than arranging a real `gh` on the process `PATH`.

    Where the code under test has no such seam, the fix is to add the
    parameter, not to move the mutation somewhere quieter.

26. **Unit test cannot finish within 10 seconds.** A unit test runs on
    every change, so it is budgeted in seconds; one that cannot hold
    to 10 seconds is an integration test or a benchmark and belongs in
    that category's home. Flag a `*_test.ts` file in the every-change
    suite that carries any of the shapes that put it over the budget:
    - spawning a process — `Deno.Command`, `Deno.run`, or a helper
      that drives one of the repository's own `.sh` / `.ps1` scripts.
      Where the repo already has a classifier for that shape, prefer
      its verdict over a fresh guess of your own;
    - waiting on wall-clock time — a `setTimeout` / sleep of seconds,
      a retry loop with real delays, a poll against a deadline;
    - reaching the network, or standing up a real server or container;
    - iterating enough work that the runtime is the point.

    Suggested fix: move the file into the repository's integration
    manifest and its `test:integration` task so per-PR CI keeps
    running it, or replace the real process, clock or socket with an
    injected seam and keep it in the every-change suite. Do not reduce
    an iteration count to squeeze a timing test under the budget —
    that yields a test that is both slow and no longer meaningful.

27. **Benchmark runs somewhere it cannot be trusted.** A benchmark's
    output is a duration, so it is only worth reading when the host is
    otherwise idle. Flag a benchmark that is wired into the quality
    gate, the default `deno test` run, or a CI job that shares a
    runner with other work, and flag benchmark run instructions that
    do not state the quiet-host requirement. Cite the task or workflow
    line that schedules it.

    Suggested fix: leave the benchmark reachable only on demand — a
    dedicated `deno task` or `deno bench` entry point, never a target
    the every-change gate reaches — and say in its documentation that
    it is run on an otherwise idle machine, never while parallel jobs
    occupy the host. A number produced under concurrent load is not a
    slow result; it is a result nobody can act on.
