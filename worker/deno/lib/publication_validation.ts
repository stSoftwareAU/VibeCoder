/**
 * Runner-owned validation before completed work is published (Issue #4625).
 *
 * Every lane that pushes agent-authored work (issue completion, CI repair, PR
 * feedback, babysitter repair) asks the same question here: does the target
 * repository's own trusted gate (`./quality.sh`, in its configured Docker
 * image and with its declared credentials, as the quality-gate phase runs it
 * except that `requireSeparateAccount` refuses the runner account) pass on the committed head about to be pushed?
 *
 * The answer is one of three outcomes, and only `passed` publishes:
 *
 * - `passed`: the gate ran and succeeded on a clean checkout (`gate: "ran"`),
 *   or the repository has no local gate (`gate: "absent"`) or the operator
 *   opted out of quality checks (`gate: "opted-out"`);
 * - `failed`: the gate ran and rejected the head, the head carries
 *   uncommitted changes the push would leave out, a Deno test run executed
 *   no tests, or the gate was killed by its timeout (exit 124, 137 or 143).
 *   The output goes back to the lane for repair;
 * - `unavailable`: the gate could not run here (missing tool, Docker or
 *   credential fault, unreadable checkout, a host out of disk, or a failure
 *   that reproduces on the PR's base commit). Not a verdict on the change: the
 *   lane releases or defers and the next cycle retries.
 *
 * The result is tied to the head it validated. An agent that commits again
 * produces a new head, which is validated afresh.
 */

import type { RepoConfig, Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import { describeUnpushedCommits } from "./git_remote_head.ts";
import { PrePushGateInfrastructureError } from "./pre_push_gate.ts";
import {
  createDefaultDeps,
  type QualityGateDeps,
  type QualityGateParams,
  type QualityGateRunResult,
  runQualityGateCheck,
  SeparateAccountRequiredError,
} from "./quality_gate_phase.ts";
import { resolveRepoCredentials } from "./repo_credentials.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import { stripAnsi } from "./github_actions_log_fetcher.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";
import {
  canRunAsUntrustedUser,
  probeCommandSuccess,
  UNTRUSTED_USER,
} from "./untrusted_command_env.ts";
import { normaliseGateOutputLines } from "./baseline_gate.ts";

export type PublicationValidation =
  | { status: "passed"; head: string; gate: "ran" | "absent" | "opted-out" }
  | { status: "failed"; head: string | null; output: string }
  | { status: "unavailable"; head: string | null; reason: string };

export interface PublicationRequest {
  /** The checkout whose HEAD is about to be pushed. */
  cwd: string;
  repo: string;
  repoConfigs?: Record<string, RepoConfig>;
  /**
   * Refuse to run the gate as the runner's own account. The default gate drops
   * to the `agent` account where the host has one and otherwise falls back to
   * the runner, whose credential files the repository's code could then read.
   * A caller whose runner holds write-capable credentials (the fleet PR
   * babysitter, THREAT-MODEL control C36) sets this: with no separate account
   * the result is `unavailable`, never a run as the runner.
   */
  requireSeparateAccount?: boolean;
  /**
   * The ref a failing gate is compared against (for example `origin/main`).
   * Defaults to the remote's default branch. See {@link reproducesOnBase}.
   */
  baseRef?: string;
}

export interface PublicationValidationDeps {
  /** Whether the host can run commands as a separate account. */
  canDropPrivileges?: () => Promise<boolean>;
  /** The gate runner. Production: {@link runQualityGateCheck}. */
  runGate?: (
    params: QualityGateParams,
    deps: QualityGateDeps,
  ) => Promise<QualityGateRunResult>;
  /**
   * Builds the base gate deps for a checkout from its declared credentials.
   * `requireSeparateAccount` is the request's flag, for the spawn to refuse
   * the runner account. Production: {@link createDefaultDeps}.
   */
  createDeps?: (
    env: Record<string, string>,
    requireSeparateAccount?: boolean,
  ) => QualityGateDeps;
  /** Whether the container runtime a `docker_image` gate needs answers. */
  dockerAvailable?: () => Promise<boolean>;
  /**
   * Whether the separate account can enter the checkout and read the gate
   * script (`script` is undefined for a configured command). Production:
   * {@link separateAccountCanReach}.
   */
  reachableBySeparateAccount?: (
    cwd: string,
    script: string | undefined,
  ) => Promise<boolean>;
}

const SEPARATE_ACCOUNT_REASON =
  "no separate account to run the repository's own commands without " +
  "exposing the runner's credentials (THREAT-MODEL C36)";

const CLONE_UNREACHABLE_REASON =
  "the separate account cannot enter the checkout, so the repository's own " +
  "commands cannot run there (the clone must be traversable and readable by it)";

/**
 * Whether the separate account can enter `cwd` and read `script` (when given):
 * the gate runs there as that account, so a checkout it cannot traverse is not
 * a checkout the gate can run in. Argv only; the paths are never spliced into
 * a shell line.
 */
export function separateAccountCanReach(
  cwd: string,
  script: string | undefined,
): Promise<boolean> {
  return probeCommandSuccess([
    "sudo",
    "-n",
    "-u",
    UNTRUSTED_USER,
    "--",
    "sh",
    "-c",
    'test -x "$1" && test -r "$1" && { [ -z "$2" ] || test -r "$2"; }',
    "sh",
    cwd,
    script ?? "",
  ]);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const OUTPUT_HEAD_CHARS = 4_000;
const OUTPUT_TAIL_CHARS = 8_000;

/**
 * Exit codes that mean the gate was killed by its timeout: 124 from `timeout`
 * itself, and 137 (SIGKILL) or 143 (SIGTERM) when `--kill-after` or the
 * runner ends the process. A gate that exits with one of these was stopped by
 * time, not by a failing check.
 */
const GATE_TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137, 143]);

