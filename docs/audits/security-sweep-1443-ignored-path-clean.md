# 🔎 Security sweep — reused-tree ignored clean (`ignored_path_clean.ts`)

**Issue:** [#1443](https://github.com/stSoftwareAU/VibeCoder/issues/1443)
(chunk 12g) · **Parent:** #1209
`security-scan-overflow: 4 chunks not reached`

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12f) recorded their coverage:

- `worker/deno/lib/ignored_path_clean.ts` — added by #1443.

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
(12e) and
[`security-sweep-1325-gh-body-file-io-and-timeout.md`](security-sweep-1325-gh-body-file-io-and-timeout.md)
(12f).

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12g**, and this file is
the reading of it.

## `worker/deno/lib/ignored_path_clean.ts`

The module is a pure argv builder plus one thin runner: it constructs the
`git clean -ffdx -- :(glob)**/<dir>/**` invocation that erases the ignored
directories a later run would execute from, and runs it through the existing
`runGitCommand` chokepoint. It reads no untrusted input, touches no
filesystem API directly, and holds no state.

Shapes checked (12a's — subprocess and argv construction):

| Property | Result |
| -------- | ------ |
| every argument is a constant | ✅ `EXECUTABLE_IGNORED_DIRS` is a literal in this module; no caller, repository or environment value reaches the argv |
| no option injection | ✅ the pathspecs follow `--`, so a name could not be read as an option even if one were attacker-controlled |
| the control is not evaded by a symlink | ✅ two pathspec forms per name — `:(glob)**/<dir>/**` for a real directory's contents and `:(glob)**/<dir>` for the entry itself, which is what catches `node_modules -> store/real`; pinned by `cleanWorkingTree - erases a symlinked dependency directory, not only a real one` |
| the pathspec cannot escape the working tree | ✅ `:(glob)**/<dir>/**` is relative and matches directory *names*; `git clean` refuses to remove anything outside the repository, and tracked paths are never removed |
| the spawn goes through the chokepoint | ✅ `runGitCommand` (`git_timeout.ts`, swept in 12a), so the timeout, redaction and auth-repair behaviour is the audited one |
| no secret reaches a sink | ✅ the only sink is `console.error` on failure, and it carries a path and git's stderr through the patched console (C24) |
| a failure cannot read as success | ✅ the ignored clean's non-zero exit and transport error both return a fail-loud `Result` naming the path, git's own message and the directories that may still hold content; `setupRepo` and the lane worktree reset refuse the tree on it, `validateRepoState` records it as a warning and the milestone sync names it in its note. The untracked `clean -fd` keeps its long-standing best-effort semantics, but its failure is warned rather than dropped |
| force scope | ✅ `-ff` is needed for a dependency directory that holds a nested `.git` (a single `-f` skips it); the pathspec bounds what the extra force can reach to the named set |

No findings. The residual — ignored content under a name outside
`EXECUTABLE_IGNORED_DIRS` — is not a defect in this module but the scope it
was given, and is recorded as **R12** in
[`../THREAT-MODEL.md`](../THREAT-MODEL.md) with the measured cost of the
alternative.
