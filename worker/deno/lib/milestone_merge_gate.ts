/**
 * Type-check gate for the `main` → `milestone/<name>` sync merge (Issue #974).
 *
 * The sync pushed whatever the merge produced. Git reported no conflict
 * because both sides were internally consistent — only their combination was
 * not — so a resolution that dropped live wiring reached the milestone branch
 * three times running, and `milestone/*` has no required checks to catch it
 * downstream (#928, #796).
 *
 * This module answers one question about the merged tree, before the push:
 * does it still compile? The repository's own check is used — its
 * `deno task check` where one is defined, otherwise `deno check '**\/*.ts'` —
 * so the gate is the repo's gate rather than a second opinion invented here.
 *
 * A check that cannot be run reports `failed`, not `passed`: absence of a
 * failure is not success, and a tree nobody verified is exactly the tree this
 * gate exists to keep off the branch.
 *
 * A `cargo check` can also fail because a workspace package's `rust-version`
 * is newer than the container's pinned `rustc` (Issue #3255) — a refusal no
 * resolution change can answer. That is reported as a {@link RustToolchainGap}
 * rather than an ordinary failure, so the repair rounds in
 * `milestone_gate_repair.ts` are not spent retrying a host toolchain limit as
 * though it were a bad resolution. When only dependencies are too new, cargo
 * itself names a `Cargo.lock` remedy (`cargo update --precise`), so that form
 * stays an ordinary, repairable failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
import { buildCacheEnvForCheckout } from "./ephemeral_build_cache.ts";
import { stripJsonc } from "./jsonc.ts";

/** How long the merged-tree type check may run before it is killed. */
export const MERGE_GATE_TIMEOUT_MS = 300_000;

/** Directory levels searched below the repo root for a Deno project. */
export const MERGE_GATE_MAX_DEPTH = 2;

/** Error name carried by the refusal, so callers can escalate on it. */
export const MILESTONE_MERGE_GATE_ERROR = "MilestoneMergeGateFailure";

/** Never descended into when looking for the project. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
]);

/** Longest check output carried into a log line or an escalation comment. */
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHARS = 4000;

/** The type check a repository defines for itself. */
export interface TypeCheckProject {
  /** Directory the check runs in. */
  dir: string;
  /** Arguments passed to the executable {@link kind} names. */
  args: string[];
  /**
   * Which toolchain checks this project (Issue #2138): a `deno.json(c)` is
   * checked with `deno`, a `Cargo.toml` with `cargo`. A tree with neither is
   * still refused as unverifiable, exactly as Issue #1559 set it.
   */
  kind: ProjectKind;
}

/** The build ecosystems the milestone gates can verify a tree with. */
export type ProjectKind = "deno" | "cargo";

/** How a project's check is spelled in a log line or an escalation. */
export function describeProject(project: TypeCheckProject): string {
  return `${project.kind} ${project.args.join(" ")}`;
}

/** What the gate concluded about the merged tree. */
export type MergeGateStatus =
  /** The tree compiles — the push may proceed. */
  | "passed"
  /** The tree does not compile, or could not be checked — do not push. */
  | "failed"
  /** The repository defines no type check, so none was run. */
  | "skipped";

/** Outcome of {@link checkMergedTree}. */
export interface MergeGateOutcome {
  status: MergeGateStatus;
  /** One-line summary for the log and the escalation comment. */
  detail: string;
  /** Trimmed tail of the check output; empty when nothing ran. */
  output: string;
  /**
   * Set only when a `cargo check` failed because the host's `rustc` is older
   * than the `rust-version` a workspace package of the merged tree requires
   * (Issue #3255) — an environment fault no resolution change can fix, so the
   * caller must not spend a repair round on it.
   */
  toolchainGap?: RustToolchainGap;
}

/**
 * A `cargo` refusal that names a `rust-version` newer than the host's `rustc`.
 *
 * Cargo prints one "requires rustc X" line per affected target, so the same
 * package can appear dozens of times for one gap (Issue #3255) — `packages`
 * is deduplicated, and `required` is the highest version any line named.
 */
