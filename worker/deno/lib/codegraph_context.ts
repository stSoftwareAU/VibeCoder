/**
 * CodeGraph repo-context runner — index step, MCP entry, prompt line and
 * `.codegraph/` persistence (Issue #2155, part of #2145).
 *
 * On a host whose `.config.json` sets `codegraph_context.enabled`, each run
 * builds or refreshes a [CodeGraph](https://github.com/colbymchenry/codegraph)
 * index of the checkout and hands the agent the `codegraph` MCP server so it
 * can query that index instead of grepping files. This module is the one place
 * that does it:
 *
 *  1. resolve the clone's `info/exclude` and append `/.codegraph/` to it, so
 *     the index survives the next run's `git reset --hard` + `git clean -fd`;
 *  2. `codegraph init --yes` when `.codegraph/` is absent, else
 *     `codegraph sync` — with `CODEGRAPH_NO_DAEMON=1` and a 300 s limit,
 *     timed into `indexSeconds`;
 *  3. `codegraph status --json` for the node and relationship counts the run
 *     stats report.
 *
 * Nothing here wires the result into a run: {@link codegraphMcpServer} and
 * {@link CODEGRAPH_PROMPT_LINE} are the two surfaces the wiring consumes, and
 * {@link countCodegraphQueries} reads the per-run tool tally the wiring
 * collects.
 *
 * ## The index is an accelerator, so nothing here fails a run
 *
 * Every failure mode — a non-zero exit, a timeout, a missing binary, and
 * counts that cannot be read — logs exactly one
 * `[CODEGRAPH_UNAVAILABLE] <reason>` line at `warn`, returns
 * `status: "failed"` with whatever figures were gathered, and never throws or
 * rejects. `failed` is a recorded outcome rather than a silently clean run:
 * `ok` therefore always carries both counts, never an index this module could
 * not actually read.
 *
 * ## Why `info/exclude` and not `.gitignore`
 *
 * `checkout_update.ts` runs `git reset --hard` then `git clean -fd` on every
 * run, which reverts the uncommitted `.gitignore` the enforcer writes and then
 * deletes an untracked, unignored `.codegraph/` — the same reason Graft's
 * runner (#2099) writes the exclude file. The exclude file is per-clone,
 * survives reset/clean, and can never be staged. `/.codegraph/` is also added
 * to `REQUIRED_GITIGNORE_PATTERNS` (`gitignore_enforcer.ts`) so the index can
 * never be committed on a repo whose own `.gitignore` re-allows dot entries.
 *
 * ## `.codegraph/` layout, and the scoped ignored clean
 *
 * CodeGraph writes a single directory at the checkout root:
 *
 * ```text
 * .codegraph/
 * ├── codegraph.db      ← the SQLite index (plus its -wal sidecar)
 * ├── writer.pid        ← the live-writer lock of `serve --mcp`
 * └── ui/trails/        ← saved UI walks (only when `codegraph ui` is used)
 * ```
 *
 * That matters because `ignored_path_clean.ts` erases
 * `EXECUTABLE_IGNORED_DIRS` (`node_modules`, `build`, `dist`, `out`,
 * `target`, `vendor`, …) **at any depth** on every run, and an ignored path is
 * exactly what that control is scoped to. No component of the layout above is
 * named in that list, so `.codegraph/` is kept rather than erased;
 * {@link CODEGRAPH_LAYOUT_DIRS} pins the invariant and a test asserts it.
 *
 * ## Where the figures come from
 *
 * `codegraph init` and `codegraph sync` render progress through `@clack/prompts`
 * and report only what *changed* (`sync` prints the nodes it updated), so
 * neither output carries the index totals, and `.codegraph/` holds a SQLite
 * database rather than a stats file. The machine-readable source is
 * `codegraph status --json`, whose `nodeCount` and `edgeCount` fields are the
 * totals reported here. Read from the CLI source at tag `v1.6.0`
 * (`src/bin/codegraph.ts`, the `status` command) — the pinned version
 * `container/tools.json` installs — because the binary is not on the host this
 * module was written on.
 *
 * `init` is invoked with `--yes` for the same reason every other worker
 * subprocess is non-interactive: without it `init` prompts (the watch-fallback
 * offer, and the ignored-child-repo offer on an empty graph), and an unattended
 * run has nobody to answer.
 *
 * ## Injectable seams
 *
 * `run` defaults to `runWithTimeout` and `git` to `runGitCommand` — the two
 * spawn chokepoints — and both are injected in tests, so no test here spawns
 * anything.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type GitCommandOptions,
  type GitCommandOutput,
  runGitCommand,
} from "./git_timeout.ts";
import { runWithTimeout, type SubprocessResult } from "./subprocess_timeout.ts";
import { appendNoFollow, readTextFileNoFollow } from "./file_utils.ts";
import { GEMINI_PROVIDER_ID } from "./agent_provider.ts";

/** Milliseconds the index step is given before it is killed (300 s). */
export const CODEGRAPH_INDEX_TIMEOUT_MS = 300_000;

