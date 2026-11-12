/**
 * Shared helpers that the Deno and Rust checks still use. The automatic
 * mutation check was retired by Issue #5095, so this module no longer runs
 * mutants: it holds only the helpers that remain in use.
 *
 * Retained: {@link MutationRunnerSeams} and {@link defaultMutationRunnerSeams}
 * (the process, filesystem, temporary-directory and tree seams), along with
 * {@link findDenoConfigDir}, {@link findCargoPackageDir}, {@link confinePath}
 * and {@link importsModule}.
 *
 * Every child process runs with an allowlisted environment, never the
 * worker's own (see {@link defaultMutationRunnerSeams}). A repository path
 * handed to {@link confinePath} is normalised, its longest existing prefix is
 * canonicalised through `realPath`, and only a canonical path inside the
 * canonical repository root is accepted.
 *
 * Known limit ({@link importsModule}): a Deno module is found through a test
 * only when that test imports it directly, through a relative specifier or a
 * specifier the project's `imports` map resolves to a local path (Issue #4533).
 * `importMap` files and `scopes` are not read.
 *
 * Australian English spelling used throughout.
 */
import { isDenoTestFile } from "./mutation_gate.ts";
import {
  type DenoProjectConfig,
  EMPTY_PROJECT_CONFIG,
  isDenoTestPath,
  parseDenoProjectConfig,
  resolveImportSpecifier,
} from "./deno_test_config.ts";
import { hardenStateDir } from "./private_cache_dir.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import {
  buildCacheEnvForCheckout,
  ephemeralBuildCacheEnv,
  workVolumeTrimRefusedForLaunch,
} from "./ephemeral_build_cache.ts";
import {
  inFlightHostDiskGateEnabled,
  parkRunningBuild,
} from "./heavy_build_gate.ts";
import {
  restoreTree,
  snapshotTree,
  type TreeSnapshot,
} from "./mutation_tree_guard.ts";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface MutationRunnerSeams {
  runProcess(
    cmd: string,
    args: string[],
    opts: {
      cwd: string;
      timeoutMs: number;
      /** Extra variables for the child, set after the allowlist is applied. */
      env?: Record<string, string>;
    },
  ): Promise<ProcessResult>;
  /** Milliseconds. */
  now(): number;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Canonical path with symlinks resolved; rejects when the path is absent. */
  realPath(path: string): Promise<string>;
  /** Recursively remove a directory; absent is not an error. */
  removeDir(path: string): Promise<void>;
  /**
   * Repo-relative Deno test files: the `*_test.ts` / `*.test.ts` suffix rule,
   * or a project's `test.include` (Issue #4533).
   */
  listTestFiles(repoPath: string): Promise<string[]>;
  /** Create an empty, writable temporary directory outside any repository; rejects when none can be created. */
  makeTempDir(): Promise<string>;
  /**
   * The untracked and modified paths of the working tree at `repoPath`, taken
   * before a Deno run (Issue #4905); null when git cannot list it. Never throws.
   */
  snapshotTree(repoPath: string): Promise<TreeSnapshot | null>;
  /**
   * Restore the working tree at `repoPath` to `before` after a Deno run: delete
   * untracked files new since the snapshot, check out newly modified tracked
   * files. A failure is a warning, never a throw (Issue #4905).
   */
  restoreTree(repoPath: string, before: TreeSnapshot): Promise<void>;
}

const DENO_MARKERS = ["deno.json", "deno.jsonc", "deno.lock"];
/** Project config files, in the order Deno prefers them. */
const DENO_CONFIG_FILES = ["deno.json", "deno.jsonc"];
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const RELATIVE_SPECIFIER = /["'](\.{1,2}\/[^"']*)["']/g;
/** Any quoted specifier; a bare one may be an `imports` alias (Issue #4533). */
const QUOTED_SPECIFIER = /["']([^"'\s]+)["']/g;

/**
 * Repo-relative directory of the nearest ancestor of `file` (itself included)
 * holding a Deno marker, `""` for the repository root, or null when none does.
 * A marker that resolves outside the repository does not count.
 */
