/**
 * Quality gate check: run the CI-pinned Checkov CloudFormation scan locally
 * (Issue #3972).
 *
 * `.github/workflows/checkov.yml` is a **blocking** PR check, and nothing ran
 * it before the push — so a misconfigured template was met as a red PR. This
 * stage runs the same scan, with the same arguments (`CHECKOV_SCAN_ARGS`) and
 * the same verdict judge (`judgeCheckovRun`), so a local pass predicts a CI
 * pass. The stage is registered only where `checkov.yml` exists
 * (`quality_gate.ts`), because it mirrors that job.
 *
 * Pipeline:
 *   1. Detect a route, in order: a `checkov` on PATH whose version is exactly
 *      the CI pin (`CHECKOV_IMAGE_TAG`); else a container runtime (docker, then
 *      podman) that **already holds** `CHECKOV_IMAGE`. An unpinned PATH binary
 *      is never run, and it does not block the container route. No route →
 *      SKIPPED, naming each route that was unusable.
 *   2. Run the scan, bounded by {@link CHECKOV_DEADLINE_MS}. Over the deadline
 *      → FAILED. A scan that cannot be judged is never read as a pass.
 *   3. Judge the exit code and stdout with `judgeCheckovRun` → PASSED or FAILED,
 *      with the judge's report rendered under the status line. A FAILED run
 *      whose stdout is not JSON also shows the tail of stderr.
 *
 * The stage adds no suppression, edits no workflow and makes no network call:
 * `--skip-download` is in `CHECKOV_SCAN_ARGS`, and the stage never runs
 * `pull`, so a missing image is a SKIPPED, not a download. Strict mode is not
 * handled here: `formatSummary(results, strict)` in `quality_helpers.ts`
 * already fails a strict run on any SKIPPED stage.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { CHECKOV_IMAGE, CHECKOV_IMAGE_TAG } from "./pinned_actions.ts";
import {
  CHECKOV_SCAN_ARGS,
  type CheckovTemplateReader,
  judgeCheckovRun,
} from "./checkov_report.ts";
import {
  probe as defaultProbe,
  type SemgrepRunResult,
  spawnWithDeadline as defaultSpawn,
} from "./semgrep_check.ts";

/**
 * Wall-clock ceiling for one local scan. Matches `SEMGREP_DEADLINE_MS`. The
 * CI job's `timeout-minutes: 15` bounds the whole job, including checkout and
 * Deno setup, so the scan itself gets a shorter ceiling. Unlike semgrep, a
 * deadline hit is FAILED here: the scan did not finish, so it cannot be read
 * as clean.
 */
export const CHECKOV_DEADLINE_MS = 300_000;

/** Lines of stderr shown after a FAILED run whose stdout is not JSON. */
const STDERR_TAIL_LINES = 10;

/** Raw subprocess result from one Checkov invocation. */
export type CheckovRunResult = SemgrepRunResult;

/** A resolved way to run the scan. */
export interface CheckovInvocation {
  /** How the scan will run, for the check output. */
  description: string;
  run: () => Promise<CheckovRunResult>;
}

/** The route chosen, or null with one reason per unusable route. */
export interface CheckovDetection {
  invocation: CheckovInvocation | null;
  /** Why each route was unusable, in the order they were tried. */
  missing: string[];
}

/** Runs `<binary> <args>` and returns trimmed stdout, or null if it cannot run. */
export type ProbeFn = (
  binary: string,
  args: string[],
) => Promise<string | null>;

/** Runs a command with the deadline applied, as `spawnWithDeadline` does. */
export type SpawnFn = (
  binary: string,
  args: string[],
  cwd: string,
  deadlineMs: number,
) => Promise<CheckovRunResult>;

/** Result of the checkov quality-gate stage. */
export interface CheckovCheckResult {
  status: "PASSED" | "FAILED" | "SKIPPED";
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** Reason for SKIPPED, when applicable. */
  skipReason?: string;
}

/** Options for {@link runCheckovCheck} (injection points for the tests). */
export interface CheckovCheckOptions {
  /** Inject a probe. Defaults to running the real binaries. */
  probe?: ProbeFn;
  /** Inject a spawner. Defaults to the deadline-bound spawn. */
  spawn?: SpawnFn;
  /** Inject a template reader. Defaults to reading under `scriptDir`. */
  templates?: CheckovTemplateReader;
}

/**
 * Arguments for running the CI-pinned Checkov image under a container runtime.
 * This mirrors the `docker run` line in `checkov.yml`: the repository is
 * mounted read-only, and `--entrypoint checkov` is needed because the image's
 * own entrypoint ignores argv under `GITHUB_ACTIONS=true`.
 */
