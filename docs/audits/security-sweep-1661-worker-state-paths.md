# 🔎 Security sweep — worker-owned state paths (`worker_state_paths.ts`)

**Issue:** [#1661](https://github.com/stSoftwareAU/VibeCoder/issues/1661)
(chunk 12j) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12i) recorded their coverage:

- `worker/deno/lib/worker_state_paths.ts` — added by #1661.

Siblings:
[`security-sweep-1214-subprocess-argv.md`](security-sweep-1214-subprocess-argv.md)
(12a),
[`filesystem-path-temp-sweep-1215.md`](filesystem-path-temp-sweep-1215.md)
(12b),
[`security-sweep-1216-untrusted-github-ingestion.md`](security-sweep-1216-untrusted-github-ingestion.md)
(12c),
[`security-sweep-1217-env-config-secrets.md`](security-sweep-1217-env-config-secrets.md)
(12d),
[`security-sweep-1219-lib-closing-pass.md`](security-sweep-1219-lib-closing-pass.md)
(12e),
[`security-sweep-1325-gh-body-file-io-and-timeout.md`](security-sweep-1325-gh-body-file-io-and-timeout.md)
(12f),
[`security-sweep-1443-ignored-path-clean.md`](security-sweep-1443-ignored-path-clean.md)
(12g),
[`security-sweep-1631-worker-record-block.md`](security-sweep-1631-worker-record-block.md)
(12h) and
[`security-sweep-1597-gate-skip-drift.md`](security-sweep-1597-gate-skip-drift.md)
(12i).

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12j**, and this file is
the reading of it.

## `worker/deno/lib/worker_state_paths.ts`

The module is pure string matching. It exports the three worker state-file
shapes and one predicate, `isWorkerStatePath`, which `git_push.ts` uses to
unstage the worker's own files between `git add -A` and the pre-commit safety
gate (#1758). It spawns nothing, touches no filesystem or network, holds no
state and reads no configuration. Its whole exposure is the path list
`git diff --cached --name-only -z` returns — repository-controlled filenames.

The consequence of a wrong answer is asymmetric, and only one direction is
dangerous:

- a **false negative** leaves the path staged, so the #1758 gate judges it
  exactly as it does today — no loss of protection;
- a **false positive** unstages a genuine repository file, so a committed
  change silently loses it. That is what the strictness below defends.

Shapes checked (12e's — a pure module with untrusted string input):

| Property | Result |
| -------- | ------ |
| only exact top-level names match | ✅ the tail pattern is anchored `^[A-Za-z0-9._-]+_\d+$`, and `/` is outside the class, so `.heartbeat_x_1/notes.txt`, `docs/.heartbeat_x_1` and `foo/.vibe_default_branch` are all rejected. Pinned by `isWorkerStatePath - rejects nested, truncated and unrelated paths` |
| no looser shape slips in | ✅ `.heartbeat_x`, `.heartbeat_x_`, `.heartbeat_x_12a`, `.vibe_default_branch.bak` and `.vibe_default_branchx` are rejected; the default-branch cache is an exact string equality, never a prefix test |
| the empty and non-ASCII cases | ✅ `""` matches no prefix and is not the exact name; the character class admits no unicode, so `.heartbeat_ownér_repo_1` and Arabic-Indic digits are rejected |
| no catastrophic backtracking | ✅ one anchored quantified class, no nesting. Measured on `.heartbeat_` + `a_1`×N + `!`: 0.017ms at N=1000, 0.060ms at N=4000, 0.154ms at N=16000 — growth below the input's, and git bounds a path at 4096 bytes anyway |
| the matcher cannot widen the safety gate | ✅ it is consulted *before* `assertSafeToCommit`, on the index only; `ALLOWED_HIDDEN_PATHS`, `FORBIDDEN_STAGED_PATTERNS` and `REQUIRED_GITIGNORE_PATTERNS` are untouched, so `.env` and `credentials.json` are refused exactly as before. Pinned by `commitAndPushPending - still refuses a staged secret when worker state is present (Issue #1661)` |
| single source of truth with the writers | ✅ `heartbeat_storage.ts` builds its paths from the same two prefix constants, so a rename cannot leave the matcher blind. Pinned by `isWorkerStatePath - matches the paths the writers actually produce` |
| no secret reaches a sink | ✅ the module logs nothing and returns a boolean; the caller's warning names only paths git already reported |

No findings. The accepted residual is the one the issue names: a repository
file whose name exactly matches `.heartbeat_<repo>_<n>` is unstaged with a
warning rather than committed — and the #1758 gate would have refused the
whole commit over it anyway, so nothing hidden reaches a commit either way.