export async function findDenoConfigDir(
  repoPath: string,
  file: string,
  seams: MutationRunnerSeams,
): Promise<string | null> {
  let dir = dirOf(normalisePath(file));
  for (;;) {
    for (const marker of DENO_MARKERS) {
      const abs = await confinePath(
        repoPath,
        dir === "" ? marker : `${dir}/${marker}`,
        seams,
      );
      if (abs !== null && await seams.exists(abs)) return dir;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

/** A Deno project: its directory relative to the repository root, and its config. */
export interface DenoProject {
  dir: string;
  config: DenoProjectConfig;
}

/** `file` (repo-relative) relative to the project directory `dir`. */
function relativeToProject(dir: string, file: string): string {
  return dir === "" ? file : file.slice(dir.length + 1);
}

/**
 * The Deno test rule (Issue #4533), shared by the runner and the real listing:
 * the suffix rule when there is no project, else the project's `test.include`
 * rule for `file`, which the suffix rule also satisfies.
 */
function isDenoTestIn(file: string, project: DenoProject | null): boolean {
  if (project === null) return isDenoTestFile(file);
  return isDenoTestPath(relativeToProject(project.dir, file), project.config);
}

function normalisePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/**
 * Resolve `rel` under `repoPath` to a canonical path that is guaranteed to sit
 * inside the canonical repository root, or null when it does not.
 *
 * 1. Join and lexically normalise; a `..` that climbs above the root rejects.
 * 2. Canonicalise the longest existing prefix (resolving any symlink in it)
 *    and re-attach the not-yet-existing tail.
 * 3. Require the result to be inside the canonical repository root.
 */
export async function confinePath(
  repoPath: string,
  rel: string,
  seams: Pick<MutationRunnerSeams, "realPath">,
): Promise<string | null> {
  if (rel.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return null;
    } else parts.push(part);
  }
  const root = await seams.realPath(repoPath);
  const tail: string[] = [];
  let prefix = `${repoPath.replace(/\/+$/, "")}/${parts.join("/")}`
    .replace(/\/+$/, "");
  let canonical: string | null = null;
  while (prefix !== "") {
    try {
      canonical = await seams.realPath(prefix);
      break;
    } catch {
      tail.unshift(prefix.slice(prefix.lastIndexOf("/") + 1));
      prefix = dirOf(prefix);
    }
  }
  if (canonical === null) return null;
  const full = tail.length === 0 ? canonical : `${canonical}/${tail.join("/")}`;
  const rootDir = root.endsWith("/") ? root : `${root}/`;
  return full === root || full.startsWith(rootDir) ? full : null;
}

/**
 * Does `text` (in directory `dir`) import the repo-relative `module`? A relative
 * specifier counts by its path. With `project` (the Deno project the test is
 * in), a bare specifier counts when the project's `imports` map resolves it to
 * `module` (Issue #4533).
 */
export function importsModule(
  text: string,
  dir: string,
  module: string,
  project?: DenoProject,
): boolean {
  for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
    const spec = m[1];
    if (spec === undefined) continue;
    if (normalisePath(`${dir}/${spec}`) === module) return true;
  }
  if (project === undefined) return false;
  for (const m of text.matchAll(QUOTED_SPECIFIER)) {
    const spec = m[1];
    if (spec === undefined || spec.startsWith(".")) continue;
    if (
      resolveImportSpecifier(spec, project.config, project.dir) === module
    ) {
      return true;
    }
  }
  return false;
}

/** The `name = "..."` under `[package]` in a Cargo.toml, or null. */
function packageNameOf(toml: string): string | null {
  let section = "";
  for (const line of toml.split("\n")) {
    const header = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = (header[1] ?? "").trim();
      continue;
    }
    if (section !== "package") continue;
    const name = /^\s*name\s*=\s*"([^"]*)"/.exec(line);
    if (name) return name[1] ?? null;
  }
  return null;
}

/**
 * Repo-relative directory of the nearest ancestor of `file` whose `Cargo.toml`
 * declares a `[package]` (a virtual workspace manifest does not count), `""` for
 * the repository root, or null when none does. A manifest that resolves outside
 * the repository does not count.
 */
export async function findCargoPackageDir(
  repoPath: string,
  file: string,
  seams: MutationRunnerSeams,
): Promise<string | null> {
  let dir = dirOf(normalisePath(file));
  for (;;) {
    const manifest = dir === "" ? "Cargo.toml" : `${dir}/Cargo.toml`;
    const abs = await confinePath(repoPath, manifest, seams);
    if (
      abs !== null && await seams.exists(abs) &&
      packageNameOf(await seams.readTextFile(abs)) !== null
    ) {
      return dir;
    }
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "target"]);

