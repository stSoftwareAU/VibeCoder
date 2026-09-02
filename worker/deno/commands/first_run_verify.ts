/**
 * first-run-verify command (Issue #736).
 *
 * The decision half of the fresh first-run verification.
 * `infra/verify/first-run.sh` sequences the run — it starts `setup.sh` and
 * `run.sh`, waits on the container and the worker, and captures what each
 * stage printed. Every judgement it reports is made here, so the standard the
 * repository sets holds: shell orchestrates, Deno decides.
 *
 * Six modes, one per judgement the run makes:
 *
 *   --mode config-path --base-dir <dir>  which file is this host's config?
 *   --mode preflight …                   is the host fresh enough to verify?
 *   --mode config --config <path>        did setup write the Codex-only file?
 *   --mode image --inspect <f> --cli <f> is the built image the Codex one?
 *   --mode claim --worker-log <file>     did the worker finish one issue?
 *   --mode report --stages <tsv> …       what did the run prove?
 *
 * Every mode fails loud: a missing input, unreadable JSON or an absent file is
 * a non-zero exit naming the path, never a quietly empty result that would
 * read as a pass.
 *
 * Australian English spelling used throughout (behaviour, colour).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  analyseDiskChain,
  classifyOutput,
  evaluateClaim,
  evaluateCodexOnlyConfig,
  evaluateFreshState,
  evaluateImage,
  type Finding,
  type FreshStateFacts,
  type FreshStateVerdict,
  renderReport,
  type RunSummary,
  type StageRecord,
  verdictFor,
  WORKAROUND_ENV_VARS,
} from "../lib/first_run_verification.ts";
import { resolveHostConfigPath } from "../lib/host_config_path.ts";

/** Stages whose output is classified: what setup, the launcher and the image said. */
const CLASSIFIED_STAGES = ["setup", "config", "launch", "image", "claim"];

/** Read a file, or fail loud naming it. */
async function readOrThrow(path: string, what: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(
      `cannot read the ${what} at ${path}: ${(error as Error).message}`,
    );
  }
}

/**
 * Read a file that may legitimately not exist yet.
 *
 * Only `NotFound` is absence: a log a stage never wrote is a real state the
 * report describes. Every other error — a permission fault, an I/O error, a
 * directory where a file was named — is a fault that would otherwise
 * contribute zero findings and let the report say "no workaround was
 * required", so it is thrown naming the path.
 */
async function readIfPresent(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw new Error(
      `cannot read ${path}, so its evidence would be silently missing: ${
        (error as Error).message
      }`,
    );
  }
}

/** A registries.conf the host may simply not have. */
async function readOrNull(path: unknown): Promise<string | null> {
  if (typeof path !== "string" || path === "") return null;
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Whether a path exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a JSON input, or fail loud naming the path and the fault. */
async function readJson<T>(path: string, what: string): Promise<T> {
  const text = await readOrThrow(path, what);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `the ${what} at ${path} is not readable JSON: ${
        (error as Error).message
      }`,
    );
  }
}

function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`--${key} is required and must name a path`);
  }
  return value;
}

/** Which file this host's configuration is, by the repository's own rule. */
function configPath(args: Record<string, unknown>): CommandResult {
  const path = resolveHostConfigPath({
    baseDir: requireString(args, "base-dir"),
    env: (name) => Deno.env.get(name),
  });
  return { success: true, message: path, data: { path } };
}