/**
 * Output that means the host ran out of disk while the gate ran. Plain literal
 * alternation, so matching is linear; case-insensitive.
 */
const DISK_FULL_PATTERN = /No space left on device|ENOSPC|Disk quota exceeded/i;

/**
 * Output lines that name or quote text rather than report the host's own
 * error: a Deno test-result line (`<name> ... ok`), the same name in the
 * failure listing (`<name> => file:line:col`), a quoted source line
 * (`12 | ...`) and a pass-count line. A passing test called "names the ENOSPC
 * export failure" must not make a failing gate read as a full disk. Anchored
 * alternation without nested quantifiers, so matching is linear.
 */
const QUOTED_TEXT_LINE =
  /(?:\.\.\. (?:ok|FAILED|ignored)\b| => \S+:\d+:\d+\s*$|^\s*\d+ \| |^(?:ok|FAILED) \| \d+ passed)/;

/**
 * The gate's timeout when the repository sets no `quality_check_timeout`. The
 * quality-gate phase's 600-second default kills a repository whose own gate
 * takes longer, and that kill would then read as a content failure. A
 * repository's own `quality_check_timeout` still overrides this value.
 */
export const PUBLICATION_GATE_TIMEOUT_SECONDS = 1800;

/** The gate rejected the head; the message carries its output for repair. */
export class PublicationValidationFailedError extends Error {
  constructor(message: string) {
    super(`Repository checks failed before publication:\n${message}`);
    this.name = "PublicationValidationFailedError";
  }
}

/** The gate could not run here: infrastructure, never a verdict. */
export class PublicationValidationUnavailableError
  extends PrePushGateInfrastructureError {
  constructor(message: string) {
    super(`Repository checks could not run before publication: ${message}`);
    this.name = "PublicationValidationUnavailableError";
  }
}

interface Checkout {
  head: string;
  /** Paths with uncommitted changes, excluding the worker's own state files. */
  uncommitted: string[];
}

