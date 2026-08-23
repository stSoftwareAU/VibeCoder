/**
 * Standing work-volume totals by category (Issue #244).
 *
 * ## Why
 *
 * Every disk problem on GRQ-23 was invisible until the host hit 95 %. The
 * only per-launch signal was the launcher's `container-store:` line, and
 * the worker log inside the container said nothing about what the work
 * volume actually held: the prune (Issue #228) logs what it *removed*, the
 * tier reclaim (Issue #242) logs the two-tier split only when it runs, and
 * the host-disk monitor (Issue #226) reports free space, not where it went.
 *
 * This module measures what *remains*, one level deep, and formats it as a
 * single line logged at cycle start beside `Concurrency:` and again in the
 * `work-volume-prune` housekeeping summary:
 *
 * ```text
 * Work volume: total 18.4 GB — monitored repos 2.1 GB (15) · side/data
 * clones 15.2 GB (8: GRQ-shareprices2026Q2 7.3, GRQ-listing 3.9, …) ·
 * build artefacts 6.3 GB (4 target dirs: GRQ-core/target 3.1, …) ·
 * caches 0.6 GB · other 0.2 GB
 * ```
 *
 * ## Categories
 *
 * A pure function of the entry name and the monitored list, so the split is
 * testable without a filesystem:
 *
 * - **monitored** — a clone of a repository in `.config.json` (tier 1).
 * - **side/data** — any other clone in the work root (tier 2), the sibling
 *   data repos a gate pulled in as `../<name>`.
 * - **caches** — the worker's own caches (`.deno-cache`, `.vibe-cache`,
 *   `.gh-*-cache`, `.claude-*`).
 * - **other** — everything else: reserved names, remaining dot-prefixed
 *   state directories, and the state files in the work root.
 *
 * **Build artefacts are a cross-cut, not a fifth bucket.** A `target/` dir
 * lives *inside* a monitored or side clone, so its bytes are already counted
 * there; naming it separately says which clones the space is in. The four
 * disjoint buckets are what sum to the total.
 *
 * ## Bounded
 *
 * Depth-1 sizes only — one `du -sk` per top-level directory (plus one per
 * discovered `target/`), against a single overall budget (default 120 s).
 * When the budget runs out the walk stops and the line says so rather than
 * holding up the launch: an incomplete total is reported as a floor, never
 * as a clean reading.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { duBytes, findCargoTargets, formatGb } from "./work_volume_prune.ts";
import { monitoredDirNames } from "./work_volume_tiers.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";

const GIB = 1_073_741_824;

/** Overall budget for the whole walk — a launch must not wait on `du`. */
export const DEFAULT_USAGE_BUDGET_MS = 120_000;

/** How many entries of a category are named inline in the log line. */
export const NAMED_ENTRY_LIMIT = 3;

/** Which bucket a work-root entry's bytes belong to. */
export type WorkVolumeCategory =
  /** A clone of a monitored repository — tier 1. */
  | "monitored"
  /** Any other clone in the work root — tier 2, the sibling/data repos. */
  | "side"
  /** A worker-owned cache directory. */
  | "cache"
  /** Reserved names, remaining worker state, and files in the work root. */
  | "other";

/** A named directory with its measured size. */
export interface NamedSize {
  /** Directory name, or the work-root-relative path for an artefact dir. */
  name: string;
  bytes: number;
}

/** One category's standing total. */
export interface CategoryTotal {
  bytes: number;
  count: number;
  /** Members, largest first — the log names the top {@link NAMED_ENTRY_LIMIT}. */
  entries: NamedSize[];
}

/** The work volume's standing totals (Issue #244). */
export interface WorkVolumeUsage {
  /** Sum of the four disjoint categories (artefacts are counted within). */
  totalBytes: number;
  monitored: CategoryTotal;
  side: CategoryTotal;
  caches: CategoryTotal;
  other: CategoryTotal;
  /** `target/` dirs inside the clones above — a subset, not a fifth bucket. */
  artefacts: CategoryTotal;
  /** Top-level directories measured. */
  measured: number;
  /** Top-level directories left unmeasured because the budget ran out. */
  skipped: number;
  /** True when the budget stopped the walk — the totals are a floor. */
  truncated: boolean;
  /** Budget the walk was given, in milliseconds. */
  budgetMs: number;
  /**
   * Directories `du` could not size — counted as 0 bytes, so the total is a
   * floor. Named in the line rather than folded into {@link errors}: the
   * filesystem's own `lost+found` is root-only on every host, and a
   * permanent permission denial there must not drown out a real fault.
   */
  unmeasured: string[];
  /** Structural faults — a work root that could not be read at all. */
  errors: string[];
}

