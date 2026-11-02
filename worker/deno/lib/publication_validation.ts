/** Runner-owned repository checks required before completed work is published. */

import { runGitCommand } from "./git_timeout.ts";
import { computeWorkingTreeDigest } from "./quality_gate_cache.ts";
import { runRepositoryCommand } from "./untrusted_gate_spawn.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

export type PublicationValidationResult =
  | { status: "passed"; identity: string }
  | { status: "failed"; identity: string | null; output: string }
  | { status: "unavailable"; identity: string | null; reason: string };

export interface PublicationValidationDeps {
  run?: typeof runRepositoryCommand;
  identity?: (cwd: string) => Promise<string | null>;
}

const MAX_OUTPUT = 12_000;
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 5_000;
const UNAVAILABLE_MARKER = "[PUBLICATION_VALIDATION_UNAVAILABLE]";

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(hash),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** Identify the exact checkout contents, including staged, unstaged and new files. */
export async function publicationTreeIdentity(
  cwd: string,
): Promise<string | null> {
  let root: string;
  try {
    root = await Deno.realPath(cwd);
  } catch {
    return null;
  }
  const [head, tree, bash, deno] = await Promise.all([
    runGitCommand(["rev-parse", "HEAD"], { cwd }),
    computeWorkingTreeDigest(cwd),
    runWithTimeout("bash", ["--version"], { timeoutMs: TOOL_PROBE_TIMEOUT_MS }),
    runWithTimeout("deno", ["--version"], { timeoutMs: TOOL_PROBE_TIMEOUT_MS }),
  ]);
  if (
    !head.ok || head.value.code !== 0 || tree === null || !bash.ok ||
    bash.value.code !== 0 || bash.value.timedOut
  ) {
    return null;
  }
  // Repositories may use a different toolchain. Record Deno when installed,
  // but let their own quality.sh decide whether it is required.
  const denoVersion = deno.ok && deno.value.code === 0 && !deno.value.timedOut
    ? deno.value.stdout
    : "deno-unavailable";
  const commandEnvironment = Object.entries(Deno.env.toObject())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return await digest([
    head.ok ? head.value.stdout.trim() : "",
    root,
    tree,
    "./quality.sh --strict",
    bash.ok ? bash.value.stdout : "",
    denoVersion,
    Deno.execPath(),
    ...commandEnvironment,
  ].join("\0"));
}

/** Execute the target repository's own required quality entry point. */
export async function validateRepositoryForPublication(
  cwd: string,
  deps: PublicationValidationDeps = {},
): Promise<PublicationValidationResult> {
  const identify = deps.identity ?? publicationTreeIdentity;
  const before = await identify(cwd);
  if (before === null) {
    return {
      status: "unavailable",
      identity: null,
      reason: "could not identify the checkout before quality validation",
    };
  }
  let result: Awaited<ReturnType<typeof runRepositoryCommand>>;
  try {
    result = await (deps.run ?? runRepositoryCommand)("./quality.sh", [
      "--strict",
    ], {
      cwd,
      timeoutMs: CHECK_TIMEOUT_MS,
      manifests: ["quality.sh"],
    });
  } catch (error) {
    return {
      status: "unavailable",
      identity: before,
      reason: `${UNAVAILABLE_MARKER} ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`,
    };
  }
  if (!result.ok) {
    return {
      status: "unavailable",
      identity: before,
      reason: `${UNAVAILABLE_MARKER} ${redactSecrets(result.error.message)}`,
    };
  }
  const fullOutput = redactSecrets(
    `${result.value.stdout}\n${result.value.stderr}`.trim(),
  );
  const output = fullOutput.slice(-MAX_OUTPUT);
  if (result.value.timedOut) {
    return {
      status: "unavailable",
      identity: before,
      reason: `${UNAVAILABLE_MARKER} quality.sh timed out; ${output}`,
    };
  }
  if (result.value.code !== 0) {
    if (isUnavailableOutput(fullOutput)) {
      return {
        status: "unavailable",
        identity: before,
        reason: `${UNAVAILABLE_MARKER} ${output}`,
      };
    }
    return { status: "failed", identity: before, output };
  }
  const after = await identify(cwd);
  if (after === null) {
    return {
      status: "unavailable",
      identity: before,
      reason: "could not identify the checkout after quality validation",
    };
  }
  if (after !== before) {
    return {
      status: "failed",
      identity: before,
      output: "checkout changed while quality.sh was running; rerun validation",
    };
  }
  return { status: "passed", identity: before };
}

function isUnavailableOutput(output: string): boolean {
  return /(?:command not found|not installed|insufficient disk|no space left on device|disk quota exceeded|could not resolve|temporary failure in name resolution|connection (?:timed out|refused)|failed to (?:download|fetch)|error sending request|network (?:error|is unreachable))/i
    .test(output);
}

/** Refuse publication when the successful result no longer describes the tree. */
export async function publicationValidationIsCurrent(
  result: PublicationValidationResult,
  cwd: string,
  identify = publicationTreeIdentity,
): Promise<boolean> {
  return result.status === "passed" &&
    await identify(cwd) === result.identity;
}
