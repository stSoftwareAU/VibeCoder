/**
 * Git operation timeout management (Issue #619, #912).
 *
 * Wraps git commands with AbortController-based timeout protection to prevent
 * indefinite hangs when a git operation stalls (network issues, SSH prompts,
 * remote unresponsive).
 *
 * Migrated from worker/shared/git_timeout.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { ensureUsableGhConfigDir, gitGlobalConfigEntries, isGitAuthMissingFailure, mountedGitLogin } from "./gh_credential_stage.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { auditGitMutation, isAuditJournalEnabled } from "./audit_hook.ts";
import { gitSubcommandIndex, redactGitMessageArgs, UnredactableMessageError } from "./git_message_redaction.ts";
/** Default timeout in seconds for standard git operations. */ const DEFAULT_GIT_COMMAND_TIMEOUT = 60;
/** Default timeout in seconds for merge/rebase/pull operations. */ const DEFAULT_GIT_MERGE_TIMEOUT = 120;
/** Exit code returned when a git operation times out. */ import { noteGitOutputForVolumeFault } from "./work_volume_fault.ts";
import { clampTimeoutToRunTimeline, formatTimeoutSeconds, subprocessCommandLabel, waitForChildExit } from "./subprocess_timeout.ts";
export const TIMEOUT_EXIT_CODE = 124;
/**
 * Determine the appropriate timeout for a git subcommand.
 *
 * Merge and rebase operations get a longer timeout because they involve more
 * computation. All other operations use the default command timeout.
 *
 * @param gitSubcommand - The first argument to git (e.g., fetch, push, merge)
 * @returns Timeout duration in seconds
 */ export function getTimeoutForOperation(gitSubcommand) {
  const gitCommandTimeout = Number(Deno.env.get("GIT_COMMAND_TIMEOUT") ?? DEFAULT_GIT_COMMAND_TIMEOUT);
  const gitMergeTimeout = Number(Deno.env.get("GIT_MERGE_TIMEOUT") ?? DEFAULT_GIT_MERGE_TIMEOUT);
  switch(gitSubcommand){
    case "merge":
    case "rebase":
    case "pull":
      return gitMergeTimeout;
    default:
      return gitCommandTimeout;
  }
}
/**
 * Check if an exit code indicates a timeout.
 *
 * @param exitCode - The exit code to check
 * @returns True if the exit code indicates a timeout
 */ export function isGitTimeout(exitCode) {
  return exitCode === TIMEOUT_EXIT_CODE;
}
/**
 * Run a git command with timeout protection using AbortController.
 *
 * @param args - Arguments to pass to git (e.g., ["fetch", "origin"])
 * @param options - Options for the command execution
 * @returns Result containing the command output or an error
 */ /**
 * Git-auth repairs this process will perform (Issue #564).
 *
 * Bounded for the same reason as the `gh` re-stage: a credential that keeps
 * vanishing is a fault to report, and a genuinely revoked one must fail
 * rather than be rebuilt on every call for the rest of the run.
 */ export const MAX_GIT_AUTH_REPAIRS = 3;
let gitAuthRepairs = 0;
/** Reset the git-auth repair budget. Tests only. */ export function resetGitAuthRepairs() {
  gitAuthRepairs = 0;
}
/**
 * Rebuild the credential helper, HTTPS transport and identity from the mount.
 *
 * Writes through `git config --global`, so it lands wherever
 * `GIT_CONFIG_GLOBAL` points — the staged copy the container owns.
 *
 * @returns True when something was written and a retry is worth making.
 */ async function repairGitAuthEnvironment() {
  // The helper shells out to `gh`, so its configuration has to be sound too.
  ensureUsableGhConfigDir();
  const home = Deno.env.get("HOME") ?? "";
  const login = mountedGitLogin(home);
  let wrote = false;
  for (const entry of gitGlobalConfigEntries(login)){
    try {
      const command = new Deno.Command("git", {
        args: [
          "config",
          ...entry.args
        ],
        stdout: "null",
        stderr: "null"
      });
      const result = await command.output();
      if (result.code === 0) wrote = true;
    } catch  {
    // Best-effort: the caller's own failure stays the loud one.
    }
  }
  if (wrote) {
    console.error("[SECURITY] git lost its credential helper or identity — rebuilt from " + "the read-only credential mount (Issue #564)");
  }
  return wrote;
}
/**
 * `safe.directory` repairs this process will attempt (Issue #2825), bounded
 * like the Issue #564 auth repair.
 */ export const MAX_SAFE_DIRECTORY_REPAIRS = 3;
