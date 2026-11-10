/**
 * The single `gh` subprocess chokepoint for the worker process (Issue #3703).
 *
 * `write_repo_allowlist.ts` documents `runGhCommandRaw` as the one place every
 * worker `gh` write flows through, but ~20 modules spawned `gh` with their own
 * `new Deno.Command("gh", …)`, so remote branch deletion, PR merge, issue
 * close and branch-protection rewrites skipped both the write-repo allowlist
 * and the audit journal. This module is that chokepoint made real: it is the
 * only place in `worker/deno/` permitted to spawn `gh`, and it always
 *
 *   1. enforces the per-run write-repo allowlist (`enforceGhWriteAllowlist`)
 *      *before* the process starts,
 *   2. refuses retargeting a milestone PR's base branch
 *      (`enforcePrBaseChangeGuard`, Issue #3433), then
 *   3. redacts secrets from the published body arguments
 *      (`redactGhBodyArgs`, Issue #3707), then
 *   4. journals the mutation to the tamper-evident audit log
 *      (`auditGhMutation`) once the exit code is known, and
 *   5. notes an issue close/reopen (`noteGhIssueClose`, Issue #181) so the
 *      stale scan-cache entries are dropped and the run never re-claims an
 *      issue it just closed.
 *
 * A quality-gate check (`gh_spawn_chokepoint_check.ts`) fails the build on any
 * direct `new Deno.Command("gh", …)` outside this file, so the invariant
 * cannot silently rot again.
 *
 * ```mermaid
 * flowchart LR
 *     C["~20 caller modules"] --> S["spawnGh()"]
 *     S --> A["enforceGhWriteAllowlist<br/>(allowlist, fail closed)"]
 *     A -->|allowed| B["enforcePrBaseChangeGuard<br/>(milestone base, fail closed)"]
 *     B -->|allowed| R["redactGhBodyArgs<br/>(public body args)"]
 *     B -->|refused| E
 *     R --> P["gh subprocess"]
 *     A -->|refused| E["throw — no subprocess"]
 *     P --> J["auditGhMutation<br/>(audit journal)"]
 *     J --> N["noteGhIssueClose<br/>(cache + run registry)"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { getGhTokenForSubprocess } from "./github_app_auth.ts";
import { ensureUsableGhConfigDir, isGhAuthMissingFailure, MAX_RESTAGE_ATTEMPTS } from "./gh_credential_stage.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { enforceGhWriteAllowlist, installationTokenRepoScope } from "./write_repo_allowlist.ts";
import { enforcePrBaseChangeGuard } from "./pr_base_change_guard.ts";
import { auditGhMutation } from "./audit_hook.ts";
import { redactGhBodyArgs, redactGhBodyText } from "./gh_body_redaction.ts";
// The same reader/writer pair the agent's guard child supplies (Issue #1254),
// so the two chokepoints cannot drift on which body classes get scanned.
import { bodyFileWriterIn, denoBodyFileReader } from "./gh_body_file_io.ts";
import { noteGhIssueClose } from "./issue_close_notifier.ts";
import { recordGhCall } from "./gh_call_metrics.ts";
import { isPrimaryQuotaLatched, isPrimaryRateLimitMessage, isQuotaExemptGhCall, primaryQuotaSkipMessage } from "./primary_quota_latch.ts";
import { isSecondaryOnlyRateLimitMessage } from "./secondary_rate_limit.ts";
import { getGhTimeoutForOperation, GH_TIMEOUT_EXIT_CODE } from "./gh_timeout.ts";
import { clampTimeoutToRunTimeline, formatTimeoutSeconds, subprocessCommandLabel, waitForChildExit } from "./subprocess_timeout.ts";
import { getRunTimeline } from "./run_timeline.ts";
let quotaExhaustionHook = null;
/**
 * Install the rate-limit hook the chokepoint calls on the first refusal
 * (Issue #1540). `github.ts` registers the production one at module load.
 */ export function setPrimaryQuotaExhaustionHook(hook) {
  quotaExhaustionHook = hook;
}
/**
 * Build the environment for a `gh` subprocess.
 *
 * When GitHub App authentication is configured, injects `GH_TOKEN` for this
 * subprocess only (Issue #959); otherwise returns `undefined` so the process
 * inherits ambient OAuth auth.
 *
 * The token is minted **scoped to the run's write-repo allowlist**
 * (Issue #1391) — the credential handed to the subprocess cannot reach a repo
 * this run may not write to, so a write that gets past
 * `enforceGhWriteAllowlist` is still refused by GitHub. Before a run seeds an
 * allowlist the scope is `null` and the token keeps the installation's full
 * reach, matching the allowlist's own fail-open-until-seeded rule.
 */ export async function buildGhEnv() {
  const token = await mintRunScopedGhToken();
  if (!token) return undefined;
  const env = {
    ...Deno.env.toObject()
  };
  env["GH_TOKEN"] = token;
  return env;
}
/**
 * Mint an installation token scoped to the run's write-repo allowlist.
 *
 * The one place that decides how a run-scoped credential is obtained, shared
 * by {@link buildGhEnv} (the worker's own `gh` calls) and
 * {@link withRunScopedGhToken} (the coding agent's). Two copies of this would
 * be two scopes to keep in step, and the one that drifted would be the one
 * handed to the agent.
 */ export function mintRunScopedGhToken() {
  return getGhTokenForSubprocess(Deno.env.get("GITHUB_APP_ID"), Deno.env.get("GITHUB_APP_INSTALLATION_ID"), Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH"), undefined, installationTokenRepoScope());
}
/**
 * Overlay a run-scoped `GH_TOKEN` onto an ALREADY-SANITISED child environment
 * (Issue #1423).
 *
 * The write-repo allowlist defends in two layers: the argv classifier refuses
 * an off-allowlist write before `gh` is spawned, and — since Issue #1391 —
 * the credential itself cannot reach beyond the run's scope, so a write that
 * gets past the classifier is still refused by GitHub. The second layer
 * existed only for the worker's own calls. The coding agent's `gh` runs
 * through the PATH shim (`gh_guard_shim.ts`) and never reached
 * {@link buildGhEnv}, so it authenticated with whatever ambient credential
 * was staged for the container — the installation's full reach. For the one
 * component driven by untrusted issue and comment text, only layer one
 * applied.
 *
 * This is deliberately NOT `buildGhEnv` (Issue #1423). That function builds
 * its environment from `Deno.env.toObject()` — the worker's WHOLE
 * environment, `GITHUB_APP_PRIVATE_KEY_PATH` among it. Handing that to the
 * agent would undo every exclusion `agent_env.ts`/`claude_env.ts` make and
 * put the PEM that mints installation tokens in reach of a prompt-injected
 * shell: a far worse leak than the scoping gap being closed. So the caller's
 * sanitised environment is the base, and exactly one value is overlaid onto
 * it.
 *
 * `GITHUB_TOKEN` is overwritten when the base carries one, because `gh`
 * accepts it as an alternative name: leaving the ambient value in place would
 * park an unscoped credential beside the scoped one.
 *
 * Degrades rather than breaks. A host with no GitHub App configured mints
 * nothing, and the environment is returned untouched so the agent keeps the
 * ambient auth it has always used — the same fallback `buildGhEnv`'s callers
 * make.
 *
 * Residual risk, recorded rather than hidden: the credential
 * `gh_credential_stage.ts` stages into `GH_CONFIG_DIR`'s `hosts.yml` is still
 * on disk and still unscoped. `gh` prefers `GH_TOKEN`, so the guarded path
 * gets the scoped credential, but a process that reads that file directly
 * does not. Removing it from the agent's reach is a mount-and-staging change,
 * tracked separately.
 *
 * @param baseEnv - The sanitised child environment, secrets already dropped.
 * @param mint - How to obtain the token; defaults to
 *   {@link mintRunScopedGhToken}.
 * @returns The environment with the scoped credential overlaid, or `baseEnv`
 *   unchanged when no token could be minted.
 */ export async function withRunScopedGhToken(baseEnv, mint = mintRunScopedGhToken) {
  const token = await mint();
  if (!token) return baseEnv;
  const scoped = {
    ...baseEnv,
    GH_TOKEN: token
  };
  if ("GITHUB_TOKEN" in baseEnv) scoped["GITHUB_TOKEN"] = token;
  return scoped;
}
/**
 * Decode a finished command's output into a {@link GhSpawnResult}.
 *
 * Deno's `CommandOutput.stdout`/`.stderr` getters THROW when the stream was
 * opened with `"null"` (Issue #3748), so a discarded stream must never be
 * read — it decodes to `""` per the `GhSpawnResult` contract.
 */ function decodeOutput(output, options) {
  const decoder = new TextDecoder();
  return {
    code: output.code,
    success: output.code === 0,
    stdout: (options.stdout ?? "piped") === "piped" ? decoder.decode(output.stdout) : "",
    stderr: (options.stderr ?? "piped") === "piped" ? decoder.decode(output.stderr) : ""
  };
}
/**
 * The budget `spawnGh` will enforce, or undefined when the caller owns the
 * abort via `signal` and no timeline is set.
 *
 * Synchronous: the timeline is read here, before `spawnGh` awaits, so a test
 * can install a timeline for this call and clear it before the first yield.
 */ export function resolveGhSpawnBudget(args, options) {
  const command = subprocessCommandLabel("gh", args);
  if (options.timeoutMs !== undefined) {
    return clampTimeoutToRunTimeline(options.timeoutMs, command);
  }
  if (options.signal) {
    if (getRunTimeline() === undefined) return undefined;
    // No numeric budget of our own. A finite clamp is the timeline's cap;
    // a non-finite result means no hard kill is known past the finish, so
    // the caller's signal stays the only abort and wrap-up still runs.
    const clamped = clampTimeoutToRunTimeline(Number.POSITIVE_INFINITY, command);
    return Number.isFinite(clamped) ? clamped : undefined;
  }
  return clampTimeoutToRunTimeline(getGhTimeoutForOperation(args) * 1000, command);
}
/** A timed-out `gh` call, as exit 124. A timeout is a failure. */ function ghTimedOut(command, timeoutMs) {
  return {
    code: GH_TIMEOUT_EXIT_CODE,
    success: false,
    stdout: "",
    stderr: `TIMEOUT: ${command} timed out after ${formatTimeoutSeconds(timeoutMs)}s`
  };
}
/** Production runner — the only `gh` spawn in the worker process. */ const productionRunner = async (args, options)=>{
  const baseEnv = await buildGhEnv();
  const env = options.env ? {
    ...baseEnv ?? Deno.env.toObject(),
    ...options.env
  } : baseEnv;
  const commandLabel = subprocessCommandLabel("gh", args);
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const onCallerAbort = ()=>{
    callerAborted = true;
    controller.abort();
  };
  let timer;
  if (options.signal) {
    if (options.signal.aborted) onCallerAbort();
    else {
      options.signal.addEventListener("abort", onCallerAbort, {
        once: true
      });
    }
  }
  try {
    if (callerAborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (options.timeoutMs !== undefined && !(options.timeoutMs > 0)) {
      return ghTimedOut(commandLabel, options.timeoutMs);
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(()=>{
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    }
    const command = new Deno.Command("gh", {
      args: [
        ...args
      ],
      stdin: options.stdin !== undefined ? "piped" : "null",
      stdout: options.stdout ?? "piped",
      stderr: options.stderr ?? "piped",
      ...options.cwd ? {
        cwd: options.cwd
      } : {},
      ...env ? {
        env
      } : {}
    });
    const child = command.spawn();
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    const outcome = await waitForChildExit(child, controller.signal, commandLabel);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "kill-incomplete") {
      return ghTimedOut(commandLabel, options.timeoutMs ?? 0);
    }
    if (timedOut || outcome.kind === "aborted") {
      if (callerAborted && !timedOut) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return ghTimedOut(commandLabel, options.timeoutMs ?? 0);
    }
    if (controller.signal.aborted) {
      if (callerAborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return ghTimedOut(commandLabel, options.timeoutMs ?? 0);
    }
    if (outcome.kind !== "output") {
      return ghTimedOut(commandLabel, options.timeoutMs ?? 0);
    }
    return decodeOutput(outcome.output, options);
  } finally{
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
};
let runner = productionRunner;
/**
 * Re-stagings this process has performed (Issue #564).
 *
 * Bounded by {@link MAX_RESTAGE_ATTEMPTS}: a credential that keeps vanishing
 * is a fault to report, and a revoked token must fail rather than re-stage on
 * every call for the rest of the run.
 */ let restageAttempts = 0;
/** Reset the re-stage budget. Tests only. */ export function resetGhRestageAttempts() {
  restageAttempts = 0;
}
/**
 * The retry's options, with any explicit `GH_CONFIG_DIR` refreshed.
 *
 * Callers that pin the directory per call (`setup/*`, the escalation paths)
 * would otherwise retry against the same broken copy the re-stage replaced.
 */ function withStagedGhConfigDir(options, hostEnv) {
  if (options.env?.GH_CONFIG_DIR === undefined) return options;
  const staged = hostEnv("GH_CONFIG_DIR");
  if (staged === undefined) return options;
  return {
    ...options,
    env: {
      ...options.env,
      GH_CONFIG_DIR: staged
    }
  };
}
/** Read the PR's head and base for the base-change guard; throws on failure. */ async function lookupPrHeadAndBase(change, options) {
  const result = await spawnGh([
    "pr",
    "view",
    ...change.prSelector ? [
      change.prSelector
    ] : [],
    ...change.repo ? [
      "--repo",
      change.repo
    ] : [],
    "--json",
    "headRefName,baseRefName"
  ], {
    ...options.cwd ? {
      cwd: options.cwd
    } : {},
    ...options.env ? {
      env: options.env
    } : {},
    ...options.hostEnv ? {
      hostEnv: options.hostEnv
    } : {},
    ...options.bypassQuotaLatch ? {
      bypassQuotaLatch: true
    } : {}
  });
  if (!result.success) {
    throw new Error(`gh pr view failed (exit ${result.code})`);
  }
  const doc = JSON.parse(result.stdout);
  if (typeof doc.headRefName !== "string" || typeof doc.baseRefName !== "string") {
    throw new Error("gh pr view returned no head/base");
  }
  return {
    headRefName: doc.headRefName,
    baseRefName: doc.baseRefName
  };
}
/**
 * Run `gh` through the worker's chokepoint.
 *
 * Enforces the write-repo allowlist before the process starts (so a refused
 * write never reaches GitHub) and journals the mutation afterwards. Never
 * throws on a non-zero exit — inspect {@link GhSpawnResult.success}.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @param options - Subprocess options.
 * @throws WriteRepoBlockedError | WriteTargetUndeterminableError when the
 *   write is refused by the allowlist.
 * @throws PrBaseChangeRefusedError when a PR base change is refused.
 */ export async function spawnGh(args, options = {}) {
  // Before the first await, so the timeline read is synchronous (Issue #4247).
  const budgetMs = resolveGhSpawnBudget(args, options);
  const timedOptions = budgetMs === undefined ? options : {
    ...options,
    timeoutMs: budgetMs
  };
  await enforceGhWriteAllowlist(args);
  // Issue #3433: a base change must not move a milestone PR off its milestone
  // branch. The lookup is a `pr view` read, so it cannot recurse into the guard.
  await enforcePrBaseChangeGuard(args, {
    lookup: (change)=>lookupPrHeadAndBase(change, options),
    readBodyFile: denoBodyFileReader,
    log: (line)=>console.error(line)
  });
  // Issue #42 / #1485: once the primary GraphQL quota is exhausted, every
  // further GraphQL-backed call in the window is guaranteed to fail. The
  // short-circuit used to live in `runGhCommandRaw` alone, so the thirty-odd
  // modules that call this chokepoint directly kept spawning doomed `gh`
  // processes after the latch had fired. It lives here now, at the one
  // place every `gh` spawn passes — before the spawn and before the
  // telemetry — and a REST `gh api <path>` still rides the core quota.
  if (!options.bypassQuotaLatch && !isQuotaExemptGhCall(args) && isPrimaryQuotaLatched()) {
    return {
      code: 1,
      success: false,
      stdout: "",
      stderr: primaryQuotaSkipMessage()
    };
  }
  // Issue #1671 / #1485: per-iteration `gh` call telemetry, recorded at the
  // chokepoint so every invocation — from any module — is counted exactly
  // once per attempt.
  recordGhCall(args);
  // Mask secrets in the published body arguments (Issue #3707) — the last
  // point before a comment or PR body leaves the worker for GitHub.
  //
  // The reader and writer are the same pair the agent's guard child supplies
  // (Issue #1254): without them this call passed argv alone, so a
  // `--body-file` / `-F <path>` / `--input <file>` body was neither scanned
  // nor refused, and a module switching from `--body` to `--body-file` would
  // have published unscanned while looking like a refactor.
  //
  // Issue #1364: a masked `--input` copy needs a directory that owns it. The
  // guard child cannot clean up — it exits before its `gh` child reads the
  // file — but this chokepoint awaits the child, so it can, and does, in the
  // `finally` below. The directory is created only when a body is actually
  // masked, so an ordinary call does no filesystem work.
  let maskedBodyDir;
  const writeMaskedBody = (content)=>{
    maskedBodyDir ??= Deno.makeTempDirSync({
      prefix: "gh-spawn-body-"
    });
    return bodyFileWriterIn(maskedBodyDir)(content);
  };
  const stdinScanned = options.stdin !== undefined;
  const redacted = redactGhBodyArgs(args, denoBodyFileReader, writeMaskedBody, stdinScanned);
  // Issue #1421: `gh api --input -` carries its body on STDIN, where there is
  // no argument to rewrite — so it never passed through the mask above. The
  // module doc promises every public sink inherits redaction by construction;
  // that was true of the argv route only. Latent rather than live today (no
  // production caller supplies stdin), which is exactly why it should be
  // closed now rather than when one appears.
  const withStdin = options.stdin === undefined ? timedOptions : {
    ...timedOptions,
    stdin: redactGhBodyText(options.stdin)
  };
  const spawnOptions = budgetMs === undefined ? withStdin : {
    ...withStdin,
    timeoutMs: budgetMs
  };
  try {
    let result = await runner(redacted, spawnOptions);
    // Issue #564: a call that failed for want of authentication did nothing,
    // so retrying it is safe — and the credential is very likely recoverable.
    // The writable copy of `hosts.yml` went missing mid-run once already and
    // every later call failed with the intact original still on its mount.
    // Rebuild from the mount and try once more, here at the chokepoint, so
    // every gh caller in the worker inherits the recovery.
    if (isGhAuthMissingFailure(result) && restageAttempts < MAX_RESTAGE_ATTEMPTS) {
      restageAttempts++;
      const hostEnv = options.hostEnv ?? processEnvLookup;
      const staging = {
        env: hostEnv,
        ...options.setHostEnv ? {
          setEnv: options.setHostEnv
        } : {}
      };
      if (ensureUsableGhConfigDir(staging)) {
        // The retry is a second real `gh` process against the same quota.
        recordGhCall(args);
        result = await runner(redacted, withStagedGhConfigDir(spawnOptions, hostEnv));
      }
    }
    // Issue #1540: the refusal is recognised here, where it is seen, and
    // handed to the registered hook, which latches and writes the shared
    // signal. The hook probes only when the response may be primary quota;
    // a primary refusal from the quota probe must not recurse. A secondary
    // refusal needs no probe, so it also latches when the probe sees it first.
    if (!result.success && !isQuotaExemptGhCall(args) && quotaExhaustionHook !== null && (!options.bypassQuotaLatch && isPrimaryRateLimitMessage(result.stderr) || isSecondaryOnlyRateLimitMessage(result.stderr, isPrimaryRateLimitMessage))) {
      try {
        await quotaExhaustionHook({
          args,
          stderr: result.stderr,
          ...options.workDir !== undefined ? {
            workDir: options.workDir
          } : {}
        });
      } catch  {
      // Best-effort bookkeeping: the caller still sees its own failure.
      }
    }
    // Best-effort — never lets journalling alter or abort the gh call.
    await auditGhMutation(args, result.code);
    // Issue #181: a close the worker just performed invalidates the scan-cache
    // entries that still describe the issue as open, and marks it finished for
    // the rest of the run so no slot re-claims it. Also best-effort.
    await noteGhIssueClose(args, result.code);
    return result;
  } finally{
    // The `gh` child has exited by the time the call above resolves, so the
    // masked copy it read is safe to remove (Issue #1364). Best-effort: a
    // cleanup failure must never turn a completed `gh` call into a thrown one.
    if (maskedBodyDir !== undefined) {
      try {
        Deno.removeSync(maskedBodyDir, {
          recursive: true
        });
      } catch  {
      // Nothing to do — the directory is under TMPDIR either way.
      }
    }
  }
}
/**
 * Run `gh` through the chokepoint and return stdout, throwing on failure.
 *
 * The convenience form used by the callers that previously had their own
 * `defaultGhCommand`.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @param options - Subprocess options.
 * @returns Decoded stdout.
 * @throws Error on a non-zero exit, carrying the exit code and stderr.
 */ export async function runGhOrThrow(args, options = {}) {
  const { code, success, stdout, stderr } = await spawnGh(args, options);
  if (!success) {
    throw new Error(`gh command failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}
/** Replace the low-level runner. Test-only. */ export function _setGhSpawnRunner(fn) {
  runner = fn;
}
/** Restore the production runner. Test-only. */ export function _resetGhSpawnRunner() {
  runner = productionRunner;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9zcGF3bi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBzaW5nbGUgYGdoYCBzdWJwcm9jZXNzIGNob2tlcG9pbnQgZm9yIHRoZSB3b3JrZXIgcHJvY2VzcyAoSXNzdWUgIzM3MDMpLlxuICpcbiAqIGB3cml0ZV9yZXBvX2FsbG93bGlzdC50c2AgZG9jdW1lbnRzIGBydW5HaENvbW1hbmRSYXdgIGFzIHRoZSBvbmUgcGxhY2UgZXZlcnlcbiAqIHdvcmtlciBgZ2hgIHdyaXRlIGZsb3dzIHRocm91Z2gsIGJ1dCB+MjAgbW9kdWxlcyBzcGF3bmVkIGBnaGAgd2l0aCB0aGVpciBvd25cbiAqIGBuZXcgRGVuby5Db21tYW5kKFwiZ2hcIiwg4oCmKWAsIHNvIHJlbW90ZSBicmFuY2ggZGVsZXRpb24sIFBSIG1lcmdlLCBpc3N1ZVxuICogY2xvc2UgYW5kIGJyYW5jaC1wcm90ZWN0aW9uIHJld3JpdGVzIHNraXBwZWQgYm90aCB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3RcbiAqIGFuZCB0aGUgYXVkaXQgam91cm5hbC4gVGhpcyBtb2R1bGUgaXMgdGhhdCBjaG9rZXBvaW50IG1hZGUgcmVhbDogaXQgaXMgdGhlXG4gKiBvbmx5IHBsYWNlIGluIGB3b3JrZXIvZGVuby9gIHBlcm1pdHRlZCB0byBzcGF3biBgZ2hgLCBhbmQgaXQgYWx3YXlzXG4gKlxuICogICAxLiBlbmZvcmNlcyB0aGUgcGVyLXJ1biB3cml0ZS1yZXBvIGFsbG93bGlzdCAoYGVuZm9yY2VHaFdyaXRlQWxsb3dsaXN0YClcbiAqICAgICAgKmJlZm9yZSogdGhlIHByb2Nlc3Mgc3RhcnRzLFxuICogICAyLiByZWZ1c2VzIHJldGFyZ2V0aW5nIGEgbWlsZXN0b25lIFBSJ3MgYmFzZSBicmFuY2hcbiAqICAgICAgKGBlbmZvcmNlUHJCYXNlQ2hhbmdlR3VhcmRgLCBJc3N1ZSAjMzQzMyksIHRoZW5cbiAqICAgMy4gcmVkYWN0cyBzZWNyZXRzIGZyb20gdGhlIHB1Ymxpc2hlZCBib2R5IGFyZ3VtZW50c1xuICogICAgICAoYHJlZGFjdEdoQm9keUFyZ3NgLCBJc3N1ZSAjMzcwNyksIHRoZW5cbiAqICAgNC4gam91cm5hbHMgdGhlIG11dGF0aW9uIHRvIHRoZSB0YW1wZXItZXZpZGVudCBhdWRpdCBsb2dcbiAqICAgICAgKGBhdWRpdEdoTXV0YXRpb25gKSBvbmNlIHRoZSBleGl0IGNvZGUgaXMga25vd24sIGFuZFxuICogICA1LiBub3RlcyBhbiBpc3N1ZSBjbG9zZS9yZW9wZW4gKGBub3RlR2hJc3N1ZUNsb3NlYCwgSXNzdWUgIzE4MSkgc28gdGhlXG4gKiAgICAgIHN0YWxlIHNjYW4tY2FjaGUgZW50cmllcyBhcmUgZHJvcHBlZCBhbmQgdGhlIHJ1biBuZXZlciByZS1jbGFpbXMgYW5cbiAqICAgICAgaXNzdWUgaXQganVzdCBjbG9zZWQuXG4gKlxuICogQSBxdWFsaXR5LWdhdGUgY2hlY2sgKGBnaF9zcGF3bl9jaG9rZXBvaW50X2NoZWNrLnRzYCkgZmFpbHMgdGhlIGJ1aWxkIG9uIGFueVxuICogZGlyZWN0IGBuZXcgRGVuby5Db21tYW5kKFwiZ2hcIiwg4oCmKWAgb3V0c2lkZSB0aGlzIGZpbGUsIHNvIHRoZSBpbnZhcmlhbnRcbiAqIGNhbm5vdCBzaWxlbnRseSByb3QgYWdhaW4uXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgQ1tcIn4yMCBjYWxsZXIgbW9kdWxlc1wiXSAtLT4gU1tcInNwYXduR2goKVwiXVxuICogICAgIFMgLS0+IEFbXCJlbmZvcmNlR2hXcml0ZUFsbG93bGlzdDxici8+KGFsbG93bGlzdCwgZmFpbCBjbG9zZWQpXCJdXG4gKiAgICAgQSAtLT58YWxsb3dlZHwgQltcImVuZm9yY2VQckJhc2VDaGFuZ2VHdWFyZDxici8+KG1pbGVzdG9uZSBiYXNlLCBmYWlsIGNsb3NlZClcIl1cbiAqICAgICBCIC0tPnxhbGxvd2VkfCBSW1wicmVkYWN0R2hCb2R5QXJnczxici8+KHB1YmxpYyBib2R5IGFyZ3MpXCJdXG4gKiAgICAgQiAtLT58cmVmdXNlZHwgRVxuICogICAgIFIgLS0+IFBbXCJnaCBzdWJwcm9jZXNzXCJdXG4gKiAgICAgQSAtLT58cmVmdXNlZHwgRVtcInRocm93IOKAlCBubyBzdWJwcm9jZXNzXCJdXG4gKiAgICAgUCAtLT4gSltcImF1ZGl0R2hNdXRhdGlvbjxici8+KGF1ZGl0IGpvdXJuYWwpXCJdXG4gKiAgICAgSiAtLT4gTltcIm5vdGVHaElzc3VlQ2xvc2U8YnIvPihjYWNoZSArIHJ1biByZWdpc3RyeSlcIl1cbiAqIGBgYFxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGdldEdoVG9rZW5Gb3JTdWJwcm9jZXNzIH0gZnJvbSBcIi4vZ2l0aHViX2FwcF9hdXRoLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEVuc3VyZUdoQ29uZmlnRGlyT3B0aW9ucyxcbiAgZW5zdXJlVXNhYmxlR2hDb25maWdEaXIsXG4gIGlzR2hBdXRoTWlzc2luZ0ZhaWx1cmUsXG4gIE1BWF9SRVNUQUdFX0FUVEVNUFRTLFxufSBmcm9tIFwiLi9naF9jcmVkZW50aWFsX3N0YWdlLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7XG4gIGVuZm9yY2VHaFdyaXRlQWxsb3dsaXN0LFxuICBpbnN0YWxsYXRpb25Ub2tlblJlcG9TY29wZSxcbn0gZnJvbSBcIi4vd3JpdGVfcmVwb19hbGxvd2xpc3QudHNcIjtcbmltcG9ydCB7XG4gIGVuZm9yY2VQckJhc2VDaGFuZ2VHdWFyZCxcbiAgdHlwZSBQckJhc2VDaGFuZ2UsXG59IGZyb20gXCIuL3ByX2Jhc2VfY2hhbmdlX2d1YXJkLnRzXCI7XG5pbXBvcnQgeyBhdWRpdEdoTXV0YXRpb24gfSBmcm9tIFwiLi9hdWRpdF9ob29rLnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEJvZHlGaWxlV3JpdGVyLFxuICByZWRhY3RHaEJvZHlBcmdzLFxuICByZWRhY3RHaEJvZHlUZXh0LFxufSBmcm9tIFwiLi9naF9ib2R5X3JlZGFjdGlvbi50c1wiO1xuLy8gVGhlIHNhbWUgcmVhZGVyL3dyaXRlciBwYWlyIHRoZSBhZ2VudCdzIGd1YXJkIGNoaWxkIHN1cHBsaWVzIChJc3N1ZSAjMTI1NCksXG4vLyBzbyB0aGUgdHdvIGNob2tlcG9pbnRzIGNhbm5vdCBkcmlmdCBvbiB3aGljaCBib2R5IGNsYXNzZXMgZ2V0IHNjYW5uZWQuXG5pbXBvcnQgeyBib2R5RmlsZVdyaXRlckluLCBkZW5vQm9keUZpbGVSZWFkZXIgfSBmcm9tIFwiLi9naF9ib2R5X2ZpbGVfaW8udHNcIjtcbmltcG9ydCB7IG5vdGVHaElzc3VlQ2xvc2UgfSBmcm9tIFwiLi9pc3N1ZV9jbG9zZV9ub3RpZmllci50c1wiO1xuaW1wb3J0IHsgcmVjb3JkR2hDYWxsIH0gZnJvbSBcIi4vZ2hfY2FsbF9tZXRyaWNzLnRzXCI7XG5pbXBvcnQge1xuICBpc1ByaW1hcnlRdW90YUxhdGNoZWQsXG4gIGlzUHJpbWFyeVJhdGVMaW1pdE1lc3NhZ2UsXG4gIGlzUXVvdGFFeGVtcHRHaENhbGwsXG4gIHByaW1hcnlRdW90YVNraXBNZXNzYWdlLFxufSBmcm9tIFwiLi9wcmltYXJ5X3F1b3RhX2xhdGNoLnRzXCI7XG5pbXBvcnQgeyBpc1NlY29uZGFyeU9ubHlSYXRlTGltaXRNZXNzYWdlIH0gZnJvbSBcIi4vc2Vjb25kYXJ5X3JhdGVfbGltaXQudHNcIjtcbmltcG9ydCB7XG4gIGdldEdoVGltZW91dEZvck9wZXJhdGlvbixcbiAgR0hfVElNRU9VVF9FWElUX0NPREUsXG59IGZyb20gXCIuL2doX3RpbWVvdXQudHNcIjtcbmltcG9ydCB7XG4gIGNsYW1wVGltZW91dFRvUnVuVGltZWxpbmUsXG4gIGZvcm1hdFRpbWVvdXRTZWNvbmRzLFxuICBzdWJwcm9jZXNzQ29tbWFuZExhYmVsLFxuICB3YWl0Rm9yQ2hpbGRFeGl0LFxufSBmcm9tIFwiLi9zdWJwcm9jZXNzX3RpbWVvdXQudHNcIjtcbmltcG9ydCB7IGdldFJ1blRpbWVsaW5lIH0gZnJvbSBcIi4vcnVuX3RpbWVsaW5lLnRzXCI7XG5cbi8qKiBPcHRpb25zIGZvciBhIHNpbmdsZSBgZ2hgIGludm9jYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEdoU3Bhd25PcHRpb25zIHtcbiAgLyoqIFRleHQgcGlwZWQgdG8gdGhlIHByb2Nlc3MncyBzdGRpbiAoZm9yIGBnaCBhcGkgLS1pbnB1dCAtYCkuICovXG4gIHN0ZGluPzogc3RyaW5nO1xuICAvKiogQ2FwdHVyZSBzdGRvdXQgKGRlZmF1bHQpIG9yIGRpc2NhcmQgaXQuICovXG4gIHN0ZG91dD86IFwicGlwZWRcIiB8IFwibnVsbFwiO1xuICAvKiogQ2FwdHVyZSBzdGRlcnIgKGRlZmF1bHQpIG9yIGRpc2NhcmQgaXQuICovXG4gIHN0ZGVycj86IFwicGlwZWRcIiB8IFwibnVsbFwiO1xuICAvKiogV29ya2luZyBkaXJlY3RvcnkgZm9yIHRoZSBzdWJwcm9jZXNzLiAqL1xuICBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBFeHRyYSBlbnZpcm9ubWVudCB2YXJpYWJsZXMsIG1lcmdlZCBvdmVyIHRoZSByZXNvbHZlZCBgZ2hgIGVudmlyb25tZW50LiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAvKiogQWJvcnQgc2lnbmFsIOKAlCB1c2VkIGJ5IHRoZSB0aW1lb3V0IHdyYXBwZXIgaW4gYGdoX3dyYXBwZXIudHNgLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEJ1ZGdldCBpbiBtaWxsaXNlY29uZHMuIFdoZW4gb21pdHRlZCwgYW5kIHtAbGluayBzaWduYWx9IGlzIGFsc28gb21pdHRlZCxcbiAgICogdGhlIGNob2tlcG9pbnQgYXBwbGllcyB7QGxpbmsgZ2V0R2hUaW1lb3V0Rm9yT3BlcmF0aW9ufS4gRWl0aGVyIHdheSB0aGVcbiAgICogYnVkZ2V0IGlzIGNsYW1wZWQgdG8gdGhlIHJ1biB0aW1lbGluZSAoSXNzdWUgIzQyNDcpLlxuICAgKi9cbiAgdGltZW91dE1zPzogbnVtYmVyO1xuICAvKipcbiAgICogSG9zdCByb290cyB0aGUgY3JlZGVudGlhbCByZS1zdGFnZSByZWFkcyAoSXNzdWUgIzk2Nykg4oCUIGBHSF9DT05GSUdfRElSYCxcbiAgICogYEhPTUVgLCBgVklCRV9TVEFURV9ESVJgLCBgVklCRV9TQ1JBVENIX0RJUmAgYW5kIGBUTVBESVJgLiBEZWZhdWx0cyB0byB0aGVcbiAgICogcHJvY2VzcyBlbnZpcm9ubWVudCwgc28gcHJvZHVjdGlvbiBjYWxsZXJzIHBhc3Mgbm90aGluZzsgYSB0ZXN0IGhhbmRzIGluIGFcbiAgICogZml4ZWQgbWFwIHJhdGhlciB0aGFuIG1vdmluZyB0aGUgcm9vdHMgZXZlcnkgcGFyYWxsZWwgd29ya2VyIHNoYXJlcy5cbiAgICpcbiAgICogVW5yZWxhdGVkIHRvIHtAbGluayBHaFNwYXduT3B0aW9ucy5lbnZ9LCB3aGljaCBpcyB0aGUgc3VicHJvY2VzcydzIG93blxuICAgKiBlbnZpcm9ubWVudC5cbiAgICovXG4gIGhvc3RFbnY/OiBFbnZMb29rdXA7XG4gIC8qKlxuICAgKiBFc3RhYmxpc2hlcyB0aGUgcmUtc3RhZ2VkIGBHSF9DT05GSUdfRElSYCBpbiB0aGUgcnVuIGVudmlyb25tZW50O1xuICAgKiBkZWZhdWx0cyB0byBgRGVuby5lbnYuc2V0YCwgd2hpY2ggaXMgd2hhdCBldmVyeSBsYXRlciBgZ2hgIGFuZCBgZ2l0YFxuICAgKiBjaGlsZCBpbmhlcml0cy5cbiAgICovXG4gIHNldEhvc3RFbnY/OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PiB2b2lkO1xuICAvKipcbiAgICogUnVuIGV2ZW4gd2hpbGUgdGhlIHByaW1hcnkgR3JhcGhRTCBxdW90YSBpcyBsYXRjaGVkIChJc3N1ZSAjMTQ4NSkuXG4gICAqIE9ubHkgdGhlIHF1b3RhIHByb2JlIHRoYXQgbGVhcm5zIHRoZSByZXNldCBtYXkgc2V0IHRoaXMg4oCUIGl0IGlzIHRoZVxuICAgKiBvbmUgR3JhcGhRTCBjYWxsIHRoYXQgbGlmdHMgdGhlIGxhdGNoIHJhdGhlciB0aGFuIGJ1cm5pbmcgYWdhaW5zdCBpdC5cbiAgICovXG4gIGJ5cGFzc1F1b3RhTGF0Y2g/OiBib29sZWFuO1xuICAvKipcbiAgICogV2hlcmUgdGhlIHNoYXJlZCByYXRlLWxpbWl0IHNpZ25hbCBpcyB3cml0dGVuIHdoZW4gdGhpcyBjYWxsIGRpc2NvdmVycyBhXG4gICAqIEdyYXBoUUwgcHJpbWFyeS1xdW90YSBvciBzZWNvbmRhcnktbGltaXQgcmVmdXNhbCAoSXNzdWUgIzE1NDApLiBEZWZhdWx0cyB0b1xuICAgKiB0aGUgYFdPUktfRElSYCB0aGUgcnVuIGRyaXZlciBleHBvcnRzOyBgcnVuR2hDb21tYW5kUmF3YCB0aHJlYWRzIGl0cyBvd25cbiAgICogb3ZlcnJpZGUgdGhyb3VnaCBoZXJlLlxuICAgKi9cbiAgd29ya0Rpcj86IHN0cmluZztcbn1cblxuLyoqXG4gKiBXaGF0IHRoZSBjaG9rZXBvaW50IHJlcG9ydHMgd2hlbiBhIEdyYXBoUUwtYmFja2VkIGNhbGwgaXMgcmVmdXNlZCBmb3IgYVxuICogcHJpbWFyeSBxdW90YSBvciBzZWNvbmRhcnkgbGltaXQgKElzc3VlICMxNTQwKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcmltYXJ5UXVvdGFSZWZ1c2FsIHtcbiAgLyoqIFRoZSBgZ2hgIGFyZ3VtZW50cyB0aGF0IHdlcmUgcmVmdXNlZC4gKi9cbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcmVmdXNhbCBhcyBgZ2hgIHByaW50ZWQgaXQuICovXG4gIHN0ZGVycjogc3RyaW5nO1xuICAvKiogVGhlIGNhbGxlcidzIHNpZ25hbCBkaXJlY3Rvcnkgb3ZlcnJpZGUsIHdoZW4gaXQgZ2F2ZSBvbmUuICovXG4gIHdvcmtEaXI/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVnaXN0ZXJlZCBieSBgZ2l0aHViLnRzYCBhdCBsb2FkOiBjbGFzc2lmaWVzIHF1b3RhIHJlZnVzYWxzLCBwcm9iZXMgdGhlXG4gKiBwcmltYXJ5IHJlc2V0IHdoZW4gbmVlZGVkLCBsYXRjaGVzIHRoZSBwcm9jZXNzIGFuZCB3cml0ZXMgdGhlIHNoYXJlZCBzaWduYWxcbiAqIChJc3N1ZSAjNDIpLiBBIGhvb2sgcmF0aGVyIHRoYW4gYW5cbiAqIGltcG9ydCBiZWNhdXNlIGBnaXRodWIudHNgIGltcG9ydHMgdGhpcyBtb2R1bGUuIE51bGwgdW50aWwgcmVnaXN0ZXJlZCwgc29cbiAqIGEgdG9vbCBvciB0ZXN0IHRoYXQgbmV2ZXIgbG9hZHMgYGdpdGh1Yi50c2Agc3Bhd25zIGV4YWN0bHkgYXMgYmVmb3JlLlxuICovXG5leHBvcnQgdHlwZSBQcmltYXJ5UXVvdGFFeGhhdXN0aW9uSG9vayA9IChcbiAgcmVmdXNhbDogUHJpbWFyeVF1b3RhUmVmdXNhbCxcbikgPT4gUHJvbWlzZTx2b2lkPjtcblxubGV0IHF1b3RhRXhoYXVzdGlvbkhvb2s6IFByaW1hcnlRdW90YUV4aGF1c3Rpb25Ib29rIHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogSW5zdGFsbCB0aGUgcmF0ZS1saW1pdCBob29rIHRoZSBjaG9rZXBvaW50IGNhbGxzIG9uIHRoZSBmaXJzdCByZWZ1c2FsXG4gKiAoSXNzdWUgIzE1NDApLiBgZ2l0aHViLnRzYCByZWdpc3RlcnMgdGhlIHByb2R1Y3Rpb24gb25lIGF0IG1vZHVsZSBsb2FkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UHJpbWFyeVF1b3RhRXhoYXVzdGlvbkhvb2soXG4gIGhvb2s6IFByaW1hcnlRdW90YUV4aGF1c3Rpb25Ib29rIHwgbnVsbCxcbik6IHZvaWQge1xuICBxdW90YUV4aGF1c3Rpb25Ib29rID0gaG9vaztcbn1cblxuLyoqIE91dGNvbWUgb2YgYSBgZ2hgIGludm9jYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIEdoU3Bhd25SZXN1bHQge1xuICAvKiogUHJvY2VzcyBleGl0IGNvZGUuICovXG4gIGNvZGU6IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgdGhlIHByb2Nlc3MgZXhpdGVkIHplcm8uICovXG4gIHN1Y2Nlc3M6IGJvb2xlYW47XG4gIC8qKiBEZWNvZGVkIHN0ZG91dCAoZW1wdHkgd2hlbiBkaXNjYXJkZWQpLiAqL1xuICBzdGRvdXQ6IHN0cmluZztcbiAgLyoqIERlY29kZWQgc3RkZXJyIChlbXB0eSB3aGVuIGRpc2NhcmRlZCkuICovXG4gIHN0ZGVycjogc3RyaW5nO1xufVxuXG4vKiogVGhlIGxvdy1sZXZlbCBydW5uZXIg4oCUIHJlcGxhY2VhYmxlIGluIHRlc3RzIHZpYSB7QGxpbmsgX3NldEdoU3Bhd25SdW5uZXJ9LiAqL1xuZXhwb3J0IHR5cGUgR2hTcGF3blJ1bm5lciA9IChcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIG9wdGlvbnM6IEdoU3Bhd25PcHRpb25zLFxuKSA9PiBQcm9taXNlPEdoU3Bhd25SZXN1bHQ+O1xuXG4vKipcbiAqIEJ1aWxkIHRoZSBlbnZpcm9ubWVudCBmb3IgYSBgZ2hgIHN1YnByb2Nlc3MuXG4gKlxuICogV2hlbiBHaXRIdWIgQXBwIGF1dGhlbnRpY2F0aW9uIGlzIGNvbmZpZ3VyZWQsIGluamVjdHMgYEdIX1RPS0VOYCBmb3IgdGhpc1xuICogc3VicHJvY2VzcyBvbmx5IChJc3N1ZSAjOTU5KTsgb3RoZXJ3aXNlIHJldHVybnMgYHVuZGVmaW5lZGAgc28gdGhlIHByb2Nlc3NcbiAqIGluaGVyaXRzIGFtYmllbnQgT0F1dGggYXV0aC5cbiAqXG4gKiBUaGUgdG9rZW4gaXMgbWludGVkICoqc2NvcGVkIHRvIHRoZSBydW4ncyB3cml0ZS1yZXBvIGFsbG93bGlzdCoqXG4gKiAoSXNzdWUgIzEzOTEpIOKAlCB0aGUgY3JlZGVudGlhbCBoYW5kZWQgdG8gdGhlIHN1YnByb2Nlc3MgY2Fubm90IHJlYWNoIGEgcmVwb1xuICogdGhpcyBydW4gbWF5IG5vdCB3cml0ZSB0bywgc28gYSB3cml0ZSB0aGF0IGdldHMgcGFzdFxuICogYGVuZm9yY2VHaFdyaXRlQWxsb3dsaXN0YCBpcyBzdGlsbCByZWZ1c2VkIGJ5IEdpdEh1Yi4gQmVmb3JlIGEgcnVuIHNlZWRzIGFuXG4gKiBhbGxvd2xpc3QgdGhlIHNjb3BlIGlzIGBudWxsYCBhbmQgdGhlIHRva2VuIGtlZXBzIHRoZSBpbnN0YWxsYXRpb24ncyBmdWxsXG4gKiByZWFjaCwgbWF0Y2hpbmcgdGhlIGFsbG93bGlzdCdzIG93biBmYWlsLW9wZW4tdW50aWwtc2VlZGVkIHJ1bGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEdoRW52KCk6IFByb21pc2U8XG4gIFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWRcbj4ge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IG1pbnRSdW5TY29wZWRHaFRva2VuKCk7XG4gIGlmICghdG9rZW4pIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi5EZW5vLmVudi50b09iamVjdCgpIH07XG4gIGVudltcIkdIX1RPS0VOXCJdID0gdG9rZW47XG4gIHJldHVybiBlbnY7XG59XG5cbi8qKiBNaW50cyB0aGUgY3JlZGVudGlhbCBhIHN1YnByb2Nlc3MgYXV0aGVudGljYXRlcyB3aXRoLiBJbmplY3RhYmxlIGZvciB0ZXN0cy4gKi9cbmV4cG9ydCB0eXBlIEdoVG9rZW5NaW50ZXIgPSAoKSA9PiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD47XG5cbi8qKlxuICogTWludCBhbiBpbnN0YWxsYXRpb24gdG9rZW4gc2NvcGVkIHRvIHRoZSBydW4ncyB3cml0ZS1yZXBvIGFsbG93bGlzdC5cbiAqXG4gKiBUaGUgb25lIHBsYWNlIHRoYXQgZGVjaWRlcyBob3cgYSBydW4tc2NvcGVkIGNyZWRlbnRpYWwgaXMgb2J0YWluZWQsIHNoYXJlZFxuICogYnkge0BsaW5rIGJ1aWxkR2hFbnZ9ICh0aGUgd29ya2VyJ3Mgb3duIGBnaGAgY2FsbHMpIGFuZFxuICoge0BsaW5rIHdpdGhSdW5TY29wZWRHaFRva2VufSAodGhlIGNvZGluZyBhZ2VudCdzKS4gVHdvIGNvcGllcyBvZiB0aGlzIHdvdWxkXG4gKiBiZSB0d28gc2NvcGVzIHRvIGtlZXAgaW4gc3RlcCwgYW5kIHRoZSBvbmUgdGhhdCBkcmlmdGVkIHdvdWxkIGJlIHRoZSBvbmVcbiAqIGhhbmRlZCB0byB0aGUgYWdlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtaW50UnVuU2NvcGVkR2hUb2tlbigpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICByZXR1cm4gZ2V0R2hUb2tlbkZvclN1YnByb2Nlc3MoXG4gICAgRGVuby5lbnYuZ2V0KFwiR0lUSFVCX0FQUF9JRFwiKSxcbiAgICBEZW5vLmVudi5nZXQoXCJHSVRIVUJfQVBQX0lOU1RBTExBVElPTl9JRFwiKSxcbiAgICBEZW5vLmVudi5nZXQoXCJHSVRIVUJfQVBQX1BSSVZBVEVfS0VZX1BBVEhcIiksXG4gICAgdW5kZWZpbmVkLFxuICAgIGluc3RhbGxhdGlvblRva2VuUmVwb1Njb3BlKCksXG4gICk7XG59XG5cbi8qKlxuICogT3ZlcmxheSBhIHJ1bi1zY29wZWQgYEdIX1RPS0VOYCBvbnRvIGFuIEFMUkVBRFktU0FOSVRJU0VEIGNoaWxkIGVudmlyb25tZW50XG4gKiAoSXNzdWUgIzE0MjMpLlxuICpcbiAqIFRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCBkZWZlbmRzIGluIHR3byBsYXllcnM6IHRoZSBhcmd2IGNsYXNzaWZpZXIgcmVmdXNlc1xuICogYW4gb2ZmLWFsbG93bGlzdCB3cml0ZSBiZWZvcmUgYGdoYCBpcyBzcGF3bmVkLCBhbmQg4oCUIHNpbmNlIElzc3VlICMxMzkxIOKAlFxuICogdGhlIGNyZWRlbnRpYWwgaXRzZWxmIGNhbm5vdCByZWFjaCBiZXlvbmQgdGhlIHJ1bidzIHNjb3BlLCBzbyBhIHdyaXRlIHRoYXRcbiAqIGdldHMgcGFzdCB0aGUgY2xhc3NpZmllciBpcyBzdGlsbCByZWZ1c2VkIGJ5IEdpdEh1Yi4gVGhlIHNlY29uZCBsYXllclxuICogZXhpc3RlZCBvbmx5IGZvciB0aGUgd29ya2VyJ3Mgb3duIGNhbGxzLiBUaGUgY29kaW5nIGFnZW50J3MgYGdoYCBydW5zXG4gKiB0aHJvdWdoIHRoZSBQQVRIIHNoaW0gKGBnaF9ndWFyZF9zaGltLnRzYCkgYW5kIG5ldmVyIHJlYWNoZWRcbiAqIHtAbGluayBidWlsZEdoRW52fSwgc28gaXQgYXV0aGVudGljYXRlZCB3aXRoIHdoYXRldmVyIGFtYmllbnQgY3JlZGVudGlhbFxuICogd2FzIHN0YWdlZCBmb3IgdGhlIGNvbnRhaW5lciDigJQgdGhlIGluc3RhbGxhdGlvbidzIGZ1bGwgcmVhY2guIEZvciB0aGUgb25lXG4gKiBjb21wb25lbnQgZHJpdmVuIGJ5IHVudHJ1c3RlZCBpc3N1ZSBhbmQgY29tbWVudCB0ZXh0LCBvbmx5IGxheWVyIG9uZVxuICogYXBwbGllZC5cbiAqXG4gKiBUaGlzIGlzIGRlbGliZXJhdGVseSBOT1QgYGJ1aWxkR2hFbnZgIChJc3N1ZSAjMTQyMykuIFRoYXQgZnVuY3Rpb24gYnVpbGRzXG4gKiBpdHMgZW52aXJvbm1lbnQgZnJvbSBgRGVuby5lbnYudG9PYmplY3QoKWAg4oCUIHRoZSB3b3JrZXIncyBXSE9MRVxuICogZW52aXJvbm1lbnQsIGBHSVRIVUJfQVBQX1BSSVZBVEVfS0VZX1BBVEhgIGFtb25nIGl0LiBIYW5kaW5nIHRoYXQgdG8gdGhlXG4gKiBhZ2VudCB3b3VsZCB1bmRvIGV2ZXJ5IGV4Y2x1c2lvbiBgYWdlbnRfZW52LnRzYC9gY2xhdWRlX2Vudi50c2AgbWFrZSBhbmRcbiAqIHB1dCB0aGUgUEVNIHRoYXQgbWludHMgaW5zdGFsbGF0aW9uIHRva2VucyBpbiByZWFjaCBvZiBhIHByb21wdC1pbmplY3RlZFxuICogc2hlbGw6IGEgZmFyIHdvcnNlIGxlYWsgdGhhbiB0aGUgc2NvcGluZyBnYXAgYmVpbmcgY2xvc2VkLiBTbyB0aGUgY2FsbGVyJ3NcbiAqIHNhbml0aXNlZCBlbnZpcm9ubWVudCBpcyB0aGUgYmFzZSwgYW5kIGV4YWN0bHkgb25lIHZhbHVlIGlzIG92ZXJsYWlkIG9udG9cbiAqIGl0LlxuICpcbiAqIGBHSVRIVUJfVE9LRU5gIGlzIG92ZXJ3cml0dGVuIHdoZW4gdGhlIGJhc2UgY2FycmllcyBvbmUsIGJlY2F1c2UgYGdoYFxuICogYWNjZXB0cyBpdCBhcyBhbiBhbHRlcm5hdGl2ZSBuYW1lOiBsZWF2aW5nIHRoZSBhbWJpZW50IHZhbHVlIGluIHBsYWNlIHdvdWxkXG4gKiBwYXJrIGFuIHVuc2NvcGVkIGNyZWRlbnRpYWwgYmVzaWRlIHRoZSBzY29wZWQgb25lLlxuICpcbiAqIERlZ3JhZGVzIHJhdGhlciB0aGFuIGJyZWFrcy4gQSBob3N0IHdpdGggbm8gR2l0SHViIEFwcCBjb25maWd1cmVkIG1pbnRzXG4gKiBub3RoaW5nLCBhbmQgdGhlIGVudmlyb25tZW50IGlzIHJldHVybmVkIHVudG91Y2hlZCBzbyB0aGUgYWdlbnQga2VlcHMgdGhlXG4gKiBhbWJpZW50IGF1dGggaXQgaGFzIGFsd2F5cyB1c2VkIOKAlCB0aGUgc2FtZSBmYWxsYmFjayBgYnVpbGRHaEVudmAncyBjYWxsZXJzXG4gKiBtYWtlLlxuICpcbiAqIFJlc2lkdWFsIHJpc2ssIHJlY29yZGVkIHJhdGhlciB0aGFuIGhpZGRlbjogdGhlIGNyZWRlbnRpYWxcbiAqIGBnaF9jcmVkZW50aWFsX3N0YWdlLnRzYCBzdGFnZXMgaW50byBgR0hfQ09ORklHX0RJUmAncyBgaG9zdHMueW1sYCBpcyBzdGlsbFxuICogb24gZGlzayBhbmQgc3RpbGwgdW5zY29wZWQuIGBnaGAgcHJlZmVycyBgR0hfVE9LRU5gLCBzbyB0aGUgZ3VhcmRlZCBwYXRoXG4gKiBnZXRzIHRoZSBzY29wZWQgY3JlZGVudGlhbCwgYnV0IGEgcHJvY2VzcyB0aGF0IHJlYWRzIHRoYXQgZmlsZSBkaXJlY3RseVxuICogZG9lcyBub3QuIFJlbW92aW5nIGl0IGZyb20gdGhlIGFnZW50J3MgcmVhY2ggaXMgYSBtb3VudC1hbmQtc3RhZ2luZyBjaGFuZ2UsXG4gKiB0cmFja2VkIHNlcGFyYXRlbHkuXG4gKlxuICogQHBhcmFtIGJhc2VFbnYgLSBUaGUgc2FuaXRpc2VkIGNoaWxkIGVudmlyb25tZW50LCBzZWNyZXRzIGFscmVhZHkgZHJvcHBlZC5cbiAqIEBwYXJhbSBtaW50IC0gSG93IHRvIG9idGFpbiB0aGUgdG9rZW47IGRlZmF1bHRzIHRvXG4gKiAgIHtAbGluayBtaW50UnVuU2NvcGVkR2hUb2tlbn0uXG4gKiBAcmV0dXJucyBUaGUgZW52aXJvbm1lbnQgd2l0aCB0aGUgc2NvcGVkIGNyZWRlbnRpYWwgb3ZlcmxhaWQsIG9yIGBiYXNlRW52YFxuICogICB1bmNoYW5nZWQgd2hlbiBubyB0b2tlbiBjb3VsZCBiZSBtaW50ZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3aXRoUnVuU2NvcGVkR2hUb2tlbihcbiAgYmFzZUVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbiAgbWludDogR2hUb2tlbk1pbnRlciA9IG1pbnRSdW5TY29wZWRHaFRva2VuLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgbWludCgpO1xuICBpZiAoIXRva2VuKSByZXR1cm4gYmFzZUVudjtcblxuICBjb25zdCBzY29wZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLmJhc2VFbnYsIEdIX1RPS0VOOiB0b2tlbiB9O1xuICBpZiAoXCJHSVRIVUJfVE9LRU5cIiBpbiBiYXNlRW52KSBzY29wZWRbXCJHSVRIVUJfVE9LRU5cIl0gPSB0b2tlbjtcbiAgcmV0dXJuIHNjb3BlZDtcbn1cblxuLyoqXG4gKiBEZWNvZGUgYSBmaW5pc2hlZCBjb21tYW5kJ3Mgb3V0cHV0IGludG8gYSB7QGxpbmsgR2hTcGF3blJlc3VsdH0uXG4gKlxuICogRGVubydzIGBDb21tYW5kT3V0cHV0LnN0ZG91dGAvYC5zdGRlcnJgIGdldHRlcnMgVEhST1cgd2hlbiB0aGUgc3RyZWFtIHdhc1xuICogb3BlbmVkIHdpdGggYFwibnVsbFwiYCAoSXNzdWUgIzM3NDgpLCBzbyBhIGRpc2NhcmRlZCBzdHJlYW0gbXVzdCBuZXZlciBiZVxuICogcmVhZCDigJQgaXQgZGVjb2RlcyB0byBgXCJcImAgcGVyIHRoZSBgR2hTcGF3blJlc3VsdGAgY29udHJhY3QuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZU91dHB1dChcbiAgb3V0cHV0OiBEZW5vLkNvbW1hbmRPdXRwdXQsXG4gIG9wdGlvbnM6IEdoU3Bhd25PcHRpb25zLFxuKTogR2hTcGF3blJlc3VsdCB7XG4gIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICBjb2RlOiBvdXRwdXQuY29kZSxcbiAgICBzdWNjZXNzOiBvdXRwdXQuY29kZSA9PT0gMCxcbiAgICBzdGRvdXQ6IChvcHRpb25zLnN0ZG91dCA/PyBcInBpcGVkXCIpID09PSBcInBpcGVkXCJcbiAgICAgID8gZGVjb2Rlci5kZWNvZGUob3V0cHV0LnN0ZG91dClcbiAgICAgIDogXCJcIixcbiAgICBzdGRlcnI6IChvcHRpb25zLnN0ZGVyciA/PyBcInBpcGVkXCIpID09PSBcInBpcGVkXCJcbiAgICAgID8gZGVjb2Rlci5kZWNvZGUob3V0cHV0LnN0ZGVycilcbiAgICAgIDogXCJcIixcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgYnVkZ2V0IGBzcGF3bkdoYCB3aWxsIGVuZm9yY2UsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSBjYWxsZXIgb3ducyB0aGVcbiAqIGFib3J0IHZpYSBgc2lnbmFsYCBhbmQgbm8gdGltZWxpbmUgaXMgc2V0LlxuICpcbiAqIFN5bmNocm9ub3VzOiB0aGUgdGltZWxpbmUgaXMgcmVhZCBoZXJlLCBiZWZvcmUgYHNwYXduR2hgIGF3YWl0cywgc28gYSB0ZXN0XG4gKiBjYW4gaW5zdGFsbCBhIHRpbWVsaW5lIGZvciB0aGlzIGNhbGwgYW5kIGNsZWFyIGl0IGJlZm9yZSB0aGUgZmlyc3QgeWllbGQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlR2hTcGF3bkJ1ZGdldChcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIG9wdGlvbnM6IEdoU3Bhd25PcHRpb25zLFxuKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY29tbWFuZCA9IHN1YnByb2Nlc3NDb21tYW5kTGFiZWwoXCJnaFwiLCBhcmdzKTtcbiAgaWYgKG9wdGlvbnMudGltZW91dE1zICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gY2xhbXBUaW1lb3V0VG9SdW5UaW1lbGluZShvcHRpb25zLnRpbWVvdXRNcywgY29tbWFuZCk7XG4gIH1cbiAgaWYgKG9wdGlvbnMuc2lnbmFsKSB7XG4gICAgaWYgKGdldFJ1blRpbWVsaW5lKCkgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAvLyBObyBudW1lcmljIGJ1ZGdldCBvZiBvdXIgb3duLiBBIGZpbml0ZSBjbGFtcCBpcyB0aGUgdGltZWxpbmUncyBjYXA7XG4gICAgLy8gYSBub24tZmluaXRlIHJlc3VsdCBtZWFucyBubyBoYXJkIGtpbGwgaXMga25vd24gcGFzdCB0aGUgZmluaXNoLCBzb1xuICAgIC8vIHRoZSBjYWxsZXIncyBzaWduYWwgc3RheXMgdGhlIG9ubHkgYWJvcnQgYW5kIHdyYXAtdXAgc3RpbGwgcnVucy5cbiAgICBjb25zdCBjbGFtcGVkID0gY2xhbXBUaW1lb3V0VG9SdW5UaW1lbGluZShcbiAgICAgIE51bWJlci5QT1NJVElWRV9JTkZJTklUWSxcbiAgICAgIGNvbW1hbmQsXG4gICAgKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKGNsYW1wZWQpID8gY2xhbXBlZCA6IHVuZGVmaW5lZDtcbiAgfVxuICByZXR1cm4gY2xhbXBUaW1lb3V0VG9SdW5UaW1lbGluZShcbiAgICBnZXRHaFRpbWVvdXRGb3JPcGVyYXRpb24oYXJncykgKiAxMDAwLFxuICAgIGNvbW1hbmQsXG4gICk7XG59XG5cbi8qKiBBIHRpbWVkLW91dCBgZ2hgIGNhbGwsIGFzIGV4aXQgMTI0LiBBIHRpbWVvdXQgaXMgYSBmYWlsdXJlLiAqL1xuZnVuY3Rpb24gZ2hUaW1lZE91dChjb21tYW5kOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogR2hTcGF3blJlc3VsdCB7XG4gIHJldHVybiB7XG4gICAgY29kZTogR0hfVElNRU9VVF9FWElUX0NPREUsXG4gICAgc3VjY2VzczogZmFsc2UsXG4gICAgc3Rkb3V0OiBcIlwiLFxuICAgIHN0ZGVycjogYFRJTUVPVVQ6ICR7Y29tbWFuZH0gdGltZWQgb3V0IGFmdGVyICR7XG4gICAgICBmb3JtYXRUaW1lb3V0U2Vjb25kcyh0aW1lb3V0TXMpXG4gICAgfXNgLFxuICB9O1xufVxuXG4vKiogUHJvZHVjdGlvbiBydW5uZXIg4oCUIHRoZSBvbmx5IGBnaGAgc3Bhd24gaW4gdGhlIHdvcmtlciBwcm9jZXNzLiAqL1xuY29uc3QgcHJvZHVjdGlvblJ1bm5lcjogR2hTcGF3blJ1bm5lciA9IGFzeW5jIChhcmdzLCBvcHRpb25zKSA9PiB7XG4gIGNvbnN0IGJhc2VFbnYgPSBhd2FpdCBidWlsZEdoRW52KCk7XG4gIGNvbnN0IGVudiA9IG9wdGlvbnMuZW52XG4gICAgPyB7IC4uLihiYXNlRW52ID8/IERlbm8uZW52LnRvT2JqZWN0KCkpLCAuLi5vcHRpb25zLmVudiB9XG4gICAgOiBiYXNlRW52O1xuICBjb25zdCBjb21tYW5kTGFiZWwgPSBzdWJwcm9jZXNzQ29tbWFuZExhYmVsKFwiZ2hcIiwgYXJncyk7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGxldCB0aW1lZE91dCA9IGZhbHNlO1xuICBsZXQgY2FsbGVyQWJvcnRlZCA9IGZhbHNlO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4ge1xuICAgIGNhbGxlckFib3J0ZWQgPSB0cnVlO1xuICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgfTtcbiAgbGV0IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgaWYgKG9wdGlvbnMuc2lnbmFsKSB7XG4gICAgaWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIG9uQ2FsbGVyQWJvcnQoKTtcbiAgICBlbHNlIHtcbiAgICAgIG9wdGlvbnMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG4gICAgfVxuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAoY2FsbGVyQWJvcnRlZCkge1xuICAgICAgdGhyb3cgbmV3IERPTUV4Y2VwdGlvbihcIlRoZSBvcGVyYXRpb24gd2FzIGFib3J0ZWRcIiwgXCJBYm9ydEVycm9yXCIpO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy50aW1lb3V0TXMgIT09IHVuZGVmaW5lZCAmJiAhKG9wdGlvbnMudGltZW91dE1zID4gMCkpIHtcbiAgICAgIHJldHVybiBnaFRpbWVkT3V0KGNvbW1hbmRMYWJlbCwgb3B0aW9ucy50aW1lb3V0TXMpO1xuICAgIH1cbiAgICBpZiAob3B0aW9ucy50aW1lb3V0TXMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgdGltZWRPdXQgPSB0cnVlO1xuICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICB9LCBvcHRpb25zLnRpbWVvdXRNcyk7XG4gICAgfVxuICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgRGVuby5Db21tYW5kKFwiZ2hcIiwge1xuICAgICAgYXJnczogWy4uLmFyZ3NdLFxuICAgICAgc3RkaW46IG9wdGlvbnMuc3RkaW4gIT09IHVuZGVmaW5lZCA/IFwicGlwZWRcIiA6IFwibnVsbFwiLFxuICAgICAgc3Rkb3V0OiBvcHRpb25zLnN0ZG91dCA/PyBcInBpcGVkXCIsXG4gICAgICBzdGRlcnI6IG9wdGlvbnMuc3RkZXJyID8/IFwicGlwZWRcIixcbiAgICAgIC4uLihvcHRpb25zLmN3ZCA/IHsgY3dkOiBvcHRpb25zLmN3ZCB9IDoge30pLFxuICAgICAgLi4uKGVudiA/IHsgZW52IH0gOiB7fSksXG4gICAgfSk7XG4gICAgY29uc3QgY2hpbGQgPSBjb21tYW5kLnNwYXduKCk7XG4gICAgaWYgKG9wdGlvbnMuc3RkaW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3Qgd3JpdGVyID0gY2hpbGQuc3RkaW4uZ2V0V3JpdGVyKCk7XG4gICAgICBhd2FpdCB3cml0ZXIud3JpdGUobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKG9wdGlvbnMuc3RkaW4pKTtcbiAgICAgIGF3YWl0IHdyaXRlci5jbG9zZSgpO1xuICAgIH1cbiAgICBjb25zdCBvdXRjb21lID0gYXdhaXQgd2FpdEZvckNoaWxkRXhpdChcbiAgICAgIGNoaWxkLFxuICAgICAgY29udHJvbGxlci5zaWduYWwsXG4gICAgICBjb21tYW5kTGFiZWwsXG4gICAgKTtcbiAgICBpZiAodGltZXIgIT09IHVuZGVmaW5lZCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICBpZiAob3V0Y29tZS5raW5kID09PSBcImtpbGwtaW5jb21wbGV0ZVwiKSB7XG4gICAgICByZXR1cm4gZ2hUaW1lZE91dChjb21tYW5kTGFiZWwsIG9wdGlvbnMudGltZW91dE1zID8/IDApO1xuICAgIH1cbiAgICBpZiAodGltZWRPdXQgfHwgb3V0Y29tZS5raW5kID09PSBcImFib3J0ZWRcIikge1xuICAgICAgaWYgKGNhbGxlckFib3J0ZWQgJiYgIXRpbWVkT3V0KSB7XG4gICAgICAgIHRocm93IG5ldyBET01FeGNlcHRpb24oXCJUaGUgb3BlcmF0aW9uIHdhcyBhYm9ydGVkXCIsIFwiQWJvcnRFcnJvclwiKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBnaFRpbWVkT3V0KGNvbW1hbmRMYWJlbCwgb3B0aW9ucy50aW1lb3V0TXMgPz8gMCk7XG4gICAgfVxuICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICBpZiAoY2FsbGVyQWJvcnRlZCkge1xuICAgICAgICB0aHJvdyBuZXcgRE9NRXhjZXB0aW9uKFwiVGhlIG9wZXJhdGlvbiB3YXMgYWJvcnRlZFwiLCBcIkFib3J0RXJyb3JcIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gZ2hUaW1lZE91dChjb21tYW5kTGFiZWwsIG9wdGlvbnMudGltZW91dE1zID8/IDApO1xuICAgIH1cbiAgICBpZiAob3V0Y29tZS5raW5kICE9PSBcIm91dHB1dFwiKSB7XG4gICAgICByZXR1cm4gZ2hUaW1lZE91dChjb21tYW5kTGFiZWwsIG9wdGlvbnMudGltZW91dE1zID8/IDApO1xuICAgIH1cbiAgICByZXR1cm4gZGVjb2RlT3V0cHV0KG91dGNvbWUub3V0cHV0LCBvcHRpb25zKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IHVuZGVmaW5lZCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICBvcHRpb25zLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59O1xuXG5sZXQgcnVubmVyOiBHaFNwYXduUnVubmVyID0gcHJvZHVjdGlvblJ1bm5lcjtcblxuLyoqXG4gKiBSZS1zdGFnaW5ncyB0aGlzIHByb2Nlc3MgaGFzIHBlcmZvcm1lZCAoSXNzdWUgIzU2NCkuXG4gKlxuICogQm91bmRlZCBieSB7QGxpbmsgTUFYX1JFU1RBR0VfQVRURU1QVFN9OiBhIGNyZWRlbnRpYWwgdGhhdCBrZWVwcyB2YW5pc2hpbmdcbiAqIGlzIGEgZmF1bHQgdG8gcmVwb3J0LCBhbmQgYSByZXZva2VkIHRva2VuIG11c3QgZmFpbCByYXRoZXIgdGhhbiByZS1zdGFnZSBvblxuICogZXZlcnkgY2FsbCBmb3IgdGhlIHJlc3Qgb2YgdGhlIHJ1bi5cbiAqL1xubGV0IHJlc3RhZ2VBdHRlbXB0cyA9IDA7XG5cbi8qKiBSZXNldCB0aGUgcmUtc3RhZ2UgYnVkZ2V0LiBUZXN0cyBvbmx5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0R2hSZXN0YWdlQXR0ZW1wdHMoKTogdm9pZCB7XG4gIHJlc3RhZ2VBdHRlbXB0cyA9IDA7XG59XG5cbi8qKlxuICogVGhlIHJldHJ5J3Mgb3B0aW9ucywgd2l0aCBhbnkgZXhwbGljaXQgYEdIX0NPTkZJR19ESVJgIHJlZnJlc2hlZC5cbiAqXG4gKiBDYWxsZXJzIHRoYXQgcGluIHRoZSBkaXJlY3RvcnkgcGVyIGNhbGwgKGBzZXR1cC8qYCwgdGhlIGVzY2FsYXRpb24gcGF0aHMpXG4gKiB3b3VsZCBvdGhlcndpc2UgcmV0cnkgYWdhaW5zdCB0aGUgc2FtZSBicm9rZW4gY29weSB0aGUgcmUtc3RhZ2UgcmVwbGFjZWQuXG4gKi9cbmZ1bmN0aW9uIHdpdGhTdGFnZWRHaENvbmZpZ0RpcihcbiAgb3B0aW9uczogR2hTcGF3bk9wdGlvbnMsXG4gIGhvc3RFbnY6IEVudkxvb2t1cCxcbik6IEdoU3Bhd25PcHRpb25zIHtcbiAgaWYgKG9wdGlvbnMuZW52Py5HSF9DT05GSUdfRElSID09PSB1bmRlZmluZWQpIHJldHVybiBvcHRpb25zO1xuICBjb25zdCBzdGFnZWQgPSBob3N0RW52KFwiR0hfQ09ORklHX0RJUlwiKTtcbiAgaWYgKHN0YWdlZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gb3B0aW9ucztcbiAgcmV0dXJuIHsgLi4ub3B0aW9ucywgZW52OiB7IC4uLm9wdGlvbnMuZW52LCBHSF9DT05GSUdfRElSOiBzdGFnZWQgfSB9O1xufVxuXG4vKiogUmVhZCB0aGUgUFIncyBoZWFkIGFuZCBiYXNlIGZvciB0aGUgYmFzZS1jaGFuZ2UgZ3VhcmQ7IHRocm93cyBvbiBmYWlsdXJlLiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9va3VwUHJIZWFkQW5kQmFzZShcbiAgY2hhbmdlOiBQckJhc2VDaGFuZ2UsXG4gIG9wdGlvbnM6IEdoU3Bhd25PcHRpb25zLFxuKTogUHJvbWlzZTx7IGhlYWRSZWZOYW1lOiBzdHJpbmc7IGJhc2VSZWZOYW1lOiBzdHJpbmcgfT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBzcGF3bkdoKFtcbiAgICBcInByXCIsXG4gICAgXCJ2aWV3XCIsXG4gICAgLi4uKGNoYW5nZS5wclNlbGVjdG9yID8gW2NoYW5nZS5wclNlbGVjdG9yXSA6IFtdKSxcbiAgICAuLi4oY2hhbmdlLnJlcG8gPyBbXCItLXJlcG9cIiwgY2hhbmdlLnJlcG9dIDogW10pLFxuICAgIFwiLS1qc29uXCIsXG4gICAgXCJoZWFkUmVmTmFtZSxiYXNlUmVmTmFtZVwiLFxuICBdLCB7XG4gICAgLi4uKG9wdGlvbnMuY3dkID8geyBjd2Q6IG9wdGlvbnMuY3dkIH0gOiB7fSksXG4gICAgLi4uKG9wdGlvbnMuZW52ID8geyBlbnY6IG9wdGlvbnMuZW52IH0gOiB7fSksXG4gICAgLi4uKG9wdGlvbnMuaG9zdEVudiA/IHsgaG9zdEVudjogb3B0aW9ucy5ob3N0RW52IH0gOiB7fSksXG4gICAgLi4uKG9wdGlvbnMuYnlwYXNzUXVvdGFMYXRjaCA/IHsgYnlwYXNzUXVvdGFMYXRjaDogdHJ1ZSB9IDoge30pLFxuICB9KTtcbiAgaWYgKCFyZXN1bHQuc3VjY2Vzcykge1xuICAgIHRocm93IG5ldyBFcnJvcihgZ2ggcHIgdmlldyBmYWlsZWQgKGV4aXQgJHtyZXN1bHQuY29kZX0pYCk7XG4gIH1cbiAgY29uc3QgZG9jID0gSlNPTi5wYXJzZShyZXN1bHQuc3Rkb3V0KSBhcyB7XG4gICAgaGVhZFJlZk5hbWU/OiB1bmtub3duO1xuICAgIGJhc2VSZWZOYW1lPzogdW5rbm93bjtcbiAgfTtcbiAgaWYgKFxuICAgIHR5cGVvZiBkb2MuaGVhZFJlZk5hbWUgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGRvYy5iYXNlUmVmTmFtZSAhPT0gXCJzdHJpbmdcIlxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJnaCBwciB2aWV3IHJldHVybmVkIG5vIGhlYWQvYmFzZVwiKTtcbiAgfVxuICByZXR1cm4geyBoZWFkUmVmTmFtZTogZG9jLmhlYWRSZWZOYW1lLCBiYXNlUmVmTmFtZTogZG9jLmJhc2VSZWZOYW1lIH07XG59XG5cbi8qKlxuICogUnVuIGBnaGAgdGhyb3VnaCB0aGUgd29ya2VyJ3MgY2hva2Vwb2ludC5cbiAqXG4gKiBFbmZvcmNlcyB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QgYmVmb3JlIHRoZSBwcm9jZXNzIHN0YXJ0cyAoc28gYSByZWZ1c2VkXG4gKiB3cml0ZSBuZXZlciByZWFjaGVzIEdpdEh1YikgYW5kIGpvdXJuYWxzIHRoZSBtdXRhdGlvbiBhZnRlcndhcmRzLiBOZXZlclxuICogdGhyb3dzIG9uIGEgbm9uLXplcm8gZXhpdCDigJQgaW5zcGVjdCB7QGxpbmsgR2hTcGF3blJlc3VsdC5zdWNjZXNzfS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHBhcmFtIG9wdGlvbnMgLSBTdWJwcm9jZXNzIG9wdGlvbnMuXG4gKiBAdGhyb3dzIFdyaXRlUmVwb0Jsb2NrZWRFcnJvciB8IFdyaXRlVGFyZ2V0VW5kZXRlcm1pbmFibGVFcnJvciB3aGVuIHRoZVxuICogICB3cml0ZSBpcyByZWZ1c2VkIGJ5IHRoZSBhbGxvd2xpc3QuXG4gKiBAdGhyb3dzIFByQmFzZUNoYW5nZVJlZnVzZWRFcnJvciB3aGVuIGEgUFIgYmFzZSBjaGFuZ2UgaXMgcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNwYXduR2goXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaFNwYXduT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxHaFNwYXduUmVzdWx0PiB7XG4gIC8vIEJlZm9yZSB0aGUgZmlyc3QgYXdhaXQsIHNvIHRoZSB0aW1lbGluZSByZWFkIGlzIHN5bmNocm9ub3VzIChJc3N1ZSAjNDI0NykuXG4gIGNvbnN0IGJ1ZGdldE1zID0gcmVzb2x2ZUdoU3Bhd25CdWRnZXQoYXJncywgb3B0aW9ucyk7XG4gIGNvbnN0IHRpbWVkT3B0aW9ucyA9IGJ1ZGdldE1zID09PSB1bmRlZmluZWRcbiAgICA/IG9wdGlvbnNcbiAgICA6IHsgLi4ub3B0aW9ucywgdGltZW91dE1zOiBidWRnZXRNcyB9O1xuICBhd2FpdCBlbmZvcmNlR2hXcml0ZUFsbG93bGlzdChhcmdzKTtcbiAgLy8gSXNzdWUgIzM0MzM6IGEgYmFzZSBjaGFuZ2UgbXVzdCBub3QgbW92ZSBhIG1pbGVzdG9uZSBQUiBvZmYgaXRzIG1pbGVzdG9uZVxuICAvLyBicmFuY2guIFRoZSBsb29rdXAgaXMgYSBgcHIgdmlld2AgcmVhZCwgc28gaXQgY2Fubm90IHJlY3Vyc2UgaW50byB0aGUgZ3VhcmQuXG4gIGF3YWl0IGVuZm9yY2VQckJhc2VDaGFuZ2VHdWFyZChhcmdzLCB7XG4gICAgbG9va3VwOiAoY2hhbmdlKSA9PiBsb29rdXBQckhlYWRBbmRCYXNlKGNoYW5nZSwgb3B0aW9ucyksXG4gICAgcmVhZEJvZHlGaWxlOiBkZW5vQm9keUZpbGVSZWFkZXIsXG4gICAgbG9nOiAobGluZSkgPT4gY29uc29sZS5lcnJvcihsaW5lKSxcbiAgfSk7XG4gIC8vIElzc3VlICM0MiAvICMxNDg1OiBvbmNlIHRoZSBwcmltYXJ5IEdyYXBoUUwgcXVvdGEgaXMgZXhoYXVzdGVkLCBldmVyeVxuICAvLyBmdXJ0aGVyIEdyYXBoUUwtYmFja2VkIGNhbGwgaW4gdGhlIHdpbmRvdyBpcyBndWFyYW50ZWVkIHRvIGZhaWwuIFRoZVxuICAvLyBzaG9ydC1jaXJjdWl0IHVzZWQgdG8gbGl2ZSBpbiBgcnVuR2hDb21tYW5kUmF3YCBhbG9uZSwgc28gdGhlIHRoaXJ0eS1vZGRcbiAgLy8gbW9kdWxlcyB0aGF0IGNhbGwgdGhpcyBjaG9rZXBvaW50IGRpcmVjdGx5IGtlcHQgc3Bhd25pbmcgZG9vbWVkIGBnaGBcbiAgLy8gcHJvY2Vzc2VzIGFmdGVyIHRoZSBsYXRjaCBoYWQgZmlyZWQuIEl0IGxpdmVzIGhlcmUgbm93LCBhdCB0aGUgb25lXG4gIC8vIHBsYWNlIGV2ZXJ5IGBnaGAgc3Bhd24gcGFzc2VzIOKAlCBiZWZvcmUgdGhlIHNwYXduIGFuZCBiZWZvcmUgdGhlXG4gIC8vIHRlbGVtZXRyeSDigJQgYW5kIGEgUkVTVCBgZ2ggYXBpIDxwYXRoPmAgc3RpbGwgcmlkZXMgdGhlIGNvcmUgcXVvdGEuXG4gIGlmIChcbiAgICAhb3B0aW9ucy5ieXBhc3NRdW90YUxhdGNoICYmICFpc1F1b3RhRXhlbXB0R2hDYWxsKGFyZ3MpICYmXG4gICAgaXNQcmltYXJ5UXVvdGFMYXRjaGVkKClcbiAgKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvZGU6IDEsXG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIHN0ZG91dDogXCJcIixcbiAgICAgIHN0ZGVycjogcHJpbWFyeVF1b3RhU2tpcE1lc3NhZ2UoKSxcbiAgICB9O1xuICB9XG4gIC8vIElzc3VlICMxNjcxIC8gIzE0ODU6IHBlci1pdGVyYXRpb24gYGdoYCBjYWxsIHRlbGVtZXRyeSwgcmVjb3JkZWQgYXQgdGhlXG4gIC8vIGNob2tlcG9pbnQgc28gZXZlcnkgaW52b2NhdGlvbiDigJQgZnJvbSBhbnkgbW9kdWxlIOKAlCBpcyBjb3VudGVkIGV4YWN0bHlcbiAgLy8gb25jZSBwZXIgYXR0ZW1wdC5cbiAgcmVjb3JkR2hDYWxsKGFyZ3MpO1xuICAvLyBNYXNrIHNlY3JldHMgaW4gdGhlIHB1Ymxpc2hlZCBib2R5IGFyZ3VtZW50cyAoSXNzdWUgIzM3MDcpIOKAlCB0aGUgbGFzdFxuICAvLyBwb2ludCBiZWZvcmUgYSBjb21tZW50IG9yIFBSIGJvZHkgbGVhdmVzIHRoZSB3b3JrZXIgZm9yIEdpdEh1Yi5cbiAgLy9cbiAgLy8gVGhlIHJlYWRlciBhbmQgd3JpdGVyIGFyZSB0aGUgc2FtZSBwYWlyIHRoZSBhZ2VudCdzIGd1YXJkIGNoaWxkIHN1cHBsaWVzXG4gIC8vIChJc3N1ZSAjMTI1NCk6IHdpdGhvdXQgdGhlbSB0aGlzIGNhbGwgcGFzc2VkIGFyZ3YgYWxvbmUsIHNvIGFcbiAgLy8gYC0tYm9keS1maWxlYCAvIGAtRiA8cGF0aD5gIC8gYC0taW5wdXQgPGZpbGU+YCBib2R5IHdhcyBuZWl0aGVyIHNjYW5uZWRcbiAgLy8gbm9yIHJlZnVzZWQsIGFuZCBhIG1vZHVsZSBzd2l0Y2hpbmcgZnJvbSBgLS1ib2R5YCB0byBgLS1ib2R5LWZpbGVgIHdvdWxkXG4gIC8vIGhhdmUgcHVibGlzaGVkIHVuc2Nhbm5lZCB3aGlsZSBsb29raW5nIGxpa2UgYSByZWZhY3Rvci5cbiAgLy9cbiAgLy8gSXNzdWUgIzEzNjQ6IGEgbWFza2VkIGAtLWlucHV0YCBjb3B5IG5lZWRzIGEgZGlyZWN0b3J5IHRoYXQgb3ducyBpdC4gVGhlXG4gIC8vIGd1YXJkIGNoaWxkIGNhbm5vdCBjbGVhbiB1cCDigJQgaXQgZXhpdHMgYmVmb3JlIGl0cyBgZ2hgIGNoaWxkIHJlYWRzIHRoZVxuICAvLyBmaWxlIOKAlCBidXQgdGhpcyBjaG9rZXBvaW50IGF3YWl0cyB0aGUgY2hpbGQsIHNvIGl0IGNhbiwgYW5kIGRvZXMsIGluIHRoZVxuICAvLyBgZmluYWxseWAgYmVsb3cuIFRoZSBkaXJlY3RvcnkgaXMgY3JlYXRlZCBvbmx5IHdoZW4gYSBib2R5IGlzIGFjdHVhbGx5XG4gIC8vIG1hc2tlZCwgc28gYW4gb3JkaW5hcnkgY2FsbCBkb2VzIG5vIGZpbGVzeXN0ZW0gd29yay5cbiAgbGV0IG1hc2tlZEJvZHlEaXI6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29uc3Qgd3JpdGVNYXNrZWRCb2R5OiBCb2R5RmlsZVdyaXRlciA9IChjb250ZW50KSA9PiB7XG4gICAgbWFza2VkQm9keURpciA/Pz0gRGVuby5tYWtlVGVtcERpclN5bmMoeyBwcmVmaXg6IFwiZ2gtc3Bhd24tYm9keS1cIiB9KTtcbiAgICByZXR1cm4gYm9keUZpbGVXcml0ZXJJbihtYXNrZWRCb2R5RGlyKShjb250ZW50KTtcbiAgfTtcbiAgY29uc3Qgc3RkaW5TY2FubmVkID0gb3B0aW9ucy5zdGRpbiAhPT0gdW5kZWZpbmVkO1xuICBjb25zdCByZWRhY3RlZCA9IHJlZGFjdEdoQm9keUFyZ3MoXG4gICAgYXJncyxcbiAgICBkZW5vQm9keUZpbGVSZWFkZXIsXG4gICAgd3JpdGVNYXNrZWRCb2R5LFxuICAgIHN0ZGluU2Nhbm5lZCxcbiAgKTtcbiAgLy8gSXNzdWUgIzE0MjE6IGBnaCBhcGkgLS1pbnB1dCAtYCBjYXJyaWVzIGl0cyBib2R5IG9uIFNURElOLCB3aGVyZSB0aGVyZSBpc1xuICAvLyBubyBhcmd1bWVudCB0byByZXdyaXRlIOKAlCBzbyBpdCBuZXZlciBwYXNzZWQgdGhyb3VnaCB0aGUgbWFzayBhYm92ZS4gVGhlXG4gIC8vIG1vZHVsZSBkb2MgcHJvbWlzZXMgZXZlcnkgcHVibGljIHNpbmsgaW5oZXJpdHMgcmVkYWN0aW9uIGJ5IGNvbnN0cnVjdGlvbjtcbiAgLy8gdGhhdCB3YXMgdHJ1ZSBvZiB0aGUgYXJndiByb3V0ZSBvbmx5LiBMYXRlbnQgcmF0aGVyIHRoYW4gbGl2ZSB0b2RheSAobm9cbiAgLy8gcHJvZHVjdGlvbiBjYWxsZXIgc3VwcGxpZXMgc3RkaW4pLCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBzaG91bGQgYmVcbiAgLy8gY2xvc2VkIG5vdyByYXRoZXIgdGhhbiB3aGVuIG9uZSBhcHBlYXJzLlxuICBjb25zdCB3aXRoU3RkaW4gPSBvcHRpb25zLnN0ZGluID09PSB1bmRlZmluZWRcbiAgICA/IHRpbWVkT3B0aW9uc1xuICAgIDogeyAuLi50aW1lZE9wdGlvbnMsIHN0ZGluOiByZWRhY3RHaEJvZHlUZXh0KG9wdGlvbnMuc3RkaW4pIH07XG4gIGNvbnN0IHNwYXduT3B0aW9ucyA9IGJ1ZGdldE1zID09PSB1bmRlZmluZWRcbiAgICA/IHdpdGhTdGRpblxuICAgIDogeyAuLi53aXRoU3RkaW4sIHRpbWVvdXRNczogYnVkZ2V0TXMgfTtcbiAgdHJ5IHtcbiAgICBsZXQgcmVzdWx0ID0gYXdhaXQgcnVubmVyKHJlZGFjdGVkLCBzcGF3bk9wdGlvbnMpO1xuICAgIC8vIElzc3VlICM1NjQ6IGEgY2FsbCB0aGF0IGZhaWxlZCBmb3Igd2FudCBvZiBhdXRoZW50aWNhdGlvbiBkaWQgbm90aGluZyxcbiAgICAvLyBzbyByZXRyeWluZyBpdCBpcyBzYWZlIOKAlCBhbmQgdGhlIGNyZWRlbnRpYWwgaXMgdmVyeSBsaWtlbHkgcmVjb3ZlcmFibGUuXG4gICAgLy8gVGhlIHdyaXRhYmxlIGNvcHkgb2YgYGhvc3RzLnltbGAgd2VudCBtaXNzaW5nIG1pZC1ydW4gb25jZSBhbHJlYWR5IGFuZFxuICAgIC8vIGV2ZXJ5IGxhdGVyIGNhbGwgZmFpbGVkIHdpdGggdGhlIGludGFjdCBvcmlnaW5hbCBzdGlsbCBvbiBpdHMgbW91bnQuXG4gICAgLy8gUmVidWlsZCBmcm9tIHRoZSBtb3VudCBhbmQgdHJ5IG9uY2UgbW9yZSwgaGVyZSBhdCB0aGUgY2hva2Vwb2ludCwgc29cbiAgICAvLyBldmVyeSBnaCBjYWxsZXIgaW4gdGhlIHdvcmtlciBpbmhlcml0cyB0aGUgcmVjb3ZlcnkuXG4gICAgaWYgKFxuICAgICAgaXNHaEF1dGhNaXNzaW5nRmFpbHVyZShyZXN1bHQpICYmIHJlc3RhZ2VBdHRlbXB0cyA8IE1BWF9SRVNUQUdFX0FUVEVNUFRTXG4gICAgKSB7XG4gICAgICByZXN0YWdlQXR0ZW1wdHMrKztcbiAgICAgIGNvbnN0IGhvc3RFbnYgPSBvcHRpb25zLmhvc3RFbnYgPz8gcHJvY2Vzc0Vudkxvb2t1cDtcbiAgICAgIGNvbnN0IHN0YWdpbmc6IEVuc3VyZUdoQ29uZmlnRGlyT3B0aW9ucyA9IHtcbiAgICAgICAgZW52OiBob3N0RW52LFxuICAgICAgICAuLi4ob3B0aW9ucy5zZXRIb3N0RW52ID8geyBzZXRFbnY6IG9wdGlvbnMuc2V0SG9zdEVudiB9IDoge30pLFxuICAgICAgfTtcbiAgICAgIGlmIChlbnN1cmVVc2FibGVHaENvbmZpZ0RpcihzdGFnaW5nKSkge1xuICAgICAgICAvLyBUaGUgcmV0cnkgaXMgYSBzZWNvbmQgcmVhbCBgZ2hgIHByb2Nlc3MgYWdhaW5zdCB0aGUgc2FtZSBxdW90YS5cbiAgICAgICAgcmVjb3JkR2hDYWxsKGFyZ3MpO1xuICAgICAgICByZXN1bHQgPSBhd2FpdCBydW5uZXIoXG4gICAgICAgICAgcmVkYWN0ZWQsXG4gICAgICAgICAgd2l0aFN0YWdlZEdoQ29uZmlnRGlyKHNwYXduT3B0aW9ucywgaG9zdEVudiksXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIElzc3VlICMxNTQwOiB0aGUgcmVmdXNhbCBpcyByZWNvZ25pc2VkIGhlcmUsIHdoZXJlIGl0IGlzIHNlZW4sIGFuZFxuICAgIC8vIGhhbmRlZCB0byB0aGUgcmVnaXN0ZXJlZCBob29rLCB3aGljaCBsYXRjaGVzIGFuZCB3cml0ZXMgdGhlIHNoYXJlZFxuICAgIC8vIHNpZ25hbC4gVGhlIGhvb2sgcHJvYmVzIG9ubHkgd2hlbiB0aGUgcmVzcG9uc2UgbWF5IGJlIHByaW1hcnkgcXVvdGE7XG4gICAgLy8gYSBwcmltYXJ5IHJlZnVzYWwgZnJvbSB0aGUgcXVvdGEgcHJvYmUgbXVzdCBub3QgcmVjdXJzZS4gQSBzZWNvbmRhcnlcbiAgICAvLyByZWZ1c2FsIG5lZWRzIG5vIHByb2JlLCBzbyBpdCBhbHNvIGxhdGNoZXMgd2hlbiB0aGUgcHJvYmUgc2VlcyBpdCBmaXJzdC5cbiAgICBpZiAoXG4gICAgICAhcmVzdWx0LnN1Y2Nlc3MgJiZcbiAgICAgICFpc1F1b3RhRXhlbXB0R2hDYWxsKGFyZ3MpICYmIHF1b3RhRXhoYXVzdGlvbkhvb2sgIT09IG51bGwgJiZcbiAgICAgICgoIW9wdGlvbnMuYnlwYXNzUXVvdGFMYXRjaCAmJlxuICAgICAgICBpc1ByaW1hcnlSYXRlTGltaXRNZXNzYWdlKHJlc3VsdC5zdGRlcnIpKSB8fFxuICAgICAgICBpc1NlY29uZGFyeU9ubHlSYXRlTGltaXRNZXNzYWdlKFxuICAgICAgICAgIHJlc3VsdC5zdGRlcnIsXG4gICAgICAgICAgaXNQcmltYXJ5UmF0ZUxpbWl0TWVzc2FnZSxcbiAgICAgICAgKSlcbiAgICApIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHF1b3RhRXhoYXVzdGlvbkhvb2soe1xuICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgc3RkZXJyOiByZXN1bHQuc3RkZXJyLFxuICAgICAgICAgIC4uLihvcHRpb25zLndvcmtEaXIgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB7IHdvcmtEaXI6IG9wdGlvbnMud29ya0RpciB9XG4gICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gQmVzdC1lZmZvcnQgYm9va2tlZXBpbmc6IHRoZSBjYWxsZXIgc3RpbGwgc2VlcyBpdHMgb3duIGZhaWx1cmUuXG4gICAgICB9XG4gICAgfVxuICAgIC8vIEJlc3QtZWZmb3J0IOKAlCBuZXZlciBsZXRzIGpvdXJuYWxsaW5nIGFsdGVyIG9yIGFib3J0IHRoZSBnaCBjYWxsLlxuICAgIGF3YWl0IGF1ZGl0R2hNdXRhdGlvbihhcmdzLCByZXN1bHQuY29kZSk7XG4gICAgLy8gSXNzdWUgIzE4MTogYSBjbG9zZSB0aGUgd29ya2VyIGp1c3QgcGVyZm9ybWVkIGludmFsaWRhdGVzIHRoZSBzY2FuLWNhY2hlXG4gICAgLy8gZW50cmllcyB0aGF0IHN0aWxsIGRlc2NyaWJlIHRoZSBpc3N1ZSBhcyBvcGVuLCBhbmQgbWFya3MgaXQgZmluaXNoZWQgZm9yXG4gICAgLy8gdGhlIHJlc3Qgb2YgdGhlIHJ1biBzbyBubyBzbG90IHJlLWNsYWltcyBpdC4gQWxzbyBiZXN0LWVmZm9ydC5cbiAgICBhd2FpdCBub3RlR2hJc3N1ZUNsb3NlKGFyZ3MsIHJlc3VsdC5jb2RlKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IGZpbmFsbHkge1xuICAgIC8vIFRoZSBgZ2hgIGNoaWxkIGhhcyBleGl0ZWQgYnkgdGhlIHRpbWUgdGhlIGNhbGwgYWJvdmUgcmVzb2x2ZXMsIHNvIHRoZVxuICAgIC8vIG1hc2tlZCBjb3B5IGl0IHJlYWQgaXMgc2FmZSB0byByZW1vdmUgKElzc3VlICMxMzY0KS4gQmVzdC1lZmZvcnQ6IGFcbiAgICAvLyBjbGVhbnVwIGZhaWx1cmUgbXVzdCBuZXZlciB0dXJuIGEgY29tcGxldGVkIGBnaGAgY2FsbCBpbnRvIGEgdGhyb3duIG9uZS5cbiAgICBpZiAobWFza2VkQm9keURpciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBEZW5vLnJlbW92ZVN5bmMobWFza2VkQm9keURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm90aGluZyB0byBkbyDigJQgdGhlIGRpcmVjdG9yeSBpcyB1bmRlciBUTVBESVIgZWl0aGVyIHdheS5cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBSdW4gYGdoYCB0aHJvdWdoIHRoZSBjaG9rZXBvaW50IGFuZCByZXR1cm4gc3Rkb3V0LCB0aHJvd2luZyBvbiBmYWlsdXJlLlxuICpcbiAqIFRoZSBjb252ZW5pZW5jZSBmb3JtIHVzZWQgYnkgdGhlIGNhbGxlcnMgdGhhdCBwcmV2aW91c2x5IGhhZCB0aGVpciBvd25cbiAqIGBkZWZhdWx0R2hDb21tYW5kYC5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHBhcmFtIG9wdGlvbnMgLSBTdWJwcm9jZXNzIG9wdGlvbnMuXG4gKiBAcmV0dXJucyBEZWNvZGVkIHN0ZG91dC5cbiAqIEB0aHJvd3MgRXJyb3Igb24gYSBub24temVybyBleGl0LCBjYXJyeWluZyB0aGUgZXhpdCBjb2RlIGFuZCBzdGRlcnIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HaE9yVGhyb3coXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBvcHRpb25zOiBHaFNwYXduT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgeyBjb2RlLCBzdWNjZXNzLCBzdGRvdXQsIHN0ZGVyciB9ID0gYXdhaXQgc3Bhd25HaChhcmdzLCBvcHRpb25zKTtcbiAgaWYgKCFzdWNjZXNzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGdoIGNvbW1hbmQgZmFpbGVkIChleGl0ICR7Y29kZX0pOiAke3N0ZGVyci50cmltKCkgfHwgc3Rkb3V0LnRyaW0oKX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHN0ZG91dDtcbn1cblxuLyoqIFJlcGxhY2UgdGhlIGxvdy1sZXZlbCBydW5uZXIuIFRlc3Qtb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfc2V0R2hTcGF3blJ1bm5lcihmbjogR2hTcGF3blJ1bm5lcik6IHZvaWQge1xuICBydW5uZXIgPSBmbjtcbn1cblxuLyoqIFJlc3RvcmUgdGhlIHByb2R1Y3Rpb24gcnVubmVyLiBUZXN0LW9ubHkuICovXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0R2hTcGF3blJ1bm5lcigpOiB2b2lkIHtcbiAgcnVubmVyID0gcHJvZHVjdGlvblJ1bm5lcjtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXdDQyxHQUVELFNBQVMsdUJBQXVCLFFBQVEsdUJBQXVCO0FBQy9ELFNBRUUsdUJBQXVCLEVBQ3ZCLHNCQUFzQixFQUN0QixvQkFBb0IsUUFDZiwyQkFBMkI7QUFDbEMsU0FBeUIsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBQ25FLFNBQ0UsdUJBQXVCLEVBQ3ZCLDBCQUEwQixRQUNyQiw0QkFBNEI7QUFDbkMsU0FDRSx3QkFBd0IsUUFFbkIsNEJBQTRCO0FBQ25DLFNBQVMsZUFBZSxRQUFRLGtCQUFrQjtBQUNsRCxTQUVFLGdCQUFnQixFQUNoQixnQkFBZ0IsUUFDWCx5QkFBeUI7QUFDaEMsOEVBQThFO0FBQzlFLHlFQUF5RTtBQUN6RSxTQUFTLGdCQUFnQixFQUFFLGtCQUFrQixRQUFRLHVCQUF1QjtBQUM1RSxTQUFTLGdCQUFnQixRQUFRLDRCQUE0QjtBQUM3RCxTQUFTLFlBQVksUUFBUSx1QkFBdUI7QUFDcEQsU0FDRSxxQkFBcUIsRUFDckIseUJBQXlCLEVBQ3pCLG1CQUFtQixFQUNuQix1QkFBdUIsUUFDbEIsMkJBQTJCO0FBQ2xDLFNBQVMsK0JBQStCLFFBQVEsNEJBQTRCO0FBQzVFLFNBQ0Usd0JBQXdCLEVBQ3hCLG9CQUFvQixRQUNmLGtCQUFrQjtBQUN6QixTQUNFLHlCQUF5QixFQUN6QixvQkFBb0IsRUFDcEIsc0JBQXNCLEVBQ3RCLGdCQUFn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
// denoCacheMetadata=16883122800559699503,946678374292202975