# 🧭 Issue routing — file an issue in the repository that owns the work

An issue belongs in the repository whose code the change edits, not the one
where the problem was noticed. The worker's `route-issue` command applies that
rule before it files anything, records why, and can retire an issue filed in
the wrong place or split work that spans several codebases (Issue #3691).

## The policy

| The issue asks for… | It belongs in |
| --- | --- |
| A product code change (source, CI or config a product repository versions) | That product repository, even when it was raised from VibeCoder |
| A worker, fleet, container, prompt, provider or orchestration change | `stSoftwareAU/VibeCoder`, even when the failing target was a product repository |
| A repo-scoped operational diagnostic, back-off or tally anchor (#2592) | The monitored repository it describes |
| A change in several independently deployable codebases | One linked issue per codebase |
| Anything the rules above cannot decide | The repository it was drafted in, with the basis stated, and nothing closed |

### The #2592 diagnostic exception

The worker files each repository's fast-failure tally and back-off issue in
that monitored repository on purpose (#2592), even when worker code is the
root cause. Such an issue is a coordination anchor: hosts read it to decide
whether to skip the repository. It is never moved or closed as "wrong
repository". When worker code needs fixing, that fix gets its own issue in
VibeCoder, and the two link to each other.

## How a draft is classified

`classifyIssueRouting` in
[`worker/deno/lib/issue_routing_classifier.ts`](../worker/deno/lib/issue_routing_classifier.ts)
reads only the draft's title and body, so every decision is deterministic.
The first rule that applies wins:

1. A fast-failure or tally marker for the target, or for one configured
   product repository, makes the draft a `diagnostic` in that repository.
2. Worker signals (paths such as `worker/deno/` or `prompts/`, or terms such as
   "fleet" and "orchestration") with no product signal send it to VibeCoder.
3. Product signals (terms such as "PWA", "layout" or "scoring", or paths such
   as `web/` or a stylesheet) with no worker signal send it to the product
   repository the draft names, or to the target when that is a product
   repository.
4. Both kinds of signal, with one product repository identified and the draft
   written in one of the two codebases, make it `cross-repo`: it stays in its
   target, and the work needs one issue per codebase.
5. Anything else is `ambiguous`.

The product repositories are the `repos` list in `.config.json`.

### The audit fields

Every decision carries four fields, printed by `route-issue --json` and
written into each filed issue:

| Field | Meaning |
| --- | --- |
| `owner_repository` | Where the issue belongs |
| `subject_repository` | Whose behaviour it describes |
| `issue_kind` | `implementation`, `diagnostic`, `cross-repo` or `ambiguous` |
| `reason` | The basis: the signals found and the rule that applied |

A filed issue's body ends with a visible `Routing:` line and a hidden marker,
for example:

```text
Routing: owner `stSoftwareAU/GRQ-AutoTrader`, subject `stSoftwareAU/GRQ-AutoTrader`, kind `implementation` — a product change with no worker signal (…)
<!-- issue-routing owner=stSoftwareAU/GRQ-AutoTrader subject=stSoftwareAU/GRQ-AutoTrader kind=implementation -->
```

## Filing an issue

```bash
cd worker/deno
deno run --allow-all mod.ts route-issue --repo stSoftwareAU/VibeCoder \
  --title "PWA iPhone: too big a gap above the header" \
  --body-file draft.md --label bug --dry-run --json
```

`fileRoutedIssue` in
[`worker/deno/lib/issue_routing_filing.ts`](../worker/deno/lib/issue_routing_filing.ts)
runs these steps in order, and a failure names its step:

1. **classify** — an `ambiguous` decision files nothing; the command exits
   non-zero and prints the basis.
2. **search** — an open issue or PR in the owner repository with the same
   title, or one closed in the last 30 days, is reused (`reused`) instead of
   filing another.
3. **permission** — the caller must have write access to the owner
   repository.
4. **create** — the issue is created with the audit line and marker.
5. **recheck** — when another filer created the same issue at the same time,
   the higher-numbered copy is closed as `not planned`, pointing at the
   lower-numbered one, which is the one kept.

Without `--dry-run` the same command files the issue. With `--dry-run` only
steps 1–3 run, and the result is `would-create` or `would-reuse`. A retry
after a failure part-way through finds the issue the first run created, so it
never files a second one.

`--label` takes a comma-separated list or a JSON array. Reserved workflow
labels and configured custom labels are stripped. When the issue is filed in
another repository, no label is applied there: the body gets a
`Labels not migrated:` line instead. Assignees are never copied.

## Retiring a wrong-repository duplicate

```bash
deno run --allow-all mod.ts route-issue \
  --resolve-duplicate stSoftwareAU/VibeCoder#3607 \
  --correct stSoftwareAU/GRQ-AutoTrader#3242 --dry-run
```

`resolveWrongRepoDuplicate` in
[`worker/deno/lib/issue_routing_resolve.ts`](../worker/deno/lib/issue_routing_resolve.ts)
reads the wrong issue X, classifies it, and then:

1. checks write access to both repositories;
2. verifies the correct issue Y is open, or, with no `--correct`, files Y in
   the owner repository (reusing a same-titled issue already there);
3. comments on Y, then on X, so each links to the other;
4. only then closes X as `not planned`, giving the routing reason.

It refuses, and changes nothing, when X is already closed, when X carries
a fast-failure or tally marker (#2592), when the owner is `ambiguous` (the basis
is printed), when the classifier keeps X in its own repository, or when
`--correct` names a repository other than the owner. A failed step exits
non-zero, names the step and leaves X open. Each linking comment carries a
marker, so a re-run skips the links that already exist and finishes the job.
With `--dry-run` it prints the planned steps and makes no write call.

`--repo`, `--title`, `--body-file`, `--label` and `--part` cannot be combined
with `--resolve-duplicate`.

## Splitting work across codebases

```bash
deno run --allow-all mod.ts route-issue --repo stSoftwareAU/VibeCoder \
  --body-file draft.md \
  --part '["stSoftwareAU/VibeCoder=Heal a dangling HEAD before creating lane worktrees","stSoftwareAU/GRQ-AutoTrader=Shrink the PWA header gap"]' \
  --dry-run
```

`fileSplitIssues` in
[`worker/deno/lib/issue_routing_split.ts`](../worker/deno/lib/issue_routing_split.ts)
files one issue per `owner/name=Title` part, each starting from the shared
body and recorded as `cross-repo`. The operator's choice of repository is the
routing decision here, so the classifier is not asked again. Once every part
exists, each body gets a sibling block listing the others.

- A split needs at least two parts, each in a different repository, and each
  repository must be VibeCoder or one in `repos`.
- `--label` applies only to the part in `--repo`; the other parts get a
  `Labels not migrated:` line.
- If a part fails, the parts that were filed are reported, the missing ones
  are listed, siblings are not linked, and the command exits non-zero. A
  re-run reuses the parts that exist (found by title) and completes the set.
- With `--dry-run` it lists every planned part and makes no write call.

The worker's argument parser keeps only the last value of a repeated flag, so
several parts go in one JSON array; a lone part is refused.

## Agents

Agents file follow-up issues with `gh issue create` themselves. The phase
prompts (planning, PR feedback, CI fix and the shared coding guidelines) tell
them to apply the policy above when choosing `--repo`, and to keep #2592
diagnostics where they are. `route-issue` is the operator and script entry
point for the same rules.

## Related

- [Cross-repo fix](CROSS-REPO-FIX.md) — raising a PR in an internal
  dependency, as opposed to filing an issue there.
