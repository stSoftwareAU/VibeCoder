/**
 * Self-heal a container build whose builder ran out of storage (VibeCoder #1, formerly Issue #4441).
 *
 * ## What went wrong
 *
 * On host-23 the host disk fell to 135 MiB free and `container build` died
 * mid-export:
 *
 * ```text
 * exporting to oci image format: Error: resourceExhausted: "failed to solve:
 *   … write /var/lib/container-builder-shim/exports/…/out.tar: no space left
 *   on device"
 * ```
 *
 * Freeing host space did not fix it. Apple container's BuildKit builder VM had
 * remounted its own filesystem read-only after the ENOSPC and stayed that way,
 * so every later launch failed with `open /tmp/1326465203: read-only file
 * system` before it built anything. `loop.sh` backed off 120 s → 240 s → … →
 * 960 s and would have retried for ever; a human ran
 * `container builder stop && container builder start` and the fleet host came
 * back immediately.
 *
 * ## The rule
 *
 * A failed build is classified from its own output. Only the builder-storage
 * signatures below are healed — the builder is restarted and the build retried
 * exactly once. Every other failure (a broken `RUN` step, a missing package, a
 * syntax error) fails exactly as it did before: a launcher that "healed" a
 * genuine build error would loop on it.
 *
 * Escalation is per launch, not per host: the first failure restarts the
 * builder, a second failure in the same launch recreates it (`builder delete`
 * + `builder start`), which is the stronger remedy for a builder whose backing
 * volume is itself damaged. The launcher never loops — it retries the build
 * once and no more.
 *
 * Driving a container runtime is exactly what a test must not really do, so
 * every invocation is a seam on {@link BuildHealDeps};
 * {@link createBuildHealDeps} supplies the production implementation, bounded
 * by a timeout because a wedged runtime CLI never returns.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
// The shape of one runtime invocation is the same here as it is for the image
// prune (Issue #4162); it is defined once, there, rather than twice.
export type { RuntimeInvocation } from "./container_image_prune.ts";
import type { RuntimeInvocation } from "./container_image_prune.ts";

/** Bound on one runtime invocation — a wedged CLI never returns. */
export const HEAL_RUNTIME_TIMEOUT_MS = 300_000;

/**
 * How much of a build log is classified.
 *
 * A real build log runs to megabytes of layer progress and the failure is
 * always at the end, so only the tail is read into memory.
 */
export const MAX_BUILD_LOG_TAIL_BYTES = 256 * 1024;

/**
 * Diagnostics that mean the *builder's own storage* failed, rather than the
 * build's instructions.
 *
 * Deliberately narrow, and matched against the runtime's diagnostic wording:
 * these are the three shapes host-23 produced (ENOSPC during export, the
 * read-only remount that followed it, and BuildKit's gRPC status for both).
 * Broadening this list is how a genuine build error would start being retried
 * for ever.
 */
export const BUILDER_STORAGE_SIGNATURES: readonly string[] = [
  "no space left on device",
  "read-only file system",
  "read only file system",
  "enospc",
  "resourceexhausted",
  "resource exhausted",
];

/** What a failed build turned out to be. */
export type BuildFailureClass = "builder-storage" | "other";

/** The classifier's verdict on one failed build. */
export interface BuildFailureClassification {
  /** Whether this is a failure the builder heal addresses. */
  class: BuildFailureClass;
  /** The signature that matched, for the host log. */
  signature?: string;
}

/**
 * Reduce build output to a single lower-case line so a diagnostic the runtime
 * wrapped across lines still matches its signature.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Classify a failed build from its own output.
 *
 * @param text - The build's combined output (its tail is enough)
 * @returns Whether the builder's storage failed, and which signature said so
 */
export function classifyBuildFailure(
  text: string,
): BuildFailureClassification {
  const haystack = normalise(text);
  for (const signature of BUILDER_STORAGE_SIGNATURES) {
    if (haystack.includes(signature)) {
      return { class: "builder-storage", signature };
    }
  }
  return { class: "other" };
}

/** Which remedy an attempt gets. */
export type BuilderHealAction = "restart" | "recreate";

/**
 * The remedy for the nth builder-storage failure of one launch.
 *
 * @param attempt - 1 for the first failure of this launch, 2 for the second
 * @returns `restart` first, `recreate` from the second failure onwards
 */
export function healActionForAttempt(attempt: number): BuilderHealAction {
  return Number.isFinite(attempt) && attempt >= 2 ? "recreate" : "restart";
}

/** The operations a heal performs — every one a seam for the tests. */
export interface BuildHealDeps {
  /** Run the runtime with the given arguments, bounded and captured. */
  runRuntime: (args: readonly string[]) => Promise<RuntimeInvocation>;
  /** Operator-facing log sink (stderr in production). */
  log: (message: string) => void;
}

/** One heal request. */
export interface BuildHealOptions {
  /** The failed build's output — the tail of its log is enough. */
  buildLog: string;
  /** 1 for this launch's first builder-storage failure, 2 for the second. */
  attempt: number;
  /** Sub-commands that restart the builder, in order. */
  restartArgs: readonly (readonly string[])[];
  /** Sub-commands that recreate the builder from scratch, in order. */
  recreateArgs: readonly (readonly string[])[];
}

/** One sub-command the heal ran. */
export interface BuilderHealStep {
  args: string[];
  /** Runtime exit status, or -1 when the runtime could not be run at all. */
  code: number;
  /** Short reason, taken from the runtime's own output. */
  detail: string;
}

