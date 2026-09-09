# 🔎 Security sweep — the gated-head guard (`gated_head_guard.ts`)

**Issue:** [#1679](https://github.com/stSoftwareAU/VibeCoder/issues/1679)
(chunk 12l) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12k) recorded their coverage:

- `worker/deno/lib/gated_head_guard.ts` — added by #1679.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12l**, and this file is
the reading of it.

## `worker/deno/lib/gated_head_guard.ts`

The module answers "can this PR head be pushed to directly?" for the spelling,
CI-fix and merge-conflict passes. It reads
`GET /repos/{repo}/rules/branches/{branch}` through `getBranchRules` (12c),
reads the PR's comment bodies through `gh pr view --json comments`, and — at
most once per branch — posts one comment. It spawns nothing itself, writes no
file, and holds one process-lifetime `Set` of reported PRs.

Shapes checked (12c's — a module ingesting untrusted GitHub data — and 12e's):

| Property | Result |
| -------- | ------ |
| the branch name cannot inject into the comment | ✅ the only path that builds a comment is a `gated: true` assessment, and that is reachable only through `getBranchRules`, which rejects any name outside `^[A-Za-z0-9._/-]+$` (`isValidBranchName`). A hostile head ref never reaches `buildGatedHeadComment`, and the allowlist excludes every Markdown and HTML metacharacter |
| the repo slug cannot escape the API path | ✅ same chokepoint: `getBranchRules` validates `owner/repo` against `isValidRepoSlug` before the path is built |
| untrusted JSON cannot be trusted into a decision | ✅ the rules array is filtered to string `type` values on the `GATING_RULE_TYPES` allowlist; a malformed body, a non-array, or an unexpected shape yields no gating type and the head is reported pushable. Comment bodies are read only for a `String.includes` of the module's own marker |
| a failed read is never read as an answer | ✅ an unreadable ruleset returns `gated: false` with the failure in `detail` (fail **open**, deliberately: the push is then attempted exactly as before and a genuine refusal is still loud on stderr), and an unreadable comment thread **throws** rather than degrading to "no comments", so it posts nothing and warns instead of commenting once per run |
| no shell, no argv construction | ✅ every `gh` call is an argument array passed to the injected `runGhCommand`; the gh-spawn chokepoint check passes over the module |
| no credential or command output is echoed | ✅ the log fields are the repo, PR number, branch and rule types; the comment carries the branch, the rule types and fixed prose. `gh` stderr is never interpolated into the PR comment — only into a `logger.warn` |
| unbounded state | ✅ `reported` is keyed `repo#pr` and bounded by the PRs one worker run touches, cleared with the process. Deliberately not persisted, for the same reason `milestone_branch_rejection.ts` (12e) is not: a fresh run should report again while the repository is still misconfigured |
| blast radius of a wrong answer | ✅ a false `gated: true` skips a fix pass and says so on the PR; it cannot delete, merge, force-push or relabel anything. Only `milestone/**` heads are assessed at all, and the rules endpoint does not account for bypass permission, which is why the scope is not widened |

No findings. The accepted residual: on a repo where the fleet account **is** a
bypass actor on the milestone ruleset, the rules endpoint still reports the
rule, so the passes stand down on a head they could in fact have pushed. The
cost is one skipped automated fix and one comment naming the rule — the
opposite failure (a push refused every run, spending an attempt each time) is
what #1679 was raised for.