/** Injectable pieces of {@link scanWorkVolumeUsage}. */
export interface WorkVolumeUsageOptions {
  workDir: string;
  /** Monitored repositories, `owner/repo` or bare directory names. */
  monitoredRepos: readonly string[];
  /** Overall walk budget (default {@link DEFAULT_USAGE_BUDGET_MS}). */
  budgetMs?: number;
  /** Milliseconds clock, injectable. */
  nowMsFn?: () => number;
  /** Directory size in bytes, injectable (default `du -sk`). */
  sizeOf?: (path: string) => Promise<number | null>;
  /** File size in bytes, injectable (default `Deno.stat`). */
  fileSizeOf?: (path: string) => Promise<number | null>;
  /** Build-artefact discovery, injectable (default Issue #228's). */
  findArtefacts?: (repoDir: string) => Promise<string[]>;
}

/**
 * Whether a work-root entry is one of the worker's own caches.
 *
 * `.deno-cache` (the durable Deno cache, Issue #4302), `.vibe-cache`, the
 * `gh` scan/timeline caches, and the agent CLI's `.claude-*` directories.
 */
export function isWorkerCacheDir(name: string): boolean {
  return name === ".deno-cache" ||
    name === ".vibe-cache" ||
    name.startsWith(".claude-") ||
    /^\.gh-.+-cache$/.test(name);
}

/**
 * Category a work-root entry's bytes belong to — a pure function of the
 * entry name and the monitored clone names (Issue #244).
 */
export function categoriseWorkVolumeEntry(
  name: string,
  monitored: ReadonlySet<string>,
): WorkVolumeCategory {
  if (name === "") return "other";
  if (monitored.has(name)) return "monitored";
  if (isWorkerCacheDir(name)) return "cache";
  if (name.startsWith(".")) return "other";
  if (isReservedWorkRootEntry(name)) return "other";
  return "side";
}

function emptyCategory(): CategoryTotal {
  return { bytes: 0, count: 0, entries: [] };
}

function emptyUsage(budgetMs: number): WorkVolumeUsage {
  return {
    totalBytes: 0,
    monitored: emptyCategory(),
    side: emptyCategory(),
    caches: emptyCategory(),
    other: emptyCategory(),
    artefacts: emptyCategory(),
    measured: 0,
    skipped: 0,
    truncated: false,
    budgetMs,
    unmeasured: [],
    errors: [],
  };
}

async function statSize(path: string): Promise<number | null> {
  try {
    return (await Deno.stat(path)).size;
  } catch {
    return null;
  }
}

function bucketFor(
  usage: WorkVolumeUsage,
  category: WorkVolumeCategory,
): CategoryTotal {
  switch (category) {
    case "monitored":
      return usage.monitored;
    case "side":
      return usage.side;
    case "cache":
      return usage.caches;
    case "other":
      return usage.other;
  }
}

function record(bucket: CategoryTotal, name: string, bytes: number): void {
  bucket.bytes += bytes;
  bucket.count++;
  bucket.entries.push({ name, bytes });
}

function sortEntries(bucket: CategoryTotal): void {
  bucket.entries.sort((a, b) =>
    b.bytes - a.bytes || a.name.localeCompare(b.name)
  );
}

/**
 * Measure the work volume's standing totals, one level deep (Issue #244).
 *
 * Every top-level directory costs one `du -sk`; files in the work root are
 * stat'd. Build-artefact dirs inside the clones are measured too, and are
 * reported as a subset of the clone categories rather than added to the
 * total twice.
 */
