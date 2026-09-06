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
 */

import type { AuditMutation } from "./audit_journal.ts";
import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { isAuditJournalEnabled } from "./audit_hook.ts";
import {
  GH_GUARD_ALLOW_MARKER,
  GH_GUARD_REFUSE_MARKER,
} from "./gh_guard_cli.ts";
import {
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  noteAgentAllowlistSnapshot,
} from "./write_repo_allowlist.ts";
import {
  defaultGitGuardModulePath,
  renderGitShimScript,
} from "./git_guard_shim.ts";
import { posixSingleQuote as shellQuote } from "./shell_quote.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { type ClaimedIssue, claimedIssueGuard } from "./claimed_issue_guard.ts";

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
 */
export const GH_CLEARED_ENV_VARS: readonly string[] = [
  "GH_REPO",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * `gh` target variables the wrapper re-asserts from the run (Issue #3866).
 *
 * A deployment may legitimately set these — `GH_HOST` names a GitHub
 * Enterprise host, `GH_CONFIG_DIR` selects the worker identity's `gh` config —
 * so the wrapper pins the run's own value and drops whatever the caller
 * supplied. Pinning `GH_CONFIG_DIR` also fixes which config file's aliases
 * `gh` can expand. A variable the run does not set is cleared in the child.
 */
export const GH_PINNED_ENV_VARS: readonly string[] = [
  "GH_HOST",
  "GH_CONFIG_DIR",
];

/**
 * Environment variable an operator sets to permit a degraded, **unguarded**
 * agent run when the shim cannot be installed (Issue #3869).
 *
 * Absent (or falsey), an uninstallable shim blocks the spawn while the
 * write-repo allowlist is active. This is deliberately an operator decision,
 * never an inference from an I/O failure.
 */
export const UNGUARDED_AGENT_GH_ENV = "VIBE_ALLOW_UNGUARDED_AGENT_GH";

/** Audit verb recorded when the shim could not be installed (Issue #3869). */
export const GH_GUARD_SHIM_AUDIT_VERB = "gh-guard-shim-unavailable";

/** Sink recording the shim-unavailable event; rejects when it cannot. */
export type ShimAuditRecorder = (mutation: AuditMutation) => Promise<void>;

/** Options for {@link installGhGuardShim}. */
export interface GhGuardShimOptions {
  /** Environment the child would otherwise receive (must carry `PATH`). */
  baseEnv: Record<string, string>;
  /** Whether the run's write-repo allowlist is active. */
  active: boolean;
  /** `owner/repo` slugs the run may write to. */
  allowedRepos: readonly string[];
  /**
   * The issue this run claimed (Issue #222). Baked into the wrapper so the
   * agent's own `gh issue close|reopen|…` on the claimed repo is refused.
   */
  claimedIssue?: ClaimedIssue;
  /** Sink for the loud warning when the shim cannot be installed. */
  warn?: (message: string) => void;
  /** Override the guard module path (test seam). */
  guardModulePath?: string;
  /** Override the `deno` binary path (test seam). */
  denoPath?: string;
  /**
   * Override the operator opt-in decision (test seam). Defaults to reading
   * {@link UNGUARDED_AGENT_GH_ENV}.
   */
  allowUnguarded?: boolean;
  /**
   * Environment lookup for {@link UNGUARDED_AGENT_GH_ENV} (Issue #964).
   * Defaults to the process environment, so production behaves exactly as
   * it did when this module read `Deno.env.get` itself. A test hands in a
   * fixed map rather than mutating the environment every parallel worker
   * shares.
   */
  env?: EnvLookup;
  /** Override the audit sink (test seam). Defaults to the journal. */
  record?: ShimAuditRecorder;
  /** Override temp-directory creation (test seam). */
  makeTempDir?: () => Promise<string>;
}

/**
 * Outcome of an install attempt (Issue #3869).
 *
 * `blocked` is the fail-closed verdict: the caller must not spawn the agent,
 * because its `gh` calls would bypass the write-repo allowlist and the
 * reserved-label guard entirely. `degraded` means the run may proceed
 * unguarded — either the allowlist is inactive, or an operator opted in.
 */
export type GhGuardShimOutcome =
  | { status: "installed"; shim: GhGuardShim }
  | { status: "degraded"; reason: string }
  | { status: "blocked"; reason: string };

/** An installed shim, its child environment, and its cleanup hook. */
export interface GhGuardShim {
  /** Directory holding the wrapper (prepended to the child's `PATH`). */
  dir: string;
  /** Absolute path of the wrapper itself. */
  shimPath: string;
  /**
   * Absolute path of the `git` wrapper installed beside it (Issue #1284).
   *
   * Absent only when the base `PATH` carries no `git` at all — the child
   * searches the same directories, so there is then no `git` for the agent to
   * run and nothing the shim could have guarded.
   */
  gitShimPath?: string;
  /** The child environment with the wrapper first on `PATH`. */
  env: Record<string, string>;
  /** Remove the wrapper directory. Best-effort; warns on failure. */
  cleanup: () => Promise<void>;
}

/**
 * Find an executable named `name` on a `PATH` string.
 *
 * @param name - Binary name to resolve (e.g. `gh`).
 * @param pathValue - Colon-separated `PATH` to search.
 * @returns Absolute path of the first executable match, or undefined.
 */
export function resolveExecutable(
  name: string,
  pathValue: string,
): string | undefined {
  for (const dir of pathValue.split(":")) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/${name}`;
    try {
      const info = Deno.statSync(candidate);
      if (info.isFile && ((info.mode ?? 0o111) & 0o111) !== 0) return candidate;
    } catch {
      // Not present in this directory — keep searching.
    }
  }
  return undefined;
}

/** Absolute path of the guard entry point this shim invokes. */
function defaultGuardModulePath(): string {
  return decodeURIComponent(
    new URL("./gh_guard_cli.ts", import.meta.url).pathname,
  );
}

/**
 * Render the wrapper script.
 *
 * Exported for direct assertion of the fail-closed contract in tests.
 *
 * @param opts - Absolute binary/module paths plus the run's allowlist state.
 * @returns The bash script body.
 */
export function renderGhShimScript(opts: {
  denoPath: string;
  guardModulePath: string;
  realGhPath: string;
  active: boolean;
  allowedRepos: readonly string[];
  /** The run's claimed issue and the lifecycle verbs it permits (#222). */
  claimedIssue?: ClaimedIssue;
  /** The wrapper's own private directory — where it buffers the verdict. */
  verdictDir: string;
  /** The run's own values for {@link GH_PINNED_ENV_VARS}. */
  pinnedEnv?: Readonly<Record<string, string>>;
}): string {
  const claim = opts.claimedIssue;
  const guardArgs = [
    ...(opts.active ? ["--active"] : []),
    ...opts.allowedRepos.flatMap((r) => ["--allow-repo", r]),
    // Issue #222 — baked in as arguments, like the allowlist, so the agent
    // cannot switch the claimed-issue guard off with an `unset`.
    ...(claim
      ? [
        "--claimed-issue",
        `${claim.repo}#${claim.issueNumber}`,
        ...claim.allowedVerbs.flatMap((v) => ["--allow-issue-verb", v]),
      ]
      : []),
  ].map(shellQuote).join(" ");

  // Issue #3866: clear what the run never sets, pin what it does. `unset`
  // first, so a variable the run has no value for cannot be supplied by the
  // agent.
  const cleared = [...GH_CLEARED_ENV_VARS];
  const pins: string[] = [];
  for (const name of GH_PINNED_ENV_VARS) {
    const value = opts.pinnedEnv?.[name];
    if (value === undefined) cleared.push(name);
    else pins.push(`export ${name}=${shellQuote(value)}`);
  }
  const targetEnvLines = [`unset ${cleared.join(" ")}`, ...pins].join("\n");

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

