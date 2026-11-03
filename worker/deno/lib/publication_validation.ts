/** Runner-owned repository checks required before completed work is published. */

import { stripAnsi } from "./github_actions_log_fetcher.ts";
import { PrePushGateInfrastructureError } from "./pre_push_gate.ts";
import {
  findProjectManifests,
  readManifestTasks,
  UNIT_SUITE_TASKS,
} from "./project_manifests.ts";
import { runGitCommand } from "./git_timeout.ts";
import { computeWorkingTreeDigest } from "./quality_gate_cache.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import { manifestsFor, runRepositoryCommand } from "./untrusted_gate_spawn.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

export type PublicationValidationResult =
  | {
    status: "passed";
    identity: string;
    command?: string;
    deno?: { command: string; cwd: string; executedTests: number }[];
  }
  | { status: "failed"; identity: string | null; output: string }
  | { status: "unavailable"; identity: string | null; reason: string };

export interface PublicationValidationDeps {
  /** Operator-configured quality_command, preserving its flags and working directory. */
  command?: string;
  run?: typeof runRepositoryCommand;
  identity?: (cwd: string) => Promise<string | null>;
}

const MAX_OUTPUT = 12_000;
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 5_000;
export class PublicationValidationUnavailableError
  extends PrePushGateInfrastructureError {}