export function buildCheckovContainerArgs(scriptDir: string): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${scriptDir}:/src:ro`,
    "-w",
    "/src",
    "--entrypoint",
    "checkov",
    CHECKOV_IMAGE,
    ...CHECKOV_SCAN_ARGS,
  ];
}

/**
 * Detect how Checkov can be run locally.
 *
 * Order:
 *   1. A `checkov` on PATH reporting exactly `CHECKOV_IMAGE_TAG`. Any other
 *      version is recorded in `missing` and never run; detection falls through.
 *   2. A container runtime (docker, then podman) that already holds
 *      `CHECKOV_IMAGE`. `image inspect` succeeds only for an image in the local
 *      store, so nothing is downloaded. `pull` is never called.
 */
export async function detectCheckovInvocation(
  scriptDir: string,
  probe: ProbeFn = defaultProbe,
  spawn: SpawnFn = defaultSpawn,
): Promise<CheckovDetection> {
  const missing: string[] = [];

  const version = await probe("checkov", ["--version"]);
  if (version === null) {
    missing.push("no checkov on PATH");
  } else {
    const reported = version.trim();
    if (reported === CHECKOV_IMAGE_TAG) {
      return {
        invocation: {
          description: `checkov ${reported} on PATH (the CI pin)`,
          run: () =>
            spawn(
              "checkov",
              [...CHECKOV_SCAN_ARGS],
              scriptDir,
              CHECKOV_DEADLINE_MS,
            ),
        },
        missing,
      };
    }
    missing.push(
      `checkov on PATH reports ${
        reported || "an unknown version"
      }, not the CI pin ${CHECKOV_IMAGE_TAG}`,
    );
  }

  for (const runtime of ["docker", "podman"]) {
    if (await probe(runtime, ["--version"]) === null) continue;
    if (await probe(runtime, ["image", "inspect", CHECKOV_IMAGE]) === null) {
      continue;
    }
    return {
      invocation: {
        description: `${runtime} run ${CHECKOV_IMAGE} (the image CI runs)`,
        run: () =>
          spawn(
            runtime,
            buildCheckovContainerArgs(scriptDir),
            scriptDir,
            CHECKOV_DEADLINE_MS,
          ),
      },
      missing,
    };
  }

  missing.push(`no docker or podman holding ${CHECKOV_IMAGE}`);
  return { invocation: null, missing };
}

/**
 * Reads a template under `scriptDir`. The judge has already stripped any
 * leading `/` and `./` from the path, so the path is joined as given. Returns
 * null when the file does not exist; any other read error is rethrown, so the
 * judge (or the caller) sees a real fault rather than a silent null.
 */
export function checkovTemplateReader(
  scriptDir: string,
): CheckovTemplateReader {
  return async (path: string): Promise<string | null> => {
    try {
      return await Deno.readTextFile(`${scriptDir}/${path}`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  };
}

/** Build the SKIPPED result, naming each route that was unusable. */
function skipped(missing: string[]): CheckovCheckResult {
  const reason = missing.join("; ");
  return {
    status: "SKIPPED",
    output: `checkov: SKIPPED (not run — ${reason}. Install checkov ` +
      `${CHECKOV_IMAGE_TAG} (e.g. \`pipx install checkov==${CHECKOV_IMAGE_TAG}\`) ` +
      `or pull ${CHECKOV_IMAGE} into docker/podman so the scan runs before the ` +
      "push; the CI checkov job stays authoritative)",
    skipReason: reason,
  };
}

/** Whether `text` parses as JSON. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The last `count` lines of `text`, trimmed, or "" when it is blank. */
function tailOf(text: string, count: number): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed.split("\n").slice(-count).join("\n");
}

/**
 * Run the checkov quality-gate stage over `scriptDir`.
 *
 * Pipeline:
 *   1. Detect a route. None → SKIPPED, naming each unusable route.
 *   2. Run the scan. Over {@link CHECKOV_DEADLINE_MS} → FAILED.
 *   3. Judge with `judgeCheckovRun` → PASSED or FAILED, with the report.
 */
export async function runCheckovCheck(
  scriptDir: string,
  options: CheckovCheckOptions = {},
): Promise<CheckovCheckResult> {
  const detection = await detectCheckovInvocation(
    scriptDir,
    options.probe,
    options.spawn,
  );
  if (detection.invocation === null) {
    return skipped(detection.missing);
  }
  const { description } = detection.invocation;
  const run = await detection.invocation.run();

  if (run.timedOut) {
    return {
      status: "FAILED",
      output: `checkov: FAILED (scan exceeded ${
        CHECKOV_DEADLINE_MS / 1000
      }s deadline via ${description})`,
    };
  }

  const verdict = await judgeCheckovRun({
    exitCode: run.exitCode,
    stdout: run.stdout,
    templates: options.templates ?? checkovTemplateReader(scriptDir),
  });

  const lines = [
    `checkov: ${verdict.status} (via ${description})`,
    verdict.report,
  ];
  if (verdict.status === "FAILED" && !isJson(run.stdout)) {
    const tail = tailOf(run.stderr, STDERR_TAIL_LINES);
    if (tail !== "") lines.push("", "checkov stderr (last lines):", tail);
  }
  return { status: verdict.status, output: lines.join("\n") };
}
