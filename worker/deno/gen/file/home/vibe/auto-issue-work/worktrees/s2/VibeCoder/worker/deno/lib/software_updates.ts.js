/**
 * Software update checking for Claude CLI, GH CLI, and Deno (Issue #294, #373, #906, #1496).
 *
 * Checks for software updates periodically (default: weekly). Uses a timestamp
 * file to track the last check time. Individual update commands retry on
 * transient failures with exponential backoff (Issue #1496). Permanent failures
 * (auth, missing binary, unsupported platform) are not retried. Final failures
 * are logged as warnings but do not propagate — the worker continues regardless.
 *
 * Every upgrade is additionally gated on a **release-age quarantine** (Issue
 * #3655): the candidate release must have been published at least
 * `VIBE_BUMP_QUARANTINE_HOURS` (default 24h) ago, matching the embargo this
 * repository already applies to every other external ecosystem. `gh` extensions
 * are enumerated and gated individually rather than upgraded wholesale, and the
 * Deno upgrade is pinned to the resolved version so the artefact installed is
 * the one that was age-checked. Each `gh` extension is likewise installed at
 * the exact ref its verdict dated (Issue #3952) — a release tag for a binary
 * extension, the default branch's HEAD sha for a script one. See
 * `tool_release_age.ts`.
 *
 * A caller may instead ask for one **exact version** through
 * `targetVersion` (Issue #623). That path installs the published artefact for
 * that version — the npm tarball for the Claude CLI, the `cli/cli` release
 * archive for `gh`, `deno upgrade <version>` for Deno — leaves a tool already
 * at that version alone, and throws when the version afterwards does not match.
 * The age gate stays exactly as it was for the unpinned "latest" path, which is
 * still what a caller gets when `targetVersion` is absent.
 *
 * `checkSoftwareUpdates` picks between the two from `update_mode` (Issue #625):
 * `dynamic` — the default — behaves exactly as it always has, while `frozen`
 * installs the exact `pinned_tool_versions` for all three tools on every
 * launch, ahead of the interval and floor gates.
 */ import { CLAUDE_CLI_NPM_PACKAGE, createReleaseAgeGate, DENO_RELEASE_REPO, GH_CLI_RELEASE_REPO, NPM_REGISTRY_BASE, parseGhExtensionList } from "./tool_release_age.ts";
import { spawnGh } from "./gh_spawn.ts";
import { runningInContainerImage } from "./container_stamp.ts";
import { WriteRepoBlockedError, WriteTargetUndeterminableError } from "./write_repo_allowlist.ts";
/** Default update check interval: 7 days in seconds. */ export const DEFAULT_UPDATE_INTERVAL_SECONDS = 604800;
/** Default timeout for each update command in seconds. */ export const DEFAULT_UPDATE_TIMEOUT_SECONDS = 120;
/** Default maximum retry attempts for a single update command (Issue #1496). */ export const DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS = 3;
/**
 * Default exponential backoff delays in seconds between retries (Issue #1496).
 *
 * Entry `i` is the delay to wait AFTER attempt `i+1` failed (before attempt
 * `i+2`). The last entry is reused if there are more retries than entries.
 */ export const DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS = [
  30,
  90,
  300
];
/**
 * Refuse a duration that cannot be compared or waited on (Issue #1270).
 *
 * `NaN` is the dangerous value here, not a negative one: every comparison
 * against it is `false` and `setTimeout(fn, NaN)` fires immediately, so a
 * `NaN` interval turns the update gate permanently closed while a `NaN`
 * timeout aborts every install — both while the caller still reports success.
 * Neither is recoverable by guessing a default, so the value is refused.
 *
 * @param value Seconds supplied by a caller.
 * @param label Operator-facing name of the setting, e.g. `--timeout`.
 * @throws When the value is not a finite, strictly positive number.
 */ function assertPositiveSeconds(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive number of seconds, got ` + `${value}. A non-finite or non-positive duration is refused rather ` + `than passed on — it would silently disable the check it controls.`);
  }
}
/**
 * Check if enough time has elapsed since the last update check.
 *
 * Reads the timestamp file to determine when the last update check occurred.
 * Returns true if the interval has elapsed, the file is missing, or contains
 * invalid content.
 *
 * @throws When `intervalSeconds` is not a finite, positive number
 *   (Issue #1270) — `elapsed >= NaN` is `false`, so a `NaN` interval would
 *   otherwise close the gate forever without a word.
 */ export function shouldCheckForUpdates(timestampDir, intervalSeconds = DEFAULT_UPDATE_INTERVAL_SECONDS, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  assertPositiveSeconds(intervalSeconds, "update interval");
  const tsFile = `${timestampDir}/.last_software_update_check`;
  let content;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch  {
    return true; // No file means never checked
  }
  if (!content || !/^\d+$/.test(content)) {
    return true; // Invalid content means we should check
  }
  const lastCheck = parseInt(content, 10);
  const now = nowFn();
  const elapsed = now - lastCheck;
  return elapsed >= intervalSeconds;
}
/**
 * Record the current time as the last update check timestamp.
 */ export function recordUpdateCheck(timestampDir, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  const tsFile = `${timestampDir}/.last_software_update_check`;
  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
}
/**
 * Record the last successful update timestamp for a given tool (Issue #1496).
 *
 * Each tool (claude, gh, deno) gets its own small state file so self-heal
 * retries for one tool do not clobber the timestamp of another.
 */ export function recordSuccessfulUpdate(timestampDir, tool, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  const tsFile = `${timestampDir}/.last_successful_update_${tool}`;
  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
}
/**
 * Read the last successful update timestamp for a given tool (Issue #1496).
 *
 * Returns null if the file is missing or contains invalid content.
 */ export function getLastSuccessfulUpdate(timestampDir, tool) {
  const tsFile = `${timestampDir}/.last_successful_update_${tool}`;
  let content;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch  {
    return null;
  }
  if (!/^\d+$/.test(content)) return null;
  return parseInt(content, 10);
}
/**
 * Classify an update command failure as transient or permanent (Issue #1496).
 *
 * Permanent failures (auth, missing binary, unsupported platform) should not
 * be retried — the same error will recur. Transient failures (network
 * timeouts, rate limits, 5xx) are retried with backoff.
 *
 * Defaults unknown failures to "transient" so flaky non-determinate errors
 * benefit from self-healing rather than skipping an entire update cycle.
 */ export function classifyUpdateError(exitCode, output) {
  // Exit code 127 is the conventional "command not found" — permanent.
  if (exitCode === 127) return "permanent";
  const lower = output.toLowerCase();
  // Missing binary — permanent.
  if (lower.includes("command not found") || lower.includes("no such file or directory") || /: not found$/m.test(lower)) {
    return "permanent";
  }
  // Authentication / authorisation — permanent.
  if (lower.includes("authentication") || lower.includes("unauthorised") || lower.includes("unauthorized") || lower.includes("permission denied") || lower.includes("not logged in") || lower.includes("access denied") || lower.includes("forbidden") || lower.includes("invalid credentials") || lower.includes("401 ") || lower.includes("403 ")) {
    return "permanent";
  }
  // Unsupported platform / architecture — permanent.
  if (lower.includes("unsupported platform") || lower.includes("platform is not supported") || lower.includes("architecture not supported") || lower.includes("unsupported architecture") || lower.includes("not supported on this")) {
    return "permanent";
  }
  // Timeout exit codes used by runWithTimeout / GNU timeout — transient.
  if (exitCode === 124 || exitCode === 137) return "transient";
  // Network, timeout, rate limit, and 5xx failures — transient.
  if (/timed?\s*out/.test(lower) || lower.includes("timeout") || lower.includes("network") || lower.includes("connection refused") || lower.includes("connection reset") || lower.includes("could not resolve") || lower.includes("temporarily unavailable") || lower.includes("service unavailable") || lower.includes("rate limit") || lower.includes("429") || /http 5\d{2}/.test(lower) || lower.includes("tls handshake") || lower.includes("ssl_error")) {
    return "transient";
  }
  // Default: treat unknown failures as transient so we self-heal.
  return "transient";
}
/**
 * Whether an error is the `gh` chokepoint refusing the call (Issue #1396).
 *
 * Matched on the error type rather than its message, so a reworded refusal
 * cannot quietly become retryable again.
 */ function isWriteRefusal(err) {
  return err instanceof WriteRepoBlockedError || err instanceof WriteTargetUndeterminableError;
}
/**
 * Spawn one update command, routing `gh` through the worker's chokepoint
 * (Issue #1396).
 *
 * `runWithTimeout` reaches its binary through `cmd[0]`, so the two `gh` calls
 * in this module — `gh extension list` and the pinned
 * `gh extension install` — spawned outside `spawnGh` and skipped the
 * write-repo allowlist and the audit journal that every other worker `gh`
 * call passes through. Dispatching on the binary name here re-routes them,
 * and keeps any `gh` command a future caller passes on the same path.
 * `gh extension` verbs classify as `non-repo` local-tool mutations
 * (`audit_mutation_classifier.ts`), so they are journalled rather than
 * refused as an undeterminable repo write.
 *
 * Every other tool (`brew`, `claude`, `deno`, `npm`, `which`) has no
 * chokepoint of its own and is spawned directly, under the same abort signal.
 */ async function runUpdateCommand(cmd, signal) {
  if (cmd[0] === "gh") {
    const result = await spawnGh(cmd.slice(1), {
      signal
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
  const output = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    signal
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr)
  };
}
/**
 * Run a command with a timeout and return the result.
 *
 * Uses the repo's canonical `AbortController` + `clearTimeout` timeout pattern
 * (as in `git_timeout.ts`) so the timeout timer is always cleared once the race
 * resolves — on the success path as well as the timeout path. Leaving a live
 * timer queued on the fast success path would keep the event loop non-idle and
 * delay process exit for up to `timeoutSeconds` (Issue #3167).
 *
 * A `gh` command is spawned by {@link runUpdateCommand} through `spawnGh`
 * rather than here (Issue #1396), so it carries the write-repo allowlist and
 * the audit journal like every other worker `gh` call.
 *
 * Exported for direct unit testing; not part of the module's public API.
 */ export async function runWithTimeout(cmd, timeoutSeconds) {
  const timeoutMs = timeoutSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const result = await runUpdateCommand(cmd, controller.signal);
    // The abort signal terminates the child rather than throwing, so detect
    // the timeout by inspecting the controller after `output()` resolves.
    if (controller.signal.aborted) {
      return {
        ok: true,
        value: {
          exitCode: 124,
          output: `Timed out after ${timeoutSeconds}s`
        }
      };
    }
    return {
      ok: true,
      value: {
        exitCode: result.code,
        output: `${result.stdout}\n${result.stderr}`.trim()
      }
    };
  } catch (err) {
    // Some runtimes surface the abort as an AbortError instead.
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        ok: true,
        value: {
          exitCode: 124,
          output: `Timed out after ${timeoutSeconds}s`
        }
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  } finally{
    clearTimeout(timer);
  }
}
/** Default sleep helper: wait `seconds` real seconds. */ function defaultSleepSeconds(seconds) {
  return new Promise((resolve)=>setTimeout(resolve, seconds * 1000));
}
/**
 * Run an update command with retry and exponential backoff on transient
 * failures (Issue #1496).
 *
 * Classifies each failure using {@link classifyUpdateError}. Permanent
 * failures return immediately without retry. Transient failures are retried
 * up to `maxAttempts` times with delays taken from `backoffSeconds`. All
 * attempts ultimately failing returns `{ success: false }` — the caller is
 * expected to log a warning rather than throw.
 */ export async function runUpdateWithRetry(logger, toolName, cmd, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_UPDATE_RETRY_MAX_ATTEMPTS;
  const backoff = options.backoffSeconds ?? DEFAULT_UPDATE_RETRY_BACKOFF_SECONDS;
  const timeout = options.timeout ?? DEFAULT_UPDATE_TIMEOUT_SECONDS;
  const sleepFn = options.sleepFn ?? defaultSleepSeconds;
  const runFn = options.runFn ?? runWithTimeout;
  let lastExit = 0;
  let lastOutput = "";
  let lastClass;
  for(let attempt = 1; attempt <= maxAttempts; attempt++){
    const runResult = await runFn(cmd, timeout);
    if (runResult.ok) {
      lastExit = runResult.value.exitCode;
      lastOutput = runResult.value.output;
      if (lastExit === 0) {
        if (attempt > 1) {
          logger.info(`${toolName} update succeeded on attempt ${attempt}/${maxAttempts}`);
        }
        return {
          success: true,
          attempts: attempt,
          finalExitCode: 0,
          finalOutput: lastOutput
        };
      }
      lastClass = classifyUpdateError(lastExit, lastOutput);
    } else {
      // Spawn error — classify as transient so we retry, unless the `gh`
      // chokepoint refused the call (Issue #1396). A write the allowlist
      // refused is refused identically on every attempt, so retrying it only
      // delays the warning and re-emits the `[SECURITY]` line three times.
      lastExit = -1;
      lastOutput = runResult.error.message;
      lastClass = isWriteRefusal(runResult.error) ? "permanent" : "transient";
    }
    if (lastClass === "permanent") {
      logger.warn(`${toolName} update failed permanently (exit ${lastExit}) — not retrying: ${lastOutput || "no output"}`);
      return {
        success: false,
        attempts: attempt,
        finalExitCode: lastExit,
        finalOutput: lastOutput,
        classification: "permanent"
      };
    }
    if (attempt < maxAttempts) {
      const delay = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 30;
      logger.info(`${toolName} update attempt ${attempt}/${maxAttempts} failed (transient, exit ${lastExit}) — retrying in ${delay}s`);
      await sleepFn(delay);
    }
  }
  logger.warn(`${toolName} update failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"} (exit ${lastExit}) — continuing anyway`);
  if (lastOutput) logger.info(`${toolName} final output: ${lastOutput}`);
  return {
    success: false,
    attempts: maxAttempts,
    finalExitCode: lastExit,
    finalOutput: lastOutput,
    classification: lastClass
  };
}
/**
 * Resolve the release-age gate for a tool update (Issue #3655).
 *
 * Tests inject a gate; production builds the real one from the same command
 * runner the update itself uses, so the gate is never accidentally bypassed.
 */ function resolveAgeGate(logger, opts) {
  return opts.ageGate ?? createReleaseAgeGate({
    runFn: opts.retry?.runFn ?? runWithTimeout,
    quarantineHours: opts.quarantineHours,
    warn: (message)=>logger.warn(message)
  });
}
/**
 * Log a quarantine verdict and report whether the upgrade may proceed
 * (Issue #3655).
 *
 * Fail-closed (Issue #3234): a release that is too new is deferred, and one
 * whose age cannot be verified is skipped with a warning. Neither outcome is
 * silent — an unverifiable upstream is a supply-chain signal, not a no-op.
 */ function passesQuarantine(logger, label, verdict) {
  if (verdict.eligible) {
    logger.info(`${label} release-age check passed: ${verdict.reason}`);
    return true;
  }
  if (verdict.indeterminate) {
    logger.warn(`${label} upgrade skipped: ${verdict.reason}`);
  } else {
    logger.info(`${label} upgrade deferred: ${verdict.reason}`);
  }
  return false;
}
/** Build the effective retry options for a tool update from its options. */ function buildRetryOptions(opts) {
  return {
    maxAttempts: opts.retry?.maxAttempts,
    backoffSeconds: opts.retry?.backoffSeconds,
    timeout: opts.retry?.timeout ?? opts.timeout,
    sleepFn: opts.retry?.sleepFn,
    runFn: opts.retry?.runFn
  };
}
/** Persist a successful update timestamp for a tool, if a directory is configured. */ function persistSuccess(logger, tool, opts) {
  if (!opts.timestampDir) return;
  const result = recordSuccessfulUpdate(opts.timestampDir, tool, opts.now);
  if (!result.ok) {
    logger.warn(`Failed to record successful update timestamp for ${tool}: ${result.error.message}`);
  }
}
/** Human-readable label per tool, used in log lines and error messages. */ const TOOL_LABELS = {
  claude: "Claude CLI",
  gh: "GH CLI",
  deno: "Deno"
};
/** Release channel each tool's "latest" version is published through. */ const TOOL_CHANNELS = {
  claude: {
    kind: "npm",
    pkg: CLAUDE_CLI_NPM_PACKAGE
  },
  gh: {
    kind: "github",
    repo: GH_CLI_RELEASE_REPO
  },
  deno: {
    kind: "github",
    repo: DENO_RELEASE_REPO
  }
};
/** Canonical order every tool sweep follows: claude → gh → deno. */ const UPDATE_TOOLS = [
  "claude",
  "gh",
  "deno"
];
/**
 * Version shape accepted as a pinned install target (Issue #623).
 *
 * The value is interpolated into a download URL and a command line, so only a
 * plain semver (with an optional pre-release suffix) is accepted — anything
 * else is refused loudly rather than fetched.
 *
 * Exported because the release tool-version manifest (Issue #688) records
 * versions a frozen host installs through exactly this path, so it must accept
 * exactly what the pinned installer accepts rather than a second copy of the
 * rule that could drift.
 */ export const PINNED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
