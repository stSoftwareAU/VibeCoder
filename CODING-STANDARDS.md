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

### Never let a unit test inherit the host's state

A unit test that reads ambient environment gets a different answer on every
machine, and inside the container it gets the running fleet's own state. The
worker exports `WORK_DIR`, `runCoreLoop` falls back to it for state that
outlives a run, and every suite driving the loop without naming its own work
directory therefore read and wrote the live
`idle_disagreement_streak.json` — four `--parallel` test processes sharing one
file, each resetting the others' streak, and the operator's real state
overwritten with test timestamps (Issue #1098). Name the directory, the config
path and the clock the test wants; the gate scrubs `CONFIG_PATH` and `WORK_DIR`
from the test stage so an unnamed one degrades to memory rather than to the
host.

The same rule covers process-global caches: a module singleton keyed by a
counter that restarts at 1 in every consumer serves one test's result to the
next file in the same worker. Key it by something only its own owner can
produce.

### Rendezvous, never sleep, to prove concurrency

"N ran at once" is not provable with `await new Promise((r) => setTimeout(r,
10))`: on an idle laptop ten milliseconds is ample, and under the gate's own
parallel suite the first participant finished before the third had started, so
a correct pool was reported as `expected 3 concurrent, saw 2`. Use
[`tests/support/rendezvous.ts`](worker/deno/tests/support/rendezvous.ts)
(`createRendezvous`), where each participant waits until every expected one has
arrived: a loaded host only makes the wait longer, never the answer different.
The wait is bounded, so a participant that never arrives fails the assertion
instead of hanging the suite.

### Test coverage expectations

Every new or modified public function MUST have tests covering the happy path,
at least one error path, and the edge cases relevant to it (empty input, zero,
maximum size, unicode, etc.). For bug fixes, add a regression test that fails against the
unfixed code and passes after the fix, and state that linkage in the PR summary.

## Unit, Integration and Benchmark Tests

Every test in this repository is exactly one of three things, and the category
decides which runner it belongs to and how often it runs. The classification is
implemented, not merely described:
[`lib/integration_test_manifest.ts`](worker/deno/lib/integration_test_manifest.ts)
and
[`lib/parallel_unsafe_test_manifest.ts`](worker/deno/lib/parallel_unsafe_test_manifest.ts)
hold the classifiers, `lib/unit_test_passes.ts` builds the gate's suite out of
them, and a file the prose and the manifests disagree about fails a test.
Classify from the rules below; if the machinery then disagrees with you, one of
the two is wrong and that disagreement is the finding.

### Unit tests

A unit test is **behavioural**, **self-contained**, **fast** and
**parallel-safe**, and it runs on every change.

- **Behavioural** — it asserts what the code does, never how fast it runs. A
  test whose output is a duration is a benchmark.
- **Self-contained** — it needs nothing the repository does not carry itself:
  no PowerShell, no container runtime, no network, no provisioned credentials,
  and it does not copy one of this repository's own `.sh`/`.ps1` scripts into a
  temporary tree and spawn it. That last clause is the boundary the code draws:
  `isIntegrationTestSource` claims any test that builds a path to a repository
  script, and a claimed file is an integration test.
- **Fast** — it finishes within 10 seconds. Nothing times a unit test at run
  time, so the rule is enforced by shape rather than by stopwatch: a wall-clock
  sleep, a retry loop against the real clock, a polling wait or a spawned
  script is a `test-audit` finding (check 13) whatever the test happens to cost
  on your machine.
- **Parallel-safe** — it does not mutate process-wide state (`Deno.env.set`,
  `Deno.env.delete`, `Deno.chdir`, or a module-level singleton the rest of the
  suite reads). Take the value as a parameter or an injected seam instead.
  [`tests/parallel_safety_cap_test.ts`](worker/deno/tests/parallel_safety_cap_test.ts)
  fails and names your file the moment a new test breaks this (Issue #880), and
  the remedy is the seam — never a serial annotation, never a new manifest
  entry.

Unit tests run in the gate's `deno tests` stage and under `deno task test:unit`,
as two passes over disjoint halves of one scope: everything parallel-safe under
`--parallel`, then the rest one at a time.

**A unit test that cannot run in parallel is still a unit test.** It is capped
debt, not a reclassification. Exactly three reasons put a file in the serial
pass: it mutates process state, it asserts on a real elapsed reading, or it
races a real subprocess for the scheduler. All three are listed in
`PARALLEL_UNSAFE_TEST_FILES`, and the mutator half of that list is **empty and
must stay empty**. A serially-run unit test is a full member of the unit
verdict, and one of them — the SIGKILLed-agent case in
`claude_runner_killed_test.ts` — is what caught the orphan-collector defect of
Issue #1135.

- **Do not** reduce iteration counts to make a "performance test" fast enough
  to pass as a unit test. If you need to confirm performance, write a benchmark
  and include the results in the PR summary.
- **Guard super-linearity by shape, not by clock** — catastrophic backtracking
  has no wrong output, only a runtime one, so a few tests must measure. Use
  [`tests/support/growth.ts`](worker/deno/tests/support/growth.ts)
  (`assertLinearGrowth`), which times the same work at size N and 4N and fails
  only when the cost grew faster than the input. A slower fleet host inflates
  both readings and stays green; an absolute millisecond budget does not
  (Issue #530). The rule in one line: **compare two readings of the same work,
  never a reading against a constant.** A ratio assertion is permitted and is
  not a `test-audit` finding; an absolute wall-clock threshold is forbidden and
  is one (Issue #786). Such a test measures deliberately, so it runs in the
  serial pass — and it is still a unit test.

### Integration tests

An integration test **drives one of the repository's own scripts**: it copies a
real `.sh` or `.ps1` into a temporary directory, builds a stub `PATH`, spawns
`bash` or `pwsh`, and asserts on the captured output. That is the whole
criterion, and `lib/integration_test_manifest.ts` applies it —
`isIntegrationTestSource` classifies, `INTEGRATION_TEST_FILES` lists, and
`integration_test_manifest_test.ts` fails when the two disagree in either
direction.

An integration test **may need what a unit test may not**: a provisioned
interpreter, a container runtime, `git`, the network, real credentials. That
prerequisite must be named and enforced loudly, never skipped in silence.
`tests/setup_ps1_test.ts` resolves PowerShell once and marks its cases
`ignore` when it is absent — and both CI jobs that would run it fail the build
when `pwsh` is missing, rather than reporting a green suite that tested nothing.

Integration tests are **excluded from every quality run**. Both unit passes
ignore them, because they cost roughly a third of the gate's wall time and ran
on changes that cannot reach them (Issue #907). They run in per-PR CI, where
the environment is provisioned and sharding absorbs the cost, and on demand
with `deno task test:integration`.

A test that **reads** a repository script without running it is a unit test,
not an integration test — but the classifier still claims it, so it must be
named in `SCRIPT_READING_UNIT_TESTS` with a reason. Neither list is a default:
a file the classifier claims is placed in one or the other deliberately.

### Benchmarks

A benchmark's output is a **duration, not a pass/fail assertion**. It exists to
compare two configurations of the same workload — host against container,
before a change against after — and it reports numbers for a human or a
dashboard to read.

Benchmarks live in [`lib/benchmark.ts`](worker/deno/lib/benchmark.ts) behind
the `benchmark` command
([`commands/benchmark.ts`](worker/deno/commands/benchmark.ts)), never in
`tests/`. They are **run on demand only**, never as part of a quality run, and
never while parallel worker jobs occupy the host: a timed workload sharing a
machine with other work measures the load, not the code, so a busy machine
makes the timings meaningless. Run one on a **quiet machine** or do not run it
at all.

A benchmark disguised as a unit test is a gate failure, not a style point. The
benchmark-audit stage scans `worker/deno/tests/` and fails any `Deno.test`
whose name contains `benchmark` or `bench_` (Issue #583).

### When a test does not fit

Take the seam, do not reclassify. A slow unit test is fixed with an injected
clock, a fake scheduler or an injected process runner; a parallel-unsafe one is
fixed by taking the value as a parameter. Moving a file into the integration
manifest to escape a rule it could have met is how a suite quietly stops
running on every change, and re-adding a mutator to the parallel-unsafe
manifest is the thing that manifest exists to prevent.

If the seam genuinely is not available — the test really does need `pwsh`, a
container runtime or the network — it is an integration test and belongs in
`INTEGRATION_TEST_FILES`. If what you want is a number rather than an
assertion, it is a benchmark and belongs behind the `benchmark` command. State
which of the three you chose, and why, in the PR summary.

## Quality Gates

Iterate with the fast checks — `deno fmt`, `deno lint`, `deno check`, and only
the test files your change touches. Run `./quality.sh < /dev/null` **once, in
the foreground**, before raising the PR — provided the run budget covers it,
see below — and fix what it reports; re-run it after a fix, never on a timer.
Never background it behind a `sleep`/`pgrep` poll loop
— that spends the whole budget waiting (Issue #399). It streams one line per
check as each settles, so a slow run is visibly alive rather than
indistinguishable from a hung one. The quality gate is implemented in Deno
TypeScript (`worker/deno/quality.ts`) and runs benchmark-audit, pages-liquid,
markdownlint, semgrep, the release-tag ruleset reconciliation, `deno test`,
`deno lint`, `deno check`, and `deno fmt --check`. The semgrep stage runs the same
`p/default` ruleset as the blocking `semgrep.yml` PR check, over the branch's
changed files only, so a SAST finding is met before the push rather than after
it (Issue #559). Shellcheck is deliberately not run here —
bash linting is owned by each repo's own CI. See
[CONTRIBUTING.md → Local quality gate](CONTRIBUTING.md) for how to install the
optional checks (Ruby + `liquid`, `markdownlint-cli2`, `semgrep`).

**A quality run executes the unit suite only** — no integration tests, no
benchmarks. Its `deno test` stage is the two unit passes and nothing else:
both of them ignore `INTEGRATION_TEST_FILES` (Issue #907), and no gate has
ever run a benchmark. Integration tests are covered by per-PR CI, which runs
every test file across four shards on a runner provisioned for them; run them
locally with `deno task test:integration` when your change touches a script
they drive. A green quality run therefore says nothing about the integration
suites, and is not meant to.

**All quality checks MUST pass before creating a PR.** The worker runs
`./quality.sh` before creating any PR; CI re-runs the same checks. Never raise a
PR with failing quality checks — fix the failures first.

**The agent's own run of the gate is conditional on the run budget (Issue
#1138).** The gate's median observed run is 17 minutes inside a budget of
roughly an hour, and the same checks arrive twice more for free — the worker
runs the gate itself before the PR, and CI runs it on the PR. So an agent
starts the gate only when the runway left covers it plus the time to fix,
commit and push what it reports; the worker writes `.vibe-run-budget.md` into
the checkout the moment it no longer does, and refuses the gate there. A gate
skipped for budget is **recorded, never silent**: the
`<!-- vibe-quality-gate-skipped … -->` note goes in the PR summary (or
`.pr_response_message`), because a gate nobody ran reads exactly like a gate
that passed. That is not a licence to raise a PR over a *failing* check — the
rule above is unchanged for every check that actually ran. See
[docs/CONFIGURATION.md → The full gate is conditional on the budget left](docs/CONFIGURATION.md#the-full-gate-is-conditional-on-the-budget-left-issue-1138).

Always redirect stdin from `/dev/null` when running tests, quality checks, or
build commands on unattended machines (`./quality.sh < /dev/null`,
`npm test < /dev/null`) so a tool that unexpectedly reads stdin fails fast
instead of hanging.

## Prompt Templates

Each prompt type has exactly one editable template — `prompts/<type>/prompt.md`
— which the worker loads at runtime. Edit it in place. There is no `vN.md`
versioning and no immutability rule: the repo is public, so **git history is the
record** of how a template evolved (`git log -p prompts/<type>/prompt.md`), and a
run's traceability comes from the checkout's commit hash, which the execute phase
logs. See
[docs/EXTENDING.md → Prompt Templates](docs/EXTENDING.md) for the full workflow.

Published documentation refers to prompts by path — `prompts/<type>/prompt.md`
or the directory alone — never by a version number.

## Language-Agnostic Standards vs Per-Language Buckets

This document and the injected `prompts/coding_guidelines/` template carry the
**language-agnostic** rules — fail-loud, security, commit safety, quality
gates. They apply to every run in every repository.

Test-first TDD is **not** in that injected block. It rides the `issue` and
`pr_feedback` phase prompts, so the phases that receive only the injected
guidelines — `spelling_fix`, `ci_fix`, `merge_conflict`, `workflow_setup` —
carry the coverage expectations above but no test-first ordering requirement.

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
`.gitattributes`, `.github/` (workflow YAML), `.vscode/` (shared editor
settings), `.markdownlint-cli2.jsonc`. These are the five entries
`REQUIRED_GITIGNORE_PATTERNS` re-allows in
`worker/deno/lib/gitignore_enforcer.ts`, which is what writes each repository's
`.gitignore`; this list and `prompts/coding_guidelines/` restate it, and
neither may drift from it.

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
