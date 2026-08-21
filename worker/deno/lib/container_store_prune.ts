/**
 * Reclaim the host-side container store (Issue #227).
 *
 * ## What went wrong
 *
 * Host GRQ-23 crashed out of disk on 2026-08-21. Of its 74 GB container
 * store, ~20 GB was reclaimable and nothing in the launcher reclaimed it:
 *
 * - the `buildkit` builder container the launcher *stops* after a build
 *   (#4331) keeps its 13 GB rootfs on disk for ever;
 * - the snapshot layers of untagged intermediate images survive the tag
 *   prune (#4162) — 5.8 GB of "dangling" layers;
 * - `vibe-test-work-*` / `vibe-test-approval-*` volumes from killed test
 *   runs (their `finally` never ran) sit there indefinitely.
 *
 * ## The rules
 *
 * 1. **Throwaway volumes** are recognised by name only — the `vibe-test-`
 *    prefix the container tests use — and every other volume, including
 *    the production `vibe-work` / `vibe-approval-state`, is never an
 *    argument to a removal. A generic `volume prune` would delete the
 *    production volumes: this runs *before* the worker container exists,
 *    when nothing references them.
 * 2. **Dangling images** are whatever the runtime's own `image prune`
 *    calls dangling — never `--all`, which would drop the pinned base
 *    images every rebuild pulls.
 * 3. **The builder** is deleted only when the store's filesystem is short
 *    of room (below {@link DEFAULT_BUILDER_FLOOR_PERCENT} free), because
 *    its cache is what keeps a definition-change rebuild cheap; a host with
 *    plenty of disk keeps it. A runtime without a builder container skips
 *    the step.
 * 4. **Best-effort and loud.** Each step reports what it reclaimed or why
 *    it could not; a failed step never stops the others, and the launchers
 *    treat a non-zero exit as a warning (reclaiming disk must never block
 *    a launch).
 *
 * Every runtime and filesystem call is a seam on {@link StorePruneDeps};
 * {@link createStorePruneDeps} supplies the production implementation.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
import { PRUNE_RUNTIME_TIMEOUT_MS } from "./container_image_prune.ts";

/** Volume-name prefix the container tests use for their per-run volumes. */
export const THROWAWAY_VOLUME_PREFIX = "vibe-test-";

/** Volume names the runtimes accept — and no argument parser can misread. */
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Below this much free space on the store's filesystem the builder goes. */
export const DEFAULT_BUILDER_FLOOR_PERCENT = 20;

/** One runtime invocation's outcome. */
export interface RuntimeInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

/** Free-space reading for the filesystem holding the store. */
export interface FreeSpace {
  /** Free bytes available to this user. */
  availableBytes: number;
  /** Filesystem size in bytes. */
  totalBytes: number;
}

/** The operations a store prune performs — every one a seam for the tests. */
export interface StorePruneDeps {
  /** Run the runtime with the given arguments, bounded and captured. */
  runRuntime: (args: readonly string[]) => Promise<RuntimeInvocation>;
  /** Measure free space on the filesystem holding `path`, or null. */
  freeSpace: (path: string) => Promise<FreeSpace | null>;
  /** Operator-facing log sink (stderr in production). */
  log: (message: string) => void;
}

/** The runtime dialect pieces the prune needs. */
export interface StorePruneDialect {
  imagePruneArgs: readonly string[];
  volumeListArgs: readonly string[];
  volumeRemoveArgs: readonly string[];
  builderDeleteArgs: readonly string[];
}

/** One prune request. */
export interface StorePruneOptions {
  dialect: StorePruneDialect;
  /** Path on the filesystem holding the store, for the free-space gate. */
  storePath?: string;
  /** Free-space floor (percent) below which the builder is deleted. */
  builderFloorPercent?: number;
}

/** What one step achieved. */
export interface StepOutcome {
  step: "volumes" | "images" | "builder";
  ok: boolean;
  /** Named things removed (volume names; "builder"). */
  removed: string[];
  /** Why the step is not ok, or what it decided. */
  detail: string;
}

/** What the whole prune achieved. */
export interface StorePruneOutcome {
  steps: StepOutcome[];
  /** True when every step succeeded (a skipped step counts as ok). */
  ok: boolean;
}

/** Keep a runtime's diagnostic output to one short, single-line reason. */
function firstLine(text: string, limit = 200): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) =>
    part !== ""
  );
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** Keys the supported runtimes spell a volume name with. */
const NAME_KEYS = ["Name", "name", "id", "Id", "ID"];

function nameFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  // Apple container nests the name at `configuration.name`.
  const configuration = object["configuration"];
  if (typeof configuration === "object" && configuration !== null) {
    const nested = (configuration as Record<string, unknown>)["name"];
    if (typeof nested === "string" && nested.trim() !== "") {
      return nested.trim();
    }
  }
  for (const key of NAME_KEYS) {
    const found = object[key];
    if (typeof found === "string" && found.trim() !== "") return found.trim();
  }
  return undefined;
}

/**
 * Parse a runtime's volume listing into names.
 *
 * Accepts a JSON array (Apple container, Podman), one JSON object per line
 * (Docker `--format json`), or one plain name per line (Docker
 * `--format {{.Name}}`).
 */
export function parseVolumeListing(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.map(nameFrom).filter((n): n is string => n !== undefined);
  } catch {
    // Not one JSON document — per-line shapes below.
  }
  const names: string[] = [];
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (value === "") continue;
    if (value.startsWith("{")) {
      try {
        const name = nameFrom(JSON.parse(value));
        if (name) names.push(name);
      } catch {
        // A truncated line names nothing; skip it.
      }
      continue;
    }
    names.push(value.split(/\s+/)[0]!);
  }
  return names;
}

/**
 * Pick the throwaway volumes out of a listing.
 *
 * Only names carrying the test prefix, and only names the runtime would
 * accept back as an argument. Everything else — the production volumes
 * above all — is left alone.
 */
export function selectThrowawayVolumes(names: readonly string[]): string[] {
  return names.filter((name) =>
    name.startsWith(THROWAWAY_VOLUME_PREFIX) && VOLUME_NAME_RE.test(name)
  );
}

/**
 * Parse POSIX `df -kP` output into a free-space reading.
 *
 * @param text - `df -kP <path>` output (header line plus one data line)
 */
export function parseDfOutput(text: string): FreeSpace | null {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter((l) =>
    l !== ""
  );
  if (lines.length < 2) return null;
  // The data line may wrap when the device name is long; take the last line
  // and read the numeric columns from it.
  const fields = lines[lines.length - 1]!.split(/\s+/);
  const numbers = fields.map((f) => Number(f)).filter((n) =>
    Number.isFinite(n)
  );
  // 1024-blocks, used, available — in that order.
  if (numbers.length < 3) return null;
  const total = numbers[0]! * 1024;
  const available = numbers[2]! * 1024;
  if (total <= 0 || available < 0) return null;
  return { availableBytes: available, totalBytes: total };
}

function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

/**
 * Decide whether the builder should go, given the free-space reading.
 *
 * @returns `null` to keep it, or the reason to delete it
 */
export function builderDeleteReason(
  free: FreeSpace | null,
  floorPercent: number,
): string | null {
  if (free === null) return null;
  const percent = (free.availableBytes / free.totalBytes) * 100;
  if (percent >= floorPercent) return null;
  return `${gb(free.availableBytes)} free (${percent.toFixed(1)}%) is below ` +
    `the ${floorPercent}% floor`;
}

/**
 * Reclaim the store: throwaway volumes, dangling images, and — when the
 * host is short of room — the stopped builder.
 */