/** Directory downloads are staged in. Falls back to `/tmp`. */ function stagingDir() {
  let dir;
  try {
    dir = Deno.env.get("TMPDIR") ?? Deno.env.get("TMP");
  } catch  {
    dir = undefined;
  }
  return (dir ?? "/tmp").replace(/\/+$/, "") || "/tmp";
}
/**
 * The `gh` release archive for one version on one platform (Issue #623).
 *
 * Mirrors the naming `container/Containerfile` already relies on —
 * `gh_<version>_<os>_<arch>` — including `gh`'s own quirks: macOS archives are
 * zipped and spelled `macOS`, Linux archives are gzipped tarballs. Returns null
 * for a platform `cli/cli` publishes no such archive for, so the caller can
 * fail loud instead of fetching a URL that does not exist.
 */ export function ghReleaseArchive(version, os = Deno.build.os, arch = Deno.build.arch) {
  const goarch = arch === "x86_64" ? "amd64" : arch === "aarch64" ? "arm64" : null;
  const osName = os === "linux" ? "linux" : os === "darwin" ? "macOS" : null;
  if (!goarch || !osName) return null;
  const zipped = osName === "macOS";
  const dir = `gh_${version}_${osName}_${goarch}`;
  const archive = `${dir}.${zipped ? "zip" : "tar.gz"}`;
  return {
    dir,
    archive,
    zipped,
    url: `https://github.com/${GH_CLI_RELEASE_REPO}/releases/download/v${version}/${archive}`
  };
}
/**
 * Resolve the path the installed `gh` binary occupies (Issue #623).
 *
 * A pinned `gh` install replaces the binary already on PATH, so the exact
 * version the caller asked for is the one that runs. Returns null when `gh`
 * cannot be located — the caller then fails loud rather than guessing a prefix.
 */ async function resolveGhBinaryPath(runFn) {
  const probe = await runFn([
    "which",
    "gh"
  ], 5);
  if (!probe.ok || probe.value.exitCode !== 0) return null;
  return probe.value.output.split("\n").map((line)=>line.trim()).find((line)=>line.startsWith("/")) ?? null;
}
/**
 * Build the command sequence that installs one exact version (Issue #623).
 *
 * Each tool follows the pattern the container image already uses for its
 * pinned tools: fetch the published artefact for that exact version, then
 * install from the local file — never a floating "latest".
 */ async function planPinnedInstall(tool, version, runFn) {
  const fail = (message)=>({
      ok: false,
      error: new Error(message)
    });
  if (tool === "deno") {
    // `deno upgrade` already takes a version argument.
    return {
      ok: true,
      value: {
        commands: [
          [
            "deno",
            "upgrade",
            version
          ]
        ],
        cleanup: []
      }
    };
  }
  const tmp = stagingDir();
  if (tool === "claude") {
    const tarball = `${tmp}/claude-code-${version}.tgz`;
    const url = `${NPM_REGISTRY_BASE}/${CLAUDE_CLI_NPM_PACKAGE}/-/claude-code-${version}.tgz`;
    return {
      ok: true,
      value: {
        commands: [
          [
            "curl",
            "-fsSL",
            "-o",
            tarball,
            url
          ],
          [
            "npm",
            "install",
            "-g",
            "--ignore-scripts",
            tarball
          ]
        ],
        cleanup: [
          [
            "rm",
            "-f",
            tarball
          ]
        ]
      }
    };
  }
  const asset = ghReleaseArchive(version);
  if (!asset) {
    return fail(`no gh ${version} release archive is published for ${Deno.build.os}/${Deno.build.arch}`);
  }
  const destination = await resolveGhBinaryPath(runFn);
  if (!destination) {
    return fail("the installed gh binary could not be located, so the pinned binary has nowhere to go");
  }
  const archive = `${tmp}/${asset.archive}`;
  const extracted = `${tmp}/${asset.dir}`;
  return {
    ok: true,
    value: {
      commands: [
        [
          "curl",
          "-fsSL",
          "-o",
          archive,
          asset.url
        ],
        asset.zipped ? [
          "unzip",
          "-o",
          "-q",
          archive,
          "-d",
          tmp
        ] : [
          "tar",
          "-xzf",
          archive,
          "-C",
          tmp
        ],
        [
          "install",
          "-m",
          "0755",
          `${extracted}/bin/gh`,
          destination
        ]
      ],
      cleanup: [
        [
          "rm",
          "-rf",
          archive,
          extracted
        ]
      ]
    }
  };
}
/**
 * Whether version output reports exactly `version` (Issue #623).
 *
 * Returns null when either side has no parseable semver, so the caller can
 * distinguish "different version" from "could not tell".
 */ export function versionMatchesExactly(installedOutput, version) {
  const installed = parseSemver(installedOutput);
  const wanted = parseSemver(version);
  if (!installed || !wanted) return null;
  return compareSemver(installed, wanted) === 0;
}
/**
 * Re-read a tool's version after a pinned install and fail loud on a mismatch
 * (Issue #623).
 *
 * Uses the same reader as the floor check (`VERSION_COMMANDS` via
 * {@link makeVersionReader}) rather than a second version reader. Unlike the
 * floor check — which warns and waits for the next interval — a pinned install
 * that did not land the requested version throws, naming the requested and the
 * actual version: silently leaving the host on an unpinned tool is exactly the
 * silent failure this path exists to prevent.
 */ async function verifyPinnedVersion(logger, tool, version, readVersion) {
  const label = TOOL_LABELS[tool];
  const output = await readVersion(tool);
  if (output === null) {
    throw new Error(`${label} pinned install of ${version} cannot be verified: the installed version could not be read`);
  }
  const matches = versionMatchesExactly(output, version);
  if (matches === null) {
    throw new Error(`${label} pinned install of ${version} cannot be verified: no version could be parsed from "${output.trim()}"`);
  }
  if (!matches) {
    const installed = parseSemver(output);
    throw new Error(`${label} version mismatch after a pinned install: requested ${version}, installed ${installed.join(".")}`);
  }
  logger.info(`${label} is now at the pinned version ${version}`);
}
/**
 * Install one tool at an exact version (Issue #623).
 *
 * A tool already reporting that version is left alone — a launch must not
 * reinstall on every run. Otherwise the artefact for exactly that version is
 * fetched and installed, and the result is verified: a failed install, an
 * unverifiable version, or a version that does not match throws with both the
 * requested and the actual version named.
 */ export async function installPinnedVersion(logger, tool, version, options = {}) {
  const label = TOOL_LABELS[tool];
  if (!PINNED_VERSION_PATTERN.test(version)) {
    throw new Error(`${label} pinned install refused: "${version}" is not a valid version`);
  }
  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const readVersion = makeVersionReader(runFn);
  const before = await readVersion(tool);
  if (before !== null && versionMatchesExactly(before, version) === true) {
    logger.info(`${label} is already at the pinned version ${version} — nothing to install`);
    return;
  }
  const plan = await planPinnedInstall(tool, version, runFn);
  if (!plan.ok) {
    throw new Error(`${label} pinned install of ${version} failed — ${plan.error.message}`);
  }
  logger.info(`Installing ${label} ${version} (pinned)...`);
  let failure = null;
  for (const cmd of plan.value.commands){
    const result = await runUpdateWithRetry(logger, `${label} ${version}`, cmd, retryOpts);
    if (!result.success) {
      failure = `\`${cmd[0]}\` failed (exit ${result.finalExitCode})${result.finalOutput ? `: ${result.finalOutput}` : ""}`;
      break;
    }
  }
  // Cleanup is best-effort: a leftover download must not mask the outcome.
  for (const cmd of plan.value.cleanup)await runFn(cmd, 30);
  if (failure) {
    throw new Error(`${label} pinned install of ${version} failed — ${failure}`);
  }
  await verifyPinnedVersion(logger, tool, version, readVersion);
  persistSuccess(logger, tool, options);
}
/**
 * Report the version dynamic mode would install right now for one tool
 * (Issue #623).
 *
 * Resolved through the existing release-age gate, so the answer is the version
 * an unpinned update would actually adopt — not merely upstream's newest. A
 * version too new to clear the quarantine window, or one that cannot be
 * resolved at all, is reported as ineligible with the gate's own reason rather
 * than being reported as a usable default.
 */ export async function resolveDynamicVersion(logger, tool, options = {}) {
  const verdict = await resolveAgeGate(logger, options).check(TOOL_CHANNELS[tool]);
  return verdictToCandidate(tool, verdict);
}
/**
 * Report what dynamic mode would install right now for every tool, in the
 * canonical claude → gh → deno order (Issue #623).
 */ export function resolveDynamicVersions(logger, options = {}) {
  return Promise.all(UPDATE_TOOLS.map((tool)=>resolveDynamicVersion(logger, tool, options)));
}
/** Fold a gate verdict into the candidate shape callers report. */ function verdictToCandidate(tool, verdict) {
  return {
    tool,
    version: verdict.eligible ? verdict.version : null,
    eligible: verdict.eligible && verdict.version !== null,
    reason: verdict.eligible && !verdict.version ? `${TOOL_LABELS[tool]}: the release-age check passed but resolved no version to install.` : verdict.reason
  };
}
/**
 * Report the newest release of one tool that has cleared the quarantine window
 * (Issue #726).
 *
 * {@link resolveDynamicVersion} answers "may upstream's newest be adopted?" —
 * the question an upgrade asks, and one whose answer is routinely "not yet":
 * the Claude CLI ships several times a day, so its newest release is almost
 * always inside the 24h window. A caller that has to *name* an installable
 * version — the release tool-version manifest — asks this instead, and gets
 * the newest release the embargo has already let through.
 *
 * The embargo is unchanged: a tool with nothing past the window is still
 * reported ineligible, with the gate's own reason.
 */ export async function resolveQuarantineClearedVersion(logger, tool, options = {}) {
  const verdict = await resolveAgeGate(logger, options).checkNewestAged(TOOL_CHANNELS[tool]);
  return verdictToCandidate(tool, verdict);
}
/**
 * Report the newest quarantine-cleared release of every tool, in the canonical
 * claude → gh → deno order (Issue #726).
 */ export function resolveQuarantineClearedVersions(logger, options = {}) {
  return Promise.all(UPDATE_TOOLS.map((tool)=>resolveQuarantineClearedVersion(logger, tool, options)));
}
/**
 * Update Claude CLI to latest version with retry on transient failures (Issue #1496).
 *
 * Gated on the release age of `@anthropic-ai/claude-code` on npm (Issue #3655).
 * `claude update` exposes no version argument, so this unpinned upgrade cannot
 * name a version; the age gate is therefore the control that keeps a
 * just-published — possibly hijacked — release out of the fleet. A caller that
 * supplies `targetVersion` takes the pinned path instead (Issue #623), which
 * installs that exact release from its npm tarball.
 */ export async function updateClaudeCli(logger, options = {}) {
  if (options.skip) {
    logger.info("Claude CLI update skipped (skipClaude=true)");
    return true;
  }
  // Pinned install (Issue #623): `claude update` takes no version argument, so
  // the exact release is installed from its npm tarball instead.
  if (options.targetVersion) {
    await installPinnedVersion(logger, "claude", options.targetVersion, options);
    return true;
  }
  logger.info("Checking for Claude CLI updates...");
  const verdict = await resolveAgeGate(logger, options).check({
    kind: "npm",
    pkg: CLAUDE_CLI_NPM_PACKAGE
  });
  if (!passesQuarantine(logger, "Claude CLI", verdict)) return true;
  const result = await runUpdateWithRetry(logger, "Claude CLI", [
    "claude",
    "update"
  ], buildRetryOptions(options));
  if (result.success) {
    logger.info("Claude CLI update completed successfully");
    if (result.finalOutput) logger.info(`Update output: ${result.finalOutput}`);
    persistSuccess(logger, "claude", options);
  }
  return result.success;
}
/**
 * Upgrade installed `gh` extensions one at a time, each gated on its own
 * repository's release age (Issue #3655).
 *
 * `gh extension upgrade --all` upgraded an unbounded set of arbitrary
 * third-party repositories in a single unpinned step, so one compromised
 * extension reached every host. Extensions are now enumerated with
 * `gh extension list` and each is checked against the quarantine window
 * individually.
 *
 * **The install is pinned to the ref the gate dated (Issue #3952).** Bare
 * `gh extension upgrade <name>` installs the latest release for a binary
 * extension but pulls the default branch for a script extension, so a gate
 * that dated the latest release could pass a months-old tag while branch HEAD
 * — possibly ten minutes old — was what actually landed. Each upgrade now runs
 * `gh extension install <repo> --pin <ref> --force`, where `<ref>` is exactly
 * the tag or commit sha the verdict dated. An extension whose installable ref
 * cannot be dated is left alone and reported.
 *
 * @returns True when enumeration succeeded and no attempted upgrade failed.
 */ async function upgradeGhExtensions(logger, gate, retryOpts) {
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const listed = await runFn([
    "gh",
    "extension",
    "list"
  ], 30);
  if (!listed.ok || listed.value.exitCode !== 0) {
    const detail = listed.ok ? `exit ${listed.value.exitCode}: ${listed.value.output || "no output"}` : listed.error.message;
    logger.warn(`Could not enumerate gh extensions (${detail}) — no extension is ` + `upgraded, because an unenumerated set cannot be age-checked`);
    return false;
  }
  const extensions = parseGhExtensionList(listed.value.output);
  if (extensions.length === 0) {
    logger.info("No gh extensions installed — nothing to upgrade");
    return true;
  }
  let allOk = true;
  for (const ext of extensions){
    const verdict = await gate.check({
      kind: "gh-extension",
      repo: ext.repo
    });
    if (!passesQuarantine(logger, `gh extension ${ext.repo}`, verdict)) {
      continue;
    }
    // Fail loud (Issue #3234): an approved verdict with no ref cannot be
    // installed as dated, so it is reported rather than upgraded unpinned.
    if (!verdict.ref) {
      logger.warn(`gh extension ${ext.repo} upgrade skipped: the release-age check ` + `approved ${verdict.version ?? "an unnamed version"} but resolved ` + `no dated ref to pin the install to`);
      allOk = false;
      continue;
    }
    const result = await runUpdateWithRetry(logger, `gh extension ${ext.name}`, [
      "gh",
      "extension",
      "install",
      ext.repo,
      "--pin",
      verdict.ref,
      "--force"
    ], retryOpts);
    if (!result.success) allOk = false;
    else if (result.finalOutput) {
      logger.info(`gh extension ${ext.name}: ${result.finalOutput}`);
    }
  }
  return allOk;
}
/**
 * Update GH CLI binary (via brew) and extensions with retry (Issue #1496).
 *
 * Both halves are release-age gated (Issue #3655): the binary upgrade against
 * the latest `cli/cli` release, and each extension against its own repository.
 * `brew upgrade gh` takes no version argument, so the gate approximates the
 * formula's age with the age of the upstream `gh` release the formula tracks —
 * a formula-only compromise that does not touch `cli/cli` is out of its reach
 * and remains covered by Homebrew's own signing. A caller that supplies
 * `targetVersion` takes the pinned path instead (Issue #623), installing that
 * exact `cli/cli` release archive over the `gh` binary already on PATH.
 */ export async function updateGhCli(logger, options = {}) {
  if (options.skip) {
    logger.info("GH CLI update skipped (skipGh=true)");
    return true;
  }
  // Pinned install (Issue #623): `brew upgrade gh` takes no version argument,
  // so the exact release archive for this platform is installed instead. Only
  // the binary is pinned — extensions keep their own age-gated upgrade path.
  if (options.targetVersion) {
    await installPinnedVersion(logger, "gh", options.targetVersion, options);
    return true;
  }
  logger.info("Checking for GH CLI updates...");
  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;
  const gate = resolveAgeGate(logger, options);
  // Upgrade GH CLI binary via brew (if available). `which brew` is a short,
  // deterministic probe and does not need retry — classify its absence as
  // "brew not installed" and skip the binary upgrade.
  let ok = true;
  const brewProbe = await runFn([
    "which",
    "brew"
  ], 5);
  if (brewProbe.ok && brewProbe.value.exitCode === 0) {
    const binaryVerdict = await gate.check({
      kind: "github",
      repo: GH_CLI_RELEASE_REPO
    });
    if (passesQuarantine(logger, "GH CLI binary", binaryVerdict)) {
      logger.info("Upgrading GH CLI via brew...");
      const brewResult = await runUpdateWithRetry(logger, "brew upgrade gh", [
        "brew",
        "upgrade",
        "gh"
      ], retryOpts);
      if (!brewResult.success) ok = false;
      else if (brewResult.finalOutput) {
        logger.info(`brew upgrade gh: ${brewResult.finalOutput}`);
      }
    }
  } else {
    logger.info("brew not available — skipping GH CLI binary upgrade");
  }
  // Upgrade GH CLI extensions individually, each behind the quarantine window.
  if (await upgradeGhExtensions(logger, gate, retryOpts)) {
    logger.info("GH CLI update completed successfully");
    persistSuccess(logger, "gh", options);
  } else {
    ok = false;
  }
  return ok;
}
/**
 * Update Deno runtime with retry (Issue #1496).
 *
 * The upgrade is **pinned** to the release the quarantine gate actually
 * approved (Issue #3655): `deno upgrade <version>` rather than a bare
 * `deno upgrade`, so a release published between the age check and the upgrade
 * cannot slip in unchecked. A caller that supplies `targetVersion` pins to that
 * version instead of the gate's verdict (Issue #623).
 */ export async function updateDeno(logger, options = {}) {
  if (options.skip) {
    logger.info("Deno update skipped (skipDeno=true)");
    return true;
  }
  // Pinned install (Issue #623): `deno upgrade` already accepts a version, so
  // the requested one is used in place of the age-gate verdict. The absent-
  // binary probe below is deliberately not consulted — a pinned install that
  // cannot run must fail loud, not return quietly.
  if (options.targetVersion) {
    await installPinnedVersion(logger, "deno", options.targetVersion, options);
    return true;
  }
  const retryOpts = buildRetryOptions(options);
  const runFn = retryOpts.runFn ?? runWithTimeout;
  // Presence probe is a one-shot check — no retry.
  const denoCheck = await runFn([
    "which",
    "deno"
  ], 5);
  if (!denoCheck.ok || denoCheck.value.exitCode !== 0) {
    logger.info("Deno not installed — skipping update");
    return true;
  }
  logger.info("Checking for Deno updates...");
  const verdict = await resolveAgeGate(logger, options).check({
    kind: "github",
    repo: DENO_RELEASE_REPO
  });
  if (!passesQuarantine(logger, "Deno", verdict)) return true;
  if (!verdict.version) {
    logger.warn("Deno upgrade skipped: no resolved version to pin to");
    return true;
  }
  const result = await runUpdateWithRetry(logger, "Deno", [
    "deno",
    "upgrade",
    verdict.version
  ], retryOpts);
  if (result.success) {
    logger.info("Deno update completed successfully");
    if (result.finalOutput) logger.info(`Update output: ${result.finalOutput}`);
    persistSuccess(logger, "deno", options);
  }
  return result.success;
}
/**
 * The updater for each tool, shared by the dynamic and frozen paths.
 *
 * Each returns false only when an update it actually attempted failed after
 * its retries (Issue #1270) — a skip, a quarantine hold or an absent binary
 * is not a failure.
 */ const TOOL_UPDATERS = {
  claude: updateClaudeCli,
  gh: updateGhCli,
  deno: updateDeno
};
/**
 * Install the exact versions a frozen host is held at (Issue #625).
 *
 * Every tool takes the pinned path added in #623, so a tool already at its
 * version is a no-op and a pinned install that does not land the requested
 * version throws with both versions named — a launch never quietly continues
 * on a different version than the one recorded in `.config.json`.
 *
 * **The release-age quarantine is deliberately not applied here.** That gate
 * exists to keep a just-published — possibly hijacked — release out of an
 * unattended "latest" pull; a frozen version is instead a human's deliberate
 * choice recorded in config, so there is no unattended selection to guard. The
 * pinned version is logged at install so the choice stays auditable.
 *
 * @throws When a tool has no pinned version, or its pinned install fails.
 * @returns Which tools were installed and which a skip flag suppressed
 *   (Issue #1270), so the caller can report what the launch actually did.
 */ async function installFrozenToolVersions(logger, pinned, toolOpts, skips) {
  const attempted = [];
  const skipped = [];
  for (const tool of UPDATE_TOOLS){
    const label = TOOL_LABELS[tool];
    const version = pinned[tool]?.trim();
    if (!version) {
      // Config load already refuses a half-pinned frozen host, so reaching
      // here means the options were assembled by hand. Continuing would leave
      // this tool floating on whatever the host happens to have.
      throw new Error(`update_mode is frozen but ${label} has no pinned version — set ` + `pinned_tool_versions.${tool} rather than leaving the tool to drift`);
    }
    if (skips[tool]) {
      skipped.push(tool);
      logger.warn(`${label} is pinned to ${version} (update_mode=frozen) but its ` + `update is suppressed (${SKIP_ENV_NAME[tool] ?? "skip flag"}) — the ` + `host may drift off its pin`);
      continue;
    }
    logger.info(`${label} pinned to ${version} (update_mode=frozen)`);
    attempted.push(tool);
    await TOOL_UPDATERS[tool](logger, {
      ...toolOpts,
      targetVersion: version
    });
  }
  return {
    attempted,
    skipped
  };
}
/** Version-reading commands per tool (Issue #2622). */ const VERSION_COMMANDS = {
  claude: [
    "claude",
    "--version"
  ],
  gh: [
    "gh",
    "--version"
  ],
  deno: [
    "deno",
    "--version"
  ]
};
/** Environment variable that suppresses each tool's update (Issue #2622). */ const SKIP_ENV_NAME = {
  claude: "SKIP_CLAUDE_UPDATE",
  gh: "SKIP_GH_UPDATE",
  deno: "SKIP_DENO_UPDATE"
};
/**
 * Parse the leading semver (MAJOR.MINOR.PATCH) from version output (Issue #2622).
 *
 * Accepts output such as "2.1.170 (Claude Code)", "gh version 2.40.0 (...)",
 * or "v1.2.3". Returns null when no semver-shaped token is present.
 */ export function parseSemver(text) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ];
}
/**
 * Compare two semver triples numerically per segment (Issue #2622).
 *
 * Returns a negative number when `a < b`, zero when equal, positive when
 * `a > b`. The comparison is numeric per segment, so 2.1.170 > 2.1.9 — a plain
 * string comparison would wrongly order these.
 */ export function compareSemver(a, b) {
  for(let i = 0; i < 3; i++){
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
/**
 * Determine whether installed version output is below a required floor (Issue #2622).
 *
 * Returns:
 *  - `true`  — installed version is strictly below the floor.
 *  - `false` — installed version is at or above the floor.
 *  - `null`  — the installed output or floor could not be parsed (the caller
 *              should fall back to interval behaviour with a warning).
 */ export function isVersionBelowFloor(installedOutput, floor) {
  const installed = parseSemver(installedOutput);
  const required = parseSemver(floor);
  if (!installed || !required) return null;
  return compareSemver(installed, required) < 0;
}
/**
 * Record the time of the most recent floor-triggered update attempt for a tool
 * (Issue #2622).
 *
 * Gates repeat floor updates so a tool that cannot reach its floor does not
 * retry-loop every iteration — the next floor attempt waits for the normal
 * interval to elapse.
 */ export function recordFloorUpdateAttempt(timestampDir, tool, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  const tsFile = `${timestampDir}/.last_floor_update_attempt_${tool}`;
  try {
    Deno.writeTextFileSync(tsFile, String(nowFn()));
    return {
      ok: true,
      value: undefined
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err))
    };
  }
}
/**
 * Whether a floor-triggered update may be attempted for a tool (Issue #2622).
 *
 * Returns true when no floor attempt has been recorded within `intervalSeconds`
 * (or the record is missing/invalid). This reuses the existing interval as a
 * backoff so an unreachable floor does not retry every iteration.
 */ export function shouldAttemptFloorUpdate(timestampDir, tool, intervalSeconds = DEFAULT_UPDATE_INTERVAL_SECONDS, nowFn = ()=>Math.floor(Date.now() / 1000)) {
  assertPositiveSeconds(intervalSeconds, "update interval");
  const tsFile = `${timestampDir}/.last_floor_update_attempt_${tool}`;
  let content;
  try {
    content = Deno.readTextFileSync(tsFile).trim();
  } catch  {
    return true;
  }
  if (!/^\d+$/.test(content)) return true;
  const last = parseInt(content, 10);
  return nowFn() - last >= intervalSeconds;
}
/**
 * Build the default installed-version reader (Issue #2622).
 *
 * Spawns the tool's `--version` command and returns its combined output, or
 * null when the tool is unknown or the command fails.
 */ function makeVersionReader(runFn) {
  return async (tool)=>{
    const cmd = VERSION_COMMANDS[tool];
    if (!cmd) return null;
    const result = await runFn([
      ...cmd
    ], 10);
    if (!result.ok || result.value.exitCode !== 0) return null;
    return result.value.output;
  };
}
/**
 * Re-read a tool's version after a floor-triggered update and warn if the
 * required floor is still unmet (Issue #2622).
 *
 * A still-below-floor result is a permanent-failure signal: it is logged once
 * (naming the tool, installed version, and required floor) and not retried
 * until the interval elapses — the caller has already recorded a floor attempt.
 */ async function verifyFloorAfterUpdate(logger, tool, floor, readVersion) {
  const output = await readVersion(tool);
  if (output === null) {
    logger.warn(`Could not re-read ${tool} version after a floor-triggered update (required floor ${floor})`);
    return;
  }
  const below = isVersionBelowFloor(output, floor);
  if (below === null) {
    logger.warn(`Could not parse ${tool} version "${output.trim()}" after a floor-triggered update (required floor ${floor})`);
    return;
  }
  if (below) {
    const installed = parseSemver(output);
    logger.warn(`${tool} is still below the required version floor ${floor} after updating (installed ${installed ? installed.join(".") : output.trim()}) — floor unmet; will not retry until the interval elapses`);
  } else {
    logger.info(`${tool} now meets the required version floor ${floor}`);
  }
}
/**
 * Orchestrate the software update check (Issues #906, #1496, #2622, #625).
 *
 * Under `update_mode: "frozen"` (Issue #625) the three tools are installed at
 * their configured `pinned_tool_versions` and nothing below applies: no
 * interval, no floor, no release-age quarantine. Everything that follows
 * describes the `dynamic` default, which is unchanged.
 *
 * Runs an update for a tool when *either* the interval has elapsed *or* the
 * installed version is below a configured floor (`minVersions`). The interval
 * gate is the weekly cadence (timestamp file); the floor gate bypasses it so a
 * known-too-old tool (e.g. Claude CLI lacking `--model fable` support) updates
 * immediately rather than waiting up to a week.
 *
 * Floor handling:
 *  - Below floor + (interval elapsed OR no recent floor attempt) → force update.
 *  - After a floor-triggered update, the version is re-read; still-below-floor
 *    is logged as a permanent failure and not retried until the interval
 *    elapses (a floor-attempt timestamp provides the backoff).
 *  - Unparseable version output falls back to interval behaviour with a warning
 *    and never blocks the worker.
 *  - A skip flag (e.g. SKIP_CLAUDE_UPDATE) still wins, but logs that a version
 *    floor is unmet when it suppresses a floor-triggered update.
 *
 * The global weekly timestamp is only recorded when the interval actually
 * elapsed, so a floor-only trigger does not skip the next weekly gh/deno check.
 */ export async function checkSoftwareUpdates(logger, options = {}) {
  // Defence in depth for Issue #4062: the bootstrap gates its call on
  // skipSoftwareUpdateFromEnv, but other callers (run-core's periodic path)
  // reached this entry directly and ran the weekly check inside the
  // container. The image is the update mechanism, so the gate lives here,
  // covering every caller.
  if (skipSoftwareUpdateFromEnv(options.env)) {
    // Debug, not info (Issue #4212): in container mode this is a permanent
    // fact of the deployment, and stating it every cycle is pure log noise.
    logger.debug("Software updates suppressed: inside the worker container the image " + "is the update mechanism (Issue #4062), or SKIP_SOFTWARE_UPDATE is " + "set");
    return {
      status: "suppressed",
      attempted: [],
      skipped: [],
      failed: []
    };
  }
  const timestampDir = options.timestampDir ?? Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_UPDATE_INTERVAL_SECONDS;
  const timeout = options.timeout ?? DEFAULT_UPDATE_TIMEOUT_SECONDS;
  // Issue #1270: refuse a NaN or non-positive duration here rather than
  // letting it reach the interval comparison and `setTimeout`, where it
  // silently turns the gate permanently closed and aborts every install
  // while the run still reports success.
  assertPositiveSeconds(intervalSeconds, "update interval");
  assertPositiveSeconds(timeout, "update timeout");
  const nowFn = options.now ?? (()=>Math.floor(Date.now() / 1000));
  const minVersions = options.minVersions ?? {};
  const readVersion = options.readVersion ?? makeVersionReader(options.retry?.runFn ?? runWithTimeout);
  const toolOpts = {
    timeout,
    retry: options.retry,
    timestampDir,
    now: nowFn,
    quarantineHours: options.quarantineHours,
    ageGate: options.ageGate
  };
  const skips = {
    claude: options.skipClaude ?? false,
    gh: options.skipGh ?? false,
    deno: options.skipDeno ?? false
  };
  // Frozen hosts install their pins on every launch (Issue #625). The interval
  // and floor gates below are dynamic-mode machinery: a pin is the operator's
  // recorded decision, and editing `pinned_tool_versions` by hand is the
  // supported way to move a frozen host, so the edit has to take effect on the
  // next launch rather than at the end of the weekly cadence. Each install is a
  // no-op once the tool reports its pinned version, so running every launch
  // costs one `--version` read per tool.
  if (options.updateMode === "frozen") {
    const frozen = await installFrozenToolVersions(logger, options.pinnedToolVersions ?? {}, toolOpts, skips);
    return {
      status: "frozen",
      ...frozen,
      failed: []
    };
  }
  const intervalElapsed = shouldCheckForUpdates(timestampDir, intervalSeconds, nowFn);
  // Evaluate version floors (Issue #2622). A tool below its floor is updated
  // immediately, bypassing the interval gate; unparseable versions fall back
  // to interval behaviour with a warning.
  const belowFloor = new Map(); // tool -> floor
  const floorTriggered = new Set();
  for (const [tool, floor] of Object.entries(minVersions)){
    if (!floor) continue;
    const output = await readVersion(tool);
    if (output === null) {
      logger.warn(`Could not read ${tool} version for floor check (floor ${floor}) — using interval behaviour`);
      continue;
    }
    const below = isVersionBelowFloor(output, floor);
    if (below === null) {
      logger.warn(`Could not parse ${tool} version from "${output.trim()}" for floor ${floor} — using interval behaviour`);
      continue;
    }
    if (!below) continue;
    belowFloor.set(tool, floor);
    if (intervalElapsed || shouldAttemptFloorUpdate(timestampDir, tool, intervalSeconds, nowFn)) {
      floorTriggered.add(tool);
      logger.info(`${tool} installed version is below required floor ${floor} — forcing update`);
    } else {
      logger.info(`${tool} is below floor ${floor} but a floor update was attempted recently — deferring until the interval elapses`);
    }
  }
  if (!intervalElapsed && floorTriggered.size === 0) {
    logger.info("Software updates checked recently — skipping");
    return {
      status: "not-due",
      attempted: [],
      skipped: [],
      failed: []
    };
  }
  logger.info(intervalElapsed ? "Running weekly software update check..." : `Running floor-triggered software update (${[
    ...floorTriggered
  ].join(", ")})...`);
  const attempted = [];
  const skipped = [];
  const failed = [];
  // Preserve the historical claude → gh → deno ordering.
  for (const tool of UPDATE_TOOLS){
    if (!(intervalElapsed || floorTriggered.has(tool))) continue;
    const skip = skips[tool] ?? false;
    const floor = belowFloor.get(tool);
    if (skip && floor !== undefined) {
      logger.warn(`${tool} is below the required version floor ${floor} but the update is suppressed (${SKIP_ENV_NAME[tool] ?? "skip flag"})`);
    }
    (skip ? skipped : attempted).push(tool);
    if (!await TOOL_UPDATERS[tool](logger, {
      ...toolOpts,
      skip
    })) {
      failed.push(tool);
    }
    if (floorTriggered.has(tool)) {
      // Record the attempt regardless of outcome so an unreachable floor does
      // not retry-loop every iteration.
      recordFloorUpdateAttempt(timestampDir, tool, nowFn);
      if (!skip && floor !== undefined) {
        await verifyFloorAfterUpdate(logger, tool, floor, readVersion);
      }
    }
  }
  // Only the full weekly cadence resets the global interval timestamp; a
  // floor-only trigger must not skip the next weekly gh/deno check.
  if (intervalElapsed) {
    recordUpdateCheck(timestampDir, nowFn);
  }
  // Issue #1270: an update that was attempted and failed is stated, not left
  // to a warning buried in the middle of the log. The worker still continues
  // — the caller decides what a failed tool update means for its own exit
  // status.
  if (failed.length > 0) {
    logger.error(`Software update failed for: ${failed.join(", ")} — the host is still ` + `running the versions it had`);
  }
  logger.info(intervalElapsed ? "Weekly software update check complete" : "Floor-triggered software update complete");
  return {
    status: "ran",
    attempted,
    skipped,
    failed
  };
}
/** Read an optional positive integer from the environment. */ function envInt(getEnv, name) {
  const raw = getEnv(name);
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return undefined;
  return parseInt(raw, 10);
}
/**
 * Build the software-update options every production entry point uses
 * (Issue #3655).
 *
 * Three callers previously assembled this option set by hand — the run-core
 * production deps, the `run-bootstrap` command, and (not at all) the
 * `run-entrypoint` driver. The driver's omission meant the documented
 * `SKIP_CLAUDE_UPDATE` / `SKIP_GH_UPDATE` / `SKIP_DENO_UPDATE` opt-outs were
 * never consulted on the primary path: setting them did not stop the upgrade
 * the worker performed at startup. One shared builder keeps the three paths
 * from drifting apart again.
 */ export function softwareUpdateOptionsFromEnv(config = {}, getEnv = (name)=>Deno.env.get(name)) {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? ".";
  return {
    timestampDir: getEnv("SOFTWARE_UPDATE_TIMESTAMP_DIR") ?? home,
    intervalSeconds: envInt(getEnv, "SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS"),
    timeout: envInt(getEnv, "CLAUDE_UPDATE_TIMEOUT"),
    minVersions: config.softwareMinVersions,
    skipClaude: getEnv("SKIP_CLAUDE_UPDATE") === "true",
    skipGh: getEnv("SKIP_GH_UPDATE") === "true",
    skipDeno: getEnv("SKIP_DENO_UPDATE") === "true",
    quarantineHours: envInt(getEnv, "VIBE_BUMP_QUARANTINE_HOURS"),
    // Issue #625: the mode and its pins reach every entry point through this
    // one builder, so a frozen host installs its pins on whichever path
    // launched it.
    updateMode: config.updateMode,
    pinnedToolVersions: config.pinnedToolVersions,
    retry: {
      maxAttempts: config.updateRetryMaxAttempts,
      backoffSeconds: config.updateRetryBackoffSeconds
    }
  };
}
/**
 * Whether the whole software-update step is suppressed (Issue #3655).
 *
 * Always suppressed inside the worker container (the image stamps
 * VIBE_IMAGE_AGENT_PROVIDERS): the image is the update mechanism
 * (Issue #4062) — every tool version is pinned and checksum-verified at
 * build time, so a run-time self-update would install unpinned packages
 * into an ephemeral VM, repeat on every run, and sit outside the image's
 * supply-chain guarantees. Bumping the pin in container/tools.json and the
 * Containerfile changes the tag and rebuilds instead.
 */ export function skipSoftwareUpdateFromEnv(getEnv = (name)=>Deno.env.get(name)) {
  if (getEnv("SKIP_SOFTWARE_UPDATE") === "true") return true;
  // By value, not presence: a blank stamp is a host run, which still needs
  // the update step (Issue #1493).
  return runningInContainerImage(getEnv);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zb2Z0d2FyZV91cGRhdGVzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU29mdHdhcmUgdXBkYXRlIGNoZWNraW5nIGZvciBDbGF1ZGUgQ0xJLCBHSCBDTEksIGFuZCBEZW5vIChJc3N1ZSAjMjk0LCAjMzczLCAjOTA2LCAjMTQ5NikuXG4gKlxuICogQ2hlY2tzIGZvciBzb2Z0d2FyZSB1cGRhdGVzIHBlcmlvZGljYWxseSAoZGVmYXVsdDogd2Vla2x5KS4gVXNlcyBhIHRpbWVzdGFtcFxuICogZmlsZSB0byB0cmFjayB0aGUgbGFzdCBjaGVjayB0aW1lLiBJbmRpdmlkdWFsIHVwZGF0ZSBjb21tYW5kcyByZXRyeSBvblxuICogdHJhbnNpZW50IGZhaWx1cmVzIHdpdGggZXhwb25lbnRpYWwgYmFja29mZiAoSXNzdWUgIzE0OTYpLiBQZXJtYW5lbnQgZmFpbHVyZXNcbiAqIChhdXRoLCBtaXNzaW5nIGJpbmFyeSwgdW5zdXBwb3J0ZWQgcGxhdGZvcm0pIGFyZSBub3QgcmV0cmllZC4gRmluYWwgZmFpbHVyZXNcbiAqIGFyZSBsb2dnZWQgYXMgd2FybmluZ3MgYnV0IGRvIG5vdCBwcm9wYWdhdGUg4oCUIHRoZSB3b3JrZXIgY29udGludWVzIHJlZ2FyZGxlc3MuXG4gKlxuICogRXZlcnkgdXBncmFkZSBpcyBhZGRpdGlvbmFsbHkgZ2F0ZWQgb24gYSAqKnJlbGVhc2UtYWdlIHF1YXJhbnRpbmUqKiAoSXNzdWVcbiAqICMzNjU1KTogdGhlIGNhbmRpZGF0ZSByZWxlYXNlIG11c3QgaGF2ZSBiZWVuIHB1Ymxpc2hlZCBhdCBsZWFzdFxuICogYFZJQkVfQlVNUF9RVUFSQU5USU5FX0hPVVJTYCAoZGVmYXVsdCAyNGgpIGFnbywgbWF0Y2hpbmcgdGhlIGVtYmFyZ28gdGhpc1xuICogcmVwb3NpdG9yeSBhbHJlYWR5IGFwcGxpZXMgdG8gZXZlcnkgb3RoZXIgZXh0ZXJuYWwgZWNvc3lzdGVtLiBgZ2hgIGV4dGVuc2lvbnNcbiAqIGFyZSBlbnVtZXJhdGVkIGFuZCBnYXRlZCBpbmRpdmlkdWFsbHkgcmF0aGVyIHRoYW4gdXBncmFkZWQgd2hvbGVzYWxlLCBhbmQgdGhlXG4gKiBEZW5vIHVwZ3JhZGUgaXMgcGlubmVkIHRvIHRoZSByZXNvbHZlZCB2ZXJzaW9uIHNvIHRoZSBhcnRlZmFjdCBpbnN0YWxsZWQgaXNcbiAqIHRoZSBvbmUgdGhhdCB3YXMgYWdlLWNoZWNrZWQuIEVhY2ggYGdoYCBleHRlbnNpb24gaXMgbGlrZXdpc2UgaW5zdGFsbGVkIGF0XG4gKiB0aGUgZXhhY3QgcmVmIGl0cyB2ZXJkaWN0IGRhdGVkIChJc3N1ZSAjMzk1Mikg4oCUIGEgcmVsZWFzZSB0YWcgZm9yIGEgYmluYXJ5XG4gKiBleHRlbnNpb24sIHRoZSBkZWZhdWx0IGJyYW5jaCdzIEhFQUQgc2hhIGZvciBhIHNjcmlwdCBvbmUuIFNlZVxuICogYHRvb2xfcmVsZWFzZV9hZ2UudHNgLlxuICpcbiAqIEEgY2FsbGVyIG1heSBpbnN0ZWFkIGFzayBmb3Igb25lICoqZXhhY3QgdmVyc2lvbioqIHRocm91Z2hcbiAqIGB0YXJnZXRWZXJzaW9uYCAoSXNzdWUgIzYyMykuIFRoYXQgcGF0aCBpbnN0YWxscyB0aGUgcHVibGlzaGVkIGFydGVmYWN0IGZvclxuICogdGhhdCB2ZXJzaW9uIOKAlCB0aGUgbnBtIHRhcmJhbGwgZm9yIHRoZSBDbGF1ZGUgQ0xJLCB0aGUgYGNsaS9jbGlgIHJlbGVhc2VcbiAqIGFyY2hpdmUgZm9yIGBnaGAsIGBkZW5vIHVwZ3JhZGUgPHZlcnNpb24+YCBmb3IgRGVubyDigJQgbGVhdmVzIGEgdG9vbCBhbHJlYWR5XG4gKiBhdCB0aGF0IHZlcnNpb24gYWxvbmUsIGFuZCB0aHJvd3Mgd2hlbiB0aGUgdmVyc2lvbiBhZnRlcndhcmRzIGRvZXMgbm90IG1hdGNoLlxuICogVGhlIGFnZSBnYXRlIHN0YXlzIGV4YWN0bHkgYXMgaXQgd2FzIGZvciB0aGUgdW5waW5uZWQgXCJsYXRlc3RcIiBwYXRoLCB3aGljaCBpc1xuICogc3RpbGwgd2hhdCBhIGNhbGxlciBnZXRzIHdoZW4gYHRhcmdldFZlcnNpb25gIGlzIGFic2VudC5cbiAqXG4gKiBgY2hlY2tTb2Z0d2FyZVVwZGF0ZXNgIHBpY2tzIGJldHdlZW4gdGhlIHR3byBmcm9tIGB1cGRhdGVfbW9kZWAgKElzc3VlICM2MjUpOlxuICogYGR5bmFtaWNgIOKAlCB0aGUgZGVmYXVsdCDigJQgYmVoYXZlcyBleGFjdGx5IGFzIGl0IGFsd2F5cyBoYXMsIHdoaWxlIGBmcm96ZW5gXG4gKiBpbnN0YWxscyB0aGUgZXhhY3QgYHBpbm5lZF90b29sX3ZlcnNpb25zYCBmb3IgYWxsIHRocmVlIHRvb2xzIG9uIGV2ZXJ5XG4gKiBsYXVuY2gsIGFoZWFkIG9mIHRoZSBpbnRlcnZhbCBhbmQgZmxvb3IgZ2F0ZXMuXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBMb2dnZXIsXG4gIFBpbm5lZFRvb2xWZXJzaW9ucyxcbiAgUmVzdWx0LFxuICBVcGRhdGVNb2RlLFxufSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIENMQVVERV9DTElfTlBNX1BBQ0tBR0UsXG4gIGNyZWF0ZVJlbGVhc2VBZ2VHYXRlLFxuICBERU5PX1JFTEVBU0VfUkVQTyxcbiAgR0hfQ0xJX1JFTEVBU0VfUkVQTyxcbiAgTlBNX1JFR0lTVFJZX0JBU0UsXG4gIHBhcnNlR2hFeHRlbnNpb25MaXN0LFxuICB0eXBlIFJlbGVhc2VBZ2VHYXRlLFxuICB0eXBlIFJlbGVhc2VBZ2VWZXJkaWN0LFxuICB0eXBlIFJlbGVhc2VDaGFubmVsLFxufSBmcm9tIFwiLi90b29sX3JlbGVhc2VfYWdlLnRzXCI7XG5pbXBvcnQgeyBzcGF3bkdoIH0gZnJvbSBcIi4vZ2hfc3Bhd24udHNcIjtcbmltcG9ydCB7IHJ1bm5pbmdJbkNvbnRhaW5lckltYWdlIH0gZnJvbSBcIi4vY29udGFpbmVyX3N0YW1wLnRzXCI7XG5pbXBvcnQge1xuICBXcml0ZVJlcG9CbG9ja2VkRXJyb3IsXG4gIFdyaXRlVGFyZ2V0VW5kZXRlcm1pbmFibGVFcnJvcixcbn0gZnJvbSBcIi4vd3JpdGVfcmVwb19hbGxvd2xpc3QudHNcIjtcblxuLyoqIERlZmF1bHQgdXBkYXRlIGNoZWNrIGludGVydmFsOiA3IGRheXMgaW4gc2Vjb25kcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1VQREFURV9JTlRFUlZBTF9TRUNPTkRTID0gNjA0ODAwO1xuXG4vKiogRGVmYXVsdCB0aW1lb3V0IGZvciBlYWNoIHVwZGF0ZSBjb21tYW5kIGluIHNlY29uZHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9VUERBVEVfVElNRU9VVF9TRUNPTkRTID0gMTIwO1xuXG4vKiogRGVmYXVsdCBtYXhpbXVtIHJldHJ5IGF0dGVtcHRzIGZvciBhIHNpbmdsZSB1cGRhdGUgY29tbWFuZCAoSXNzdWUgIzE0OTYpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfVVBEQVRFX1JFVFJZX01BWF9BVFRFTVBUUyA9IDM7XG5cbi8qKlxuICogRGVmYXVsdCBleHBvbmVudGlhbCBiYWNrb2ZmIGRlbGF5cyBpbiBzZWNvbmRzIGJldHdlZW4gcmV0cmllcyAoSXNzdWUgIzE0OTYpLlxuICpcbiAqIEVudHJ5IGBpYCBpcyB0aGUgZGVsYXkgdG8gd2FpdCBBRlRFUiBhdHRlbXB0IGBpKzFgIGZhaWxlZCAoYmVmb3JlIGF0dGVtcHRcbiAqIGBpKzJgKS4gVGhlIGxhc3QgZW50cnkgaXMgcmV1c2VkIGlmIHRoZXJlIGFyZSBtb3JlIHJldHJpZXMgdGhhbiBlbnRyaWVzLlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9VUERBVEVfUkVUUllfQkFDS09GRl9TRUNPTkRTOiByZWFkb25seSBudW1iZXJbXSA9IFtcbiAgMzAsXG4gIDkwLFxuICAzMDAsXG5dO1xuXG4vKiogQ2xhc3NpZmljYXRpb24gb2YgYW4gdXBkYXRlIGNvbW1hbmQgZmFpbHVyZSAoSXNzdWUgIzE0OTYpLiAqL1xuZXhwb3J0IHR5cGUgVXBkYXRlRXJyb3JDbGFzcyA9IFwidHJhbnNpZW50XCIgfCBcInBlcm1hbmVudFwiO1xuXG4vKipcbiAqIFdoYXQgb25lIHtAbGluayBjaGVja1NvZnR3YXJlVXBkYXRlc30gcnVuIGFjdHVhbGx5IGRpZCAoSXNzdWUgIzEyNzApLlxuICpcbiAqIFRoZSBydW4gdXNlZCB0byByZXBvcnQgbm90aGluZyBhdCBhbGwsIHNvIGEgY2FsbGVyIGNvdWxkIG5vdCB0ZWxsIGEgd2Vla2x5XG4gKiBjaGVjayB0aGF0IHVwZ3JhZGVkIHRocmVlIHRvb2xzIGZyb20gb25lIHRoYXQgYXR0ZW1wdGVkIG5vdGhpbmcsIG9yIGZyb20gb25lXG4gKiB3aG9zZSBldmVyeSBpbnN0YWxsIGZhaWxlZCDigJQgYWxsIHRocmVlIGVuZGVkIGluIFwiY2hlY2sgY29tcGxldGVcIi4gVGhlIGNhbGxlclxuICogbm93IGdldHMgdGhlIGZhY3RzIGFuZCBkZWNpZGVzIGl0cyBvd24gZXhpdCBzdGF0dXMgZnJvbSB0aGVtLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNvZnR3YXJlVXBkYXRlUnVuT3V0Y29tZSB7XG4gIC8qKlxuICAgKiBgc3VwcHJlc3NlZGAg4oCUIHRoZSB3aG9sZSBzdGVwIGlzIG9mZiAoY29udGFpbmVyIGltYWdlIC8gU0tJUF9TT0ZUV0FSRV9VUERBVEUpO1xuICAgKiBgZnJvemVuYCDigJQgdGhlIGhvc3QgaW5zdGFsbGVkIGl0cyBwaW5uZWQgdmVyc2lvbnM7XG4gICAqIGBub3QtZHVlYCDigJQgdGhlIGludGVydmFsIGhhcyBub3QgZWxhcHNlZCBhbmQgbm8gdmVyc2lvbiBmbG9vciBmb3JjZWQgYSBydW47XG4gICAqIGByYW5gIOKAlCB0aGUgdXBkYXRlIHBhc3MgZXhlY3V0ZWQuXG4gICAqL1xuICBzdGF0dXM6IFwic3VwcHJlc3NlZFwiIHwgXCJmcm96ZW5cIiB8IFwibm90LWR1ZVwiIHwgXCJyYW5cIjtcbiAgLyoqIFRvb2xzIHdob3NlIHVwZGF0ZSB3YXMgYWN0dWFsbHkgYXR0ZW1wdGVkLiAqL1xuICBhdHRlbXB0ZWQ6IHN0cmluZ1tdO1xuICAvKiogVG9vbHMgd2hvc2UgdXBkYXRlIGFuIGV4cGxpY2l0IHNraXAgZmxhZyBzdXBwcmVzc2VkLiAqL1xuICBza2lwcGVkOiBzdHJpbmdbXTtcbiAgLyoqIFRvb2xzIHdob3NlIGF0dGVtcHRlZCB1cGRhdGUgZmFpbGVkIGFmdGVyIGl0cyByZXRyaWVzIHdlcmUgZXhoYXVzdGVkLiAqL1xuICBmYWlsZWQ6IHN0cmluZ1tdO1xufVxuXG4vKiogT3B0aW9ucyBmb3Igc29mdHdhcmUgdXBkYXRlIGNoZWNraW5nLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTb2Z0d2FyZVVwZGF0ZU9wdGlvbnMge1xuICAvKiogRGlyZWN0b3J5IGZvciB0aGUgdGltZXN0YW1wIGZpbGUgKGRlZmF1bHQ6IEhPTUUpLiAqL1xuICB0aW1lc3RhbXBEaXI/OiBzdHJpbmc7XG4gIC8qKiBVcGRhdGUgY2hlY2sgaW50ZXJ2YWwgaW4gc2Vjb25kcyAoZGVmYXVsdDogNjA0ODAwID0gNyBkYXlzKS4gKi9cbiAgaW50ZXJ2YWxTZWNvbmRzPzogbnVtYmVyO1xuICAvKiogU2tpcCBDbGF1ZGUgQ0xJIHVwZGF0ZS4gKi9cbiAgc2tpcENsYXVkZT86IGJvb2xlYW47XG4gIC8qKiBTa2lwIEdIIENMSSB1cGRhdGUuICovXG4gIHNraXBHaD86IGJvb2xlYW47XG4gIC8qKiBTa2lwIERlbm8gdXBkYXRlLiAqL1xuICBza2lwRGVubz86IGJvb2xlYW47XG4gIC8qKiBUaW1lb3V0IHBlciB1cGRhdGUgY29tbWFuZCBpbiBzZWNvbmRzIChkZWZhdWx0OiAxMjApLiAqL1xuICB0aW1lb3V0PzogbnVtYmVyO1xuICAvKiogSW5qZWN0YWJsZSB0aW1lIHNvdXJjZSBmb3IgdGVzdGluZyAocmV0dXJucyBVbml4IHNlY29uZHMpLiAqL1xuICBub3c/OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZXRyeSBjb25maWd1cmF0aW9uIHBhc3NlZCB0aHJvdWdoIHRvIGVhY2ggdG9vbCB1cGRhdGUgKElzc3VlICMxNDk2KS4gKi9cbiAgcmV0cnk/OiBVcGRhdGVSZXRyeU9wdGlvbnM7XG4gIC8qKlxuICAgKiBQZXItdG9vbCBtaW5pbXVtIHZlcnNpb24gZmxvb3JzIChJc3N1ZSAjMjYyMikuIFdoZW4gdGhlIGluc3RhbGxlZCB2ZXJzaW9uXG4gICAqIG9mIGEgdG9vbCBpcyBiZWxvdyBpdHMgZmxvb3IsIHRoZSB1cGRhdGUgcnVucyBpbW1lZGlhdGVseSwgYnlwYXNzaW5nIHRoZVxuICAgKiBpbnRlcnZhbCB0aW1lc3RhbXAgZ2F0ZS4gRW1wdHkgd2hlbiB0aGUgY2FsbGVyIHBhc3NlcyBub3RoaW5nOyB0aGUgd29ya2VyXG4gICAqIHBhc3NlcyBgT1BFUkFUSU9OQUxfREVGQVVMVFMuc29mdHdhcmVNaW5WZXJzaW9uc2AsIHdoaWNoIGlzIHRoZSBtYXAnc1xuICAgKiBzaW5nbGUgc291cmNlIG9mIHRydXRoIChgeyBjbGF1ZGU6IFwiMi4xLjI2MFwiIH1gIHRvZGF5KS5cbiAgICovXG4gIG1pblZlcnNpb25zPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgLyoqXG4gICAqIEluamVjdGFibGUgaW5zdGFsbGVkLXZlcnNpb24gcmVhZGVyIGZvciB0ZXN0aW5nIChJc3N1ZSAjMjYyMikuIEdpdmVuIGFcbiAgICogdG9vbCBuYW1lIGl0IHJldHVybnMgdGhlIHJhdyBgLS12ZXJzaW9uYCBvdXRwdXQgKGUuZy4gXCIyLjEuMTcwIChDbGF1ZGVcbiAgICogQ29kZSlcIikgb3IgbnVsbCB3aGVuIHRoZSB2ZXJzaW9uIGNvdWxkIG5vdCBiZSByZWFkLiBEZWZhdWx0cyB0byBzcGF3bmluZ1xuICAgKiB0aGUgdG9vbCdzIGAtLXZlcnNpb25gIGNvbW1hbmQuXG4gICAqL1xuICByZWFkVmVyc2lvbj86ICh0b29sOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBSZWxlYXNlLWFnZSBxdWFyYW50aW5lIHdpbmRvdyBpbiBob3VycyAoSXNzdWUgIzM2NTUpLiBEZWZhdWx0cyB0byAyNCBhbmRcbiAgICogbWlycm9ycyBgVklCRV9CVU1QX1FVQVJBTlRJTkVfSE9VUlNgOyBhIG5vbi1wb3NpdGl2ZSBvciB1bnBhcnNlYWJsZSB2YWx1ZVxuICAgKiBmYWxscyBiYWNrIHRvIHRoZSBkZWZhdWx0IHJhdGhlciB0aGFuIGRpc2FibGluZyB0aGUgZW1iYXJnby5cbiAgICovXG4gIHF1YXJhbnRpbmVIb3Vycz86IG51bWJlcjtcbiAgLyoqXG4gICAqIEluamVjdGFibGUgcmVsZWFzZS1hZ2UgZ2F0ZSAoSXNzdWUgIzM2NTUpLiBEZWZhdWx0cyB0byB0aGUgcmVhbCB1cHN0cmVhbVxuICAgKiBnYXRlIChgZ2ggYXBpYCBmb3IgR2l0SHViIHJlbGVhc2VzLCB0aGUgbnBtIHJlZ2lzdHJ5IGZvciB0aGUgQ2xhdWRlIENMSSkuXG4gICAqL1xuICBhZ2VHYXRlPzogUmVsZWFzZUFnZUdhdGU7XG4gIC8qKiBJbmplY3RhYmxlIGVudmlyb25tZW50IGxvb2t1cCAodGVzdHMgaW5qZWN0IGEgZml4ZWQgbWFwKS4gKi9cbiAgZW52PzogKG5hbWU6IHN0cmluZykgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogSG93IHRoaXMgaG9zdCB0cmFja3MgcmVsZWFzZXMgKElzc3VlICM2MjUsIGAuY29uZmlnLmpzb25gIGB1cGRhdGVfbW9kZWApLlxuICAgKiBBYnNlbnQgb3IgYFwiZHluYW1pY1wiYCBsZWF2ZXMgZXZlcnkgcGF0aCBleGFjdGx5IGFzIGl0IHdhczsgYFwiZnJvemVuXCJgXG4gICAqIGluc3RhbGxzIHtAbGluayBwaW5uZWRUb29sVmVyc2lvbnN9IGluc3RlYWQgb2YgY2hlY2tpbmcgZm9yIHVwZGF0ZXMuXG4gICAqL1xuICB1cGRhdGVNb2RlPzogVXBkYXRlTW9kZTtcbiAgLyoqXG4gICAqIEV4YWN0IHZlcnNpb25zIGEgYGZyb3plbmAgaG9zdCBpbnN0YWxscyAoSXNzdWUgIzYyNSwgYC5jb25maWcuanNvbmBcbiAgICogYHBpbm5lZF90b29sX3ZlcnNpb25zYCkuIElnbm9yZWQgaW4gYGR5bmFtaWNgIG1vZGUsIHNvIGEgaG9zdCB0aGF0IGZsaXBwZWRcbiAgICogYmFjayBrZWVwcyBpdHMgc3RhbGUgcGlucyB3aXRob3V0IGFjdGluZyBvbiB0aGVtLlxuICAgKi9cbiAgcGlubmVkVG9vbFZlcnNpb25zPzogUGlubmVkVG9vbFZlcnNpb25zO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiBleGVjdXRpbmcgYW4gdXBkYXRlIGNvbW1hbmQgKHBvc3NpYmx5IGFjcm9zcyBtdWx0aXBsZSByZXRyaWVzKS5cbiAqIElzc3VlICMxNDk2LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1blVwZGF0ZVJlc3VsdCB7XG4gIC8qKiBXaGV0aGVyIHRoZSB1cGRhdGUgdWx0aW1hdGVseSBzdWNjZWVkZWQuICovXG4gIHN1Y2Nlc3M6IGJvb2xlYW47XG4gIC8qKiBOdW1iZXIgb2YgYXR0ZW1wdHMgYWN0dWFsbHkgbWFkZS4gKi9cbiAgYXR0ZW1wdHM6IG51bWJlcjtcbiAgLyoqIEZpbmFsIGV4aXQgY29kZSBvYnNlcnZlZC4gKi9cbiAgZmluYWxFeGl0Q29kZTogbnVtYmVyO1xuICAvKiogRmluYWwgY29tYmluZWQgc3Rkb3V0L3N0ZGVyciBvdXRwdXQgb2JzZXJ2ZWQuICovXG4gIGZpbmFsT3V0cHV0OiBzdHJpbmc7XG4gIC8qKiBDbGFzc2lmaWNhdGlvbiBvZiB0aGUgZmluYWwgZmFpbHVyZSAob25seSBzZXQgb24gZmFpbHVyZSkuICovXG4gIGNsYXNzaWZpY2F0aW9uPzogVXBkYXRlRXJyb3JDbGFzcztcbn1cblxuLyoqIFJldHJ5IGNvbmZpZ3VyYXRpb24gZm9yIGEgc2luZ2xlIHVwZGF0ZSBjb21tYW5kIChJc3N1ZSAjMTQ5NikuICovXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZVJldHJ5T3B0aW9ucyB7XG4gIC8qKiBNYXhpbXVtIG51bWJlciBvZiBhdHRlbXB0cyBpbmNsdWRpbmcgdGhlIGluaXRpYWwgb25lIChkZWZhdWx0OiAzKS4gKi9cbiAgbWF4QXR0ZW1wdHM/OiBudW1iZXI7XG4gIC8qKiBFeHBvbmVudGlhbCBiYWNrb2ZmIGRlbGF5cyBiZXR3ZWVuIHJldHJpZXMgKGRlZmF1bHQ6IFszMCwgOTAsIDMwMF0pLiAqL1xuICBiYWNrb2ZmU2Vjb25kcz86IHJlYWRvbmx5IG51bWJlcltdO1xuICAvKiogVGltZW91dCBwZXIgYXR0ZW1wdCBpbiBzZWNvbmRzIChkZWZhdWx0OiAxMjApLiAqL1xuICB0aW1lb3V0PzogbnVtYmVyO1xuICAvKiogSW5qZWN0YWJsZSBzbGVlcCBmdW5jdGlvbiAoZGVmYXVsdHMgdG8gcmVhbCBzZXRUaW1lb3V0KS4gKi9cbiAgc2xlZXBGbj86IChzZWNvbmRzOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD47XG4gIC8qKlxuICAgKiBJbmplY3RhYmxlIGNvbW1hbmQgcnVubmVyIGZvciB0ZXN0cy4gRGVmYXVsdHMgdG8gYHJ1bldpdGhUaW1lb3V0YCxcbiAgICogd2hpY2ggc3Bhd25zIHRoZSByZWFsIGNvbW1hbmQuXG4gICAqL1xuICBydW5Gbj86IChcbiAgICBjbWQ6IHN0cmluZ1tdLFxuICAgIHRpbWVvdXRTZWNvbmRzOiBudW1iZXIsXG4gICkgPT4gUHJvbWlzZTxSZXN1bHQ8eyBleGl0Q29kZTogbnVtYmVyOyBvdXRwdXQ6IHN0cmluZyB9Pj47XG59XG5cbi8qKlxuICogUmVmdXNlIGEgZHVyYXRpb24gdGhhdCBjYW5ub3QgYmUgY29tcGFyZWQgb3Igd2FpdGVkIG9uIChJc3N1ZSAjMTI3MCkuXG4gKlxuICogYE5hTmAgaXMgdGhlIGRhbmdlcm91cyB2YWx1ZSBoZXJlLCBub3QgYSBuZWdhdGl2ZSBvbmU6IGV2ZXJ5IGNvbXBhcmlzb25cbiAqIGFnYWluc3QgaXQgaXMgYGZhbHNlYCBhbmQgYHNldFRpbWVvdXQoZm4sIE5hTilgIGZpcmVzIGltbWVkaWF0ZWx5LCBzbyBhXG4gKiBgTmFOYCBpbnRlcnZhbCB0dXJucyB0aGUgdXBkYXRlIGdhdGUgcGVybWFuZW50bHkgY2xvc2VkIHdoaWxlIGEgYE5hTmBcbiAqIHRpbWVvdXQgYWJvcnRzIGV2ZXJ5IGluc3RhbGwg4oCUIGJvdGggd2hpbGUgdGhlIGNhbGxlciBzdGlsbCByZXBvcnRzIHN1Y2Nlc3MuXG4gKiBOZWl0aGVyIGlzIHJlY292ZXJhYmxlIGJ5IGd1ZXNzaW5nIGEgZGVmYXVsdCwgc28gdGhlIHZhbHVlIGlzIHJlZnVzZWQuXG4gKlxuICogQHBhcmFtIHZhbHVlIFNlY29uZHMgc3VwcGxpZWQgYnkgYSBjYWxsZXIuXG4gKiBAcGFyYW0gbGFiZWwgT3BlcmF0b3ItZmFjaW5nIG5hbWUgb2YgdGhlIHNldHRpbmcsIGUuZy4gYC0tdGltZW91dGAuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHZhbHVlIGlzIG5vdCBhIGZpbml0ZSwgc3RyaWN0bHkgcG9zaXRpdmUgbnVtYmVyLlxuICovXG5mdW5jdGlvbiBhc3NlcnRQb3NpdGl2ZVNlY29uZHModmFsdWU6IG51bWJlciwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgfHwgdmFsdWUgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBJbnZhbGlkICR7bGFiZWx9OiBleHBlY3RlZCBhIHBvc2l0aXZlIG51bWJlciBvZiBzZWNvbmRzLCBnb3QgYCArXG4gICAgICAgIGAke3ZhbHVlfS4gQSBub24tZmluaXRlIG9yIG5vbi1wb3NpdGl2ZSBkdXJhdGlvbiBpcyByZWZ1c2VkIHJhdGhlciBgICtcbiAgICAgICAgYHRoYW4gcGFzc2VkIG9uIOKAlCBpdCB3b3VsZCBzaWxlbnRseSBkaXNhYmxlIHRoZSBjaGVjayBpdCBjb250cm9scy5gLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiBlbm91Z2ggdGltZSBoYXMgZWxhcHNlZCBzaW5jZSB0aGUgbGFzdCB1cGRhdGUgY2hlY2suXG4gKlxuICogUmVhZHMgdGhlIHRpbWVzdGFtcCBmaWxlIHRvIGRldGVybWluZSB3aGVuIHRoZSBsYXN0IHVwZGF0ZSBjaGVjayBvY2N1cnJlZC5cbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgaW50ZXJ2YWwgaGFzIGVsYXBzZWQsIHRoZSBmaWxlIGlzIG1pc3NpbmcsIG9yIGNvbnRhaW5zXG4gKiBpbnZhbGlkIGNvbnRlbnQuXG4gKlxuICogQHRocm93cyBXaGVuIGBpbnRlcnZhbFNlY29uZHNgIGlzIG5vdCBhIGZpbml0ZSwgcG9zaXRpdmUgbnVtYmVyXG4gKiAgIChJc3N1ZSAjMTI3MCkg4oCUIGBlbGFwc2VkID49IE5hTmAgaXMgYGZhbHNlYCwgc28gYSBgTmFOYCBpbnRlcnZhbCB3b3VsZFxuICogICBvdGhlcndpc2UgY2xvc2UgdGhlIGdhdGUgZm9yZXZlciB3aXRob3V0IGEgd29yZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZENoZWNrRm9yVXBkYXRlcyhcbiAgdGltZXN0YW1wRGlyOiBzdHJpbmcsXG4gIGludGVydmFsU2Vjb25kczogbnVtYmVyID0gREVGQVVMVF9VUERBVEVfSU5URVJWQUxfU0VDT05EUyxcbiAgbm93Rm46ICgpID0+IG51bWJlciA9ICgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuKTogYm9vbGVhbiB7XG4gIGFzc2VydFBvc2l0aXZlU2Vjb25kcyhpbnRlcnZhbFNlY29uZHMsIFwidXBkYXRlIGludGVydmFsXCIpO1xuXG4gIGNvbnN0IHRzRmlsZSA9IGAke3RpbWVzdGFtcERpcn0vLmxhc3Rfc29mdHdhcmVfdXBkYXRlX2NoZWNrYDtcblxuICBsZXQgY29udGVudDogc3RyaW5nO1xuICB0cnkge1xuICAgIGNvbnRlbnQgPSBEZW5vLnJlYWRUZXh0RmlsZVN5bmModHNGaWxlKS50cmltKCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB0cnVlOyAvLyBObyBmaWxlIG1lYW5zIG5ldmVyIGNoZWNrZWRcbiAgfVxuXG4gIGlmICghY29udGVudCB8fCAhL15cXGQrJC8udGVzdChjb250ZW50KSkge1xuICAgIHJldHVybiB0cnVlOyAvLyBJbnZhbGlkIGNvbnRlbnQgbWVhbnMgd2Ugc2hvdWxkIGNoZWNrXG4gIH1cblxuICBjb25zdCBsYXN0Q2hlY2sgPSBwYXJzZUludChjb250ZW50LCAxMCk7XG4gIGNvbnN0IG5vdyA9IG5vd0ZuKCk7XG4gIGNvbnN0IGVsYXBzZWQgPSBub3cgLSBsYXN0Q2hlY2s7XG5cbiAgcmV0dXJuIGVsYXBzZWQgPj0gaW50ZXJ2YWxTZWNvbmRzO1xufVxuXG4vKipcbiAqIFJlY29yZCB0aGUgY3VycmVudCB0aW1lIGFzIHRoZSBsYXN0IHVwZGF0ZSBjaGVjayB0aW1lc3RhbXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRVcGRhdGVDaGVjayhcbiAgdGltZXN0YW1wRGlyOiBzdHJpbmcsXG4gIG5vd0ZuOiAoKSA9PiBudW1iZXIgPSAoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSxcbik6IFJlc3VsdDx2b2lkPiB7XG4gIGNvbnN0IHRzRmlsZSA9IGAke3RpbWVzdGFtcERpcn0vLmxhc3Rfc29mdHdhcmVfdXBkYXRlX2NoZWNrYDtcblxuICB0cnkge1xuICAgIERlbm8ud3JpdGVUZXh0RmlsZVN5bmModHNGaWxlLCBTdHJpbmcobm93Rm4oKSkpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBSZWNvcmQgdGhlIGxhc3Qgc3VjY2Vzc2Z1bCB1cGRhdGUgdGltZXN0YW1wIGZvciBhIGdpdmVuIHRvb2wgKElzc3VlICMxNDk2KS5cbiAqXG4gKiBFYWNoIHRvb2wgKGNsYXVkZSwgZ2gsIGRlbm8pIGdldHMgaXRzIG93biBzbWFsbCBzdGF0ZSBmaWxlIHNvIHNlbGYtaGVhbFxuICogcmV0cmllcyBmb3Igb25lIHRvb2wgZG8gbm90IGNsb2JiZXIgdGhlIHRpbWVzdGFtcCBvZiBhbm90aGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkU3VjY2Vzc2Z1bFVwZGF0ZShcbiAgdGltZXN0YW1wRGlyOiBzdHJpbmcsXG4gIHRvb2w6IHN0cmluZyxcbiAgbm93Rm46ICgpID0+IG51bWJlciA9ICgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuKTogUmVzdWx0PHZvaWQ+IHtcbiAgY29uc3QgdHNGaWxlID0gYCR7dGltZXN0YW1wRGlyfS8ubGFzdF9zdWNjZXNzZnVsX3VwZGF0ZV8ke3Rvb2x9YDtcbiAgdHJ5IHtcbiAgICBEZW5vLndyaXRlVGV4dEZpbGVTeW5jKHRzRmlsZSwgU3RyaW5nKG5vd0ZuKCkpKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVhZCB0aGUgbGFzdCBzdWNjZXNzZnVsIHVwZGF0ZSB0aW1lc3RhbXAgZm9yIGEgZ2l2ZW4gdG9vbCAoSXNzdWUgIzE0OTYpLlxuICpcbiAqIFJldHVybnMgbnVsbCBpZiB0aGUgZmlsZSBpcyBtaXNzaW5nIG9yIGNvbnRhaW5zIGludmFsaWQgY29udGVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldExhc3RTdWNjZXNzZnVsVXBkYXRlKFxuICB0aW1lc3RhbXBEaXI6IHN0cmluZyxcbiAgdG9vbDogc3RyaW5nLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IHRzRmlsZSA9IGAke3RpbWVzdGFtcERpcn0vLmxhc3Rfc3VjY2Vzc2Z1bF91cGRhdGVfJHt0b29sfWA7XG4gIGxldCBjb250ZW50OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgY29udGVudCA9IERlbm8ucmVhZFRleHRGaWxlU3luYyh0c0ZpbGUpLnRyaW0oKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKCEvXlxcZCskLy50ZXN0KGNvbnRlbnQpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHBhcnNlSW50KGNvbnRlbnQsIDEwKTtcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBhbiB1cGRhdGUgY29tbWFuZCBmYWlsdXJlIGFzIHRyYW5zaWVudCBvciBwZXJtYW5lbnQgKElzc3VlICMxNDk2KS5cbiAqXG4gKiBQZXJtYW5lbnQgZmFpbHVyZXMgKGF1dGgsIG1pc3NpbmcgYmluYXJ5LCB1bnN1cHBvcnRlZCBwbGF0Zm9ybSkgc2hvdWxkIG5vdFxuICogYmUgcmV0cmllZCDigJQgdGhlIHNhbWUgZXJyb3Igd2lsbCByZWN1ci4gVHJhbnNpZW50IGZhaWx1cmVzIChuZXR3b3JrXG4gKiB0aW1lb3V0cywgcmF0ZSBsaW1pdHMsIDV4eCkgYXJlIHJldHJpZWQgd2l0aCBiYWNrb2ZmLlxuICpcbiAqIERlZmF1bHRzIHVua25vd24gZmFpbHVyZXMgdG8gXCJ0cmFuc2llbnRcIiBzbyBmbGFreSBub24tZGV0ZXJtaW5hdGUgZXJyb3JzXG4gKiBiZW5lZml0IGZyb20gc2VsZi1oZWFsaW5nIHJhdGhlciB0aGFuIHNraXBwaW5nIGFuIGVudGlyZSB1cGRhdGUgY3ljbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeVVwZGF0ZUVycm9yKFxuICBleGl0Q29kZTogbnVtYmVyLFxuICBvdXRwdXQ6IHN0cmluZyxcbik6IFVwZGF0ZUVycm9yQ2xhc3Mge1xuICAvLyBFeGl0IGNvZGUgMTI3IGlzIHRoZSBjb252ZW50aW9uYWwgXCJjb21tYW5kIG5vdCBmb3VuZFwiIOKAlCBwZXJtYW5lbnQuXG4gIGlmIChleGl0Q29kZSA9PT0gMTI3KSByZXR1cm4gXCJwZXJtYW5lbnRcIjtcblxuICBjb25zdCBsb3dlciA9IG91dHB1dC50b0xvd2VyQ2FzZSgpO1xuXG4gIC8vIE1pc3NpbmcgYmluYXJ5IOKAlCBwZXJtYW5lbnQuXG4gIGlmIChcbiAgICBsb3dlci5pbmNsdWRlcyhcImNvbW1hbmQgbm90IGZvdW5kXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJubyBzdWNoIGZpbGUgb3IgZGlyZWN0b3J5XCIpIHx8XG4gICAgLzogbm90IGZvdW5kJC9tLnRlc3QobG93ZXIpXG4gICkge1xuICAgIHJldHVybiBcInBlcm1hbmVudFwiO1xuICB9XG5cbiAgLy8gQXV0aGVudGljYXRpb24gLyBhdXRob3Jpc2F0aW9uIOKAlCBwZXJtYW5lbnQuXG4gIGlmIChcbiAgICBsb3dlci5pbmNsdWRlcyhcImF1dGhlbnRpY2F0aW9uXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJ1bmF1dGhvcmlzZWRcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcInVuYXV0aG9yaXplZFwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwicGVybWlzc2lvbiBkZW5pZWRcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcIm5vdCBsb2dnZWQgaW5cIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcImFjY2VzcyBkZW5pZWRcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcImZvcmJpZGRlblwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwiaW52YWxpZCBjcmVkZW50aWFsc1wiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwiNDAxIFwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwiNDAzIFwiKVxuICApIHtcbiAgICByZXR1cm4gXCJwZXJtYW5lbnRcIjtcbiAgfVxuXG4gIC8vIFVuc3VwcG9ydGVkIHBsYXRmb3JtIC8gYXJjaGl0ZWN0dXJlIOKAlCBwZXJtYW5lbnQuXG4gIGlmIChcbiAgICBsb3dlci5pbmNsdWRlcyhcInVuc3VwcG9ydGVkIHBsYXRmb3JtXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJwbGF0Zm9ybSBpcyBub3Qgc3VwcG9ydGVkXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJhcmNoaXRlY3R1cmUgbm90IHN1cHBvcnRlZFwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwidW5zdXBwb3J0ZWQgYXJjaGl0ZWN0dXJlXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJub3Qgc3VwcG9ydGVkIG9uIHRoaXNcIilcbiAgKSB7XG4gICAgcmV0dXJuIFwicGVybWFuZW50XCI7XG4gIH1cblxuICAvLyBUaW1lb3V0IGV4aXQgY29kZXMgdXNlZCBieSBydW5XaXRoVGltZW91dCAvIEdOVSB0aW1lb3V0IOKAlCB0cmFuc2llbnQuXG4gIGlmIChleGl0Q29kZSA9PT0gMTI0IHx8IGV4aXRDb2RlID09PSAxMzcpIHJldHVybiBcInRyYW5zaWVudFwiO1xuXG4gIC8vIE5ldHdvcmssIHRpbWVvdXQsIHJhdGUgbGltaXQsIGFuZCA1eHggZmFpbHVyZXMg4oCUIHRyYW5zaWVudC5cbiAgaWYgKFxuICAgIC90aW1lZD9cXHMqb3V0Ly50ZXN0KGxvd2VyKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwidGltZW91dFwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwibmV0d29ya1wiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwiY29ubmVjdGlvbiByZWZ1c2VkXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJjb25uZWN0aW9uIHJlc2V0XCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJjb3VsZCBub3QgcmVzb2x2ZVwiKSB8fFxuICAgIGxvd2VyLmluY2x1ZGVzKFwidGVtcG9yYXJpbHkgdW5hdmFpbGFibGVcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcInNlcnZpY2UgdW5hdmFpbGFibGVcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcInJhdGUgbGltaXRcIikgfHxcbiAgICBsb3dlci5pbmNsdWRlcyhcIjQyOVwiKSB8fFxuICAgIC9odHRwIDVcXGR7Mn0vLnRlc3QobG93ZXIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJ0bHMgaGFuZHNoYWtlXCIpIHx8XG4gICAgbG93ZXIuaW5jbHVkZXMoXCJzc2xfZXJyb3JcIilcbiAgKSB7XG4gICAgcmV0dXJuIFwidHJhbnNpZW50XCI7XG4gIH1cblxuICAvLyBEZWZhdWx0OiB0cmVhdCB1bmtub3duIGZhaWx1cmVzIGFzIHRyYW5zaWVudCBzbyB3ZSBzZWxmLWhlYWwuXG4gIHJldHVybiBcInRyYW5zaWVudFwiO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYW4gZXJyb3IgaXMgdGhlIGBnaGAgY2hva2Vwb2ludCByZWZ1c2luZyB0aGUgY2FsbCAoSXNzdWUgIzEzOTYpLlxuICpcbiAqIE1hdGNoZWQgb24gdGhlIGVycm9yIHR5cGUgcmF0aGVyIHRoYW4gaXRzIG1lc3NhZ2UsIHNvIGEgcmV3b3JkZWQgcmVmdXNhbFxuICogY2Fubm90IHF1aWV0bHkgYmVjb21lIHJldHJ5YWJsZSBhZ2Fpbi5cbiAqL1xuZnVuY3Rpb24gaXNXcml0ZVJlZnVzYWwoZXJyOiBFcnJvcik6IGJvb2xlYW4ge1xuICByZXR1cm4gZXJyIGluc3RhbmNlb2YgV3JpdGVSZXBvQmxvY2tlZEVycm9yIHx8XG4gICAgZXJyIGluc3RhbmNlb2YgV3JpdGVUYXJnZXRVbmRldGVybWluYWJsZUVycm9yO1xufVxuXG4vKiogT25lIGZpbmlzaGVkIHVwZGF0ZSBzdWJwcm9jZXNzLCBob3dldmVyIGl0IHdhcyBzcGF3bmVkLiAqL1xuaW50ZXJmYWNlIFVwZGF0ZUNvbW1hbmRPdXRwdXQge1xuICBjb2RlOiBudW1iZXI7XG4gIHN0ZG91dDogc3RyaW5nO1xuICBzdGRlcnI6IHN0cmluZztcbn1cblxuLyoqXG4gKiBTcGF3biBvbmUgdXBkYXRlIGNvbW1hbmQsIHJvdXRpbmcgYGdoYCB0aHJvdWdoIHRoZSB3b3JrZXIncyBjaG9rZXBvaW50XG4gKiAoSXNzdWUgIzEzOTYpLlxuICpcbiAqIGBydW5XaXRoVGltZW91dGAgcmVhY2hlcyBpdHMgYmluYXJ5IHRocm91Z2ggYGNtZFswXWAsIHNvIHRoZSB0d28gYGdoYCBjYWxsc1xuICogaW4gdGhpcyBtb2R1bGUg4oCUIGBnaCBleHRlbnNpb24gbGlzdGAgYW5kIHRoZSBwaW5uZWRcbiAqIGBnaCBleHRlbnNpb24gaW5zdGFsbGAg4oCUIHNwYXduZWQgb3V0c2lkZSBgc3Bhd25HaGAgYW5kIHNraXBwZWQgdGhlXG4gKiB3cml0ZS1yZXBvIGFsbG93bGlzdCBhbmQgdGhlIGF1ZGl0IGpvdXJuYWwgdGhhdCBldmVyeSBvdGhlciB3b3JrZXIgYGdoYFxuICogY2FsbCBwYXNzZXMgdGhyb3VnaC4gRGlzcGF0Y2hpbmcgb24gdGhlIGJpbmFyeSBuYW1lIGhlcmUgcmUtcm91dGVzIHRoZW0sXG4gKiBhbmQga2VlcHMgYW55IGBnaGAgY29tbWFuZCBhIGZ1dHVyZSBjYWxsZXIgcGFzc2VzIG9uIHRoZSBzYW1lIHBhdGguXG4gKiBgZ2ggZXh0ZW5zaW9uYCB2ZXJicyBjbGFzc2lmeSBhcyBgbm9uLXJlcG9gIGxvY2FsLXRvb2wgbXV0YXRpb25zXG4gKiAoYGF1ZGl0X211dGF0aW9uX2NsYXNzaWZpZXIudHNgKSwgc28gdGhleSBhcmUgam91cm5hbGxlZCByYXRoZXIgdGhhblxuICogcmVmdXNlZCBhcyBhbiB1bmRldGVybWluYWJsZSByZXBvIHdyaXRlLlxuICpcbiAqIEV2ZXJ5IG90aGVyIHRvb2wgKGBicmV3YCwgYGNsYXVkZWAsIGBkZW5vYCwgYG5wbWAsIGB3aGljaGApIGhhcyBub1xuICogY2hva2Vwb2ludCBvZiBpdHMgb3duIGFuZCBpcyBzcGF3bmVkIGRpcmVjdGx5LCB1bmRlciB0aGUgc2FtZSBhYm9ydCBzaWduYWwuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1blVwZGF0ZUNvbW1hbmQoXG4gIGNtZDogc3RyaW5nW10sXG4gIHNpZ25hbDogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPFVwZGF0ZUNvbW1hbmRPdXRwdXQ+IHtcbiAgaWYgKGNtZFswXSA9PT0gXCJnaFwiKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3Bhd25HaChjbWQuc2xpY2UoMSksIHsgc2lnbmFsIH0pO1xuICAgIHJldHVybiB7IGNvZGU6IHJlc3VsdC5jb2RlLCBzdGRvdXQ6IHJlc3VsdC5zdGRvdXQsIHN0ZGVycjogcmVzdWx0LnN0ZGVyciB9O1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZChjbWRbMF0hLCB7XG4gICAgYXJnczogY21kLnNsaWNlKDEpLFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgIHNpZ25hbCxcbiAgfSkub3V0cHV0KCk7XG4gIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICBjb2RlOiBvdXRwdXQuY29kZSxcbiAgICBzdGRvdXQ6IGRlY29kZXIuZGVjb2RlKG91dHB1dC5zdGRvdXQpLFxuICAgIHN0ZGVycjogZGVjb2Rlci5kZWNvZGUob3V0cHV0LnN0ZGVyciksXG4gIH07XG59XG5cbi8qKlxuICogUnVuIGEgY29tbWFuZCB3aXRoIGEgdGltZW91dCBhbmQgcmV0dXJuIHRoZSByZXN1bHQuXG4gKlxuICogVXNlcyB0aGUgcmVwbydzIGNhbm9uaWNhbCBgQWJvcnRDb250cm9sbGVyYCArIGBjbGVhclRpbWVvdXRgIHRpbWVvdXQgcGF0dGVyblxuICogKGFzIGluIGBnaXRfdGltZW91dC50c2ApIHNvIHRoZSB0aW1lb3V0IHRpbWVyIGlzIGFsd2F5cyBjbGVhcmVkIG9uY2UgdGhlIHJhY2VcbiAqIHJlc29sdmVzIOKAlCBvbiB0aGUgc3VjY2VzcyBwYXRoIGFzIHdlbGwgYXMgdGhlIHRpbWVvdXQgcGF0aC4gTGVhdmluZyBhIGxpdmVcbiAqIHRpbWVyIHF1ZXVlZCBvbiB0aGUgZmFzdCBzdWNjZXNzIHBhdGggd291bGQga2VlcCB0aGUgZXZlbnQgbG9vcCBub24taWRsZSBhbmRcbiAqIGRlbGF5IHByb2Nlc3MgZXhpdCBmb3IgdXAgdG8gYHRpbWVvdXRTZWNvbmRzYCAoSXNzdWUgIzMxNjcpLlxuICpcbiAqIEEgYGdoYCBjb21tYW5kIGlzIHNwYXduZWQgYnkge0BsaW5rIHJ1blVwZGF0ZUNvbW1hbmR9IHRocm91Z2ggYHNwYXduR2hgXG4gKiByYXRoZXIgdGhhbiBoZXJlIChJc3N1ZSAjMTM5NiksIHNvIGl0IGNhcnJpZXMgdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGFuZFxuICogdGhlIGF1ZGl0IGpvdXJuYWwgbGlrZSBldmVyeSBvdGhlciB3b3JrZXIgYGdoYCBjYWxsLlxuICpcbiAqIEV4cG9ydGVkIGZvciBkaXJlY3QgdW5pdCB0ZXN0aW5nOyBub3QgcGFydCBvZiB0aGUgbW9kdWxlJ3MgcHVibGljIEFQSS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bldpdGhUaW1lb3V0KFxuICBjbWQ6IHN0cmluZ1tdLFxuICB0aW1lb3V0U2Vjb25kczogbnVtYmVyLFxuKTogUHJvbWlzZTxSZXN1bHQ8eyBleGl0Q29kZTogbnVtYmVyOyBvdXRwdXQ6IHN0cmluZyB9Pj4ge1xuICBjb25zdCB0aW1lb3V0TXMgPSB0aW1lb3V0U2Vjb25kcyAqIDEwMDA7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIHRpbWVvdXRNcyk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5VcGRhdGVDb21tYW5kKGNtZCwgY29udHJvbGxlci5zaWduYWwpO1xuXG4gICAgLy8gVGhlIGFib3J0IHNpZ25hbCB0ZXJtaW5hdGVzIHRoZSBjaGlsZCByYXRoZXIgdGhhbiB0aHJvd2luZywgc28gZGV0ZWN0XG4gICAgLy8gdGhlIHRpbWVvdXQgYnkgaW5zcGVjdGluZyB0aGUgY29udHJvbGxlciBhZnRlciBgb3V0cHV0KClgIHJlc29sdmVzLlxuICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgdmFsdWU6IHsgZXhpdENvZGU6IDEyNCwgb3V0cHV0OiBgVGltZWQgb3V0IGFmdGVyICR7dGltZW91dFNlY29uZHN9c2AgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgZXhpdENvZGU6IHJlc3VsdC5jb2RlLFxuICAgICAgICBvdXRwdXQ6IGAke3Jlc3VsdC5zdGRvdXR9XFxuJHtyZXN1bHQuc3RkZXJyfWAudHJpbSgpLFxuICAgICAgfSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBTb21lIHJ1bnRpbWVzIHN1cmZhY2UgdGhlIGFib3J0IGFzIGFuIEFib3J0RXJyb3IgaW5zdGVhZC5cbiAgICBpZiAoZXJyIGluc3RhbmNlb2YgRE9NRXhjZXB0aW9uICYmIGVyci5uYW1lID09PSBcIkFib3J0RXJyb3JcIikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7IGV4aXRDb2RlOiAxMjQsIG91dHB1dDogYFRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRTZWNvbmRzfXNgIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gIH1cbn1cblxuLyoqIERlZmF1bHQgc2xlZXAgaGVscGVyOiB3YWl0IGBzZWNvbmRzYCByZWFsIHNlY29uZHMuICovXG5mdW5jdGlvbiBkZWZhdWx0U2xlZXBTZWNvbmRzKHNlY29uZHM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgc2Vjb25kcyAqIDEwMDApKTtcbn1cblxuLyoqXG4gKiBSdW4gYW4gdXBkYXRlIGNvbW1hbmQgd2l0aCByZXRyeSBhbmQgZXhwb25lbnRpYWwgYmFja29mZiBvbiB0cmFuc2llbnRcbiAqIGZhaWx1cmVzIChJc3N1ZSAjMTQ5NikuXG4gKlxuICogQ2xhc3NpZmllcyBlYWNoIGZhaWx1cmUgdXNpbmcge0BsaW5rIGNsYXNzaWZ5VXBkYXRlRXJyb3J9LiBQZXJtYW5lbnRcbiAqIGZhaWx1cmVzIHJldHVybiBpbW1lZGlhdGVseSB3aXRob3V0IHJldHJ5LiBUcmFuc2llbnQgZmFpbHVyZXMgYXJlIHJldHJpZWRcbiAqIHVwIHRvIGBtYXhBdHRlbXB0c2AgdGltZXMgd2l0aCBkZWxheXMgdGFrZW4gZnJvbSBgYmFja29mZlNlY29uZHNgLiBBbGxcbiAqIGF0dGVtcHRzIHVsdGltYXRlbHkgZmFpbGluZyByZXR1cm5zIGB7IHN1Y2Nlc3M6IGZhbHNlIH1gIOKAlCB0aGUgY2FsbGVyIGlzXG4gKiBleHBlY3RlZCB0byBsb2cgYSB3YXJuaW5nIHJhdGhlciB0aGFuIHRocm93LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuVXBkYXRlV2l0aFJldHJ5KFxuICBsb2dnZXI6IExvZ2dlcixcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgY21kOiBzdHJpbmdbXSxcbiAgb3B0aW9uczogVXBkYXRlUmV0cnlPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJ1blVwZGF0ZVJlc3VsdD4ge1xuICBjb25zdCBtYXhBdHRlbXB0cyA9IG9wdGlvbnMubWF4QXR0ZW1wdHMgPz8gREVGQVVMVF9VUERBVEVfUkVUUllfTUFYX0FUVEVNUFRTO1xuICBjb25zdCBiYWNrb2ZmID0gb3B0aW9ucy5iYWNrb2ZmU2Vjb25kcyA/P1xuICAgIERFRkFVTFRfVVBEQVRFX1JFVFJZX0JBQ0tPRkZfU0VDT05EUztcbiAgY29uc3QgdGltZW91dCA9IG9wdGlvbnMudGltZW91dCA/PyBERUZBVUxUX1VQREFURV9USU1FT1VUX1NFQ09ORFM7XG4gIGNvbnN0IHNsZWVwRm4gPSBvcHRpb25zLnNsZWVwRm4gPz8gZGVmYXVsdFNsZWVwU2Vjb25kcztcbiAgY29uc3QgcnVuRm4gPSBvcHRpb25zLnJ1bkZuID8/IHJ1bldpdGhUaW1lb3V0O1xuXG4gIGxldCBsYXN0RXhpdCA9IDA7XG4gIGxldCBsYXN0T3V0cHV0ID0gXCJcIjtcbiAgbGV0IGxhc3RDbGFzczogVXBkYXRlRXJyb3JDbGFzcyB8IHVuZGVmaW5lZDtcblxuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgY29uc3QgcnVuUmVzdWx0ID0gYXdhaXQgcnVuRm4oY21kLCB0aW1lb3V0KTtcblxuICAgIGlmIChydW5SZXN1bHQub2spIHtcbiAgICAgIGxhc3RFeGl0ID0gcnVuUmVzdWx0LnZhbHVlLmV4aXRDb2RlO1xuICAgICAgbGFzdE91dHB1dCA9IHJ1blJlc3VsdC52YWx1ZS5vdXRwdXQ7XG4gICAgICBpZiAobGFzdEV4aXQgPT09IDApIHtcbiAgICAgICAgaWYgKGF0dGVtcHQgPiAxKSB7XG4gICAgICAgICAgbG9nZ2VyLmluZm8oXG4gICAgICAgICAgICBgJHt0b29sTmFtZX0gdXBkYXRlIHN1Y2NlZWRlZCBvbiBhdHRlbXB0ICR7YXR0ZW1wdH0vJHttYXhBdHRlbXB0c31gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgIGF0dGVtcHRzOiBhdHRlbXB0LFxuICAgICAgICAgIGZpbmFsRXhpdENvZGU6IDAsXG4gICAgICAgICAgZmluYWxPdXRwdXQ6IGxhc3RPdXRwdXQsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBsYXN0Q2xhc3MgPSBjbGFzc2lmeVVwZGF0ZUVycm9yKGxhc3RFeGl0LCBsYXN0T3V0cHV0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gU3Bhd24gZXJyb3Ig4oCUIGNsYXNzaWZ5IGFzIHRyYW5zaWVudCBzbyB3ZSByZXRyeSwgdW5sZXNzIHRoZSBgZ2hgXG4gICAgICAvLyBjaG9rZXBvaW50IHJlZnVzZWQgdGhlIGNhbGwgKElzc3VlICMxMzk2KS4gQSB3cml0ZSB0aGUgYWxsb3dsaXN0XG4gICAgICAvLyByZWZ1c2VkIGlzIHJlZnVzZWQgaWRlbnRpY2FsbHkgb24gZXZlcnkgYXR0ZW1wdCwgc28gcmV0cnlpbmcgaXQgb25seVxuICAgICAgLy8gZGVsYXlzIHRoZSB3YXJuaW5nIGFuZCByZS1lbWl0cyB0aGUgYFtTRUNVUklUWV1gIGxpbmUgdGhyZWUgdGltZXMuXG4gICAgICBsYXN0RXhpdCA9IC0xO1xuICAgICAgbGFzdE91dHB1dCA9IHJ1blJlc3VsdC5lcnJvci5tZXNzYWdlO1xuICAgICAgbGFzdENsYXNzID0gaXNXcml0ZVJlZnVzYWwocnVuUmVzdWx0LmVycm9yKSA/IFwicGVybWFuZW50XCIgOiBcInRyYW5zaWVudFwiO1xuICAgIH1cblxuICAgIGlmIChsYXN0Q2xhc3MgPT09IFwicGVybWFuZW50XCIpIHtcbiAgICAgIGxvZ2dlci53YXJuKFxuICAgICAgICBgJHt0b29sTmFtZX0gdXBkYXRlIGZhaWxlZCBwZXJtYW5lbnRseSAoZXhpdCAke2xhc3RFeGl0fSkg4oCUIG5vdCByZXRyeWluZzogJHtcbiAgICAgICAgICBsYXN0T3V0cHV0IHx8IFwibm8gb3V0cHV0XCJcbiAgICAgICAgfWAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGF0dGVtcHRzOiBhdHRlbXB0LFxuICAgICAgICBmaW5hbEV4aXRDb2RlOiBsYXN0RXhpdCxcbiAgICAgICAgZmluYWxPdXRwdXQ6IGxhc3RPdXRwdXQsXG4gICAgICAgIGNsYXNzaWZpY2F0aW9uOiBcInBlcm1hbmVudFwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoYXR0ZW1wdCA8IG1heEF0dGVtcHRzKSB7XG4gICAgICBjb25zdCBkZWxheSA9IGJhY2tvZmZbYXR0ZW1wdCAtIDFdID8/XG4gICAgICAgIGJhY2tvZmZbYmFja29mZi5sZW5ndGggLSAxXSA/PyAzMDtcbiAgICAgIGxvZ2dlci5pbmZvKFxuICAgICAgICBgJHt0b29sTmFtZX0gdXBkYXRlIGF0dGVtcHQgJHthdHRlbXB0fS8ke21heEF0dGVtcHRzfSBmYWlsZWQgKHRyYW5zaWVudCwgZXhpdCAke2xhc3RFeGl0fSkg4oCUIHJldHJ5aW5nIGluICR7ZGVsYXl9c2AsXG4gICAgICApO1xuICAgICAgYXdhaXQgc2xlZXBGbihkZWxheSk7XG4gICAgfVxuICB9XG5cbiAgbG9nZ2VyLndhcm4oXG4gICAgYCR7dG9vbE5hbWV9IHVwZGF0ZSBmYWlsZWQgYWZ0ZXIgJHttYXhBdHRlbXB0c30gYXR0ZW1wdCR7XG4gICAgICBtYXhBdHRlbXB0cyA9PT0gMSA/IFwiXCIgOiBcInNcIlxuICAgIH0gKGV4aXQgJHtsYXN0RXhpdH0pIOKAlCBjb250aW51aW5nIGFueXdheWAsXG4gICk7XG4gIGlmIChsYXN0T3V0cHV0KSBsb2dnZXIuaW5mbyhgJHt0b29sTmFtZX0gZmluYWwgb3V0cHV0OiAke2xhc3RPdXRwdXR9YCk7XG4gIHJldHVybiB7XG4gICAgc3VjY2VzczogZmFsc2UsXG4gICAgYXR0ZW1wdHM6IG1heEF0dGVtcHRzLFxuICAgIGZpbmFsRXhpdENvZGU6IGxhc3RFeGl0LFxuICAgIGZpbmFsT3V0cHV0OiBsYXN0T3V0cHV0LFxuICAgIGNsYXNzaWZpY2F0aW9uOiBsYXN0Q2xhc3MsXG4gIH07XG59XG5cbi8qKiBTaGFyZWQgcGVyLXRvb2wgdXBkYXRlIG9wdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xVcGRhdGVPcHRpb25zIHtcbiAgLyoqIFNraXAgdGhlIHVwZGF0ZSBlbnRpcmVseS4gKi9cbiAgc2tpcD86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBJbnN0YWxsIHRoaXMgZXhhY3QgdmVyc2lvbiBpbnN0ZWFkIG9mIFwid2hhdGV2ZXIgaXMgbGF0ZXN0XCIgKElzc3VlICM2MjMpLlxuICAgKlxuICAgKiBXaGVuIGFic2VudCwgZXZlcnkgdXBkYXRlciBiZWhhdmVzIGV4YWN0bHkgYXMgaXQgZGlkIGJlZm9yZTogdGhlXG4gICAqIHJlbGVhc2UtYWdlIGdhdGUgcmVzb2x2ZXMgdGhlIGNhbmRpZGF0ZSBhbmQgdGhlIHRvb2wncyBvd24gdXBncmFkZSBjb21tYW5kXG4gICAqIHJ1bnMuIFdoZW4gcHJlc2VudCwgdGhlIGdhdGUgaXMgYnlwYXNzZWQg4oCUIGEgcGlubmVkIHZlcnNpb24gaXMgYW4gZXhwbGljaXRcbiAgICogY2hvaWNlLCBhbmQgdGhlIGdhdGUgZXhpc3RzIHRvIGNvbnRyb2wgdW5waW5uZWQgXCJsYXRlc3RcIiBpbnN0YWxscyDigJQgdGhlXG4gICAqIGV4YWN0IHZlcnNpb24gaXMgaW5zdGFsbGVkLCBhbmQgYSBtaXNtYXRjaCBhZnRlcndhcmRzIHRocm93cy5cbiAgICovXG4gIHRhcmdldFZlcnNpb24/OiBzdHJpbmc7XG4gIC8qKiBUaW1lb3V0IHBlciBhdHRlbXB0IGluIHNlY29uZHMgKGRlZmF1bHQ6IDEyMCkuICovXG4gIHRpbWVvdXQ/OiBudW1iZXI7XG4gIC8qKiBSZXRyeSBjb25maWd1cmF0aW9uIChkZWZhdWx0OiAzIGF0dGVtcHRzLCBbMzAsIDkwLCAzMDBdIGJhY2tvZmYpLiAqL1xuICByZXRyeT86IFVwZGF0ZVJldHJ5T3B0aW9ucztcbiAgLyoqIERpcmVjdG9yeSBmb3IgcGVyLXRvb2wgdGltZXN0YW1wIGZpbGVzIChkZWZhdWx0OiBIT01FKS4gKi9cbiAgdGltZXN0YW1wRGlyPzogc3RyaW5nO1xuICAvKiogSW5qZWN0YWJsZSB0aW1lIHNvdXJjZSBmb3IgdGhlIHBlci10b29sIHRpbWVzdGFtcCBmaWxlLiAqL1xuICBub3c/OiAoKSA9PiBudW1iZXI7XG4gIC8qKiBSZWxlYXNlLWFnZSBxdWFyYW50aW5lIHdpbmRvdyBpbiBob3VycyAoZGVmYXVsdCAyNCwgSXNzdWUgIzM2NTUpLiAqL1xuICBxdWFyYW50aW5lSG91cnM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RhYmxlIHJlbGVhc2UtYWdlIGdhdGUgKGRlZmF1bHRzIHRvIHRoZSByZWFsIHVwc3RyZWFtIGdhdGUpLiAqL1xuICBhZ2VHYXRlPzogUmVsZWFzZUFnZUdhdGU7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcmVsZWFzZS1hZ2UgZ2F0ZSBmb3IgYSB0b29sIHVwZGF0ZSAoSXNzdWUgIzM2NTUpLlxuICpcbiAqIFRlc3RzIGluamVjdCBhIGdhdGU7IHByb2R1Y3Rpb24gYnVpbGRzIHRoZSByZWFsIG9uZSBmcm9tIHRoZSBzYW1lIGNvbW1hbmRcbiAqIHJ1bm5lciB0aGUgdXBkYXRlIGl0c2VsZiB1c2VzLCBzbyB0aGUgZ2F0ZSBpcyBuZXZlciBhY2NpZGVudGFsbHkgYnlwYXNzZWQuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVBZ2VHYXRlKFxuICBsb2dnZXI6IExvZ2dlcixcbiAgb3B0czogVG9vbFVwZGF0ZU9wdGlvbnMsXG4pOiBSZWxlYXNlQWdlR2F0ZSB7XG4gIHJldHVybiBvcHRzLmFnZUdhdGUgPz8gY3JlYXRlUmVsZWFzZUFnZUdhdGUoe1xuICAgIHJ1bkZuOiBvcHRzLnJldHJ5Py5ydW5GbiA/PyBydW5XaXRoVGltZW91dCxcbiAgICBxdWFyYW50aW5lSG91cnM6IG9wdHMucXVhcmFudGluZUhvdXJzLFxuICAgIHdhcm46IChtZXNzYWdlKSA9PiBsb2dnZXIud2FybihtZXNzYWdlKSxcbiAgfSk7XG59XG5cbi8qKlxuICogTG9nIGEgcXVhcmFudGluZSB2ZXJkaWN0IGFuZCByZXBvcnQgd2hldGhlciB0aGUgdXBncmFkZSBtYXkgcHJvY2VlZFxuICogKElzc3VlICMzNjU1KS5cbiAqXG4gKiBGYWlsLWNsb3NlZCAoSXNzdWUgIzMyMzQpOiBhIHJlbGVhc2UgdGhhdCBpcyB0b28gbmV3IGlzIGRlZmVycmVkLCBhbmQgb25lXG4gKiB3aG9zZSBhZ2UgY2Fubm90IGJlIHZlcmlmaWVkIGlzIHNraXBwZWQgd2l0aCBhIHdhcm5pbmcuIE5laXRoZXIgb3V0Y29tZSBpc1xuICogc2lsZW50IOKAlCBhbiB1bnZlcmlmaWFibGUgdXBzdHJlYW0gaXMgYSBzdXBwbHktY2hhaW4gc2lnbmFsLCBub3QgYSBuby1vcC5cbiAqL1xuZnVuY3Rpb24gcGFzc2VzUXVhcmFudGluZShcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHZlcmRpY3Q6IFJlbGVhc2VBZ2VWZXJkaWN0LFxuKTogYm9vbGVhbiB7XG4gIGlmICh2ZXJkaWN0LmVsaWdpYmxlKSB7XG4gICAgbG9nZ2VyLmluZm8oYCR7bGFiZWx9IHJlbGVhc2UtYWdlIGNoZWNrIHBhc3NlZDogJHt2ZXJkaWN0LnJlYXNvbn1gKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAodmVyZGljdC5pbmRldGVybWluYXRlKSB7XG4gICAgbG9nZ2VyLndhcm4oYCR7bGFiZWx9IHVwZ3JhZGUgc2tpcHBlZDogJHt2ZXJkaWN0LnJlYXNvbn1gKTtcbiAgfSBlbHNlIHtcbiAgICBsb2dnZXIuaW5mbyhgJHtsYWJlbH0gdXBncmFkZSBkZWZlcnJlZDogJHt2ZXJkaWN0LnJlYXNvbn1gKTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBCdWlsZCB0aGUgZWZmZWN0aXZlIHJldHJ5IG9wdGlvbnMgZm9yIGEgdG9vbCB1cGRhdGUgZnJvbSBpdHMgb3B0aW9ucy4gKi9cbmZ1bmN0aW9uIGJ1aWxkUmV0cnlPcHRpb25zKG9wdHM6IFRvb2xVcGRhdGVPcHRpb25zKTogVXBkYXRlUmV0cnlPcHRpb25zIHtcbiAgcmV0dXJuIHtcbiAgICBtYXhBdHRlbXB0czogb3B0cy5yZXRyeT8ubWF4QXR0ZW1wdHMsXG4gICAgYmFja29mZlNlY29uZHM6IG9wdHMucmV0cnk/LmJhY2tvZmZTZWNvbmRzLFxuICAgIHRpbWVvdXQ6IG9wdHMucmV0cnk/LnRpbWVvdXQgPz8gb3B0cy50aW1lb3V0LFxuICAgIHNsZWVwRm46IG9wdHMucmV0cnk/LnNsZWVwRm4sXG4gICAgcnVuRm46IG9wdHMucmV0cnk/LnJ1bkZuLFxuICB9O1xufVxuXG4vKiogUGVyc2lzdCBhIHN1Y2Nlc3NmdWwgdXBkYXRlIHRpbWVzdGFtcCBmb3IgYSB0b29sLCBpZiBhIGRpcmVjdG9yeSBpcyBjb25maWd1cmVkLiAqL1xuZnVuY3Rpb24gcGVyc2lzdFN1Y2Nlc3MoXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICB0b29sOiBzdHJpbmcsXG4gIG9wdHM6IFRvb2xVcGRhdGVPcHRpb25zLFxuKTogdm9pZCB7XG4gIGlmICghb3B0cy50aW1lc3RhbXBEaXIpIHJldHVybjtcbiAgY29uc3QgcmVzdWx0ID0gcmVjb3JkU3VjY2Vzc2Z1bFVwZGF0ZShvcHRzLnRpbWVzdGFtcERpciwgdG9vbCwgb3B0cy5ub3cpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIGxvZ2dlci53YXJuKFxuICAgICAgYEZhaWxlZCB0byByZWNvcmQgc3VjY2Vzc2Z1bCB1cGRhdGUgdGltZXN0YW1wIGZvciAke3Rvb2x9OiAke3Jlc3VsdC5lcnJvci5tZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tIEV4YWN0LXZlcnNpb24gKHBpbm5lZCkgaW5zdGFsbHMgKElzc3VlICM2MjMpIC0tLS0tLS0tLS1cblxuLyoqIFRvb2xzIHRoYXQgY2FuIGJlIGluc3RhbGxlZCBhdCBhbiBleGFjdCB2ZXJzaW9uIChJc3N1ZSAjNjIzKS4gKi9cbmV4cG9ydCB0eXBlIFBpbm5lZFRvb2wgPSBcImNsYXVkZVwiIHwgXCJnaFwiIHwgXCJkZW5vXCI7XG5cbi8qKiBIdW1hbi1yZWFkYWJsZSBsYWJlbCBwZXIgdG9vbCwgdXNlZCBpbiBsb2cgbGluZXMgYW5kIGVycm9yIG1lc3NhZ2VzLiAqL1xuY29uc3QgVE9PTF9MQUJFTFM6IFJlYWRvbmx5PFJlY29yZDxQaW5uZWRUb29sLCBzdHJpbmc+PiA9IHtcbiAgY2xhdWRlOiBcIkNsYXVkZSBDTElcIixcbiAgZ2g6IFwiR0ggQ0xJXCIsXG4gIGRlbm86IFwiRGVub1wiLFxufTtcblxuLyoqIFJlbGVhc2UgY2hhbm5lbCBlYWNoIHRvb2wncyBcImxhdGVzdFwiIHZlcnNpb24gaXMgcHVibGlzaGVkIHRocm91Z2guICovXG5jb25zdCBUT09MX0NIQU5ORUxTOiBSZWFkb25seTxSZWNvcmQ8UGlubmVkVG9vbCwgUmVsZWFzZUNoYW5uZWw+PiA9IHtcbiAgY2xhdWRlOiB7IGtpbmQ6IFwibnBtXCIsIHBrZzogQ0xBVURFX0NMSV9OUE1fUEFDS0FHRSB9LFxuICBnaDogeyBraW5kOiBcImdpdGh1YlwiLCByZXBvOiBHSF9DTElfUkVMRUFTRV9SRVBPIH0sXG4gIGRlbm86IHsga2luZDogXCJnaXRodWJcIiwgcmVwbzogREVOT19SRUxFQVNFX1JFUE8gfSxcbn07XG5cbi8qKiBDYW5vbmljYWwgb3JkZXIgZXZlcnkgdG9vbCBzd2VlcCBmb2xsb3dzOiBjbGF1ZGUg4oaSIGdoIOKGkiBkZW5vLiAqL1xuY29uc3QgVVBEQVRFX1RPT0xTOiByZWFkb25seSBQaW5uZWRUb29sW10gPSBbXCJjbGF1ZGVcIiwgXCJnaFwiLCBcImRlbm9cIl07XG5cbi8qKlxuICogVmVyc2lvbiBzaGFwZSBhY2NlcHRlZCBhcyBhIHBpbm5lZCBpbnN0YWxsIHRhcmdldCAoSXNzdWUgIzYyMykuXG4gKlxuICogVGhlIHZhbHVlIGlzIGludGVycG9sYXRlZCBpbnRvIGEgZG93bmxvYWQgVVJMIGFuZCBhIGNvbW1hbmQgbGluZSwgc28gb25seSBhXG4gKiBwbGFpbiBzZW12ZXIgKHdpdGggYW4gb3B0aW9uYWwgcHJlLXJlbGVhc2Ugc3VmZml4KSBpcyBhY2NlcHRlZCDigJQgYW55dGhpbmdcbiAqIGVsc2UgaXMgcmVmdXNlZCBsb3VkbHkgcmF0aGVyIHRoYW4gZmV0Y2hlZC5cbiAqXG4gKiBFeHBvcnRlZCBiZWNhdXNlIHRoZSByZWxlYXNlIHRvb2wtdmVyc2lvbiBtYW5pZmVzdCAoSXNzdWUgIzY4OCkgcmVjb3Jkc1xuICogdmVyc2lvbnMgYSBmcm96ZW4gaG9zdCBpbnN0YWxscyB0aHJvdWdoIGV4YWN0bHkgdGhpcyBwYXRoLCBzbyBpdCBtdXN0IGFjY2VwdFxuICogZXhhY3RseSB3aGF0IHRoZSBwaW5uZWQgaW5zdGFsbGVyIGFjY2VwdHMgcmF0aGVyIHRoYW4gYSBzZWNvbmQgY29weSBvZiB0aGVcbiAqIHJ1bGUgdGhhdCBjb3VsZCBkcmlmdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFBJTk5FRF9WRVJTSU9OX1BBVFRFUk4gPSAvXlxcZCtcXC5cXGQrXFwuXFxkKyg/Oi1bMC05QS1aYS16Ll0rKT8kLztcblxuLyoqIFRoZSBjb21tYW5kcyB0aGF0IGluc3RhbGwgb25lIHBpbm5lZCB2ZXJzaW9uLCBwbHVzIGJlc3QtZWZmb3J0IGNsZWFudXAuICovXG5pbnRlcmZhY2UgUGlubmVkSW5zdGFsbFBsYW4ge1xuICAvKiogQ29tbWFuZHMgcnVuIGluIG9yZGVyOyB0aGUgZmlyc3QgZmFpbHVyZSBhYm9ydHMgdGhlIGluc3RhbGwuICovXG4gIGNvbW1hbmRzOiBzdHJpbmdbXVtdO1xuICAvKiogQ29tbWFuZHMgcnVuIGFmdGVyd2FyZHMgcmVnYXJkbGVzcyBvZiBvdXRjb21lOyBmYWlsdXJlcyBhcmUgaWdub3JlZC4gKi9cbiAgY2xlYW51cDogc3RyaW5nW11bXTtcbn1cblxuLyoqIERpcmVjdG9yeSBkb3dubG9hZHMgYXJlIHN0YWdlZCBpbi4gRmFsbHMgYmFjayB0byBgL3RtcGAuICovXG5mdW5jdGlvbiBzdGFnaW5nRGlyKCk6IHN0cmluZyB7XG4gIGxldCBkaXI6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBkaXIgPSBEZW5vLmVudi5nZXQoXCJUTVBESVJcIikgPz8gRGVuby5lbnYuZ2V0KFwiVE1QXCIpO1xuICB9IGNhdGNoIHtcbiAgICBkaXIgPSB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIChkaXIgPz8gXCIvdG1wXCIpLnJlcGxhY2UoL1xcLyskLywgXCJcIikgfHwgXCIvdG1wXCI7XG59XG5cbi8qKlxuICogVGhlIGBnaGAgcmVsZWFzZSBhcmNoaXZlIGZvciBvbmUgdmVyc2lvbiBvbiBvbmUgcGxhdGZvcm0gKElzc3VlICM2MjMpLlxuICpcbiAqIE1pcnJvcnMgdGhlIG5hbWluZyBgY29udGFpbmVyL0NvbnRhaW5lcmZpbGVgIGFscmVhZHkgcmVsaWVzIG9uIOKAlFxuICogYGdoXzx2ZXJzaW9uPl88b3M+XzxhcmNoPmAg4oCUIGluY2x1ZGluZyBgZ2hgJ3Mgb3duIHF1aXJrczogbWFjT1MgYXJjaGl2ZXMgYXJlXG4gKiB6aXBwZWQgYW5kIHNwZWxsZWQgYG1hY09TYCwgTGludXggYXJjaGl2ZXMgYXJlIGd6aXBwZWQgdGFyYmFsbHMuIFJldHVybnMgbnVsbFxuICogZm9yIGEgcGxhdGZvcm0gYGNsaS9jbGlgIHB1Ymxpc2hlcyBubyBzdWNoIGFyY2hpdmUgZm9yLCBzbyB0aGUgY2FsbGVyIGNhblxuICogZmFpbCBsb3VkIGluc3RlYWQgb2YgZmV0Y2hpbmcgYSBVUkwgdGhhdCBkb2VzIG5vdCBleGlzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdoUmVsZWFzZUFyY2hpdmUoXG4gIHZlcnNpb246IHN0cmluZyxcbiAgb3M6IHN0cmluZyA9IERlbm8uYnVpbGQub3MsXG4gIGFyY2g6IHN0cmluZyA9IERlbm8uYnVpbGQuYXJjaCxcbik6IHsgZGlyOiBzdHJpbmc7IGFyY2hpdmU6IHN0cmluZzsgdXJsOiBzdHJpbmc7IHppcHBlZDogYm9vbGVhbiB9IHwgbnVsbCB7XG4gIGNvbnN0IGdvYXJjaCA9IGFyY2ggPT09IFwieDg2XzY0XCJcbiAgICA/IFwiYW1kNjRcIlxuICAgIDogYXJjaCA9PT0gXCJhYXJjaDY0XCJcbiAgICA/IFwiYXJtNjRcIlxuICAgIDogbnVsbDtcbiAgY29uc3Qgb3NOYW1lID0gb3MgPT09IFwibGludXhcIiA/IFwibGludXhcIiA6IG9zID09PSBcImRhcndpblwiID8gXCJtYWNPU1wiIDogbnVsbDtcbiAgaWYgKCFnb2FyY2ggfHwgIW9zTmFtZSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHppcHBlZCA9IG9zTmFtZSA9PT0gXCJtYWNPU1wiO1xuICBjb25zdCBkaXIgPSBgZ2hfJHt2ZXJzaW9ufV8ke29zTmFtZX1fJHtnb2FyY2h9YDtcbiAgY29uc3QgYXJjaGl2ZSA9IGAke2Rpcn0uJHt6aXBwZWQgPyBcInppcFwiIDogXCJ0YXIuZ3pcIn1gO1xuICByZXR1cm4ge1xuICAgIGRpcixcbiAgICBhcmNoaXZlLFxuICAgIHppcHBlZCxcbiAgICB1cmw6XG4gICAgICBgaHR0cHM6Ly9naXRodWIuY29tLyR7R0hfQ0xJX1JFTEVBU0VfUkVQT30vcmVsZWFzZXMvZG93bmxvYWQvdiR7dmVyc2lvbn0vJHthcmNoaXZlfWAsXG4gIH07XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcGF0aCB0aGUgaW5zdGFsbGVkIGBnaGAgYmluYXJ5IG9jY3VwaWVzIChJc3N1ZSAjNjIzKS5cbiAqXG4gKiBBIHBpbm5lZCBgZ2hgIGluc3RhbGwgcmVwbGFjZXMgdGhlIGJpbmFyeSBhbHJlYWR5IG9uIFBBVEgsIHNvIHRoZSBleGFjdFxuICogdmVyc2lvbiB0aGUgY2FsbGVyIGFza2VkIGZvciBpcyB0aGUgb25lIHRoYXQgcnVucy4gUmV0dXJucyBudWxsIHdoZW4gYGdoYFxuICogY2Fubm90IGJlIGxvY2F0ZWQg4oCUIHRoZSBjYWxsZXIgdGhlbiBmYWlscyBsb3VkIHJhdGhlciB0aGFuIGd1ZXNzaW5nIGEgcHJlZml4LlxuICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlR2hCaW5hcnlQYXRoKFxuICBydW5GbjogTm9uTnVsbGFibGU8VXBkYXRlUmV0cnlPcHRpb25zW1wicnVuRm5cIl0+LFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHByb2JlID0gYXdhaXQgcnVuRm4oW1wid2hpY2hcIiwgXCJnaFwiXSwgNSk7XG4gIGlmICghcHJvYmUub2sgfHwgcHJvYmUudmFsdWUuZXhpdENvZGUgIT09IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gcHJvYmUudmFsdWUub3V0cHV0XG4gICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgLm1hcCgobGluZSkgPT4gbGluZS50cmltKCkpXG4gICAgLmZpbmQoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aChcIi9cIikpID8/IG51bGw7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGNvbW1hbmQgc2VxdWVuY2UgdGhhdCBpbnN0YWxscyBvbmUgZXhhY3QgdmVyc2lvbiAoSXNzdWUgIzYyMykuXG4gKlxuICogRWFjaCB0b29sIGZvbGxvd3MgdGhlIHBhdHRlcm4gdGhlIGNvbnRhaW5lciBpbWFnZSBhbHJlYWR5IHVzZXMgZm9yIGl0c1xuICogcGlubmVkIHRvb2xzOiBmZXRjaCB0aGUgcHVibGlzaGVkIGFydGVmYWN0IGZvciB0aGF0IGV4YWN0IHZlcnNpb24sIHRoZW5cbiAqIGluc3RhbGwgZnJvbSB0aGUgbG9jYWwgZmlsZSDigJQgbmV2ZXIgYSBmbG9hdGluZyBcImxhdGVzdFwiLlxuICovXG5hc3luYyBmdW5jdGlvbiBwbGFuUGlubmVkSW5zdGFsbChcbiAgdG9vbDogUGlubmVkVG9vbCxcbiAgdmVyc2lvbjogc3RyaW5nLFxuICBydW5GbjogTm9uTnVsbGFibGU8VXBkYXRlUmV0cnlPcHRpb25zW1wicnVuRm5cIl0+LFxuKTogUHJvbWlzZTxSZXN1bHQ8UGlubmVkSW5zdGFsbFBsYW4+PiB7XG4gIGNvbnN0IGZhaWwgPSAobWVzc2FnZTogc3RyaW5nKTogUmVzdWx0PFBpbm5lZEluc3RhbGxQbGFuPiA9PiAoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKG1lc3NhZ2UpLFxuICB9KTtcblxuICBpZiAodG9vbCA9PT0gXCJkZW5vXCIpIHtcbiAgICAvLyBgZGVubyB1cGdyYWRlYCBhbHJlYWR5IHRha2VzIGEgdmVyc2lvbiBhcmd1bWVudC5cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogeyBjb21tYW5kczogW1tcImRlbm9cIiwgXCJ1cGdyYWRlXCIsIHZlcnNpb25dXSwgY2xlYW51cDogW10gfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdG1wID0gc3RhZ2luZ0RpcigpO1xuXG4gIGlmICh0b29sID09PSBcImNsYXVkZVwiKSB7XG4gICAgY29uc3QgdGFyYmFsbCA9IGAke3RtcH0vY2xhdWRlLWNvZGUtJHt2ZXJzaW9ufS50Z3pgO1xuICAgIGNvbnN0IHVybCA9XG4gICAgICBgJHtOUE1fUkVHSVNUUllfQkFTRX0vJHtDTEFVREVfQ0xJX05QTV9QQUNLQUdFfS8tL2NsYXVkZS1jb2RlLSR7dmVyc2lvbn0udGd6YDtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBjb21tYW5kczogW1xuICAgICAgICAgIFtcImN1cmxcIiwgXCItZnNTTFwiLCBcIi1vXCIsIHRhcmJhbGwsIHVybF0sXG4gICAgICAgICAgW1wibnBtXCIsIFwiaW5zdGFsbFwiLCBcIi1nXCIsIFwiLS1pZ25vcmUtc2NyaXB0c1wiLCB0YXJiYWxsXSxcbiAgICAgICAgXSxcbiAgICAgICAgY2xlYW51cDogW1tcInJtXCIsIFwiLWZcIiwgdGFyYmFsbF1dLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYXNzZXQgPSBnaFJlbGVhc2VBcmNoaXZlKHZlcnNpb24pO1xuICBpZiAoIWFzc2V0KSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBgbm8gZ2ggJHt2ZXJzaW9ufSByZWxlYXNlIGFyY2hpdmUgaXMgcHVibGlzaGVkIGZvciAke0Rlbm8uYnVpbGQub3N9LyR7RGVuby5idWlsZC5hcmNofWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBkZXN0aW5hdGlvbiA9IGF3YWl0IHJlc29sdmVHaEJpbmFyeVBhdGgocnVuRm4pO1xuICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgcmV0dXJuIGZhaWwoXG4gICAgICBcInRoZSBpbnN0YWxsZWQgZ2ggYmluYXJ5IGNvdWxkIG5vdCBiZSBsb2NhdGVkLCBzbyB0aGUgcGlubmVkIGJpbmFyeSBoYXMgbm93aGVyZSB0byBnb1wiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYXJjaGl2ZSA9IGAke3RtcH0vJHthc3NldC5hcmNoaXZlfWA7XG4gIGNvbnN0IGV4dHJhY3RlZCA9IGAke3RtcH0vJHthc3NldC5kaXJ9YDtcbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgY29tbWFuZHM6IFtcbiAgICAgICAgW1wiY3VybFwiLCBcIi1mc1NMXCIsIFwiLW9cIiwgYXJjaGl2ZSwgYXNzZXQudXJsXSxcbiAgICAgICAgYXNzZXQuemlwcGVkXG4gICAgICAgICAgPyBbXCJ1bnppcFwiLCBcIi1vXCIsIFwiLXFcIiwgYXJjaGl2ZSwgXCItZFwiLCB0bXBdXG4gICAgICAgICAgOiBbXCJ0YXJcIiwgXCIteHpmXCIsIGFyY2hpdmUsIFwiLUNcIiwgdG1wXSxcbiAgICAgICAgW1wiaW5zdGFsbFwiLCBcIi1tXCIsIFwiMDc1NVwiLCBgJHtleHRyYWN0ZWR9L2Jpbi9naGAsIGRlc3RpbmF0aW9uXSxcbiAgICAgIF0sXG4gICAgICBjbGVhbnVwOiBbW1wicm1cIiwgXCItcmZcIiwgYXJjaGl2ZSwgZXh0cmFjdGVkXV0sXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHZlcnNpb24gb3V0cHV0IHJlcG9ydHMgZXhhY3RseSBgdmVyc2lvbmAgKElzc3VlICM2MjMpLlxuICpcbiAqIFJldHVybnMgbnVsbCB3aGVuIGVpdGhlciBzaWRlIGhhcyBubyBwYXJzZWFibGUgc2VtdmVyLCBzbyB0aGUgY2FsbGVyIGNhblxuICogZGlzdGluZ3Vpc2ggXCJkaWZmZXJlbnQgdmVyc2lvblwiIGZyb20gXCJjb3VsZCBub3QgdGVsbFwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyc2lvbk1hdGNoZXNFeGFjdGx5KFxuICBpbnN0YWxsZWRPdXRwdXQ6IHN0cmluZyxcbiAgdmVyc2lvbjogc3RyaW5nLFxuKTogYm9vbGVhbiB8IG51bGwge1xuICBjb25zdCBpbnN0YWxsZWQgPSBwYXJzZVNlbXZlcihpbnN0YWxsZWRPdXRwdXQpO1xuICBjb25zdCB3YW50ZWQgPSBwYXJzZVNlbXZlcih2ZXJzaW9uKTtcbiAgaWYgKCFpbnN0YWxsZWQgfHwgIXdhbnRlZCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBjb21wYXJlU2VtdmVyKGluc3RhbGxlZCwgd2FudGVkKSA9PT0gMDtcbn1cblxuLyoqXG4gKiBSZS1yZWFkIGEgdG9vbCdzIHZlcnNpb24gYWZ0ZXIgYSBwaW5uZWQgaW5zdGFsbCBhbmQgZmFpbCBsb3VkIG9uIGEgbWlzbWF0Y2hcbiAqIChJc3N1ZSAjNjIzKS5cbiAqXG4gKiBVc2VzIHRoZSBzYW1lIHJlYWRlciBhcyB0aGUgZmxvb3IgY2hlY2sgKGBWRVJTSU9OX0NPTU1BTkRTYCB2aWFcbiAqIHtAbGluayBtYWtlVmVyc2lvblJlYWRlcn0pIHJhdGhlciB0aGFuIGEgc2Vjb25kIHZlcnNpb24gcmVhZGVyLiBVbmxpa2UgdGhlXG4gKiBmbG9vciBjaGVjayDigJQgd2hpY2ggd2FybnMgYW5kIHdhaXRzIGZvciB0aGUgbmV4dCBpbnRlcnZhbCDigJQgYSBwaW5uZWQgaW5zdGFsbFxuICogdGhhdCBkaWQgbm90IGxhbmQgdGhlIHJlcXVlc3RlZCB2ZXJzaW9uIHRocm93cywgbmFtaW5nIHRoZSByZXF1ZXN0ZWQgYW5kIHRoZVxuICogYWN0dWFsIHZlcnNpb246IHNpbGVudGx5IGxlYXZpbmcgdGhlIGhvc3Qgb24gYW4gdW5waW5uZWQgdG9vbCBpcyBleGFjdGx5IHRoZVxuICogc2lsZW50IGZhaWx1cmUgdGhpcyBwYXRoIGV4aXN0cyB0byBwcmV2ZW50LlxuICovXG5hc3luYyBmdW5jdGlvbiB2ZXJpZnlQaW5uZWRWZXJzaW9uKFxuICBsb2dnZXI6IExvZ2dlcixcbiAgdG9vbDogUGlubmVkVG9vbCxcbiAgdmVyc2lvbjogc3RyaW5nLFxuICByZWFkVmVyc2lvbjogKHRvb2w6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBsYWJlbCA9IFRPT0xfTEFCRUxTW3Rvb2xdO1xuICBjb25zdCBvdXRwdXQgPSBhd2FpdCByZWFkVmVyc2lvbih0b29sKTtcbiAgaWYgKG91dHB1dCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGAke2xhYmVsfSBwaW5uZWQgaW5zdGFsbCBvZiAke3ZlcnNpb259IGNhbm5vdCBiZSB2ZXJpZmllZDogdGhlIGluc3RhbGxlZCB2ZXJzaW9uIGNvdWxkIG5vdCBiZSByZWFkYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IG1hdGNoZXMgPSB2ZXJzaW9uTWF0Y2hlc0V4YWN0bHkob3V0cHV0LCB2ZXJzaW9uKTtcbiAgaWYgKG1hdGNoZXMgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtsYWJlbH0gcGlubmVkIGluc3RhbGwgb2YgJHt2ZXJzaW9ufSBjYW5ub3QgYmUgdmVyaWZpZWQ6IG5vIHZlcnNpb24gY291bGQgYmUgcGFyc2VkIGZyb20gXCIke291dHB1dC50cmltKCl9XCJgLFxuICAgICk7XG4gIH1cbiAgaWYgKCFtYXRjaGVzKSB7XG4gICAgY29uc3QgaW5zdGFsbGVkID0gcGFyc2VTZW12ZXIob3V0cHV0KSE7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYCR7bGFiZWx9IHZlcnNpb24gbWlzbWF0Y2ggYWZ0ZXIgYSBwaW5uZWQgaW5zdGFsbDogcmVxdWVzdGVkICR7dmVyc2lvbn0sIGluc3RhbGxlZCAke1xuICAgICAgICBpbnN0YWxsZWQuam9pbihcIi5cIilcbiAgICAgIH1gLFxuICAgICk7XG4gIH1cbiAgbG9nZ2VyLmluZm8oYCR7bGFiZWx9IGlzIG5vdyBhdCB0aGUgcGlubmVkIHZlcnNpb24gJHt2ZXJzaW9ufWApO1xufVxuXG4vKipcbiAqIEluc3RhbGwgb25lIHRvb2wgYXQgYW4gZXhhY3QgdmVyc2lvbiAoSXNzdWUgIzYyMykuXG4gKlxuICogQSB0b29sIGFscmVhZHkgcmVwb3J0aW5nIHRoYXQgdmVyc2lvbiBpcyBsZWZ0IGFsb25lIOKAlCBhIGxhdW5jaCBtdXN0IG5vdFxuICogcmVpbnN0YWxsIG9uIGV2ZXJ5IHJ1bi4gT3RoZXJ3aXNlIHRoZSBhcnRlZmFjdCBmb3IgZXhhY3RseSB0aGF0IHZlcnNpb24gaXNcbiAqIGZldGNoZWQgYW5kIGluc3RhbGxlZCwgYW5kIHRoZSByZXN1bHQgaXMgdmVyaWZpZWQ6IGEgZmFpbGVkIGluc3RhbGwsIGFuXG4gKiB1bnZlcmlmaWFibGUgdmVyc2lvbiwgb3IgYSB2ZXJzaW9uIHRoYXQgZG9lcyBub3QgbWF0Y2ggdGhyb3dzIHdpdGggYm90aCB0aGVcbiAqIHJlcXVlc3RlZCBhbmQgdGhlIGFjdHVhbCB2ZXJzaW9uIG5hbWVkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFBpbm5lZFZlcnNpb24oXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICB0b29sOiBQaW5uZWRUb29sLFxuICB2ZXJzaW9uOiBzdHJpbmcsXG4gIG9wdGlvbnM6IFRvb2xVcGRhdGVPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbGFiZWwgPSBUT09MX0xBQkVMU1t0b29sXTtcbiAgaWYgKCFQSU5ORURfVkVSU0lPTl9QQVRURVJOLnRlc3QodmVyc2lvbikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtsYWJlbH0gcGlubmVkIGluc3RhbGwgcmVmdXNlZDogXCIke3ZlcnNpb259XCIgaXMgbm90IGEgdmFsaWQgdmVyc2lvbmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJldHJ5T3B0cyA9IGJ1aWxkUmV0cnlPcHRpb25zKG9wdGlvbnMpO1xuICBjb25zdCBydW5GbiA9IHJldHJ5T3B0cy5ydW5GbiA/PyBydW5XaXRoVGltZW91dDtcbiAgY29uc3QgcmVhZFZlcnNpb24gPSBtYWtlVmVyc2lvblJlYWRlcihydW5Gbik7XG5cbiAgY29uc3QgYmVmb3JlID0gYXdhaXQgcmVhZFZlcnNpb24odG9vbCk7XG4gIGlmIChiZWZvcmUgIT09IG51bGwgJiYgdmVyc2lvbk1hdGNoZXNFeGFjdGx5KGJlZm9yZSwgdmVyc2lvbikgPT09IHRydWUpIHtcbiAgICBsb2dnZXIuaW5mbyhcbiAgICAgIGAke2xhYmVsfSBpcyBhbHJlYWR5IGF0IHRoZSBwaW5uZWQgdmVyc2lvbiAke3ZlcnNpb259IOKAlCBub3RoaW5nIHRvIGluc3RhbGxgLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcGxhbiA9IGF3YWl0IHBsYW5QaW5uZWRJbnN0YWxsKHRvb2wsIHZlcnNpb24sIHJ1bkZuKTtcbiAgaWYgKCFwbGFuLm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYCR7bGFiZWx9IHBpbm5lZCBpbnN0YWxsIG9mICR7dmVyc2lvbn0gZmFpbGVkIOKAlCAke3BsYW4uZXJyb3IubWVzc2FnZX1gLFxuICAgICk7XG4gIH1cblxuICBsb2dnZXIuaW5mbyhgSW5zdGFsbGluZyAke2xhYmVsfSAke3ZlcnNpb259IChwaW5uZWQpLi4uYCk7XG5cbiAgbGV0IGZhaWx1cmU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGNtZCBvZiBwbGFuLnZhbHVlLmNvbW1hbmRzKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVXBkYXRlV2l0aFJldHJ5KFxuICAgICAgbG9nZ2VyLFxuICAgICAgYCR7bGFiZWx9ICR7dmVyc2lvbn1gLFxuICAgICAgY21kLFxuICAgICAgcmV0cnlPcHRzLFxuICAgICk7XG4gICAgaWYgKCFyZXN1bHQuc3VjY2Vzcykge1xuICAgICAgZmFpbHVyZSA9IGBcXGAke2NtZFswXX1cXGAgZmFpbGVkIChleGl0ICR7cmVzdWx0LmZpbmFsRXhpdENvZGV9KSR7XG4gICAgICAgIHJlc3VsdC5maW5hbE91dHB1dCA/IGA6ICR7cmVzdWx0LmZpbmFsT3V0cHV0fWAgOiBcIlwiXG4gICAgICB9YDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICAvLyBDbGVhbnVwIGlzIGJlc3QtZWZmb3J0OiBhIGxlZnRvdmVyIGRvd25sb2FkIG11c3Qgbm90IG1hc2sgdGhlIG91dGNvbWUuXG4gIGZvciAoY29uc3QgY21kIG9mIHBsYW4udmFsdWUuY2xlYW51cCkgYXdhaXQgcnVuRm4oY21kLCAzMCk7XG5cbiAgaWYgKGZhaWx1cmUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtsYWJlbH0gcGlubmVkIGluc3RhbGwgb2YgJHt2ZXJzaW9ufSBmYWlsZWQg4oCUICR7ZmFpbHVyZX1gLFxuICAgICk7XG4gIH1cblxuICBhd2FpdCB2ZXJpZnlQaW5uZWRWZXJzaW9uKGxvZ2dlciwgdG9vbCwgdmVyc2lvbiwgcmVhZFZlcnNpb24pO1xuICBwZXJzaXN0U3VjY2Vzcyhsb2dnZXIsIHRvb2wsIG9wdGlvbnMpO1xufVxuXG4vKiogV2hhdCBkeW5hbWljIG1vZGUgd291bGQgaW5zdGFsbCBmb3Igb25lIHRvb2wgcmlnaHQgbm93IChJc3N1ZSAjNjIzKS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRHluYW1pY1ZlcnNpb25DYW5kaWRhdGUge1xuICAvKiogVG9vbCB0aGUgY2FuZGlkYXRlIGFwcGxpZXMgdG8uICovXG4gIHRvb2w6IFBpbm5lZFRvb2w7XG4gIC8qKiBWZXJzaW9uIGR5bmFtaWMgbW9kZSB3b3VsZCBpbnN0YWxsLCBvciBudWxsIHdoZW4gdW5yZXNvbHZlZC4gKi9cbiAgdmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRydWUgd2hlbiBhIHZlcnNpb24gd2FzIHJlc29sdmVkIGFuZCBpdCBjbGVhcnMgdGhlIHF1YXJhbnRpbmUgd2luZG93LiAqL1xuICBlbGlnaWJsZTogYm9vbGVhbjtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIGV4cGxhbmF0aW9uLCBzdWl0YWJsZSBmb3IgYSBwcm9tcHQgb3IgYSBsb2cgbGluZS4gKi9cbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVwb3J0IHRoZSB2ZXJzaW9uIGR5bmFtaWMgbW9kZSB3b3VsZCBpbnN0YWxsIHJpZ2h0IG5vdyBmb3Igb25lIHRvb2xcbiAqIChJc3N1ZSAjNjIzKS5cbiAqXG4gKiBSZXNvbHZlZCB0aHJvdWdoIHRoZSBleGlzdGluZyByZWxlYXNlLWFnZSBnYXRlLCBzbyB0aGUgYW5zd2VyIGlzIHRoZSB2ZXJzaW9uXG4gKiBhbiB1bnBpbm5lZCB1cGRhdGUgd291bGQgYWN0dWFsbHkgYWRvcHQg4oCUIG5vdCBtZXJlbHkgdXBzdHJlYW0ncyBuZXdlc3QuIEFcbiAqIHZlcnNpb24gdG9vIG5ldyB0byBjbGVhciB0aGUgcXVhcmFudGluZSB3aW5kb3csIG9yIG9uZSB0aGF0IGNhbm5vdCBiZVxuICogcmVzb2x2ZWQgYXQgYWxsLCBpcyByZXBvcnRlZCBhcyBpbmVsaWdpYmxlIHdpdGggdGhlIGdhdGUncyBvd24gcmVhc29uIHJhdGhlclxuICogdGhhbiBiZWluZyByZXBvcnRlZCBhcyBhIHVzYWJsZSBkZWZhdWx0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUR5bmFtaWNWZXJzaW9uKFxuICBsb2dnZXI6IExvZ2dlcixcbiAgdG9vbDogUGlubmVkVG9vbCxcbiAgb3B0aW9uczogVG9vbFVwZGF0ZU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8RHluYW1pY1ZlcnNpb25DYW5kaWRhdGU+IHtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IHJlc29sdmVBZ2VHYXRlKGxvZ2dlciwgb3B0aW9ucykuY2hlY2soXG4gICAgVE9PTF9DSEFOTkVMU1t0b29sXSxcbiAgKTtcbiAgcmV0dXJuIHZlcmRpY3RUb0NhbmRpZGF0ZSh0b29sLCB2ZXJkaWN0KTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgd2hhdCBkeW5hbWljIG1vZGUgd291bGQgaW5zdGFsbCByaWdodCBub3cgZm9yIGV2ZXJ5IHRvb2wsIGluIHRoZVxuICogY2Fub25pY2FsIGNsYXVkZSDihpIgZ2gg4oaSIGRlbm8gb3JkZXIgKElzc3VlICM2MjMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUR5bmFtaWNWZXJzaW9ucyhcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIG9wdGlvbnM6IFRvb2xVcGRhdGVPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPER5bmFtaWNWZXJzaW9uQ2FuZGlkYXRlW10+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIFVQREFURV9UT09MUy5tYXAoKHRvb2wpID0+IHJlc29sdmVEeW5hbWljVmVyc2lvbihsb2dnZXIsIHRvb2wsIG9wdGlvbnMpKSxcbiAgKTtcbn1cblxuLyoqIEZvbGQgYSBnYXRlIHZlcmRpY3QgaW50byB0aGUgY2FuZGlkYXRlIHNoYXBlIGNhbGxlcnMgcmVwb3J0LiAqL1xuZnVuY3Rpb24gdmVyZGljdFRvQ2FuZGlkYXRlKFxuICB0b29sOiBQaW5uZWRUb29sLFxuICB2ZXJkaWN0OiBSZWxlYXNlQWdlVmVyZGljdCxcbik6IER5bmFtaWNWZXJzaW9uQ2FuZGlkYXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0b29sLFxuICAgIHZlcnNpb246IHZlcmRpY3QuZWxpZ2libGUgPyB2ZXJkaWN0LnZlcnNpb24gOiBudWxsLFxuICAgIGVsaWdpYmxlOiB2ZXJkaWN0LmVsaWdpYmxlICYmIHZlcmRpY3QudmVyc2lvbiAhPT0gbnVsbCxcbiAgICByZWFzb246IHZlcmRpY3QuZWxpZ2libGUgJiYgIXZlcmRpY3QudmVyc2lvblxuICAgICAgPyBgJHtcbiAgICAgICAgVE9PTF9MQUJFTFNbdG9vbF1cbiAgICAgIH06IHRoZSByZWxlYXNlLWFnZSBjaGVjayBwYXNzZWQgYnV0IHJlc29sdmVkIG5vIHZlcnNpb24gdG8gaW5zdGFsbC5gXG4gICAgICA6IHZlcmRpY3QucmVhc29uLFxuICB9O1xufVxuXG4vKipcbiAqIFJlcG9ydCB0aGUgbmV3ZXN0IHJlbGVhc2Ugb2Ygb25lIHRvb2wgdGhhdCBoYXMgY2xlYXJlZCB0aGUgcXVhcmFudGluZSB3aW5kb3dcbiAqIChJc3N1ZSAjNzI2KS5cbiAqXG4gKiB7QGxpbmsgcmVzb2x2ZUR5bmFtaWNWZXJzaW9ufSBhbnN3ZXJzIFwibWF5IHVwc3RyZWFtJ3MgbmV3ZXN0IGJlIGFkb3B0ZWQ/XCIg4oCUXG4gKiB0aGUgcXVlc3Rpb24gYW4gdXBncmFkZSBhc2tzLCBhbmQgb25lIHdob3NlIGFuc3dlciBpcyByb3V0aW5lbHkgXCJub3QgeWV0XCI6XG4gKiB0aGUgQ2xhdWRlIENMSSBzaGlwcyBzZXZlcmFsIHRpbWVzIGEgZGF5LCBzbyBpdHMgbmV3ZXN0IHJlbGVhc2UgaXMgYWxtb3N0XG4gKiBhbHdheXMgaW5zaWRlIHRoZSAyNGggd2luZG93LiBBIGNhbGxlciB0aGF0IGhhcyB0byAqbmFtZSogYW4gaW5zdGFsbGFibGVcbiAqIHZlcnNpb24g4oCUIHRoZSByZWxlYXNlIHRvb2wtdmVyc2lvbiBtYW5pZmVzdCDigJQgYXNrcyB0aGlzIGluc3RlYWQsIGFuZCBnZXRzXG4gKiB0aGUgbmV3ZXN0IHJlbGVhc2UgdGhlIGVtYmFyZ28gaGFzIGFscmVhZHkgbGV0IHRocm91Z2guXG4gKlxuICogVGhlIGVtYmFyZ28gaXMgdW5jaGFuZ2VkOiBhIHRvb2wgd2l0aCBub3RoaW5nIHBhc3QgdGhlIHdpbmRvdyBpcyBzdGlsbFxuICogcmVwb3J0ZWQgaW5lbGlnaWJsZSwgd2l0aCB0aGUgZ2F0ZSdzIG93biByZWFzb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlUXVhcmFudGluZUNsZWFyZWRWZXJzaW9uKFxuICBsb2dnZXI6IExvZ2dlcixcbiAgdG9vbDogUGlubmVkVG9vbCxcbiAgb3B0aW9uczogVG9vbFVwZGF0ZU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8RHluYW1pY1ZlcnNpb25DYW5kaWRhdGU+IHtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IHJlc29sdmVBZ2VHYXRlKGxvZ2dlciwgb3B0aW9ucykuY2hlY2tOZXdlc3RBZ2VkKFxuICAgIFRPT0xfQ0hBTk5FTFNbdG9vbF0sXG4gICk7XG4gIHJldHVybiB2ZXJkaWN0VG9DYW5kaWRhdGUodG9vbCwgdmVyZGljdCk7XG59XG5cbi8qKlxuICogUmVwb3J0IHRoZSBuZXdlc3QgcXVhcmFudGluZS1jbGVhcmVkIHJlbGVhc2Ugb2YgZXZlcnkgdG9vbCwgaW4gdGhlIGNhbm9uaWNhbFxuICogY2xhdWRlIOKGkiBnaCDihpIgZGVubyBvcmRlciAoSXNzdWUgIzcyNikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUXVhcmFudGluZUNsZWFyZWRWZXJzaW9ucyhcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIG9wdGlvbnM6IFRvb2xVcGRhdGVPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPER5bmFtaWNWZXJzaW9uQ2FuZGlkYXRlW10+IHtcbiAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgIFVQREFURV9UT09MUy5tYXAoKHRvb2wpID0+XG4gICAgICByZXNvbHZlUXVhcmFudGluZUNsZWFyZWRWZXJzaW9uKGxvZ2dlciwgdG9vbCwgb3B0aW9ucylcbiAgICApLFxuICApO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBDbGF1ZGUgQ0xJIHRvIGxhdGVzdCB2ZXJzaW9uIHdpdGggcmV0cnkgb24gdHJhbnNpZW50IGZhaWx1cmVzIChJc3N1ZSAjMTQ5NikuXG4gKlxuICogR2F0ZWQgb24gdGhlIHJlbGVhc2UgYWdlIG9mIGBAYW50aHJvcGljLWFpL2NsYXVkZS1jb2RlYCBvbiBucG0gKElzc3VlICMzNjU1KS5cbiAqIGBjbGF1ZGUgdXBkYXRlYCBleHBvc2VzIG5vIHZlcnNpb24gYXJndW1lbnQsIHNvIHRoaXMgdW5waW5uZWQgdXBncmFkZSBjYW5ub3RcbiAqIG5hbWUgYSB2ZXJzaW9uOyB0aGUgYWdlIGdhdGUgaXMgdGhlcmVmb3JlIHRoZSBjb250cm9sIHRoYXQga2VlcHMgYVxuICoganVzdC1wdWJsaXNoZWQg4oCUIHBvc3NpYmx5IGhpamFja2VkIOKAlCByZWxlYXNlIG91dCBvZiB0aGUgZmxlZXQuIEEgY2FsbGVyIHRoYXRcbiAqIHN1cHBsaWVzIGB0YXJnZXRWZXJzaW9uYCB0YWtlcyB0aGUgcGlubmVkIHBhdGggaW5zdGVhZCAoSXNzdWUgIzYyMyksIHdoaWNoXG4gKiBpbnN0YWxscyB0aGF0IGV4YWN0IHJlbGVhc2UgZnJvbSBpdHMgbnBtIHRhcmJhbGwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB1cGRhdGVDbGF1ZGVDbGkoXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICBvcHRpb25zOiBUb29sVXBkYXRlT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChvcHRpb25zLnNraXApIHtcbiAgICBsb2dnZXIuaW5mbyhcIkNsYXVkZSBDTEkgdXBkYXRlIHNraXBwZWQgKHNraXBDbGF1ZGU9dHJ1ZSlcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBQaW5uZWQgaW5zdGFsbCAoSXNzdWUgIzYyMyk6IGBjbGF1ZGUgdXBkYXRlYCB0YWtlcyBubyB2ZXJzaW9uIGFyZ3VtZW50LCBzb1xuICAvLyB0aGUgZXhhY3QgcmVsZWFzZSBpcyBpbnN0YWxsZWQgZnJvbSBpdHMgbnBtIHRhcmJhbGwgaW5zdGVhZC5cbiAgaWYgKG9wdGlvbnMudGFyZ2V0VmVyc2lvbikge1xuICAgIGF3YWl0IGluc3RhbGxQaW5uZWRWZXJzaW9uKFxuICAgICAgbG9nZ2VyLFxuICAgICAgXCJjbGF1ZGVcIixcbiAgICAgIG9wdGlvbnMudGFyZ2V0VmVyc2lvbixcbiAgICAgIG9wdGlvbnMsXG4gICAgKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGxvZ2dlci5pbmZvKFwiQ2hlY2tpbmcgZm9yIENsYXVkZSBDTEkgdXBkYXRlcy4uLlwiKTtcblxuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQgcmVzb2x2ZUFnZUdhdGUobG9nZ2VyLCBvcHRpb25zKS5jaGVjayh7XG4gICAga2luZDogXCJucG1cIixcbiAgICBwa2c6IENMQVVERV9DTElfTlBNX1BBQ0tBR0UsXG4gIH0pO1xuICBpZiAoIXBhc3Nlc1F1YXJhbnRpbmUobG9nZ2VyLCBcIkNsYXVkZSBDTElcIiwgdmVyZGljdCkpIHJldHVybiB0cnVlO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blVwZGF0ZVdpdGhSZXRyeShcbiAgICBsb2dnZXIsXG4gICAgXCJDbGF1ZGUgQ0xJXCIsXG4gICAgW1wiY2xhdWRlXCIsIFwidXBkYXRlXCJdLFxuICAgIGJ1aWxkUmV0cnlPcHRpb25zKG9wdGlvbnMpLFxuICApO1xuXG4gIGlmIChyZXN1bHQuc3VjY2Vzcykge1xuICAgIGxvZ2dlci5pbmZvKFwiQ2xhdWRlIENMSSB1cGRhdGUgY29tcGxldGVkIHN1Y2Nlc3NmdWxseVwiKTtcbiAgICBpZiAocmVzdWx0LmZpbmFsT3V0cHV0KSBsb2dnZXIuaW5mbyhgVXBkYXRlIG91dHB1dDogJHtyZXN1bHQuZmluYWxPdXRwdXR9YCk7XG4gICAgcGVyc2lzdFN1Y2Nlc3MobG9nZ2VyLCBcImNsYXVkZVwiLCBvcHRpb25zKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0LnN1Y2Nlc3M7XG59XG5cbi8qKlxuICogVXBncmFkZSBpbnN0YWxsZWQgYGdoYCBleHRlbnNpb25zIG9uZSBhdCBhIHRpbWUsIGVhY2ggZ2F0ZWQgb24gaXRzIG93blxuICogcmVwb3NpdG9yeSdzIHJlbGVhc2UgYWdlIChJc3N1ZSAjMzY1NSkuXG4gKlxuICogYGdoIGV4dGVuc2lvbiB1cGdyYWRlIC0tYWxsYCB1cGdyYWRlZCBhbiB1bmJvdW5kZWQgc2V0IG9mIGFyYml0cmFyeVxuICogdGhpcmQtcGFydHkgcmVwb3NpdG9yaWVzIGluIGEgc2luZ2xlIHVucGlubmVkIHN0ZXAsIHNvIG9uZSBjb21wcm9taXNlZFxuICogZXh0ZW5zaW9uIHJlYWNoZWQgZXZlcnkgaG9zdC4gRXh0ZW5zaW9ucyBhcmUgbm93IGVudW1lcmF0ZWQgd2l0aFxuICogYGdoIGV4dGVuc2lvbiBsaXN0YCBhbmQgZWFjaCBpcyBjaGVja2VkIGFnYWluc3QgdGhlIHF1YXJhbnRpbmUgd2luZG93XG4gKiBpbmRpdmlkdWFsbHkuXG4gKlxuICogKipUaGUgaW5zdGFsbCBpcyBwaW5uZWQgdG8gdGhlIHJlZiB0aGUgZ2F0ZSBkYXRlZCAoSXNzdWUgIzM5NTIpLioqIEJhcmVcbiAqIGBnaCBleHRlbnNpb24gdXBncmFkZSA8bmFtZT5gIGluc3RhbGxzIHRoZSBsYXRlc3QgcmVsZWFzZSBmb3IgYSBiaW5hcnlcbiAqIGV4dGVuc2lvbiBidXQgcHVsbHMgdGhlIGRlZmF1bHQgYnJhbmNoIGZvciBhIHNjcmlwdCBleHRlbnNpb24sIHNvIGEgZ2F0ZVxuICogdGhhdCBkYXRlZCB0aGUgbGF0ZXN0IHJlbGVhc2UgY291bGQgcGFzcyBhIG1vbnRocy1vbGQgdGFnIHdoaWxlIGJyYW5jaCBIRUFEXG4gKiDigJQgcG9zc2libHkgdGVuIG1pbnV0ZXMgb2xkIOKAlCB3YXMgd2hhdCBhY3R1YWxseSBsYW5kZWQuIEVhY2ggdXBncmFkZSBub3cgcnVuc1xuICogYGdoIGV4dGVuc2lvbiBpbnN0YWxsIDxyZXBvPiAtLXBpbiA8cmVmPiAtLWZvcmNlYCwgd2hlcmUgYDxyZWY+YCBpcyBleGFjdGx5XG4gKiB0aGUgdGFnIG9yIGNvbW1pdCBzaGEgdGhlIHZlcmRpY3QgZGF0ZWQuIEFuIGV4dGVuc2lvbiB3aG9zZSBpbnN0YWxsYWJsZSByZWZcbiAqIGNhbm5vdCBiZSBkYXRlZCBpcyBsZWZ0IGFsb25lIGFuZCByZXBvcnRlZC5cbiAqXG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gZW51bWVyYXRpb24gc3VjY2VlZGVkIGFuZCBubyBhdHRlbXB0ZWQgdXBncmFkZSBmYWlsZWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHVwZ3JhZGVHaEV4dGVuc2lvbnMoXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICBnYXRlOiBSZWxlYXNlQWdlR2F0ZSxcbiAgcmV0cnlPcHRzOiBVcGRhdGVSZXRyeU9wdGlvbnMsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcnVuRm4gPSByZXRyeU9wdHMucnVuRm4gPz8gcnVuV2l0aFRpbWVvdXQ7XG4gIGNvbnN0IGxpc3RlZCA9IGF3YWl0IHJ1bkZuKFtcImdoXCIsIFwiZXh0ZW5zaW9uXCIsIFwibGlzdFwiXSwgMzApO1xuICBpZiAoIWxpc3RlZC5vayB8fCBsaXN0ZWQudmFsdWUuZXhpdENvZGUgIT09IDApIHtcbiAgICBjb25zdCBkZXRhaWwgPSBsaXN0ZWQub2tcbiAgICAgID8gYGV4aXQgJHtsaXN0ZWQudmFsdWUuZXhpdENvZGV9OiAke2xpc3RlZC52YWx1ZS5vdXRwdXQgfHwgXCJubyBvdXRwdXRcIn1gXG4gICAgICA6IGxpc3RlZC5lcnJvci5tZXNzYWdlO1xuICAgIGxvZ2dlci53YXJuKFxuICAgICAgYENvdWxkIG5vdCBlbnVtZXJhdGUgZ2ggZXh0ZW5zaW9ucyAoJHtkZXRhaWx9KSDigJQgbm8gZXh0ZW5zaW9uIGlzIGAgK1xuICAgICAgICBgdXBncmFkZWQsIGJlY2F1c2UgYW4gdW5lbnVtZXJhdGVkIHNldCBjYW5ub3QgYmUgYWdlLWNoZWNrZWRgLFxuICAgICk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgZXh0ZW5zaW9ucyA9IHBhcnNlR2hFeHRlbnNpb25MaXN0KGxpc3RlZC52YWx1ZS5vdXRwdXQpO1xuICBpZiAoZXh0ZW5zaW9ucy5sZW5ndGggPT09IDApIHtcbiAgICBsb2dnZXIuaW5mbyhcIk5vIGdoIGV4dGVuc2lvbnMgaW5zdGFsbGVkIOKAlCBub3RoaW5nIHRvIHVwZ3JhZGVcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBsZXQgYWxsT2sgPSB0cnVlO1xuICBmb3IgKGNvbnN0IGV4dCBvZiBleHRlbnNpb25zKSB7XG4gICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGdhdGUuY2hlY2soeyBraW5kOiBcImdoLWV4dGVuc2lvblwiLCByZXBvOiBleHQucmVwbyB9KTtcbiAgICBpZiAoIXBhc3Nlc1F1YXJhbnRpbmUobG9nZ2VyLCBgZ2ggZXh0ZW5zaW9uICR7ZXh0LnJlcG99YCwgdmVyZGljdCkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBGYWlsIGxvdWQgKElzc3VlICMzMjM0KTogYW4gYXBwcm92ZWQgdmVyZGljdCB3aXRoIG5vIHJlZiBjYW5ub3QgYmVcbiAgICAvLyBpbnN0YWxsZWQgYXMgZGF0ZWQsIHNvIGl0IGlzIHJlcG9ydGVkIHJhdGhlciB0aGFuIHVwZ3JhZGVkIHVucGlubmVkLlxuICAgIGlmICghdmVyZGljdC5yZWYpIHtcbiAgICAgIGxvZ2dlci53YXJuKFxuICAgICAgICBgZ2ggZXh0ZW5zaW9uICR7ZXh0LnJlcG99IHVwZ3JhZGUgc2tpcHBlZDogdGhlIHJlbGVhc2UtYWdlIGNoZWNrIGAgK1xuICAgICAgICAgIGBhcHByb3ZlZCAke3ZlcmRpY3QudmVyc2lvbiA/PyBcImFuIHVubmFtZWQgdmVyc2lvblwifSBidXQgcmVzb2x2ZWQgYCArXG4gICAgICAgICAgYG5vIGRhdGVkIHJlZiB0byBwaW4gdGhlIGluc3RhbGwgdG9gLFxuICAgICAgKTtcbiAgICAgIGFsbE9rID0gZmFsc2U7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVXBkYXRlV2l0aFJldHJ5KFxuICAgICAgbG9nZ2VyLFxuICAgICAgYGdoIGV4dGVuc2lvbiAke2V4dC5uYW1lfWAsXG4gICAgICBbXCJnaFwiLCBcImV4dGVuc2lvblwiLCBcImluc3RhbGxcIiwgZXh0LnJlcG8sIFwiLS1waW5cIiwgdmVyZGljdC5yZWYsIFwiLS1mb3JjZVwiXSxcbiAgICAgIHJldHJ5T3B0cyxcbiAgICApO1xuICAgIGlmICghcmVzdWx0LnN1Y2Nlc3MpIGFsbE9rID0gZmFsc2U7XG4gICAgZWxzZSBpZiAocmVzdWx0LmZpbmFsT3V0cHV0KSB7XG4gICAgICBsb2dnZXIuaW5mbyhgZ2ggZXh0ZW5zaW9uICR7ZXh0Lm5hbWV9OiAke3Jlc3VsdC5maW5hbE91dHB1dH1gKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGFsbE9rO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBHSCBDTEkgYmluYXJ5ICh2aWEgYnJldykgYW5kIGV4dGVuc2lvbnMgd2l0aCByZXRyeSAoSXNzdWUgIzE0OTYpLlxuICpcbiAqIEJvdGggaGFsdmVzIGFyZSByZWxlYXNlLWFnZSBnYXRlZCAoSXNzdWUgIzM2NTUpOiB0aGUgYmluYXJ5IHVwZ3JhZGUgYWdhaW5zdFxuICogdGhlIGxhdGVzdCBgY2xpL2NsaWAgcmVsZWFzZSwgYW5kIGVhY2ggZXh0ZW5zaW9uIGFnYWluc3QgaXRzIG93biByZXBvc2l0b3J5LlxuICogYGJyZXcgdXBncmFkZSBnaGAgdGFrZXMgbm8gdmVyc2lvbiBhcmd1bWVudCwgc28gdGhlIGdhdGUgYXBwcm94aW1hdGVzIHRoZVxuICogZm9ybXVsYSdzIGFnZSB3aXRoIHRoZSBhZ2Ugb2YgdGhlIHVwc3RyZWFtIGBnaGAgcmVsZWFzZSB0aGUgZm9ybXVsYSB0cmFja3Mg4oCUXG4gKiBhIGZvcm11bGEtb25seSBjb21wcm9taXNlIHRoYXQgZG9lcyBub3QgdG91Y2ggYGNsaS9jbGlgIGlzIG91dCBvZiBpdHMgcmVhY2hcbiAqIGFuZCByZW1haW5zIGNvdmVyZWQgYnkgSG9tZWJyZXcncyBvd24gc2lnbmluZy4gQSBjYWxsZXIgdGhhdCBzdXBwbGllc1xuICogYHRhcmdldFZlcnNpb25gIHRha2VzIHRoZSBwaW5uZWQgcGF0aCBpbnN0ZWFkIChJc3N1ZSAjNjIzKSwgaW5zdGFsbGluZyB0aGF0XG4gKiBleGFjdCBgY2xpL2NsaWAgcmVsZWFzZSBhcmNoaXZlIG92ZXIgdGhlIGBnaGAgYmluYXJ5IGFscmVhZHkgb24gUEFUSC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUdoQ2xpKFxuICBsb2dnZXI6IExvZ2dlcixcbiAgb3B0aW9uczogVG9vbFVwZGF0ZU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAob3B0aW9ucy5za2lwKSB7XG4gICAgbG9nZ2VyLmluZm8oXCJHSCBDTEkgdXBkYXRlIHNraXBwZWQgKHNraXBHaD10cnVlKVwiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIFBpbm5lZCBpbnN0YWxsIChJc3N1ZSAjNjIzKTogYGJyZXcgdXBncmFkZSBnaGAgdGFrZXMgbm8gdmVyc2lvbiBhcmd1bWVudCxcbiAgLy8gc28gdGhlIGV4YWN0IHJlbGVhc2UgYXJjaGl2ZSBmb3IgdGhpcyBwbGF0Zm9ybSBpcyBpbnN0YWxsZWQgaW5zdGVhZC4gT25seVxuICAvLyB0aGUgYmluYXJ5IGlzIHBpbm5lZCDigJQgZXh0ZW5zaW9ucyBrZWVwIHRoZWlyIG93biBhZ2UtZ2F0ZWQgdXBncmFkZSBwYXRoLlxuICBpZiAob3B0aW9ucy50YXJnZXRWZXJzaW9uKSB7XG4gICAgYXdhaXQgaW5zdGFsbFBpbm5lZFZlcnNpb24obG9nZ2VyLCBcImdoXCIsIG9wdGlvbnMudGFyZ2V0VmVyc2lvbiwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBsb2dnZXIuaW5mbyhcIkNoZWNraW5nIGZvciBHSCBDTEkgdXBkYXRlcy4uLlwiKTtcblxuICBjb25zdCByZXRyeU9wdHMgPSBidWlsZFJldHJ5T3B0aW9ucyhvcHRpb25zKTtcbiAgY29uc3QgcnVuRm4gPSByZXRyeU9wdHMucnVuRm4gPz8gcnVuV2l0aFRpbWVvdXQ7XG4gIGNvbnN0IGdhdGUgPSByZXNvbHZlQWdlR2F0ZShsb2dnZXIsIG9wdGlvbnMpO1xuXG4gIC8vIFVwZ3JhZGUgR0ggQ0xJIGJpbmFyeSB2aWEgYnJldyAoaWYgYXZhaWxhYmxlKS4gYHdoaWNoIGJyZXdgIGlzIGEgc2hvcnQsXG4gIC8vIGRldGVybWluaXN0aWMgcHJvYmUgYW5kIGRvZXMgbm90IG5lZWQgcmV0cnkg4oCUIGNsYXNzaWZ5IGl0cyBhYnNlbmNlIGFzXG4gIC8vIFwiYnJldyBub3QgaW5zdGFsbGVkXCIgYW5kIHNraXAgdGhlIGJpbmFyeSB1cGdyYWRlLlxuICBsZXQgb2sgPSB0cnVlO1xuICBjb25zdCBicmV3UHJvYmUgPSBhd2FpdCBydW5GbihbXCJ3aGljaFwiLCBcImJyZXdcIl0sIDUpO1xuICBpZiAoYnJld1Byb2JlLm9rICYmIGJyZXdQcm9iZS52YWx1ZS5leGl0Q29kZSA9PT0gMCkge1xuICAgIGNvbnN0IGJpbmFyeVZlcmRpY3QgPSBhd2FpdCBnYXRlLmNoZWNrKHtcbiAgICAgIGtpbmQ6IFwiZ2l0aHViXCIsXG4gICAgICByZXBvOiBHSF9DTElfUkVMRUFTRV9SRVBPLFxuICAgIH0pO1xuICAgIGlmIChwYXNzZXNRdWFyYW50aW5lKGxvZ2dlciwgXCJHSCBDTEkgYmluYXJ5XCIsIGJpbmFyeVZlcmRpY3QpKSB7XG4gICAgICBsb2dnZXIuaW5mbyhcIlVwZ3JhZGluZyBHSCBDTEkgdmlhIGJyZXcuLi5cIik7XG4gICAgICBjb25zdCBicmV3UmVzdWx0ID0gYXdhaXQgcnVuVXBkYXRlV2l0aFJldHJ5KFxuICAgICAgICBsb2dnZXIsXG4gICAgICAgIFwiYnJldyB1cGdyYWRlIGdoXCIsXG4gICAgICAgIFtcImJyZXdcIiwgXCJ1cGdyYWRlXCIsIFwiZ2hcIl0sXG4gICAgICAgIHJldHJ5T3B0cyxcbiAgICAgICk7XG4gICAgICBpZiAoIWJyZXdSZXN1bHQuc3VjY2Vzcykgb2sgPSBmYWxzZTtcbiAgICAgIGVsc2UgaWYgKGJyZXdSZXN1bHQuZmluYWxPdXRwdXQpIHtcbiAgICAgICAgbG9nZ2VyLmluZm8oYGJyZXcgdXBncmFkZSBnaDogJHticmV3UmVzdWx0LmZpbmFsT3V0cHV0fWApO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBsb2dnZXIuaW5mbyhcImJyZXcgbm90IGF2YWlsYWJsZSDigJQgc2tpcHBpbmcgR0ggQ0xJIGJpbmFyeSB1cGdyYWRlXCIpO1xuICB9XG5cbiAgLy8gVXBncmFkZSBHSCBDTEkgZXh0ZW5zaW9ucyBpbmRpdmlkdWFsbHksIGVhY2ggYmVoaW5kIHRoZSBxdWFyYW50aW5lIHdpbmRvdy5cbiAgaWYgKGF3YWl0IHVwZ3JhZGVHaEV4dGVuc2lvbnMobG9nZ2VyLCBnYXRlLCByZXRyeU9wdHMpKSB7XG4gICAgbG9nZ2VyLmluZm8oXCJHSCBDTEkgdXBkYXRlIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgcGVyc2lzdFN1Y2Nlc3MobG9nZ2VyLCBcImdoXCIsIG9wdGlvbnMpO1xuICB9IGVsc2Uge1xuICAgIG9rID0gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIG9rO1xufVxuXG4vKipcbiAqIFVwZGF0ZSBEZW5vIHJ1bnRpbWUgd2l0aCByZXRyeSAoSXNzdWUgIzE0OTYpLlxuICpcbiAqIFRoZSB1cGdyYWRlIGlzICoqcGlubmVkKiogdG8gdGhlIHJlbGVhc2UgdGhlIHF1YXJhbnRpbmUgZ2F0ZSBhY3R1YWxseVxuICogYXBwcm92ZWQgKElzc3VlICMzNjU1KTogYGRlbm8gdXBncmFkZSA8dmVyc2lvbj5gIHJhdGhlciB0aGFuIGEgYmFyZVxuICogYGRlbm8gdXBncmFkZWAsIHNvIGEgcmVsZWFzZSBwdWJsaXNoZWQgYmV0d2VlbiB0aGUgYWdlIGNoZWNrIGFuZCB0aGUgdXBncmFkZVxuICogY2Fubm90IHNsaXAgaW4gdW5jaGVja2VkLiBBIGNhbGxlciB0aGF0IHN1cHBsaWVzIGB0YXJnZXRWZXJzaW9uYCBwaW5zIHRvIHRoYXRcbiAqIHZlcnNpb24gaW5zdGVhZCBvZiB0aGUgZ2F0ZSdzIHZlcmRpY3QgKElzc3VlICM2MjMpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlRGVubyhcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIG9wdGlvbnM6IFRvb2xVcGRhdGVPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKG9wdGlvbnMuc2tpcCkge1xuICAgIGxvZ2dlci5pbmZvKFwiRGVubyB1cGRhdGUgc2tpcHBlZCAoc2tpcERlbm89dHJ1ZSlcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBQaW5uZWQgaW5zdGFsbCAoSXNzdWUgIzYyMyk6IGBkZW5vIHVwZ3JhZGVgIGFscmVhZHkgYWNjZXB0cyBhIHZlcnNpb24sIHNvXG4gIC8vIHRoZSByZXF1ZXN0ZWQgb25lIGlzIHVzZWQgaW4gcGxhY2Ugb2YgdGhlIGFnZS1nYXRlIHZlcmRpY3QuIFRoZSBhYnNlbnQtXG4gIC8vIGJpbmFyeSBwcm9iZSBiZWxvdyBpcyBkZWxpYmVyYXRlbHkgbm90IGNvbnN1bHRlZCDigJQgYSBwaW5uZWQgaW5zdGFsbCB0aGF0XG4gIC8vIGNhbm5vdCBydW4gbXVzdCBmYWlsIGxvdWQsIG5vdCByZXR1cm4gcXVpZXRseS5cbiAgaWYgKG9wdGlvbnMudGFyZ2V0VmVyc2lvbikge1xuICAgIGF3YWl0IGluc3RhbGxQaW5uZWRWZXJzaW9uKGxvZ2dlciwgXCJkZW5vXCIsIG9wdGlvbnMudGFyZ2V0VmVyc2lvbiwgb3B0aW9ucyk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBjb25zdCByZXRyeU9wdHMgPSBidWlsZFJldHJ5T3B0aW9ucyhvcHRpb25zKTtcbiAgY29uc3QgcnVuRm4gPSByZXRyeU9wdHMucnVuRm4gPz8gcnVuV2l0aFRpbWVvdXQ7XG5cbiAgLy8gUHJlc2VuY2UgcHJvYmUgaXMgYSBvbmUtc2hvdCBjaGVjayDigJQgbm8gcmV0cnkuXG4gIGNvbnN0IGRlbm9DaGVjayA9IGF3YWl0IHJ1bkZuKFtcIndoaWNoXCIsIFwiZGVub1wiXSwgNSk7XG4gIGlmICghZGVub0NoZWNrLm9rIHx8IGRlbm9DaGVjay52YWx1ZS5leGl0Q29kZSAhPT0gMCkge1xuICAgIGxvZ2dlci5pbmZvKFwiRGVubyBub3QgaW5zdGFsbGVkIOKAlCBza2lwcGluZyB1cGRhdGVcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBsb2dnZXIuaW5mbyhcIkNoZWNraW5nIGZvciBEZW5vIHVwZGF0ZXMuLi5cIik7XG5cbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IHJlc29sdmVBZ2VHYXRlKGxvZ2dlciwgb3B0aW9ucykuY2hlY2soe1xuICAgIGtpbmQ6IFwiZ2l0aHViXCIsXG4gICAgcmVwbzogREVOT19SRUxFQVNFX1JFUE8sXG4gIH0pO1xuICBpZiAoIXBhc3Nlc1F1YXJhbnRpbmUobG9nZ2VyLCBcIkRlbm9cIiwgdmVyZGljdCkpIHJldHVybiB0cnVlO1xuICBpZiAoIXZlcmRpY3QudmVyc2lvbikge1xuICAgIGxvZ2dlci53YXJuKFwiRGVubyB1cGdyYWRlIHNraXBwZWQ6IG5vIHJlc29sdmVkIHZlcnNpb24gdG8gcGluIHRvXCIpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVXBkYXRlV2l0aFJldHJ5KFxuICAgIGxvZ2dlcixcbiAgICBcIkRlbm9cIixcbiAgICBbXCJkZW5vXCIsIFwidXBncmFkZVwiLCB2ZXJkaWN0LnZlcnNpb25dLFxuICAgIHJldHJ5T3B0cyxcbiAgKTtcblxuICBpZiAocmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICBsb2dnZXIuaW5mbyhcIkRlbm8gdXBkYXRlIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHlcIik7XG4gICAgaWYgKHJlc3VsdC5maW5hbE91dHB1dCkgbG9nZ2VyLmluZm8oYFVwZGF0ZSBvdXRwdXQ6ICR7cmVzdWx0LmZpbmFsT3V0cHV0fWApO1xuICAgIHBlcnNpc3RTdWNjZXNzKGxvZ2dlciwgXCJkZW5vXCIsIG9wdGlvbnMpO1xuICB9XG4gIHJldHVybiByZXN1bHQuc3VjY2Vzcztcbn1cblxuLyoqXG4gKiBUaGUgdXBkYXRlciBmb3IgZWFjaCB0b29sLCBzaGFyZWQgYnkgdGhlIGR5bmFtaWMgYW5kIGZyb3plbiBwYXRocy5cbiAqXG4gKiBFYWNoIHJldHVybnMgZmFsc2Ugb25seSB3aGVuIGFuIHVwZGF0ZSBpdCBhY3R1YWxseSBhdHRlbXB0ZWQgZmFpbGVkIGFmdGVyXG4gKiBpdHMgcmV0cmllcyAoSXNzdWUgIzEyNzApIOKAlCBhIHNraXAsIGEgcXVhcmFudGluZSBob2xkIG9yIGFuIGFic2VudCBiaW5hcnlcbiAqIGlzIG5vdCBhIGZhaWx1cmUuXG4gKi9cbmNvbnN0IFRPT0xfVVBEQVRFUlM6IFJlYWRvbmx5PFxuICBSZWNvcmQ8UGlubmVkVG9vbCwgKGw6IExvZ2dlciwgbzogVG9vbFVwZGF0ZU9wdGlvbnMpID0+IFByb21pc2U8Ym9vbGVhbj4+XG4+ID0ge1xuICBjbGF1ZGU6IHVwZGF0ZUNsYXVkZUNsaSxcbiAgZ2g6IHVwZGF0ZUdoQ2xpLFxuICBkZW5vOiB1cGRhdGVEZW5vLFxufTtcblxuLyoqXG4gKiBJbnN0YWxsIHRoZSBleGFjdCB2ZXJzaW9ucyBhIGZyb3plbiBob3N0IGlzIGhlbGQgYXQgKElzc3VlICM2MjUpLlxuICpcbiAqIEV2ZXJ5IHRvb2wgdGFrZXMgdGhlIHBpbm5lZCBwYXRoIGFkZGVkIGluICM2MjMsIHNvIGEgdG9vbCBhbHJlYWR5IGF0IGl0c1xuICogdmVyc2lvbiBpcyBhIG5vLW9wIGFuZCBhIHBpbm5lZCBpbnN0YWxsIHRoYXQgZG9lcyBub3QgbGFuZCB0aGUgcmVxdWVzdGVkXG4gKiB2ZXJzaW9uIHRocm93cyB3aXRoIGJvdGggdmVyc2lvbnMgbmFtZWQg4oCUIGEgbGF1bmNoIG5ldmVyIHF1aWV0bHkgY29udGludWVzXG4gKiBvbiBhIGRpZmZlcmVudCB2ZXJzaW9uIHRoYW4gdGhlIG9uZSByZWNvcmRlZCBpbiBgLmNvbmZpZy5qc29uYC5cbiAqXG4gKiAqKlRoZSByZWxlYXNlLWFnZSBxdWFyYW50aW5lIGlzIGRlbGliZXJhdGVseSBub3QgYXBwbGllZCBoZXJlLioqIFRoYXQgZ2F0ZVxuICogZXhpc3RzIHRvIGtlZXAgYSBqdXN0LXB1Ymxpc2hlZCDigJQgcG9zc2libHkgaGlqYWNrZWQg4oCUIHJlbGVhc2Ugb3V0IG9mIGFuXG4gKiB1bmF0dGVuZGVkIFwibGF0ZXN0XCIgcHVsbDsgYSBmcm96ZW4gdmVyc2lvbiBpcyBpbnN0ZWFkIGEgaHVtYW4ncyBkZWxpYmVyYXRlXG4gKiBjaG9pY2UgcmVjb3JkZWQgaW4gY29uZmlnLCBzbyB0aGVyZSBpcyBubyB1bmF0dGVuZGVkIHNlbGVjdGlvbiB0byBndWFyZC4gVGhlXG4gKiBwaW5uZWQgdmVyc2lvbiBpcyBsb2dnZWQgYXQgaW5zdGFsbCBzbyB0aGUgY2hvaWNlIHN0YXlzIGF1ZGl0YWJsZS5cbiAqXG4gKiBAdGhyb3dzIFdoZW4gYSB0b29sIGhhcyBubyBwaW5uZWQgdmVyc2lvbiwgb3IgaXRzIHBpbm5lZCBpbnN0YWxsIGZhaWxzLlxuICogQHJldHVybnMgV2hpY2ggdG9vbHMgd2VyZSBpbnN0YWxsZWQgYW5kIHdoaWNoIGEgc2tpcCBmbGFnIHN1cHByZXNzZWRcbiAqICAgKElzc3VlICMxMjcwKSwgc28gdGhlIGNhbGxlciBjYW4gcmVwb3J0IHdoYXQgdGhlIGxhdW5jaCBhY3R1YWxseSBkaWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxGcm96ZW5Ub29sVmVyc2lvbnMoXG4gIGxvZ2dlcjogTG9nZ2VyLFxuICBwaW5uZWQ6IFBpbm5lZFRvb2xWZXJzaW9ucyxcbiAgdG9vbE9wdHM6IFRvb2xVcGRhdGVPcHRpb25zLFxuICBza2lwczogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4sXG4pOiBQcm9taXNlPHsgYXR0ZW1wdGVkOiBzdHJpbmdbXTsgc2tpcHBlZDogc3RyaW5nW10gfT4ge1xuICBjb25zdCBhdHRlbXB0ZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHNraXBwZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgdG9vbCBvZiBVUERBVEVfVE9PTFMpIHtcbiAgICBjb25zdCBsYWJlbCA9IFRPT0xfTEFCRUxTW3Rvb2xdO1xuICAgIGNvbnN0IHZlcnNpb24gPSBwaW5uZWRbdG9vbF0/LnRyaW0oKTtcbiAgICBpZiAoIXZlcnNpb24pIHtcbiAgICAgIC8vIENvbmZpZyBsb2FkIGFscmVhZHkgcmVmdXNlcyBhIGhhbGYtcGlubmVkIGZyb3plbiBob3N0LCBzbyByZWFjaGluZ1xuICAgICAgLy8gaGVyZSBtZWFucyB0aGUgb3B0aW9ucyB3ZXJlIGFzc2VtYmxlZCBieSBoYW5kLiBDb250aW51aW5nIHdvdWxkIGxlYXZlXG4gICAgICAvLyB0aGlzIHRvb2wgZmxvYXRpbmcgb24gd2hhdGV2ZXIgdGhlIGhvc3QgaGFwcGVucyB0byBoYXZlLlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgdXBkYXRlX21vZGUgaXMgZnJvemVuIGJ1dCAke2xhYmVsfSBoYXMgbm8gcGlubmVkIHZlcnNpb24g4oCUIHNldCBgICtcbiAgICAgICAgICBgcGlubmVkX3Rvb2xfdmVyc2lvbnMuJHt0b29sfSByYXRoZXIgdGhhbiBsZWF2aW5nIHRoZSB0b29sIHRvIGRyaWZ0YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChza2lwc1t0b29sXSkge1xuICAgICAgc2tpcHBlZC5wdXNoKHRvb2wpO1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGAke2xhYmVsfSBpcyBwaW5uZWQgdG8gJHt2ZXJzaW9ufSAodXBkYXRlX21vZGU9ZnJvemVuKSBidXQgaXRzIGAgK1xuICAgICAgICAgIGB1cGRhdGUgaXMgc3VwcHJlc3NlZCAoJHtcbiAgICAgICAgICAgIFNLSVBfRU5WX05BTUVbdG9vbF0gPz8gXCJza2lwIGZsYWdcIlxuICAgICAgICAgIH0pIOKAlCB0aGUgYCArXG4gICAgICAgICAgYGhvc3QgbWF5IGRyaWZ0IG9mZiBpdHMgcGluYCxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgbG9nZ2VyLmluZm8oYCR7bGFiZWx9IHBpbm5lZCB0byAke3ZlcnNpb259ICh1cGRhdGVfbW9kZT1mcm96ZW4pYCk7XG4gICAgYXR0ZW1wdGVkLnB1c2godG9vbCk7XG4gICAgYXdhaXQgVE9PTF9VUERBVEVSU1t0b29sXShsb2dnZXIsIHsgLi4udG9vbE9wdHMsIHRhcmdldFZlcnNpb246IHZlcnNpb24gfSk7XG4gIH1cbiAgcmV0dXJuIHsgYXR0ZW1wdGVkLCBza2lwcGVkIH07XG59XG5cbi8qKiBWZXJzaW9uLXJlYWRpbmcgY29tbWFuZHMgcGVyIHRvb2wgKElzc3VlICMyNjIyKS4gKi9cbmNvbnN0IFZFUlNJT05fQ09NTUFORFM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPj4gPSB7XG4gIGNsYXVkZTogW1wiY2xhdWRlXCIsIFwiLS12ZXJzaW9uXCJdLFxuICBnaDogW1wiZ2hcIiwgXCItLXZlcnNpb25cIl0sXG4gIGRlbm86IFtcImRlbm9cIiwgXCItLXZlcnNpb25cIl0sXG59O1xuXG4vKiogRW52aXJvbm1lbnQgdmFyaWFibGUgdGhhdCBzdXBwcmVzc2VzIGVhY2ggdG9vbCdzIHVwZGF0ZSAoSXNzdWUgIzI2MjIpLiAqL1xuY29uc3QgU0tJUF9FTlZfTkFNRTogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7XG4gIGNsYXVkZTogXCJTS0lQX0NMQVVERV9VUERBVEVcIixcbiAgZ2g6IFwiU0tJUF9HSF9VUERBVEVcIixcbiAgZGVubzogXCJTS0lQX0RFTk9fVVBEQVRFXCIsXG59O1xuXG4vKipcbiAqIFBhcnNlIHRoZSBsZWFkaW5nIHNlbXZlciAoTUFKT1IuTUlOT1IuUEFUQ0gpIGZyb20gdmVyc2lvbiBvdXRwdXQgKElzc3VlICMyNjIyKS5cbiAqXG4gKiBBY2NlcHRzIG91dHB1dCBzdWNoIGFzIFwiMi4xLjE3MCAoQ2xhdWRlIENvZGUpXCIsIFwiZ2ggdmVyc2lvbiAyLjQwLjAgKC4uLilcIixcbiAqIG9yIFwidjEuMi4zXCIuIFJldHVybnMgbnVsbCB3aGVuIG5vIHNlbXZlci1zaGFwZWQgdG9rZW4gaXMgcHJlc2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2VtdmVyKHRleHQ6IHN0cmluZyk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXSB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHRleHQubWF0Y2goLyhcXGQrKVxcLihcXGQrKVxcLihcXGQrKS8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIFtOdW1iZXIobWF0Y2hbMV0pLCBOdW1iZXIobWF0Y2hbMl0pLCBOdW1iZXIobWF0Y2hbM10pXTtcbn1cblxuLyoqXG4gKiBDb21wYXJlIHR3byBzZW12ZXIgdHJpcGxlcyBudW1lcmljYWxseSBwZXIgc2VnbWVudCAoSXNzdWUgIzI2MjIpLlxuICpcbiAqIFJldHVybnMgYSBuZWdhdGl2ZSBudW1iZXIgd2hlbiBgYSA8IGJgLCB6ZXJvIHdoZW4gZXF1YWwsIHBvc2l0aXZlIHdoZW5cbiAqIGBhID4gYmAuIFRoZSBjb21wYXJpc29uIGlzIG51bWVyaWMgcGVyIHNlZ21lbnQsIHNvIDIuMS4xNzAgPiAyLjEuOSDigJQgYSBwbGFpblxuICogc3RyaW5nIGNvbXBhcmlzb24gd291bGQgd3JvbmdseSBvcmRlciB0aGVzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVTZW12ZXIoXG4gIGE6IHJlYWRvbmx5IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXSxcbiAgYjogcmVhZG9ubHkgW251bWJlciwgbnVtYmVyLCBudW1iZXJdLFxuKTogbnVtYmVyIHtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcbiAgICBpZiAoYVtpXSAhPT0gYltpXSkgcmV0dXJuIGFbaV0hIC0gYltpXSE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogRGV0ZXJtaW5lIHdoZXRoZXIgaW5zdGFsbGVkIHZlcnNpb24gb3V0cHV0IGlzIGJlbG93IGEgcmVxdWlyZWQgZmxvb3IgKElzc3VlICMyNjIyKS5cbiAqXG4gKiBSZXR1cm5zOlxuICogIC0gYHRydWVgICDigJQgaW5zdGFsbGVkIHZlcnNpb24gaXMgc3RyaWN0bHkgYmVsb3cgdGhlIGZsb29yLlxuICogIC0gYGZhbHNlYCDigJQgaW5zdGFsbGVkIHZlcnNpb24gaXMgYXQgb3IgYWJvdmUgdGhlIGZsb29yLlxuICogIC0gYG51bGxgICDigJQgdGhlIGluc3RhbGxlZCBvdXRwdXQgb3IgZmxvb3IgY291bGQgbm90IGJlIHBhcnNlZCAodGhlIGNhbGxlclxuICogICAgICAgICAgICAgIHNob3VsZCBmYWxsIGJhY2sgdG8gaW50ZXJ2YWwgYmVoYXZpb3VyIHdpdGggYSB3YXJuaW5nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVmVyc2lvbkJlbG93Rmxvb3IoXG4gIGluc3RhbGxlZE91dHB1dDogc3RyaW5nLFxuICBmbG9vcjogc3RyaW5nLFxuKTogYm9vbGVhbiB8IG51bGwge1xuICBjb25zdCBpbnN0YWxsZWQgPSBwYXJzZVNlbXZlcihpbnN0YWxsZWRPdXRwdXQpO1xuICBjb25zdCByZXF1aXJlZCA9IHBhcnNlU2VtdmVyKGZsb29yKTtcbiAgaWYgKCFpbnN0YWxsZWQgfHwgIXJlcXVpcmVkKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGNvbXBhcmVTZW12ZXIoaW5zdGFsbGVkLCByZXF1aXJlZCkgPCAwO1xufVxuXG4vKipcbiAqIFJlY29yZCB0aGUgdGltZSBvZiB0aGUgbW9zdCByZWNlbnQgZmxvb3ItdHJpZ2dlcmVkIHVwZGF0ZSBhdHRlbXB0IGZvciBhIHRvb2xcbiAqIChJc3N1ZSAjMjYyMikuXG4gKlxuICogR2F0ZXMgcmVwZWF0IGZsb29yIHVwZGF0ZXMgc28gYSB0b29sIHRoYXQgY2Fubm90IHJlYWNoIGl0cyBmbG9vciBkb2VzIG5vdFxuICogcmV0cnktbG9vcCBldmVyeSBpdGVyYXRpb24g4oCUIHRoZSBuZXh0IGZsb29yIGF0dGVtcHQgd2FpdHMgZm9yIHRoZSBub3JtYWxcbiAqIGludGVydmFsIHRvIGVsYXBzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZEZsb29yVXBkYXRlQXR0ZW1wdChcbiAgdGltZXN0YW1wRGlyOiBzdHJpbmcsXG4gIHRvb2w6IHN0cmluZyxcbiAgbm93Rm46ICgpID0+IG51bWJlciA9ICgpID0+IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApLFxuKTogUmVzdWx0PHZvaWQ+IHtcbiAgY29uc3QgdHNGaWxlID0gYCR7dGltZXN0YW1wRGlyfS8ubGFzdF9mbG9vcl91cGRhdGVfYXR0ZW1wdF8ke3Rvb2x9YDtcbiAgdHJ5IHtcbiAgICBEZW5vLndyaXRlVGV4dEZpbGVTeW5jKHRzRmlsZSwgU3RyaW5nKG5vd0ZuKCkpKTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogV2hldGhlciBhIGZsb29yLXRyaWdnZXJlZCB1cGRhdGUgbWF5IGJlIGF0dGVtcHRlZCBmb3IgYSB0b29sIChJc3N1ZSAjMjYyMikuXG4gKlxuICogUmV0dXJucyB0cnVlIHdoZW4gbm8gZmxvb3IgYXR0ZW1wdCBoYXMgYmVlbiByZWNvcmRlZCB3aXRoaW4gYGludGVydmFsU2Vjb25kc2BcbiAqIChvciB0aGUgcmVjb3JkIGlzIG1pc3NpbmcvaW52YWxpZCkuIFRoaXMgcmV1c2VzIHRoZSBleGlzdGluZyBpbnRlcnZhbCBhcyBhXG4gKiBiYWNrb2ZmIHNvIGFuIHVucmVhY2hhYmxlIGZsb29yIGRvZXMgbm90IHJldHJ5IGV2ZXJ5IGl0ZXJhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEF0dGVtcHRGbG9vclVwZGF0ZShcbiAgdGltZXN0YW1wRGlyOiBzdHJpbmcsXG4gIHRvb2w6IHN0cmluZyxcbiAgaW50ZXJ2YWxTZWNvbmRzOiBudW1iZXIgPSBERUZBVUxUX1VQREFURV9JTlRFUlZBTF9TRUNPTkRTLFxuICBub3dGbjogKCkgPT4gbnVtYmVyID0gKCkgPT4gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4pOiBib29sZWFuIHtcbiAgYXNzZXJ0UG9zaXRpdmVTZWNvbmRzKGludGVydmFsU2Vjb25kcywgXCJ1cGRhdGUgaW50ZXJ2YWxcIik7XG5cbiAgY29uc3QgdHNGaWxlID0gYCR7dGltZXN0YW1wRGlyfS8ubGFzdF9mbG9vcl91cGRhdGVfYXR0ZW1wdF8ke3Rvb2x9YDtcbiAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBjb250ZW50ID0gRGVuby5yZWFkVGV4dEZpbGVTeW5jKHRzRmlsZSkudHJpbSgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBpZiAoIS9eXFxkKyQvLnRlc3QoY29udGVudCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsYXN0ID0gcGFyc2VJbnQoY29udGVudCwgMTApO1xuICByZXR1cm4gbm93Rm4oKSAtIGxhc3QgPj0gaW50ZXJ2YWxTZWNvbmRzO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBkZWZhdWx0IGluc3RhbGxlZC12ZXJzaW9uIHJlYWRlciAoSXNzdWUgIzI2MjIpLlxuICpcbiAqIFNwYXducyB0aGUgdG9vbCdzIGAtLXZlcnNpb25gIGNvbW1hbmQgYW5kIHJldHVybnMgaXRzIGNvbWJpbmVkIG91dHB1dCwgb3JcbiAqIG51bGwgd2hlbiB0aGUgdG9vbCBpcyB1bmtub3duIG9yIHRoZSBjb21tYW5kIGZhaWxzLlxuICovXG5mdW5jdGlvbiBtYWtlVmVyc2lvblJlYWRlcihcbiAgcnVuRm46IChcbiAgICBjbWQ6IHN0cmluZ1tdLFxuICAgIHRpbWVvdXRTZWNvbmRzOiBudW1iZXIsXG4gICkgPT4gUHJvbWlzZTxSZXN1bHQ8eyBleGl0Q29kZTogbnVtYmVyOyBvdXRwdXQ6IHN0cmluZyB9Pj4sXG4pOiAodG9vbDogc3RyaW5nKSA9PiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgcmV0dXJuIGFzeW5jICh0b29sOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBjbWQgPSBWRVJTSU9OX0NPTU1BTkRTW3Rvb2xdO1xuICAgIGlmICghY21kKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GbihbLi4uY21kXSwgMTApO1xuICAgIGlmICghcmVzdWx0Lm9rIHx8IHJlc3VsdC52YWx1ZS5leGl0Q29kZSAhPT0gMCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHJlc3VsdC52YWx1ZS5vdXRwdXQ7XG4gIH07XG59XG5cbi8qKlxuICogUmUtcmVhZCBhIHRvb2wncyB2ZXJzaW9uIGFmdGVyIGEgZmxvb3ItdHJpZ2dlcmVkIHVwZGF0ZSBhbmQgd2FybiBpZiB0aGVcbiAqIHJlcXVpcmVkIGZsb29yIGlzIHN0aWxsIHVubWV0IChJc3N1ZSAjMjYyMikuXG4gKlxuICogQSBzdGlsbC1iZWxvdy1mbG9vciByZXN1bHQgaXMgYSBwZXJtYW5lbnQtZmFpbHVyZSBzaWduYWw6IGl0IGlzIGxvZ2dlZCBvbmNlXG4gKiAobmFtaW5nIHRoZSB0b29sLCBpbnN0YWxsZWQgdmVyc2lvbiwgYW5kIHJlcXVpcmVkIGZsb29yKSBhbmQgbm90IHJldHJpZWRcbiAqIHVudGlsIHRoZSBpbnRlcnZhbCBlbGFwc2VzIOKAlCB0aGUgY2FsbGVyIGhhcyBhbHJlYWR5IHJlY29yZGVkIGEgZmxvb3IgYXR0ZW1wdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gdmVyaWZ5Rmxvb3JBZnRlclVwZGF0ZShcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIHRvb2w6IHN0cmluZyxcbiAgZmxvb3I6IHN0cmluZyxcbiAgcmVhZFZlcnNpb246ICh0b29sOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcmVhZFZlcnNpb24odG9vbCk7XG4gIGlmIChvdXRwdXQgPT09IG51bGwpIHtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGBDb3VsZCBub3QgcmUtcmVhZCAke3Rvb2x9IHZlcnNpb24gYWZ0ZXIgYSBmbG9vci10cmlnZ2VyZWQgdXBkYXRlIChyZXF1aXJlZCBmbG9vciAke2Zsb29yfSlgLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGJlbG93ID0gaXNWZXJzaW9uQmVsb3dGbG9vcihvdXRwdXQsIGZsb29yKTtcbiAgaWYgKGJlbG93ID09PSBudWxsKSB7XG4gICAgbG9nZ2VyLndhcm4oXG4gICAgICBgQ291bGQgbm90IHBhcnNlICR7dG9vbH0gdmVyc2lvbiBcIiR7b3V0cHV0LnRyaW0oKX1cIiBhZnRlciBhIGZsb29yLXRyaWdnZXJlZCB1cGRhdGUgKHJlcXVpcmVkIGZsb29yICR7Zmxvb3J9KWAsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGJlbG93KSB7XG4gICAgY29uc3QgaW5zdGFsbGVkID0gcGFyc2VTZW12ZXIob3V0cHV0KTtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGAke3Rvb2x9IGlzIHN0aWxsIGJlbG93IHRoZSByZXF1aXJlZCB2ZXJzaW9uIGZsb29yICR7Zmxvb3J9IGFmdGVyIHVwZGF0aW5nIChpbnN0YWxsZWQgJHtcbiAgICAgICAgaW5zdGFsbGVkID8gaW5zdGFsbGVkLmpvaW4oXCIuXCIpIDogb3V0cHV0LnRyaW0oKVxuICAgICAgfSkg4oCUIGZsb29yIHVubWV0OyB3aWxsIG5vdCByZXRyeSB1bnRpbCB0aGUgaW50ZXJ2YWwgZWxhcHNlc2AsXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICBsb2dnZXIuaW5mbyhgJHt0b29sfSBub3cgbWVldHMgdGhlIHJlcXVpcmVkIHZlcnNpb24gZmxvb3IgJHtmbG9vcn1gKTtcbiAgfVxufVxuXG4vKipcbiAqIE9yY2hlc3RyYXRlIHRoZSBzb2Z0d2FyZSB1cGRhdGUgY2hlY2sgKElzc3VlcyAjOTA2LCAjMTQ5NiwgIzI2MjIsICM2MjUpLlxuICpcbiAqIFVuZGVyIGB1cGRhdGVfbW9kZTogXCJmcm96ZW5cImAgKElzc3VlICM2MjUpIHRoZSB0aHJlZSB0b29scyBhcmUgaW5zdGFsbGVkIGF0XG4gKiB0aGVpciBjb25maWd1cmVkIGBwaW5uZWRfdG9vbF92ZXJzaW9uc2AgYW5kIG5vdGhpbmcgYmVsb3cgYXBwbGllczogbm9cbiAqIGludGVydmFsLCBubyBmbG9vciwgbm8gcmVsZWFzZS1hZ2UgcXVhcmFudGluZS4gRXZlcnl0aGluZyB0aGF0IGZvbGxvd3NcbiAqIGRlc2NyaWJlcyB0aGUgYGR5bmFtaWNgIGRlZmF1bHQsIHdoaWNoIGlzIHVuY2hhbmdlZC5cbiAqXG4gKiBSdW5zIGFuIHVwZGF0ZSBmb3IgYSB0b29sIHdoZW4gKmVpdGhlciogdGhlIGludGVydmFsIGhhcyBlbGFwc2VkICpvciogdGhlXG4gKiBpbnN0YWxsZWQgdmVyc2lvbiBpcyBiZWxvdyBhIGNvbmZpZ3VyZWQgZmxvb3IgKGBtaW5WZXJzaW9uc2ApLiBUaGUgaW50ZXJ2YWxcbiAqIGdhdGUgaXMgdGhlIHdlZWtseSBjYWRlbmNlICh0aW1lc3RhbXAgZmlsZSk7IHRoZSBmbG9vciBnYXRlIGJ5cGFzc2VzIGl0IHNvIGFcbiAqIGtub3duLXRvby1vbGQgdG9vbCAoZS5nLiBDbGF1ZGUgQ0xJIGxhY2tpbmcgYC0tbW9kZWwgZmFibGVgIHN1cHBvcnQpIHVwZGF0ZXNcbiAqIGltbWVkaWF0ZWx5IHJhdGhlciB0aGFuIHdhaXRpbmcgdXAgdG8gYSB3ZWVrLlxuICpcbiAqIEZsb29yIGhhbmRsaW5nOlxuICogIC0gQmVsb3cgZmxvb3IgKyAoaW50ZXJ2YWwgZWxhcHNlZCBPUiBubyByZWNlbnQgZmxvb3IgYXR0ZW1wdCkg4oaSIGZvcmNlIHVwZGF0ZS5cbiAqICAtIEFmdGVyIGEgZmxvb3ItdHJpZ2dlcmVkIHVwZGF0ZSwgdGhlIHZlcnNpb24gaXMgcmUtcmVhZDsgc3RpbGwtYmVsb3ctZmxvb3JcbiAqICAgIGlzIGxvZ2dlZCBhcyBhIHBlcm1hbmVudCBmYWlsdXJlIGFuZCBub3QgcmV0cmllZCB1bnRpbCB0aGUgaW50ZXJ2YWxcbiAqICAgIGVsYXBzZXMgKGEgZmxvb3ItYXR0ZW1wdCB0aW1lc3RhbXAgcHJvdmlkZXMgdGhlIGJhY2tvZmYpLlxuICogIC0gVW5wYXJzZWFibGUgdmVyc2lvbiBvdXRwdXQgZmFsbHMgYmFjayB0byBpbnRlcnZhbCBiZWhhdmlvdXIgd2l0aCBhIHdhcm5pbmdcbiAqICAgIGFuZCBuZXZlciBibG9ja3MgdGhlIHdvcmtlci5cbiAqICAtIEEgc2tpcCBmbGFnIChlLmcuIFNLSVBfQ0xBVURFX1VQREFURSkgc3RpbGwgd2lucywgYnV0IGxvZ3MgdGhhdCBhIHZlcnNpb25cbiAqICAgIGZsb29yIGlzIHVubWV0IHdoZW4gaXQgc3VwcHJlc3NlcyBhIGZsb29yLXRyaWdnZXJlZCB1cGRhdGUuXG4gKlxuICogVGhlIGdsb2JhbCB3ZWVrbHkgdGltZXN0YW1wIGlzIG9ubHkgcmVjb3JkZWQgd2hlbiB0aGUgaW50ZXJ2YWwgYWN0dWFsbHlcbiAqIGVsYXBzZWQsIHNvIGEgZmxvb3Itb25seSB0cmlnZ2VyIGRvZXMgbm90IHNraXAgdGhlIG5leHQgd2Vla2x5IGdoL2Rlbm8gY2hlY2suXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja1NvZnR3YXJlVXBkYXRlcyhcbiAgbG9nZ2VyOiBMb2dnZXIsXG4gIG9wdGlvbnM6IFNvZnR3YXJlVXBkYXRlT3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxTb2Z0d2FyZVVwZGF0ZVJ1bk91dGNvbWU+IHtcbiAgLy8gRGVmZW5jZSBpbiBkZXB0aCBmb3IgSXNzdWUgIzQwNjI6IHRoZSBib290c3RyYXAgZ2F0ZXMgaXRzIGNhbGwgb25cbiAgLy8gc2tpcFNvZnR3YXJlVXBkYXRlRnJvbUVudiwgYnV0IG90aGVyIGNhbGxlcnMgKHJ1bi1jb3JlJ3MgcGVyaW9kaWMgcGF0aClcbiAgLy8gcmVhY2hlZCB0aGlzIGVudHJ5IGRpcmVjdGx5IGFuZCByYW4gdGhlIHdlZWtseSBjaGVjayBpbnNpZGUgdGhlXG4gIC8vIGNvbnRhaW5lci4gVGhlIGltYWdlIGlzIHRoZSB1cGRhdGUgbWVjaGFuaXNtLCBzbyB0aGUgZ2F0ZSBsaXZlcyBoZXJlLFxuICAvLyBjb3ZlcmluZyBldmVyeSBjYWxsZXIuXG4gIGlmIChza2lwU29mdHdhcmVVcGRhdGVGcm9tRW52KG9wdGlvbnMuZW52KSkge1xuICAgIC8vIERlYnVnLCBub3QgaW5mbyAoSXNzdWUgIzQyMTIpOiBpbiBjb250YWluZXIgbW9kZSB0aGlzIGlzIGEgcGVybWFuZW50XG4gICAgLy8gZmFjdCBvZiB0aGUgZGVwbG95bWVudCwgYW5kIHN0YXRpbmcgaXQgZXZlcnkgY3ljbGUgaXMgcHVyZSBsb2cgbm9pc2UuXG4gICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgXCJTb2Z0d2FyZSB1cGRhdGVzIHN1cHByZXNzZWQ6IGluc2lkZSB0aGUgd29ya2VyIGNvbnRhaW5lciB0aGUgaW1hZ2UgXCIgK1xuICAgICAgICBcImlzIHRoZSB1cGRhdGUgbWVjaGFuaXNtIChJc3N1ZSAjNDA2MiksIG9yIFNLSVBfU09GVFdBUkVfVVBEQVRFIGlzIFwiICtcbiAgICAgICAgXCJzZXRcIixcbiAgICApO1xuICAgIHJldHVybiB7IHN0YXR1czogXCJzdXBwcmVzc2VkXCIsIGF0dGVtcHRlZDogW10sIHNraXBwZWQ6IFtdLCBmYWlsZWQ6IFtdIH07XG4gIH1cblxuICBjb25zdCB0aW1lc3RhbXBEaXIgPSBvcHRpb25zLnRpbWVzdGFtcERpciA/P1xuICAgIChEZW5vLmVudi5nZXQoXCJIT01FXCIpID8/IERlbm8uZW52LmdldChcIlVTRVJQUk9GSUxFXCIpID8/IFwiLlwiKTtcbiAgY29uc3QgaW50ZXJ2YWxTZWNvbmRzID0gb3B0aW9ucy5pbnRlcnZhbFNlY29uZHMgPz9cbiAgICBERUZBVUxUX1VQREFURV9JTlRFUlZBTF9TRUNPTkRTO1xuICBjb25zdCB0aW1lb3V0ID0gb3B0aW9ucy50aW1lb3V0ID8/IERFRkFVTFRfVVBEQVRFX1RJTUVPVVRfU0VDT05EUztcblxuICAvLyBJc3N1ZSAjMTI3MDogcmVmdXNlIGEgTmFOIG9yIG5vbi1wb3NpdGl2ZSBkdXJhdGlvbiBoZXJlIHJhdGhlciB0aGFuXG4gIC8vIGxldHRpbmcgaXQgcmVhY2ggdGhlIGludGVydmFsIGNvbXBhcmlzb24gYW5kIGBzZXRUaW1lb3V0YCwgd2hlcmUgaXRcbiAgLy8gc2lsZW50bHkgdHVybnMgdGhlIGdhdGUgcGVybWFuZW50bHkgY2xvc2VkIGFuZCBhYm9ydHMgZXZlcnkgaW5zdGFsbFxuICAvLyB3aGlsZSB0aGUgcnVuIHN0aWxsIHJlcG9ydHMgc3VjY2Vzcy5cbiAgYXNzZXJ0UG9zaXRpdmVTZWNvbmRzKGludGVydmFsU2Vjb25kcywgXCJ1cGRhdGUgaW50ZXJ2YWxcIik7XG4gIGFzc2VydFBvc2l0aXZlU2Vjb25kcyh0aW1lb3V0LCBcInVwZGF0ZSB0aW1lb3V0XCIpO1xuICBjb25zdCBub3dGbiA9IG9wdGlvbnMubm93ID8/ICgoKSA9PiBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKSk7XG4gIGNvbnN0IG1pblZlcnNpb25zID0gb3B0aW9ucy5taW5WZXJzaW9ucyA/PyB7fTtcbiAgY29uc3QgcmVhZFZlcnNpb24gPSBvcHRpb25zLnJlYWRWZXJzaW9uID8/XG4gICAgbWFrZVZlcnNpb25SZWFkZXIob3B0aW9ucy5yZXRyeT8ucnVuRm4gPz8gcnVuV2l0aFRpbWVvdXQpO1xuXG4gIGNvbnN0IHRvb2xPcHRzOiBUb29sVXBkYXRlT3B0aW9ucyA9IHtcbiAgICB0aW1lb3V0LFxuICAgIHJldHJ5OiBvcHRpb25zLnJldHJ5LFxuICAgIHRpbWVzdGFtcERpcixcbiAgICBub3c6IG5vd0ZuLFxuICAgIHF1YXJhbnRpbmVIb3Vyczogb3B0aW9ucy5xdWFyYW50aW5lSG91cnMsXG4gICAgYWdlR2F0ZTogb3B0aW9ucy5hZ2VHYXRlLFxuICB9O1xuICBjb25zdCBza2lwczogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSB7XG4gICAgY2xhdWRlOiBvcHRpb25zLnNraXBDbGF1ZGUgPz8gZmFsc2UsXG4gICAgZ2g6IG9wdGlvbnMuc2tpcEdoID8/IGZhbHNlLFxuICAgIGRlbm86IG9wdGlvbnMuc2tpcERlbm8gPz8gZmFsc2UsXG4gIH07XG5cbiAgLy8gRnJvemVuIGhvc3RzIGluc3RhbGwgdGhlaXIgcGlucyBvbiBldmVyeSBsYXVuY2ggKElzc3VlICM2MjUpLiBUaGUgaW50ZXJ2YWxcbiAgLy8gYW5kIGZsb29yIGdhdGVzIGJlbG93IGFyZSBkeW5hbWljLW1vZGUgbWFjaGluZXJ5OiBhIHBpbiBpcyB0aGUgb3BlcmF0b3Inc1xuICAvLyByZWNvcmRlZCBkZWNpc2lvbiwgYW5kIGVkaXRpbmcgYHBpbm5lZF90b29sX3ZlcnNpb25zYCBieSBoYW5kIGlzIHRoZVxuICAvLyBzdXBwb3J0ZWQgd2F5IHRvIG1vdmUgYSBmcm96ZW4gaG9zdCwgc28gdGhlIGVkaXQgaGFzIHRvIHRha2UgZWZmZWN0IG9uIHRoZVxuICAvLyBuZXh0IGxhdW5jaCByYXRoZXIgdGhhbiBhdCB0aGUgZW5kIG9mIHRoZSB3ZWVrbHkgY2FkZW5jZS4gRWFjaCBpbnN0YWxsIGlzIGFcbiAgLy8gbm8tb3Agb25jZSB0aGUgdG9vbCByZXBvcnRzIGl0cyBwaW5uZWQgdmVyc2lvbiwgc28gcnVubmluZyBldmVyeSBsYXVuY2hcbiAgLy8gY29zdHMgb25lIGAtLXZlcnNpb25gIHJlYWQgcGVyIHRvb2wuXG4gIGlmIChvcHRpb25zLnVwZGF0ZU1vZGUgPT09IFwiZnJvemVuXCIpIHtcbiAgICBjb25zdCBmcm96ZW4gPSBhd2FpdCBpbnN0YWxsRnJvemVuVG9vbFZlcnNpb25zKFxuICAgICAgbG9nZ2VyLFxuICAgICAgb3B0aW9ucy5waW5uZWRUb29sVmVyc2lvbnMgPz8ge30sXG4gICAgICB0b29sT3B0cyxcbiAgICAgIHNraXBzLFxuICAgICk7XG4gICAgcmV0dXJuIHsgc3RhdHVzOiBcImZyb3plblwiLCAuLi5mcm96ZW4sIGZhaWxlZDogW10gfTtcbiAgfVxuXG4gIGNvbnN0IGludGVydmFsRWxhcHNlZCA9IHNob3VsZENoZWNrRm9yVXBkYXRlcyhcbiAgICB0aW1lc3RhbXBEaXIsXG4gICAgaW50ZXJ2YWxTZWNvbmRzLFxuICAgIG5vd0ZuLFxuICApO1xuXG4gIC8vIEV2YWx1YXRlIHZlcnNpb24gZmxvb3JzIChJc3N1ZSAjMjYyMikuIEEgdG9vbCBiZWxvdyBpdHMgZmxvb3IgaXMgdXBkYXRlZFxuICAvLyBpbW1lZGlhdGVseSwgYnlwYXNzaW5nIHRoZSBpbnRlcnZhbCBnYXRlOyB1bnBhcnNlYWJsZSB2ZXJzaW9ucyBmYWxsIGJhY2tcbiAgLy8gdG8gaW50ZXJ2YWwgYmVoYXZpb3VyIHdpdGggYSB3YXJuaW5nLlxuICBjb25zdCBiZWxvd0Zsb29yID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTsgLy8gdG9vbCAtPiBmbG9vclxuICBjb25zdCBmbG9vclRyaWdnZXJlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IFt0b29sLCBmbG9vcl0gb2YgT2JqZWN0LmVudHJpZXMobWluVmVyc2lvbnMpKSB7XG4gICAgaWYgKCFmbG9vcikgY29udGludWU7XG4gICAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgcmVhZFZlcnNpb24odG9vbCk7XG4gICAgaWYgKG91dHB1dCA9PT0gbnVsbCkge1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGBDb3VsZCBub3QgcmVhZCAke3Rvb2x9IHZlcnNpb24gZm9yIGZsb29yIGNoZWNrIChmbG9vciAke2Zsb29yfSkg4oCUIHVzaW5nIGludGVydmFsIGJlaGF2aW91cmAsXG4gICAgICApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGJlbG93ID0gaXNWZXJzaW9uQmVsb3dGbG9vcihvdXRwdXQsIGZsb29yKTtcbiAgICBpZiAoYmVsb3cgPT09IG51bGwpIHtcbiAgICAgIGxvZ2dlci53YXJuKFxuICAgICAgICBgQ291bGQgbm90IHBhcnNlICR7dG9vbH0gdmVyc2lvbiBmcm9tIFwiJHtvdXRwdXQudHJpbSgpfVwiIGZvciBmbG9vciAke2Zsb29yfSDigJQgdXNpbmcgaW50ZXJ2YWwgYmVoYXZpb3VyYCxcbiAgICAgICk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFiZWxvdykgY29udGludWU7XG4gICAgYmVsb3dGbG9vci5zZXQodG9vbCwgZmxvb3IpO1xuICAgIGlmIChcbiAgICAgIGludGVydmFsRWxhcHNlZCB8fFxuICAgICAgc2hvdWxkQXR0ZW1wdEZsb29yVXBkYXRlKHRpbWVzdGFtcERpciwgdG9vbCwgaW50ZXJ2YWxTZWNvbmRzLCBub3dGbilcbiAgICApIHtcbiAgICAgIGZsb29yVHJpZ2dlcmVkLmFkZCh0b29sKTtcbiAgICAgIGxvZ2dlci5pbmZvKFxuICAgICAgICBgJHt0b29sfSBpbnN0YWxsZWQgdmVyc2lvbiBpcyBiZWxvdyByZXF1aXJlZCBmbG9vciAke2Zsb29yfSDigJQgZm9yY2luZyB1cGRhdGVgLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nZ2VyLmluZm8oXG4gICAgICAgIGAke3Rvb2x9IGlzIGJlbG93IGZsb29yICR7Zmxvb3J9IGJ1dCBhIGZsb29yIHVwZGF0ZSB3YXMgYXR0ZW1wdGVkIHJlY2VudGx5IOKAlCBkZWZlcnJpbmcgdW50aWwgdGhlIGludGVydmFsIGVsYXBzZXNgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoIWludGVydmFsRWxhcHNlZCAmJiBmbG9vclRyaWdnZXJlZC5zaXplID09PSAwKSB7XG4gICAgbG9nZ2VyLmluZm8oXCJTb2Z0d2FyZSB1cGRhdGVzIGNoZWNrZWQgcmVjZW50bHkg4oCUIHNraXBwaW5nXCIpO1xuICAgIHJldHVybiB7IHN0YXR1czogXCJub3QtZHVlXCIsIGF0dGVtcHRlZDogW10sIHNraXBwZWQ6IFtdLCBmYWlsZWQ6IFtdIH07XG4gIH1cblxuICBsb2dnZXIuaW5mbyhcbiAgICBpbnRlcnZhbEVsYXBzZWRcbiAgICAgID8gXCJSdW5uaW5nIHdlZWtseSBzb2Z0d2FyZSB1cGRhdGUgY2hlY2suLi5cIlxuICAgICAgOiBgUnVubmluZyBmbG9vci10cmlnZ2VyZWQgc29mdHdhcmUgdXBkYXRlICgke1xuICAgICAgICBbLi4uZmxvb3JUcmlnZ2VyZWRdLmpvaW4oXCIsIFwiKVxuICAgICAgfSkuLi5gLFxuICApO1xuXG4gIGNvbnN0IGF0dGVtcHRlZDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2tpcHBlZDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZmFpbGVkOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIFByZXNlcnZlIHRoZSBoaXN0b3JpY2FsIGNsYXVkZSDihpIgZ2gg4oaSIGRlbm8gb3JkZXJpbmcuXG4gIGZvciAoY29uc3QgdG9vbCBvZiBVUERBVEVfVE9PTFMpIHtcbiAgICBpZiAoIShpbnRlcnZhbEVsYXBzZWQgfHwgZmxvb3JUcmlnZ2VyZWQuaGFzKHRvb2wpKSkgY29udGludWU7XG4gICAgY29uc3Qgc2tpcCA9IHNraXBzW3Rvb2xdID8/IGZhbHNlO1xuICAgIGNvbnN0IGZsb29yID0gYmVsb3dGbG9vci5nZXQodG9vbCk7XG4gICAgaWYgKHNraXAgJiYgZmxvb3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgIGAke3Rvb2x9IGlzIGJlbG93IHRoZSByZXF1aXJlZCB2ZXJzaW9uIGZsb29yICR7Zmxvb3J9IGJ1dCB0aGUgdXBkYXRlIGlzIHN1cHByZXNzZWQgKCR7XG4gICAgICAgICAgU0tJUF9FTlZfTkFNRVt0b29sXSA/PyBcInNraXAgZmxhZ1wiXG4gICAgICAgIH0pYCxcbiAgICAgICk7XG4gICAgfVxuICAgIChza2lwID8gc2tpcHBlZCA6IGF0dGVtcHRlZCkucHVzaCh0b29sKTtcbiAgICBpZiAoIWF3YWl0IFRPT0xfVVBEQVRFUlNbdG9vbF0obG9nZ2VyLCB7IC4uLnRvb2xPcHRzLCBza2lwIH0pKSB7XG4gICAgICBmYWlsZWQucHVzaCh0b29sKTtcbiAgICB9XG4gICAgaWYgKGZsb29yVHJpZ2dlcmVkLmhhcyh0b29sKSkge1xuICAgICAgLy8gUmVjb3JkIHRoZSBhdHRlbXB0IHJlZ2FyZGxlc3Mgb2Ygb3V0Y29tZSBzbyBhbiB1bnJlYWNoYWJsZSBmbG9vciBkb2VzXG4gICAgICAvLyBub3QgcmV0cnktbG9vcCBldmVyeSBpdGVyYXRpb24uXG4gICAgICByZWNvcmRGbG9vclVwZGF0ZUF0dGVtcHQodGltZXN0YW1wRGlyLCB0b29sLCBub3dGbik7XG4gICAgICBpZiAoIXNraXAgJiYgZmxvb3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBhd2FpdCB2ZXJpZnlGbG9vckFmdGVyVXBkYXRlKGxvZ2dlciwgdG9vbCwgZmxvb3IsIHJlYWRWZXJzaW9uKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBPbmx5IHRoZSBmdWxsIHdlZWtseSBjYWRlbmNlIHJlc2V0cyB0aGUgZ2xvYmFsIGludGVydmFsIHRpbWVzdGFtcDsgYVxuICAvLyBmbG9vci1vbmx5IHRyaWdnZXIgbXVzdCBub3Qgc2tpcCB0aGUgbmV4dCB3ZWVrbHkgZ2gvZGVubyBjaGVjay5cbiAgaWYgKGludGVydmFsRWxhcHNlZCkge1xuICAgIHJlY29yZFVwZGF0ZUNoZWNrKHRpbWVzdGFtcERpciwgbm93Rm4pO1xuICB9XG5cbiAgLy8gSXNzdWUgIzEyNzA6IGFuIHVwZGF0ZSB0aGF0IHdhcyBhdHRlbXB0ZWQgYW5kIGZhaWxlZCBpcyBzdGF0ZWQsIG5vdCBsZWZ0XG4gIC8vIHRvIGEgd2FybmluZyBidXJpZWQgaW4gdGhlIG1pZGRsZSBvZiB0aGUgbG9nLiBUaGUgd29ya2VyIHN0aWxsIGNvbnRpbnVlc1xuICAvLyDigJQgdGhlIGNhbGxlciBkZWNpZGVzIHdoYXQgYSBmYWlsZWQgdG9vbCB1cGRhdGUgbWVhbnMgZm9yIGl0cyBvd24gZXhpdFxuICAvLyBzdGF0dXMuXG4gIGlmIChmYWlsZWQubGVuZ3RoID4gMCkge1xuICAgIGxvZ2dlci5lcnJvcihcbiAgICAgIGBTb2Z0d2FyZSB1cGRhdGUgZmFpbGVkIGZvcjogJHtmYWlsZWQuam9pbihcIiwgXCIpfSDigJQgdGhlIGhvc3QgaXMgc3RpbGwgYCArXG4gICAgICAgIGBydW5uaW5nIHRoZSB2ZXJzaW9ucyBpdCBoYWRgLFxuICAgICk7XG4gIH1cblxuICBsb2dnZXIuaW5mbyhcbiAgICBpbnRlcnZhbEVsYXBzZWRcbiAgICAgID8gXCJXZWVrbHkgc29mdHdhcmUgdXBkYXRlIGNoZWNrIGNvbXBsZXRlXCJcbiAgICAgIDogXCJGbG9vci10cmlnZ2VyZWQgc29mdHdhcmUgdXBkYXRlIGNvbXBsZXRlXCIsXG4gICk7XG5cbiAgcmV0dXJuIHsgc3RhdHVzOiBcInJhblwiLCBhdHRlbXB0ZWQsIHNraXBwZWQsIGZhaWxlZCB9O1xufVxuXG4vKiogQ29uZmlnIGZpZWxkcyB7QGxpbmsgc29mdHdhcmVVcGRhdGVPcHRpb25zRnJvbUVudn0gcmVhZHMuICovXG5leHBvcnQgaW50ZXJmYWNlIFNvZnR3YXJlVXBkYXRlQ29uZmlnIHtcbiAgLyoqIFBlci10b29sIG1pbmltdW0gdmVyc2lvbiBmbG9vcnMgKElzc3VlICMyNjIyKS4gKi9cbiAgc29mdHdhcmVNaW5WZXJzaW9ucz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKiBNYXhpbXVtIHJldHJ5IGF0dGVtcHRzIHBlciB1cGRhdGUgY29tbWFuZC4gKi9cbiAgdXBkYXRlUmV0cnlNYXhBdHRlbXB0cz86IG51bWJlcjtcbiAgLyoqIEV4cG9uZW50aWFsIGJhY2tvZmYgZGVsYXlzIGJldHdlZW4gcmV0cmllcy4gKi9cbiAgdXBkYXRlUmV0cnlCYWNrb2ZmU2Vjb25kcz86IHJlYWRvbmx5IG51bWJlcltdO1xuICAvKipcbiAgICogSG93IHRoaXMgaG9zdCB0cmFja3MgcmVsZWFzZXMgKElzc3VlICM2MjUsIGAuY29uZmlnLmpzb25gIGB1cGRhdGVfbW9kZWApLlxuICAgKiBBYnNlbnQgcmVhZHMgYXMgYGR5bmFtaWNgLlxuICAgKi9cbiAgdXBkYXRlTW9kZT86IFVwZGF0ZU1vZGU7XG4gIC8qKiBFeGFjdCB2ZXJzaW9ucyBhIGZyb3plbiBob3N0IGluc3RhbGxzIChJc3N1ZSAjNjI1KS4gKi9cbiAgcGlubmVkVG9vbFZlcnNpb25zPzogUGlubmVkVG9vbFZlcnNpb25zO1xufVxuXG4vKiogUmVhZCBhbiBvcHRpb25hbCBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gdGhlIGVudmlyb25tZW50LiAqL1xuZnVuY3Rpb24gZW52SW50KFxuICBnZXRFbnY6IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgbmFtZTogc3RyaW5nLFxuKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gZ2V0RW52KG5hbWUpO1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIiB8fCAhL15cXGQrJC8udGVzdChyYXcudHJpbSgpKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHBhcnNlSW50KHJhdywgMTApO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBzb2Z0d2FyZS11cGRhdGUgb3B0aW9ucyBldmVyeSBwcm9kdWN0aW9uIGVudHJ5IHBvaW50IHVzZXNcbiAqIChJc3N1ZSAjMzY1NSkuXG4gKlxuICogVGhyZWUgY2FsbGVycyBwcmV2aW91c2x5IGFzc2VtYmxlZCB0aGlzIG9wdGlvbiBzZXQgYnkgaGFuZCDigJQgdGhlIHJ1bi1jb3JlXG4gKiBwcm9kdWN0aW9uIGRlcHMsIHRoZSBgcnVuLWJvb3RzdHJhcGAgY29tbWFuZCwgYW5kIChub3QgYXQgYWxsKSB0aGVcbiAqIGBydW4tZW50cnlwb2ludGAgZHJpdmVyLiBUaGUgZHJpdmVyJ3Mgb21pc3Npb24gbWVhbnQgdGhlIGRvY3VtZW50ZWRcbiAqIGBTS0lQX0NMQVVERV9VUERBVEVgIC8gYFNLSVBfR0hfVVBEQVRFYCAvIGBTS0lQX0RFTk9fVVBEQVRFYCBvcHQtb3V0cyB3ZXJlXG4gKiBuZXZlciBjb25zdWx0ZWQgb24gdGhlIHByaW1hcnkgcGF0aDogc2V0dGluZyB0aGVtIGRpZCBub3Qgc3RvcCB0aGUgdXBncmFkZVxuICogdGhlIHdvcmtlciBwZXJmb3JtZWQgYXQgc3RhcnR1cC4gT25lIHNoYXJlZCBidWlsZGVyIGtlZXBzIHRoZSB0aHJlZSBwYXRoc1xuICogZnJvbSBkcmlmdGluZyBhcGFydCBhZ2Fpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNvZnR3YXJlVXBkYXRlT3B0aW9uc0Zyb21FbnYoXG4gIGNvbmZpZzogU29mdHdhcmVVcGRhdGVDb25maWcgPSB7fSxcbiAgZ2V0RW52OiAobmFtZTogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQgPSAobmFtZSkgPT4gRGVuby5lbnYuZ2V0KG5hbWUpLFxuKTogU29mdHdhcmVVcGRhdGVPcHRpb25zIHtcbiAgY29uc3QgaG9tZSA9IGdldEVudihcIkhPTUVcIikgPz8gZ2V0RW52KFwiVVNFUlBST0ZJTEVcIikgPz8gXCIuXCI7XG4gIHJldHVybiB7XG4gICAgdGltZXN0YW1wRGlyOiBnZXRFbnYoXCJTT0ZUV0FSRV9VUERBVEVfVElNRVNUQU1QX0RJUlwiKSA/PyBob21lLFxuICAgIGludGVydmFsU2Vjb25kczogZW52SW50KGdldEVudiwgXCJTT0ZUV0FSRV9VUERBVEVfQ0hFQ0tfSU5URVJWQUxfU0VDT05EU1wiKSxcbiAgICB0aW1lb3V0OiBlbnZJbnQoZ2V0RW52LCBcIkNMQVVERV9VUERBVEVfVElNRU9VVFwiKSxcbiAgICBtaW5WZXJzaW9uczogY29uZmlnLnNvZnR3YXJlTWluVmVyc2lvbnMsXG4gICAgc2tpcENsYXVkZTogZ2V0RW52KFwiU0tJUF9DTEFVREVfVVBEQVRFXCIpID09PSBcInRydWVcIixcbiAgICBza2lwR2g6IGdldEVudihcIlNLSVBfR0hfVVBEQVRFXCIpID09PSBcInRydWVcIixcbiAgICBza2lwRGVubzogZ2V0RW52KFwiU0tJUF9ERU5PX1VQREFURVwiKSA9PT0gXCJ0cnVlXCIsXG4gICAgcXVhcmFudGluZUhvdXJzOiBlbnZJbnQoZ2V0RW52LCBcIlZJQkVfQlVNUF9RVUFSQU5USU5FX0hPVVJTXCIpLFxuICAgIC8vIElzc3VlICM2MjU6IHRoZSBtb2RlIGFuZCBpdHMgcGlucyByZWFjaCBldmVyeSBlbnRyeSBwb2ludCB0aHJvdWdoIHRoaXNcbiAgICAvLyBvbmUgYnVpbGRlciwgc28gYSBmcm96ZW4gaG9zdCBpbnN0YWxscyBpdHMgcGlucyBvbiB3aGljaGV2ZXIgcGF0aFxuICAgIC8vIGxhdW5jaGVkIGl0LlxuICAgIHVwZGF0ZU1vZGU6IGNvbmZpZy51cGRhdGVNb2RlLFxuICAgIHBpbm5lZFRvb2xWZXJzaW9uczogY29uZmlnLnBpbm5lZFRvb2xWZXJzaW9ucyxcbiAgICByZXRyeToge1xuICAgICAgbWF4QXR0ZW1wdHM6IGNvbmZpZy51cGRhdGVSZXRyeU1heEF0dGVtcHRzLFxuICAgICAgYmFja29mZlNlY29uZHM6IGNvbmZpZy51cGRhdGVSZXRyeUJhY2tvZmZTZWNvbmRzLFxuICAgIH0sXG4gIH07XG59XG5cbi8qKlxuICogV2hldGhlciB0aGUgd2hvbGUgc29mdHdhcmUtdXBkYXRlIHN0ZXAgaXMgc3VwcHJlc3NlZCAoSXNzdWUgIzM2NTUpLlxuICpcbiAqIEFsd2F5cyBzdXBwcmVzc2VkIGluc2lkZSB0aGUgd29ya2VyIGNvbnRhaW5lciAodGhlIGltYWdlIHN0YW1wc1xuICogVklCRV9JTUFHRV9BR0VOVF9QUk9WSURFUlMpOiB0aGUgaW1hZ2UgaXMgdGhlIHVwZGF0ZSBtZWNoYW5pc21cbiAqIChJc3N1ZSAjNDA2Mikg4oCUIGV2ZXJ5IHRvb2wgdmVyc2lvbiBpcyBwaW5uZWQgYW5kIGNoZWNrc3VtLXZlcmlmaWVkIGF0XG4gKiBidWlsZCB0aW1lLCBzbyBhIHJ1bi10aW1lIHNlbGYtdXBkYXRlIHdvdWxkIGluc3RhbGwgdW5waW5uZWQgcGFja2FnZXNcbiAqIGludG8gYW4gZXBoZW1lcmFsIFZNLCByZXBlYXQgb24gZXZlcnkgcnVuLCBhbmQgc2l0IG91dHNpZGUgdGhlIGltYWdlJ3NcbiAqIHN1cHBseS1jaGFpbiBndWFyYW50ZWVzLiBCdW1waW5nIHRoZSBwaW4gaW4gY29udGFpbmVyL3Rvb2xzLmpzb24gYW5kIHRoZVxuICogQ29udGFpbmVyZmlsZSBjaGFuZ2VzIHRoZSB0YWcgYW5kIHJlYnVpbGRzIGluc3RlYWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBza2lwU29mdHdhcmVVcGRhdGVGcm9tRW52KFxuICBnZXRFbnY6IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCA9IChuYW1lKSA9PiBEZW5vLmVudi5nZXQobmFtZSksXG4pOiBib29sZWFuIHtcbiAgaWYgKGdldEVudihcIlNLSVBfU09GVFdBUkVfVVBEQVRFXCIpID09PSBcInRydWVcIikgcmV0dXJuIHRydWU7XG4gIC8vIEJ5IHZhbHVlLCBub3QgcHJlc2VuY2U6IGEgYmxhbmsgc3RhbXAgaXMgYSBob3N0IHJ1biwgd2hpY2ggc3RpbGwgbmVlZHNcbiAgLy8gdGhlIHVwZGF0ZSBzdGVwIChJc3N1ZSAjMTQ5MykuXG4gIHJldHVybiBydW5uaW5nSW5Db250YWluZXJJbWFnZShnZXRFbnYpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWdDQyxHQVFELFNBQ0Usc0JBQXNCLEVBQ3RCLG9CQUFvQixFQUNwQixpQkFBaUIsRUFDakIsbUJBQW1CLEVBQ25CLGlCQUFpQixFQUNqQixvQkFBb0IsUUFJZix3QkFBd0I7QUFDL0IsU0FBUyxPQUFPLFFBQVEsZ0JBQWdCO0FBQ3hDLFNBQVMsdUJBQXVCLFFBQVEsdUJBQXVCO0FBQy9ELFNBQ0UscUJBQXFCLEVBQ3JCLDhCQUE4QixRQUN6Qiw0QkFBNEI7QUFFbkMsc0RBQXNELEdBQ3RELE9BQU8sTUFBTSxrQ0FBa0MsT0FBTztBQUV0RCx3REFBd0QsR0FDeEQsT0FBTyxNQUFNLGlDQUFpQyxJQUFJO0FBRWxELDhFQUE4RSxHQUM5RSxPQUFPLE1BQU0sb0NBQW9DLEVBQUU7QUFFbkQ7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sdUNBQTBEO0VBQ3JF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
// denoCacheMetadata=15207909470959650340,2523482014293937148