/**
 * Walk the repository collecting its source files and its Deno project
 * directories: each directory holding a `deno.json` or `deno.jsonc` (mapped to
 * that file's name) or only a `deno.lock` (mapped to null). Symlinks and
 * {@link SKIP_DIRS} are skipped.
 */
async function walkSources(
  root: string,
  rel: string,
  sources: string[],
  projects: Map<string, string | null>,
): Promise<void> {
  const dir = rel === "" ? root : `${root}/${rel}`;
  const names = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isSymlink) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walkSources(root, childRel, sources, projects);
      }
    } else if (entry.isFile) {
      names.add(entry.name);
      if (SOURCE_FILE.test(entry.name)) sources.push(childRel);
    }
  }
  const config = DENO_CONFIG_FILES.find((name) => names.has(name));
  if (config !== undefined) projects.set(rel, config);
  else if (names.has("deno.lock")) projects.set(rel, null);
}

/** The nearest directory of `file` (itself included) that a walk found to be a project. */
function nearestProjectDir(
  file: string,
  projects: ReadonlyMap<string, string | null>,
): string | null {
  let dir = dirOf(file);
  for (;;) {
    if (projects.has(dir)) return dir;
    if (dir === "") return null;
    dir = dirOf(dir);
  }
}

/**
 * A walked project's config, read once per directory. A lock-only project, or
 * one whose config cannot be read or parsed, has the empty config (suffix rule).
 */
async function readWalkedConfig(
  repoPath: string,
  dir: string,
  name: string | null,
  cache: Map<string, DenoProjectConfig>,
): Promise<DenoProjectConfig> {
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;
  let config: DenoProjectConfig = EMPTY_PROJECT_CONFIG;
  if (name !== null) {
    const rel = dir === "" ? name : `${dir}/${name}`;
    try {
      config = parseDenoProjectConfig(
        await Deno.readTextFile(`${repoPath}/${rel}`),
        rel,
      );
    } catch {
      // A broken config in a project the caller never asked about must not
      // fail the whole listing; that project falls back to the suffix rule.
      // The changed module's own project still fails loud in loadProjectConfig.
      config = EMPTY_PROJECT_CONFIG;
    }
  }
  cache.set(dir, config);
  return config;
}

/**
 * Repo-relative Deno test files, sorted (Issue #4533). A source file is a test
 * by the rule the runner applies to a module's tests, judged against its
 * nearest project directory; a `.d.ts` declaration is never a test.
 */
async function listDenoTestFiles(repoPath: string): Promise<string[]> {
  const sources: string[] = [];
  const projects = new Map<string, string | null>();
  await walkSources(repoPath, "", sources, projects);
  const configs = new Map<string, DenoProjectConfig>();
  const out: string[] = [];
  for (const file of sources) {
    if (file.endsWith(".d.ts")) continue;
    const dir = nearestProjectDir(file, projects);
    const project = dir === null ? null : {
      dir,
      config: await readWalkedConfig(
        repoPath,
        dir,
        projects.get(dir) ?? null,
        configs,
      ),
    };
    if (isDenoTestIn(file, project)) out.push(file);
  }
  return out.sort();
}

/** Leaf directory on the work volume used when the system temp directory refuses a write (Issue #4127). */
export const MUTATION_SCRATCH_DIR_NAME = ".mutation-scratch";

/** Work-directory name derived from `HOME`, mirroring `config.ts` and `ci_check_state_dir.ts`. */
const HOME_WORK_DIR_NAME = "auto-issue-work";

/** Trim whitespace and trailing slashes; `/` normalises to `""`. */
function normaliseScratchBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** `<WORK_DIR or $HOME/auto-issue-work>/.mutation-scratch`, the first absolute candidate, or null. */
export function resolveMutationScratchRoot(
  lookup: (name: string) => string | undefined,
): string | null {
  const home = normaliseScratchBase(lookup("HOME"));
  const candidates = [
    normaliseScratchBase(lookup("WORK_DIR")),
    home ? `${home}/${HOME_WORK_DIR_NAME}` : "",
  ];
  const base = candidates.find((c) => c.startsWith("/"));
  return base === undefined ? null : `${base}/${MUTATION_SCRATCH_DIR_NAME}`;
}

