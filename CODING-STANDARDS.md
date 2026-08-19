# 📐 Vibe Coder — Coding Standards

The single source of truth for coding standards and conventions in this
repository. There is **one set** of standards, shared by human contributors and
AI agents alike — no per-provider copy.

- **Why the system behaves as it does** — [Design Principles](DESIGN-PRINCIPLES.md).
- **User-facing overview & feature index** — [README](README.md).
- **Extending the worker (commands, prompts, tests)** — [docs/EXTENDING.md](docs/EXTENDING.md).
- **Contributing (branching, commits, local quality gate)** — [CONTRIBUTING.md](CONTRIBUTING.md).

## Language and Spelling

Use **Australian English** spelling throughout all code, comments, and
documentation.

Examples: colour, behaviour, organisation, favour, metre, centre, analyse,
summarise, authorised.

## Coding Principles

- **KISS** — Favour simplicity; avoid unnecessary complexity. Prefer the
  approach with fewer moving parts and less indirection, even if it costs a few
  more lines.
- **DRY** — Avoid code duplication; maintain a single source of truth.
- **Boy Scout Rule** — Leave the code cleaner than you found it.
- **Single Responsibility / Smaller Files** — Favour many smaller, focused
  source files over large monolithic ones. Three similar lines of code is better
  than a premature abstraction.
- **Avoid over-engineering** — Only make changes that are directly requested or
  clearly necessary. Do not add features, refactor code, or make "improvements"
  beyond what was asked.
- **Deno TypeScript for new logic** — All new business logic, decision-making,
  and data processing must be implemented in Deno TypeScript (`worker/deno/`),
  not in shell scripts. Shell scripts are for orchestration only (calling Deno
  commands, managing processes, invoking CLI tools like `gh` and `git`). When
  implementing a new feature, create a Deno command in `worker/deno/commands/`
  and call it from shell via `deno run`.

## Never Fail Silently — Fail Loud

Generated code must never fail silently. If an operation fails, it must surface
the fault immediately rather than swallowing it into a green result.

- **Surface every failure** — exit non-zero, throw with context, or emit a clear
  failure marker.
- **Do not swallow errors** — never catch-and-ignore an exception or discard a
  non-zero exit code. If you catch, handle it meaningfully or re-raise with
  context.
- **Absence of a success marker is not success** — a result is successful only
  when success is positively confirmed.
- **Prefer loud, early failure** over continuing in a degraded or partial state
  that hides the problem downstream.

## Test-Driven Development (TDD)

Follow TDD for all changes:

1. Write failing tests first that define the expected behaviour.
2. Implement the code to make the tests pass.
3. **Do NOT comment out or remove existing tests.** If business logic changes
   require test modifications, this must be explicitly documented.
4. Every test must exercise real code: source a module, call a function with
   test data, and assert on results, exit codes, or side effects. Tests should
   continue to pass when the implementation is refactored.
5. Do NOT write tests that grep source files for patterns, inspect function
   bodies, check documentation for keywords, verify line counts, or assert that
   one function calls another. These are not real tests. If a function requires
   external services to test, skip it rather than faking a test with grep.

### Examples

**Good** — calls a real function, checks the result:

```typescript
Deno.test("loadConfig - should parse repos from JSON config", async () => {
  const configPath = `${testTmpDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      repos: ["org/repo1", "org/repo2"],
    }),
  );
  const config = await loadConfig(configPath);
  assertEquals(config.repos[0], "org/repo1");
});
```

**Bad** — not a real test, greps source code instead of running it:

```typescript
// Breaks on refactor, verifies nothing useful
Deno.test("should have validateConfig function", async () => {
  const source = await Deno.readTextFile("lib/config.ts");
  assertMatch(source, /function validateConfig/);
});
```

### Test coverage expectations

Every new or modified public function should cover the happy path, at least one
error path, and the edge cases relevant to it (empty input, zero, maximum size,
unicode, etc.). For bug fixes, add a regression test that fails against the
unfixed code and passes after the fix, and state that linkage in the PR summary.

## Unit Tests vs Benchmarks

- **Unit tests are for functionality testing only** — verify that code produces
  correct results, not how fast it runs. Each test should finish well within the
  120-second budget; most in under 10 seconds.
- **Benchmarks are for performance testing** — use dedicated benchmarks to
  measure and compare execution time.
- **Why this matters** — unit tests run in parallel with other tests, making
  performance measurements unreliable.
- **Do not** reduce iteration counts to make "performance tests" faster in unit
  tests. If you need to confirm performance, create proper benchmarks and
  include results in the PR summary.

## Quality Gates

Run `./quality.sh < /dev/null` after making changes and fix any issues it
reports. Keep running it until it passes cleanly. The quality gate is implemented
in Deno TypeScript (`worker/deno/quality.ts`) and runs prompt-immutability,
benchmark-audit, pages-liquid, markdownlint, `deno test`, `deno lint`,
`deno check`, and `deno fmt --check`. Shellcheck is deliberately not run here —
bash linting is owned by each repo's own CI (Issue #3129). See
[CONTRIBUTING.md → Local quality gate](CONTRIBUTING.md) for how to install the
optional checks (Ruby + `liquid`, `markdownlint-cli2`).

**All quality checks MUST pass before creating a PR.** The worker runs
`./quality.sh` before creating any PR; CI re-runs the same checks. Never raise a
PR with failing quality checks — fix the failures first.

Always redirect stdin from `/dev/null` when running tests, quality checks, or
build commands on unattended machines (`./quality.sh < /dev/null`,
`npm test < /dev/null`) so a tool that unexpectedly reads stdin fails fast
instead of hanging.

## Prompt Template Versioning

Prompt templates in `prompts/` are **immutable once committed**. Do NOT modify
an existing version file — create a new version instead. The worker always loads
the latest version at runtime. `quality.sh` enforces immutability. See
[docs/EXTENDING.md → Prompt Versioning and Templates](docs/EXTENDING.md) for the
full workflow.

### Documentation references to prompt versions

Published documentation must refer to prompts by **directory name only** —
`prompts/<type>/` — so it stays fresh as new versions are added. When you
genuinely need to name a specific version, use the wording **"from vN onward"**
rather than a literal `prompts/<type>/vN.md` filename. The `docs prompt versions`
quality check enforces this.

## Deno / TypeScript Conventions

All business logic lives in `worker/deno/` as type-safe TypeScript. New logic
must be written in TypeScript, and all tests use `deno test` with `@std/assert`.

- **`Result<T, E>`** — Discriminated union for consistent error handling:
  `{ ok: true; value: T } | { ok: false; error: E }`. Use it instead of throwing
  for control flow.
- **Strict TypeScript** — all strict compiler options are enabled.
- **`@std/assert`** for tests — no external test frameworks.
- **Config defaults** live in `worker/deno/lib/config_defaults.ts` — the single
  source of truth.

Each module has a corresponding test file (e.g. `lib/config.ts` →
`tests/config_test.ts`). For the command pattern, the `Command` /
`CommandResult<T>` interfaces, registry error handling, and step-by-step
instructions for adding a command, see
[docs/EXTENDING.md](docs/EXTENDING.md).

## Commit Safety — never commit hidden files

Hidden files (any path matching `.*`) routinely carry secrets — `.env`, API
keys, OAuth tokens, SSH keys. Never stage or commit a hidden path outside the
small allowlist.

**Allowlist — the only hidden paths that may ever be tracked:** `.gitignore`,
`.gitattributes`, `.github/` (workflow YAML), `.markdownlint-cli2.jsonc`.

**Always-forbidden patterns:** `.env`, `.env.*`, `.config.json`, `.config*.json`,
`*.secret.json`, `.secrets/`, `.aws/`, `.ssh/`, `.gnupg/`, `.netrc`, and any
other hidden file not on the allowlist.

**Also forbidden — private key material and credential files (Issue #3660):**
`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_rsa.*`, `credentials.json`,
`service-account*.json`. These are not hidden files, so the `.*` rule never
covered them — the worker reads a GitHub App private key from disk, and a
`.pem` left in a working tree would otherwise be staged by `git add -A`. If a
repo intentionally tracks a fixture matching one of these patterns, negate it
explicitly (e.g. `!tests/fixtures/*.pem`) rather than dropping the broad rule.

- Before every commit, run `git diff --cached --name-only` and confirm no hidden
  path is staged except those on the allowlist. Remove accidents with
  `git reset HEAD <file>`.
- **Never use `git add -f`** to bypass `.gitignore`, and never bypass the
  pre-commit safety gate with `git commit --no-verify`.
- If a hidden file legitimately needs tracking, raise an issue and update the
  allowlist in `worker/deno/lib/gitignore_enforcer.ts` via PR.

## Secret Redaction — Every Outbound Sink

Commit Safety keeps secrets out of the repo; this keeps them out of everything
the worker *emits*. There is **no global redaction chokepoint** — redaction is
applied **per-sink** as defence-in-depth. Every public or permanent outbound
sink (logs, issue/PR comments, crash and failure notifications, the answer
sanitiser) must independently route its text through `redactSecrets()` from
`worker/deno/lib/secret_redaction.ts`, and a new credential shape must be added
as a rule in that module so every sink inherits the coverage. Wiring a new sink
to `redactSecrets()` is part of adding it, not a follow-up.

The full standard, the list of sinks already wired, and the rationale live in
[SECURITY.md → Secret Redaction — Every Outbound Sink](SECURITY.md#-secret-redaction--every-outbound-sink).

## A Code Change Owes a Docs Change

When you rename a symbol, change a signature or a default, add or remove a flag,
or change a documented command, grep the repo's docs for the old name and update
every surface that mentions it — README, `docs/`, operator manuals, prompt
templates, and agent instructions — in the same change. Do it before the commit,
not after a reviewer (or an idle-task documentation scan, weeks later) finds it.

## Commit Messages

Reference the issue number in all commit messages (e.g.,
`Fix: Description (Issue #42)`). Add a `Vibe-Coder-Run-Id` trailer to every
worker-authored commit.

## PR Summary and Evidence

At the end of your work, after all commits are complete, create
`docs/archive/pr-summaries/pr-summary-{issue_number}.md` — the canonical home
for every PR summary — containing:

1. **Summary** — What was changed and why, including the `Closes #<n>` keyword.
2. **Evidence** — Screenshots (saved to `docs/evidence/`) for UI changes,
   before/after benchmark results for performance changes, or test references
   for bug fixes. If visual evidence cannot be provided, state why.
3. **Test Plan** — Tests added or modified.

For changes to architecture, workflows, or sequence of events, include a
**Mermaid** diagram in a fenced ` ```mermaid ` block — it renders natively on
GitHub and often tells the story better than prose.

You may write Liquid-looking syntax (`{% ... %}`, `{{ ... }}`) freely in
published Markdown prose — the Pages build wraps every published body in a Liquid
raw block. Do not write the literal raw open/close markers themselves in prose;
Liquid does not support nested raw blocks.

## Available Tools

The following tools are installed, authenticated, and available — use them
proactively:

- **GitHub CLI (`gh`)** — for all GitHub operations (issues, PRs, comments, API
  access). Prefer `gh` over web scraping or raw API calls.
- **Playwright MCP (headless browser)** — for browser automation: navigating
  URLs, inspecting pages, taking screenshots (save to `docs/evidence/`), and
  interacting with web interfaces.

## Prompt Engineering Guidance

The top-tier reasoning phases route to the current top model generation —
**Fable 5**, with automatic fallback to **Opus 5** when Fable is unavailable
(see docs/MODEL-AND-CACHING.md for the per-phase
routing chain and the Fable-unavailable self-heal). The guidance below is
model-generation-agnostic good practice for authoring prompt templates and
agent instructions; it is not tied to any superseded model. Where a rule does
depend on the model generation, it defers to
Model-generation prompt tuning,
which records what each generation needs and what was tried and reversed.

- **Write precise, unambiguous instructions.** State exactly what you want done
  and to which items. Avoid vague qualitative language such as "appropriate" or
  "as needed" — replace it with concrete criteria. If a rule applies to multiple
  items, list each item explicitly rather than expecting generalisation.
- **Calibrate response length.** When shorter output is desired, say so
  explicitly ("Summarise in one sentence"). Do not add padding instructions to
  force longer output.
- **Match verification scaffolding to the model generation.** An explicit
  self-verification checkpoint ("After generating code, review your output for
  correctness before proceeding") helps a generation that does not self-verify;
  on a generation that already does — Opus 5 — it is redundant and encourages
  over-work, which is why the current templates omit it. Check
  Model-generation prompt tuning
  before adding or removing such scaffolding.
- **State when and why a tool should be used** rather than assuming the model
  reaches for it — e.g. "Use the `gh` CLI to check the current PR status".
- **Mind the token economy.** Reduce redundancy — a single clear statement beats
  the same instruction paraphrased three ways.
- **Prefer positive instructions over negative ones.** "Use Australian English
  spelling" is more effective than "Do not use American English spelling".
- **Structure prompts with clear sections** — headings and bullet points aid
  literal parsing.

## Configuration

The worker is configured via `.config.json` (gitignored) — configuration is
**operator-side only**; target repositories carry no worker configuration. See
[Configuration Reference](docs/CONFIGURATION.md) for details and
[SECURITY.md](SECURITY.md) for security-related configuration guidance.
