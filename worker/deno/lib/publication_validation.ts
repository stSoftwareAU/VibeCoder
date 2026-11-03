/**
 * Runner-owned validation before completed work is published (Issue #4625).
 *
 * Every lane that pushes agent-authored work (issue completion, CI repair, PR
 * feedback, babysitter repair) asks the same question here: does the target
 * repository's own trusted gate (`./quality.sh`, in its configured Docker
 * image and with its declared credentials, exactly as the quality-gate phase
 * runs it) pass on the committed head about to be pushed?
 *
 * The answer is one of three outcomes, and only `passed` publishes:
 *
 * - `passed`: the gate ran and succeeded on a clean checkout (`gate: "ran"`),
 *   or the repository has no local gate (`gate: "absent"`) or the operator
 *   opted out of quality checks (`gate: "opted-out"`);
 * - `failed`: the gate ran and rejected the head, the head carries
 *   uncommitted changes the push would leave out, or a Deno test run executed
 *   no tests. The output goes back to the lane for repair;
 * - `unavailable`: the gate could not run here (missing tool, Docker or
 *   credential fault, unreadable checkout). Not a verdict on the change: the
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
} from "./quality_gate_phase.ts";
import { resolveRepoCredentials } from "./repo_credentials.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import { stripAnsi } from "./github_actions_log_fetcher.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";

export type PublicationValidation =
  | { status: "passed"; head: string; gate: "ran" | "absent" | "opted-out" }
  | { status: "failed"; head: string | null; output: string }
  | { status: "unavailable"; head: string | null; reason: string };

export interface PublicationRequest {
  /** The checkout whose HEAD is about to be pushed. */
  cwd: string;
  repo: string;
  repoConfigs?: Record<string, RepoConfig>;
}

export interface PublicationValidationDeps {
  /** The gate runner. Production: {@link runQualityGateCheck}. */
  runGate?: (
    params: QualityGateParams,
    deps: QualityGateDeps,
  ) => Promise<QualityGateRunResult>;
}

const OUTPUT_HEAD_CHARS = 4_000;
const OUTPUT_TAIL_CHARS = 8_000;

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
): QualityGateDeps {
  const resolve = (path: string) =>
    path.startsWith("/") ? path : `${cwd}/${path.replace(/^\.\//, "")}`;
  return {
    ...base,
    // A configured command is a shell line, not a file to look for.
    fileExists: (path) =>
      customCommand ? Promise.resolve(true) : base.fileExists(resolve(path)),
    detectMissingTools: (script) => base.detectMissingTools(resolve(script)),
    runCommand: (cmd, options) => base.runCommand(cmd, { ...options, cwd }),
    getCwd: () => cwd,
  };
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
  try {
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
    const gateDeps = gateDepsFor(
      cwd,
      createDefaultDeps(credentials.value.env),
      command !== "./quality.sh",
    );
    const result = await (deps.runGate ?? runQualityGateCheck)(
      { repo, qualityScript: command, repoConfigs },
      gateDeps,
    );
    const after = await inspectCheckout(cwd);
    if (typeof after === "string" || after.head !== before.head) {
      return {
        status: "unavailable",
        head: before.head,
        reason: "HEAD moved while the checks ran; the result is discarded",
      };
    }
    return classify(result, before.head);
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

function classify(
  result: QualityGateRunResult,
  head: string,
): PublicationValidation {
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
    case "failed":
      return { status: "failed", head, output: text };
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