function causeText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Create the run's temporary directory (Issue #4127): in the system temp
 * directory (`TMPDIR`, else Deno's default) first, and when that refuses —
 * a read-only mount in the agent container — in a private `0700`
 * `.mutation-scratch` root on the work volume. Rejects with both causes when
 * neither can be created.
 */
export async function makeMutationTempDir(
  lookup: (name: string) => string | undefined,
  /** The real `Deno.makeTempDir` in production; a test can force a refusal. */
  makeTemp: (options: Deno.MakeTempOptions) => Promise<string> = (options) =>
    Deno.makeTempDir(options),
): Promise<string> {
  const tmp = lookup("TMPDIR")?.trim();
  try {
    return await makeTemp({
      prefix: "vibe-mutation-",
      ...(tmp ? { dir: tmp } : {}),
    });
  } catch (systemErr) {
    const systemCause = causeText(systemErr);
    const root = resolveMutationScratchRoot(lookup);
    if (root === null) {
      throw new Error(
        `system temp directory: ${systemCause}; no work-volume fallback (neither WORK_DIR nor HOME names an absolute directory)`,
      );
    }
    const trust = await hardenStateDir(root, { create: true });
    if (!trust.trusted) {
      throw new Error(
        `system temp directory: ${systemCause}; ${root}: ${
          trust.reason ?? "not a private directory"
        }`,
      );
    }
    try {
      return await makeTemp({ dir: root, prefix: "vibe-mutation-" });
    } catch (fallbackErr) {
      throw new Error(
        `system temp directory: ${systemCause}; ${root}: ${
          causeText(fallbackErr)
        }`,
      );
    }
  }
}

/**
 * Child environment for one mutation or discrimination command.
 *
 * `cargo` and `deno` take the ephemeral target directory when the launch
 * refuses the volume trim (Issue #4360), the same placement the agent and the
 * quality gate already use. `git` does not: it writes no build output.
 * An explicit `CARGO_TARGET_DIR` on `source` is left alone.
 */
export function mutationChildEnv(
  cmd: string,
  cwd: string,
  options: {
    source?: Record<string, string>;
    overrides?: Record<string, string>;
    trimRefused?: boolean;
    root?: string;
  } = {},
): Record<string, string> {
  const cache = cmd === "cargo" || cmd === "deno"
    ? ephemeralBuildCacheEnv({
      checkoutPath: cwd,
      trimRefused: options.trimRefused === true,
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.source === undefined ? {} : { source: options.source }),
    })
    : {};
  return buildUntrustedCommandEnv({
    ...(options.source === undefined ? {} : { source: options.source }),
    overrides: { ...(options.overrides ?? {}), ...cache },
  });
}

/** How often a running cargo or deno is asked whether the host is still above the floor. */
const HOST_DISK_POLL_MS = 30_000;

/**
 * Real seams: `Deno.Command` with kill-on-timeout, real clock and filesystem.
 *
 * The mutation gate runs repository code (`deno test -A`, `cargo mutants`'s
 * build scripts and tests) after the agent has written tests, so a child never
 * inherits the worker's environment: it gets
 * {@link buildUntrustedCommandEnv}'s allowlist with `clearEnv`, the same
 * control every other repository-controlled spawn uses (Issue #572). The
 * credentials the repository declared come in as `opts.env` and are applied as
 * `overrides`, as the quality gate does (Issues #573, #574).
 */
