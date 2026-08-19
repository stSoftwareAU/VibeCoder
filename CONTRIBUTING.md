# 🤝 Contributing to Vibe Coder

Thanks for your interest. Vibe Coder is an Apache-2.0 licensed, unattended
GitHub issue-to-PR worker whose value rests on a containment boundary holding
against hostile input. That shapes what we accept and how carefully we review
it. This page is the human contributor's landing; the standards that humans
and AI agents both follow are in [AGENTS.md](AGENTS.md),
[CODING-STANDARDS.md](CODING-STANDARDS.md) and
[DESIGN-PRINCIPLES.md](DESIGN-PRINCIPLES.md) — this page points into them
rather than duplicating them.

## What we accept

**Welcome, with a test:**

- Bug fixes — with a failing test first, then the fix that makes it pass.
- Hardening of any boundary named in the [Threat Model](docs/THREAT-MODEL.md)
  — closing a listed gap, reducing a residual risk, adding an enforcing test
  to a control that has none.
- Improvements to the container definition, launcher scripts and seatbelt
  profile that keep the mount set explicit and the boundary deny-by-default.
- Documentation that is accurate against the code as it is today.
- New worker commands, prompts and idle-task templates, following
  [Extending](docs/EXTENDING.md).

**Please open an issue first:**

- Anything that widens what the agent can reach — a new mount, a new
  environment variable passed through, a new outbound sink, a new GitHub
  surface the worker reads. These need a threat-model row before code
  (see [Change process](docs/THREAT-MODEL.md#-change-process)).
- New agent providers or model integrations.
- Large refactors of `worker/deno/lib`.

**Not accepted:**

- A change that weakens an execution or egress boundary in exchange for a
  stronger prompt-level defence. The threat model calls this a bad trade on
  purpose.
- Tests that grep source files for patterns instead of calling real code.
- Unpinned dependencies or actions, or a change that needs the Deno lockfile
  regenerated without saying why.

By submitting a pull request you agree that your contribution is licensed
under the [Apache License 2.0](LICENSE) (its section 5 covers this).

## Security-sensitive review

A public repository receives untrusted pull requests — exactly the class of
input this product is built to distrust — so the review bar is deliberately
higher on the paths that hold the boundary:

- `worker/deno/lib/` files named in the threat model's traceability table
  (trust classification, prompt fencing, content-approval snapshots, the `gh`
  guard and write-repository allowlist, secret redaction, the audit journal,
  container launch);
- `container/`, `hooks/`, `run.sh`, `run.ps1`, `setup.sh`, `setup.ps1`,
  `loop.sh`, `loop.ps1`;
- `.github/workflows/`.

Expect a maintainer to ask *which attack path this changes* and *which test
proves it*. Workflows from a fork run with a read-only token and no secrets;
a maintainer re-runs them after review where needed. If your change touches
security behaviour, say so in the PR body — do not make reviewers discover it.

Found a vulnerability rather than a bug? **Do not open an issue or PR.** Use
private vulnerability reporting as described in [SECURITY.md](SECURITY.md).

## The rules every change follows

- **Test-driven.** Write the failing test, watch it fail, make it pass. Every
  test calls real code and asserts on its result. See
  [Test-driven development](CODING-STANDARDS.md#test-driven-development-tdd).
- **Frozen lockfile.** Every Deno launch site runs `--frozen
  --lock=deno.lock`. A PR that changes `worker/deno/deno.lock` must explain
  the dependency change; new dependencies sit in a release-age quarantine
  before adoption.
- **SHA-pinned actions.** Every `uses:` in `.github/workflows/` is pinned to
  a 40-character commit SHA with the version tag in a leading
  `# owner/action@vX.Y.Z` comment, and one SHA carries one version comment
  across the tree. Tag or branch refs are rejected in CI.
- **`set -euo pipefail`** opens every multi-line `run:` block.
- **Never stage hidden files** (anything matching `.*`) outside the small
  allowlist in
  [Commit safety](CODING-STANDARDS.md#commit-safety--never-commit-hidden-files);
  the pre-commit hook blocks credential-shaped files and `git add -f` is
  forbidden.
- **Australian English** in prose, comments and identifiers — `behaviour`,
  `colour`, `organisation`, `licence` (noun).
- **No operator specifics.** No account names, hostnames, e-mail addresses
  or home paths in code, docs or tests. Fixtures use `example.invalid`.

## Local quality gate

One entry point mirrors CI:

```bash
./quality.sh < /dev/null
```

It runs the Deno type-check, the test suite, `deno lint`, `deno fmt --check`
and markdownlint. Redirect stdin from `/dev/null` so an unattended run can
never hang on a prompt. To run one test file:

```bash
cd worker/deno
deno test --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/<file>_test.ts
```

CI adds shellcheck, actionlint and zizmor over the workflows, secret detection
(gitleaks), SAST (semgrep), a dependency audit with SBOM, the container image
build with its containment tests, and a Markdown lint. A green local
`./quality.sh` is the best predictor of a green PR.

## Branching, commits and pull requests

- Open pull requests against the default branch. Branch names are descriptive
  kebab-case, ideally carrying the issue number
  (`issue-123-short-description`).
- Reference the issue in commit messages; lead with the *what* and the *why*;
  keep commits focused and reviewable.
- PR body: a short `## Summary` (with `Closes #N`), `## Evidence` (test
  output, a screenshot where behaviour is visual), and `## Test Plan` naming
  the tests added or changed.
- Keep the diff to the change. Reformatting unrelated files, or "while I was
  here" edits, slow review down on the paths where review matters most.

## Getting help

If something in this guide is unclear or out of date, open an issue — or a PR
fixing it. We take both gladly.