/** A flag the shell passes as `true` or `false`. */
function requireBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${key} is required and must be true or false`);
}

/** Preflight: refuse a host that already carries a workaround. */
async function preflight(
  args: Record<string, unknown>,
): Promise<CommandResult> {
  const configFile = requireString(args, "config-file");
  const env: Record<string, string> = {};
  for (const { name } of WORKAROUND_ENV_VARS) {
    const value = Deno.env.get(name);
    if (value !== undefined) env[name] = value;
  }
  const facts: FreshStateFacts = {
    env,
    configFile,
    configFileExists: await exists(configFile),
    claudeOnPath: requireBoolean(args, "claude-on-path"),
    declaredProvider: typeof args["declared-provider"] === "string"
      ? args["declared-provider"] as string
      : undefined,
    localImages: (await readOrThrow(
      requireString(args, "images"),
      "local image list",
    )).split("\n").filter((line) => line.trim() !== ""),
    checkoutStatus: await readOrThrow(
      requireString(args, "checkout-status"),
      "checkout status",
    ),
    userRegistriesConf: await readOrNull(args["user-registries"]),
    systemRegistriesConf: await readOrNull(args["system-registries"]),
  };
  const verdict = evaluateFreshState(facts);
  const out = args["out"];
  if (typeof out === "string" && out !== "") {
    await Deno.writeTextFile(out, JSON.stringify(verdict, null, 2));
  }
  const lines = [
    ...verdict.violations.map((v) => `workaround present: ${v}`),
    ...verdict.notes.map((n) => `note: ${n}`),
  ];
  if (verdict.violations.length === 0) {
    lines.unshift("the host carries no workaround");
  }
  return {
    success: verdict.violations.length === 0,
    message: lines.join("\n"),
    data: verdict,
  };
}

/** Config: the file setup wrote selects Codex and nothing else. */
async function config(args: Record<string, unknown>): Promise<CommandResult> {
  const path = requireString(args, "config");
  const verdict = evaluateCodexOnlyConfig(
    await readOrThrow(path, "configuration"),
  );
  return {
    success: verdict.ok,
    message: [`configuration: ${path}`, ...verdict.findings].join("\n"),
    data: verdict,
  };
}

/** Claim: the worker took one issue and finished it. */
async function claim(args: Record<string, unknown>): Promise<CommandResult> {
  const path = requireString(args, "worker-log");
  const verdict = evaluateClaim(await readIfPresent(path));
  return {
    success: verdict.completed,
    message: `${path}: ${verdict.detail}`,
    data: verdict,
  };
}

/** Image: the build stamped codex and installed it, not Claude. */
async function image(args: Record<string, unknown>): Promise<CommandResult> {
  const verdict = evaluateImage(
    await readOrThrow(requireString(args, "inspect"), "image environment"),
    await readOrThrow(requireString(args, "cli"), "image CLI probe"),
  );
  return {
    success: verdict.ok,
    message: verdict.findings.join("\n"),
    data: verdict,
  };
}

/**
 * Report: classify every stage's output, read the disk and volume evidence,
 * and write the artefact that goes onto the issue.
 */
async function report(args: Record<string, unknown>): Promise<CommandResult> {
  const outPath = requireString(args, "out");
  const transcript = requireString(args, "transcript");
  const stagesPath = requireString(args, "stages");
  const stageInput = parseStages(
    await readOrThrow(stagesPath, "stage record"),
    stagesPath,
  );
  // A preflight that wrote no verdict is a host never confirmed fresh, which
  // is a refusal rather than a blank — decided here so the shell never has to
  // hand-write a verdict of its own.
  const freshStatePath = requireString(args, "fresh-state");
  const freshState: FreshStateVerdict = await exists(freshStatePath)
    ? await readJson<FreshStateVerdict>(freshStatePath, "fresh-state verdict")
    : {
      violations: [
        "the preflight wrote no verdict, so the host was never confirmed fresh",
      ],
      notes: [],
    };

  const findings: Finding[] = [];
  for (const stage of stageInput) {
    if (!CLASSIFIED_STAGES.includes(stage.name)) continue;
    findings.push(
      ...classifyOutput(await readIfPresent(`${transcript}/${stage.log}`)),
    );
  }

  // All three sources are needed: volume-init speaks on the launcher's stderr,
  // run.sh writes the trim refusal and every launch-time disk decision to
  // run_core.log (Issue #734), and the worker writes its claim-time refusal to
  // worker.log (Issue #732).
  const runCoreLog = typeof args["run-core-log"] === "string"
    ? args["run-core-log"] as string
    : undefined;
  const chain = analyseDiskChain(
    await readIfPresent(
      typeof args["launch-log"] === "string"
        ? args["launch-log"] as string
        : undefined,
    ),
    await readIfPresent(runCoreLog),
    await readIfPresent(
      typeof args["worker-log"] === "string"
        ? args["worker-log"] as string
        : undefined,
    ),
  );
  findings.push(...chain.findings);

  // FAIL only when the volume itself is implicated. A claim-time disk refusal
  // is a defect of its own and fails the verdict on its own; reporting it
  // against volume-init would send a reader to the wrong subsystem.
  const volumeStage: StageRecord = {
    name: "volume-init",
    status: chain.volumeImplicated
      ? "FAIL"
      : chain.volumeInitSeen
      ? "PASS"
      : "SKIPPED",
    detail: chain.volumeInitSeen
      ? "read from the launcher output and run_core.log"
      : "no volume-init output was produced, so nothing was confirmed",
    log: runCoreLog ? "run_core.log" : "(none)",
  };

  const stages: StageRecord[] = [];
  for (const stage of stageInput) {
    stages.push(stage);
    if (stage.name === "launch") stages.push(volumeStage);
  }
  if (!stages.some((stage) => stage.name === "volume-init")) {
    stages.push(volumeStage);
  }

  const summary: RunSummary = {
    host: typeof args["host"] === "string" ? args["host"] as string : "unknown",
    checkout: requireString(args, "checkout"),
    commit: typeof args["commit"] === "string"
      ? args["commit"] as string
      : "unknown",
    transcript,
    stages,
    freshState,
    findings: dedupe(findings),
  };
  const markdown = renderReport(summary);
  await Deno.writeTextFile(outPath, markdown);
  return {
    success: verdictFor(summary) === "PASS",
    message: markdown,
    data: { verdict: verdictFor(summary) },
  };
}

/**
 * Parse the stage record the shell writes: one tab-separated
 * `name<TAB>status<TAB>detail<TAB>log` per stage, in the order they ran.
 *
 * A malformed line is a loud failure naming the file and the line: a stage
 * silently dropped from the report is a stage nobody knows went unrun.
 */
export function parseStages(text: string, path: string): StageRecord[] {
  const stages: StageRecord[] = [];
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  for (const [index, line] of lines.entries()) {
    const parts = line.split("\t");
    if (parts.length !== 4) {
      throw new Error(
        `${path} line ${index + 1} is not name/status/detail/log: ${line}`,
      );
    }
    const [name, status, detail, log] = parts as [
      string,
      string,
      string,
      string,
    ];
    if (status !== "PASS" && status !== "FAIL" && status !== "SKIPPED") {
      throw new Error(
        `${path} line ${index + 1} has status "${status}", which is not ` +
          `PASS, FAIL or SKIPPED`,
      );
    }
    stages.push({ name, status, detail, log });
  }
  if (stages.length === 0) {
    throw new Error(`${path} records no stages, so nothing was verified`);
  }
  return stages;
}

/** One entry per distinct summary: the same fault seen twice is one finding. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.summary)) return false;
    seen.add(finding.summary);
    return true;
  });
}

export const firstRunVerifyCommand: Command = {
  name: "first-run-verify",
  description:
    "Judge one stage of the fresh first-run verification (Issue #736)",
  async execute(args: Record<string, unknown>): Promise<CommandResult> {
    const mode = args["mode"];
    try {
      switch (mode) {
        case "config-path":
          return configPath(args);
        case "preflight":
          return await preflight(args);
        case "config":
          return await config(args);
        case "image":
          return await image(args);
        case "claim":
          return await claim(args);
        case "report":
          return await report(args);
        default:
          return {
            success: false,
            message:
              `--mode must be one of config-path, preflight, config, image, ` +
              `claim, report (got ${JSON.stringify(mode)})`,
          };
      }
    } catch (error) {
      // Fail loud: the caller sees the path and the fault, never an empty
      // result that would read as a clean stage.
      return { success: false, message: (error as Error).message };
    }
  },
};