export async function scanWorkVolumeUsage(
  options: WorkVolumeUsageOptions,
): Promise<WorkVolumeUsage> {
  const budgetMs = options.budgetMs ?? DEFAULT_USAGE_BUDGET_MS;
  const nowMs = options.nowMsFn ?? (() => Date.now());
  const sizeOf = options.sizeOf ?? duBytes;
  const fileSizeOf = options.fileSizeOf ?? statSize;
  const findArtefacts = options.findArtefacts ?? findCargoTargets;
  const monitored = monitoredDirNames(options.monitoredRepos);
  const workDir = options.workDir;
  const deadline = nowMs() + budgetMs;
  const usage = emptyUsage(budgetMs);

  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) entries.push(entry);
  } catch (err) {
    usage.errors.push(
      `cannot read ${workDir}: ${err instanceof Error ? err.message : err}`,
    );
    return usage;
  }

  /** Clones whose build artefacts are worth naming separately. */
  const cloneDirs: string[] = [];

  for (const entry of entries) {
    const path = `${workDir}/${entry.name}`;
    if (entry.isFile) {
      const bytes = (await fileSizeOf(path)) ?? 0;
      usage.other.bytes += bytes;
      usage.other.count++;
      usage.totalBytes += bytes;
      continue;
    }
    // Symlinks own no bytes here; anything else is not a directory.
    if (!entry.isDirectory) continue;
    if (nowMs() >= deadline) {
      usage.skipped++;
      usage.truncated = true;
      continue;
    }
    const measuredBytes = await sizeOf(path);
    if (measuredBytes === null) usage.unmeasured.push(entry.name);
    const bytes = measuredBytes ?? 0;
    const category = categoriseWorkVolumeEntry(entry.name, monitored);
    record(bucketFor(usage, category), entry.name, bytes);
    usage.totalBytes += bytes;
    usage.measured++;
    if (category === "monitored" || category === "side") cloneDirs.push(path);
  }

  for (const cloneDir of cloneDirs) {
    if (nowMs() >= deadline) {
      usage.truncated = true;
      break;
    }
    for (const target of await findArtefacts(cloneDir)) {
      if (nowMs() >= deadline) {
        usage.truncated = true;
        break;
      }
      const bytes = (await sizeOf(target)) ?? 0;
      const name = target.startsWith(`${workDir}/`)
        ? target.slice(workDir.length + 1)
        : target;
      record(usage.artefacts, name, bytes);
    }
  }

  for (
    const bucket of [
      usage.monitored,
      usage.side,
      usage.caches,
      usage.other,
      usage.artefacts,
    ]
  ) {
    sortEntries(bucket);
  }
  return usage;
}

/** Bare GB number for an inline `<name> <size>` pair. */
function gbNumber(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/** `8: GRQ-shareprices2026Q2 7.3, GRQ-listing 3.9, GRQ-companyreports 2.1, …` */
function namedTop(bucket: CategoryTotal): string {
  if (bucket.count === 0) return "0";
  const named = bucket.entries.slice(0, NAMED_ENTRY_LIMIT)
    .map((e) => `${e.name} ${gbNumber(e.bytes)}`);
  const more = bucket.count > named.length ? ", …" : "";
  return `${bucket.count}: ${named.join(", ")}${more}`;
}

/**
 * The one-line standing-totals log (Issue #244).
 *
 * @param usage - Totals from {@link scanWorkVolumeUsage}.
 * @param label - Line prefix; the prune summary distinguishes before/after.
 */
export function formatWorkVolumeUsage(
  usage: WorkVolumeUsage,
  label = "Work volume",
): string {
  const artefacts = usage.artefacts.count === 0
    ? "0 target dirs"
    : `${usage.artefacts.count} target dir${
      usage.artefacts.count === 1 ? "" : "s"
    }: ${
      usage.artefacts.entries.slice(0, NAMED_ENTRY_LIMIT)
        .map((e) => `${e.name} ${gbNumber(e.bytes)}`)
        .join(", ")
    }${usage.artefacts.count > NAMED_ENTRY_LIMIT ? ", …" : ""}`;

  const parts = [
    `monitored repos ${
      formatGb(usage.monitored.bytes)
    } (${usage.monitored.count})`,
    `side/data clones ${formatGb(usage.side.bytes)} (${namedTop(usage.side)})`,
    `build artefacts ${formatGb(usage.artefacts.bytes)} (${artefacts})`,
    `caches ${formatGb(usage.caches.bytes)}`,
    `other ${formatGb(usage.other.bytes)}`,
  ];
  let line = `${label}: total ${formatGb(usage.totalBytes)} — ${
    parts.join(" · ")
  }`;
  if (usage.truncated) {
    line += ` — walk stopped at the ${
      Math.round(usage.budgetMs / 1000)
    }s budget (${usage.measured} dir(s) measured, ${usage.skipped} skipped; totals are a floor)`;
  }
  if (usage.unmeasured.length > 0) {
    line += ` — unmeasured (counted as 0): ${usage.unmeasured.join(", ")}`;
  }
  if (usage.errors.length > 0) {
    line += ` — errors: ${usage.errors.join("; ")}`;
  }
  return line;
}

/**
 * Scan and format in one call, with the guard both call sites need: without
 * a monitored list every clone reads as side/data, so say that instead of
 * publishing a misleading split (mirrors the tier command's refusal).
 */
export async function reportWorkVolumeUsage(
  options: WorkVolumeUsageOptions,
  label = "Work volume",
): Promise<string> {
  if (options.monitoredRepos.length === 0) {
    return `${label}: standing totals skipped — no monitored repositories configured (Issue #244)`;
  }
  return formatWorkVolumeUsage(await scanWorkVolumeUsage(options), label);
}