/**
 * Milliseconds `codegraph status --json` is given.
 *
 * The status read opens the index and prints its totals — a fraction of a
 * second's work — so it gets its own short limit rather than the index step's
 * 300 s, which would otherwise be the ceiling on a wedged read.
 */
export const CODEGRAPH_STATUS_TIMEOUT_MS = 30_000;

/** The line written to the clone's `info/exclude`. */
export const CODEGRAPH_EXCLUDE_PATTERN = "/.codegraph/";

/** The index directory CodeGraph writes at the checkout root. */
export const CODEGRAPH_INDEX_DIR = ".codegraph";

/** Marker opening the single warn line every failure mode logs. */
export const CODEGRAPH_UNAVAILABLE_MARKER = "[CODEGRAPH_UNAVAILABLE]";

/** The MCP tool CodeGraph's server exposes. */
export const CODEGRAPH_EXPLORE_TOOL = "codegraph_explore";

/**
 * The one prompt line an enabled run gains, telling the agent to query the
 * index before it searches files.
 *
 * Exactly one line, with no trailing newline, so a caller interpolates it into
 * a list or a paragraph without reflowing anything around it.
 */
export const CODEGRAPH_PROMPT_LINE =
  `This repository has a pre-built CodeGraph index: before grepping or reading files to find code, ask the \`${CODEGRAPH_EXPLORE_TOOL}\` MCP tool — it returns the relevant symbols' source and the call paths between them in one call.`;

/**
 * Directory names appearing in the `.codegraph/` layout.
 *
 * Pinned so a test can assert none of them is in `EXECUTABLE_IGNORED_DIRS`,
 * whose scoped `git clean` matches those names at any depth.
 */
export const CODEGRAPH_LAYOUT_DIRS: readonly string[] = [
  CODEGRAPH_INDEX_DIR,
  "ui",
  "trails",
];

/**
 * Environment handed to every `codegraph` invocation.
 *
 * `CODEGRAPH_NO_DAEMON=1` disables the file watcher and the shared background
 * server: the worker's checkout is a sandboxed, short-lived working copy, and
 * a daemon outliving the run would keep writing to an index the next
 * `git clean` may be about to replace.
 */
export const CODEGRAPH_ENV: Record<string, string> = {
  CODEGRAPH_NO_DAEMON: "1",
};

/** Mode for the exclude file — git's own is world-readable. */
const EXCLUDE_FILE_MODE = 0o644;

/** Longest failure detail carried into the `[CODEGRAPH_UNAVAILABLE]` line. */
const MAX_REASON_DETAIL_CHARS = 300;

/** Outcome of one CodeGraph context preparation. */
export type CodegraphStatus = "ok" | "failed" | "off" | "unsupported";

/** Subprocess options this module needs — the injectable half of the seam. */
export interface CodegraphRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** The subprocess seam. Defaults to `runWithTimeout`. */
export type CodegraphRunner = (
  executable: string,
  args: string[],
  options?: CodegraphRunOptions,
) => Promise<Result<SubprocessResult>>;

/** The git seam. Defaults to `runGitCommand`. */
export type CodegraphGitRunner = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<Result<GitCommandOutput>>;

/**
 * The logging surface this module needs.
 *
 * Structurally satisfied by the worker's `Logger`, so a caller passes its own
 * straight through; tests pass a one-method stub.
 */
