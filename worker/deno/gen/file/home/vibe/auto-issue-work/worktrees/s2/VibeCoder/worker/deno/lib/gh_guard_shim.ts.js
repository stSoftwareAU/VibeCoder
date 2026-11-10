/**
 * Agent-side `gh` guard shim (Issue #3643).
 *
 * The write-repo allowlist and the worker label guard enforce inside the
 * worker's Deno process only. The agent subprocess is spawned with
 * `--dangerously-skip-permissions` and an inherited `GH_TOKEN`, so a
 * prompt-injected `gh issue comment -R other/repo …` from the agent's own Bash
 * reached GitHub without passing either control.
 *
 * This module interposes on the child: a wrapper named `gh` is written to a
 * per-spawn directory that is prepended to the child's `PATH`. Every `gh` the
 * agent runs therefore re-enters {@link evaluateGhCommand} (the same
 * classifier and reserved-label list the worker uses) before the real binary
 * is `exec`d. The run's allowlist is baked into the generated wrapper as
 * arguments rather than passed in the environment, so it cannot be switched
 * off with an `unset`.
 *
 * The verdict covers argv, so the wrapper also re-asserts the run's own target
 * environment before delegating (Issue #3866): the real binary otherwise takes
 * its target repo from `GH_REPO`/`GH_HOST` and its aliases from
 * `GH_CONFIG_DIR`, none of which appear in the argv the guard judged. See
 * {@link GH_CLEARED_ENV_VARS} and {@link GH_PINNED_ENV_VARS}.
 *
 * The guard is also where the agent's published bodies are redacted (Issue
 * #3938). `redactGhBodyArgs` was wired inside `spawnGh` only — the worker's
 * chokepoint, which this subprocess bypasses — so model output, the body class
 * most likely to carry a leaked credential, was published verbatim. The guard
 * child now returns the argv to run rather than a bare verdict: body arguments
 * (`--body`, `-b`, `--body=`, `-f/-F body=`, and `--body-file` contents) come
 * back masked, and the wrapper `exec`s *that* argv. Redaction is therefore a
 * property of the chokepoint, not of which process called it.
 *
 * ```mermaid
 * flowchart LR
 *     A["Agent Bash: gh …"] --> S["PATH shim: gh"]
 *     S --> G["gh_guard_cli.ts<br/>evaluateGhCommand + redactGhBodyArgs"]
 *     G -- "allowed (redacted argv)" --> R["real gh binary"]
 *     G -- refused --> X["exit 1 + SECURITY log line"]
 * ```
 *
 * **The `git` wrapper rides in the same directory (Issue #1284).** `git push`
 * is as public a sink as a comment and its history is permanent, so
 * `installGhGuardShim` also writes the `git` wrapper described in
 * `git_guard_shim.ts` beside the `gh` one — one PATH prefix covers both
 * binaries, and one cleanup removes both.
 *
 * **Fails closed.** If the guard cannot be evaluated (missing Deno, missing
 * module, any non-refusal error) the wrapper refuses the call rather than
 * passing it through. If the shim itself cannot be installed while the
 * write-repo allowlist is active, the install is **blocked** (Issue #3869):
 * the caller must refuse to spawn the agent rather than run it with the raw
 * environment, because a full `TMPDIR`, a restrictive umask, or a `PATH`
 * without `gh` would otherwise turn a mundane I/O fault into complete loss of
 * egress containment. Every such event emits a
 * `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE]` warning **and** an audit-journal
 * entry, so the loss is visible to `deno task audit-log-tail` rather than only
 * in console output. A degraded, unguarded run remains possible only behind an
 * explicit operator opt-in ({@link UNGUARDED_AGENT_GH_ENV}), or when the
 * allowlist is inactive and there is no containment boundary to lose.
 *
 * **Residual risk, stated plainly.** This is a containment boundary against a
 * single injected `gh` command, not a sandbox. An agent that deliberately
 * invokes the real binary by absolute path, or edits `PATH`, bypasses it. The
 * durable fix is a per-run GitHub App token scoped to the target repo — the
 * follow-up already noted in `write_repo_allowlist.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { recordMutation, resolveBaseDir, resolveRunId, resolveWorkerId } from "./audit_journal.ts";
import { rosterPath, rosterSeenPath } from "./audit_anchor.ts";
import { isAuditJournalEnabled } from "./audit_hook.ts";
import { resolveGuardModulePath } from "./guard_module_path.ts";
import { DENO_SEED_DIR_ENV, expectsReadOnlyGuardCache, resolveGuardDenoDir } from "./guard_deno_dir.ts";
import { GH_GUARD_ALLOW_MARKER, GH_GUARD_REFUSE_MARKER } from "./gh_guard_cli.ts";
import { isWriteRepoAllowlistActive, listAllowedWriteRepos, noteAgentAllowlistSnapshot } from "./write_repo_allowlist.ts";
import { defaultGitGuardModulePath, renderGitShimScript } from "./git_guard_shim.ts";
import { posixSingleQuote as shellQuote } from "./shell_quote.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { claimedIssueGuard } from "./claimed_issue_guard.ts";
/**
 * `gh` target variables the wrapper always clears (Issue #3866).
 *
 * The guard reaches its verdict from argv alone, but `gh` resolves the repo it
 * writes to from `GH_REPO` as well. `GH_REPO=other/repo gh issue comment 1
 * --body …` therefore classified as a cwd-scoped write to the run's own repo
 * and landed on `other/repo`. The guard's cwd-scope reasoning *is* "no
 * `GH_REPO`", so it is cleared unconditionally rather than re-asserted; the
 * worker never sets it. The enterprise tokens go with it — one supplied inline
 * would authenticate a redirected call.
 */ export const GH_CLEARED_ENV_VARS = [
  "GH_REPO",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN"
];
/**
 * `gh` target variables the wrapper re-asserts from the run (Issue #3866).
 *
 * A deployment may legitimately set these — `GH_HOST` names a GitHub
 * Enterprise host, `GH_CONFIG_DIR` selects the worker identity's `gh` config —
 * so the wrapper pins the run's own value and drops whatever the caller
 * supplied. Pinning `GH_CONFIG_DIR` also fixes which config file's aliases
 * `gh` can expand. A variable the run does not set is cleared in the child.
 */ export const GH_PINNED_ENV_VARS = [
  "GH_HOST",
  "GH_CONFIG_DIR"
];
/**
 * Environment variable an operator sets to permit a degraded, **unguarded**
 * agent run when the shim cannot be installed (Issue #3869).
 *
 * Absent (or falsey), an uninstallable shim blocks the spawn while the
 * write-repo allowlist is active. This is deliberately an operator decision,
 * never an inference from an I/O failure.
 */ export const UNGUARDED_AGENT_GH_ENV = "VIBE_ALLOW_UNGUARDED_AGENT_GH";