/** What one heal achieved. */
export interface BuildHealOutcome {
  /** True when the failure carried a builder-storage signature. */
  healable: boolean;
  /** The signature that matched, when one did. */
  signature?: string;
  /** Which remedy was performed, when one was. */
  action?: BuilderHealAction;
  /** The sub-commands run, in order. */
  steps: BuilderHealStep[];
  /** True only when the builder is usable again and the build may be retried. */
  ok: boolean;
  /** Why the heal is not `ok` — named for the host log. */
  detail?: string;
}

/** Keep a runtime's diagnostic output to one short, single-line reason. */
function firstLine(text: string, limit = 200): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) =>
    part !== ""
  );
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * Restart (or recreate) the runtime's builder after a storage failure.
 *
 * Intermediate teardown steps are best-effort — `builder stop` exits non-zero
 * when nothing is running, and `builder delete` when there is nothing to
 * delete — but the **final** step must succeed, because that is the one that
 * leaves a builder the retry can use. A heal that cannot leave a working
 * builder reports `ok: false` rather than inviting a retry that will fail the
 * same way (Issue #3234).
 *
 * @param deps - Injected runtime and log seams
 * @param options - The failed build's output, the attempt, and the runtime's
 *   own argv dialect
 * @returns What was done, and why the heal is not clean when it is not
 */
export async function healBuilderStorage(
  deps: BuildHealDeps,
  options: BuildHealOptions,
): Promise<BuildHealOutcome> {
  const classification = classifyBuildFailure(options.buildLog);
  if (classification.class !== "builder-storage") {
    const detail = "the build did not fail on builder storage — leaving it " +
      "to fail as it always has";
    deps.log(`[container-build-heal] ${detail}`);
    return { healable: false, steps: [], ok: false, detail };
  }

  const action = healActionForAttempt(options.attempt);
  const sequence = action === "recreate"
    ? options.recreateArgs
    : options.restartArgs;

  if (sequence.length === 0) {
    const detail = "this runtime has no builder to restart, so a " +
      `${classification.signature} failure cannot be healed here`;
    deps.log(`[container-build-heal] ${detail}`);
    return {
      healable: true,
      ...(classification.signature
        ? { signature: classification.signature }
        : {}),
      steps: [],
      ok: false,
      detail,
    };
  }

  deps.log(
    `[container-build-heal] the build failed on builder storage ` +
      `(${classification.signature}) — performing a builder ${action}`,
  );

  const steps: BuilderHealStep[] = [];
  for (const args of sequence) {
    const result = await deps.runRuntime(args);
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || "";
    steps.push({ args: [...args], code: result.code, detail });
    if (result.code !== 0) {
      deps.log(
        `[container-build-heal] ${args.join(" ")} exited ${result.code}` +
          (detail ? `: ${detail}` : ""),
      );
    }
  }

  const last = steps[steps.length - 1]!;
  if (last.code !== 0) {
    const detail = `${last.args.join(" ")} exited ${last.code}` +
      (last.detail ? `: ${last.detail}` : "");
    return {
      healable: true,
      ...(classification.signature
        ? { signature: classification.signature }
        : {}),
      action,
      steps,
      ok: false,
      detail,
    };
  }

  deps.log(
    `[container-build-heal] builder ${action} complete — retrying the build`,
  );
  return {
    healable: true,
    ...(classification.signature
      ? { signature: classification.signature }
      : {}),
    action,
    steps,
    ok: true,
  };
}

/**
 * Read the tail of a build log.
 *
 * @param path - Host path the launcher captured the build's output to
 * @param maxBytes - How much of the end to read
 * @returns The tail, decoded as UTF-8
 * @throws When the log cannot be read — an unreadable log must not classify as
 *   "not a builder failure" (Issue #3234)
 */
export async function readBuildLogTail(
  path: string,
  maxBytes: number = MAX_BUILD_LOG_TAIL_BYTES,
): Promise<string> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    throw new Error(
      `cannot read the build log ${path}: ${(error as Error).message}`,
    );
  }
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - maxBytes);
    if (start > 0) await file.seek(start, Deno.SeekMode.Start);
    const bytes = new Uint8Array(Math.min(size, maxBytes));
    let read = 0;
    while (read < bytes.length) {
      const n = await file.read(bytes.subarray(read));
      if (n === null) break;
      read += n;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, read),
    );
  } finally {
    file.close();
  }
}

/**
 * The production seam: real subprocesses, bounded, output captured.
 *
 * @param runtime - Runtime executable the launcher chose
 * @param timeoutMs - Bound on one runtime invocation
 * @returns Dependencies for {@link healBuilderStorage}
 */
export function createBuildHealDeps(
  runtime: string,
  timeoutMs: number = HEAL_RUNTIME_TIMEOUT_MS,
): BuildHealDeps {
  return {
    log: (message) => console.error(message),
    runRuntime: async (args) => {
      const result = await runWithTimeout(runtime, [...args], { timeoutMs });
      if (!result.ok) {
        // A missing executable is a failed invocation, never an empty success.
        return {
          code: -1,
          stdout: "",
          stderr: `${runtime} could not be run: ${result.error.message}`,
        };
      }
      if (result.value.timedOut) {
        return {
          code: -1,
          stdout: result.value.stdout,
          stderr: `${runtime} ${args.join(" ")} did not answer within ${
            timeoutMs / 1000
          }s`,
        };
      }
      return {
        code: result.value.code,
        stdout: result.value.stdout,
        stderr: result.value.stderr,
      };
    },
  };
}