export interface CodegraphContextLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** What one run's CodeGraph step produced. */
export interface CodegraphContextResult {
  /**
   * `off` when the host switch is off, `unsupported` on a Gemini-routed run,
   * `ok` on an index with readable figures, else `failed`.
   */
  status: CodegraphStatus;
  /** Whether the host switch was on for this run. */
  enabled: boolean;
  /** Wall-clock seconds the index step took, when it was started. */
  indexSeconds?: number;
  /** Nodes in the index, from `codegraph status --json`. */
  nodeCount?: number;
  /** Relationships (edges) in the index, from `codegraph status --json`. */
  relationshipCount?: number;
  /**
   * `codegraph_explore` calls the agent made — set by the wiring after the
   * run, from the tool tally, via {@link countCodegraphQueries}.
   */
  queries?: number;
}

/** Options for {@link prepareCodegraphContext}. */
export interface PrepareCodegraphContextOptions {
  /** Absolute path of the repository checkout. */
  repoDir: string;
  /** The host switch — `false` short-circuits before anything is spawned. */
  enabled: boolean;
  /** Provider this run was routed to; Gemini has no MCP transport. */
  providerId: string;
  /** Sink for the single `[CODEGRAPH_UNAVAILABLE]` line. */
  logger: CodegraphContextLogger;
  /** Subprocess seam; defaults to `runWithTimeout`. */
  run?: CodegraphRunner;
  /** Git seam; defaults to `runGitCommand`. */
  git?: CodegraphGitRunner;
  /** Index limit in ms (default: {@link CODEGRAPH_INDEX_TIMEOUT_MS}). */
  indexTimeoutMs?: number;
}

/** Node and relationship counts read from `codegraph status --json`. */
interface IndexFigures {
  nodeCount: number;
  relationshipCount: number;
}

/**
 * Build or refresh the index and report its figures.
 *
 * Never throws and never rejects: every fault is reported as
 * `status: "failed"` with one `[CODEGRAPH_UNAVAILABLE]` line, because the
 * index is an accelerator and losing it must not fail the run.
 *
 * @param options - Checkout, host switch, provider, seams and the index limit
 * @returns The outcome, with whatever figures were gathered
 */
export async function prepareCodegraphContext(
  options: PrepareCodegraphContextOptions,
): Promise<CodegraphContextResult> {
  const {
    repoDir,
    enabled,
    providerId,
    logger,
    run = runWithTimeout,
    git = runGitCommand,
    indexTimeoutMs = CODEGRAPH_INDEX_TIMEOUT_MS,
  } = options;

  if (!enabled) return { status: "off", enabled: false };

  // Gemini has no MCP transport, so an index the agent cannot reach is 300 s
  // spent for nothing. Reported rather than skipped silently: `unsupported`
  // is what excludes the run from the trial figures.
  if (providerId === GEMINI_PROVIDER_ID) {
    return { status: "unsupported", enabled: true };
  }

  const fail = (
    reason: string,
    figures: Omit<CodegraphContextResult, "status" | "enabled"> = {},
  ): CodegraphContextResult => {
    logger.warn(`${CODEGRAPH_UNAVAILABLE_MARKER} ${reason}`);
    return { status: "failed", enabled: true, ...figures };
  };

  // 1. Keep `.codegraph/` across runs. Done before the index step, because an
  //    index the next `git clean` deletes is 300 s spent for nothing.
  const excluded = await ensureCodegraphExcluded(repoDir, git);
  if (!excluded.ok) return fail(excluded.error.message);

  // 2. Build or refresh, timed. `init` both creates `.codegraph/` and builds
  //    the graph; `sync` is the incremental update for an index already there.
  const present = await indexDirectoryPresent(repoDir);
  const indexArgs = present ? ["sync"] : ["init", "--yes"];
  const startedAt = performance.now();
  const indexed = await runCodegraph(run, indexArgs, repoDir, indexTimeoutMs);
  const indexSeconds = elapsedSeconds(startedAt);
  if (!indexed.ok) {
    return fail(`codegraph ${indexArgs[0]} ${indexed.reason}`, {
      indexSeconds,
    });
  }

  // 3. Read the figures. Unreadable counts are a failure, not a zero: an index
  //    of zero nodes and an index this module cannot read look identical in
  //    the run stats, and "no failure marker" must never read as success.
  const figures = await readIndexFigures(run, repoDir);
  if (!figures.ok) return fail(figures.error.message, { indexSeconds });

  return {
    status: "ok",
    enabled: true,
    indexSeconds,
    ...figures.value,
  };
}