export interface RustToolchainGap {
  /** The host's `rustc` version, when cargo's header line named it. */
  installed?: string;
  /** The highest `rust-version` any affected package required. */
  required: string;
  /** Distinct `name@version` packages that named the requirement, in order. */
  packages: string[];
}

/** Gate signature injected into the sync, so tests can drive both verdicts. */
export type MergeGateFn = (repoDir: string) => Promise<MergeGateOutcome>;

/** Runs the resolved check. Injected in tests; spawns `deno` in production. */
export type TypeCheckRunner = (
  project: TypeCheckProject,
) => Promise<{ code: number; output: string }>;

/** Whether a path exists and is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Which arguments run this project's type check.
 *
 * A `check` task in the manifest is the repository's own gate — flags,
 * lockfile pins and all — so it is preferred. `deno.jsonc` may carry comments,
 * so the manifest is stripped before parsing rather than quietly losing the
 * repo's own task to a `JSON.parse` failure. A manifest that still cannot be
 * read falls back to a whole-tree `deno check`, which type-checks the same
 * files with default flags.
 */
async function resolveCheckArgs(manifestPath: string): Promise<string[]> {
  return (await readManifestTasks(manifestPath)).includes("check")
    ? ["task", "check"]
    : ["check", "**/*.ts"];
}

/**
 * `cargo check` over the whole workspace, every target (Issue #2138) —
 * `--locked` only when a `Cargo.lock` is committed, so a merged lockfile
 * that no longer matches is a failure and an unlocked crate is not refused
 * for a file it never had.
 */
export async function cargoCheckArgs(dir: string): Promise<string[]> {
  const args = ["check", "--workspace", "--all-targets"];
  if (await isFile(`${dir}/Cargo.lock`)) args.push("--locked");
  return args;
}

/**
 * The task names a Deno manifest defines.
 *
 * Only tasks with a non-empty command string count: a manifest whose `tasks`
 * key is malformed defines none, and an unparseable manifest is read the same
 * way — the caller then falls back to a check it can run rather than trying to
 * run a task that may not exist.
 *
 * Shared with the conflict-resolution gate (Issue #1559), which runs more of a
 * repository's own tasks than a type check alone.
 *
 * @param manifestPath - Path to `deno.json` or `deno.jsonc`
 * @returns Every task name the manifest defines; empty when it defines none
 */
export async function readManifestTasks(
  manifestPath: string,
): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      stripJsonc(await Deno.readTextFile(manifestPath)),
    );
    const tasks = parsed?.tasks;
    if (!tasks || typeof tasks !== "object") return [];
    return Object.entries(tasks as Record<string, unknown>)
      .filter(([, command]) =>
        typeof command === "string" && command.trim().length > 0
      )
      .map(([name]) => name);
  } catch {
    // Unparseable manifest — it defines nothing this gate can run.
    return [];
  }
}

/** The manifest in a directory, or null when it holds none. */
async function manifestsIn(dir: string): Promise<ProjectManifest[]> {
  const found: ProjectManifest[] = [];
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    const path = `${dir}/${manifest}`;
    if (await isFile(path)) {
      found.push({ dir, manifest: path, kind: "deno" });
      break;
    }
  }
  // Issue #2138: a Cargo workspace is a project too. Its members are covered
  // by `--workspace`, so a directory that holds a Cargo.toml is not descended.
  const cargo = `${dir}/Cargo.toml`;
  if (await isFile(cargo)) found.push({ dir, manifest: cargo, kind: "cargo" });
  return found;
}

/**
 * The type check to run for every Deno project in a tree.
 *
 * @param repoDir - Root of the merged working tree
 * @returns Every project to check; empty when the tree defines none
 */
export async function findTypeCheckProjects(
  repoDir: string,
): Promise<TypeCheckProject[]> {
  const found: TypeCheckProject[] = [];
  for (const project of await findProjectManifests(repoDir)) {
    found.push({
      dir: project.dir,
      kind: project.kind,
      args: project.kind === "cargo"
        ? await cargoCheckArgs(project.dir)
        : await resolveCheckArgs(project.manifest),
    });
  }
  return found;
}

