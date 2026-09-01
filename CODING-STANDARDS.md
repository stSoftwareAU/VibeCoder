# 📐 Vibe Coder — Coding Standards

The single source of truth for coding standards and conventions in this
repository. There is **one set** of standards, shared by human contributors and
AI agents alike — no per-provider copy.

- **Why the system behaves as it does** —
  [Design Principles](DESIGN-PRINCIPLES.md).
- **User-facing overview & feature index** — [README](README.md).
- **Extending the worker (commands, prompts, tests)** —
  [docs/EXTENDING.md](docs/EXTENDING.md).
- **Contributing (branching, commits, local quality gate)** —
  [CONTRIBUTING.md](CONTRIBUTING.md).

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

### Fake the external service, do not assert the request

When a function's only observable effect is a call to an external API, do not
assert the _text_ of the request it builds. A test written from the same mental
model that produced the request cannot disagree with its author: Issue #470
shipped a reversed `Ref.compare` and the test that pinned the reversed query
text passed for the whole life of the defect.

Write a fake that models the external API's own rules and assert on the decision
the worker reaches. `worker/deno/tests/support/github_graphql_fake.ts` is the
worked example — it resolves aliases, honours `first:` (head) versus `last:`
(tail) and returns `null` for what it cannot resolve, so a query asked the wrong
way round receives a truthfully wrong answer and the test goes red.

### Never fire a real process-group signal from a test

A test may spawn a real subprocess and let the production code kill it — that is
the only way the watchdogs are covered end to end. It must not arrange for the
signal to be a **group** signal (`kill -TERM -<pgid>`). Put the stub in the
`deno test` process group and `terminateProcessTree` refuses the group signal by
design, leaving the PID signal plus `terminateDescendants`; give the stub its
own session (`setsid`) and the group signal genuinely fires inside the CI VM,
where a single mis-read PGID takes the whole runner down.

That is not hypothetical. Three test files gave their stubs a session; the shard
split kept them one-per-shard until it did not, and the moment two landed in the
same job `validate (tests 4/4)` died mid-file with "The runner has received a
shutdown signal" at the instant of the second file's first kill — four times
running, on four different commits. The group-signalling logic itself is covered
by `worker/deno/tests/pid_guard_test.ts`, which asserts the exact signal targets
through injected seams and needs no real process at all.

### Never signal a pid you cannot prove is still yours

