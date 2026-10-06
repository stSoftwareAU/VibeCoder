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
  more lines. Work down the **smallest-change-first ladder** and stop at the
  first rung that solves the problem: skip what is not needed, reuse what the
  codebase has, use the standard library, use a native platform feature, use a
  dependency already installed, write one line, and only then write new code.
  The floor is never cut: input validation at a trust boundary, error handling
  that prevents data loss, security, accessibility, and whatever the issue
  explicitly asks for all stay in — see
  [Never Fail Silently — Fail Loud](#never-fail-silently--fail-loud) below and
  [SECURITY.md](SECURITY.md). Mark each deliberate corner cut with exactly one
  comment line opening with `// SIMPLE-ON-PURPOSE:` — the ceiling first, then
  the condition that lifts it after `upgrade when` — so
  `grep -r SIMPLE-ON-PURPOSE` lists every cut:
  `// SIMPLE-ON-PURPOSE: linear scan, fine to 10,000 rows — upgrade when a table exceeds 10,000 rows`.
- **DRY** — Avoid code duplication; maintain a single source of truth.
- **Boy Scout Rule** — Leave the code cleaner than you found it.
- **Single Responsibility / Smaller Files** — Favour many smaller, focused
  source files over large monolithic ones.
- **Avoid over-engineering** — Only make changes that are directly requested or
  clearly necessary. Do not add features, refactor code, or make "improvements"
  beyond what was asked. Reviewing a diff, flag these four departures
  explicitly: a standard-library function reinvented by hand, a dependency
  added when an installed one or the standard library already does the job,
  an abstraction with a single implementation, and an in-repo helper,
  component or policy re-implemented by hand instead of called — when that
  owner is private, widen its visibility rather than copy it.
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

## Automation and Shared GitHub State

**Remove only what you can prove you added.** Before automation removes or
releases a label (or similar shared GitHub state), it must have recorded
provenance at add time: the label was absent before the add, or a marker
comment or log entry this code path wrote. An idempotent add succeeding is not
provenance — `gh issue edit --add-label` and `gh pr edit --add-label` succeed
whether or not the label was already there. Labels such as `needs-human`,
`failed` and `failed-once` can come from several actors (a human, another
worker lane, claim churn); when ownership cannot be proven, leave the label
alone.

- **Record provenance at add time** — read the labels before the add and
  remember only a label that was absent, or match a marker this code path wrote
  under its own heading, not every heading that applies the same label.
- **Test the pre-existing case** — add a test where the label already exists
  before the add, and assert that it is not removed later.

Past regressions: a release sweep that counted only one comment heading while
another path applied the same labels (#2938), a `needs-human` flag set after an
idempotent `gh pr edit --add-label` (#2949), and stall repair ignoring a
hand-applied `needs-human` (#2866).

## Log Levels Are a Promise About What the Reader Must Do

A log level tells the person scanning a fleet log what to do next. Use them
for that and nothing else:

- **INFO** — the expected path, including an expected absence ("no transcript:
  the run succeeded and transcripts are kept on failure only"). Nothing to do.
- **WARNING** — something is degraded and the run **continues**, and someone
  should act before it gets worse: "disk filling up, clean up", a refused trim,
  a retry that is being taken. Read it soon.
- **ERROR** — the run, handler or launch **cannot continue** from here: "we are
  offline", the build failed, the phase is failed. Read it now.

Neither WARNING nor ERROR ever means "everything is fine". A line that fires on
the normal path at WARNING or ERROR trains every reader to ignore the level, and
the real "disk filling up" or "we are offline" line is lost in it. A condition
the code goes on to handle — a pool that drains and resumes, a transient API
refusal the next tick retries — is a WARNING, not an ERROR; a line that reports
the expected outcome of the common case is INFO. When in doubt, ask what the
reader must do on seeing it, and pick the level that says so.

## Test-Driven Development (TDD)

Use test-first TDD when introducing or fixing behaviour that needs a new test.
Not every change needs a new test: a refactor, presentation change, or already
covered behaviour may be verified by existing tests and appropriate manual or
browser checks. A test earns its maintenance cost when failure is strong
evidence that supported behaviour, an invariant, or a contract regressed.

1. When a new test is warranted, write a failing test first that defines the
   expected behaviour.
2. Implement the code to make the tests pass.
3. Do not remove, skip, or weaken tests just to pass a gate. If a supported
   contract changes, or a test pins only incidental implementation, update or
   remove the test deliberately and document the reason and remaining coverage.
   **Change only what the issue changes.** When an issue alters part of what
   an existing test expects, edit that expectation and keep every other
   assertion the test made — a green gate before and after does not prove
   nothing was lost. Before raising the PR, go through the assertions your
   diff removes from each existing test (`git diff <base>...HEAD` over the
   edited test files). Each one needs an issue requirement that makes it
   untrue, recorded in the PR summary. An assertion removed without one is a
   blocking self-review finding: restore it, or move it to a test that still
   covers the behaviour and say where. The worker enforces this at PR
   creation (`removed_assertion_gate.ts`, Issue #3131): the removed
   assertion must be named in the summary's Test Plan, and the Standards
   reviewer is asked to judge each one.
4. Every test must exercise real code: source a module, call a function with
   test data, and assert on results, exit codes, or side effects. Tests should
   continue to pass when the implementation is refactored without changing its
   supported behaviour.
5. Do NOT write tests that grep source files for patterns, inspect function
   bodies, verify line counts, or assert that one function calls another. These
   are not real tests. If a function requires external services to test, skip it
   rather than faking a test with grep. Documentation is the one narrow
   exception, and it carries its own conditions — see **Documentation-drift
   tests** below.

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

### Documentation-drift tests

Rule 5 bans keyword checks over documentation; this subsection is the one
exception, and the `worker/deno/tests/*_docs_test.ts` suites are what it exists
for. They are the only guard on a documented rule, switch name or rendered line
drifting away from the code that produces it, so such a suite stays — but it
earns its place by meeting all four conditions:

1. **Section-scoped.** Read the page with `readRepoDoc` and narrow it with
   `section` from `worker/deno/tests/support/markdown_docs.ts`, which masks
   fenced code and throws when the heading is renamed. A whole-file `includes`
   is not a documentation-drift test: it still passes on a page that moved the
   rule into an unrelated section, or deleted the context that gave it meaning.

   `deno check` now rejects a whole-file `flat(body)`: `section()` returns a
   branded `DocSection`, and `flat()` accepts nothing else. The type does not
   see a raw `includes` over a whole page, or a test's own
   whitespace-collapsing helper, so those are still review findings.
   `flatWholeFile` is the named exception for
   text that is not a section of a page: a pinned-phrase literal, text a
   module holds, or a whole file read for an absence check. A positive pin
   over a page's text through `flatWholeFile(body)` is a finding.
2. **What it pins is a rule the code cannot express.** A promise about the
   worker's behaviour that no module holds as a value — "no worker flips it",
   "the trial runs for 10% of claims". There is nothing to import, so the prose
   is the only place the promise exists and drift is silent.
3. **Every value the code can express is imported from the live module.**
   Status names, rendered output lines, config keys, markers, defaults and
   timeouts are imported from the live module that produces them, never retyped.
   A retyped constant stays green while the page and the test agree with each
   other and the code has moved on — the very drift the suite was written to
   catch.
4. **Every pinned phrase occurs only in the rule being added.** A phrase the
   section already held before the change stays green when the new rule is
   deleted — VibeCoder#3091 pinned "blocking self-review finding", which the
   issue prompt already carried. The check is **per pinned phrase, not per
   test**: each phrase must be absent from the base branch's version of its
   scoped section (`git show <base>:<doc>`, narrowed with the same `section()`
   title). "The test goes red against the base" is not enough when a test pins
   more than one phrase — one new pin turns it red and hides a vacuous pin
   beside it, which is how VibeCoder#3156 kept a bare `needs-human` pin the
   base section already held four times. Run
   `deno task drift-pins-on-base <base-ref> <doc> <section> <phrase>...` from
   `worker/deno` for each section a test reads: it lists every phrase the base
   section already held and exits 1 when there is one. `<doc>` is relative to
   the repo root (`prompts/issue/prompt.md`, not `../../prompts/...`); a path
   it cannot resolve exits 2 naming the path, and a doc the base never had
   prints one `doc not on base` line. Record the result for every pinned
   phrase in the PR's Test Plan.

A filesystem-derived invariant is a different species and needs no exemption:
`worker/deno/tests/bucket_docs_test.ts` fails when a bucket file is added
without being listed or a link stops resolving, which is a fact about the tree
rather than a keyword in prose.

The distinguishing question is what is being pinned: a rule the source cannot
hold is documentation drift; a string the source does hold is a grep. Cite this
subsection rather than arguing a fresh exemption in a file header.

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
worker exports `WORK_DIR`, `runCoreLoop` fell back to it for state that
outlives a run, and every suite driving the loop without naming its own work
directory therefore read and wrote the live
`idle_disagreement_streak.json` — four `--parallel` test processes sharing one
file, each resetting the others' streak, and the operator's real state
overwritten with test timestamps (Issue #1098). Name the directory, the config
path and the clock the test wants; the gate scrubs `CONFIG_PATH` and `WORK_DIR`
from the test stage so an unnamed one degrades to memory rather than to the
host.

Fix it on both sides. The scrub keeps the gate honest, but a `deno task test`
run has no scrub, so Issue #1177 took the fallback out of the code as well:
`resolveRunStateWorkDir` reads `config.workDir` and nothing else, and the
suites that name no directory now keep that state in memory wherever they run.
Prefer the argument to the ambient variable — a production path that quietly
reads the environment is a dependency nothing declares, and the test that
covers it is only ever as honest as the machine it ran on.

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

Test supported public contracts at the useful boundary, including success,
validation/error and relevant edge cases; existing direct or indirect coverage
counts. Do not add a test per function or assertion merely to increase coverage.
For a real defect, where practical first reproduce the externally meaningful
failure in a test, then fix it and state the linkage in the PR summary.

**A red run counts only against the base branch.** The regression test must
fail against the unfixed base-branch production code with the base branch's
own test doubles; if the change edits a fake, fixture or stub, run the new
test with the new double against the base-branch production code — if it
passes there, the red came only from the modified double and proves nothing.
When the fault is not reproduced, do not change production behaviour or a
durable format (stored keys, schemas, wire or file formats) on an unverified
diagnosis: first confirm the premise against the base-branch code (for
example, what the production adapter actually accepts), or say the fault is
undiagnosed or already fixed and only pin the current behaviour. When the
issue cites a logged error line, start the reproducing test from that exact
input and quote the line in the PR summary.

**A new test must go red without its change.** A test added to guard a
change — a regression test a fix or a review asks for, a documentation-drift
test, a growth guard — must go red when only that change is removed. A test
whose input never reaches the failure passes either way: a fake that throws
into a catch that returns the expected value, a fixture that a re-sort puts
in order before the assertion runs, a phrase the section already held before
the change. Remove the change on purpose (delete the clause, drop the cap,
restore the old expression), run the test, see it fail, then restore it. A
new test that stays green without its change is a blocking self-review
finding. For a documentation-drift test the check is per pinned phrase, not
per test: one new pin turns a test red against the base and hides a vacuous
pin beside it. Look for each phrase in the base branch's version of every
section the test reads (`git show <base>:<doc>`, narrowed to the same section
title; in the Vibe Coder repository, `deno task drift-pins-on-base <base-ref>
<doc> <section> <phrase>...` from `worker/deno` does this), and record in the
Test Plan that each pinned phrase is absent from the base section; a phrase
the base section already held is a blocking self-review finding. A test that
only pins current behaviour — the fault was unreproduced
or already fixed, and no production change was made — is expected green on
base, and the Test Plan says so. **A negative test must be able to fail**
below is this rule for an assertion that something does *not* happen.

**A negative test must be able to fail.** An assertion that something does
*not* happen — not leaked, not carried over, not exported, not called, null
rather than stale — needs a fixture that contains the forbidden thing: a real
token to leak, an earlier value to carry over, a caller that would otherwise
run. A new guard has no base-branch red run to lean on, so before raising the
PR break the guard on purpose (remove the filter, invert the check, or fill
from the wrong source), run the test, confirm it goes red, then restore the
guard. A negative test that stays green without its guard is a blocking
self-review finding.

**A refusal test must be refused by the rule it names.** A test that
expects an input to be refused, rejected or answered with `false` or an
error must assert the specific error variant or rule, not only that an
error occurred or which field it mentions. Its input must satisfy every
other rule, so only the rule under test can refuse it: show that the same
input with only the probed value made legal is accepted. A test that
compares two refusers (schema against loader, client against server) must
also assert that the on-target base value is accepted by both sides, so
agreement on an unrelated refusal cannot pass. When a change adds a
refusal that runs before an existing one (a new boundary check, a
retired-field list, a stricter parse, a fake that throws), re-run the
existing tests that expect the later refusal and confirm each still
reaches it; one that now stops earlier is a blocking self-review finding.

**Every changed call site needs a test that goes red without it.** This
covers every new or changed wiring between an entry point and the code it
drives, including a single caller: a CLI command or task, an HTTP route or
handler, a scheduled job, a UI control's event handler, and each production
caller a new argument, flag or behaviour is threaded through. A test of the
helper, or of some callers, does not cover the others. For each call site
or entry point the diff changes, revert only that caller's change (restore
its old wiring, pass the old value, drop the new argument, restore the old
filter, or point the handler at a no-op) and confirm at least one test goes
red. For a new or changed UI control, a test must invoke the control's
handler (press the button or submit the form, as the repo's UI test style
does it) and assert what it sends or changes; when the linked issue states
an acceptance criterion as a user action ("pressing X requests Y"), a test
of the helper behind X does not cover that criterion. A test double that
bypasses the production path (for example, a stub that ignores the filter
it is passed, or forcing a fallback path) does not count for that path.
List each entry point checked in the PR summary. A changed call site
whose revert leaves the suite green is a blocking self-review finding: add
a test through that caller, ideally at the level the linked issue's
Failure Detection names.

**Narrowing a shared helper changes every caller.** Before a helper that
other code already calls starts rejecting, throwing on or dropping a value it
used to accept (a validator, type guard, allowed-value set, required field,
ref/name check), list its existing callers and the real values each can
receive. Check those values against the tool or API's actual output, not its
documentation's happy path (see **Observe the real tool before you rely on
it**). If any existing caller can legitimately pass a value the new rule
rejects, keep the shared helper as it was and apply the stricter rule at the
new call site. Otherwise add a test showing an existing caller still accepts
its real inputs. List the callers checked in the PR summary. A narrowed shared
helper with no callers-checked list is a blocking self-review finding
(Issue #3100).

**Every outcome of a branch you add needs a test that reaches it.** For each
new condition, match arm, exit-code check or trait/interface default in the
diff, list its outcomes (success, absent/empty, error, fail-closed default)
and name the test that drives each one. A test double that overrides the
default, or a stub that always returns the same code, does not reach the
other outcomes. Flip each outcome on purpose (return the lenient value
instead of the error, treat "absent" as "failed"), run the tests, confirm at
least one goes red, then restore it. An outcome with no test, or one whose
flip leaves the suite green, is a blocking self-review finding: add a test
for it. When the run writes or refreshes a PR summary, record the
enumeration as a `Branch outcomes:` list in its Test Plan — one line per
outcome naming `path:line`, the outcome, the test that reaches it, and that
flipping it went red — or `Branch outcomes: none added` when the diff adds
no branch; every test it names must exist at the head (see **A named test
must exist**). A fix to an existing PR re-enumerates every branch its own
commits add, not only those a review finding named, and refreshes the list
to the head.

**A new path to an existing outcome keeps that outcome's guards.** When a
change adds an early return, a new gate or route, or a direct call that
reaches an outcome an existing path already reaches — finalising or raising a
PR, publishing UI or state, charging a retry or attempt, ending a claimed
task — first list every guard and side effect the existing path applies
before that outcome: the degraded-run guard, ticket and freshness checks,
spacing and attempt limits, replying to or releasing a claim. For each one,
either make the new path apply it (or order the new branch after it), or
state in the PR summary why it does not apply. For each guard the new path
keeps, add a test that reaches the new path while the guard's trigger
condition holds and asserts the guard's effect, then move the new branch
ahead of the guard (or remove the guard call) and confirm the test goes red.
List the guards kept and excluded in the PR summary. A new path that skips an
existing path's guard with no stated reason is a blocking self-review finding
(Issue #3087).

**A new branch must be reachable by the input it exists for.** When you add
a branch, guard, capture or hand-off below existing early exits in the same
function or its caller (`return`, `continue`, `break`, `exit`, a retry or
failure return), list each exit above the insertion point and what fires it.
For each one, ask whether a realistic input for the new case can fire it
first. Free-text heuristics, empty or short-input filters and "nothing to do"
exits are the usual culprits. If one can, move the new branch above it, or
state in the PR summary why that exit must win. A real infrastructure signal
can justify that; a wording guess cannot. Then add a test whose input is the
realistic case and also trips each earlier exit the new branch now precedes.
Move the new branch back below that exit and confirm the test goes red. A
new branch that a realistic input for its own case cannot reach is a
blocking self-review finding (Issue #3167).

**Code that deletes or replaces state proves everything it destroys is safe
to lose.** When a change adds code that `rm -rf`s a directory, swaps a new
clone or `.git` in for an old one, runs `git reset --hard` or `git clean -fdx`,
or overwrites a file in place, first list everything the old copy holds that
the replacement will not. For a git clone that is every `refs/heads/*` tip and
its commits not contained in an origin ref, the stash, the reflogs, untracked
and ignored files, and local config (branch upstreams, hooks, `extensions.*`).
Proving only the state the change is about — the current branch equals
`origin/<branch>` and the working tree is clean — says nothing about the rest.
For each item, either prove it is safe to lose (for example, every local
branch tip is an ancestor of an origin ref) or refuse the operation and report
why. Before writing a new check, search the repo for an existing guard on a
sibling destructive path (`git grep -n -e 'rm -rf' -e unpushed`) and call it
rather than copying it. Add a test per refusal whose fixture holds that state
and asserts it survives. List the inventory in the PR summary, with what is
guarded and what is accepted as lost. A destructive operation that deletes
state it never checked is a blocking self-review finding (Issue #3107).

**A named test must exist.** Every test the PR summary names under Evidence or
Test Plan, and every code comment or anchor that points at a test, must be a
file in the PR's diff or already tracked at the head, named **relative to the
repository root** — `worker/deno/tests/foo_test.ts`, not `tests/foo_test.ts`,
even when the repository's own test command runs from a subdirectory such as
`worker/deno` (Issue #3160). Before raising the PR, check each named path
with `git ls-files <path>` run **from the repository root**; a
named-but-absent test is a blocking self-review finding — add the test or
drop the claim, and never commit an anchor that references a test that does
not exist. A test cited as evidence is also run on the final head and its
result reported, and a coverage claim
names the branches its tests exercise — "every branch" with one branch
untested is an over-claim (Issue #3058). An unresolved placeholder where a
result belongs — an unfilled ALL-CAPS `..._PLACEHOLDER` token left where
`./quality.sh`'s outcome should be, say — counts as an unreported result and
is itself a blocking self-review finding (Issue #3124).

**A stub mirrors the real callee's contract.** When code shells out to another
repository's binary or script, the test stub must reproduce that callee's
documented contract: the inputs it actually reads (an index file, say, rather
than a tree scan) and its exit codes on failure. A stub more permissive than the
real callee masks the contract it stands in for and is a finding. Run the test
against a real checkout of the callee, or name the contract the stub mirrors in
the PR summary with a source link to the callee's code or docs.

**A fake mirrors the production implementation it stands in for.** The stub
rule above covers another repository's binary; this covers the repository's
own ports. When a test double replaces one of the repository's own ports (a
trait or interface with a production implementation) and the change relies
on a property of that port, read the production implementation first and
confirm it has that property. Examples of such properties: which rows a read
returns, a filter, ordering or paging, which value types a write accepts, or
whether a conditional write can lose. If the fake behaves differently, fix
whichever side is wrong. Then pin the two together with one contract test
that runs against both, or against the production adapter's parsing of a
recorded response, or test the behaviour at the production adapter itself. A
fix to the fake is still held to **A red run counts only against the base
branch**. In the PR summary, name the production implementation each
load-bearing fake stands in for and the property the change relies on. A
change whose only proof is a fake more permissive than its production
implementation is a blocking self-review finding.

**A test of a third-party tool's input uses that tool's semantics.** The
fake rule above covers the repository's own ports; this covers a pattern or
config that an external tool reads — Renovate `matchStrings` or
`managerFilePatterns`, Actions `branches` or `paths` filters, linter or
scanner configs. When the tool's own validator or engine can run in the
repository's CI (for example `renovate-config-validator`, or RE2 for a
Renovate regex), run the test through it. When it cannot, test the in-repo
stand-in against cases taken from the tool's documentation: the exact case
the change relies on, and at least one input the tool rejects or does not
match. For example, GitHub's `*/*` branch filter matches `milestone/foo`,
and RE2 rejects a negative look-ahead that JavaScript's `RegExp` accepts.
Name that documentation in the PR summary. A stand-in more permissive or
more restrictive than the tool, so a test passes on input the tool rejects
or fails on input it accepts, is a blocking self-review finding.

**Observe the real tool before you rely on it.** When a decision depends on
how git, `gh`, the GitHub API or another external tool behaves in a
particular case (exit code, warnings on stderr, case-sensitivity, ordering,
which items a response includes), run the real tool on that case first. If
the issue names real examples, use them. Build the fake's fixture from the
observed output, not from what you expect it to be. In the PR summary, give
the command you ran and the part of the output the code depends on. If the
case cannot be observed safely, cite the tool's documentation or source for
that behaviour.

**A workflow behaviour change extends the workflow validator.** When a change
alters what a `.github/workflows/*` file does — a new or changed flag, step,
trigger or setting the job's correctness depends on — extend the repository's
workflow validator in the same PR, or add one when the repository has none,
with a positive and a negative test for each new or changed invariant. A flag
that is load-bearing must be load-bearing in the validator too, not only in
the README or a code comment: an invariant documented but not validated is a
blocking self-review finding (Issue #3021). A validator that emulates
GitHub's glob or expression semantics is also held to **A test of a
third-party tool's input uses that tool's semantics**.

### Writing a gate over text

A deterministic gate over text — a PR summary, a Markdown file, a diff, a
closure entry, or source code it counts or scans — fails in two ways its own
tests rarely show: the matcher misses a realistic variant of the thing it
exists to catch (or fires on a look-alike it should ignore), and input it
cannot handle is skipped while the gate reports a clean pass. Fleet PRs have
shipped both. VibeCoder#3148 counted a commented-out assertion as "moved"
because its text was a substring of an added block. VibeCoder#3132 recognised
only column-0 fences and paired inline code spans one line at a time, which a
run over `docs/archive/pr-summaries/` would have exposed. VibeCoder#3134
skipped every non-matching closure entry with `continue`, including the
`partial`/`missing` entries that were the run's own evidence of a gap.
VibeCoder#3157 counted `Deno.test(` inside string literals and counted
`Deno.test.ignore` declarations, so it flagged correct Test Plan counts as
stale. Before calling a gate done (Issue #3149):

1. **Evasion table.** For each thing the gate must catch, add a test per
   nearby variant an agent or human would plausibly produce — commented out,
   wrapped in a condition (`if (false)`), loosened, re-wrapped across lines,
   escaped, indented, moved to another file, deleted with its file, and
   renamed — each asserting the gate still blocks. Run the table both ways:
   for each look-alike the gate must ignore — the pattern inside a string or
   template literal, a skipped or ignored declaration (`Deno.test.ignore`,
   `it.skip`), an example inside a code block — add a test asserting it does
   **not** fire. A gate that reads source code blanks out comments and
   literals before it matches, or uses a tokeniser.
2. **Corpus run.** When a real corpus exists — `docs/archive/pr-summaries/`,
   recent PR diffs, closure-verdict logs, the PR's own test files — run the
   matcher across it and report the false-positive and false-negative counts
   in the Test Plan. A counting gate compares its count with the tool's own
   (the number of tests `deno test` reports it ran).
3. **No silent pass on unread input.** Input the gate truncates, filters out,
   cannot parse, or skips with `continue` either fails closed or is logged and
   reported as not checked (for example `testDiffKnown=false`) — never a clean
   pass, and a test pins that outcome. This is **Never Fail Silently — Fail
   Loud** applied to a matcher, and each skip is an outcome under **Every
   outcome of a branch you add needs a test that reaches it** above.
4. **Compare like with like.** Normalise both sides of a comparison the same
   way — escapes, whitespace, comments — and use equality on the normalised
   forms rather than substring containment, unless containment is the
   contract.

A gate's matcher must also stay cheap on hostile input — see the ReDoS
guidance under **Unit tests** below.

### Choosing assertions

- **UI / PWA:** Prefer real/headless-browser user journeys and visible states
  (loading, empty, error, offline/cache and retry) where practical. Select by
  role, accessible name or label, or an explicit stable product identifier.
  Avoid exact CSS values, pixel dimensions, class names, DOM hierarchy and
  framework internals unless that appearance or structure is itself a stated
  contract. Use visual snapshots deliberately when appearance is the contract
  and the baseline can be reviewed. A restyle should not break a behaviour test.
  A closed `visually-hidden` element keeps a 1×1 box, which Playwright counts
  as visible, so assert the semantic closed state (`aria-expanded="false"`, or
  the open-only class absent) rather than `toBeVisible()`/`isHidden()`.
  Measure only after the UI has committed the change (await the state or the
  next frame), never in the same synchronous `page.evaluate` as the click.
- **APIs:** Check successful responses and schema/semantics, invalid inputs,
  authorisation, relevant boundaries, documented errors, and retry/idempotency
  where applicable. Incompatible supported contract changes need a new version
  and an explicit supported-version/migration policy; do not silently break
  clients or preserve obsolete versions indefinitely.
- **Units:** Assert meaningful invariants and outcomes at useful boundaries,
  not private call sequences or line-by-line implementation. Refactoring private
  code should not require widespread test changes. Existing higher-level tests
  can cover behaviour without a direct unit test. A unit test of a shared
  helper does not cover its callers' wiring — see **Every changed call site
  needs a test that goes red without it** above. Each outcome of a branch you
  add needs its own test, and a test double that overrides a default or stubs
  past the branch does not count — see **Every outcome of a branch you add
  needs a test that reaches it** above. A new early return or route to an
  outcome an existing path reaches keeps that path's guards — see **A new
  path to an existing outcome keeps that outcome's guards** above. A test
  for a new branch below existing early exits uses the realistic input for
  its case, including one that trips each earlier exit it now precedes — see
  **A new branch must be reachable by the input it exists for** above.

Before adding an assertion, ask whether it would fail on a legitimate redesign
or refactor with the supported behaviour intact. If so, justify it as an
explicit contract or leave it out. Ask a negative assertion the opposite
question too: would it fail if the guard it protects were removed? If not,
its fixture lacks the forbidden value — see **A negative test must be able to
fail** above. Ask every new test the same question of its change: would it
fail if only that change were removed? See **A new test must go red without
its change** above. See Playwright's
[user-visible testing guidance](https://playwright.dev/docs/best-practices)
and Testing Library's [guiding principles](https://testing-library.com/docs/guiding-principles/).

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
  script, and a claimed file is an integration test — including the three the
  gate runs anyway (Issue #1598). Being run by the gate does not make a suite a
  unit test: the classifier decides what a file is, and the exception decides
  only where it runs.
- **Fast** — it finishes in milliseconds, and within 10 seconds at worst, a
  **target, not a kill**. The unit passes write a JUnit report and hold it to
  a one-second budget (Issue #2642): every test over it is reported as a
  `WARNING` line, and a file whose tests **all** exceed it fails the gate
  unless it is an integration suite or on `SLOW_UNIT_TEST_KEEP_FILES` in
  [`lib/unit_test_time_budget.ts`](worker/deno/lib/unit_test_time_budget.ts)
  with a reason. Under the agent's own git guard shim, which adds ~200 ms to
  every message-carrying `git` call, that failure is printed as
  `NOT ENFORCED` rather than failing the gate; CI and the worker's gate
  enforce it (Issue #2669). A slow unit test is
  usually a real side effect the mocks missed — #2642's planning suites were
  spawning `claude` for real. Beyond
  that budget the rule is enforced by shape rather than by stopwatch: a wall-clock
  sleep, a retry loop against the real clock, a polling wait or a spawned
  script is a `test-audit` finding (check 13) whatever the test happens to cost
  on your machine — unless the file is **declared**, in the integration
  manifest or in `IN_GATE_SCRIPT_SUITES`, where the spawn is the point and its
  cost is recorded beside it.
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
`deno task test:unit tests/a_test.ts tests/b_test.ts` runs only the unit tests
among the files named, split the same way, and says which integration suites it
left out — use it for targeted runs instead of a raw `deno test <files>`.

**A unit test that cannot run in parallel is still a unit test.** It is capped
debt, not a reclassification. Exactly three reasons put a file in the serial
pass: it mutates process state, it asserts on a real elapsed reading, or it
races a real subprocess for the scheduler. All three are listed in
`PARALLEL_UNSAFE_TEST_FILES`, and the mutator half of that list is **empty and
must stay empty**. A serially-run unit test is a full member of the unit
verdict.

The wall-clock half is nearly empty too, and the way it emptied is the lesson.
Twenty-five suites were listed there for driving `runClaudeWithTimeout` against
a real one- to four-second deadline — 108 seconds of the serial pass spent
asleep, and, worse, a watchdog woken late by a busy host reported as a
correctness failure four times in PR #1170's own run. The fix was the seam, not
a longer budget: [`lib/clock.ts`](worker/deno/lib/clock.ts) is what the runner
reads time and arms every watchdog through, production passes nothing and gets
the real one, and a test passes
[`tests/support/fake_clock.ts`](worker/deno/tests/support/fake_clock.ts) and
*drives* the deadline. The stubs stop at a gate
(`agentStubGate`/`releaseAgentStub`) instead of sleeping, so the agent reaches
the point under test because the test said so. The SIGKILLed-agent case in
`claude_runner_killed_test.ts` — what caught the orphan-collector defect of
Issue #1135 — still spawns a real agent and still lets the runner kill it; it
simply no longer waits out a stopwatch to do it.

- **Do not** reduce iteration counts to make a "performance test" fast enough
  to pass as a unit test. If you need to confirm performance, write a benchmark
  and include the results in the PR summary.
- **Guard super-linearity by behaviour first** — catastrophic backtracking on
  an adversarial input of any real size does not cost a little more than some
  threshold, it never returns. So the first form to reach for is not a
  measurement at all: feed the hostile input and assert what the code
  **produces** — benign text unchanged, the credential masked, no suppression
  found. A super-linear regression then hangs the case until the runner kills
  it, which is a failure on every machine under every load. PR #1170 is what
  it cost to learn this twice: an absolute millisecond budget went red on a
  host 8% slower than the one it was chosen on, and the ratio assertion that
  replaced it went red on a loaded laptop reading 30 ms against 355 ms for work
  that is linear. **A fleet of unlike machines under unlike loads has no budget
  and no ratio that means the same thing twice**, and a flaky gate teaches
  everyone to re-run rather than read the result. Whichever form guards it,
  build the test from the input shape that was slow, and run it against the
  unfixed pattern to see it hang or fail the growth check before counting it:
  Issue #3085's growth test fed dots that ran to the end of the value, which
  never backtracks, when the input that does is dots followed by `x`.
- **If, and only if, no observable output distinguishes the two, guard by
  shape rather than by clock** — catastrophic backtracking has no wrong output,
  only a runtime one, so such a test must measure. Use
  [`tests/support/growth.ts`](worker/deno/tests/support/growth.ts)
  (`assertLinearGrowth`), which times the same work at size N and 4N and fails
  only when the cost grew faster than the input. A slower fleet host inflates
  both readings and stays green; an absolute millisecond budget does not
  (Issue #530). The rule in one line: **compare two readings of the same work,
  never a reading against a constant.** A ratio assertion is permitted and is
  not a `test-audit` finding; an absolute wall-clock threshold is forbidden and
  is one (Issue #786). Such a test measures deliberately, so it runs in the
  serial pass — and it is still a unit test. Prefer the behavioural form where
  it works: PR #1170 moved twelve ReDoS guards onto asserting what the code
  *produces* for an adversarial input, because a pattern that never returns
  hangs the case on every host. It only works when the pre-fix cost is large
  enough to hang — `plan_coverage_gate_bounds_1245_test.ts` guards a pattern
  costing about twelve seconds on the largest input GitHub accepts, which
  stalls a planning close but finishes well inside a test timeout, so the
  ratio is the only detector it has (Issue #1245).
- **Vet every regex on untrusted text, one hostile case per pattern.** Every
  regex a change adds or edits that runs on untrusted or agent-written text
  (an issue body, a PR summary, agent output) gets its own check, not one per
  module. Read each pattern for two quantifiers that can match the same
  characters with only optional tokens between them: `\s*:?\s*$`,
  `\s*[:\-–—]\s*(.+)$`, or an unanchored `[.!\s]+$` or `\s+$`. Remove the
  overlap: trim the line first and drop the redundant quantifier, make the
  pieces disjoint (`\s*(?::\s*)?$`), call `trimEnd()` instead of matching
  trailing whitespace, or cap the run. A `(.*)$` tail can fail too, because
  `.` stops at a lone `\r`: after an unanchored label such as `reason:`, the
  search restarts at every later occurrence of the label and rescans to the
  end each time, so read the value with `([^\n]*)` and no `$` (Issue #3186).
  Then add one hostile case per pattern: a long run of the shared character
  followed by a character the pattern rejects. A parser with several
  patterns needs a case for each. stSoftwareAU/VibeCoder#3085
  capped `isBarePlaceholder` and left `DOCS_SWEEP_LINE_RE` in the same file
  with the same defect, and #3160's hostile cases covered the inline form while
  `BRANCH_OUTCOMES_HEADING_RE` took about a minute per call (Issue #3164).

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
`ignore` when it is absent — and every CI job that would run it fails the build
when `pwsh` is missing, rather than reporting a green suite that tested nothing.

Integration tests are **excluded from every quality run and from the merge
gate**. Both unit passes ignore them, because they cost roughly a third of the
gate's wall time and ran on changes that cannot reach them (Issue #907), and
PR #1170 took them out of the sharded `validate (tests N/4)` legs for the
same reason — a required check that needs an interpreter it cannot count on
reports the runner as often as it reports the change. They run in
per-PR CI in their own `integration tests` job, which is deliberately **not** a
required check, and on demand with `deno task test:integration`. A red result
there is a real signal and must be read; it is not the gate.

**One named exception, and it is the prerequisite that moved, not the rule**
(Issue #1598). The container image now ships PowerShell 7 (Issue #1596), so
the three `run.ps1` launcher suites have their interpreter wherever the worker
runs its gate. They are named in `IN_GATE_SCRIPT_SUITES`, each with a reason
and its measured cost, and the gate runs them — about 97s for the Windows
containment boundary being verified before the push rather than in a job that
cannot block a merge. `pwsh_suites_in_the_gate_test.ts` fails the gate on a
host without PowerShell rather than letting those suites report "ignored"
while the gate reports green. The `setup.ps1` suites stay excluded. An entry
there is an exception a change has to argue for, never a place to move a slow
suite into.

A test that **reads** a repository script without running it is a unit test,
not an integration test — but the classifier still claims it, so it must be
named in `SCRIPT_READING_UNIT_TESTS` with a reason. No list is a default: a
file the classifier claims is placed in one of the three deliberately.

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
the test files your change touches. Then run `deno task check:manifests`
(Issue #1483): the tree-scanning completeness tests — every new `lib/` module
claimed by a sweep slice, every `VIBE_*` name registered, every prompt and
integration suite in its manifest — in a few seconds, under read and env
permissions only. Its membership is derived from the tree, so it cannot
drift. A new file or variable that is missing one registration line is the
commonest way a correct change goes red in CI, and this is where it is found
for free rather than after a full matrix. Run `./quality.sh < /dev/null`
**once, in the foreground**, before raising the PR — provided the run budget
covers it,
see below — and fix what it reports; re-run it after a fix, never on a timer.
Never background it behind a `sleep`/`pgrep` poll loop
— that spends the whole budget waiting (Issue #399). It streams one line per
check as each settles, so a slow run is visibly alive rather than
indistinguishable from a hung one. The quality gate is implemented in Deno
TypeScript (`worker/deno/quality.ts`) and runs benchmark-audit, markdownlint,
semgrep, the release-tag ruleset reconciliation, `deno test`,
`deno lint`, `deno check`, and `deno fmt --check`. The semgrep stage runs the same
`p/default` ruleset as the blocking `semgrep.yml` PR check, over the branch's
changed files only, so a SAST finding is met before the push rather than after
it (Issue #559). Shellcheck is deliberately not run here —
bash linting is owned by each repo's own CI. See
[CONTRIBUTING.md → Local quality gate](CONTRIBUTING.md) for how to install the
optional checks (`markdownlint-cli2`, `semgrep`).

**A quality run executes the unit suite only** — no benchmarks, and no
integration tests beyond the three `run.ps1` launcher suites
`IN_GATE_SCRIPT_SUITES` names (Issue #1598). Its `deno test` stage is the two
unit passes and nothing else: both of them ignore `INTEGRATION_TEST_FILES`
(Issue #907), and no gate has ever run a benchmark. The sharded
`validate (tests N/4)` legs run exactly the same two unit passes, built from
the same manifests by `lib/unit_test_passes.ts` (PR #1170), so "it passed
locally" and "the merge gate passed" mean the same thing — including the
`run.ps1` suites, which both now run. Every other integration test is covered
by per-PR CI in a separate, non-required `integration tests` job; run them
locally with `deno task test:integration` when your change touches a script
they drive. A green quality run therefore says nothing about those suites, and
is not meant to.

**A green gate says nothing; a red one says everything** (Issue #2430). The
gate runs many times a day and its output is quoted back into review comments
and agent prompts, so a line per passing test is paid for over and over — one
green run here printed roughly 23,000 of them. A stage that passes prints at
most its own summary line, and a stage that fails prints every failure in full:
the test's name, the assertion message and the stack trace. Pass the runner's
quiet or failures-only reporter (`deno test --reporter=dot`) rather than
post-filtering the output, and check what that reporter prints on a failure
before adopting it — one that also swallows the assertion message trades a
token bill for a debugging one. Where the quietest reporter the runner accepts
still marks each passing test, pair the flag with a trim in whatever collects
the transcript: `unitTestPassTranscript` in `lib/unit_test_passes.ts` keeps a
failing pass's output and drops a passing one's.

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

**Never add worker-local paths to a target repository's lint/format config.**
`graft/`, `.codegraph/`, or anything else listed in a checkout's
`.git/info/exclude` are worker-internal state, not repository content — a PR
must never add them to that repository's `.markdownlint*`, `.markdownlintignore`,
`.prettierignore`, `deno.json` excludes, `.gitignore`, or any other lint, format
or ignore config, however red the gate runs. A target repo's quality gate
tripping over one of these paths is a worker environment fault: report it so it
is fixed in the worker, rather than committing a workaround into that repo.

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

The injected block asks for test-first work when a new behavioural regression
test is warranted, without requiring a new test for every change. The `issue`
and `pr_feedback` phase prompts also state the conditional TDD sequence. Other
phases receive the same testing principles without a blanket test-first mandate.

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
| [`html`](prompts/best_practices/buckets/html.md)                             | Living-standard markup, WCAG and ARIA accessibility, visual design anti-patterns |
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

Place warranted tests in a focused test file (e.g. `lib/config.ts` →
`tests/config_test.ts`); a one-to-one module/test count is not required.
For the command pattern, the `Command` /
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

## Path Confinement — Resolve Before You Check

Guards that confine a path to, or keep it out of, a directory keep missing
`..` traversal because they check a partly resolved path.

- **Resolve fully, then check — in this order.** Before comparing a path
  against an allowed or forbidden directory: (1) join it to the working
  directory; (2) normalise or reject every `..` and `.` segment of the whole
  joined path, including any tail that does not exist yet; (3) canonicalise the
  longest existing prefix of the *normalised* path (following symlinks); (4)
  compare. Then act on the path you checked, not the original string. The
  order matters: canonicalising first and normalising the tail afterwards lets
  `<dir>/missing/../link/file` collapse to `<dir>/link/file` after the
  symlink check has already run, so a `link` pointing outside still escapes.
  Never check a partly resolved path.
- **Allow-list identifiers that become path segments.** Refs, names and IDs
  joined into a path need their own allow-list validator that rejects `..`,
  `/` and absolute paths. Do not reuse a validator written for another purpose
  (e.g. `assertSafeGitRef`, which accepts `..`).
- **Negative tests are part of the guard.** Every such guard ships with tests
  for `..` traversal — including `..` after a not-yet-existing component —
  and, on Unix, a symlink into the protected directory, plus the combined
  case: `..` after a not-yet-existing component that lands on a symlink
  pointing out (`<dir>/missing/../link/file`).
- **Do not claim a traversal case is impossible** in a PR summary unless a
  test proves it.

Seen in VibeCoder#2881 (`assertSafeGitRef` accepting `..`) and GRQ-GTC#448 (a
non-existent tail containing `..` appended after canonicalisation).

## A Code Change Owes a Docs Change

When you rename a symbol, change a signature or a default, add or remove a flag,
or change a documented command, grep the repo's docs for the old name and update
every surface that mentions it — README, `docs/`, operator manuals, prompt
templates, and agent instructions — in the same change. Do it before the commit,
not after a reviewer (or an idle-task documentation scan, weeks later) finds it.

- Changing the **behaviour or meaning** of an existing function, field,
  setting or endpoint while keeping its name also owes a docs change — the
  rename rule alone misses it, because there is no old name to grep for.
- Grep for the **unchanged name**, then re-read every hit — including the doc
  comment directly above the changed code, the doc comments on the definitions
  and callers of what changed, wherever they live, and the prose beside any
  example you updated — and fix any that still describe the old behaviour.
- **Doc comments outside the diff go stale too.** Grep source files, not only
  the manuals: for each name the change removes or whose behaviour it changes,
  and for the shared constants, types and helpers the changed code defines or
  calls. Read every doc comment and module doc a hit lands in, and fix any
  sentence the change makes false, including in a file the diff does not
  otherwise touch. A constant's definition, a reader's safety argument and a
  helper's list of callers are where these go stale.
- Updating an example alone is not enough: if the surrounding prose still
  describes the old contract, the doc is still stale.
- **Adding a member owes a docs change too.** When you add a field, enum
  variant, kind, flag, column or row element to an existing set, grep for one
  or two **existing sibling members**, not the new one — the new name is in no
  doc yet, so a grep for it comes back clean. Every doc comment, module doc,
  manual page or API description that lists the set names the new member in
  the same change, or is reworded so it no longer reads as complete.
- When a change alters what an existing **state, enum variant, field or value**
  means — even though its name stays — find every place that **renders or
  explains** it: API response strings and labels, reason and stage sentences,
  UI copy, and the docs prose for those fields. Make each one true for **every
  case** the new behaviour produces, not only the common one. Grep for the
  variant or field name **and** for the old wording.
- Grep for the **stem** of a behavioural claim, not one inflection
  (`replac\w* or remov\w*`, not "replaces or removes"), and re-run it on the
  final head after editing. In a file you update, read every passage that
  mentions the changed surface, not only the section you edited. Each
  remaining hit goes in the Docs sweep line by `file:line` with the reason it
  is still true.
- **Check where you insert.** Before adding a new function, item, test or
  paragraph, read the lines directly above and below the insertion point. A
  doc comment, attribute or decorator directly above belongs to the item
  below it: insert above the doc comment, never between it and its item. A
  following sentence that points back ("above", "both paragraphs above",
  "this", "the rule above", "as described earlier") must still point at what
  it meant; if it would not, insert after it, or reword it to name what it
  means. In the diff, check the first and last context lines of every hunk
  that adds a block, since that is where these breaks appear. The docs
  sweep misses them, because the sentence made wrong is one the diff neither
  adds nor edits, and no linter catches the Rust case: there is no blank
  line for Clippy's `empty_line_after_doc_comments` to flag.
  stSoftwareAU/GRQ-AutoTrader#2218 and #2413 each put a new function between
  another function's doc comment and that function, so rustdoc opened the
  new helper's doc with the other function's description, and #2478 put a
  new paragraph in front of "Both paragraphs above describe …" (Issue #3194).

## A Contract a Deployed Extension Reads Is Additive-Only

The worker updates itself on every host within the hour. An operator's
extension — a post-run callback hook, a container extension, anything that
reads a documented interface from outside this repository — does not: it is
reinstalled by a human, host by host. So a change to such an interface that an
existing extension cannot read is a fleet-wide outage with a manual recovery on
every host, however small the diff.

- **Add; never remove or repurpose.** A new field, value, event or flag is
  fine. Removing one, renaming one or changing its meaning is a breaking
  change, whether or not a version number moves.
- **A version number is compatibility, not a changelog.** Bump it only for a
  removal or a change of meaning — never for an addition — and pin the field
  set an existing version promised with a test, so a removal fails in review.
- **A bump is a release decision, not a side effect.** It needs the entry in
  [Release notes](docs/RELEASE-NOTES.md), the
  [release floor](docs/RELEASE-TAGGING.md#the-release-floor) moved, and the
  extensions upgraded on every host **before** the worker that emits the new
  version ships. If that sequence cannot be run, the change is not ready.
- **The scar.** On 2026-09-11 the post-run callback schema went 1 → 2 for an
  additive change. Every deployed hook refused the version, every callback on
  every host failed on every issue, and each host was reinstalled by hand
  (Issues #2039, #2041). The
  [callback contract's versioning rule](docs/CALLBACKS.md#versioning--the-contract-is-additive) is the
  operator-facing statement for that contract.

## Commit Messages

Reference the issue number in all commit messages (e.g.,
`Fix: Description (Issue #42)`). Add a `Vibe-Coder-Run-Id` trailer to every
worker-authored commit.

## PR Summary and Evidence

At the end of your work, after all commits are complete, create
`docs/archive/pr-summaries/pr-summary-{issue_number}.md` — the canonical home
for every PR summary — containing:

1. **Summary** — What was changed and why, including the `Closes #<n>` keyword.
2. **Spec** — The after-run record of what the diff alone cannot tell a
   reviewer, under `### Intent and Rationale`, `### Essential Design
   Decisions` and `### Undiscoverable Facts` (decisions from issue comments,
   behaviour seen only at run time, constraints from outside the repo) — at
   most four bullets each, `None.` when empty.
3. **Evidence** — Screenshots (saved to `docs/evidence/`) for UI changes,
   before/after benchmark results for performance changes, or test references
   for bug fixes. If visual evidence cannot be provided, state why.
   Always add a one-line **Docs sweep** — the grep terms searched, the doc
   files updated, and the manual `section:` read for the changed surface, or
   `no hits` (see
   [A Code Change Owes a Docs Change](#a-code-change-owes-a-docs-change)). The
   worker refuses to raise a PR whose diff changes code with no such line.
   Re-run the grep on the final head and list each hit you leave in place as
   `file:line — still true because …`, so the worker and the reviewer can
   check it: the worker re-runs the line's quoted terms over the head's docs
   and the comment lines of its source files, and posts a hit outside the
   diff that the line does not name as an advisory PR comment for the
   reviewer, rather than blocking the PR.
4. **Test Plan** — Tests added or modified.

The summary describes the **final** state of the branch, not the history of the
run. Before the last commit, re-read `git diff <base>...HEAD`, rerun the tests
it names, and rewrite — never append to — the summary so every claim
(reproduction status, test results, "known defect" notes, named functions and
files) matches the head. Every file or behaviour the summary says the PR changes
must appear in `git diff <base>...HEAD`, not merely exist at the head — a merge
from the base branch can supersede the change — and an abandoned iteration's
description is replaced by the one that shipped. A summary that contradicts the
diff is a blocking self-review finding. The same holds for every doc the diff
adds or edits — a README or `docs/` page, an audit record, the doc comment
above a changed function: each assertion it makes must match the head code.
After any merge of the base branch into the branch, re-verify each claim; one
whose subject the merge absorbed is dropped, or the work redone. A
Standards-review violation the diff itself introduced is fixed before the PR
is raised, never listed as standing, and a PR whose core deliverable is
`missing` is not raised over a `Closes #<n>` — finish the work, except when
the core deliverable is genuinely blocked on another open issue after work
is committed: a `## Blocked:` heading followed by a `Depends on owner/repo#N`
(or `Blocked by`) line naming an issue that is still open then defers the
issue and raises no PR. A closed or unreadable dependency does not defer;
the committed run hands off to a human and raises no PR.
The worker enforces this itself, not only a reviewer, because a PR into a
milestone branch merges unreviewed on green CI (Issue #3177): a summary
whose `## Acceptance Criteria` block marks any criterion `missing` is raised
as `Part of #<n>`, never `Closes #<n>`, and when it merges the worker leaves
the issue open, labels it `needs-human` and names the missing criteria.
In an issue run, a hand-off (the planning marker, a time deferral, or a
`## Blocked:` dependency) is honoured after a commit as well as before one.
A free-text escape hatch is honoured only while the branch has no commits
and no uncommitted changes against the base (Issue #3058, #3088). A CI-fix
run is the exception: a check
already red on the base branch still defers on a `Depends on owner/repo#N`
line (`prompts/ci_fix/prompt.md`, "Base-branch failures"). That CI-fix
deferral never covers a dependency-audit check (`deno audit`, `cargo audit`,
or a `GHSA-`/`RUSTSEC-` advisory): a CI-fix run fixes it in the PR
(`prompts/ci_fix/prompt.md`, "Dependency audit failures"), even when the base
branch is red. The Escape Hatch
in `prompts/pr_feedback/prompt.md` and in `prompts/ci_fix/prompt.md` is also
honoured on a committed PR branch when `.pr_response_message` names a
follow-up issue. Any later commit on the branch — a
review fix, a PR feedback, CI-fix or merge-conflict run — refreshes the summary
in the same push when it changes what the summary says.

**Prose about the PR's own change** is where that rule breaks most often: a
sentence states the new behaviour more simply than the code implements it —
it drops a condition the code checks, names a trigger the code does not have,
says a cost cannot happen when the code makes it happen, or says a scan or
check covers a set its code does not select. For each sentence the diff adds
or edits in a doc, prompt, doc comment or PR summary that says **when** the
change's behaviour happens, **what it costs** or **which inputs** it covers:

1. Open the code that decides it and list every condition and every path that
   reaches it. The sentence names each condition, or scopes itself explicitly
   to the path it describes.
2. An absolute word — "only", "never", "always", "any", "every", "all",
   "each", "automatically", "exactly as before", "no … is missed" — or a
   counted or closed list ("three things are …", "X, Y and Z are the …")
   needs a line of head code that guarantees it. With no such line, rewrite
   the sentence. For a claim about **which inputs** a scan, check, guardrail
   or test list covers, open the code that builds the set — the candidate
   selection, filter or allow-list, or the PR's own `Branch outcomes:` list —
   and match it exactly or scope the sentence to it: "each Markdown line the
   milestone adds that names a milestone issue, or an issue one declares as a
   bare `#N` with `Depends on`/`Blocked by` (an `owner/repo#N` dependency is
   not read, even when it names this repo), closed as not planned", not
   "every Markdown line that names an issue closed as not planned". A
   test-coverage claim is the same check: it names the branches its tests
   exercise (**A named test must exist** above).
3. When the change moves a cost (a download, a retry, a push, a fallback) from
   one path to another, the doc says where the cost now lands.
4. A sentence about history ("before this fix, X skipped Y") is checked
   against the base-branch code, not reconstructed from memory.

Fleet PRs sent back for this: a doc said an 8.2 GB tarball "only reappears
when the remote symlink moves", when the PR's own code downloads it again
whenever the extracted tree is wiped (GRQ#5158); a prompt said a `## Blocked:`
heading defers, when the code defers only on a `Depends on`/`Blocked by` line
naming an issue it reads as open (VibeCoder#3095); a section said a script
"runs automatically" after a fetch that never calls it (GRQ#5153)
(Issue #3120). Sent back for an "every" or a closed list the selecting code
does not back: a standards paragraph said a milestone summary PR body lists
"every Markdown line the milestone adds that names an issue closed as not
planned", when `findNotPlannedDocReferences` checks only milestone members
and the bare-`#N` `Depends on`/`Blocked by` targets they declare — a
qualified `owner/repo#N` reference, even one naming this repo, is dropped
before the lookup (VibeCoder#3231); a PR summary said "every arm" of three parsers had its own
`Branch outcomes:` line when five branches had none (VibeCoder#3160); a
script's header comments listed "three things" that are deliberately not
faults when the script skips and allows several more (GRQ-AutoTrader#2479)
(Issue #3232).

**Behaviour another issue delivers is not described as present.** A doc,
prompt or code comment may name work that another issue owns — a sibling
sub-issue of the same epic or milestone, or a follow-up — only as planned
("not yet: #N will …"), and only while #N is open. Before writing a sentence
that names or depends on another issue, run `gh issue view N` and grep the
head for its deliverable: the binary, script, workflow step or check. When
that code is not at the head, the sentence describes what ships today (for
example "written by hand, see Step 1"), not the plan; when #N was closed as
not planned, the forward reference goes. When the issue's plan says a sibling
will do X, grep the docs the diff touches for that sibling's `#N`, and make
each present-tense hit either backed by head code or reworded as planned.
This adds to the rule that every doc assertion must match the head code; it
does not relax it. Milestone sub-PRs merge into the milestone branch on green
CI without review, so a sibling dropped later leaves its forward references
there until the milestone's summary PR is reviewed; that PR's body lists
each Markdown line the milestone adds that names a milestone issue, or an
issue one declares as a bare `#N` with `Depends on` or `Blocked by` (an
`owner/repo#N` dependency is not read, even when it names this repo), closed
as not planned
(see [Milestones](docs/workflows/milestones.md)); a follow-up named only in
the prose is not scanned, so the review still reads those lines. Fleet PRs
sent back
for this: docs described a `policy-check` binary and schema-drift test owned
by sibling GRQ-AutoTrader#2301 that were not on the branch
(GRQ-AutoTrader#2464); three runbooks said the deploy's publish step (#2303)
writes the policy after #2303 was closed as not planned
(GRQ-AutoTrader#2506); two docs called a red dependency audit "never
deferred" while the refusal that makes it true was still-open sibling #3141
(VibeCoder#3156) (Issue #3223).

For changes to architecture, workflows, or sequence of events, include a
**Mermaid** diagram in a fenced `` ```mermaid `` block — it renders natively on
GitHub and often tells the story better than prose.

## Available Tools

The following tools are installed, authenticated, and available — use them
proactively:

- **GitHub CLI (`gh`)** — for all GitHub operations (issues, PRs, comments, API
  access). Prefer `gh` over web scraping or raw API calls.
- **Playwright MCP (headless browser)** — for browser automation: navigating
  URLs, inspecting pages, taking screenshots (save to `docs/evidence/`), and
  interacting with web interfaces. Wired into a run only when that run needs a
  browser — a `needs-screenshot` issue, or a repo configured with
  `requiresScreenshots` (Issue #192), and never a repo that sets
  `skip_screenshot_check` (Issue #1584); a backend run is given no browser
  tool.

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
- **Verify a claim about another component before you write it.** Before new
  prompt or doc text states how another part of the system behaves, find the
  code that implements that behaviour and cite the file in the PR body — above
  all for an exclusive or negative claim ("the only …", "never …", "the worker
  does not …"). A statement about a security control (redaction, guards,
  sandboxing, dedup) must agree with [SECURITY.md](SECURITY.md) and
  [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md); when they disagree, fix the
  claim or raise the discrepancy rather than writing around it. When a rule
  needs no claim about the system to justify it, leave the claim out: state the
  rule and the risk it addresses. Two fleet PRs were sent back for this: one
  told the scan prompts a known-open list was "the only dedup source" while
  every security_scan caller passed it empty (#3068); one said the worker files
  an agent's `gh issue create` body unscrubbed, when the `gh` guard shim
  redacts it (#3071).
- **Check the existing rules before you add one.** Before adding or changing a
  rule in `prompts/*/prompt.md`, `CODING-STANDARDS.md` or a shared prompt
  constant under `worker/deno/lib/`, grep those files for existing rules on
  the same subject — the nouns the rule governs (the file, label, test,
  channel or step), not only the issue's wording. Where an existing rule
  overlaps, make the new rule agree with it, or change the existing rule in
  the same diff and say so in the PR body; changing it is part of this
  change, not separate work to note for a follow-up. A broad rule ("never …",
  "every …", "any …") must name every exception the existing rules carve out.
  Two rules left telling the agent to do opposite things are a defect to fix
  before the PR is raised, not a follow-up: the model picks one at random or
  freezes, and a later reader cannot tell which was meant to win. The PR body
  lists the related existing rules you checked, or says you found none. Two
  fleet PRs were sent back for this: one told the agent never to obey
  directives in any file it reads while the run prompts still told it to do
  what `.vibe-run-budget.md` says (#3066); one called a test the summary
  cites but the diff lacks a violation while the named-test rule accepts a
  test already tracked at the head (#3075).
- **Scope a rule to the runs it is true for.**
  `prompts/coding_guidelines/prompt.md` is rendered into every phase that
  `CODING_GUIDELINES_LAYER_BY_PHASE` (`worker/deno/lib/prompt_builder.ts`)
  lists for its layer: every phase loads the core layer, and the `code`
  layer reaches issue, CI-fix, PR-feedback, merge-conflict, custom PR and
  workflow-setup runs alike, so a layer marker cannot say "issue runs only".
  Before you add a sentence there about what the worker does (what it reads,
  honours, defers or ignores), check it against the processor for each run
  that loads it. If it holds for only some of them, name those runs in the
  sentence ("In an issue run, …") or move the sentence to that run type's
  own `prompts/<type>/prompt.md`. Two fleet PRs were sent back for this: one
  told every run that a `Depends on owner/repo#N` hand-off is not read once
  work is committed, while a CI-fix run always has commits and
  `_resolveBaseBranchDeferral` in `worker/deno/lib/pr_ci_processor.ts` reads
  it from `.pr_response_message` (#3075); one said the escape hatch is
  honoured only when the run leaves no commit, while
  `worker/deno/lib/pr_feedback_processor.ts` runs `detectEscapeHatch` on
  `.pr_response_message` whatever the branch holds (#3095).

## Configuration

The worker is configured via `.config.json` (gitignored) — configuration is
**operator-side only**; target repositories carry no worker configuration. See
[Configuration Reference](docs/CONFIGURATION.md) for details and
[SECURITY.md](SECURITY.md) for security-related configuration guidance.