GUARD_ARGS=(${guardArgs})

# Issue #3938 — the guard returns the argv to run, with the published bodies
# redacted, as NUL-terminated fields. A NUL cannot cross a command
# substitution, so the verdict is buffered in the wrapper's own private
# directory (0700, per run, removed when the child exits) instead. No external
# command is used for it: a security wrapper must not need a PATH lookup, and
# the agent controls its own PATH.
GUARD_OUT=${shellQuote(opts.verdictDir)}/verdict.$$
if ! : > "$GUARD_OUT"; then
  printf '%s\\n' "[SECURITY] [GH_GUARD_ERROR] could not create the guard's verdict file — refusing to run this gh command." >&2
  exit 126
fi

status=0
${shellQuote(opts.denoPath)} run --quiet --no-config --no-lock --allow-read \\
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
 */
export function unguardedOptInFromEnv(
  env: EnvLookup = processEnvLookup,
): boolean {
  let raw: string | undefined;
  try {
    raw = env(UNGUARDED_AGENT_GH_ENV);
  } catch {
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
 */
async function journalShimUnavailable(
  mutation: AuditMutation,
  env: EnvLookup = processEnvLookup,
): Promise<void> {
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
 */
export async function installGhGuardShim(
  opts: GhGuardShimOptions,
): Promise<GhGuardShimOutcome> {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const env = opts.env ?? processEnvLookup;
  const record = opts.record ??
    ((mutation: AuditMutation) => journalShimUnavailable(mutation, env));

  /**
   * Report an uninstallable shim and decide whether the run may continue.
   *
   * Fail closed (Issue #3869): while the allowlist is active, only an explicit
   * operator opt-in downgrades the block to a degraded run.
   */
  const unavailable = async (why: string): Promise<GhGuardShimOutcome> => {
    const optedIn = opts.allowUnguarded ?? unguardedOptInFromEnv(env);
    const blocked = opts.active && !optedIn;
    warn(
      blocked
        ? `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE] refusing to start the agent: ` +
          `its gh calls would bypass the write-repo allowlist and the ` +
          `reserved-label guard entirely — ${why}. Set ` +
          `${UNGUARDED_AGENT_GH_ENV}=1 to permit a degraded, unguarded run.`
        : `[SECURITY] [GH_GUARD_SHIM_UNAVAILABLE] agent gh calls are NOT ` +
          `guarded by the write-repo allowlist or the reserved-label guard: ` +
          `${why}` +
          (optedIn ? ` (permitted by ${UNGUARDED_AGENT_GH_ENV})` : ""),
    );
    try {
      await record({
        runId: resolveRunId(),
        verb: GH_GUARD_SHIM_AUDIT_VERB,
        outcome: "error",
        target: `${blocked ? "blocked" : "degraded"}: ${why}`,
        caller: "worker/deno/lib/gh_guard_shim.ts",
      });
    } catch (err) {
      // Never let journalling mask the verdict — but say so (Issue #3234).
      warn(
        `[SECURITY] [AUDIT_JOURNAL_REFUSED] ${GH_GUARD_SHIM_AUDIT_VERB}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return blocked
      ? { status: "blocked", reason: why }
      : { status: "degraded", reason: why };
  };

  const pathValue = opts.baseEnv["PATH"] ?? "";
  const realGhPath = resolveExecutable("gh", pathValue);
  if (!realGhPath) return await unavailable("no gh binary found on PATH");

  const denoPath = opts.denoPath ?? Deno.execPath();
  const guardModulePath = opts.guardModulePath ?? defaultGuardModulePath();
  const makeTempDir = opts.makeTempDir ??
    (() => Deno.makeTempDir({ prefix: "vibe-gh-guard-" }));

  let dir: string;
  try {
    dir = await makeTempDir();
  } catch (err) {
    return await unavailable(
      `could not create the shim directory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Issue #1284: the `git` wrapper goes in the same directory, so one PATH
  // prefix covers both binaries and one cleanup removes both.
  const realGitPath = resolveExecutable("git", pathValue);
  const gitShimPath = realGitPath ? `${dir}/git` : undefined;

  const shimPath = `${dir}/gh`;
  try {
    if (gitShimPath && realGitPath) {
      await Deno.writeTextFile(
        gitShimPath,
        renderGitShimScript({
          denoPath,
          guardModulePath: defaultGitGuardModulePath(),
          realGitPath,
          verdictDir: dir,
        }),
      );
      await Deno.chmod(gitShimPath, 0o755);
    }
    await Deno.writeTextFile(
      shimPath,
      renderGhShimScript({
        denoPath,
        guardModulePath,
        realGhPath,
        active: opts.active,
        allowedRepos: opts.allowedRepos,
        ...(opts.claimedIssue ? { claimedIssue: opts.claimedIssue } : {}),
        verdictDir: dir,
        pinnedEnv: Object.fromEntries(
          GH_PINNED_ENV_VARS.flatMap((name) => {
            const value = opts.baseEnv[name];
            return value === undefined ? [] : [[name, value] as const];
          }),
        ),
      }),
    );
    await Deno.chmod(shimPath, 0o755);
  } catch (err) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    return await unavailable(
      `could not write the shim: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    status: "installed",
    shim: {
      dir,
      shimPath,
      ...(gitShimPath ? { gitShimPath } : {}),
      env: { ...opts.baseEnv, PATH: pathValue ? `${dir}:${pathValue}` : dir },
      cleanup: async () => {
        try {
          await Deno.remove(dir, { recursive: true });
        } catch (err) {
          warn(
            `[SECURITY] [GH_GUARD_SHIM_CLEANUP] could not remove ${dir}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
    },
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
 */
export function prepareGhGuardShim(
  baseEnv: Record<string, string>,
  warn?: (message: string) => void,
  env?: EnvLookup,
): Promise<GhGuardShimOutcome> {
  noteAgentAllowlistSnapshot();
  const claimedIssue = claimedIssueGuard();
  return installGhGuardShim({
    baseEnv,
    active: isWriteRepoAllowlistActive(),
    allowedRepos: listAllowedWriteRepos(),
    // Issue #222 — inert unless the run seeded a claim.
    ...(claimedIssue ? { claimedIssue } : {}),
    ...(warn ? { warn } : {}),
    ...(env ? { env } : {}),
  });
}