export async function pruneContainerStore(
  deps: StorePruneDeps,
  options: StorePruneOptions,
): Promise<StorePruneOutcome> {
  const steps: StepOutcome[] = [];
  const tag = "[container-store-prune]";

  // 1. Throwaway volumes.
  {
    const listing = await deps.runRuntime(options.dialect.volumeListArgs);
    if (listing.code !== 0) {
      const detail = `${
        options.dialect.volumeListArgs.join(" ")
      } exited ${listing.code}: ${
        firstLine(listing.stderr) || firstLine(listing.stdout) || "no output"
      }`;
      deps.log(`${tag} could not list volumes — ${detail}`);
      steps.push({ step: "volumes", ok: false, removed: [], detail });
    } else {
      const candidates = selectThrowawayVolumes(
        parseVolumeListing(listing.stdout),
      );
      const removed: string[] = [];
      const failed: string[] = [];
      for (const name of candidates) {
        const result = await deps.runRuntime([
          ...options.dialect.volumeRemoveArgs,
          name,
        ]);
        if (result.code === 0) {
          removed.push(name);
          deps.log(`${tag} removed throwaway volume ${name}`);
        } else {
          failed.push(name);
          deps.log(
            `${tag} could not remove volume ${name} (exit ${result.code}): ${
              firstLine(result.stderr) || firstLine(result.stdout) ||
              "no output"
            }`,
          );
        }
      }
      steps.push({
        step: "volumes",
        ok: failed.length === 0,
        removed,
        detail: failed.length > 0
          ? `could not remove ${failed.join(", ")}`
          : candidates.length === 0
          ? "no throwaway volumes"
          : `removed ${removed.length} throwaway volume(s)`,
      });
    }
  }

  // 2. Dangling images.
  {
    const result = await deps.runRuntime(options.dialect.imagePruneArgs);
    if (result.code !== 0) {
      const detail = `${
        options.dialect.imagePruneArgs.join(" ")
      } exited ${result.code}: ${
        firstLine(result.stderr) || firstLine(result.stdout) || "no output"
      }`;
      deps.log(`${tag} could not prune dangling images — ${detail}`);
      steps.push({ step: "images", ok: false, removed: [], detail });
    } else {
      const detail = firstLine(result.stdout) || "dangling images pruned";
      deps.log(`${tag} ${detail}`);
      steps.push({ step: "images", ok: true, removed: [], detail });
    }
  }

  // 3. The builder, when the host is short of room.
  if (options.dialect.builderDeleteArgs.length === 0) {
    steps.push({
      step: "builder",
      ok: true,
      removed: [],
      detail: "runtime keeps no builder container",
    });
  } else {
    const free = options.storePath
      ? await deps.freeSpace(options.storePath)
      : null;
    const reason = builderDeleteReason(
      free,
      options.builderFloorPercent ?? DEFAULT_BUILDER_FLOOR_PERCENT,
    );
    if (reason === null) {
      const detail = free === null
        ? "free space unknown — builder kept"
        : `${gb(free.availableBytes)} free (${
          ((free.availableBytes / free.totalBytes) * 100).toFixed(1)
        }%) — builder kept`;
      deps.log(`${tag} ${detail}`);
      steps.push({ step: "builder", ok: true, removed: [], detail });
    } else {
      const result = await deps.runRuntime(options.dialect.builderDeleteArgs);
      if (result.code === 0) {
        deps.log(`${tag} deleted the builder: ${reason}`);
        steps.push({
          step: "builder",
          ok: true,
          removed: ["builder"],
          detail: `deleted: ${reason}`,
        });
      } else {
        const out = firstLine(result.stderr) || firstLine(result.stdout) ||
          "no output";
        // A builder that does not exist is the state we wanted.
        if (/not found|no such|does not exist/i.test(out)) {
          deps.log(`${tag} no builder to delete (${reason})`);
          steps.push({
            step: "builder",
            ok: true,
            removed: [],
            detail: "no builder present",
          });
        } else {
          const detail = `${
            options.dialect.builderDeleteArgs.join(" ")
          } exited ${result.code}: ${out}`;
          deps.log(`${tag} could not delete the builder — ${detail}`);
          steps.push({ step: "builder", ok: false, removed: [], detail });
        }
      }
    }
  }

  return { steps, ok: steps.every((s) => s.ok) };
}

/**
 * The production seam: real subprocesses, bounded, output captured.
 */
export function createStorePruneDeps(
  runtime: string,
  timeoutMs: number = PRUNE_RUNTIME_TIMEOUT_MS,
): StorePruneDeps {
  const run = async (
    command: string,
    args: readonly string[],
  ): Promise<RuntimeInvocation> => {
    const result = await runWithTimeout(command, [...args], { timeoutMs });
    if (!result.ok) {
      return {
        code: -1,
        stdout: "",
        stderr: `${command} could not be run: ${result.error.message}`,
      };
    }
    if (result.value.timedOut) {
      return {
        code: -1,
        stdout: result.value.stdout,
        stderr: `${command} ${args.join(" ")} did not answer within ${
          timeoutMs / 1000
        }s`,
      };
    }
    return {
      code: result.value.code,
      stdout: result.value.stdout,
      stderr: result.value.stderr,
    };
  };
  return {
    log: (message) => console.error(message),
    runRuntime: (args) => run(runtime, args),
    freeSpace: async (path) => {
      const result = await run("df", ["-kP", path]);
      if (result.code !== 0) return null;
      return parseDfOutput(result.stdout);
    },
  };
}