let safeDirectoryRepairs = 0;
/** Reset the `safe.directory` repair budget. Tests only. */ export function resetSafeDirectoryRepairs() {
  safeDirectoryRepairs = 0;
}
/** True when a finished git call was refused for dubious ownership. */ export function isDubiousOwnershipFailure(result) {
  return result.code !== 0 && result.stderr.toLowerCase().includes("detected dubious ownership");
}
/**
 * Restore the `safe.directory = *` line the container entrypoint stages
 * (Issue #2825). Without it git refuses the clone, and `git config` refuses
 * quietly — `--add` says only "not in a git directory" — so setup died in the
 * first minute. Runs with the failed call's `env`, so it writes wherever that
 * call's `GIT_CONFIG_GLOBAL` points.
 *
 * @returns True when the line was written and a retry is worth making.
 */ async function repairSafeDirectory(env) {
  if (safeDirectoryRepairs >= MAX_SAFE_DIRECTORY_REPAIRS) return false;
  safeDirectoryRepairs++;
  const config = (args)=>new Deno.Command("git", {
      args: [
        "config",
        "--global",
        ...args
      ],
      env,
      stdout: "piped",
      stderr: "null"
    }).output();
  try {
    const existing = new TextDecoder().decode((await config([
      "--get-all",
      "safe.directory"
    ])).stdout);
    // Already present: the repair cannot help, so the caller's failure stands.
    if (existing.split("\n").some((line)=>line.trim() === "*")) return false;
    if ((await config([
      "--add",
      "safe.directory",
      "*"
    ])).code !== 0) {
      return false;
    }
  } catch  {
    // Best-effort: the caller's own dubious-ownership failure stays loud.
    return false;
  }
  console.error("[SECURITY] git refused a clone as dubious ownership — restored the " + "staged safe.directory line (Issue #2825)");
  return true;
}
/**
 * Reader the message redaction uses for `-F <path>` bodies (Issue #1284).
 *
 * Throws when the file cannot be read, which the caller turns into a loud
 * refusal rather than an unscanned commit.
 */ function readMessageFileSync(path) {
  return Deno.readTextFileSync(path);
}
/**
 * Capture the commits a single explicit branch push would add to its remote.
 * Read an existing destination from the remote itself, never a possibly stale
 * tracking ref. For a new destination, exclude this remote's tracked history.
 * Unsupported push forms and unavailable/shallow history leave provenance unknown.
 */ export async function capturePushCommits(args, options = {}) {
  if (args[0] !== "push") return undefined;
  const positional = args.slice(1);
  while(positional[0] === "-u" || positional[0] === "--set-upstream"){
    positional.shift();
  }
  if (positional[0] === "--end-of-options") positional.shift();
  if (positional.length !== 2) return undefined;
  const [remote, refspec] = positional;
  if (!remote || !refspec) return undefined;
  // Restrict routing to explicit branch names; flags, deletion, force,
  // matching/multiple refs and HEAD shorthand remain unknown.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) || !/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(refspec)) return undefined;
  const parts = refspec.split(":");
  if (parts.length > 2 || parts.some((p)=>!p || p === "HEAD")) {
    return undefined;
  }
  const [source, destination = source] = parts;
  if (!source || !destination) return undefined;
  const branch = destination.startsWith("refs/heads/") ? destination : `refs/heads/${destination}`;
  const remoteHead = await runGitCommand([
    "ls-remote",
    "--heads",
    "--end-of-options",
    remote,
    branch
  ], options);
  if (!remoteHead.ok || remoteHead.value.code !== 0) return undefined;
  const lines = remoteHead.value.stdout.trim().split("\n").filter(Boolean);
  if (lines.length > 1) return undefined;
  const old = lines[0]?.split(/\s+/)[0];
  if (old !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(old)) {
    return undefined;
  }
  const shallow = await runGitCommand([
    "rev-parse",
    "--is-shallow-repository"
  ], options);
  if (!shallow.ok || shallow.value.code !== 0 || shallow.value.stdout.trim() !== "false") return undefined;
  const commits = await runGitCommand([
    "rev-list",
    // A new destination must not journal history already on this remote.
    ...old ? [] : [
      "--not",
      `--remotes=${remote}`,
      "--not"
    ],
    "--end-of-options",
    ...old ? [
      `${old}..${source}`
    ] : [
      source
    ]
  ], options);
  if (!commits.ok || commits.value.code !== 0) return undefined;
  return commits.value.stdout.trim().split("\n").filter(Boolean);
}
export async function runGitCommand(args, options = {}) {
  const gitSubcommand = args[0] ?? "";
  const timeoutSeconds = options.timeoutSeconds ?? getTimeoutForOperation(gitSubcommand);
  // Issue #1284: mask secrets in the message arguments before the process
  // starts. A pushed commit message is permanent public history, so this is
  // the git counterpart of `redactGhBodyArgs` at the `gh` chokepoint. Only
  // text-carrying arguments are rewritten; routing arguments are untouched.
  // Named for the log lines below: `args[0]` is `-C` for `git -C /repo commit`.
  const subcommandName = args[gitSubcommandIndex(args)] ?? gitSubcommand;
  let effectiveArgs;
  try {
    effectiveArgs = redactGitMessageArgs(args, readMessageFileSync);
  } catch (error) {
    if (!(error instanceof UnredactableMessageError)) throw error;
    // Fail loud rather than commit a message no control could scan. The
    // message names the source, never the unscanned text.
    return {
      ok: false,
      error: new Error(`[SECURITY] [GIT_MESSAGE_UNREDACTABLE] refusing to run git ` + `${subcommandName}: ${error.message}`)
    };
  }
  if (effectiveArgs.some((arg, i)=>arg !== args[i])) {
    console.error("[SECURITY] [GIT_MESSAGE_REDACTED] a secret was masked in the message " + `of this git ${subcommandName} before it reached history (Issue #1284)`);
  }
  // Issue #4247: the table (or the caller's override) is then clamped to the
  // run timeline. Read it before any await so a test can set the timeline
  // for this call only. A budget of 0 or less throws and does not spawn.
  const commandLabel = subprocessCommandLabel("git", effectiveArgs);
  const timeoutMs = clampTimeoutToRunTimeline(timeoutSeconds * 1000, commandLabel);
  const reportedSeconds = formatTimeoutSeconds(timeoutMs);
  // Audit the same effective environment as the child (env overrides inherit
  // all unspecified names). This also keeps isolated callers off host journals.
  const auditEnv = (key)=>options.env?.[key] ?? Deno.env.get(key);
  const deliveredCommits = subcommandName === "push" && isAuditJournalEnabled(auditEnv) ? await capturePushCommits(effectiveArgs, options) : undefined;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const command = new Deno.Command("git", {
      args: effectiveArgs,
      cwd: options.cwd,
      env: options.env,
      stdout: "piped",
      stderr: "piped",
      stdin: "null"
    });
    const child = command.spawn();
    const outcome = await waitForChildExit(child, controller.signal, commandLabel);
    clearTimeout(timer);
    // Issue #1378: a timed-out call used to resolve with git's signal exit
    // code (143) and was reported as a plain failure, which hid every timeout
    // from `isGitTimeout`. The abort, including a kill that did not finish
    // inside the grace, is a timeout.
    if (outcome.kind === "kill-incomplete" || outcome.kind === "aborted" || controller.signal.aborted) {
      incrementCounter("timeouts");
      return {
        ok: true,
        value: {
          code: TIMEOUT_EXIT_CODE,
          stdout: "",
          stderr: `TIMEOUT: git ${args.join(" ")} timed out after ${reportedSeconds}s (Issue #619)`
        }
      };
    }
    const process = outcome.output;
    const stdout = new TextDecoder().decode(process.stdout);
    const stderr = new TextDecoder().decode(process.stderr);
    // Issue #229: a filesystem-level failure in git's output is a host
    // fault, not this call's — record it once so the claim guards stop new
    // work on the broken volume.
    if (process.code !== 0) {
      noteGitOutputForVolumeFault(effectiveArgs, stderr, stdout);
    }
    // Issue #564: git lost its credential helper and identity mid-run while
    // `gh` still worked — the staged global config had been reduced to its
    // `safe.directory` line. Rebuild both from the read-only mount and retry
    // once. A call that failed for want of credentials did nothing, so the
    // retry is safe, and every git caller inherits the recovery.
    if (isGitAuthMissingFailure({
      code: process.code,
      stderr
    }) && gitAuthRepairs < MAX_GIT_AUTH_REPAIRS) {
      gitAuthRepairs++;
      if (await repairGitAuthEnvironment()) {
        const retry = await runGitCommand(args, options);
        if (retry.ok) {
          return retry;
        }
      }
    }
    // Issue #2825: git refused the clone as dubious ownership because the
    // staged `safe.directory` line went missing. A refused call did nothing,
    // so restoring the line and retrying once is safe.
    if (isDubiousOwnershipFailure({
      code: process.code,
      stderr
    }) && await repairSafeDirectory(options.env)) {
      return await runGitCommand(args, options);
    }
    // Issue #2380: journal `git push` mutations to the audit log.
    // Best-effort — never lets journalling alter or abort the git call.
    await auditGitMutation(effectiveArgs, process.code, {
      env: auditEnv,
      deliveredCommits
    });
    return {
      ok: true,
      value: {
        code: process.code,
        stdout,
        stderr
      }
    };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      incrementCounter("timeouts");
      return {
        ok: true,
        value: {
          code: TIMEOUT_EXIT_CODE,
          stdout: "",
          stderr: `TIMEOUT: git ${effectiveArgs.join(" ")} timed out after ${reportedSeconds}s (Issue #619)`
        }
      };
    }
    return {
      ok: false,
      error: new Error(`Failed to execute git ${effectiveArgs.join(" ")}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Run a git command and return success/failure based on exit code.
 *
 * Convenience wrapper around runGitCommand that checks the exit code.
 *
 * @param args - Arguments to pass to git
 * @param options - Options for the command execution
 * @returns Result with stdout on success, error message on failure
 */ export async function runGitCommandChecked(args, options = {}) {
  const result = await runGitCommand(args, options);
  if (!result.ok) {
    return result;
  }
  const { code, stdout, stderr } = result.value;
  if (code !== 0) {
    if (isGitTimeout(code)) {
      return {
        ok: false,
        error: new Error(`TIMEOUT: git ${args.join(" ")} timed out (Issue #619)`)
      };
    }
    return {
      ok: false,
      error: new Error(`git ${args.join(" ")} failed (exit code ${code}): ${stderr.trim() || stdout.trim()}`)
    };
  }
  return {
    ok: true,
    value: stdout
  };
}
/**
 * Run a full `git …` argv — binary included — through the chokepoint
 * (Issue #1553).
 *
 * The worker's generic pass-through runners are handed an argv whose head is
 * the binary (`["git", "-C", dir, "push", …]`), often built in a different
 * module. `runGitCommand` takes the arguments *after* the binary, so each
 * runner had to strip the head itself; none did, and they spawned git
 * directly instead — outside the timeout, the audit journal and the
 * work-volume fault detector. This adapter is the one-line delegation those
 * runners use, so the head-stripping is written once rather than per caller.
 *
 * A `Result` error (a redaction refusal, a spawn failure) is reported as an
 * unsuccessful call carrying the message, never swallowed.
 *
 * @param argv - Full argv with `git` as its head; a missing head is fine, the
 *   remainder is still routed.
 * @param options - Same options as {@link runGitCommand}.
 * @returns Success plus the trimmed streams.
 */ export async function runGitArgv(argv, options = {}) {
  const args = argv[0] === "git" ? argv.slice(1) : [
    ...argv
  ];
  const result = await runGitCommand(args, options);
  if (!result.ok) {
    return {
      success: false,
      stdout: "",
      stderr: result.error.message
    };
  }
  const { code, stdout, stderr } = result.value;
  return {
    success: code === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}
/**
 * Synchronous local git read (Issue #4120).
 *
 * The post-run callback context is built synchronously, so that read cannot
 * await {@link runGitCommand}. The spawn stays in this module, which is the
 * only file allowed to start `git` (Issue #1214). `outputSync` cannot take
 * the AbortController timeout the async path uses, so this is for local
 * metadata (`describe`, `rev-parse`), not for a git call that talks to a
 * remote.
 *
 * A finished process is returned even when git exits non-zero. A spawn that
 * cannot start throws, including `NotCapable` and `NotFound`. An unreadable
 * commit message throws {@link UnredactableMessageError}.
 */ export function runGitReadSync(args, options = {}) {
  const effectiveArgs = redactGitMessageArgs(args, readMessageFileSync);
  const process = new Deno.Command("git", {
    args: effectiveArgs,
    cwd: options.cwd,
    env: options.env,
    stdout: "piped",
    stderr: "piped"
  }).outputSync();
  const stdout = new TextDecoder().decode(process.stdout);
  const stderr = new TextDecoder().decode(process.stderr);
  if (process.code !== 0) {
    noteGitOutputForVolumeFault(effectiveArgs, stderr, stdout);
  }
  return {
    code: process.code,
    stdout,
    stderr
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfdGltZW91dC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEdpdCBvcGVyYXRpb24gdGltZW91dCBtYW5hZ2VtZW50IChJc3N1ZSAjNjE5LCAjOTEyKS5cbiAqXG4gKiBXcmFwcyBnaXQgY29tbWFuZHMgd2l0aCBBYm9ydENvbnRyb2xsZXItYmFzZWQgdGltZW91dCBwcm90ZWN0aW9uIHRvIHByZXZlbnRcbiAqIGluZGVmaW5pdGUgaGFuZ3Mgd2hlbiBhIGdpdCBvcGVyYXRpb24gc3RhbGxzIChuZXR3b3JrIGlzc3VlcywgU1NIIHByb21wdHMsXG4gKiByZW1vdGUgdW5yZXNwb25zaXZlKS5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvZ2l0X3RpbWVvdXQuc2guXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIGVuc3VyZVVzYWJsZUdoQ29uZmlnRGlyLFxuICBnaXRHbG9iYWxDb25maWdFbnRyaWVzLFxuICBpc0dpdEF1dGhNaXNzaW5nRmFpbHVyZSxcbiAgbW91bnRlZEdpdExvZ2luLFxufSBmcm9tIFwiLi9naF9jcmVkZW50aWFsX3N0YWdlLnRzXCI7XG5pbXBvcnQgeyBpbmNyZW1lbnRDb3VudGVyIH0gZnJvbSBcIi4vZmF1bHRfdG9sZXJhbmNlX2NvdW50ZXJzLnRzXCI7XG5pbXBvcnQgeyBhdWRpdEdpdE11dGF0aW9uLCBpc0F1ZGl0Sm91cm5hbEVuYWJsZWQgfSBmcm9tIFwiLi9hdWRpdF9ob29rLnRzXCI7XG5pbXBvcnQge1xuICBnaXRTdWJjb21tYW5kSW5kZXgsXG4gIHJlZGFjdEdpdE1lc3NhZ2VBcmdzLFxuICBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IsXG59IGZyb20gXCIuL2dpdF9tZXNzYWdlX3JlZGFjdGlvbi50c1wiO1xuXG4vKiogRGVmYXVsdCB0aW1lb3V0IGluIHNlY29uZHMgZm9yIHN0YW5kYXJkIGdpdCBvcGVyYXRpb25zLiAqL1xuY29uc3QgREVGQVVMVF9HSVRfQ09NTUFORF9USU1FT1VUID0gNjA7XG5cbi8qKiBEZWZhdWx0IHRpbWVvdXQgaW4gc2Vjb25kcyBmb3IgbWVyZ2UvcmViYXNlL3B1bGwgb3BlcmF0aW9ucy4gKi9cbmNvbnN0IERFRkFVTFRfR0lUX01FUkdFX1RJTUVPVVQgPSAxMjA7XG5cbi8qKiBFeGl0IGNvZGUgcmV0dXJuZWQgd2hlbiBhIGdpdCBvcGVyYXRpb24gdGltZXMgb3V0LiAqL1xuaW1wb3J0IHsgbm90ZUdpdE91dHB1dEZvclZvbHVtZUZhdWx0IH0gZnJvbSBcIi4vd29ya192b2x1bWVfZmF1bHQudHNcIjtcbmltcG9ydCB7XG4gIGNsYW1wVGltZW91dFRvUnVuVGltZWxpbmUsXG4gIGZvcm1hdFRpbWVvdXRTZWNvbmRzLFxuICBzdWJwcm9jZXNzQ29tbWFuZExhYmVsLFxuICB3YWl0Rm9yQ2hpbGRFeGl0LFxufSBmcm9tIFwiLi9zdWJwcm9jZXNzX3RpbWVvdXQudHNcIjtcblxuZXhwb3J0IGNvbnN0IFRJTUVPVVRfRVhJVF9DT0RFID0gMTI0O1xuXG4vKiogUmVzdWx0IG9mIHJ1bm5pbmcgYSBnaXQgY29tbWFuZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2l0Q29tbWFuZE91dHB1dCB7XG4gIC8qKiBFeGl0IGNvZGUgZnJvbSB0aGUgZ2l0IHByb2Nlc3MuICovXG4gIGNvZGU6IG51bWJlcjtcbiAgLyoqIFN0YW5kYXJkIG91dHB1dCB0ZXh0LiAqL1xuICBzdGRvdXQ6IHN0cmluZztcbiAgLyoqIFN0YW5kYXJkIGVycm9yIHRleHQuICovXG4gIHN0ZGVycjogc3RyaW5nO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgcnVubmluZyBhIGdpdCBjb21tYW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRDb21tYW5kT3B0aW9ucyB7XG4gIC8qKiBXb3JraW5nIGRpcmVjdG9yeSBmb3IgdGhlIGdpdCBjb21tYW5kLiAqL1xuICBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBPdmVycmlkZSB0aGUgZGVmYXVsdCB0aW1lb3V0IGluIHNlY29uZHMuICovXG4gIHRpbWVvdXRTZWNvbmRzPzogbnVtYmVyO1xuICAvKiogRW52aXJvbm1lbnQgdmFyaWFibGVzIHRvIHBhc3MgdG8gdGhlIGdpdCBwcm9jZXNzLiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIERldGVybWluZSB0aGUgYXBwcm9wcmlhdGUgdGltZW91dCBmb3IgYSBnaXQgc3ViY29tbWFuZC5cbiAqXG4gKiBNZXJnZSBhbmQgcmViYXNlIG9wZXJhdGlvbnMgZ2V0IGEgbG9uZ2VyIHRpbWVvdXQgYmVjYXVzZSB0aGV5IGludm9sdmUgbW9yZVxuICogY29tcHV0YXRpb24uIEFsbCBvdGhlciBvcGVyYXRpb25zIHVzZSB0aGUgZGVmYXVsdCBjb21tYW5kIHRpbWVvdXQuXG4gKlxuICogQHBhcmFtIGdpdFN1YmNvbW1hbmQgLSBUaGUgZmlyc3QgYXJndW1lbnQgdG8gZ2l0IChlLmcuLCBmZXRjaCwgcHVzaCwgbWVyZ2UpXG4gKiBAcmV0dXJucyBUaW1lb3V0IGR1cmF0aW9uIGluIHNlY29uZHNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFRpbWVvdXRGb3JPcGVyYXRpb24oZ2l0U3ViY29tbWFuZDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgZ2l0Q29tbWFuZFRpbWVvdXQgPSBOdW1iZXIoXG4gICAgRGVuby5lbnYuZ2V0KFwiR0lUX0NPTU1BTkRfVElNRU9VVFwiKSA/PyBERUZBVUxUX0dJVF9DT01NQU5EX1RJTUVPVVQsXG4gICk7XG4gIGNvbnN0IGdpdE1lcmdlVGltZW91dCA9IE51bWJlcihcbiAgICBEZW5vLmVudi5nZXQoXCJHSVRfTUVSR0VfVElNRU9VVFwiKSA/PyBERUZBVUxUX0dJVF9NRVJHRV9USU1FT1VULFxuICApO1xuXG4gIHN3aXRjaCAoZ2l0U3ViY29tbWFuZCkge1xuICAgIGNhc2UgXCJtZXJnZVwiOlxuICAgIGNhc2UgXCJyZWJhc2VcIjpcbiAgICBjYXNlIFwicHVsbFwiOlxuICAgICAgcmV0dXJuIGdpdE1lcmdlVGltZW91dDtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGdpdENvbW1hbmRUaW1lb3V0O1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYW4gZXhpdCBjb2RlIGluZGljYXRlcyBhIHRpbWVvdXQuXG4gKlxuICogQHBhcmFtIGV4aXRDb2RlIC0gVGhlIGV4aXQgY29kZSB0byBjaGVja1xuICogQHJldHVybnMgVHJ1ZSBpZiB0aGUgZXhpdCBjb2RlIGluZGljYXRlcyBhIHRpbWVvdXRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzR2l0VGltZW91dChleGl0Q29kZTogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiBleGl0Q29kZSA9PT0gVElNRU9VVF9FWElUX0NPREU7XG59XG5cbi8qKlxuICogUnVuIGEgZ2l0IGNvbW1hbmQgd2l0aCB0aW1lb3V0IHByb3RlY3Rpb24gdXNpbmcgQWJvcnRDb250cm9sbGVyLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnRzIHRvIHBhc3MgdG8gZ2l0IChlLmcuLCBbXCJmZXRjaFwiLCBcIm9yaWdpblwiXSlcbiAqIEBwYXJhbSBvcHRpb25zIC0gT3B0aW9ucyBmb3IgdGhlIGNvbW1hbmQgZXhlY3V0aW9uXG4gKiBAcmV0dXJucyBSZXN1bHQgY29udGFpbmluZyB0aGUgY29tbWFuZCBvdXRwdXQgb3IgYW4gZXJyb3JcbiAqL1xuLyoqXG4gKiBHaXQtYXV0aCByZXBhaXJzIHRoaXMgcHJvY2VzcyB3aWxsIHBlcmZvcm0gKElzc3VlICM1NjQpLlxuICpcbiAqIEJvdW5kZWQgZm9yIHRoZSBzYW1lIHJlYXNvbiBhcyB0aGUgYGdoYCByZS1zdGFnZTogYSBjcmVkZW50aWFsIHRoYXQga2VlcHNcbiAqIHZhbmlzaGluZyBpcyBhIGZhdWx0IHRvIHJlcG9ydCwgYW5kIGEgZ2VudWluZWx5IHJldm9rZWQgb25lIG11c3QgZmFpbFxuICogcmF0aGVyIHRoYW4gYmUgcmVidWlsdCBvbiBldmVyeSBjYWxsIGZvciB0aGUgcmVzdCBvZiB0aGUgcnVuLlxuICovXG5leHBvcnQgY29uc3QgTUFYX0dJVF9BVVRIX1JFUEFJUlMgPSAzO1xuXG5sZXQgZ2l0QXV0aFJlcGFpcnMgPSAwO1xuXG4vKiogUmVzZXQgdGhlIGdpdC1hdXRoIHJlcGFpciBidWRnZXQuIFRlc3RzIG9ubHkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRHaXRBdXRoUmVwYWlycygpOiB2b2lkIHtcbiAgZ2l0QXV0aFJlcGFpcnMgPSAwO1xufVxuXG4vKipcbiAqIFJlYnVpbGQgdGhlIGNyZWRlbnRpYWwgaGVscGVyLCBIVFRQUyB0cmFuc3BvcnQgYW5kIGlkZW50aXR5IGZyb20gdGhlIG1vdW50LlxuICpcbiAqIFdyaXRlcyB0aHJvdWdoIGBnaXQgY29uZmlnIC0tZ2xvYmFsYCwgc28gaXQgbGFuZHMgd2hlcmV2ZXJcbiAqIGBHSVRfQ09ORklHX0dMT0JBTGAgcG9pbnRzIOKAlCB0aGUgc3RhZ2VkIGNvcHkgdGhlIGNvbnRhaW5lciBvd25zLlxuICpcbiAqIEByZXR1cm5zIFRydWUgd2hlbiBzb21ldGhpbmcgd2FzIHdyaXR0ZW4gYW5kIGEgcmV0cnkgaXMgd29ydGggbWFraW5nLlxuICovXG5hc3luYyBmdW5jdGlvbiByZXBhaXJHaXRBdXRoRW52aXJvbm1lbnQoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIC8vIFRoZSBoZWxwZXIgc2hlbGxzIG91dCB0byBgZ2hgLCBzbyBpdHMgY29uZmlndXJhdGlvbiBoYXMgdG8gYmUgc291bmQgdG9vLlxuICBlbnN1cmVVc2FibGVHaENvbmZpZ0RpcigpO1xuXG4gIGNvbnN0IGhvbWUgPSBEZW5vLmVudi5nZXQoXCJIT01FXCIpID8/IFwiXCI7XG4gIGNvbnN0IGxvZ2luID0gbW91bnRlZEdpdExvZ2luKGhvbWUpO1xuICBsZXQgd3JvdGUgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBnaXRHbG9iYWxDb25maWdFbnRyaWVzKGxvZ2luKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb21tYW5kID0gbmV3IERlbm8uQ29tbWFuZChcImdpdFwiLCB7XG4gICAgICAgIGFyZ3M6IFtcImNvbmZpZ1wiLCAuLi5lbnRyeS5hcmdzXSxcbiAgICAgICAgc3Rkb3V0OiBcIm51bGxcIixcbiAgICAgICAgc3RkZXJyOiBcIm51bGxcIixcbiAgICAgIH0pO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29tbWFuZC5vdXRwdXQoKTtcbiAgICAgIGlmIChyZXN1bHQuY29kZSA9PT0gMCkgd3JvdGUgPSB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQmVzdC1lZmZvcnQ6IHRoZSBjYWxsZXIncyBvd24gZmFpbHVyZSBzdGF5cyB0aGUgbG91ZCBvbmUuXG4gICAgfVxuICB9XG4gIGlmICh3cm90ZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICBcIltTRUNVUklUWV0gZ2l0IGxvc3QgaXRzIGNyZWRlbnRpYWwgaGVscGVyIG9yIGlkZW50aXR5IOKAlCByZWJ1aWx0IGZyb20gXCIgK1xuICAgICAgICBcInRoZSByZWFkLW9ubHkgY3JlZGVudGlhbCBtb3VudCAoSXNzdWUgIzU2NClcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB3cm90ZTtcbn1cblxuLyoqXG4gKiBgc2FmZS5kaXJlY3RvcnlgIHJlcGFpcnMgdGhpcyBwcm9jZXNzIHdpbGwgYXR0ZW1wdCAoSXNzdWUgIzI4MjUpLCBib3VuZGVkXG4gKiBsaWtlIHRoZSBJc3N1ZSAjNTY0IGF1dGggcmVwYWlyLlxuICovXG5leHBvcnQgY29uc3QgTUFYX1NBRkVfRElSRUNUT1JZX1JFUEFJUlMgPSAzO1xuXG5sZXQgc2FmZURpcmVjdG9yeVJlcGFpcnMgPSAwO1xuXG4vKiogUmVzZXQgdGhlIGBzYWZlLmRpcmVjdG9yeWAgcmVwYWlyIGJ1ZGdldC4gVGVzdHMgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFNhZmVEaXJlY3RvcnlSZXBhaXJzKCk6IHZvaWQge1xuICBzYWZlRGlyZWN0b3J5UmVwYWlycyA9IDA7XG59XG5cbi8qKiBUcnVlIHdoZW4gYSBmaW5pc2hlZCBnaXQgY2FsbCB3YXMgcmVmdXNlZCBmb3IgZHViaW91cyBvd25lcnNoaXAuICovXG5leHBvcnQgZnVuY3Rpb24gaXNEdWJpb3VzT3duZXJzaGlwRmFpbHVyZShcbiAgcmVzdWx0OiB7IGNvZGU6IG51bWJlcjsgc3RkZXJyOiBzdHJpbmcgfSxcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gcmVzdWx0LmNvZGUgIT09IDAgJiZcbiAgICByZXN1bHQuc3RkZXJyLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJkZXRlY3RlZCBkdWJpb3VzIG93bmVyc2hpcFwiKTtcbn1cblxuLyoqXG4gKiBSZXN0b3JlIHRoZSBgc2FmZS5kaXJlY3RvcnkgPSAqYCBsaW5lIHRoZSBjb250YWluZXIgZW50cnlwb2ludCBzdGFnZXNcbiAqIChJc3N1ZSAjMjgyNSkuIFdpdGhvdXQgaXQgZ2l0IHJlZnVzZXMgdGhlIGNsb25lLCBhbmQgYGdpdCBjb25maWdgIHJlZnVzZXNcbiAqIHF1aWV0bHkg4oCUIGAtLWFkZGAgc2F5cyBvbmx5IFwibm90IGluIGEgZ2l0IGRpcmVjdG9yeVwiIOKAlCBzbyBzZXR1cCBkaWVkIGluIHRoZVxuICogZmlyc3QgbWludXRlLiBSdW5zIHdpdGggdGhlIGZhaWxlZCBjYWxsJ3MgYGVudmAsIHNvIGl0IHdyaXRlcyB3aGVyZXZlciB0aGF0XG4gKiBjYWxsJ3MgYEdJVF9DT05GSUdfR0xPQkFMYCBwb2ludHMuXG4gKlxuICogQHJldHVybnMgVHJ1ZSB3aGVuIHRoZSBsaW5lIHdhcyB3cml0dGVuIGFuZCBhIHJldHJ5IGlzIHdvcnRoIG1ha2luZy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVwYWlyU2FmZURpcmVjdG9yeShcbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoc2FmZURpcmVjdG9yeVJlcGFpcnMgPj0gTUFYX1NBRkVfRElSRUNUT1JZX1JFUEFJUlMpIHJldHVybiBmYWxzZTtcbiAgc2FmZURpcmVjdG9yeVJlcGFpcnMrKztcbiAgY29uc3QgY29uZmlnID0gKGFyZ3M6IHN0cmluZ1tdKSA9PlxuICAgIG5ldyBEZW5vLkNvbW1hbmQoXCJnaXRcIiwge1xuICAgICAgYXJnczogW1wiY29uZmlnXCIsIFwiLS1nbG9iYWxcIiwgLi4uYXJnc10sXG4gICAgICBlbnYsXG4gICAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICAgIHN0ZGVycjogXCJudWxsXCIsXG4gICAgfSkub3V0cHV0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoXG4gICAgICAoYXdhaXQgY29uZmlnKFtcIi0tZ2V0LWFsbFwiLCBcInNhZmUuZGlyZWN0b3J5XCJdKSkuc3Rkb3V0LFxuICAgICk7XG4gICAgLy8gQWxyZWFkeSBwcmVzZW50OiB0aGUgcmVwYWlyIGNhbm5vdCBoZWxwLCBzbyB0aGUgY2FsbGVyJ3MgZmFpbHVyZSBzdGFuZHMuXG4gICAgaWYgKGV4aXN0aW5nLnNwbGl0KFwiXFxuXCIpLnNvbWUoKGxpbmUpID0+IGxpbmUudHJpbSgpID09PSBcIipcIikpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoKGF3YWl0IGNvbmZpZyhbXCItLWFkZFwiLCBcInNhZmUuZGlyZWN0b3J5XCIsIFwiKlwiXSkpLmNvZGUgIT09IDApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEJlc3QtZWZmb3J0OiB0aGUgY2FsbGVyJ3Mgb3duIGR1YmlvdXMtb3duZXJzaGlwIGZhaWx1cmUgc3RheXMgbG91ZC5cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgY29uc29sZS5lcnJvcihcbiAgICBcIltTRUNVUklUWV0gZ2l0IHJlZnVzZWQgYSBjbG9uZSBhcyBkdWJpb3VzIG93bmVyc2hpcCDigJQgcmVzdG9yZWQgdGhlIFwiICtcbiAgICAgIFwic3RhZ2VkIHNhZmUuZGlyZWN0b3J5IGxpbmUgKElzc3VlICMyODI1KVwiLFxuICApO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBSZWFkZXIgdGhlIG1lc3NhZ2UgcmVkYWN0aW9uIHVzZXMgZm9yIGAtRiA8cGF0aD5gIGJvZGllcyAoSXNzdWUgIzEyODQpLlxuICpcbiAqIFRocm93cyB3aGVuIHRoZSBmaWxlIGNhbm5vdCBiZSByZWFkLCB3aGljaCB0aGUgY2FsbGVyIHR1cm5zIGludG8gYSBsb3VkXG4gKiByZWZ1c2FsIHJhdGhlciB0aGFuIGFuIHVuc2Nhbm5lZCBjb21taXQuXG4gKi9cbmZ1bmN0aW9uIHJlYWRNZXNzYWdlRmlsZVN5bmMocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIERlbm8ucmVhZFRleHRGaWxlU3luYyhwYXRoKTtcbn1cblxuLyoqXG4gKiBDYXB0dXJlIHRoZSBjb21taXRzIGEgc2luZ2xlIGV4cGxpY2l0IGJyYW5jaCBwdXNoIHdvdWxkIGFkZCB0byBpdHMgcmVtb3RlLlxuICogUmVhZCBhbiBleGlzdGluZyBkZXN0aW5hdGlvbiBmcm9tIHRoZSByZW1vdGUgaXRzZWxmLCBuZXZlciBhIHBvc3NpYmx5IHN0YWxlXG4gKiB0cmFja2luZyByZWYuIEZvciBhIG5ldyBkZXN0aW5hdGlvbiwgZXhjbHVkZSB0aGlzIHJlbW90ZSdzIHRyYWNrZWQgaGlzdG9yeS5cbiAqIFVuc3VwcG9ydGVkIHB1c2ggZm9ybXMgYW5kIHVuYXZhaWxhYmxlL3NoYWxsb3cgaGlzdG9yeSBsZWF2ZSBwcm92ZW5hbmNlIHVua25vd24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlUHVzaENvbW1pdHMoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmdbXSB8IHVuZGVmaW5lZD4ge1xuICBpZiAoYXJnc1swXSAhPT0gXCJwdXNoXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBvc2l0aW9uYWwgPSBhcmdzLnNsaWNlKDEpO1xuICB3aGlsZSAocG9zaXRpb25hbFswXSA9PT0gXCItdVwiIHx8IHBvc2l0aW9uYWxbMF0gPT09IFwiLS1zZXQtdXBzdHJlYW1cIikge1xuICAgIHBvc2l0aW9uYWwuc2hpZnQoKTtcbiAgfVxuICBpZiAocG9zaXRpb25hbFswXSA9PT0gXCItLWVuZC1vZi1vcHRpb25zXCIpIHBvc2l0aW9uYWwuc2hpZnQoKTtcbiAgaWYgKHBvc2l0aW9uYWwubGVuZ3RoICE9PSAyKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBbcmVtb3RlLCByZWZzcGVjXSA9IHBvc2l0aW9uYWw7XG4gIGlmICghcmVtb3RlIHx8ICFyZWZzcGVjKSByZXR1cm4gdW5kZWZpbmVkO1xuICAvLyBSZXN0cmljdCByb3V0aW5nIHRvIGV4cGxpY2l0IGJyYW5jaCBuYW1lczsgZmxhZ3MsIGRlbGV0aW9uLCBmb3JjZSxcbiAgLy8gbWF0Y2hpbmcvbXVsdGlwbGUgcmVmcyBhbmQgSEVBRCBzaG9ydGhhbmQgcmVtYWluIHVua25vd24uXG4gIGlmIChcbiAgICAhL15bQS1aYS16MC05XVtBLVphLXowLTkuXy8tXSokLy50ZXN0KHJlbW90ZSkgfHxcbiAgICAhL15bQS1aYS16MC05XVtBLVphLXowLTkuXy86LV0qJC8udGVzdChyZWZzcGVjKVxuICApIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnRzID0gcmVmc3BlYy5zcGxpdChcIjpcIik7XG4gIGlmIChwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+ICFwIHx8IHAgPT09IFwiSEVBRFwiKSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3QgW3NvdXJjZSwgZGVzdGluYXRpb24gPSBzb3VyY2VdID0gcGFydHM7XG4gIGlmICghc291cmNlIHx8ICFkZXN0aW5hdGlvbikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgYnJhbmNoID0gZGVzdGluYXRpb24uc3RhcnRzV2l0aChcInJlZnMvaGVhZHMvXCIpXG4gICAgPyBkZXN0aW5hdGlvblxuICAgIDogYHJlZnMvaGVhZHMvJHtkZXN0aW5hdGlvbn1gO1xuICBjb25zdCByZW1vdGVIZWFkID0gYXdhaXQgcnVuR2l0Q29tbWFuZChbXG4gICAgXCJscy1yZW1vdGVcIixcbiAgICBcIi0taGVhZHNcIixcbiAgICBcIi0tZW5kLW9mLW9wdGlvbnNcIixcbiAgICByZW1vdGUsXG4gICAgYnJhbmNoLFxuICBdLCBvcHRpb25zKTtcbiAgaWYgKCFyZW1vdGVIZWFkLm9rIHx8IHJlbW90ZUhlYWQudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbGluZXMgPSByZW1vdGVIZWFkLnZhbHVlLnN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pO1xuICBpZiAobGluZXMubGVuZ3RoID4gMSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgb2xkID0gbGluZXNbMF0/LnNwbGl0KC9cXHMrLylbMF07XG4gIGlmIChvbGQgIT09IHVuZGVmaW5lZCAmJiAhL15bMC05YS1mXXs0MH0oWzAtOWEtZl17MjR9KT8kLy50ZXN0KG9sZCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IHNoYWxsb3cgPSBhd2FpdCBydW5HaXRDb21tYW5kKFxuICAgIFtcInJldi1wYXJzZVwiLCBcIi0taXMtc2hhbGxvdy1yZXBvc2l0b3J5XCJdLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIGlmIChcbiAgICAhc2hhbGxvdy5vayB8fCBzaGFsbG93LnZhbHVlLmNvZGUgIT09IDAgfHxcbiAgICBzaGFsbG93LnZhbHVlLnN0ZG91dC50cmltKCkgIT09IFwiZmFsc2VcIlxuICApIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGNvbW1pdHMgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcbiAgICBcInJldi1saXN0XCIsXG4gICAgLy8gQSBuZXcgZGVzdGluYXRpb24gbXVzdCBub3Qgam91cm5hbCBoaXN0b3J5IGFscmVhZHkgb24gdGhpcyByZW1vdGUuXG4gICAgLi4uKG9sZCA/IFtdIDogW1wiLS1ub3RcIiwgYC0tcmVtb3Rlcz0ke3JlbW90ZX1gLCBcIi0tbm90XCJdKSxcbiAgICBcIi0tZW5kLW9mLW9wdGlvbnNcIixcbiAgICAuLi4ob2xkID8gW2Ake29sZH0uLiR7c291cmNlfWBdIDogW3NvdXJjZV0pLFxuICBdLCBvcHRpb25zKTtcbiAgaWYgKCFjb21taXRzLm9rIHx8IGNvbW1pdHMudmFsdWUuY29kZSAhPT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIGNvbW1pdHMudmFsdWUuc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HaXRDb21tYW5kKFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogR2l0Q29tbWFuZE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVzdWx0PEdpdENvbW1hbmRPdXRwdXQ+PiB7XG4gIGNvbnN0IGdpdFN1YmNvbW1hbmQgPSBhcmdzWzBdID8/IFwiXCI7XG4gIGNvbnN0IHRpbWVvdXRTZWNvbmRzID0gb3B0aW9ucy50aW1lb3V0U2Vjb25kcyA/P1xuICAgIGdldFRpbWVvdXRGb3JPcGVyYXRpb24oZ2l0U3ViY29tbWFuZCk7XG5cbiAgLy8gSXNzdWUgIzEyODQ6IG1hc2sgc2VjcmV0cyBpbiB0aGUgbWVzc2FnZSBhcmd1bWVudHMgYmVmb3JlIHRoZSBwcm9jZXNzXG4gIC8vIHN0YXJ0cy4gQSBwdXNoZWQgY29tbWl0IG1lc3NhZ2UgaXMgcGVybWFuZW50IHB1YmxpYyBoaXN0b3J5LCBzbyB0aGlzIGlzXG4gIC8vIHRoZSBnaXQgY291bnRlcnBhcnQgb2YgYHJlZGFjdEdoQm9keUFyZ3NgIGF0IHRoZSBgZ2hgIGNob2tlcG9pbnQuIE9ubHlcbiAgLy8gdGV4dC1jYXJyeWluZyBhcmd1bWVudHMgYXJlIHJld3JpdHRlbjsgcm91dGluZyBhcmd1bWVudHMgYXJlIHVudG91Y2hlZC5cbiAgLy8gTmFtZWQgZm9yIHRoZSBsb2cgbGluZXMgYmVsb3c6IGBhcmdzWzBdYCBpcyBgLUNgIGZvciBgZ2l0IC1DIC9yZXBvIGNvbW1pdGAuXG4gIGNvbnN0IHN1YmNvbW1hbmROYW1lID0gYXJnc1tnaXRTdWJjb21tYW5kSW5kZXgoYXJncyldID8/IGdpdFN1YmNvbW1hbmQ7XG4gIGxldCBlZmZlY3RpdmVBcmdzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBlZmZlY3RpdmVBcmdzID0gcmVkYWN0R2l0TWVzc2FnZUFyZ3MoYXJncywgcmVhZE1lc3NhZ2VGaWxlU3luYyk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKCEoZXJyb3IgaW5zdGFuY2VvZiBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICAvLyBGYWlsIGxvdWQgcmF0aGVyIHRoYW4gY29tbWl0IGEgbWVzc2FnZSBubyBjb250cm9sIGNvdWxkIHNjYW4uIFRoZVxuICAgIC8vIG1lc3NhZ2UgbmFtZXMgdGhlIHNvdXJjZSwgbmV2ZXIgdGhlIHVuc2Nhbm5lZCB0ZXh0LlxuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgW1NFQ1VSSVRZXSBbR0lUX01FU1NBR0VfVU5SRURBQ1RBQkxFXSByZWZ1c2luZyB0byBydW4gZ2l0IGAgK1xuICAgICAgICAgIGAke3N1YmNvbW1hbmROYW1lfTogJHtlcnJvci5tZXNzYWdlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbiAgaWYgKGVmZmVjdGl2ZUFyZ3Muc29tZSgoYXJnLCBpKSA9PiBhcmcgIT09IGFyZ3NbaV0pKSB7XG4gICAgY29uc29sZS5lcnJvcihcbiAgICAgIFwiW1NFQ1VSSVRZXSBbR0lUX01FU1NBR0VfUkVEQUNURURdIGEgc2VjcmV0IHdhcyBtYXNrZWQgaW4gdGhlIG1lc3NhZ2UgXCIgK1xuICAgICAgICBgb2YgdGhpcyBnaXQgJHtzdWJjb21tYW5kTmFtZX0gYmVmb3JlIGl0IHJlYWNoZWQgaGlzdG9yeSAoSXNzdWUgIzEyODQpYCxcbiAgICApO1xuICB9XG5cbiAgLy8gSXNzdWUgIzQyNDc6IHRoZSB0YWJsZSAob3IgdGhlIGNhbGxlcidzIG92ZXJyaWRlKSBpcyB0aGVuIGNsYW1wZWQgdG8gdGhlXG4gIC8vIHJ1biB0aW1lbGluZS4gUmVhZCBpdCBiZWZvcmUgYW55IGF3YWl0IHNvIGEgdGVzdCBjYW4gc2V0IHRoZSB0aW1lbGluZVxuICAvLyBmb3IgdGhpcyBjYWxsIG9ubHkuIEEgYnVkZ2V0IG9mIDAgb3IgbGVzcyB0aHJvd3MgYW5kIGRvZXMgbm90IHNwYXduLlxuICBjb25zdCBjb21tYW5kTGFiZWwgPSBzdWJwcm9jZXNzQ29tbWFuZExhYmVsKFwiZ2l0XCIsIGVmZmVjdGl2ZUFyZ3MpO1xuICBjb25zdCB0aW1lb3V0TXMgPSBjbGFtcFRpbWVvdXRUb1J1blRpbWVsaW5lKFxuICAgIHRpbWVvdXRTZWNvbmRzICogMTAwMCxcbiAgICBjb21tYW5kTGFiZWwsXG4gICk7XG4gIGNvbnN0IHJlcG9ydGVkU2Vjb25kcyA9IGZvcm1hdFRpbWVvdXRTZWNvbmRzKHRpbWVvdXRNcyk7XG5cbiAgLy8gQXVkaXQgdGhlIHNhbWUgZWZmZWN0aXZlIGVudmlyb25tZW50IGFzIHRoZSBjaGlsZCAoZW52IG92ZXJyaWRlcyBpbmhlcml0XG4gIC8vIGFsbCB1bnNwZWNpZmllZCBuYW1lcykuIFRoaXMgYWxzbyBrZWVwcyBpc29sYXRlZCBjYWxsZXJzIG9mZiBob3N0IGpvdXJuYWxzLlxuICBjb25zdCBhdWRpdEVudiA9IChrZXk6IHN0cmluZykgPT4gb3B0aW9ucy5lbnY/LltrZXldID8/IERlbm8uZW52LmdldChrZXkpO1xuICBjb25zdCBkZWxpdmVyZWRDb21taXRzID1cbiAgICBzdWJjb21tYW5kTmFtZSA9PT0gXCJwdXNoXCIgJiYgaXNBdWRpdEpvdXJuYWxFbmFibGVkKGF1ZGl0RW52KVxuICAgICAgPyBhd2FpdCBjYXB0dXJlUHVzaENvbW1pdHMoZWZmZWN0aXZlQXJncywgb3B0aW9ucylcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIHRpbWVvdXRNcyk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb21tYW5kID0gbmV3IERlbm8uQ29tbWFuZChcImdpdFwiLCB7XG4gICAgICBhcmdzOiBlZmZlY3RpdmVBcmdzLFxuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIGVudjogb3B0aW9ucy5lbnYsXG4gICAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgICAgc3RkaW46IFwibnVsbFwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2hpbGQgPSBjb21tYW5kLnNwYXduKCk7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IHdhaXRGb3JDaGlsZEV4aXQoXG4gICAgICBjaGlsZCxcbiAgICAgIGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgICAgY29tbWFuZExhYmVsLFxuICAgICk7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcblxuICAgIC8vIElzc3VlICMxMzc4OiBhIHRpbWVkLW91dCBjYWxsIHVzZWQgdG8gcmVzb2x2ZSB3aXRoIGdpdCdzIHNpZ25hbCBleGl0XG4gICAgLy8gY29kZSAoMTQzKSBhbmQgd2FzIHJlcG9ydGVkIGFzIGEgcGxhaW4gZmFpbHVyZSwgd2hpY2ggaGlkIGV2ZXJ5IHRpbWVvdXRcbiAgICAvLyBmcm9tIGBpc0dpdFRpbWVvdXRgLiBUaGUgYWJvcnQsIGluY2x1ZGluZyBhIGtpbGwgdGhhdCBkaWQgbm90IGZpbmlzaFxuICAgIC8vIGluc2lkZSB0aGUgZ3JhY2UsIGlzIGEgdGltZW91dC5cbiAgICBpZiAoXG4gICAgICBvdXRjb21lLmtpbmQgPT09IFwia2lsbC1pbmNvbXBsZXRlXCIgfHxcbiAgICAgIG91dGNvbWUua2luZCA9PT0gXCJhYm9ydGVkXCIgfHxcbiAgICAgIGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWRcbiAgICApIHtcbiAgICAgIGluY3JlbWVudENvdW50ZXIoXCJ0aW1lb3V0c1wiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIGNvZGU6IFRJTUVPVVRfRVhJVF9DT0RFLFxuICAgICAgICAgIHN0ZG91dDogXCJcIixcbiAgICAgICAgICBzdGRlcnI6IGBUSU1FT1VUOiBnaXQgJHtcbiAgICAgICAgICAgIGFyZ3Muam9pbihcIiBcIilcbiAgICAgICAgICB9IHRpbWVkIG91dCBhZnRlciAke3JlcG9ydGVkU2Vjb25kc31zIChJc3N1ZSAjNjE5KWAsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IHByb2Nlc3MgPSBvdXRjb21lLm91dHB1dDtcblxuICAgIGNvbnN0IHN0ZG91dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwcm9jZXNzLnN0ZG91dCk7XG4gICAgY29uc3Qgc3RkZXJyID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHByb2Nlc3Muc3RkZXJyKTtcblxuICAgIC8vIElzc3VlICMyMjk6IGEgZmlsZXN5c3RlbS1sZXZlbCBmYWlsdXJlIGluIGdpdCdzIG91dHB1dCBpcyBhIGhvc3RcbiAgICAvLyBmYXVsdCwgbm90IHRoaXMgY2FsbCdzIOKAlCByZWNvcmQgaXQgb25jZSBzbyB0aGUgY2xhaW0gZ3VhcmRzIHN0b3AgbmV3XG4gICAgLy8gd29yayBvbiB0aGUgYnJva2VuIHZvbHVtZS5cbiAgICBpZiAocHJvY2Vzcy5jb2RlICE9PSAwKSB7XG4gICAgICBub3RlR2l0T3V0cHV0Rm9yVm9sdW1lRmF1bHQoZWZmZWN0aXZlQXJncywgc3RkZXJyLCBzdGRvdXQpO1xuICAgIH1cblxuICAgIC8vIElzc3VlICM1NjQ6IGdpdCBsb3N0IGl0cyBjcmVkZW50aWFsIGhlbHBlciBhbmQgaWRlbnRpdHkgbWlkLXJ1biB3aGlsZVxuICAgIC8vIGBnaGAgc3RpbGwgd29ya2VkIOKAlCB0aGUgc3RhZ2VkIGdsb2JhbCBjb25maWcgaGFkIGJlZW4gcmVkdWNlZCB0byBpdHNcbiAgICAvLyBgc2FmZS5kaXJlY3RvcnlgIGxpbmUuIFJlYnVpbGQgYm90aCBmcm9tIHRoZSByZWFkLW9ubHkgbW91bnQgYW5kIHJldHJ5XG4gICAgLy8gb25jZS4gQSBjYWxsIHRoYXQgZmFpbGVkIGZvciB3YW50IG9mIGNyZWRlbnRpYWxzIGRpZCBub3RoaW5nLCBzbyB0aGVcbiAgICAvLyByZXRyeSBpcyBzYWZlLCBhbmQgZXZlcnkgZ2l0IGNhbGxlciBpbmhlcml0cyB0aGUgcmVjb3ZlcnkuXG4gICAgaWYgKFxuICAgICAgaXNHaXRBdXRoTWlzc2luZ0ZhaWx1cmUoeyBjb2RlOiBwcm9jZXNzLmNvZGUsIHN0ZGVyciB9KSAmJlxuICAgICAgZ2l0QXV0aFJlcGFpcnMgPCBNQVhfR0lUX0FVVEhfUkVQQUlSU1xuICAgICkge1xuICAgICAgZ2l0QXV0aFJlcGFpcnMrKztcbiAgICAgIGlmIChhd2FpdCByZXBhaXJHaXRBdXRoRW52aXJvbm1lbnQoKSkge1xuICAgICAgICBjb25zdCByZXRyeSA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoYXJncywgb3B0aW9ucyk7XG4gICAgICAgIGlmIChyZXRyeS5vaykge1xuICAgICAgICAgIHJldHVybiByZXRyeTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIElzc3VlICMyODI1OiBnaXQgcmVmdXNlZCB0aGUgY2xvbmUgYXMgZHViaW91cyBvd25lcnNoaXAgYmVjYXVzZSB0aGVcbiAgICAvLyBzdGFnZWQgYHNhZmUuZGlyZWN0b3J5YCBsaW5lIHdlbnQgbWlzc2luZy4gQSByZWZ1c2VkIGNhbGwgZGlkIG5vdGhpbmcsXG4gICAgLy8gc28gcmVzdG9yaW5nIHRoZSBsaW5lIGFuZCByZXRyeWluZyBvbmNlIGlzIHNhZmUuXG4gICAgaWYgKFxuICAgICAgaXNEdWJpb3VzT3duZXJzaGlwRmFpbHVyZSh7IGNvZGU6IHByb2Nlc3MuY29kZSwgc3RkZXJyIH0pICYmXG4gICAgICBhd2FpdCByZXBhaXJTYWZlRGlyZWN0b3J5KG9wdGlvbnMuZW52KVxuICAgICkge1xuICAgICAgcmV0dXJuIGF3YWl0IHJ1bkdpdENvbW1hbmQoYXJncywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLy8gSXNzdWUgIzIzODA6IGpvdXJuYWwgYGdpdCBwdXNoYCBtdXRhdGlvbnMgdG8gdGhlIGF1ZGl0IGxvZy5cbiAgICAvLyBCZXN0LWVmZm9ydCDigJQgbmV2ZXIgbGV0cyBqb3VybmFsbGluZyBhbHRlciBvciBhYm9ydCB0aGUgZ2l0IGNhbGwuXG4gICAgYXdhaXQgYXVkaXRHaXRNdXRhdGlvbihlZmZlY3RpdmVBcmdzLCBwcm9jZXNzLmNvZGUsIHtcbiAgICAgIGVudjogYXVkaXRFbnYsXG4gICAgICBkZWxpdmVyZWRDb21taXRzLFxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHsgY29kZTogcHJvY2Vzcy5jb2RlLCBzdGRvdXQsIHN0ZGVyciB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcblxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiBlcnJvci5uYW1lID09PSBcIkFib3J0RXJyb3JcIikge1xuICAgICAgaW5jcmVtZW50Q291bnRlcihcInRpbWVvdXRzXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgY29kZTogVElNRU9VVF9FWElUX0NPREUsXG4gICAgICAgICAgc3Rkb3V0OiBcIlwiLFxuICAgICAgICAgIHN0ZGVycjogYFRJTUVPVVQ6IGdpdCAke1xuICAgICAgICAgICAgZWZmZWN0aXZlQXJncy5qb2luKFwiIFwiKVxuICAgICAgICAgIH0gdGltZWQgb3V0IGFmdGVyICR7cmVwb3J0ZWRTZWNvbmRzfXMgKElzc3VlICM2MTkpYCxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBGYWlsZWQgdG8gZXhlY3V0ZSBnaXQgJHtlZmZlY3RpdmVBcmdzLmpvaW4oXCIgXCIpfTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBSdW4gYSBnaXQgY29tbWFuZCBhbmQgcmV0dXJuIHN1Y2Nlc3MvZmFpbHVyZSBiYXNlZCBvbiBleGl0IGNvZGUuXG4gKlxuICogQ29udmVuaWVuY2Ugd3JhcHBlciBhcm91bmQgcnVuR2l0Q29tbWFuZCB0aGF0IGNoZWNrcyB0aGUgZXhpdCBjb2RlLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnRzIHRvIHBhc3MgdG8gZ2l0XG4gKiBAcGFyYW0gb3B0aW9ucyAtIE9wdGlvbnMgZm9yIHRoZSBjb21tYW5kIGV4ZWN1dGlvblxuICogQHJldHVybnMgUmVzdWx0IHdpdGggc3Rkb3V0IG9uIHN1Y2Nlc3MsIGVycm9yIG1lc3NhZ2Ugb24gZmFpbHVyZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuR2l0Q29tbWFuZENoZWNrZWQoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKGFyZ3MsIG9wdGlvbnMpO1xuXG4gIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIGNvbnN0IHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIgfSA9IHJlc3VsdC52YWx1ZTtcblxuICBpZiAoY29kZSAhPT0gMCkge1xuICAgIGlmIChpc0dpdFRpbWVvdXQoY29kZSkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgVElNRU9VVDogZ2l0ICR7YXJncy5qb2luKFwiIFwiKX0gdGltZWQgb3V0IChJc3N1ZSAjNjE5KWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYGdpdCAke2FyZ3Muam9pbihcIiBcIil9IGZhaWxlZCAoZXhpdCBjb2RlICR7Y29kZX0pOiAke1xuICAgICAgICAgIHN0ZGVyci50cmltKCkgfHwgc3Rkb3V0LnRyaW0oKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogc3Rkb3V0IH07XG59XG5cbi8qKiBPdXRwdXQgb2YgYSBmdWxsLWFyZ3YgZ2l0IGNhbGwsIGFzIHRoZSB3b3JrZXIncyBhcmd2IHJ1bm5lcnMgcmVwb3J0IGl0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRBcmd2T3V0cHV0IHtcbiAgLyoqIFRydWUgd2hlbiBnaXQgZXhpdGVkIHplcm8uICovXG4gIHN1Y2Nlc3M6IGJvb2xlYW47XG4gIC8qKiBUcmltbWVkIHN0YW5kYXJkIG91dHB1dC4gKi9cbiAgc3Rkb3V0OiBzdHJpbmc7XG4gIC8qKiBUcmltbWVkIHN0YW5kYXJkIGVycm9yLCBvciB0aGUgcmVmdXNhbCB0aGF0IHN0b3BwZWQgdGhlIGNhbGwuICovXG4gIHN0ZGVycjogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJ1biBhIGZ1bGwgYGdpdCDigKZgIGFyZ3Yg4oCUIGJpbmFyeSBpbmNsdWRlZCDigJQgdGhyb3VnaCB0aGUgY2hva2Vwb2ludFxuICogKElzc3VlICMxNTUzKS5cbiAqXG4gKiBUaGUgd29ya2VyJ3MgZ2VuZXJpYyBwYXNzLXRocm91Z2ggcnVubmVycyBhcmUgaGFuZGVkIGFuIGFyZ3Ygd2hvc2UgaGVhZCBpc1xuICogdGhlIGJpbmFyeSAoYFtcImdpdFwiLCBcIi1DXCIsIGRpciwgXCJwdXNoXCIsIOKApl1gKSwgb2Z0ZW4gYnVpbHQgaW4gYSBkaWZmZXJlbnRcbiAqIG1vZHVsZS4gYHJ1bkdpdENvbW1hbmRgIHRha2VzIHRoZSBhcmd1bWVudHMgKmFmdGVyKiB0aGUgYmluYXJ5LCBzbyBlYWNoXG4gKiBydW5uZXIgaGFkIHRvIHN0cmlwIHRoZSBoZWFkIGl0c2VsZjsgbm9uZSBkaWQsIGFuZCB0aGV5IHNwYXduZWQgZ2l0XG4gKiBkaXJlY3RseSBpbnN0ZWFkIOKAlCBvdXRzaWRlIHRoZSB0aW1lb3V0LCB0aGUgYXVkaXQgam91cm5hbCBhbmQgdGhlXG4gKiB3b3JrLXZvbHVtZSBmYXVsdCBkZXRlY3Rvci4gVGhpcyBhZGFwdGVyIGlzIHRoZSBvbmUtbGluZSBkZWxlZ2F0aW9uIHRob3NlXG4gKiBydW5uZXJzIHVzZSwgc28gdGhlIGhlYWQtc3RyaXBwaW5nIGlzIHdyaXR0ZW4gb25jZSByYXRoZXIgdGhhbiBwZXIgY2FsbGVyLlxuICpcbiAqIEEgYFJlc3VsdGAgZXJyb3IgKGEgcmVkYWN0aW9uIHJlZnVzYWwsIGEgc3Bhd24gZmFpbHVyZSkgaXMgcmVwb3J0ZWQgYXMgYW5cbiAqIHVuc3VjY2Vzc2Z1bCBjYWxsIGNhcnJ5aW5nIHRoZSBtZXNzYWdlLCBuZXZlciBzd2FsbG93ZWQuXG4gKlxuICogQHBhcmFtIGFyZ3YgLSBGdWxsIGFyZ3Ygd2l0aCBgZ2l0YCBhcyBpdHMgaGVhZDsgYSBtaXNzaW5nIGhlYWQgaXMgZmluZSwgdGhlXG4gKiAgIHJlbWFpbmRlciBpcyBzdGlsbCByb3V0ZWQuXG4gKiBAcGFyYW0gb3B0aW9ucyAtIFNhbWUgb3B0aW9ucyBhcyB7QGxpbmsgcnVuR2l0Q29tbWFuZH0uXG4gKiBAcmV0dXJucyBTdWNjZXNzIHBsdXMgdGhlIHRyaW1tZWQgc3RyZWFtcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkdpdEFyZ3YoXG4gIGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaXRDb21tYW5kT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxHaXRBcmd2T3V0cHV0PiB7XG4gIGNvbnN0IGFyZ3MgPSBhcmd2WzBdID09PSBcImdpdFwiID8gYXJndi5zbGljZSgxKSA6IFsuLi5hcmd2XTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuR2l0Q29tbWFuZChhcmdzLCBvcHRpb25zKTtcbiAgaWYgKCFyZXN1bHQub2spIHtcbiAgICByZXR1cm4geyBzdWNjZXNzOiBmYWxzZSwgc3Rkb3V0OiBcIlwiLCBzdGRlcnI6IHJlc3VsdC5lcnJvci5tZXNzYWdlIH07XG4gIH1cbiAgY29uc3QgeyBjb2RlLCBzdGRvdXQsIHN0ZGVyciB9ID0gcmVzdWx0LnZhbHVlO1xuICByZXR1cm4geyBzdWNjZXNzOiBjb2RlID09PSAwLCBzdGRvdXQ6IHN0ZG91dC50cmltKCksIHN0ZGVycjogc3RkZXJyLnRyaW0oKSB9O1xufVxuXG4vKipcbiAqIFN5bmNocm9ub3VzIGxvY2FsIGdpdCByZWFkIChJc3N1ZSAjNDEyMCkuXG4gKlxuICogVGhlIHBvc3QtcnVuIGNhbGxiYWNrIGNvbnRleHQgaXMgYnVpbHQgc3luY2hyb25vdXNseSwgc28gdGhhdCByZWFkIGNhbm5vdFxuICogYXdhaXQge0BsaW5rIHJ1bkdpdENvbW1hbmR9LiBUaGUgc3Bhd24gc3RheXMgaW4gdGhpcyBtb2R1bGUsIHdoaWNoIGlzIHRoZVxuICogb25seSBmaWxlIGFsbG93ZWQgdG8gc3RhcnQgYGdpdGAgKElzc3VlICMxMjE0KS4gYG91dHB1dFN5bmNgIGNhbm5vdCB0YWtlXG4gKiB0aGUgQWJvcnRDb250cm9sbGVyIHRpbWVvdXQgdGhlIGFzeW5jIHBhdGggdXNlcywgc28gdGhpcyBpcyBmb3IgbG9jYWxcbiAqIG1ldGFkYXRhIChgZGVzY3JpYmVgLCBgcmV2LXBhcnNlYCksIG5vdCBmb3IgYSBnaXQgY2FsbCB0aGF0IHRhbGtzIHRvIGFcbiAqIHJlbW90ZS5cbiAqXG4gKiBBIGZpbmlzaGVkIHByb2Nlc3MgaXMgcmV0dXJuZWQgZXZlbiB3aGVuIGdpdCBleGl0cyBub24temVyby4gQSBzcGF3biB0aGF0XG4gKiBjYW5ub3Qgc3RhcnQgdGhyb3dzLCBpbmNsdWRpbmcgYE5vdENhcGFibGVgIGFuZCBgTm90Rm91bmRgLiBBbiB1bnJlYWRhYmxlXG4gKiBjb21taXQgbWVzc2FnZSB0aHJvd3Mge0BsaW5rIFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcn0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5HaXRSZWFkU3luYyhcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IFBpY2s8R2l0Q29tbWFuZE9wdGlvbnMsIFwiY3dkXCIgfCBcImVudlwiPiA9IHt9LFxuKTogR2l0Q29tbWFuZE91dHB1dCB7XG4gIGNvbnN0IGVmZmVjdGl2ZUFyZ3MgPSByZWRhY3RHaXRNZXNzYWdlQXJncyhhcmdzLCByZWFkTWVzc2FnZUZpbGVTeW5jKTtcbiAgY29uc3QgcHJvY2VzcyA9IG5ldyBEZW5vLkNvbW1hbmQoXCJnaXRcIiwge1xuICAgIGFyZ3M6IGVmZmVjdGl2ZUFyZ3MsXG4gICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICBlbnY6IG9wdGlvbnMuZW52LFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICB9KS5vdXRwdXRTeW5jKCk7XG4gIGNvbnN0IHN0ZG91dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwcm9jZXNzLnN0ZG91dCk7XG4gIGNvbnN0IHN0ZGVyciA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShwcm9jZXNzLnN0ZGVycik7XG4gIGlmIChwcm9jZXNzLmNvZGUgIT09IDApIHtcbiAgICBub3RlR2l0T3V0cHV0Rm9yVm9sdW1lRmF1bHQoZWZmZWN0aXZlQXJncywgc3RkZXJyLCBzdGRvdXQpO1xuICB9XG4gIHJldHVybiB7IGNvZGU6IHByb2Nlc3MuY29kZSwgc3Rkb3V0LCBzdGRlcnIgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7OztDQVVDLEdBR0QsU0FDRSx1QkFBdUIsRUFDdkIsc0JBQXNCLEVBQ3RCLHVCQUF1QixFQUN2QixlQUFlLFFBQ1YsMkJBQTJCO0FBQ2xDLFNBQVMsZ0JBQWdCLFFBQVEsZ0NBQWdDO0FBQ2pFLFNBQVMsZ0JBQWdCLEVBQUUscUJBQXFCLFFBQVEsa0JBQWtCO0FBQzFFLFNBQ0Usa0JBQWtCLEVBQ2xCLG9CQUFvQixFQUNwQix3QkFBd0IsUUFDbkIsNkJBQTZCO0FBRXBDLDREQUE0RCxHQUM1RCxNQUFNLDhCQUE4QjtBQUVwQyxpRUFBaUUsR0FDakUsTUFBTSw0QkFBNEI7QUFFbEMsdURBQXVELEdBQ3ZELFNBQVMsMkJBQTJCLFFBQVEseUJBQXlCO0FBQ3JFLFNBQ0UseUJBQXlCLEVBQ3pCLG9CQUFvQixFQUNwQixzQkFBc0IsRUFDdEIsZ0JBQWdCLFFBQ1gsMEJBQTBCO0FBRWpDLE9BQU8sTUFBTSxvQkFBb0IsSUFBSTtBQXNCckM7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLFNBQVMsdUJBQXVCLGFBQXFCO0VBQzFELE1BQU0sb0JBQW9CLE9BQ3hCLEtBQUssR0FBRyxDQUFDLEdBQUcsQ0FBQywwQkFBMEI7RUFFekMsTUFBTSxrQkFBa0IsT0FDdEIsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLHdCQUF3QjtFQUd2QyxPQUFRO0lBQ04sS0FBSztJQUNMLEtBQUs7SUFDTCxLQUFLO01BQ0gsT0FBTztJQUNUO01BQ0UsT0FBTztFQUNYO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxhQUFhLFFBQWdCO0VBQzNDLE9BQU8sYUFBYTtBQUN0QjtBQUVB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
// denoCacheMetadata=6057737747173855342,4251521230008562013