export function defaultMutationRunnerSeams(
  /**
   * Environment the allowlist is applied to, and where the temporary directory
   * is resolved from (TMPDIR, WORK_DIR, HOME); tests only. Default: the
   * worker's.
   */
  envSource?: Record<string, string>,
  /** Milliseconds between SIGTERM at the budget and SIGKILL; tests only. */
  killGraceMs: number = DEFAULT_KILL_GRACE_MS,
  /**
   * In-flight disk watch. Production leaves this unset and uses the armed
   * gate; tests pass a park function and a short poll.
   */
  options?: {
    diskPollMs?: number;
    park?: (cwd: string) => Promise<string | null>;
    trimRefused?: boolean;
    cargoRoot?: string;
  },
): MutationRunnerSeams {
  const lookup = (name: string) =>
    envSource === undefined ? Deno.env.get(name) : envSource[name];
  return {
    async runProcess(cmd, args, opts) {
      const trimRefused = options?.trimRefused !== undefined
        ? options.trimRefused
        : (cmd === "cargo" || cmd === "deno") &&
          workVolumeTrimRefusedForLaunch();
      const childEnv = mutationChildEnv(cmd, opts.cwd, {
        ...(envSource === undefined ? {} : { source: envSource }),
        ...(opts.env === undefined ? {} : { overrides: opts.env }),
        trimRefused,
        ...(options?.cargoRoot === undefined
          ? {}
          : { root: options.cargoRoot }),
      });
      // The pure env names the directory; this makes it usable by both
      // accounts, and drops the relocation if the root cannot be created.
      if (childEnv["CARGO_TARGET_DIR"] !== undefined) {
        const provisioned = buildCacheEnvForCheckout(opts.cwd, {
          trimRefused: true,
          ...(envSource === undefined ? {} : { source: envSource }),
          ...(options?.cargoRoot === undefined
            ? {}
            : { root: options.cargoRoot }),
        });
        if (provisioned["CARGO_TARGET_DIR"] === undefined) {
          delete childEnv["CARGO_TARGET_DIR"];
        }
      }
      // Aborted with the SIGKILL fallbacks below, so the spawn also carries
      // an explicit signal (Issue #4248).
      const hardStop = new AbortController();
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(cmd, {
          args,
          cwd: opts.cwd,
          env: childEnv,
          clearEnv: true,
          signal: hardStop.signal,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return {
            code: 127,
            stdout: "",
            stderr: `command not found: ${cmd}`,
            timedOut: false,
          };
        }
        throw err;
      }
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // SIGTERM first: cargo-mutants catches it, stops its cargo process
      // groups and removes its scratch copy of the tree, none of which
      // SIGKILL lets it do. SIGKILL follows only if it has not exited.
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch { /* already exited */ }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch { /* already exited */ }
          hardStop.abort();
        }, killGraceMs);
      }, Math.max(1, opts.timeoutMs));
      // A cargo that started above the floor can still fill the host
      // (Issue #4360). Ask again while it runs, and stop it as a host fault
      // rather than letting it write until the filesystem goes read-only.
      // Absent unless production armed the gate or a test injected a park,
      // so a short test command does not grow a timer.
      let diskPark: string | undefined;
      let diskSettled = false;
      let diskKillTimer: ReturnType<typeof setTimeout> | undefined;
      const watchDisk = options?.park !== undefined ||
        inFlightHostDiskGateEnabled();
      const diskTimer = watchDisk
        ? setInterval(() => {
          if (diskSettled || diskPark) return;
          const ask = options?.park ?? parkRunningBuild;
          void ask(opts.cwd).then((reason) => {
            if (diskSettled || !reason || diskPark) return;
            diskPark = reason;
            try {
              child.kill("SIGTERM");
            } catch { /* already exited */ }
            diskKillTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch { /* already exited */ }
              hardStop.abort();
            }, killGraceMs);
          });
        }, options?.diskPollMs ?? HOST_DISK_POLL_MS)
        : undefined;
      try {
        const out = await child.output();
        diskSettled = true;
        if (diskPark) throw new Error(diskPark);
        const dec = new TextDecoder();
        return {
          code: out.code,
          stdout: dec.decode(out.stdout),
          stderr: dec.decode(out.stderr),
          timedOut,
        };
      } finally {
        diskSettled = true;
        if (diskTimer !== undefined) clearInterval(diskTimer);
        if (diskKillTimer !== undefined) clearTimeout(diskKillTimer);
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
      }
    },
    now: () => Date.now(),
    readTextFile: (path) => Deno.readTextFile(path),
    async writeTextFile(path, data) {
      const slash = path.lastIndexOf("/");
      if (slash > 0) {
        await Deno.mkdir(path.slice(0, slash), { recursive: true });
      }
      await Deno.writeTextFile(path, data);
    },
    async exists(path) {
      try {
        await Deno.stat(path);
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      }
    },
    realPath: (path) => Deno.realPath(path),
    async removeDir(path) {
      try {
        await Deno.remove(path, { recursive: true });
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    },
    makeTempDir: () => makeMutationTempDir(lookup),
    listTestFiles: (repoPath) => listDenoTestFiles(repoPath),
    snapshotTree: (repoPath) => snapshotTree(repoPath),
    restoreTree: (repoPath, before) => restoreTree(repoPath, before),
  };
}