async function inspectCheckout(cwd: string): Promise<Checkout | string> {
  const head = await runGitCommand(["rev-parse", "HEAD"], { cwd });
  if (!head.ok || head.value.code !== 0) {
    return `could not read HEAD: ${
      head.ok ? head.value.stderr.trim() : head.error.message
    }`;
  }
  const status = await runGitCommand(["status", "--porcelain"], { cwd });
  if (!status.ok || status.value.code !== 0) {
    return `could not read the working tree: ${
      status.ok ? status.value.stderr.trim() : status.error.message
    }`;
  }
  const uncommitted = status.value.stdout.split("\n")
    .filter((line) => line.trim() !== "")
    // `XY path` or `XY old -> new`: the path is what follows the status code.
    .map((line) => line.slice(3).split(" -> ").at(-1)!)
    .filter((path) => !isWorkerStatePath(path));
  return { head: head.value.stdout.trim(), uncommitted };
}

/** Sum the tests every Deno summary line in the output says were executed. */
function denoTestsExecuted(output: string): number | null {
  const pattern =
    /\b(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed/g;
  let total: number | null = null;
  for (const match of stripAnsi(output).matchAll(pattern)) {
    total = (total ?? 0) + Number(match[1]) + Number(match[2]);
  }
  return total;
}

function gateDepsFor(
  cwd: string,
  base: QualityGateDeps,
  customCommand: boolean,
  observed: { exitCode?: number; refusedAsRunner?: boolean },
  canDrop: (() => Promise<boolean>) | undefined,
): QualityGateDeps {
  const resolve = (path: string) =>
    path.startsWith("/") ? path : `${cwd}/${path.replace(/^\.\//, "")}`;
  const hostRun = canDrop !== undefined;
  const noSweep = () => Promise.resolve();
  return {
    ...base,
    // The port and process sweeps were written for the isolated worker
    // container: `lsof | kill -9` and `pgrep -f | kill -9` across the whole
    // machine. A caller that runs on a shared host (`requireSeparateAccount`)
    // must not kill the operator's other processes, nor another repair's gate.
    cleanupPorts: hostRun ? noSweep : base.cleanupPorts,
    cleanupSubprocesses: hostRun ? noSweep : base.cleanupSubprocesses,
    // A configured command is a shell line, not a file to look for.
    fileExists: (path) =>
      customCommand ? Promise.resolve(true) : base.fileExists(resolve(path)),
    detectMissingTools: (script) => base.detectMissingTools(resolve(script)),
    runCommand: async (cmd, options) => {
      if (canDrop !== undefined && !(await canDrop())) {
        // Fail closed: the command would run as the runner (C36).
        observed.refusedAsRunner = true;
        throw new PublicationValidationUnavailableError(
          SEPARATE_ACCOUNT_REASON,
        );
      }
      let result;
      try {
        result = await base.runCommand(cmd, { ...options, cwd });
      } catch (error) {
        // The spawn itself refused the runner account (the argv that would
        // have run carried no separate account).
        if (error instanceof SeparateAccountRequiredError) {
          observed.refusedAsRunner = true;
        }
        throw error;
      }
      // The gate result carries no exit code, so the most recent one is kept
      // for classify. The result itself is passed back unchanged.
      observed.exitCode = result.exitCode;
      return result;
    },
    getCwd: () => cwd,
  };
}

/**
 * Whether this host can run the repository's gate at all, answered without
 * starting an agent session or the gate: the cheap, fixed properties of the
 * host (PR #4800 review). A string is the reason it cannot; `undefined` means
 * nothing found that stops it. A repository with no gate, or one that opted
 * out of quality checks, is never refused. The tools `quality.sh` needs are
 * not probed here: that needs the script's own text, which the gate reads.
 */
export async function probePublicationCapability(
  request: PublicationRequest,
  deps: Pick<
    PublicationValidationDeps,
    | "canDropPrivileges"
    | "dockerAvailable"
    | "reachableBySeparateAccount"
  >,
): Promise<string | undefined> {
  const config = request.repoConfigs?.[request.repo];
  if (config?.skipQualityCheck) return undefined;
  const command = config?.qualityCommand || "./quality.sh";
  try {
    if (
      command === "./quality.sh" && !await isFile(`${request.cwd}/quality.sh`)
    ) {
      return undefined;
    }
    if (
      request.requireSeparateAccount &&
      !await (deps.canDropPrivileges ?? canRunAsUntrustedUser)()
    ) {
      return SEPARATE_ACCOUNT_REASON;
    }
    if (
      request.requireSeparateAccount &&
      !await (deps.reachableBySeparateAccount ?? separateAccountCanReach)(
        request.cwd,
        command === "./quality.sh" ? `${request.cwd}/quality.sh` : undefined,
      )
    ) {
      return CLONE_UNREACHABLE_REASON;
    }
    if (
      config?.dockerImage &&
      !await (deps.dockerAvailable ??
        (() => probeCommandSuccess(["docker", "version"])))()
    ) {
      return "the repository's gate runs in a Docker image and Docker is not " +
        "available on this host";
    }
  } catch (error) {
    return `the host's capability to run the checks could not be probed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return undefined;
}

/**
 * Run the repository's own gate on the committed head in `request.cwd`.
 * Never throws for a gate outcome; a thrown fault is reported as `unavailable`.
 */
export async function validateRepositoryForPublication(
  request: PublicationRequest,
  deps: PublicationValidationDeps = {},
): Promise<PublicationValidation> {
  const { cwd, repo, repoConfigs } = request;
  const before = await inspectCheckout(cwd);
  if (typeof before === "string") {
    return { status: "unavailable", head: null, reason: before };
  }
  if (before.uncommitted.length > 0) {
    return {
      status: "failed",
      head: before.head,
      output: `The working tree has uncommitted changes the push would leave ` +
        `out, so the checks cannot vouch for what is published. Commit or ` +
        `discard: ${before.uncommitted.slice(0, 20).join(", ")}`,
    };
  }
  const config = repoConfigs?.[repo];
  if (config?.skipQualityCheck) {
    return { status: "passed", head: before.head, gate: "opted-out" };
  }
  const command = config?.qualityCommand || "./quality.sh";
  // Probed at most once per request: two spawns whose answer cannot change.
  let dropProbe: Promise<boolean> | undefined;
  const canDrop = request.requireSeparateAccount
    ? () => dropProbe ??= (deps.canDropPrivileges ?? canRunAsUntrustedUser)()
    : undefined;
  // Likewise probed at most once per request, as the separate account.
  const gateScript = command === "./quality.sh"
    ? `${cwd}/quality.sh`
    : undefined;
  let reachProbe: Promise<boolean> | undefined;
  const canReach = () =>
    reachProbe ??= (deps.reachableBySeparateAccount ?? separateAccountCanReach)(
      cwd,
      gateScript,
    );
  try {
    // Decided before the gate is entered, so a refused gate has no side
    // effects: no credential mint, no sweep, no spawn (PR #4800 review). A
    // repository with no gate to run is not refused.
    if (
      canDrop !== undefined && !(await canDrop()) &&
      (command !== "./quality.sh" || await isFile(`${cwd}/quality.sh`))
    ) {
      return {
        status: "unavailable",
        head: before.head,
        reason: SEPARATE_ACCOUNT_REASON,
      };
    }
    // The same gate, but the account can drop and cannot enter the clone: the
    // gate would fail on permissions, which must not read as a verdict.
    if (
      canDrop !== undefined && await canDrop() &&
      (command !== "./quality.sh" || await isFile(`${cwd}/quality.sh`)) &&
      !await canReach()
    ) {
      return {
        status: "unavailable",
        head: before.head,
        reason: CLONE_UNREACHABLE_REASON,
      };
    }
    const credentials = await resolveRepoCredentials(
      repo,
      config?.qualityCredentials,
    );
    if (!credentials.ok) {
      return {
        status: "unavailable",
        head: before.head,
        reason:
          `declared quality credentials could not be resolved: ${credentials.error.message}`,
      };
    }
    const observed: { exitCode?: number; refusedAsRunner?: boolean } = {};
    const baseDeps = deps.createDeps
      ? deps.createDeps(credentials.value.env, request.requireSeparateAccount)
      : createDefaultDeps(
        credentials.value.env,
        undefined,
        request.requireSeparateAccount === true,
      );
    const runGateAt = (dir: string, seen: typeof observed) =>
      (deps.runGate ?? runQualityGateCheck)(
        {
          repo,
          qualityScript: command,
          repoConfigs,
          defaultTimeoutSeconds: PUBLICATION_GATE_TIMEOUT_SECONDS,
        },
        gateDepsFor(
          dir,
          baseDeps,
          command !== "./quality.sh",
          seen,
          canDrop,
        ),
      );
    // A throw from a refused spawn reaches the catch below as `unavailable`;
    // a runner that swallows it is caught by the flag check.
    const result = await runGateAt(cwd, observed);
    if (observed.refusedAsRunner) {
      return {
        status: "unavailable",
        head: before.head,
        reason: SEPARATE_ACCOUNT_REASON,
      };
    }
    const after = await inspectCheckout(cwd);
    if (typeof after === "string") {
      return {
        status: "unavailable",
        head: before.head,
        reason: `could not re-read the checkout after the checks ran: ${after}`,
      };
    }
    if (after.head !== before.head) {
      return {
        status: "unavailable",
        head: before.head,
        reason: "HEAD moved while the checks ran; the result is discarded",
      };
    }
    const verdict = classify(result, before.head, observed.exitCode);
    if (
      verdict.status === "failed" && isContentFailure(result, observed.exitCode)
    ) {
      const base = await reproducesOnBase({
        cwd,
        repo,
        baseRef: request.baseRef,
        headOutput: result.qualityOutput,
        runAt: (dir) => {
          const seen: typeof observed = {};
          return runGateAt(dir, seen).then((outcome) => ({
            outcome,
            refused: seen.refusedAsRunner === true,
          }));
        },
      });
      if (base !== undefined) {
        return {
          status: "unavailable",
          head: before.head,
          reason: `the same failure reproduces on ${base}, so the change ` +
            `did not cause it (host or pre-existing)`,
        };
      }
    }
    return verdict;
  } catch (error) {
    return {
      status: "unavailable",
      head: before.head,
      reason: `the checks threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Why a gate that exited non-zero was starved of disk rather than rejecting
 * the change. `undefined` when no disk fault is reported.
 */
function gateInfrastructureFault(
  output: string,
  _exitCode: number | undefined,
): string | undefined {
  const line = output.split("\n").find((candidate) =>
    !QUOTED_TEXT_LINE.test(candidate) && DISK_FULL_PATTERN.test(candidate)
  );
  if (line !== undefined) {
    return `the host ran out of disk: ${
      redactedHeadTail(line.trim(), OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS)
    }`;
  }
  return undefined;
}

/** A gate failure that is the change's content, not a timeout or disk fault. */
function isContentFailure(
  result: QualityGateRunResult,
  exitCode: number | undefined,
): boolean {
  return (result.action === "failed" || result.action === "failed_fixable") &&
    !(exitCode !== undefined && GATE_TIMEOUT_EXIT_CODES.has(exitCode)) &&
    gateInfrastructureFault(result.qualityOutput, exitCode) === undefined;
}

/** A checkout's path as given and as the filesystem resolves it. */
async function checkoutRoots(path: string): Promise<string[]> {
  try {
    const real = await Deno.realPath(path);
    return real === path ? [path] : [real, path];
  } catch (_error) {
    // The checkout is gone; its path as given is all that can be replaced.
    return [path];
  }
}

/**
 * Lines that say a test, step or check went well, or restate counts that move
 * when a change adds or renames a test or file. They are not evidence of a
 * failure, and a head that adds a passing test must not read as a different
 * failure. The last alternative is the gate's per-check pass line,
 * `<label>: PASSED` with an optional parenthesised count (for example
 * `hardcoded branch names: PASSED (12 files scanned)`, see
 * `lib/quality_gate.ts`). Anchored alternations without nested quantifiers, so
 * matching is linear.
 */
const NON_FAILURE_LINE =
  /(?:\.\.\. (?:ok|ignored)\b|^(?:ok|FAILED) \| \d+ passed|^running \d+ tests? from |^test result: |^(?:Check|Download) |^[^:\n]{1,100}: PASSED\b)/;

/**
 * The normalised lines that evidence a gate failure: the output with each
 * checkout path replaced by one token (a stack frame names the checkout it ran
 * in, and the base runs in another), and passing or count-only lines dropped.
 */
export function failureEvidenceLines(
  output: string,
  roots: readonly string[],
): string[] {
  let text = output;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (root !== "") text = text.split(root).join("<checkout>");
  }
  return normaliseGateOutputLines(text).filter((line) =>
    !NON_FAILURE_LINE.test(line)
  );
}

/** What the gate did on a base commit, kept per `repo@sha` for the process. */
const baseGateOutcomes = new Map<string, Promise<string[] | null>>();

/** Forget the cached base outcomes. Tests only. */
export function _resetBaseGateOutcomes(): void {
  baseGateOutcomes.clear();
}

async function resolveBase(
  cwd: string,
  baseRef: string | undefined,
): Promise<{ ref: string; sha: string } | undefined> {
  const candidates = baseRef
    ? [baseRef]
    : ["origin/HEAD", "origin/main", "origin/master"];
  for (const ref of candidates) {
    const parsed = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd },
    );
    if (parsed.ok && parsed.value.code === 0 && parsed.value.stdout.trim()) {
      return { ref, sha: parsed.value.stdout.trim() };
    }
  }
  return undefined;
}