const DEFAULT_COMMAND = "./quality.sh";
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
  command = DEFAULT_COMMAND,
  environment = Deno.env.toObject(),
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
  // but let their own configured entry point decide whether it is required.
  const denoVersion = deno.ok && deno.value.code === 0 && !deno.value.timedOut
    ? deno.value.stdout
    : "deno-unavailable";
  const commandEnvironment = Object.entries(environment)
    .filter(([key]) =>
      !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE)/i
        .test(key)
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  return await digest([
    head.ok ? head.value.stdout.trim() : "",
    root,
    tree,
    command,
    JSON.stringify(await requiredDenoTasks(cwd)),
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
  const command = deps.command || DEFAULT_COMMAND;
  const identify = deps.identity ??
    ((dir: string) => publicationTreeIdentity(dir, command));
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
    result = await (deps.run ?? runRepositoryCommand)("bash", ["-c", command], {
      cwd,
      timeoutMs: CHECK_TIMEOUT_MS,
      manifests: command === DEFAULT_COMMAND ? ["quality.sh"] : [],
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
  const output = redactedHeadTail(
    fullOutput,
    MAX_OUTPUT / 2,
    MAX_OUTPUT / 2,
  );
  if (result.value.timedOut) {
    return {
      status: "unavailable",
      identity: before,
      reason: `${UNAVAILABLE_MARKER} repository gate timed out; ${output}`,
    };
  }
  if (result.value.code !== 0) {
    if (isUnavailableOutput(result.value.stderr, fullOutput)) {
      return {
        status: "unavailable",
        identity: before,
        reason: `${UNAVAILABLE_MARKER} ${output}`,
      };
    }
    return { status: "failed", identity: before, output };
  }
  if (
    /\b0 passed\s*\|\s*0 failed/.test(stripAnsi(fullOutput))
  ) {
    return {
      status: "failed",
      identity: before,
      output:
        "required Deno selection executed no tests; a zero exit is insufficient",
    };
  }
  // A complete gate owns its permissions and selection. Only supplement an
  // empty or explicitly filtered run; a manifest task alone does not establish
  // that CI uses the same permissions.
  const deno: { command: string; cwd: string; executedTests: number }[] = [];
  let plans: Awaited<ReturnType<typeof requiredDenoTasks>>;
  try {
    plans = executedDenoTests(fullOutput) === 0 ||
        /\b[1-9]\d* filtered out\b/.test(stripAnsi(fullOutput))
      ? await requiredDenoTasks(cwd)
      : [];
  } catch (error) {
    return {
      status: "unavailable",
      identity: before,
      reason: `${UNAVAILABLE_MARKER} ${redactSecrets(String(error))}`,
    };
  }
  for (const plan of plans) {
    let checked: Awaited<ReturnType<typeof runRepositoryCommand>>;
    try {
      checked = await (deps.run ?? runRepositoryCommand)(
        "deno",
        plan.args,
        {
          cwd: plan.cwd,
          timeoutMs: CHECK_TIMEOUT_MS,
          manifests: await manifestsFor("deno", plan.cwd),
        },
      );
    } catch (error) {
      return {
        status: "unavailable",
        identity: before,
        reason: `${UNAVAILABLE_MARKER} ${redactSecrets(String(error))}`,
      };
    }
    if (!checked.ok || checked.value.timedOut) {
      return {
        status: "unavailable",
        identity: before,
        reason: `${UNAVAILABLE_MARKER} ${
          checked.ok ? "Deno tests timed out" : checked.error.message
        }`,
      };
    }
    const transcript = `${checked.value.stdout}\n${checked.value.stderr}`;
    if (checked.value.code !== 0) {
      const detail = redactedHeadTail(
        transcript,
        MAX_OUTPUT / 2,
        MAX_OUTPUT / 2,
      );
      return isUnavailableOutput(checked.value.stderr, transcript)
        ? {
          status: "unavailable",
          identity: before,
          reason: `${UNAVAILABLE_MARKER} ${detail}`,
        }
        : { status: "failed", identity: before, output: detail };
    }
    const executedTests = executedDenoTests(transcript);
    if (executedTests === 0) {
      return {
        status: "failed",
        identity: before,
        output:
          "required Deno selection executed no tests; a zero exit is insufficient",
      };
    }
    deno.push({
      command: ["deno", ...plan.args].join(" "),
      cwd: plan.cwd,
      executedTests,
    });
  }
  if (
    plans.length === 0 &&
    (await findProjectManifests(cwd)).some((project) =>
      project.kind === "deno"
    ) &&
    executedDenoTests(fullOutput) === 0
  ) {
    return {
      status: "failed",
      identity: before,
      output: "repository gate executed no Deno tests",
    };
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
      output:
        "checkout changed while repository checks were running; rerun validation",
    };
  }
  return {
    status: "passed",
    identity: before,
    command,
    ...(deno.length ? { deno } : {}),
  };
}

/** Count Deno's execution summaries, excluding ignored and filtered tests. */
function executedDenoTests(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    const match =
      /(?:ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed/.exec(
        stripAnsi(line),
      );
    if (match) count += Number(match[1]) + Number(match[2]);
  }
  return count;
}

/** Fallback selection for an empty or filtered repository gate.
 * Reuse the merge gate's project discovery and task priority, including nested
 * projects. Projects without a unit task or Deno test files have no test target.
 */
async function requiredDenoTasks(
  cwd: string,
): Promise<{ cwd: string; args: string[] }[]> {
  const plans: { cwd: string; args: string[] }[] = [];
  for (const project of await findProjectManifests(cwd)) {
    if (project.kind !== "deno") continue;
    const defined = await readManifestTasks(project.manifest);
    const task = UNIT_SUITE_TASKS.find((name) => defined.includes(name));
    if (task) plans.push({ cwd: project.dir, args: ["task", task] });
  }
  return plans;
}

/** Only execution diagnostics classify infrastructure, never arbitrary test names.
 * Substantive failures win when a command reports both kinds of failure.
 * Each expression is bounded to one line, with no repeated-prefix rescans.
 */
function isUnavailableOutput(stderr: string, output: string): boolean {
  let unavailable = false;
  let substantive = false;
  for (const raw of output.split("\n")) {
    const line = stripAnsi(raw).trim();
    const summaryFields = line.split(/ {2,}/);
    if (
      (summaryFields.length > 1 && summaryFields.at(-1) === "FAILED") ||
      (line.startsWith("✗") && line.includes(": FAILED"))
    ) substantive = true;
    if (
      /^(?:error: )?(?:AssertionError|TypeError|TS\d+(?: \[ERROR\]|:))/.test(
        line,
      ) ||
      /^(?:ok|FAILED) \| \d+ passed(?: \(\d+ steps?\))? \| [1-9]\d* failed/
        .test(line)
    ) substantive = true;
    if (
      line.startsWith("untrusted account cannot use ") ||
      line === "Result: FAILED (strict mode — skipped checks are not allowed)"
    ) unavailable = true;
  }
  const shellDiagnostics = output.split("\n").filter((line) =>
    /^(?:(?:[^ :]*\/)?(?:bash|sh):|\.\/[^ :]+:)/.test(stripAnsi(line).trim())
  ).join("\n");
  for (const raw of (stderr + "\n" + shellDiagnostics).split("\n")) {
    const line = stripAnsi(raw).trim();
    if (
      /^(?:error: |JSR package manifest |(?:[^ :]*\/)?(?:bash|sh):|\.\/[^ :]+:)/i
        .test(line) &&
      /(?:command not found|(?:exec: [^\n]+: )?not found|No such file or directory|not installed|no space left on device|disk quota exceeded|could not resolve|connection refused|failed to (?:download|fetch)|error sending request|failed to load|Import 'https?:)/i
        .test(line)
    ) {
      unavailable = true;
    } else if (/^error(?:\[|:)/i.test(line)) {
      substantive = true;
    }
  }
  return unavailable && !substantive;
}

/** Refuse publication when the successful result no longer describes the tree. */
export async function publicationValidationIsCurrent(
  result: PublicationValidationResult,
  cwd: string,
  identify = publicationTreeIdentity,
): Promise<boolean> {
  return result.status === "passed" &&
    (result.deno === undefined ||
      (result.deno.length > 0 &&
        result.deno.every((selection) => selection.executedTests > 0))) &&
    await identify(cwd, result.command) === result.identity;
}