/** Audit verb recorded when the shim could not be installed (Issue #3869). */ export const GH_GUARD_SHIM_AUDIT_VERB = "gh-guard-shim-unavailable";
/**
 * Find an executable named `name` on a `PATH` string.
 *
 * @param name - Binary name to resolve (e.g. `gh`).
 * @param pathValue - Colon-separated `PATH` to search.
 * @returns Absolute path of the first executable match, or undefined.
 */ export function resolveExecutable(name, pathValue) {
  for (const dir of pathValue.split(":")){
    if (dir.length === 0) continue;
    const candidate = `${dir}/${name}`;
    try {
      const info = Deno.statSync(candidate);
      if (info.isFile && ((info.mode ?? 0o111) & 0o111) !== 0) return candidate;
    } catch  {
    // Not present in this directory — keep searching.
    }
  }
  return undefined;
}
/** Absolute path of the guard entry point this shim invokes. */ function defaultGuardModulePath() {
  // Issue #1444: the read-only checkout, not the writable staged copy this
  // module is running from — the agent must not be able to edit the guard
  // that constrains it. See `guard_module_path.ts`.
  return resolveGuardModulePath("gh_guard_cli.ts", import.meta.url);
}
/**
 * Render the wrapper script.
 *
 * Exported for direct assertion of the fail-closed contract in tests.
 *
 * @param opts - Absolute binary/module paths plus the run's allowlist state.
 * @returns The bash script body.
 */ export function renderGhShimScript(opts) {
  const claim = opts.claimedIssue;
  const guardArgs = [
    ...opts.active ? [
      "--active"
    ] : [],
    ...opts.allowedRepos.flatMap((r)=>[
        "--allow-repo",
        r
      ]),
    // Issue #222 — baked in as arguments, like the allowlist, so the agent
    // cannot switch the claimed-issue guard off with an `unset`.
    ...claim ? [
      "--claimed-issue",
      `${claim.repo}#${claim.issueNumber}`,
      ...claim.allowedVerbs.flatMap((v)=>[
          "--allow-issue-verb",
          v
        ])
    ] : [],
    // Issue #1364 — a masked `gh api --input` body is a fresh file the child
    // reads after the guard has exited, so the guard cannot remove it. It
    // lands in the wrapper's own per-spawn directory instead of TMPDIR, and
    // dies with it when the spawn site cleans up.
    "--body-dir",
    opts.verdictDir,
    ...opts.audit ? [
      "--audit-dir",
      opts.audit.baseDir,
      "--audit-worker",
      opts.audit.workerId,
      "--audit-run",
      opts.audit.runId
    ] : []
  ].map(shellQuote).join(" ");
  // Issue #1604 — the journal's footprint, and only that: the journal
  // directory (entries, lock, anchors) and the roster pair that sits beside
  // it. Everything else the child may write is still the verdict buffer.
  const writeGrant = [
    opts.verdictDir,
    ...opts.audit ? [
      opts.audit.baseDir,
      rosterPath(opts.audit.baseDir),
      rosterSeenPath(opts.audit.baseDir)
    ] : []
  ].map(shellQuote).join(",");
  // Issue #3866: clear what the run never sets, pin what it does. `unset`
  // first, so a variable the run has no value for cannot be supplied by the
  // agent.
  const cleared = [
    ...GH_CLEARED_ENV_VARS
  ];
  const pins = [];
  for (const name of GH_PINNED_ENV_VARS){
    const value = opts.pinnedEnv?.[name];
    if (value === undefined) cleared.push(name);
    else pins.push(`export ${name}=${shellQuote(value)}`);
  }
  const targetEnvLines = [
    `unset ${cleared.join(" ")}`,
    ...pins
  ].join("\n");
  // Issue #1448 — the guard child must not read code back from a cache the
  // agent can write or choose. Pinned here, beside the gh target variables,
  // for the same reason they are: the wrapper judges argv, and everything
  // else the child could be steered by is the run's to set, not the caller's.
  const denoDirLine = `export DENO_DIR=${shellQuote(opts.denoDir)}`;
  const ALLOW_MARKER = GH_GUARD_ALLOW_MARKER;
  const REFUSE_MARKER = GH_GUARD_REFUSE_MARKER;
  // bash 3.2 (macOS) under `set -u` treats an empty array expansion as an
  // unbound variable, hence the ${arr[@]+"${arr[@]}"} guard.
  // `#!/bin/bash` rather than `/usr/bin/env bash`: a security wrapper must not
  // depend on the PATH of whoever invokes it.
  return `#!/bin/bash
# Vibe Coder gh guard shim (Issue #3643) — generated per run; do not edit.
# Re-enters the write-repo allowlist and the reserved-label guard for every
# gh call made by the agent subprocess, then delegates to the real binary.
set -uo pipefail

# Issue #3866 — the real gh resolves its target from more than argv: GH_REPO
# and GH_HOST redirect a repo-scoped command, and GH_CONFIG_DIR selects the
# config file whose aliases it expands. The guard judges argv alone, so the
# run's own values are re-asserted here rather than inherited from the caller.
${targetEnvLines}
# Issue #1448 — and the cache the guard child reads its own compiled modules
# back from is the run's choice too: a read-only directory where one exists.
${denoDirLine}

GUARD_ARGS=(${guardArgs})

# Issue #3938 — the guard returns the argv to run, with the published bodies
# redacted, as NUL-terminated fields. A NUL cannot cross a command
# substitution, so the verdict is buffered in the wrapper's own private
# directory (0700, per spawn, removed when the child exits) instead. No
# external command is used for it: a security wrapper must not need a PATH
# lookup, and the agent controls its own PATH. Issue #1364 — a masked
# --input body is written to that same directory, so it too is removed with it.
GUARD_OUT=${shellQuote(opts.verdictDir)}/verdict.$$
if ! : > "$GUARD_OUT"; then
  printf '%s\\n' "[SECURITY] [GH_GUARD_ERROR] could not create the guard's verdict file — refusing to run this gh command." >&2
  exit 126
fi

status=0
${shellQuote(opts.denoPath)} run --quiet --no-config --no-lock --allow-read \\
  --allow-write=${writeGrant} \\
  ${shellQuote(opts.guardModulePath)} \\
  \${GUARD_ARGS[@]+"\${GUARD_ARGS[@]}"} -- "$@" >"$GUARD_OUT" || status=$?

fields=()
while IFS= read -r -d '' field; do
  fields+=("$field")
done < "$GUARD_OUT"
# Drop the buffered body immediately; the directory itself goes at run end.
: > "$GUARD_OUT"

verdict="\${fields[0]-}"

# Positive marker only: a missing/garbled verdict means the guard did not run,
# which is refused rather than waved through.
if [ "$status" -eq 0 ] && [ "$verdict" = "${ALLOW_MARKER}" ]; then
  GH_ARGS=()
  seen_verdict=0
  for field in \${fields[@]+"\${fields[@]}"}; do
    if [ "$seen_verdict" -eq 0 ]; then seen_verdict=1; continue; fi
    GH_ARGS+=("$field")
  done
  # Redaction never adds or drops an argument, so a different count means the
  # rewrite is not the command the guard judged.
  if [ "\${#GH_ARGS[@]}" -eq "$#" ]; then
    exec ${shellQuote(opts.realGhPath)} \${GH_ARGS[@]+"\${GH_ARGS[@]}"}
  fi
  printf '%s\\n' "[SECURITY] [GH_GUARD_ERROR] the guard returned \${#GH_ARGS[@]} arguments for a $# argument command — refusing to run it." >&2
  exit 126
fi

if [ "$verdict" != "${REFUSE_MARKER}" ]; then
  printf '%s\\n' "[SECURITY] [GH_GUARD_ERROR] guard could not evaluate this gh command (exit $status) — refusing to run it." >&2
  if [ "$status" -eq 0 ]; then status=126; fi
fi
exit "$status"
`;
}
/**
 * Whether an operator has opted in to running the agent unguarded.
 *
 * A read that throws (no `--allow-env`) counts as **no** opt-in, so the
 * decision stays fail-closed.
 *
 * @param env - Environment lookup (Issue #964); defaults to the process
 *   environment. Exported so the opt-in spelling can be asserted directly
 *   against an injected map.
 */ export function unguardedOptInFromEnv(env = processEnvLookup) {
  let raw;
  try {
    raw = env(UNGUARDED_AGENT_GH_ENV);
  } catch  {
    return false;
  }
  const value = (raw ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "no";
}
/**
 * Default audit sink — journal the shim-unavailable event.
 *
 * Gated exactly like the other chokepoint hooks (`WORK_DIR` present and
 * journalling not disabled), so unit tests incur no journal side effects.
 * Rejects when the append is refused, so the caller can say so loudly.
 */ async function journalShimUnavailable(mutation, env = processEnvLookup) {
  if (!isAuditJournalEnabled(env)) return;
  const result = await recordMutation(mutation);
  if (!result.ok) throw result.error;
}
/**
 * Install the `gh` wrapper for one agent subprocess.
 *
 * @param opts - Base environment, allowlist state, and test seams.
 * @returns The installed shim, or a `blocked`/`degraded` outcome when it could
 *   not be installed (a `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE]` warning and an
 *   audit-journal entry are emitted first).
 */ export async function installGhGuardShim(opts) {
  const warn = opts.warn ?? ((m)=>console.error(m));
  const env = opts.env ?? processEnvLookup;
  const record = opts.record ?? ((mutation)=>journalShimUnavailable(mutation, env));
  /**
   * Report an uninstallable shim and decide whether the run may continue.
   *
   * Fail closed (Issue #3869): while the allowlist is active, only an explicit
   * operator opt-in downgrades the block to a degraded run.
   */ const unavailable = async (why)=>{
    const optedIn = opts.allowUnguarded ?? unguardedOptInFromEnv(env);
    const blocked = opts.active && !optedIn;
    warn(blocked ? `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE] refusing to start the agent: ` + `its gh calls would bypass the write-repo allowlist and the ` + `reserved-label guard entirely — ${why}. Set ` + `${UNGUARDED_AGENT_GH_ENV}=1 to permit a degraded, unguarded run.` : `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE] agent gh calls are NOT ` + `guarded by the write-repo allowlist or the reserved-label guard: ` + `${why}` + (optedIn ? ` (permitted by ${UNGUARDED_AGENT_GH_ENV})` : ""));
    try {
      await record({
        runId: resolveRunId(),
        verb: GH_GUARD_SHIM_AUDIT_VERB,
        outcome: "error",
        target: `${blocked ? "blocked" : "degraded"}: ${why}`,
        caller: "worker/deno/lib/gh_guard_shim.ts"
      });
    } catch (err) {
      // Never let journalling mask the verdict — but say so (Issue #3234).
      warn(`[SECURITY] [AUDIT_JOURNAL_REFUSED] ${GH_GUARD_SHIM_AUDIT_VERB}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return blocked ? {
      status: "blocked",
      reason: why
    } : {
      status: "degraded",
      reason: why
    };
  };
  const pathValue = opts.baseEnv["PATH"] ?? "";
  const realGhPath = resolveExecutable("gh", pathValue);
  if (!realGhPath) return await unavailable("no gh binary found on PATH");
  const denoPath = opts.denoPath ?? Deno.execPath();
  const guardModulePath = opts.guardModulePath ?? defaultGuardModulePath();
  const makeTempDir = opts.makeTempDir ?? (()=>Deno.makeTempDir({
      prefix: "vibe-gh-guard-"
    }));
  let dir;
  try {
    dir = await makeTempDir();
  } catch (err) {
    return await unavailable(`could not create the shim directory: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Issue #1448: both wrappers pin the guard child's Deno cache — the image's
  // read-only seed when this host has one, else a directory of this run's
  // own. Only the container is expected to have the seed; there, its absence
  // (or a writable one) means the guard's compiled modules are agent-writable
  // between calls, which is said out loud rather than assumed away.
  const denoDir = resolveGuardDenoDir(`${dir}/deno-cache`, env, opts.guardDenoDirProbe);
  if (!denoDir.readOnly && expectsReadOnlyGuardCache(env)) {
    warn(`[SECURITY] [GH_GUARD_CACHE_WRITABLE] the guard child's Deno cache ` + `${denoDir.path} is writable by the agent's own uid — no read-only ` + `seed cache is available (${DENO_SEED_DIR_ENV}) — so the guard's ` + `compiled modules can be modified between calls (Issue #1448).`);
  }
  // Issue #1284: the `git` wrapper goes in the same directory, so one PATH
  // prefix covers both binaries and one cleanup removes both.
  const realGitPath = resolveExecutable("git", pathValue);
  const gitShimPath = realGitPath ? `${dir}/git` : undefined;
  const shimPath = `${dir}/gh`;
  try {
    if (gitShimPath && realGitPath) {
      await Deno.writeTextFile(gitShimPath, renderGitShimScript({
        denoPath,
        guardModulePath: defaultGitGuardModulePath(),
        realGitPath,
        verdictDir: dir,
        denoDir: denoDir.path
      }));
      await Deno.chmod(gitShimPath, 0o755);
    }
    await Deno.writeTextFile(shimPath, renderGhShimScript({
      denoPath,
      guardModulePath,
      realGhPath,
      active: opts.active,
      allowedRepos: opts.allowedRepos,
      ...opts.claimedIssue ? {
        claimedIssue: opts.claimedIssue
      } : {},
      verdictDir: dir,
      denoDir: denoDir.path,
      // Issue #1604 — refusals reach the same journal as every other
      // classified mutation, wherever that journal is on for this run.
      ...isAuditJournalEnabled(env) ? {
        audit: {
          baseDir: resolveBaseDir(undefined, env),
          workerId: resolveWorkerId(undefined, env),
          runId: resolveRunId(env)
        }
      } : {},
      pinnedEnv: Object.fromEntries(GH_PINNED_ENV_VARS.flatMap((name)=>{
        const value = opts.baseEnv[name];
        return value === undefined ? [] : [
          [
            name,
            value
          ]
        ];
      }))
    }));
    await Deno.chmod(shimPath, 0o755);
  } catch (err) {
    await Deno.remove(dir, {
      recursive: true
    }).catch(()=>{});
    return await unavailable(`could not write the shim: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    status: "installed",
    shim: {
      dir,
      shimPath,
      ...gitShimPath ? {
        gitShimPath
      } : {},
      env: {
        ...opts.baseEnv,
        PATH: pathValue ? `${dir}:${pathValue}` : dir
      },
      denoDir,
      cleanup: async ()=>{
        try {
          await Deno.remove(dir, {
            recursive: true
          });
        } catch (err) {
          warn(`[SECURITY] [GH_GUARD_SHIM_CLEANUP] could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
}
/**
 * Install the shim for the current run, reading the live write-repo allowlist.
 *
 * The convenience wrapper `runClaudeWithTimeout` uses: it reads the allowlist
 * state seeded by the run (`seedWriteRepoAllowlist`) and bakes it into the
 * wrapper, so the agent subprocess is held to the same egress boundary as the
 * worker itself.
 *
 * The snapshot is taken once, here, and stays fixed for the life of this
 * child (Issue #3861) — the allowlist is not re-read per `gh` invocation.
 * `noteAgentAllowlistSnapshot()` tells the allowlist module that, so a later
 * worker-side grant is reported rather than mistaken for a widened agent
 * boundary.
 *
 * @param baseEnv - The child environment before the shim is prepended.
 * @param warn - Sink for the unavailable warning (defaults to console.error).
 * @param env - Environment lookup for the operator opt-in and the audit gate
 *   (Issue #961); defaults to the process environment.
 * @returns The install outcome — the caller must refuse to spawn the agent on
 *   a `blocked` verdict (Issue #3869).
 */ export function prepareGhGuardShim(baseEnv, warn, env) {
  noteAgentAllowlistSnapshot();
  const claimedIssue = claimedIssueGuard();
  return installGhGuardShim({
    baseEnv,
    active: isWriteRepoAllowlistActive(),
    allowedRepos: listAllowedWriteRepos(),
    // Issue #222 — inert unless the run seeded a claim.
    ...claimedIssue ? {
      claimedIssue
    } : {},
    ...warn ? {
      warn
    } : {},
    ...env ? {
      env
    } : {}
  });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9ndWFyZF9zaGltLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQWdlbnQtc2lkZSBgZ2hgIGd1YXJkIHNoaW0gKElzc3VlICMzNjQzKS5cbiAqXG4gKiBUaGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QgYW5kIHRoZSB3b3JrZXIgbGFiZWwgZ3VhcmQgZW5mb3JjZSBpbnNpZGUgdGhlXG4gKiB3b3JrZXIncyBEZW5vIHByb2Nlc3Mgb25seS4gVGhlIGFnZW50IHN1YnByb2Nlc3MgaXMgc3Bhd25lZCB3aXRoXG4gKiBgLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zYCBhbmQgYW4gaW5oZXJpdGVkIGBHSF9UT0tFTmAsIHNvIGFcbiAqIHByb21wdC1pbmplY3RlZCBgZ2ggaXNzdWUgY29tbWVudCAtUiBvdGhlci9yZXBvIOKApmAgZnJvbSB0aGUgYWdlbnQncyBvd24gQmFzaFxuICogcmVhY2hlZCBHaXRIdWIgd2l0aG91dCBwYXNzaW5nIGVpdGhlciBjb250cm9sLlxuICpcbiAqIFRoaXMgbW9kdWxlIGludGVycG9zZXMgb24gdGhlIGNoaWxkOiBhIHdyYXBwZXIgbmFtZWQgYGdoYCBpcyB3cml0dGVuIHRvIGFcbiAqIHBlci1zcGF3biBkaXJlY3RvcnkgdGhhdCBpcyBwcmVwZW5kZWQgdG8gdGhlIGNoaWxkJ3MgYFBBVEhgLiBFdmVyeSBgZ2hgIHRoZVxuICogYWdlbnQgcnVucyB0aGVyZWZvcmUgcmUtZW50ZXJzIHtAbGluayBldmFsdWF0ZUdoQ29tbWFuZH0gKHRoZSBzYW1lXG4gKiBjbGFzc2lmaWVyIGFuZCByZXNlcnZlZC1sYWJlbCBsaXN0IHRoZSB3b3JrZXIgdXNlcykgYmVmb3JlIHRoZSByZWFsIGJpbmFyeVxuICogaXMgYGV4ZWNgZC4gVGhlIHJ1bidzIGFsbG93bGlzdCBpcyBiYWtlZCBpbnRvIHRoZSBnZW5lcmF0ZWQgd3JhcHBlciBhc1xuICogYXJndW1lbnRzIHJhdGhlciB0aGFuIHBhc3NlZCBpbiB0aGUgZW52aXJvbm1lbnQsIHNvIGl0IGNhbm5vdCBiZSBzd2l0Y2hlZFxuICogb2ZmIHdpdGggYW4gYHVuc2V0YC5cbiAqXG4gKiBUaGUgdmVyZGljdCBjb3ZlcnMgYXJndiwgc28gdGhlIHdyYXBwZXIgYWxzbyByZS1hc3NlcnRzIHRoZSBydW4ncyBvd24gdGFyZ2V0XG4gKiBlbnZpcm9ubWVudCBiZWZvcmUgZGVsZWdhdGluZyAoSXNzdWUgIzM4NjYpOiB0aGUgcmVhbCBiaW5hcnkgb3RoZXJ3aXNlIHRha2VzXG4gKiBpdHMgdGFyZ2V0IHJlcG8gZnJvbSBgR0hfUkVQT2AvYEdIX0hPU1RgIGFuZCBpdHMgYWxpYXNlcyBmcm9tXG4gKiBgR0hfQ09ORklHX0RJUmAsIG5vbmUgb2Ygd2hpY2ggYXBwZWFyIGluIHRoZSBhcmd2IHRoZSBndWFyZCBqdWRnZWQuIFNlZVxuICoge0BsaW5rIEdIX0NMRUFSRURfRU5WX1ZBUlN9IGFuZCB7QGxpbmsgR0hfUElOTkVEX0VOVl9WQVJTfS5cbiAqXG4gKiBUaGUgZ3VhcmQgaXMgYWxzbyB3aGVyZSB0aGUgYWdlbnQncyBwdWJsaXNoZWQgYm9kaWVzIGFyZSByZWRhY3RlZCAoSXNzdWVcbiAqICMzOTM4KS4gYHJlZGFjdEdoQm9keUFyZ3NgIHdhcyB3aXJlZCBpbnNpZGUgYHNwYXduR2hgIG9ubHkg4oCUIHRoZSB3b3JrZXInc1xuICogY2hva2Vwb2ludCwgd2hpY2ggdGhpcyBzdWJwcm9jZXNzIGJ5cGFzc2VzIOKAlCBzbyBtb2RlbCBvdXRwdXQsIHRoZSBib2R5IGNsYXNzXG4gKiBtb3N0IGxpa2VseSB0byBjYXJyeSBhIGxlYWtlZCBjcmVkZW50aWFsLCB3YXMgcHVibGlzaGVkIHZlcmJhdGltLiBUaGUgZ3VhcmRcbiAqIGNoaWxkIG5vdyByZXR1cm5zIHRoZSBhcmd2IHRvIHJ1biByYXRoZXIgdGhhbiBhIGJhcmUgdmVyZGljdDogYm9keSBhcmd1bWVudHNcbiAqIChgLS1ib2R5YCwgYC1iYCwgYC0tYm9keT1gLCBgLWYvLUYgYm9keT1gLCBhbmQgYC0tYm9keS1maWxlYCBjb250ZW50cykgY29tZVxuICogYmFjayBtYXNrZWQsIGFuZCB0aGUgd3JhcHBlciBgZXhlY2BzICp0aGF0KiBhcmd2LiBSZWRhY3Rpb24gaXMgdGhlcmVmb3JlIGFcbiAqIHByb3BlcnR5IG9mIHRoZSBjaG9rZXBvaW50LCBub3Qgb2Ygd2hpY2ggcHJvY2VzcyBjYWxsZWQgaXQuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgQVtcIkFnZW50IEJhc2g6IGdoIOKAplwiXSAtLT4gU1tcIlBBVEggc2hpbTogZ2hcIl1cbiAqICAgICBTIC0tPiBHW1wiZ2hfZ3VhcmRfY2xpLnRzPGJyLz5ldmFsdWF0ZUdoQ29tbWFuZCArIHJlZGFjdEdoQm9keUFyZ3NcIl1cbiAqICAgICBHIC0tIFwiYWxsb3dlZCAocmVkYWN0ZWQgYXJndilcIiAtLT4gUltcInJlYWwgZ2ggYmluYXJ5XCJdXG4gKiAgICAgRyAtLSByZWZ1c2VkIC0tPiBYW1wiZXhpdCAxICsgU0VDVVJJVFkgbG9nIGxpbmVcIl1cbiAqIGBgYFxuICpcbiAqICoqVGhlIGBnaXRgIHdyYXBwZXIgcmlkZXMgaW4gdGhlIHNhbWUgZGlyZWN0b3J5IChJc3N1ZSAjMTI4NCkuKiogYGdpdCBwdXNoYFxuICogaXMgYXMgcHVibGljIGEgc2luayBhcyBhIGNvbW1lbnQgYW5kIGl0cyBoaXN0b3J5IGlzIHBlcm1hbmVudCwgc29cbiAqIGBpbnN0YWxsR2hHdWFyZFNoaW1gIGFsc28gd3JpdGVzIHRoZSBgZ2l0YCB3cmFwcGVyIGRlc2NyaWJlZCBpblxuICogYGdpdF9ndWFyZF9zaGltLnRzYCBiZXNpZGUgdGhlIGBnaGAgb25lIOKAlCBvbmUgUEFUSCBwcmVmaXggY292ZXJzIGJvdGhcbiAqIGJpbmFyaWVzLCBhbmQgb25lIGNsZWFudXAgcmVtb3ZlcyBib3RoLlxuICpcbiAqICoqRmFpbHMgY2xvc2VkLioqIElmIHRoZSBndWFyZCBjYW5ub3QgYmUgZXZhbHVhdGVkIChtaXNzaW5nIERlbm8sIG1pc3NpbmdcbiAqIG1vZHVsZSwgYW55IG5vbi1yZWZ1c2FsIGVycm9yKSB0aGUgd3JhcHBlciByZWZ1c2VzIHRoZSBjYWxsIHJhdGhlciB0aGFuXG4gKiBwYXNzaW5nIGl0IHRocm91Z2guIElmIHRoZSBzaGltIGl0c2VsZiBjYW5ub3QgYmUgaW5zdGFsbGVkIHdoaWxlIHRoZVxuICogd3JpdGUtcmVwbyBhbGxvd2xpc3QgaXMgYWN0aXZlLCB0aGUgaW5zdGFsbCBpcyAqKmJsb2NrZWQqKiAoSXNzdWUgIzM4NjkpOlxuICogdGhlIGNhbGxlciBtdXN0IHJlZnVzZSB0byBzcGF3biB0aGUgYWdlbnQgcmF0aGVyIHRoYW4gcnVuIGl0IHdpdGggdGhlIHJhd1xuICogZW52aXJvbm1lbnQsIGJlY2F1c2UgYSBmdWxsIGBUTVBESVJgLCBhIHJlc3RyaWN0aXZlIHVtYXNrLCBvciBhIGBQQVRIYFxuICogd2l0aG91dCBgZ2hgIHdvdWxkIG90aGVyd2lzZSB0dXJuIGEgbXVuZGFuZSBJL08gZmF1bHQgaW50byBjb21wbGV0ZSBsb3NzIG9mXG4gKiBlZ3Jlc3MgY29udGFpbm1lbnQuIEV2ZXJ5IHN1Y2ggZXZlbnQgZW1pdHMgYVxuICogYFtTRUNVUklUWV0gW0dIX0dVQVJEX1NISU1fVU5BVkFJTEFCTEVdYCB3YXJuaW5nICoqYW5kKiogYW4gYXVkaXQtam91cm5hbFxuICogZW50cnksIHNvIHRoZSBsb3NzIGlzIHZpc2libGUgdG8gYGRlbm8gdGFzayBhdWRpdC1sb2ctdGFpbGAgcmF0aGVyIHRoYW4gb25seVxuICogaW4gY29uc29sZSBvdXRwdXQuIEEgZGVncmFkZWQsIHVuZ3VhcmRlZCBydW4gcmVtYWlucyBwb3NzaWJsZSBvbmx5IGJlaGluZCBhblxuICogZXhwbGljaXQgb3BlcmF0b3Igb3B0LWluICh7QGxpbmsgVU5HVUFSREVEX0FHRU5UX0dIX0VOVn0pLCBvciB3aGVuIHRoZVxuICogYWxsb3dsaXN0IGlzIGluYWN0aXZlIGFuZCB0aGVyZSBpcyBubyBjb250YWlubWVudCBib3VuZGFyeSB0byBsb3NlLlxuICpcbiAqICoqUmVzaWR1YWwgcmlzaywgc3RhdGVkIHBsYWlubHkuKiogVGhpcyBpcyBhIGNvbnRhaW5tZW50IGJvdW5kYXJ5IGFnYWluc3QgYVxuICogc2luZ2xlIGluamVjdGVkIGBnaGAgY29tbWFuZCwgbm90IGEgc2FuZGJveC4gQW4gYWdlbnQgdGhhdCBkZWxpYmVyYXRlbHlcbiAqIGludm9rZXMgdGhlIHJlYWwgYmluYXJ5IGJ5IGFic29sdXRlIHBhdGgsIG9yIGVkaXRzIGBQQVRIYCwgYnlwYXNzZXMgaXQuIFRoZVxuICogZHVyYWJsZSBmaXggaXMgYSBwZXItcnVuIEdpdEh1YiBBcHAgdG9rZW4gc2NvcGVkIHRvIHRoZSB0YXJnZXQgcmVwbyDigJQgdGhlXG4gKiBmb2xsb3ctdXAgYWxyZWFkeSBub3RlZCBpbiBgd3JpdGVfcmVwb19hbGxvd2xpc3QudHNgLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXVkaXRNdXRhdGlvbiB9IGZyb20gXCIuL2F1ZGl0X2pvdXJuYWwudHNcIjtcbmltcG9ydCB7XG4gIHJlY29yZE11dGF0aW9uLFxuICByZXNvbHZlQmFzZURpcixcbiAgcmVzb2x2ZVJ1bklkLFxuICByZXNvbHZlV29ya2VySWQsXG59IGZyb20gXCIuL2F1ZGl0X2pvdXJuYWwudHNcIjtcbmltcG9ydCB7IHJvc3RlclBhdGgsIHJvc3RlclNlZW5QYXRoIH0gZnJvbSBcIi4vYXVkaXRfYW5jaG9yLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEd1YXJkQXVkaXRUYXJnZXQgfSBmcm9tIFwiLi9naF9ndWFyZF9jbGkudHNcIjtcbmltcG9ydCB7IGlzQXVkaXRKb3VybmFsRW5hYmxlZCB9IGZyb20gXCIuL2F1ZGl0X2hvb2sudHNcIjtcbmltcG9ydCB7IHJlc29sdmVHdWFyZE1vZHVsZVBhdGggfSBmcm9tIFwiLi9ndWFyZF9tb2R1bGVfcGF0aC50c1wiO1xuaW1wb3J0IHtcbiAgREVOT19TRUVEX0RJUl9FTlYsXG4gIGV4cGVjdHNSZWFkT25seUd1YXJkQ2FjaGUsXG4gIHR5cGUgR3VhcmREZW5vRGlyLFxuICB0eXBlIEd1YXJkRGVub0RpclByb2JlLFxuICByZXNvbHZlR3VhcmREZW5vRGlyLFxufSBmcm9tIFwiLi9ndWFyZF9kZW5vX2Rpci50c1wiO1xuaW1wb3J0IHtcbiAgR0hfR1VBUkRfQUxMT1dfTUFSS0VSLFxuICBHSF9HVUFSRF9SRUZVU0VfTUFSS0VSLFxufSBmcm9tIFwiLi9naF9ndWFyZF9jbGkudHNcIjtcbmltcG9ydCB7XG4gIGlzV3JpdGVSZXBvQWxsb3dsaXN0QWN0aXZlLFxuICBsaXN0QWxsb3dlZFdyaXRlUmVwb3MsXG4gIG5vdGVBZ2VudEFsbG93bGlzdFNuYXBzaG90LFxufSBmcm9tIFwiLi93cml0ZV9yZXBvX2FsbG93bGlzdC50c1wiO1xuaW1wb3J0IHtcbiAgZGVmYXVsdEdpdEd1YXJkTW9kdWxlUGF0aCxcbiAgcmVuZGVyR2l0U2hpbVNjcmlwdCxcbn0gZnJvbSBcIi4vZ2l0X2d1YXJkX3NoaW0udHNcIjtcbmltcG9ydCB7IHBvc2l4U2luZ2xlUXVvdGUgYXMgc2hlbGxRdW90ZSB9IGZyb20gXCIuL3NoZWxsX3F1b3RlLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7IHR5cGUgQ2xhaW1lZElzc3VlLCBjbGFpbWVkSXNzdWVHdWFyZCB9IGZyb20gXCIuL2NsYWltZWRfaXNzdWVfZ3VhcmQudHNcIjtcblxuLyoqXG4gKiBgZ2hgIHRhcmdldCB2YXJpYWJsZXMgdGhlIHdyYXBwZXIgYWx3YXlzIGNsZWFycyAoSXNzdWUgIzM4NjYpLlxuICpcbiAqIFRoZSBndWFyZCByZWFjaGVzIGl0cyB2ZXJkaWN0IGZyb20gYXJndiBhbG9uZSwgYnV0IGBnaGAgcmVzb2x2ZXMgdGhlIHJlcG8gaXRcbiAqIHdyaXRlcyB0byBmcm9tIGBHSF9SRVBPYCBhcyB3ZWxsLiBgR0hfUkVQTz1vdGhlci9yZXBvIGdoIGlzc3VlIGNvbW1lbnQgMVxuICogLS1ib2R5IOKApmAgdGhlcmVmb3JlIGNsYXNzaWZpZWQgYXMgYSBjd2Qtc2NvcGVkIHdyaXRlIHRvIHRoZSBydW4ncyBvd24gcmVwb1xuICogYW5kIGxhbmRlZCBvbiBgb3RoZXIvcmVwb2AuIFRoZSBndWFyZCdzIGN3ZC1zY29wZSByZWFzb25pbmcgKmlzKiBcIm5vXG4gKiBgR0hfUkVQT2BcIiwgc28gaXQgaXMgY2xlYXJlZCB1bmNvbmRpdGlvbmFsbHkgcmF0aGVyIHRoYW4gcmUtYXNzZXJ0ZWQ7IHRoZVxuICogd29ya2VyIG5ldmVyIHNldHMgaXQuIFRoZSBlbnRlcnByaXNlIHRva2VucyBnbyB3aXRoIGl0IOKAlCBvbmUgc3VwcGxpZWQgaW5saW5lXG4gKiB3b3VsZCBhdXRoZW50aWNhdGUgYSByZWRpcmVjdGVkIGNhbGwuXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9DTEVBUkVEX0VOVl9WQVJTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJHSF9SRVBPXCIsXG4gIFwiR0hfRU5URVJQUklTRV9UT0tFTlwiLFxuICBcIkdJVEhVQl9FTlRFUlBSSVNFX1RPS0VOXCIsXG5dO1xuXG4vKipcbiAqIGBnaGAgdGFyZ2V0IHZhcmlhYmxlcyB0aGUgd3JhcHBlciByZS1hc3NlcnRzIGZyb20gdGhlIHJ1biAoSXNzdWUgIzM4NjYpLlxuICpcbiAqIEEgZGVwbG95bWVudCBtYXkgbGVnaXRpbWF0ZWx5IHNldCB0aGVzZSDigJQgYEdIX0hPU1RgIG5hbWVzIGEgR2l0SHViXG4gKiBFbnRlcnByaXNlIGhvc3QsIGBHSF9DT05GSUdfRElSYCBzZWxlY3RzIHRoZSB3b3JrZXIgaWRlbnRpdHkncyBgZ2hgIGNvbmZpZyDigJRcbiAqIHNvIHRoZSB3cmFwcGVyIHBpbnMgdGhlIHJ1bidzIG93biB2YWx1ZSBhbmQgZHJvcHMgd2hhdGV2ZXIgdGhlIGNhbGxlclxuICogc3VwcGxpZWQuIFBpbm5pbmcgYEdIX0NPTkZJR19ESVJgIGFsc28gZml4ZXMgd2hpY2ggY29uZmlnIGZpbGUncyBhbGlhc2VzXG4gKiBgZ2hgIGNhbiBleHBhbmQuIEEgdmFyaWFibGUgdGhlIHJ1biBkb2VzIG5vdCBzZXQgaXMgY2xlYXJlZCBpbiB0aGUgY2hpbGQuXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9QSU5ORURfRU5WX1ZBUlM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIkdIX0hPU1RcIixcbiAgXCJHSF9DT05GSUdfRElSXCIsXG5dO1xuXG4vKipcbiAqIEVudmlyb25tZW50IHZhcmlhYmxlIGFuIG9wZXJhdG9yIHNldHMgdG8gcGVybWl0IGEgZGVncmFkZWQsICoqdW5ndWFyZGVkKipcbiAqIGFnZW50IHJ1biB3aGVuIHRoZSBzaGltIGNhbm5vdCBiZSBpbnN0YWxsZWQgKElzc3VlICMzODY5KS5cbiAqXG4gKiBBYnNlbnQgKG9yIGZhbHNleSksIGFuIHVuaW5zdGFsbGFibGUgc2hpbSBibG9ja3MgdGhlIHNwYXduIHdoaWxlIHRoZVxuICogd3JpdGUtcmVwbyBhbGxvd2xpc3QgaXMgYWN0aXZlLiBUaGlzIGlzIGRlbGliZXJhdGVseSBhbiBvcGVyYXRvciBkZWNpc2lvbixcbiAqIG5ldmVyIGFuIGluZmVyZW5jZSBmcm9tIGFuIEkvTyBmYWlsdXJlLlxuICovXG5leHBvcnQgY29uc3QgVU5HVUFSREVEX0FHRU5UX0dIX0VOViA9IFwiVklCRV9BTExPV19VTkdVQVJERURfQUdFTlRfR0hcIjtcblxuLyoqIEF1ZGl0IHZlcmIgcmVjb3JkZWQgd2hlbiB0aGUgc2hpbSBjb3VsZCBub3QgYmUgaW5zdGFsbGVkIChJc3N1ZSAjMzg2OSkuICovXG5leHBvcnQgY29uc3QgR0hfR1VBUkRfU0hJTV9BVURJVF9WRVJCID0gXCJnaC1ndWFyZC1zaGltLXVuYXZhaWxhYmxlXCI7XG5cbi8qKiBTaW5rIHJlY29yZGluZyB0aGUgc2hpbS11bmF2YWlsYWJsZSBldmVudDsgcmVqZWN0cyB3aGVuIGl0IGNhbm5vdC4gKi9cbmV4cG9ydCB0eXBlIFNoaW1BdWRpdFJlY29yZGVyID0gKG11dGF0aW9uOiBBdWRpdE11dGF0aW9uKSA9PiBQcm9taXNlPHZvaWQ+O1xuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGluc3RhbGxHaEd1YXJkU2hpbX0uICovXG5leHBvcnQgaW50ZXJmYWNlIEdoR3VhcmRTaGltT3B0aW9ucyB7XG4gIC8qKiBFbnZpcm9ubWVudCB0aGUgY2hpbGQgd291bGQgb3RoZXJ3aXNlIHJlY2VpdmUgKG11c3QgY2FycnkgYFBBVEhgKS4gKi9cbiAgYmFzZUVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgLyoqIFdoZXRoZXIgdGhlIHJ1bidzIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGlzIGFjdGl2ZS4gKi9cbiAgYWN0aXZlOiBib29sZWFuO1xuICAvKiogYG93bmVyL3JlcG9gIHNsdWdzIHRoZSBydW4gbWF5IHdyaXRlIHRvLiAqL1xuICBhbGxvd2VkUmVwb3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogVGhlIGlzc3VlIHRoaXMgcnVuIGNsYWltZWQgKElzc3VlICMyMjIpLiBCYWtlZCBpbnRvIHRoZSB3cmFwcGVyIHNvIHRoZVxuICAgKiBhZ2VudCdzIG93biBgZ2ggaXNzdWUgY2xvc2V8cmVvcGVufOKApmAgb24gdGhlIGNsYWltZWQgcmVwbyBpcyByZWZ1c2VkLlxuICAgKi9cbiAgY2xhaW1lZElzc3VlPzogQ2xhaW1lZElzc3VlO1xuICAvKiogU2luayBmb3IgdGhlIGxvdWQgd2FybmluZyB3aGVuIHRoZSBzaGltIGNhbm5vdCBiZSBpbnN0YWxsZWQuICovXG4gIHdhcm4/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKiogT3ZlcnJpZGUgdGhlIGd1YXJkIG1vZHVsZSBwYXRoICh0ZXN0IHNlYW0pLiAqL1xuICBndWFyZE1vZHVsZVBhdGg/OiBzdHJpbmc7XG4gIC8qKiBPdmVycmlkZSB0aGUgYGRlbm9gIGJpbmFyeSBwYXRoICh0ZXN0IHNlYW0pLiAqL1xuICBkZW5vUGF0aD86IHN0cmluZztcbiAgLyoqXG4gICAqIE92ZXJyaWRlIHRoZSBvcGVyYXRvciBvcHQtaW4gZGVjaXNpb24gKHRlc3Qgc2VhbSkuIERlZmF1bHRzIHRvIHJlYWRpbmdcbiAgICoge0BsaW5rIFVOR1VBUkRFRF9BR0VOVF9HSF9FTlZ9LlxuICAgKi9cbiAgYWxsb3dVbmd1YXJkZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgbG9va3VwIGZvciB7QGxpbmsgVU5HVUFSREVEX0FHRU5UX0dIX0VOVn0gKElzc3VlICM5NjQpLlxuICAgKiBEZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCwgc28gcHJvZHVjdGlvbiBiZWhhdmVzIGV4YWN0bHkgYXNcbiAgICogaXQgZGlkIHdoZW4gdGhpcyBtb2R1bGUgcmVhZCBgRGVuby5lbnYuZ2V0YCBpdHNlbGYuIEEgdGVzdCBoYW5kcyBpbiBhXG4gICAqIGZpeGVkIG1hcCByYXRoZXIgdGhhbiBtdXRhdGluZyB0aGUgZW52aXJvbm1lbnQgZXZlcnkgcGFyYWxsZWwgd29ya2VyXG4gICAqIHNoYXJlcy5cbiAgICovXG4gIGVudj86IEVudkxvb2t1cDtcbiAgLyoqIE92ZXJyaWRlIHRoZSBhdWRpdCBzaW5rICh0ZXN0IHNlYW0pLiBEZWZhdWx0cyB0byB0aGUgam91cm5hbC4gKi9cbiAgcmVjb3JkPzogU2hpbUF1ZGl0UmVjb3JkZXI7XG4gIC8qKiBPdmVycmlkZSB0ZW1wLWRpcmVjdG9yeSBjcmVhdGlvbiAodGVzdCBzZWFtKS4gKi9cbiAgbWFrZVRlbXBEaXI/OiAoKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKlxuICAgKiBPdmVycmlkZSB0aGUgZ3VhcmQtY2FjaGUgZGlyZWN0b3J5IHByb2JlICh0ZXN0IHNlYW0sIElzc3VlICMxNTMxKS4gVGhlXG4gICAqIHJlc29sdmVyIGZhbGxzIGJhY2sgdG8gdGhlIGltYWdlJ3MgZGVmYXVsdCBzZWVkIHBhdGggd2hlbiB0aGVcbiAgICogZW52aXJvbm1lbnQgbmFtZXMgbm9uZSwgc28gYSB0ZXN0IHRoYXQgbWVhbnMgXCJubyBzZWVkIGF2YWlsYWJsZVwiIG11c3RcbiAgICogc2F5IHNvIHRocm91Z2ggdGhlIHByb2JlIHJhdGhlciB0aGFuIHJlbHkgb24gdGhhdCBwYXRoIGJlaW5nIGFic2VudCBvblxuICAgKiB0aGUgaG9zdCDigJQgaW5zaWRlIHRoZSB3b3JrZXIgY29udGFpbmVyIGl0IGlzIHByZXNlbnQgYW5kIHJlYWQtb25seS5cbiAgICovXG4gIGd1YXJkRGVub0RpclByb2JlPzogR3VhcmREZW5vRGlyUHJvYmU7XG59XG5cbi8qKlxuICogT3V0Y29tZSBvZiBhbiBpbnN0YWxsIGF0dGVtcHQgKElzc3VlICMzODY5KS5cbiAqXG4gKiBgYmxvY2tlZGAgaXMgdGhlIGZhaWwtY2xvc2VkIHZlcmRpY3Q6IHRoZSBjYWxsZXIgbXVzdCBub3Qgc3Bhd24gdGhlIGFnZW50LFxuICogYmVjYXVzZSBpdHMgYGdoYCBjYWxscyB3b3VsZCBieXBhc3MgdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGFuZCB0aGVcbiAqIHJlc2VydmVkLWxhYmVsIGd1YXJkIGVudGlyZWx5LiBgZGVncmFkZWRgIG1lYW5zIHRoZSBydW4gbWF5IHByb2NlZWRcbiAqIHVuZ3VhcmRlZCDigJQgZWl0aGVyIHRoZSBhbGxvd2xpc3QgaXMgaW5hY3RpdmUsIG9yIGFuIG9wZXJhdG9yIG9wdGVkIGluLlxuICovXG5leHBvcnQgdHlwZSBHaEd1YXJkU2hpbU91dGNvbWUgPVxuICB8IHsgc3RhdHVzOiBcImluc3RhbGxlZFwiOyBzaGltOiBHaEd1YXJkU2hpbSB9XG4gIHwgeyBzdGF0dXM6IFwiZGVncmFkZWRcIjsgcmVhc29uOiBzdHJpbmcgfVxuICB8IHsgc3RhdHVzOiBcImJsb2NrZWRcIjsgcmVhc29uOiBzdHJpbmcgfTtcblxuLyoqIEFuIGluc3RhbGxlZCBzaGltLCBpdHMgY2hpbGQgZW52aXJvbm1lbnQsIGFuZCBpdHMgY2xlYW51cCBob29rLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaEd1YXJkU2hpbSB7XG4gIC8qKlxuICAgKiBEaXJlY3RvcnkgaG9sZGluZyB0aGUgd3JhcHBlciAocHJlcGVuZGVkIHRvIHRoZSBjaGlsZCdzIGBQQVRIYCkuIEl0IGFsc29cbiAgICogaG9sZHMgdGhlIHBlci1gZ2hgLWNhbGwgdmVyZGljdCBidWZmZXJzIGFuZCBhbnkgbWFza2VkIGAtLWlucHV0YCBib2R5IHRoZVxuICAgKiBndWFyZCBtYXRlcmlhbGlzZWQsIHNvIHJlbW92aW5nIGl0IHJlbW92ZXMgdGhvc2UgdG9vIChJc3N1ZSAjMTM2NCkuXG4gICAqL1xuICBkaXI6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGggb2YgdGhlIHdyYXBwZXIgaXRzZWxmLiAqL1xuICBzaGltUGF0aDogc3RyaW5nO1xuICAvKipcbiAgICogQWJzb2x1dGUgcGF0aCBvZiB0aGUgYGdpdGAgd3JhcHBlciBpbnN0YWxsZWQgYmVzaWRlIGl0IChJc3N1ZSAjMTI4NCkuXG4gICAqXG4gICAqIEFic2VudCBvbmx5IHdoZW4gdGhlIGJhc2UgYFBBVEhgIGNhcnJpZXMgbm8gYGdpdGAgYXQgYWxsIOKAlCB0aGUgY2hpbGRcbiAgICogc2VhcmNoZXMgdGhlIHNhbWUgZGlyZWN0b3JpZXMsIHNvIHRoZXJlIGlzIHRoZW4gbm8gYGdpdGAgZm9yIHRoZSBhZ2VudCB0b1xuICAgKiBydW4gYW5kIG5vdGhpbmcgdGhlIHNoaW0gY291bGQgaGF2ZSBndWFyZGVkLlxuICAgKi9cbiAgZ2l0U2hpbVBhdGg/OiBzdHJpbmc7XG4gIC8qKiBUaGUgY2hpbGQgZW52aXJvbm1lbnQgd2l0aCB0aGUgd3JhcHBlciBmaXJzdCBvbiBgUEFUSGAuICovXG4gIGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgLyoqXG4gICAqIFRoZSBEZW5vIGNhY2hlIGJvdGggd3JhcHBlcnMgcGluIGZvciB0aGVpciBndWFyZCBjaGlsZCAoSXNzdWUgIzE0NDgpIOKAlFxuICAgKiB0aGUgaW1hZ2UncyByZWFkLW9ubHkgc2VlZCB3aGVuIGl0IGlzIHRoZXJlLCBlbHNlIGEgcGVyLXJ1biBkaXJlY3RvcnkuXG4gICAqL1xuICBkZW5vRGlyOiBHdWFyZERlbm9EaXI7XG4gIC8qKiBSZW1vdmUgdGhlIHdyYXBwZXIgZGlyZWN0b3J5LiBCZXN0LWVmZm9ydDsgd2FybnMgb24gZmFpbHVyZS4gKi9cbiAgY2xlYW51cDogKCkgPT4gUHJvbWlzZTx2b2lkPjtcbn1cblxuLyoqXG4gKiBGaW5kIGFuIGV4ZWN1dGFibGUgbmFtZWQgYG5hbWVgIG9uIGEgYFBBVEhgIHN0cmluZy5cbiAqXG4gKiBAcGFyYW0gbmFtZSAtIEJpbmFyeSBuYW1lIHRvIHJlc29sdmUgKGUuZy4gYGdoYCkuXG4gKiBAcGFyYW0gcGF0aFZhbHVlIC0gQ29sb24tc2VwYXJhdGVkIGBQQVRIYCB0byBzZWFyY2guXG4gKiBAcmV0dXJucyBBYnNvbHV0ZSBwYXRoIG9mIHRoZSBmaXJzdCBleGVjdXRhYmxlIG1hdGNoLCBvciB1bmRlZmluZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlRXhlY3V0YWJsZShcbiAgbmFtZTogc3RyaW5nLFxuICBwYXRoVmFsdWU6IHN0cmluZyxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgZGlyIG9mIHBhdGhWYWx1ZS5zcGxpdChcIjpcIikpIHtcbiAgICBpZiAoZGlyLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gYCR7ZGlyfS8ke25hbWV9YDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaW5mbyA9IERlbm8uc3RhdFN5bmMoY2FuZGlkYXRlKTtcbiAgICAgIGlmIChpbmZvLmlzRmlsZSAmJiAoKGluZm8ubW9kZSA/PyAwbzExMSkgJiAwbzExMSkgIT09IDApIHJldHVybiBjYW5kaWRhdGU7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBOb3QgcHJlc2VudCBpbiB0aGlzIGRpcmVjdG9yeSDigJQga2VlcCBzZWFyY2hpbmcuXG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIG9mIHRoZSBndWFyZCBlbnRyeSBwb2ludCB0aGlzIHNoaW0gaW52b2tlcy4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRHdWFyZE1vZHVsZVBhdGgoKTogc3RyaW5nIHtcbiAgLy8gSXNzdWUgIzE0NDQ6IHRoZSByZWFkLW9ubHkgY2hlY2tvdXQsIG5vdCB0aGUgd3JpdGFibGUgc3RhZ2VkIGNvcHkgdGhpc1xuICAvLyBtb2R1bGUgaXMgcnVubmluZyBmcm9tIOKAlCB0aGUgYWdlbnQgbXVzdCBub3QgYmUgYWJsZSB0byBlZGl0IHRoZSBndWFyZFxuICAvLyB0aGF0IGNvbnN0cmFpbnMgaXQuIFNlZSBgZ3VhcmRfbW9kdWxlX3BhdGgudHNgLlxuICByZXR1cm4gcmVzb2x2ZUd1YXJkTW9kdWxlUGF0aChcImdoX2d1YXJkX2NsaS50c1wiLCBpbXBvcnQubWV0YS51cmwpO1xufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgd3JhcHBlciBzY3JpcHQuXG4gKlxuICogRXhwb3J0ZWQgZm9yIGRpcmVjdCBhc3NlcnRpb24gb2YgdGhlIGZhaWwtY2xvc2VkIGNvbnRyYWN0IGluIHRlc3RzLlxuICpcbiAqIEBwYXJhbSBvcHRzIC0gQWJzb2x1dGUgYmluYXJ5L21vZHVsZSBwYXRocyBwbHVzIHRoZSBydW4ncyBhbGxvd2xpc3Qgc3RhdGUuXG4gKiBAcmV0dXJucyBUaGUgYmFzaCBzY3JpcHQgYm9keS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckdoU2hpbVNjcmlwdChvcHRzOiB7XG4gIGRlbm9QYXRoOiBzdHJpbmc7XG4gIGd1YXJkTW9kdWxlUGF0aDogc3RyaW5nO1xuICByZWFsR2hQYXRoOiBzdHJpbmc7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgYWxsb3dlZFJlcG9zOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoZSBydW4ncyBjbGFpbWVkIGlzc3VlIGFuZCB0aGUgbGlmZWN5Y2xlIHZlcmJzIGl0IHBlcm1pdHMgKCMyMjIpLiAqL1xuICBjbGFpbWVkSXNzdWU/OiBDbGFpbWVkSXNzdWU7XG4gIC8qKiBUaGUgd3JhcHBlcidzIG93biBwcml2YXRlIGRpcmVjdG9yeSDigJQgd2hlcmUgaXQgYnVmZmVycyB0aGUgdmVyZGljdC4gKi9cbiAgdmVyZGljdERpcjogc3RyaW5nO1xuICAvKiogVGhlIHJ1bidzIG93biB2YWx1ZXMgZm9yIHtAbGluayBHSF9QSU5ORURfRU5WX1ZBUlN9LiAqL1xuICBwaW5uZWRFbnY/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PjtcbiAgLyoqXG4gICAqIFRoZSBgREVOT19ESVJgIHRoZSBndWFyZCBjaGlsZCBydW5zIHdpdGggKElzc3VlICMxNDQ4KS4gUGlubmVkIGluIHRoZVxuICAgKiB3cmFwcGVyIHNvIHRoZSBhZ2VudCdzIGVudmlyb25tZW50IGNhbm5vdCBwb2ludCB0aGUgY2hpbGQgYXQgYSBjYWNoZSBpdFxuICAgKiBwcmVwYXJlZDsgc2VlIGBndWFyZF9kZW5vX2Rpci50c2AgZm9yIHdoeSBpdCBpcyB0aGUgcmVhZC1vbmx5IHNlZWQuXG4gICAqL1xuICBkZW5vRGlyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGVyZSB0aGUgZ3VhcmQgY2hpbGQgam91cm5hbHMgYSByZWZ1c2FsIChJc3N1ZSAjMTYwNCkuIFByZXNlbnQgd2hlbmV2ZXJcbiAgICogdGhlIHdvcmtlcidzIG93biBhdWRpdCBqb3VybmFsIGlzIG9uOyBhYnNlbnQgbWVhbnMgcmVmdXNhbHMgYXJlIHN0ZGVyclxuICAgKiBsaW5lcyBvbmx5LCBhcyB0aGV5IHdlcmUgYmVmb3JlLiBCYWtlZCBpbnRvIHRoZSB3cmFwcGVyIGFzIGFyZ3VtZW50cywgbGlrZVxuICAgKiBldmVyeXRoaW5nIGVsc2UgdGhlIGNoaWxkIGRlY2lkZXMgb24sIHNvIHRoZSBhZ2VudCBjYW5ub3QgcmVkaXJlY3QgdGhlXG4gICAqIGpvdXJuYWwgd2l0aCBhbiBgZXhwb3J0YC5cbiAgICovXG4gIGF1ZGl0PzogR3VhcmRBdWRpdFRhcmdldDtcbn0pOiBzdHJpbmcge1xuICBjb25zdCBjbGFpbSA9IG9wdHMuY2xhaW1lZElzc3VlO1xuICBjb25zdCBndWFyZEFyZ3MgPSBbXG4gICAgLi4uKG9wdHMuYWN0aXZlID8gW1wiLS1hY3RpdmVcIl0gOiBbXSksXG4gICAgLi4ub3B0cy5hbGxvd2VkUmVwb3MuZmxhdE1hcCgocikgPT4gW1wiLS1hbGxvdy1yZXBvXCIsIHJdKSxcbiAgICAvLyBJc3N1ZSAjMjIyIOKAlCBiYWtlZCBpbiBhcyBhcmd1bWVudHMsIGxpa2UgdGhlIGFsbG93bGlzdCwgc28gdGhlIGFnZW50XG4gICAgLy8gY2Fubm90IHN3aXRjaCB0aGUgY2xhaW1lZC1pc3N1ZSBndWFyZCBvZmYgd2l0aCBhbiBgdW5zZXRgLlxuICAgIC4uLihjbGFpbVxuICAgICAgPyBbXG4gICAgICAgIFwiLS1jbGFpbWVkLWlzc3VlXCIsXG4gICAgICAgIGAke2NsYWltLnJlcG99IyR7Y2xhaW0uaXNzdWVOdW1iZXJ9YCxcbiAgICAgICAgLi4uY2xhaW0uYWxsb3dlZFZlcmJzLmZsYXRNYXAoKHYpID0+IFtcIi0tYWxsb3ctaXNzdWUtdmVyYlwiLCB2XSksXG4gICAgICBdXG4gICAgICA6IFtdKSxcbiAgICAvLyBJc3N1ZSAjMTM2NCDigJQgYSBtYXNrZWQgYGdoIGFwaSAtLWlucHV0YCBib2R5IGlzIGEgZnJlc2ggZmlsZSB0aGUgY2hpbGRcbiAgICAvLyByZWFkcyBhZnRlciB0aGUgZ3VhcmQgaGFzIGV4aXRlZCwgc28gdGhlIGd1YXJkIGNhbm5vdCByZW1vdmUgaXQuIEl0XG4gICAgLy8gbGFuZHMgaW4gdGhlIHdyYXBwZXIncyBvd24gcGVyLXNwYXduIGRpcmVjdG9yeSBpbnN0ZWFkIG9mIFRNUERJUiwgYW5kXG4gICAgLy8gZGllcyB3aXRoIGl0IHdoZW4gdGhlIHNwYXduIHNpdGUgY2xlYW5zIHVwLlxuICAgIFwiLS1ib2R5LWRpclwiLFxuICAgIG9wdHMudmVyZGljdERpcixcbiAgICAuLi4ob3B0cy5hdWRpdFxuICAgICAgPyBbXG4gICAgICAgIFwiLS1hdWRpdC1kaXJcIixcbiAgICAgICAgb3B0cy5hdWRpdC5iYXNlRGlyLFxuICAgICAgICBcIi0tYXVkaXQtd29ya2VyXCIsXG4gICAgICAgIG9wdHMuYXVkaXQud29ya2VySWQsXG4gICAgICAgIFwiLS1hdWRpdC1ydW5cIixcbiAgICAgICAgb3B0cy5hdWRpdC5ydW5JZCxcbiAgICAgIF1cbiAgICAgIDogW10pLFxuICBdLm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcblxuICAvLyBJc3N1ZSAjMTYwNCDigJQgdGhlIGpvdXJuYWwncyBmb290cHJpbnQsIGFuZCBvbmx5IHRoYXQ6IHRoZSBqb3VybmFsXG4gIC8vIGRpcmVjdG9yeSAoZW50cmllcywgbG9jaywgYW5jaG9ycykgYW5kIHRoZSByb3N0ZXIgcGFpciB0aGF0IHNpdHMgYmVzaWRlXG4gIC8vIGl0LiBFdmVyeXRoaW5nIGVsc2UgdGhlIGNoaWxkIG1heSB3cml0ZSBpcyBzdGlsbCB0aGUgdmVyZGljdCBidWZmZXIuXG4gIGNvbnN0IHdyaXRlR3JhbnQgPSBbXG4gICAgb3B0cy52ZXJkaWN0RGlyLFxuICAgIC4uLihvcHRzLmF1ZGl0XG4gICAgICA/IFtcbiAgICAgICAgb3B0cy5hdWRpdC5iYXNlRGlyLFxuICAgICAgICByb3N0ZXJQYXRoKG9wdHMuYXVkaXQuYmFzZURpciksXG4gICAgICAgIHJvc3RlclNlZW5QYXRoKG9wdHMuYXVkaXQuYmFzZURpciksXG4gICAgICBdXG4gICAgICA6IFtdKSxcbiAgXS5tYXAoc2hlbGxRdW90ZSkuam9pbihcIixcIik7XG5cbiAgLy8gSXNzdWUgIzM4NjY6IGNsZWFyIHdoYXQgdGhlIHJ1biBuZXZlciBzZXRzLCBwaW4gd2hhdCBpdCBkb2VzLiBgdW5zZXRgXG4gIC8vIGZpcnN0LCBzbyBhIHZhcmlhYmxlIHRoZSBydW4gaGFzIG5vIHZhbHVlIGZvciBjYW5ub3QgYmUgc3VwcGxpZWQgYnkgdGhlXG4gIC8vIGFnZW50LlxuICBjb25zdCBjbGVhcmVkID0gWy4uLkdIX0NMRUFSRURfRU5WX1ZBUlNdO1xuICBjb25zdCBwaW5zOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgR0hfUElOTkVEX0VOVl9WQVJTKSB7XG4gICAgY29uc3QgdmFsdWUgPSBvcHRzLnBpbm5lZEVudj8uW25hbWVdO1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSBjbGVhcmVkLnB1c2gobmFtZSk7XG4gICAgZWxzZSBwaW5zLnB1c2goYGV4cG9ydCAke25hbWV9PSR7c2hlbGxRdW90ZSh2YWx1ZSl9YCk7XG4gIH1cbiAgY29uc3QgdGFyZ2V0RW52TGluZXMgPSBbYHVuc2V0ICR7Y2xlYXJlZC5qb2luKFwiIFwiKX1gLCAuLi5waW5zXS5qb2luKFwiXFxuXCIpO1xuICAvLyBJc3N1ZSAjMTQ0OCDigJQgdGhlIGd1YXJkIGNoaWxkIG11c3Qgbm90IHJlYWQgY29kZSBiYWNrIGZyb20gYSBjYWNoZSB0aGVcbiAgLy8gYWdlbnQgY2FuIHdyaXRlIG9yIGNob29zZS4gUGlubmVkIGhlcmUsIGJlc2lkZSB0aGUgZ2ggdGFyZ2V0IHZhcmlhYmxlcyxcbiAgLy8gZm9yIHRoZSBzYW1lIHJlYXNvbiB0aGV5IGFyZTogdGhlIHdyYXBwZXIganVkZ2VzIGFyZ3YsIGFuZCBldmVyeXRoaW5nXG4gIC8vIGVsc2UgdGhlIGNoaWxkIGNvdWxkIGJlIHN0ZWVyZWQgYnkgaXMgdGhlIHJ1bidzIHRvIHNldCwgbm90IHRoZSBjYWxsZXIncy5cbiAgY29uc3QgZGVub0RpckxpbmUgPSBgZXhwb3J0IERFTk9fRElSPSR7c2hlbGxRdW90ZShvcHRzLmRlbm9EaXIpfWA7XG5cbiAgY29uc3QgQUxMT1dfTUFSS0VSID0gR0hfR1VBUkRfQUxMT1dfTUFSS0VSO1xuICBjb25zdCBSRUZVU0VfTUFSS0VSID0gR0hfR1VBUkRfUkVGVVNFX01BUktFUjtcblxuICAvLyBiYXNoIDMuMiAobWFjT1MpIHVuZGVyIGBzZXQgLXVgIHRyZWF0cyBhbiBlbXB0eSBhcnJheSBleHBhbnNpb24gYXMgYW5cbiAgLy8gdW5ib3VuZCB2YXJpYWJsZSwgaGVuY2UgdGhlICR7YXJyW0BdK1wiJHthcnJbQF19XCJ9IGd1YXJkLlxuICAvLyBgIyEvYmluL2Jhc2hgIHJhdGhlciB0aGFuIGAvdXNyL2Jpbi9lbnYgYmFzaGA6IGEgc2VjdXJpdHkgd3JhcHBlciBtdXN0IG5vdFxuICAvLyBkZXBlbmQgb24gdGhlIFBBVEggb2Ygd2hvZXZlciBpbnZva2VzIGl0LlxuICByZXR1cm4gYCMhL2Jpbi9iYXNoXG4jIFZpYmUgQ29kZXIgZ2ggZ3VhcmQgc2hpbSAoSXNzdWUgIzM2NDMpIOKAlCBnZW5lcmF0ZWQgcGVyIHJ1bjsgZG8gbm90IGVkaXQuXG4jIFJlLWVudGVycyB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QgYW5kIHRoZSByZXNlcnZlZC1sYWJlbCBndWFyZCBmb3IgZXZlcnlcbiMgZ2ggY2FsbCBtYWRlIGJ5IHRoZSBhZ2VudCBzdWJwcm9jZXNzLCB0aGVuIGRlbGVnYXRlcyB0byB0aGUgcmVhbCBiaW5hcnkuXG5zZXQgLXVvIHBpcGVmYWlsXG5cbiMgSXNzdWUgIzM4NjYg4oCUIHRoZSByZWFsIGdoIHJlc29sdmVzIGl0cyB0YXJnZXQgZnJvbSBtb3JlIHRoYW4gYXJndjogR0hfUkVQT1xuIyBhbmQgR0hfSE9TVCByZWRpcmVjdCBhIHJlcG8tc2NvcGVkIGNvbW1hbmQsIGFuZCBHSF9DT05GSUdfRElSIHNlbGVjdHMgdGhlXG4jIGNvbmZpZyBmaWxlIHdob3NlIGFsaWFzZXMgaXQgZXhwYW5kcy4gVGhlIGd1YXJkIGp1ZGdlcyBhcmd2IGFsb25lLCBzbyB0aGVcbiMgcnVuJ3Mgb3duIHZhbHVlcyBhcmUgcmUtYXNzZXJ0ZWQgaGVyZSByYXRoZXIgdGhhbiBpbmhlcml0ZWQgZnJvbSB0aGUgY2FsbGVyLlxuJHt0YXJnZXRFbnZMaW5lc31cbiMgSXNzdWUgIzE0NDgg4oCUIGFuZCB0aGUgY2FjaGUgdGhlIGd1YXJkIGNoaWxkIHJlYWRzIGl0cyBvd24gY29tcGlsZWQgbW9kdWxlc1xuIyBiYWNrIGZyb20gaXMgdGhlIHJ1bidzIGNob2ljZSB0b286IGEgcmVhZC1vbmx5IGRpcmVjdG9yeSB3aGVyZSBvbmUgZXhpc3RzLlxuJHtkZW5vRGlyTGluZX1cblxuR1VBUkRfQVJHUz0oJHtndWFyZEFyZ3N9KVxuXG4jIElzc3VlICMzOTM4IOKAlCB0aGUgZ3VhcmQgcmV0dXJucyB0aGUgYXJndiB0byBydW4sIHdpdGggdGhlIHB1Ymxpc2hlZCBib2RpZXNcbiMgcmVkYWN0ZWQsIGFzIE5VTC10ZXJtaW5hdGVkIGZpZWxkcy4gQSBOVUwgY2Fubm90IGNyb3NzIGEgY29tbWFuZFxuIyBzdWJzdGl0dXRpb24sIHNvIHRoZSB2ZXJkaWN0IGlzIGJ1ZmZlcmVkIGluIHRoZSB3cmFwcGVyJ3Mgb3duIHByaXZhdGVcbiMgZGlyZWN0b3J5ICgwNzAwLCBwZXIgc3Bhd24sIHJlbW92ZWQgd2hlbiB0aGUgY2hpbGQgZXhpdHMpIGluc3RlYWQuIE5vXG4jIGV4dGVybmFsIGNvbW1hbmQgaXMgdXNlZCBmb3IgaXQ6IGEgc2VjdXJpdHkgd3JhcHBlciBtdXN0IG5vdCBuZWVkIGEgUEFUSFxuIyBsb29rdXAsIGFuZCB0aGUgYWdlbnQgY29udHJvbHMgaXRzIG93biBQQVRILiBJc3N1ZSAjMTM2NCDigJQgYSBtYXNrZWRcbiMgLS1pbnB1dCBib2R5IGlzIHdyaXR0ZW4gdG8gdGhhdCBzYW1lIGRpcmVjdG9yeSwgc28gaXQgdG9vIGlzIHJlbW92ZWQgd2l0aCBpdC5cbkdVQVJEX09VVD0ke3NoZWxsUXVvdGUob3B0cy52ZXJkaWN0RGlyKX0vdmVyZGljdC4kJFxuaWYgISA6ID4gXCIkR1VBUkRfT1VUXCI7IHRoZW5cbiAgcHJpbnRmICclc1xcXFxuJyBcIltTRUNVUklUWV0gW0dIX0dVQVJEX0VSUk9SXSBjb3VsZCBub3QgY3JlYXRlIHRoZSBndWFyZCdzIHZlcmRpY3QgZmlsZSDigJQgcmVmdXNpbmcgdG8gcnVuIHRoaXMgZ2ggY29tbWFuZC5cIiA+JjJcbiAgZXhpdCAxMjZcbmZpXG5cbnN0YXR1cz0wXG4ke3NoZWxsUXVvdGUob3B0cy5kZW5vUGF0aCl9IHJ1biAtLXF1aWV0IC0tbm8tY29uZmlnIC0tbm8tbG9jayAtLWFsbG93LXJlYWQgXFxcXFxuICAtLWFsbG93LXdyaXRlPSR7d3JpdGVHcmFudH0gXFxcXFxuICAke3NoZWxsUXVvdGUob3B0cy5ndWFyZE1vZHVsZVBhdGgpfSBcXFxcXG4gIFxcJHtHVUFSRF9BUkdTW0BdK1wiXFwke0dVQVJEX0FSR1NbQF19XCJ9IC0tIFwiJEBcIiA+XCIkR1VBUkRfT1VUXCIgfHwgc3RhdHVzPSQ/XG5cbmZpZWxkcz0oKVxud2hpbGUgSUZTPSByZWFkIC1yIC1kICcnIGZpZWxkOyBkb1xuICBmaWVsZHMrPShcIiRmaWVsZFwiKVxuZG9uZSA8IFwiJEdVQVJEX09VVFwiXG4jIERyb3AgdGhlIGJ1ZmZlcmVkIGJvZHkgaW1tZWRpYXRlbHk7IHRoZSBkaXJlY3RvcnkgaXRzZWxmIGdvZXMgYXQgcnVuIGVuZC5cbjogPiBcIiRHVUFSRF9PVVRcIlxuXG52ZXJkaWN0PVwiXFwke2ZpZWxkc1swXS19XCJcblxuIyBQb3NpdGl2ZSBtYXJrZXIgb25seTogYSBtaXNzaW5nL2dhcmJsZWQgdmVyZGljdCBtZWFucyB0aGUgZ3VhcmQgZGlkIG5vdCBydW4sXG4jIHdoaWNoIGlzIHJlZnVzZWQgcmF0aGVyIHRoYW4gd2F2ZWQgdGhyb3VnaC5cbmlmIFsgXCIkc3RhdHVzXCIgLWVxIDAgXSAmJiBbIFwiJHZlcmRpY3RcIiA9IFwiJHtBTExPV19NQVJLRVJ9XCIgXTsgdGhlblxuICBHSF9BUkdTPSgpXG4gIHNlZW5fdmVyZGljdD0wXG4gIGZvciBmaWVsZCBpbiBcXCR7ZmllbGRzW0BdK1wiXFwke2ZpZWxkc1tAXX1cIn07IGRvXG4gICAgaWYgWyBcIiRzZWVuX3ZlcmRpY3RcIiAtZXEgMCBdOyB0aGVuIHNlZW5fdmVyZGljdD0xOyBjb250aW51ZTsgZmlcbiAgICBHSF9BUkdTKz0oXCIkZmllbGRcIilcbiAgZG9uZVxuICAjIFJlZGFjdGlvbiBuZXZlciBhZGRzIG9yIGRyb3BzIGFuIGFyZ3VtZW50LCBzbyBhIGRpZmZlcmVudCBjb3VudCBtZWFucyB0aGVcbiAgIyByZXdyaXRlIGlzIG5vdCB0aGUgY29tbWFuZCB0aGUgZ3VhcmQganVkZ2VkLlxuICBpZiBbIFwiXFwkeyNHSF9BUkdTW0BdfVwiIC1lcSBcIiQjXCIgXTsgdGhlblxuICAgIGV4ZWMgJHtzaGVsbFF1b3RlKG9wdHMucmVhbEdoUGF0aCl9IFxcJHtHSF9BUkdTW0BdK1wiXFwke0dIX0FSR1NbQF19XCJ9XG4gIGZpXG4gIHByaW50ZiAnJXNcXFxcbicgXCJbU0VDVVJJVFldIFtHSF9HVUFSRF9FUlJPUl0gdGhlIGd1YXJkIHJldHVybmVkIFxcJHsjR0hfQVJHU1tAXX0gYXJndW1lbnRzIGZvciBhICQjIGFyZ3VtZW50IGNvbW1hbmQg4oCUIHJlZnVzaW5nIHRvIHJ1biBpdC5cIiA+JjJcbiAgZXhpdCAxMjZcbmZpXG5cbmlmIFsgXCIkdmVyZGljdFwiICE9IFwiJHtSRUZVU0VfTUFSS0VSfVwiIF07IHRoZW5cbiAgcHJpbnRmICclc1xcXFxuJyBcIltTRUNVUklUWV0gW0dIX0dVQVJEX0VSUk9SXSBndWFyZCBjb3VsZCBub3QgZXZhbHVhdGUgdGhpcyBnaCBjb21tYW5kIChleGl0ICRzdGF0dXMpIOKAlCByZWZ1c2luZyB0byBydW4gaXQuXCIgPiYyXG4gIGlmIFsgXCIkc3RhdHVzXCIgLWVxIDAgXTsgdGhlbiBzdGF0dXM9MTI2OyBmaVxuZmlcbmV4aXQgXCIkc3RhdHVzXCJcbmA7XG59XG5cbi8qKlxuICogV2hldGhlciBhbiBvcGVyYXRvciBoYXMgb3B0ZWQgaW4gdG8gcnVubmluZyB0aGUgYWdlbnQgdW5ndWFyZGVkLlxuICpcbiAqIEEgcmVhZCB0aGF0IHRocm93cyAobm8gYC0tYWxsb3ctZW52YCkgY291bnRzIGFzICoqbm8qKiBvcHQtaW4sIHNvIHRoZVxuICogZGVjaXNpb24gc3RheXMgZmFpbC1jbG9zZWQuXG4gKlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cCAoSXNzdWUgIzk2NCk7IGRlZmF1bHRzIHRvIHRoZSBwcm9jZXNzXG4gKiAgIGVudmlyb25tZW50LiBFeHBvcnRlZCBzbyB0aGUgb3B0LWluIHNwZWxsaW5nIGNhbiBiZSBhc3NlcnRlZCBkaXJlY3RseVxuICogICBhZ2FpbnN0IGFuIGluamVjdGVkIG1hcC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuZ3VhcmRlZE9wdEluRnJvbUVudihcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogYm9vbGVhbiB7XG4gIGxldCByYXc6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICByYXcgPSBlbnYoVU5HVUFSREVEX0FHRU5UX0dIX0VOVik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCB2YWx1ZSA9IChyYXcgPz8gXCJcIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiB2YWx1ZSAhPT0gXCJcIiAmJiB2YWx1ZSAhPT0gXCIwXCIgJiYgdmFsdWUgIT09IFwiZmFsc2VcIiAmJiB2YWx1ZSAhPT0gXCJub1wiO1xufVxuXG4vKipcbiAqIERlZmF1bHQgYXVkaXQgc2luayDigJQgam91cm5hbCB0aGUgc2hpbS11bmF2YWlsYWJsZSBldmVudC5cbiAqXG4gKiBHYXRlZCBleGFjdGx5IGxpa2UgdGhlIG90aGVyIGNob2tlcG9pbnQgaG9va3MgKGBXT1JLX0RJUmAgcHJlc2VudCBhbmRcbiAqIGpvdXJuYWxsaW5nIG5vdCBkaXNhYmxlZCksIHNvIHVuaXQgdGVzdHMgaW5jdXIgbm8gam91cm5hbCBzaWRlIGVmZmVjdHMuXG4gKiBSZWplY3RzIHdoZW4gdGhlIGFwcGVuZCBpcyByZWZ1c2VkLCBzbyB0aGUgY2FsbGVyIGNhbiBzYXkgc28gbG91ZGx5LlxuICovXG5hc3luYyBmdW5jdGlvbiBqb3VybmFsU2hpbVVuYXZhaWxhYmxlKFxuICBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbixcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghaXNBdWRpdEpvdXJuYWxFbmFibGVkKGVudikpIHJldHVybjtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVjb3JkTXV0YXRpb24obXV0YXRpb24pO1xuICBpZiAoIXJlc3VsdC5vaykgdGhyb3cgcmVzdWx0LmVycm9yO1xufVxuXG4vKipcbiAqIEluc3RhbGwgdGhlIGBnaGAgd3JhcHBlciBmb3Igb25lIGFnZW50IHN1YnByb2Nlc3MuXG4gKlxuICogQHBhcmFtIG9wdHMgLSBCYXNlIGVudmlyb25tZW50LCBhbGxvd2xpc3Qgc3RhdGUsIGFuZCB0ZXN0IHNlYW1zLlxuICogQHJldHVybnMgVGhlIGluc3RhbGxlZCBzaGltLCBvciBhIGBibG9ja2VkYC9gZGVncmFkZWRgIG91dGNvbWUgd2hlbiBpdCBjb3VsZFxuICogICBub3QgYmUgaW5zdGFsbGVkIChhIGBbU0VDVVJJVFldIFtHSF9HVUFSRF9TSElNX1VOQVZBSUxBQkxFXWAgd2FybmluZyBhbmQgYW5cbiAqICAgYXVkaXQtam91cm5hbCBlbnRyeSBhcmUgZW1pdHRlZCBmaXJzdCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbnN0YWxsR2hHdWFyZFNoaW0oXG4gIG9wdHM6IEdoR3VhcmRTaGltT3B0aW9ucyxcbik6IFByb21pc2U8R2hHdWFyZFNoaW1PdXRjb21lPiB7XG4gIGNvbnN0IHdhcm4gPSBvcHRzLndhcm4gPz8gKChtOiBzdHJpbmcpID0+IGNvbnNvbGUuZXJyb3IobSkpO1xuICBjb25zdCBlbnYgPSBvcHRzLmVudiA/PyBwcm9jZXNzRW52TG9va3VwO1xuICBjb25zdCByZWNvcmQgPSBvcHRzLnJlY29yZCA/P1xuICAgICgobXV0YXRpb246IEF1ZGl0TXV0YXRpb24pID0+IGpvdXJuYWxTaGltVW5hdmFpbGFibGUobXV0YXRpb24sIGVudikpO1xuXG4gIC8qKlxuICAgKiBSZXBvcnQgYW4gdW5pbnN0YWxsYWJsZSBzaGltIGFuZCBkZWNpZGUgd2hldGhlciB0aGUgcnVuIG1heSBjb250aW51ZS5cbiAgICpcbiAgICogRmFpbCBjbG9zZWQgKElzc3VlICMzODY5KTogd2hpbGUgdGhlIGFsbG93bGlzdCBpcyBhY3RpdmUsIG9ubHkgYW4gZXhwbGljaXRcbiAgICogb3BlcmF0b3Igb3B0LWluIGRvd25ncmFkZXMgdGhlIGJsb2NrIHRvIGEgZGVncmFkZWQgcnVuLlxuICAgKi9cbiAgY29uc3QgdW5hdmFpbGFibGUgPSBhc3luYyAod2h5OiBzdHJpbmcpOiBQcm9taXNlPEdoR3VhcmRTaGltT3V0Y29tZT4gPT4ge1xuICAgIGNvbnN0IG9wdGVkSW4gPSBvcHRzLmFsbG93VW5ndWFyZGVkID8/IHVuZ3VhcmRlZE9wdEluRnJvbUVudihlbnYpO1xuICAgIGNvbnN0IGJsb2NrZWQgPSBvcHRzLmFjdGl2ZSAmJiAhb3B0ZWRJbjtcbiAgICB3YXJuKFxuICAgICAgYmxvY2tlZFxuICAgICAgICA/IGBbU0VDVVJJVFldIFtHSF9HVUFSRF9TSElNX1VOQVZBSUxBQkxFXSByZWZ1c2luZyB0byBzdGFydCB0aGUgYWdlbnQ6IGAgK1xuICAgICAgICAgIGBpdHMgZ2ggY2FsbHMgd291bGQgYnlwYXNzIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCBhbmQgdGhlIGAgK1xuICAgICAgICAgIGByZXNlcnZlZC1sYWJlbCBndWFyZCBlbnRpcmVseSDigJQgJHt3aHl9LiBTZXQgYCArXG4gICAgICAgICAgYCR7VU5HVUFSREVEX0FHRU5UX0dIX0VOVn09MSB0byBwZXJtaXQgYSBkZWdyYWRlZCwgdW5ndWFyZGVkIHJ1bi5gXG4gICAgICAgIDogYFtTRUNVUklUWV0gW0dIX0dVQVJEX1NISU1fVU5BVkFJTEFCTEVdIGFnZW50IGdoIGNhbGxzIGFyZSBOT1QgYCArXG4gICAgICAgICAgYGd1YXJkZWQgYnkgdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IG9yIHRoZSByZXNlcnZlZC1sYWJlbCBndWFyZDogYCArXG4gICAgICAgICAgYCR7d2h5fWAgK1xuICAgICAgICAgIChvcHRlZEluID8gYCAocGVybWl0dGVkIGJ5ICR7VU5HVUFSREVEX0FHRU5UX0dIX0VOVn0pYCA6IFwiXCIpLFxuICAgICk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHJlY29yZCh7XG4gICAgICAgIHJ1bklkOiByZXNvbHZlUnVuSWQoKSxcbiAgICAgICAgdmVyYjogR0hfR1VBUkRfU0hJTV9BVURJVF9WRVJCLFxuICAgICAgICBvdXRjb21lOiBcImVycm9yXCIsXG4gICAgICAgIHRhcmdldDogYCR7YmxvY2tlZCA/IFwiYmxvY2tlZFwiIDogXCJkZWdyYWRlZFwifTogJHt3aHl9YCxcbiAgICAgICAgY2FsbGVyOiBcIndvcmtlci9kZW5vL2xpYi9naF9ndWFyZF9zaGltLnRzXCIsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIE5ldmVyIGxldCBqb3VybmFsbGluZyBtYXNrIHRoZSB2ZXJkaWN0IOKAlCBidXQgc2F5IHNvIChJc3N1ZSAjMzIzNCkuXG4gICAgICB3YXJuKFxuICAgICAgICBgW1NFQ1VSSVRZXSBbQVVESVRfSk9VUk5BTF9SRUZVU0VEXSAke0dIX0dVQVJEX1NISU1fQVVESVRfVkVSQn06ICR7XG4gICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgIH1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGJsb2NrZWRcbiAgICAgID8geyBzdGF0dXM6IFwiYmxvY2tlZFwiLCByZWFzb246IHdoeSB9XG4gICAgICA6IHsgc3RhdHVzOiBcImRlZ3JhZGVkXCIsIHJlYXNvbjogd2h5IH07XG4gIH07XG5cbiAgY29uc3QgcGF0aFZhbHVlID0gb3B0cy5iYXNlRW52W1wiUEFUSFwiXSA/PyBcIlwiO1xuICBjb25zdCByZWFsR2hQYXRoID0gcmVzb2x2ZUV4ZWN1dGFibGUoXCJnaFwiLCBwYXRoVmFsdWUpO1xuICBpZiAoIXJlYWxHaFBhdGgpIHJldHVybiBhd2FpdCB1bmF2YWlsYWJsZShcIm5vIGdoIGJpbmFyeSBmb3VuZCBvbiBQQVRIXCIpO1xuXG4gIGNvbnN0IGRlbm9QYXRoID0gb3B0cy5kZW5vUGF0aCA/PyBEZW5vLmV4ZWNQYXRoKCk7XG4gIGNvbnN0IGd1YXJkTW9kdWxlUGF0aCA9IG9wdHMuZ3VhcmRNb2R1bGVQYXRoID8/IGRlZmF1bHRHdWFyZE1vZHVsZVBhdGgoKTtcbiAgY29uc3QgbWFrZVRlbXBEaXIgPSBvcHRzLm1ha2VUZW1wRGlyID8/XG4gICAgKCgpID0+IERlbm8ubWFrZVRlbXBEaXIoeyBwcmVmaXg6IFwidmliZS1naC1ndWFyZC1cIiB9KSk7XG5cbiAgbGV0IGRpcjogc3RyaW5nO1xuICB0cnkge1xuICAgIGRpciA9IGF3YWl0IG1ha2VUZW1wRGlyKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiBhd2FpdCB1bmF2YWlsYWJsZShcbiAgICAgIGBjb3VsZCBub3QgY3JlYXRlIHRoZSBzaGltIGRpcmVjdG9yeTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gSXNzdWUgIzE0NDg6IGJvdGggd3JhcHBlcnMgcGluIHRoZSBndWFyZCBjaGlsZCdzIERlbm8gY2FjaGUg4oCUIHRoZSBpbWFnZSdzXG4gIC8vIHJlYWQtb25seSBzZWVkIHdoZW4gdGhpcyBob3N0IGhhcyBvbmUsIGVsc2UgYSBkaXJlY3Rvcnkgb2YgdGhpcyBydW4nc1xuICAvLyBvd24uIE9ubHkgdGhlIGNvbnRhaW5lciBpcyBleHBlY3RlZCB0byBoYXZlIHRoZSBzZWVkOyB0aGVyZSwgaXRzIGFic2VuY2VcbiAgLy8gKG9yIGEgd3JpdGFibGUgb25lKSBtZWFucyB0aGUgZ3VhcmQncyBjb21waWxlZCBtb2R1bGVzIGFyZSBhZ2VudC13cml0YWJsZVxuICAvLyBiZXR3ZWVuIGNhbGxzLCB3aGljaCBpcyBzYWlkIG91dCBsb3VkIHJhdGhlciB0aGFuIGFzc3VtZWQgYXdheS5cbiAgY29uc3QgZGVub0RpciA9IHJlc29sdmVHdWFyZERlbm9EaXIoXG4gICAgYCR7ZGlyfS9kZW5vLWNhY2hlYCxcbiAgICBlbnYsXG4gICAgb3B0cy5ndWFyZERlbm9EaXJQcm9iZSxcbiAgKTtcbiAgaWYgKCFkZW5vRGlyLnJlYWRPbmx5ICYmIGV4cGVjdHNSZWFkT25seUd1YXJkQ2FjaGUoZW52KSkge1xuICAgIHdhcm4oXG4gICAgICBgW1NFQ1VSSVRZXSBbR0hfR1VBUkRfQ0FDSEVfV1JJVEFCTEVdIHRoZSBndWFyZCBjaGlsZCdzIERlbm8gY2FjaGUgYCArXG4gICAgICAgIGAke2Rlbm9EaXIucGF0aH0gaXMgd3JpdGFibGUgYnkgdGhlIGFnZW50J3Mgb3duIHVpZCDigJQgbm8gcmVhZC1vbmx5IGAgK1xuICAgICAgICBgc2VlZCBjYWNoZSBpcyBhdmFpbGFibGUgKCR7REVOT19TRUVEX0RJUl9FTlZ9KSDigJQgc28gdGhlIGd1YXJkJ3MgYCArXG4gICAgICAgIGBjb21waWxlZCBtb2R1bGVzIGNhbiBiZSBtb2RpZmllZCBiZXR3ZWVuIGNhbGxzIChJc3N1ZSAjMTQ0OCkuYCxcbiAgICApO1xuICB9XG5cbiAgLy8gSXNzdWUgIzEyODQ6IHRoZSBgZ2l0YCB3cmFwcGVyIGdvZXMgaW4gdGhlIHNhbWUgZGlyZWN0b3J5LCBzbyBvbmUgUEFUSFxuICAvLyBwcmVmaXggY292ZXJzIGJvdGggYmluYXJpZXMgYW5kIG9uZSBjbGVhbnVwIHJlbW92ZXMgYm90aC5cbiAgY29uc3QgcmVhbEdpdFBhdGggPSByZXNvbHZlRXhlY3V0YWJsZShcImdpdFwiLCBwYXRoVmFsdWUpO1xuICBjb25zdCBnaXRTaGltUGF0aCA9IHJlYWxHaXRQYXRoID8gYCR7ZGlyfS9naXRgIDogdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHNoaW1QYXRoID0gYCR7ZGlyfS9naGA7XG4gIHRyeSB7XG4gICAgaWYgKGdpdFNoaW1QYXRoICYmIHJlYWxHaXRQYXRoKSB7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICAgIGdpdFNoaW1QYXRoLFxuICAgICAgICByZW5kZXJHaXRTaGltU2NyaXB0KHtcbiAgICAgICAgICBkZW5vUGF0aCxcbiAgICAgICAgICBndWFyZE1vZHVsZVBhdGg6IGRlZmF1bHRHaXRHdWFyZE1vZHVsZVBhdGgoKSxcbiAgICAgICAgICByZWFsR2l0UGF0aCxcbiAgICAgICAgICB2ZXJkaWN0RGlyOiBkaXIsXG4gICAgICAgICAgZGVub0RpcjogZGVub0Rpci5wYXRoLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgICBhd2FpdCBEZW5vLmNobW9kKGdpdFNoaW1QYXRoLCAwbzc1NSk7XG4gICAgfVxuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIHNoaW1QYXRoLFxuICAgICAgcmVuZGVyR2hTaGltU2NyaXB0KHtcbiAgICAgICAgZGVub1BhdGgsXG4gICAgICAgIGd1YXJkTW9kdWxlUGF0aCxcbiAgICAgICAgcmVhbEdoUGF0aCxcbiAgICAgICAgYWN0aXZlOiBvcHRzLmFjdGl2ZSxcbiAgICAgICAgYWxsb3dlZFJlcG9zOiBvcHRzLmFsbG93ZWRSZXBvcyxcbiAgICAgICAgLi4uKG9wdHMuY2xhaW1lZElzc3VlID8geyBjbGFpbWVkSXNzdWU6IG9wdHMuY2xhaW1lZElzc3VlIH0gOiB7fSksXG4gICAgICAgIHZlcmRpY3REaXI6IGRpcixcbiAgICAgICAgZGVub0RpcjogZGVub0Rpci5wYXRoLFxuICAgICAgICAvLyBJc3N1ZSAjMTYwNCDigJQgcmVmdXNhbHMgcmVhY2ggdGhlIHNhbWUgam91cm5hbCBhcyBldmVyeSBvdGhlclxuICAgICAgICAvLyBjbGFzc2lmaWVkIG11dGF0aW9uLCB3aGVyZXZlciB0aGF0IGpvdXJuYWwgaXMgb24gZm9yIHRoaXMgcnVuLlxuICAgICAgICAuLi4oaXNBdWRpdEpvdXJuYWxFbmFibGVkKGVudilcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgIGF1ZGl0OiB7XG4gICAgICAgICAgICAgIGJhc2VEaXI6IHJlc29sdmVCYXNlRGlyKHVuZGVmaW5lZCwgZW52KSxcbiAgICAgICAgICAgICAgd29ya2VySWQ6IHJlc29sdmVXb3JrZXJJZCh1bmRlZmluZWQsIGVudiksXG4gICAgICAgICAgICAgIHJ1bklkOiByZXNvbHZlUnVuSWQoZW52KSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgICBwaW5uZWRFbnY6IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICBHSF9QSU5ORURfRU5WX1ZBUlMuZmxhdE1hcCgobmFtZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBvcHRzLmJhc2VFbnZbbmFtZV07XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPT09IHVuZGVmaW5lZCA/IFtdIDogW1tuYW1lLCB2YWx1ZV0gYXMgY29uc3RdO1xuICAgICAgICAgIH0pLFxuICAgICAgICApLFxuICAgICAgfSksXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLmNobW9kKHNoaW1QYXRoLCAwbzc1NSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJldHVybiBhd2FpdCB1bmF2YWlsYWJsZShcbiAgICAgIGBjb3VsZCBub3Qgd3JpdGUgdGhlIHNoaW06ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc3RhdHVzOiBcImluc3RhbGxlZFwiLFxuICAgIHNoaW06IHtcbiAgICAgIGRpcixcbiAgICAgIHNoaW1QYXRoLFxuICAgICAgLi4uKGdpdFNoaW1QYXRoID8geyBnaXRTaGltUGF0aCB9IDoge30pLFxuICAgICAgZW52OiB7IC4uLm9wdHMuYmFzZUVudiwgUEFUSDogcGF0aFZhbHVlID8gYCR7ZGlyfToke3BhdGhWYWx1ZX1gIDogZGlyIH0sXG4gICAgICBkZW5vRGlyLFxuICAgICAgY2xlYW51cDogYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHdhcm4oXG4gICAgICAgICAgICBgW1NFQ1VSSVRZXSBbR0hfR1VBUkRfU0hJTV9DTEVBTlVQXSBjb3VsZCBub3QgcmVtb3ZlICR7ZGlyfTogJHtcbiAgICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgICAgICB9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogSW5zdGFsbCB0aGUgc2hpbSBmb3IgdGhlIGN1cnJlbnQgcnVuLCByZWFkaW5nIHRoZSBsaXZlIHdyaXRlLXJlcG8gYWxsb3dsaXN0LlxuICpcbiAqIFRoZSBjb252ZW5pZW5jZSB3cmFwcGVyIGBydW5DbGF1ZGVXaXRoVGltZW91dGAgdXNlczogaXQgcmVhZHMgdGhlIGFsbG93bGlzdFxuICogc3RhdGUgc2VlZGVkIGJ5IHRoZSBydW4gKGBzZWVkV3JpdGVSZXBvQWxsb3dsaXN0YCkgYW5kIGJha2VzIGl0IGludG8gdGhlXG4gKiB3cmFwcGVyLCBzbyB0aGUgYWdlbnQgc3VicHJvY2VzcyBpcyBoZWxkIHRvIHRoZSBzYW1lIGVncmVzcyBib3VuZGFyeSBhcyB0aGVcbiAqIHdvcmtlciBpdHNlbGYuXG4gKlxuICogVGhlIHNuYXBzaG90IGlzIHRha2VuIG9uY2UsIGhlcmUsIGFuZCBzdGF5cyBmaXhlZCBmb3IgdGhlIGxpZmUgb2YgdGhpc1xuICogY2hpbGQgKElzc3VlICMzODYxKSDigJQgdGhlIGFsbG93bGlzdCBpcyBub3QgcmUtcmVhZCBwZXIgYGdoYCBpbnZvY2F0aW9uLlxuICogYG5vdGVBZ2VudEFsbG93bGlzdFNuYXBzaG90KClgIHRlbGxzIHRoZSBhbGxvd2xpc3QgbW9kdWxlIHRoYXQsIHNvIGEgbGF0ZXJcbiAqIHdvcmtlci1zaWRlIGdyYW50IGlzIHJlcG9ydGVkIHJhdGhlciB0aGFuIG1pc3Rha2VuIGZvciBhIHdpZGVuZWQgYWdlbnRcbiAqIGJvdW5kYXJ5LlxuICpcbiAqIEBwYXJhbSBiYXNlRW52IC0gVGhlIGNoaWxkIGVudmlyb25tZW50IGJlZm9yZSB0aGUgc2hpbSBpcyBwcmVwZW5kZWQuXG4gKiBAcGFyYW0gd2FybiAtIFNpbmsgZm9yIHRoZSB1bmF2YWlsYWJsZSB3YXJuaW5nIChkZWZhdWx0cyB0byBjb25zb2xlLmVycm9yKS5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgZm9yIHRoZSBvcGVyYXRvciBvcHQtaW4gYW5kIHRoZSBhdWRpdCBnYXRlXG4gKiAgIChJc3N1ZSAjOTYxKTsgZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgaW5zdGFsbCBvdXRjb21lIOKAlCB0aGUgY2FsbGVyIG11c3QgcmVmdXNlIHRvIHNwYXduIHRoZSBhZ2VudCBvblxuICogICBhIGBibG9ja2VkYCB2ZXJkaWN0IChJc3N1ZSAjMzg2OSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmVwYXJlR2hHdWFyZFNoaW0oXG4gIGJhc2VFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4gIHdhcm4/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkLFxuICBlbnY/OiBFbnZMb29rdXAsXG4pOiBQcm9taXNlPEdoR3VhcmRTaGltT3V0Y29tZT4ge1xuICBub3RlQWdlbnRBbGxvd2xpc3RTbmFwc2hvdCgpO1xuICBjb25zdCBjbGFpbWVkSXNzdWUgPSBjbGFpbWVkSXNzdWVHdWFyZCgpO1xuICByZXR1cm4gaW5zdGFsbEdoR3VhcmRTaGltKHtcbiAgICBiYXNlRW52LFxuICAgIGFjdGl2ZTogaXNXcml0ZVJlcG9BbGxvd2xpc3RBY3RpdmUoKSxcbiAgICBhbGxvd2VkUmVwb3M6IGxpc3RBbGxvd2VkV3JpdGVSZXBvcygpLFxuICAgIC8vIElzc3VlICMyMjIg4oCUIGluZXJ0IHVubGVzcyB0aGUgcnVuIHNlZWRlZCBhIGNsYWltLlxuICAgIC4uLihjbGFpbWVkSXNzdWUgPyB7IGNsYWltZWRJc3N1ZSB9IDoge30pLFxuICAgIC4uLih3YXJuID8geyB3YXJuIH0gOiB7fSksXG4gICAgLi4uKGVudiA/IHsgZW52IH0gOiB7fSksXG4gIH0pO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUVDLEdBR0QsU0FDRSxjQUFjLEVBQ2QsY0FBYyxFQUNkLFlBQVksRUFDWixlQUFlLFFBQ1YscUJBQXFCO0FBQzVCLFNBQVMsVUFBVSxFQUFFLGNBQWMsUUFBUSxvQkFBb0I7QUFFL0QsU0FBUyxxQkFBcUIsUUFBUSxrQkFBa0I7QUFDeEQsU0FBUyxzQkFBc0IsUUFBUSx5QkFBeUI7QUFDaEUsU0FDRSxpQkFBaUIsRUFDakIseUJBQXlCLEVBR3pCLG1CQUFtQixRQUNkLHNCQUFzQjtBQUM3QixTQUNFLHFCQUFxQixFQUNyQixzQkFBc0IsUUFDakIsb0JBQW9CO0FBQzNCLFNBQ0UsMEJBQTBCLEVBQzFCLHFCQUFxQixFQUNyQiwwQkFBMEIsUUFDckIsNEJBQTRCO0FBQ25DLFNBQ0UseUJBQXlCLEVBQ3pCLG1CQUFtQixRQUNkLHNCQUFzQjtBQUM3QixTQUFTLG9CQUFvQixVQUFVLFFBQVEsbUJBQW1CO0FBQ2xFLFNBQXlCLGdCQUFnQixRQUFRLGtCQUFrQjtBQUNuRSxTQUE0QixpQkFBaUIsUUFBUSwyQkFBMkI7QUFFaEY7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sTUFBTSxzQkFBeUM7RUFDcEQ7RUFDQTtFQUNBO0NBQ0QsQ0FBQztBQUVGOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxNQUFNLHFCQUF3QztFQUNuRDtFQUNBO0NBQ0QsQ0FBQztBQUVGOzs7Ozs7O0NBT0MsR0FDRCxP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
// denoCacheMetadata=17426504295537937428,3833850386678675694