A pid is a handle the kernel re-issues the moment its process is reaped, so
evidence gathered earlier (a `pgrep -P` sweep, a `ps` liveness probe) can name a
stranger by the time the signal is sent. Fingerprint the process while it is
provably yours — `captureProcessIdentity` in
[`pid_guard.ts`](worker/deno/lib/pid_guard.ts) records its start time — and
re-verify with `isSameProcess` immediately before every signal, TERM and KILL
alike. Unproven means no signal, never "go ahead".

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
- **Guard super-linearity by shape, not by clock** — catastrophic backtracking
  has no wrong output, only a runtime one, so a few tests must measure. Use
  [`tests/support/growth.ts`](worker/deno/tests/support/growth.ts)
  (`assertLinearGrowth`), which times the same work at size N and 4N and fails
  only when the cost grew faster than the input. A slower fleet host inflates
  both readings and stays green; an absolute millisecond budget does not
  (Issue #530).

## Quality Gates

Iterate with the fast checks — `deno fmt`, `deno lint`, `deno check`, and only
the test files your change touches. Run `./quality.sh < /dev/null` **once, in
the foreground**, before raising the PR and fix what it reports; re-run it after
a fix, never on a timer. Never background it behind a `sleep`/`pgrep` poll loop
— that spends the whole budget waiting (Issue #399). It streams one line per
check as each settles, so a slow run is visibly alive rather than
indistinguishable from a hung one. The quality gate is implemented in Deno
TypeScript (`worker/deno/quality.ts`) and runs prompt-immutability,
benchmark-audit, pages-liquid, markdownlint, semgrep, `deno test`, `deno lint`,
`deno check`, and `deno fmt --check`. The semgrep stage runs the same
`p/default` ruleset as the blocking `semgrep.yml` PR check, over the branch's
changed files only, so a SAST finding is met before the push rather than after
it (Issue #559). Shellcheck is deliberately not run here —
bash linting is owned by each repo's own CI. See
[CONTRIBUTING.md → Local quality gate](CONTRIBUTING.md) for how to install the
optional checks (Ruby + `liquid`, `markdownlint-cli2`, `semgrep`).

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
rather than a literal `prompts/<type>/vN.md` filename. The
`docs prompt versions` quality check enforces this.

## Language-Agnostic Standards vs Per-Language Buckets

This document and the injected `prompts/coding_guidelines/` template carry the
**language-agnostic** rules — fail-loud, security, commit safety, TDD, quality
gates. They apply to every run in every repository.

**Language-specific** rules live in per-language best-practice buckets under
[`prompts/best_practices/buckets/`](prompts/best_practices/buckets/) and are
injected only when the repository uses that language, so a Rust repo receives
the Rust rules and a TypeScript repo does not.
[`worker/deno/lib/best_practices_bucket_picker.ts`](worker/deno/lib/best_practices_bucket_picker.ts)
selects the bucket from the languages detected in the repository
([`language_detector.ts`](worker/deno/lib/language_detector.ts)). The operator
manual is [docs/BEST-PRACTICES-SCAN.md](docs/BEST-PRACTICES-SCAN.md).

| Bucket                                                                       | Covers                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`rust`](prompts/best_practices/buckets/rust.md)                             | Error handling, ownership and lifetimes, `unsafe`, Cargo build profiles |
| [`typescript`](prompts/best_practices/buckets/typescript.md)                 | Type safety, `tsconfig` strictness, lint rules, module structure        |
| [`java`](prompts/best_practices/buckets/java.md)                             | Effective Java items, style guide conformance, API design               |
| [`react`](prompts/best_practices/buckets/react.md)                           | Hooks rules, rendering and state, component accessibility               |
| [`html`](prompts/best_practices/buckets/html.md)                             | Living-standard markup, WCAG and ARIA accessibility                     |
| [`terraform`](prompts/best_practices/buckets/terraform.md)                   | Module composition, state handling, provider/version pinning            |
| [`aws-cloudformation`](prompts/best_practices/buckets/aws-cloudformation.md) | Well-Architected pillars, template structure, stack safety              |
| [`general`](prompts/best_practices/buckets/general.md)                       | Repo-level hygiene only — never language-specific code quality          |
| [`design`](prompts/best_practices/buckets/design.md)                         | Language-agnostic design smells (Fowler ch. 3), reported as judgement calls |

Two buckets name no language: `general` scores repo-level hygiene, and
`design` scores the shape of the code — naming, coupling, cohesion,
delegation — against the twelve named smells from _Refactoring_ ch. 3. Both
compete with the dominant detected language when the bucket is picked, so a
repo in a language with no bucket of its own still receives design feedback.

**Which surface does a new rule belong on?** If it holds regardless of language,
it belongs here. If it names a language, a framework, or their tooling, it
belongs in that language's bucket. If it is a design judgement that holds in
any language — a smell rather than a rule — it belongs in the `design` bucket.

**Worked example.** "Never `unwrap()`" is a Rust rule, so it is not in this
document: [`buckets/rust.md`](prompts/best_practices/buckets/rust.md) carries
"prefer `?` propagation and `Result` over `unwrap()` / `expect()` outside tests,
examples, and clearly unreachable branches". Searching here for "unwrap" or
"Rust" should land you on that file in one hop — that is the whole point of this
section.

Every bucket file must be listed above, and every link must resolve:
`worker/deno/tests/bucket_docs_test.ts` fails CI when a new bucket is added
without documenting it here.

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
instructions for adding a command, see [docs/EXTENDING.md](docs/EXTENDING.md).

## Commit Safety — never commit hidden files

Hidden files (any path matching `.*`) routinely carry secrets — `.env`, API
keys, OAuth tokens, SSH keys. Never stage or commit a hidden path outside the
small allowlist.

**Allowlist — the only hidden paths that may ever be tracked:** `.gitignore`,
`.gitattributes`, `.github/` (workflow YAML), `.markdownlint-cli2.jsonc`.

**Always-forbidden patterns:** `.env`, `.env.*`, `.config.json`,
`.config*.json`, `*.secret.json`, `.secrets/`, `.aws/`, `.ssh/`, `.gnupg/`,
`.netrc`, and any other hidden file not on the allowlist.

**Also forbidden — private key material and credential files:** `*.pem`,
`*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_rsa.*`, `credentials.json`,
`service-account*.json`. These are not hidden files, so the `.*` rule never
covered them — the worker reads a GitHub App private key from disk, and a `.pem`
left in a working tree would otherwise be staged by `git add -A`. If a repo
intentionally tracks a fixture matching one of these patterns, negate it
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
the worker _emits_. There is **no global redaction chokepoint** — redaction is
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
**Mermaid** diagram in a fenced `` ```mermaid `` block — it renders natively on
GitHub and often tells the story better than prose.

You may write Liquid-looking syntax (`{% ... %}`, `{{ ... }}`) freely in
published Markdown prose — the Pages build wraps every published body in a
Liquid raw block. Do not write the literal raw open/close markers themselves in
prose; Liquid does not support nested raw blocks.

## Available Tools

The following tools are installed, authenticated, and available — use them
proactively:

- **GitHub CLI (`gh`)** — for all GitHub operations (issues, PRs, comments, API
  access). Prefer `gh` over web scraping or raw API calls.
- **Playwright MCP (headless browser)** — for browser automation: navigating
  URLs, inspecting pages, taking screenshots (save to `docs/evidence/`), and
  interacting with web interfaces. Wired into a run only when that run needs a
  browser — a `needs-screenshot` issue, or a repo configured with
  `requiresScreenshots` (Issue #192); a backend run is given no browser tool.

## Prompt Engineering Guidance

The guidance below is model-generation-agnostic good practice for authoring
prompt templates and agent instructions; it names no model generation by design.
Which generation runs which phase — the per-phase routing chain and the
self-heal that reroutes when the top-tier generation is unavailable — is
recorded once, in [Model Selection](docs/MODEL-AND-CACHING.md#model-selection).
Where a rule does depend on the model generation, it defers to
[Model-generation prompt tuning](docs/MODEL-AND-CACHING.md#model-generation-prompt-tuning),
which records what each generation needs and what was tried and reversed.
`worker/deno/tests/coding_standards_model_agnostic_test.ts` fails the quality
gate if a model-generation name reappears in this document.

- **Write precise, unambiguous instructions.** State exactly what you want done
  and to which items. Avoid vague qualitative language such as "appropriate" or
  "as needed" — replace it with concrete criteria. If a rule applies to multiple
  items, list each item explicitly rather than expecting generalisation.
- **Calibrate response length.** When shorter output is desired, say so
  explicitly ("Summarise in one sentence"). Do not add padding instructions to
  force longer output.
- **Match verification scaffolding to the model generation.** An explicit
  self-verification checkpoint ("After generating code, review your output for
  correctness before proceeding") helps a generation that does not self-verify.
  Add it only for such a generation and omit it for one that self-verifies
  unprompted, where the ritual re-check is redundant and encourages over-work —
  the reason the current templates omit it. Check
  [Model-generation prompt tuning](docs/MODEL-AND-CACHING.md#model-generation-prompt-tuning)
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
