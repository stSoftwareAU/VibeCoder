# 🔎 Security sweep — pending working-tree work (`pending_work.ts`)

**Issue:** [#1684](https://github.com/stSoftwareAU/VibeCoder/issues/1684)
(chunk 12m) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12l) recorded their coverage:

- `worker/deno/lib/pending_work.ts` — added by #1684.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12m**, and this file is the
reading of it.

## `worker/deno/lib/pending_work.ts`

The module answers "what is uncommitted here, and can it be put on the branch?"
for the quality-gate remediation phase and the completion phase. It runs one
git command of its own (`git status --porcelain`) through the injected
`runGitCommand` seam (12a's chokepoint), delegates every commit and push to
`commitAndPushPending` (`git_push.ts`, 12a/12e), and otherwise only parses
strings.

Shapes checked (12a's — a module reaching a subprocess — and 12e's):

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | ✅ the only command is the fixed array `["status", "--porcelain"]`; `repoPath` is passed as `cwd`, never spliced into argv, so no path can be read by git as an option |
| untrusted input | ✅ porcelain output is working-tree data (an agent, or repo content, chooses the filenames). It is only parsed into strings and compared against `isWorkerStatePath` (12j); nothing is executed, resolved or opened |
| a name cannot break the line it is reported on | ✅ `describePaths` replaces C0/DEL control characters with `?`, so a filename containing a newline (legal on Linux, and quoted by git as `\n`, which `decodePorcelainPath` decodes) cannot forge a second log line or a second Markdown line in a failure reason |
| unbounded output | ✅ `describePaths` names at most ten paths and summarises the rest as `(+N more)`, so a thousand-file tree cannot flood a log or a comment |
| a failed read is never read as an answer | ✅ `listPendingWorkPaths` returns `null` — deliberately distinct from `[]` — when `git status` cannot be run or exits non-zero, and every caller reports the unknown rather than treating it as a clean tree |
| commit safety | ✅ nothing is staged or committed here: `commitAndPushPending` is the only writer, so the pre-commit hidden/secret-file gate (#1758), the worker-state unstaging (#1661), the default-branch guard (#2584) and the run-id trailer (#2381) all still apply unchanged. The repo's mandatory pre-flight gate (#3577) is passed through as well — both callers hand it `resolvePreFlightSpec(config.repoConfig, repo)`, so an automated commit here is held to the same gate as one from a PR processor |
| secrets in output | ✅ only paths are logged, never file contents, git stderr or environment values |
| blast radius of a wrong answer | ✅ a false "dirty" costs one commit of the agent's own working tree onto the claim-locked issue branch; a false "clean" costs exactly what the fleet did before #1684 — nothing is deleted, force-pushed or merged |

No findings. The accepted residual: a filename may still contain Markdown
metacharacters (backtick, underscore, bracket), so a hostile path could
italicise or link part of one sentence in a log line or release comment. The
control-character scrub removes the only shape that can forge a *line*, and the
names come from the repository's own working tree — the same trust level as the
`wipNote` file names Issue #218's rescue has reported since it shipped.
