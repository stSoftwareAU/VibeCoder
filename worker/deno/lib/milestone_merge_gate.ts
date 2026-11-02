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

import {
  runRepositoryCommand,
  type UntrustedGateSpawnDeps,
} from "./untrusted_gate_spawn.ts";
import { stripJsonc } from "./jsonc.ts";
import {
  CARGO_BUILD_SKIPPED_FOR_MERGE,
  shouldSkipEphemeralCargoBuild,
} from "./heavy_build_gate.ts";
import {
  findProjectManifests,
  isFile,
  type ProjectKind,
} from "./project_manifests.ts";
export {
  findProjectManifests,
  MERGE_GATE_MAX_DEPTH,
  type ProjectKind,
  type ProjectManifest,
} from "./project_manifests.ts";

/** How long the merged-tree type check may run before it is killed. */
export const MERGE_GATE_TIMEOUT_MS = 300_000;

/** Error name carried by the refusal, so callers can escalate on it. */
export const MILESTONE_MERGE_GATE_ERROR = "MilestoneMergeGateFailure";

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
  /**
   * Set only by a merge-only gate (Issue #4326) on a `skipped` verdict: the
   * host cannot afford the build, so a conflict the deterministic rules
   * settled is pushed unverified with the `UNGATED:` note rather than refused
   * as a resolution nothing verified (Issue #1559).
   */
  landUnverified?: boolean;
  /**
   * Set when a cargo project was left to CI (Issue #4326). A `passed` outcome
   * with this set has verified only the Deno half; the report must not claim
   * the cargo half passed. A `skipped` outcome with this set verified nothing.
   */
  cargoSkipped?: boolean;
  /**
   * Set on a `passed` outcome when a Deno task could not fetch its remote
   * modules because the host is offline or blocked (Issue #4422). It names the
   * task and the cause. That task did not run, so the report must not claim it
   * passed; the milestone PR's CI runs it.
   */
  suiteLeftToCi?: string;
  /**
   * Set when the repository's own type check for a Deno project could not
   * fetch its remote modules (Issue #4422). It names the task and the cause.
   * That check did not run, so the report must not claim it passed; the
   * milestone PR's CI runs it (Issue #4441).
   */
  checkLeftToCi?: string;
}

/**
 * A Deno task that could not fetch a remote module because the host cannot
 * reach the module host (Issue #4422).
 */
export interface RemoteModuleGap {
  /** The `http(s)` URL the failed import named. */
  url: string;
  /** The trimmed output line that names the connection-class cause. */
  cause: string;
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

/**
 * Import-failure line naming a remote module, e.g.
 * `error: Import 'https://esm.sh/x' failed`. Anchored on the literal prefix;
 * `[^'\s]+` is disjoint from the closing quote, so the match is linear.
 */
const REMOTE_IMPORT_FAILED_RE = /^error: Import '(https?:\/\/[^'\s]+)' failed/;

/**
 * A connection-class cause: the host could not open a route to the module
 * host. Literal alternatives only, so the match is linear in the line length.
 */
const REMOTE_FETCH_CAUSE_RE =
  /error sending request for url|unsuccessful tunnel|dns error|client error \(Connect\)|connection (refused|reset|timed out)/i;

/**
 * Detect a Deno task that could not fetch a remote module because the host
 * cannot reach the module host (Issue #4422).
 *
 * An unreachable host is an environment fault, like the Rust toolchain gap of
 * Issue #3255, not a bad resolution: a repair round cannot fix it. A gap is
 * reported only when an import-failure line names an `http(s)` URL and a
 * connection-class cause line follows it. An import that failed for any other
 * reason (a 404, a bad certificate, a checksum mismatch, a missing module, a
 * type error) is an ordinary failure and returns undefined.
 *
 * @param output - The raw task output (untrimmed)
 * @returns The gap, or undefined when no connection-class cause follows an
 *   import failure
 */
export function detectRemoteModuleGap(
  output: string,
): RemoteModuleGap | undefined {
  let importUrl: string | undefined;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim().slice(0, MAX_GAP_LINE_CHARS);
    const imported = REMOTE_IMPORT_FAILED_RE.exec(line);
    if (imported) {
      importUrl = imported[1];
      continue;
    }
    if (importUrl !== undefined && REMOTE_FETCH_CAUSE_RE.test(line)) {
      return { url: importUrl, cause: line };
    }
  }
  return undefined;
}

/**
 * Spawn the repository's own check with a bounded timeout.
 *
 * The check runs as the untrusted account from the allowlisted environment, not
 * the worker's inherited one (Issue #4659).
 */
export const spawnTypeCheck = async (
  project: TypeCheckProject,
  deps: UntrustedGateSpawnDeps = {},
): ReturnType<TypeCheckRunner> => {
  const executable = project.kind === "cargo" ? "cargo" : Deno.execPath();
  const result = await runRepositoryCommand(executable, project.args, {
    cwd: project.dir,
    timeoutMs: MERGE_GATE_TIMEOUT_MS,
  }, deps);
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
  /**
   * Whether the ephemeral cargo build must not run (Issue #4326).
   * Defaults to the host-disk budget. A merge still lands; CI builds it.
   */
  skipCargoBuild: () => Promise<boolean> = () =>
    shouldSkipEphemeralCargoBuild(repoDir),
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
  const leftToCi: string[] = [];
  const skipCargo = await skipCargoBuild();
  let skippedCargo = false;
  for (const project of projects) {
    if (project.kind === "cargo" && skipCargo) {
      // The host is above its floor and short of cargo headroom, and
      // pruning freed nothing. Running cargo here is what would take free
      // space through the floor, so the merge lands and CI builds it.
      skippedCargo = true;
      continue;
    }
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
      // A Deno check that could not reach its module host says nothing about
      // the merged tree: it is left to CI, as the resolution gate leaves it
      // (Issue #4422). Refusing here charged a conflict attempt for a network
      // fault and walked every milestone to the merge-fallback rung.
      const remote = project.kind === "cargo"
        ? undefined
        : detectRemoteModuleGap(result.output);
      if (remote) {
        leftToCi.push(
          `${where} could not fetch its remote modules (${remote.cause})`,
        );
        continue;
      }
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

  const notes = [
    ...(skippedCargo ? [`${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #4326)`] : []),
    ...leftToCi.map((note) => `${note} — left to CI (Issue #4422)`),
  ];
  const checkLeftToCi = leftToCi.length > 0 ? leftToCi.join("; ") : undefined;
  if (checked.length === 0 && notes.length > 0) {
    return {
      status: "skipped",
      detail: notes.join("; "),
      output: "",
      ...(skippedCargo ? { cargoSkipped: true } : {}),
      ...(checkLeftToCi ? { checkLeftToCi } : {}),
    };
  }

  return {
    status: "passed",
    detail: [`${checked.join("; ")} passed`, ...notes].join("; "),
    output: "",
    ...(skippedCargo ? { cargoSkipped: true } : {}),
    ...(checkLeftToCi ? { checkLeftToCi } : {}),
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