/** A Deno project found in a tree, and the manifest that declares it. */
export interface ProjectManifest {
  /** Which toolchain owns the manifest (Issue #2138). */
  kind: ProjectKind;
  /** Directory holding the manifest. */
  dir: string;
  /** Path to `deno.json` or `deno.jsonc` in that directory. */
  manifest: string;
}

/**
 * Locate every Deno project in the tree, breadth-first from the repo root.
 *
 * **All** of them, not the first one found: this repository carries
 * `container/deno-seed/deno.json` alongside `worker/deno/deno.json`, and a
 * search that stopped at whichever `Deno.readDir` happened to return first
 * would type-check a single-file seed project and call a broken
 * `worker/deno` clean — a gate that passes everything, which is the state
 * Issue #974 exists to end.
 *
 * A directory that holds a manifest is not descended into: its own project
 * covers what lies beneath it. Each level is sorted, so the same tree yields
 * the same order on every host.
 *
 * Shared by the type-check gate (Issue #974) and the conflict-resolution gate
 * (Issue #1559) so both judge the same set of projects.
 *
 * @param repoDir - Root of the merged working tree
 * @returns Every project found; empty when the tree defines none
 */
export async function findProjectManifests(
  repoDir: string,
): Promise<ProjectManifest[]> {
  const found: ProjectManifest[] = [];
  let level = [repoDir];
  for (let depth = 0; depth <= MERGE_GATE_MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level.sort()) {
      const manifests = await manifestsIn(dir);
      if (manifests.length > 0) {
        found.push(...manifests);
        continue;
      }
      if (depth === MERGE_GATE_MAX_DEPTH) continue;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isDirectory) continue;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          next.push(`${dir}/${entry.name}`);
        }
      } catch {
        // An unreadable subdirectory simply contributes no candidates; an
        // unreadable *root* is caught by checkMergedTree, which fails.
      }
    }
    level = next;
  }
  return found;
}

/**
 * Collapse consecutive identical lines into one line marked `(×N)`.
 *
 * Cargo's "requires rustc" refusal repeats the same line once per target —
 * `neat_ai_discovery@0.74.279 requires rustc 1.99` forty times over — which
 * pushed the one line that mattered for Issue #3255 out of the kept tail
 * entirely. Only *consecutive* duplicates collapse: lines repeated with other
 * output between them are a weaker signal of the same cause and are kept as
 * they were.
 *
 * @param output - The raw check output, before it is trimmed to a tail
 * @returns The same lines, with consecutive runs collapsed
 */
export function collapseRepeatedLines(output: string): string {
  const lines = output.split("\n");
  const collapsed: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    collapsed.push(run > 1 ? `${line} (×${run})` : line);
    i += run;
  }
  return collapsed.join("\n");
}

/** Keep the tail of the output — the errors sit at the end of a check run. */
function tail(output: string): string {
  const lines = collapseRepeatedLines(output.trim()).split("\n");
  const kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  return kept.length > MAX_OUTPUT_CHARS ? kept.slice(-MAX_OUTPUT_CHARS) : kept;
}

/** Longest line considered for a toolchain-gap pattern (Issue #3255). */
const MAX_GAP_LINE_CHARS = 4000;

/**
 * Cargo's "rustc X is not supported" header, naming the host's version.
 *
 * Anchored on a literal prefix before the numeric capture and a literal
 * suffix after it, so the capture's `[0-9.]*` cannot backtrack against
 * hostile input — each character is either a digit/dot (consumed by the
 * class) or the first character of the literal suffix (which the class never
 * matches), so the match is a single linear pass.
 */
const RUSTC_HEADER_RE = /^error: rustc ([0-9][0-9.]*) is not supported/;

/**
 * One cargo "package@version requires rustc X" line.
 *
 * The same anchoring reasoning as {@link RUSTC_HEADER_RE}: `[^\s@]+` is
 * disjoint from the literal `@` and ` ` that follow it, so neither capture
 * group can backtrack into the next.
 */
const RUSTC_REQUIRES_RE = /^([^\s@]+)@([^\s@]+) requires rustc ([0-9][0-9.]*)/;