/**
 * Whether a failing gate fails the same way on the PR's base commit on this
 * host (the check-agnostic idea of `decidePreExistingGateFailure`, Issue
 * #1852). The base run happens in a throwaway detached worktree and is cached
 * per base SHA. Reproduces only when the base gate also failed and every
 * failure evidence line of the head (`failureEvidenceLines`) is already in the
 * base's.
 * Anything unreadable, refused or different is "does not reproduce": the
 * failure stays a content verdict.
 *
 * @returns The base label (`ref@sha`) when the failure reproduces
 */
async function reproducesOnBase(options: {
  cwd: string;
  repo: string;
  baseRef: string | undefined;
  headOutput: string;
  runAt: (
    dir: string,
  ) => Promise<{ outcome: QualityGateRunResult; refused: boolean }>;
}): Promise<string | undefined> {
  const base = await resolveBase(options.cwd, options.baseRef);
  if (base === undefined) return undefined;
  const key = `${options.repo}@${base.sha}`;
  let pending = baseGateOutcomes.get(key);
  if (pending === undefined) {
    pending = runGateOnBase(options.cwd, base.sha, options.runAt);
    baseGateOutcomes.set(key, pending);
  }
  const baseLines = await pending;
  if (baseLines === null) return undefined;
  const known = new Set(baseLines);
  const headLines = failureEvidenceLines(
    options.headOutput,
    await checkoutRoots(options.cwd),
  );
  if (headLines.length === 0 || !headLines.every((line) => known.has(line))) {
    return undefined;
  }
  return `${base.ref}@${base.sha.slice(0, 12)}`;
}