/**
 * The `codegraph` entry for the per-run `mcpServers` configuration.
 *
 * Only `command`, `args` and `env` are named, because those are the keys
 * `buildCodexMcpConfigArgs` (`codex_executor.ts`) translates into Codex `-c`
 * overrides — it ignores `cwd` — so one entry serves Claude and Codex alike.
 * The server inherits the agent's working directory, which is the checkout it
 * must resolve the index from.
 *
 * @returns The server specification, fresh on each call so a caller may mutate it
 */
export function codegraphMcpServer(): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: "codegraph",
    args: ["serve", "--mcp"],
    env: { ...CODEGRAPH_ENV },
  };
}

/**
 * Count the `codegraph_explore` calls in a run's tool tally.
 *
 * Claude names an MCP tool `mcp__<server>__<tool>` while the bare tool name is
 * what a CLI-shaped tally records, so both spellings are summed. A tally that
 * ran other tools and no CodeGraph query counts `0` — a real figure, and not
 * the same thing as a run with no tally at all.
 *
 * @param counts - Per-tool call counts for the run, or `undefined` when the
 *   provider's stream exposed none
 * @returns The query count, or `undefined` when there is no tally
 */
export function countCodegraphQueries(
  counts?: Record<string, number>,
): number | undefined {
  if (!counts) return undefined;
  let total = 0;
  for (const [tool, count] of Object.entries(counts)) {
    if (
      tool !== CODEGRAPH_EXPLORE_TOOL &&
      !tool.endsWith(`__${CODEGRAPH_EXPLORE_TOOL}`)
    ) {
      continue;
    }
    if (typeof count === "number" && Number.isFinite(count)) total += count;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

/** What one `codegraph` subcommand did: its stdout, or why it did not run. */
type CodegraphRunOutcome =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

/**
 * Run one `codegraph` subcommand.
 *
 * A spawn error, a timeout and a non-zero exit are all outcomes here, never
 * exceptions — this is the module's fail-loud-but-never-throw boundary.
 */
async function runCodegraph(
  run: CodegraphRunner,
  args: string[],
  repoDir: string,
  timeoutMs: number,
): Promise<CodegraphRunOutcome> {
  let result: Result<SubprocessResult>;
  try {
    result = await run("codegraph", args, {
      cwd: repoDir,
      env: CODEGRAPH_ENV,
      timeoutMs,
    });
  } catch (err) {
    // A seam that throws is still a spawn failure, not a run failure.
    return {
      ok: false,
      reason: `could not be started: ${detail(message(err))}`,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: `could not be started: ${detail(result.error.message)} ` +
        `(is the codegraph binary installed on this host?)`,
    };
  }
  const output = result.value;
  if (output.timedOut) {
    return { ok: false, reason: `timed out after ${timeoutMs}ms` };
  }
  if (!output.success || output.code !== 0) {
    return {
      ok: false,
      reason: `exited ${output.code}: ${detail(output.stderr)}`,
    };
  }
  return { ok: true, stdout: output.stdout };
}

// ---------------------------------------------------------------------------
// `.codegraph/` persistence
// ---------------------------------------------------------------------------

/**
 * Whether the checkout already carries an index directory.
 *
 * `lstat`, not `stat`: a symlink planted at `.codegraph` in the
 * agent-writable clone is not a directory this module will treat as an index,
 * so the run takes the `init` branch, which is idempotent.
 */
async function indexDirectoryPresent(repoDir: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(`${repoDir}/${CODEGRAPH_INDEX_DIR}`);
    return info.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Append `/.codegraph/` to the clone's `info/exclude`, once.
 *
 * The path comes from `git rev-parse --git-path info/exclude` rather than a
 * hardcoded `.git/info/exclude`, because a lane worktree's `.git` is a *file*
 * pointing at the common directory — only git knows where the exclude file
 * actually lives.
 */
async function ensureCodegraphExcluded(
  repoDir: string,
  git: CodegraphGitRunner,
): Promise<Result<void>> {
  let resolved: Result<GitCommandOutput>;
  try {
    resolved = await git(["rev-parse", "--git-path", "info/exclude"], {
      cwd: repoDir,
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `could not resolve info/exclude in ${repoDir}: ${detail(message(err))}`,
      ),
    };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      error: new Error(
        `could not resolve info/exclude in ${repoDir}: ${
          detail(resolved.error.message)
        }`,
      ),
    };
  }
  if (resolved.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `could not resolve info/exclude in ${repoDir} (git exited ${resolved.value.code}): ${
          detail(resolved.value.stderr)
        }`,
      ),
    };
  }

  const answer = resolved.value.stdout.trim();
  if (answer === "") {
    return {
      ok: false,
      error: new Error(
        `could not resolve info/exclude in ${repoDir}: git printed nothing`,
      ),
    };
  }
  // `--git-path` answers relative to the working directory it ran in.
  const excludePath = answer.startsWith("/") ? answer : `${repoDir}/${answer}`;

  // Link-free read: the clone is agent-writable and persists between runs, so
  // a planted symlink must be refused rather than followed (Issue #1234).
  const read = await readTextFileNoFollow(excludePath);
  if (!read.ok) {
    return {
      ok: false,
      error: new Error(
        `could not read ${excludePath}: ${detail(read.error.message)}`,
      ),
    };
  }
  const existing = read.value ?? "";
  const present = existing
    .split("\n")
    .some((line) => line.trim() === CODEGRAPH_EXCLUDE_PATTERN);
  if (present) return { ok: true, value: undefined };

  // A fresh clone may not carry `info/` at all.
  const parent = excludePath.slice(0, excludePath.lastIndexOf("/"));
  if (parent !== "") {
    try {
      await Deno.mkdir(parent, { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) {
        return {
          ok: false,
          error: new Error(
            `could not create ${parent}: ${detail(message(err))}`,
          ),
        };
      }
    }
  }

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const appended = await appendNoFollow({
    targetFile: excludePath,
    content: `${needsNewline ? "\n" : ""}${CODEGRAPH_EXCLUDE_PATTERN}\n`,
    mode: EXCLUDE_FILE_MODE,
  });
  if (!appended.ok) {
    return {
      ok: false,
      error: new Error(
        `could not add ${CODEGRAPH_EXCLUDE_PATTERN} to ${excludePath}: ${
          detail(appended.error.message)
        }`,
      ),
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Index figures
// ---------------------------------------------------------------------------

/**
 * Read the node and relationship counts from `codegraph status --json`.
 *
 * An unreadable, unparseable or count-less answer is an error, not a zero —
 * see the module docstring for why this is the source the figures come from.
 */
async function readIndexFigures(
  run: CodegraphRunner,
  repoDir: string,
): Promise<Result<IndexFigures>> {
  const status = await runCodegraph(
    run,
    ["status", "--json"],
    repoDir,
    CODEGRAPH_STATUS_TIMEOUT_MS,
  );
  if (!status.ok) {
    return {
      ok: false,
      error: new Error(`codegraph status ${status.reason}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `codegraph status --json could not be parsed: ${detail(message(err))}`,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error("codegraph status --json is not a JSON object"),
    };
  }

  const record = parsed as Record<string, unknown>;
  const nodeCount = countOf(record.nodeCount);
  const relationshipCount = countOf(record.edgeCount);
  if (nodeCount === null || relationshipCount === null) {
    return {
      ok: false,
      error: new Error(
        `codegraph status --json carries no readable "nodeCount" and ` +
          `"edgeCount" (is the index initialised?)`,
      ),
    };
  }
  return { ok: true, value: { nodeCount, relationshipCount } };
}

/** A non-negative whole count, or `null` when the field is not one. */
function countOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || !Number.isInteger(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wall-clock seconds since `startedAt`, to millisecond precision. */
function elapsedSeconds(startedAt: number): number {
  return Math.round(performance.now() - startedAt) / 1000;
}

/** Collapse a diagnostic to one bounded line, so the warn line stays readable. */
function detail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no output)";
  return flat.length > MAX_REASON_DETAIL_CHARS
    ? `${flat.slice(0, MAX_REASON_DETAIL_CHARS - 1)}…`
    : flat;
}

/** The message of an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