/**
 * The hint cargo appends only when every incompatible package is a
 * dependency, never a workspace member (`local_incompatible` in cargo's
 * `ops/cargo_compile/mod.rs`): the refusal is then fixable by selecting older
 * dependency versions in `Cargo.lock`, which a resolution can do.
 */
const DEPENDENCY_ONLY_HINT =
  "Either upgrade rustc or select compatible dependency versions";

/** Numeric, dot-separated version comparison (`"1.99"` > `"1.98.0"`). */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Detect a cargo refusal caused by the host's `rustc` being older than a
 * workspace package's `rust-version` (Issue #3255).
 *
 * No resolution change can fix that — only raising the container's Rust pin
 * (`container/tools.json`) can — so the caller treats it as an environment
 * fault rather than an ordinary check failure, and skips the repair rounds
 * built for a bad resolution. A refusal carrying cargo's dependency-only hint
 * ({@link DEPENDENCY_ONLY_HINT}) is not a gap: a `Cargo.lock` change can fix
 * it, so it stays an ordinary failure that a repair round may answer.
 *
 * @param output - The raw `cargo check` output (untrimmed)
 * @returns The gap, or undefined when no "requires rustc" line is found or
 *   cargo says only dependencies are incompatible
 */
export function detectRustToolchainGap(
  output: string,
): RustToolchainGap | undefined {
  let installed: string | undefined;
  let required: string | undefined;
  const packages: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim().slice(0, MAX_GAP_LINE_CHARS);

    const header = RUSTC_HEADER_RE.exec(line);
    if (header) {
      installed = header[1];
      continue;
    }

    const requires = RUSTC_REQUIRES_RE.exec(line);
    if (requires) {
      const [, name, version, requiredVersion] = requires;
      const pkg = `${name}@${version}`;
      if (!seen.has(pkg)) {
        seen.add(pkg);
        packages.push(pkg);
      }
      if (!required || compareVersions(requiredVersion!, required) > 0) {
        required = requiredVersion;
      }
    }
  }

  if (!required || output.includes(DEPENDENCY_ONLY_HINT)) return undefined;
  return { installed, required, packages };
}

/**
 * One-line failure detail for a {@link RustToolchainGap} (Issue #3255),
 * naming the installed and required rustc, the packages and the pin to raise.
 */
export function describeRustToolchainGap(
  where: string,
  code: number,
  gap: RustToolchainGap,
): string {
  return `${where} failed (exit ${code}): the host's rustc ` +
    `${
      gap.installed ?? "(unknown)"
    } is older than the rust-version ${gap.required} that ` +
    `${gap.packages.join(", ")} require(s) — raise the container's Rust pin ` +
    `(container/tools.json) to at least ${gap.required}; a workspace ` +
    "package requires it, so no change to the resolution can fix this";
}

/** Spawn the repository's own check with a bounded timeout. */
const spawnTypeCheck: TypeCheckRunner = async (project) => {
  const executable = project.kind === "cargo" ? "cargo" : Deno.execPath();
  const result = await runWithTimeout(executable, project.args, {
    cwd: project.dir,
    timeoutMs: MERGE_GATE_TIMEOUT_MS,
    // Where the runtime refuses to trim the work volume, `cargo check` writes
    // its artefacts to the container's ephemeral layer instead of ratcheting
    // the volume's sparse image (Issue #2247). Empty everywhere else.
    env: buildCacheEnvForCheckout(project.dir),
  });
  if (!result.ok) return { code: 1, output: result.error.message };
  const { code, stdout, stderr, timedOut } = result.value;
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean)
    .join("\n");
  if (timedOut) {
    return {
      code: 124,
      output: `${output}\nType check timed out after ${MERGE_GATE_TIMEOUT_MS}ms`
        .trim(),
    };
  }
  return { code, output };
};

/**
 * Run the repository's own type check against a merged working tree.
 *
 * @param repoDir - Root of the merged working tree (the clone's cwd)
 * @param runner - Override the spawned check (tests)
 * @returns The verdict, with the check output when one ran
 */