/** The base gate's normalised failure lines, or null when it did not fail. */
async function runGateOnBase(
  cwd: string,
  sha: string,
  runAt: (
    dir: string,
  ) => Promise<{ outcome: QualityGateRunResult; refused: boolean }>,
): Promise<string[] | null> {
  const dir = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vibe-base-gate-",
  });
  try {
    // A makeTempDir directory is 0700, and the gate runs as the separate
    // `agent` account where the host has one: it must reach the tree, as it
    // reaches the lane's own checkout. The tree holds a public clone.
    await Deno.chmod(dir, 0o755);
    const added = await runGitCommand(
      ["worktree", "add", "--detach", "--force", `${dir}/tree`, sha],
      { cwd },
    );
    if (!added.ok || added.value.code !== 0) return null;
    try {
      const { outcome, refused } = await runAt(`${dir}/tree`);
      if (refused) return null;
      return outcome.action === "failed" || outcome.action === "failed_fixable"
        ? failureEvidenceLines(
          outcome.qualityOutput,
          await checkoutRoots(`${dir}/tree`),
        )
        : null;
    } finally {
      await runGitCommand(["worktree", "remove", "--force", `${dir}/tree`], {
        cwd,
      });
    }
  } catch (error) {
    console.error(
      `[publication] the base-commit gate comparison could not run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      console.error(
        `[publication] could not remove the base-gate scratch '${dir}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function classify(
  result: QualityGateRunResult,
  head: string,
  exitCode: number | undefined,
): PublicationValidation {
  if (
    result.action !== "passed" && exitCode !== undefined &&
    GATE_TIMEOUT_EXIT_CODES.has(exitCode)
  ) {
    return {
      status: "failed",
      head,
      output:
        `the repository gate timed out (exit ${exitCode}) and was killed at its time limit`,
    };
  }
  const text = redactedHeadTail(
    result.failureMessage ?? result.qualityOutput,
    OUTPUT_HEAD_CHARS,
    OUTPUT_TAIL_CHARS,
  );
  switch (result.action) {
    case "skipped":
      return { status: "passed", head, gate: "absent" };
    case "passed": {
      if (denoTestsExecuted(result.qualityOutput) === 0) {
        return {
          status: "failed",
          head,
          output:
            "The Deno test run executed no tests (0 passed, 0 failed); a zero " +
            "exit with an empty selection is not a passing check.",
        };
      }
      return { status: "passed", head, gate: "ran" };
    }
    case "failed_fixable":
    case "failed": {
      const fault = gateInfrastructureFault(result.qualityOutput, exitCode);
      if (fault !== undefined) {
        return { status: "unavailable", head, reason: fault };
      }
      return { status: "failed", head, output: text };
    }
    case "failed_missing_tools":
    case "failed_missing_command":
    case "failed_docker_infra":
    case "failed_credential_delivery":
      return {
        status: "unavailable",
        head,
        reason: `${result.action}: ${text}`,
      };
    default: {
      const unknown: never = result.action;
      return {
        status: "unavailable",
        head,
        reason: `unrecognised gate outcome ${String(unknown)}`,
      };
    }
  }
}

/** Turn a validation into the `Result` a `beforePush` seam expects. */
export function publicationVerdict(
  validation: PublicationValidation,
): Result<void> {
  switch (validation.status) {
    case "passed":
      return { ok: true, value: undefined };
    case "failed":
      return {
        ok: false,
        error: new PublicationValidationFailedError(validation.output),
      };
    case "unavailable":
      return {
        ok: false,
        error: new PublicationValidationUnavailableError(validation.reason),
      };
  }
}

export interface PublicationGuardOptions extends PublicationRequest {
  /** The branch being pushed; a branch with nothing to publish is not checked. */
  branchName: string;
  validate?: typeof validateRepositoryForPublication;
}

/**
 * A `beforePush` guard: validates the head about to leave the host, once per
 * head. Calls for a head that already passed (a retry push, a repeated
 * callback) reuse that verdict only while the checkout is still clean; any
 * new commit or uncommitted edit is validated afresh. A branch already in sync
 * with its remote head has nothing to publish and is not checked.
 */
export function createPublicationGuard(
  options: PublicationGuardOptions,
): () => Promise<Result<void>> {
  const passed = new Set<string>();
  const validate = options.validate ?? validateRepositoryForPublication;
  return async () => {
    const state = await describeUnpushedCommits(options.branchName, {
      cwd: options.cwd,
    });
    if (state.ok && state.value.sha !== null && state.value.count === 0) {
      return { ok: true, value: undefined };
    }
    const checkout = await inspectCheckout(options.cwd);
    if (
      typeof checkout !== "string" && checkout.uncommitted.length === 0 &&
      passed.has(checkout.head)
    ) {
      return { ok: true, value: undefined };
    }
    const validation = await validate(options);
    if (validation.status === "passed") passed.add(validation.head);
    return publicationVerdict(validation);
  };
}

/**
 * Validate a head the AGENT pushed itself (Issue #4625). The worker's
 * `beforePush` guard never sees such a push: by the time the round finalises
 * the branch is in sync with its remote, so the guard has nothing to publish.
 * The head has already left the host, so a failed or unavailable verdict
 * cannot undo it; the caller must not report the round as a successful push.
 */
export async function validateSelfPushedHead(
  options: PublicationRequest & {
    validate?: typeof validateRepositoryForPublication;
  },
): Promise<Result<void>> {
  const validate = options.validate ?? validateRepositoryForPublication;
  return publicationVerdict(await validate(options));
}