export async function checkMergedTree(
  repoDir: string,
  runner: TypeCheckRunner = spawnTypeCheck,
): Promise<MergeGateOutcome> {
  // A tree that cannot be read is a check that could not be run, not a
  // repository without one — refuse rather than wave it through as "skipped".
  try {
    if (!(await Deno.stat(repoDir)).isDirectory) {
      return {
        status: "failed",
        detail:
          `merged tree '${repoDir}' is not a directory — nothing checked it`,
        output: "",
      };
    }
  } catch (err) {
    return {
      status: "failed",
      detail: `merged tree '${repoDir}' could not be read — nothing checked it`,
      output: tail(err instanceof Error ? err.message : String(err)),
    };
  }

  const projects = await findTypeCheckProjects(repoDir);
  if (projects.length === 0) {
    return {
      status: "skipped",
      detail: `no deno.json(c) or Cargo.toml under '${repoDir}' — the merged ` +
        "tree was not type-checked",
      output: "",
    };
  }

  const checked: string[] = [];
  for (const project of projects) {
    const where = `${describeProject(project)} in ${project.dir}`;
    let result: { code: number; output: string };
    try {
      result = await runner(project);
    } catch (err) {
      // Unrunnable is not clean: refuse the push rather than assume it
      // compiles.
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "failed",
        detail: `${where} could not be run`,
        output: tail(message),
      };
    }
    if (result.code !== 0) {
      const gap = project.kind === "cargo"
        ? detectRustToolchainGap(result.output)
        : undefined;
      if (gap) {
        return {
          status: "failed",
          detail: describeRustToolchainGap(where, result.code, gap),
          output: tail(result.output),
          toolchainGap: gap,
        };
      }
      return {
        status: "failed",
        detail: `${where} failed (exit ${result.code})`,
        output: tail(result.output),
      };
    }
    checked.push(where);
  }

  return {
    status: "passed",
    detail: `${checked.join("; ")} passed`,
    output: "",
  };
}

/**
 * The refusal raised when a merged tree does not compile (Issue #974).
 *
 * Typed with {@link MILESTONE_MERGE_GATE_ERROR} so the sync can tell it apart
 * from an ordinary merge failure and escalate on the first occurrence — a
 * tree that does not compile is not a transient condition that a retry fixes.
 */
export function mergeGateFailureError(
  milestoneBranch: string,
  defaultBranch: string,
  outcome: MergeGateOutcome,
): Error {
  const err = new Error(
    `Refused to push the merge of '${defaultBranch}' into ` +
      `'${milestoneBranch}': the merged tree does not pass the repository's ` +
      `own check (Issue #974) — ${outcome.detail}${
        outcome.output ? `\n${outcome.output}` : ""
      }`,
  );
  err.name = MILESTONE_MERGE_GATE_ERROR;
  return err;
}

/** Whether an error is the merge-gate refusal. */
export function isMergeGateFailure(err: unknown): boolean {
  return err instanceof Error && err.name === MILESTONE_MERGE_GATE_ERROR;
}

/** Everything the escalation comment names. */
export interface MergeGateEscalation {
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  /** The refusal message, including the check output. */
  reason: string;
}

/**
 * Body of the needs-human comment posted on the milestone's tracking issue.
 *
 * The merge is named, the check output travels with it, and the comment says
 * plainly that nothing was pushed — so the reader knows the branch is intact
 * and what has to be resolved before it moves.
 */
export function buildMergeGateEscalationComment(
  e: MergeGateEscalation,
): string {
  return `## Milestone sync merge fails the repo's own check — needs a human\n\n` +
    `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
    `\`${e.repo}\` produced a tree that fails the repository's own check ` +
    `(a type error, or whatever else that check enforces — a stale lockfile ` +
    `under \`--frozen\`, say), so it was **not pushed** and the local merge ` +
    `was discarded (Issue #974).\n\n` +
    `Git reported no conflict: both sides were internally consistent and ` +
    `only their combination is not, which is how the same wiring was lost ` +
    `three times before this gate existed (#928, #796).\n\n` +
    `Check output:\n\n\`\`\`\n${e.reason}\n\`\`\`\n\n` +
    `Resolve the merge by hand on \`${e.milestoneBranch}\`. The sync will ` +
    `keep refusing to push until the merged tree compiles.`;
}
