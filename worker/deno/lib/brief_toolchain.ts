/**
 * brief toolchain runner (Issue #2602, part of the #2581 brief trial).
 *
 * [git-pkgs/brief](https://github.com/git-pkgs/brief) detects a project's
 * toolchain and reports the commands that run it. The codebase map lists
 * commands only from `deno.json`, `package.json` and `quality.sh`, so a Rust
 * repository gets none; this runner asks brief for its Cargo commands.
 *
 * The boundary is deliberately narrow:
 *
 * - **Fixed argv, no shell.** brief's default local scan (`brief --json
 *   <path>`) is the only invocation. `enrich`, `outline`, remote-URL and
 *   registry scans reach the network and are never built — the path must be
 *   absolute, so brief cannot read it as a URL or `crate:name` shorthand.
 * - **Bounded.** The spawn runs under {@link runWithTimeout}.
 * - **Allowlisted output.** Only `cargo …` command strings survive, free of
 *   control and invisible characters, capped in length and count: the result
 *   is injected into the agent's prompt, so nothing else from the report is
 *   trusted through.
 * - **Never throws.** A missing binary, a non-zero exit, a timeout or
 *   unparseable output is `{status:"failed", reason}` for the caller to log.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  runWithTimeout,
  type SubprocessResult,
} from "./subprocess_timeout.ts";

/** The brief executable, resolved on `PATH` — never through a shell. */
export const BRIEF_BINARY = "brief";

/** Maximum Cargo commands kept from one report. */
export const MAX_BRIEF_COMMANDS = 20;

/** Maximum length of one kept command; a longer one is dropped, not cut. */
export const MAX_BRIEF_COMMAND_LENGTH = 200;

/** Maximum length of a failure reason, so a noisy stderr stays one short line. */
const MAX_REASON_LENGTH = 200;

/**
 * Control, format (bidi, zero-width, soft hyphen, tag characters), line/
 * paragraph separator and private-use characters — never let through to the
 * prompt.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;

/** The outcome of one brief run. */
export type BriefRunResult =
  | { status: "ok"; commands: string[]; seconds: number }
  | { status: "failed"; reason: string };

/** Runs brief against a repository checkout. Never throws. */
export type BriefRunner = (repoDir: string) => Promise<BriefRunResult>;

/** The spawn seam — {@link runWithTimeout} in production, a stub in tests. */
export type BriefSpawn = (
  executable: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<Result<SubprocessResult>>;

/** Options for {@link createBriefRunner}. */
export interface BriefRunnerOptions {
  /** Subprocess bound (default {@link DEFAULT_SUBPROCESS_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Spawn seam (default {@link runWithTimeout}). */
  spawn?: BriefSpawn;
  /** Millisecond clock for the wall-clock timing (default `performance.now`). */
  now?: () => number;
}

/**
 * The argv for brief's offline scan of `repoDir`.
 *
 * `--json` forces the machine-readable report whatever stdout is attached to.
 */
export function briefScanArgs(repoDir: string): string[] {
  return ["--json", repoDir];
}

/** Build a {@link BriefRunner}. */
export function createBriefRunner(
  options: BriefRunnerOptions = {},
): BriefRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
  const spawn = options.spawn ?? runWithTimeout;
  const now = options.now ?? (() => performance.now());

  return async (repoDir: string): Promise<BriefRunResult> => {
    // An absolute path is the only form brief resolves as a local directory:
    // anything else could be read as a URL, a registry shorthand or a flag.
    if (!repoDir.startsWith("/") || UNSAFE_CHARS.test(repoDir)) {
      return failed("brief needs an absolute repository path");
    }

    const started = now();
    let spawned: Result<SubprocessResult>;
    try {
      spawned = await spawn(BRIEF_BINARY, briefScanArgs(repoDir), {
        timeoutMs,
      });
    } catch (err) {
      return failed(`brief could not be spawned: ${message(err)}`);
    }
    const seconds = Math.round(now() - started) / 1000;

    if (!spawned.ok) {
      return failed(`brief could not be spawned: ${spawned.error.message}`);
    }
    const run = spawned.value;
    if (run.timedOut) return failed(`brief timed out after ${timeoutMs}ms`);
    if (!run.success) {
      const detail = run.stderr.split("\n")[0] ?? "";
      return failed(
        `brief exited with code ${run.code}${detail ? `: ${detail}` : ""}`,
      );
    }

    const commands = extractCargoCommands(run.stdout);
    if (!commands.ok) return failed(commands.error.message);
    return { status: "ok", commands: commands.value, seconds };
  };
}

/**
 * Pull the allowlisted Cargo commands out of a brief JSON report.
 *
 * Reads every detection's `command.run` and `command.alternatives`
 * (languages, package managers and each tool category) plus `scripts[].run`.
 * Anything that is not a string is skipped; a report that is not a JSON object
 * is an error.
 */
export function extractCargoCommands(stdout: string): Result<string[]> {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { ok: false, error: new Error("brief output was not valid JSON") };
  }
  if (!isRecord(report)) {
    return {
      ok: false,
      error: new Error("brief output was not a JSON report object"),
    };
  }

  const detections = [
    ...asArray(report.languages),
    ...asArray(report.package_managers),
    ...(isRecord(report.tools)
      ? Object.values(report.tools).flatMap(asArray)
      : []),
  ];

  const candidates: unknown[] = [];
  for (const detection of detections) {
    if (!isRecord(detection) || !isRecord(detection.command)) continue;
    candidates.push(detection.command.run);
    candidates.push(...asArray(detection.command.alternatives));
  }
  for (const script of asArray(report.scripts)) {
    if (isRecord(script)) candidates.push(script.run);
  }

  return { ok: true, value: sanitiseCargoCommands(candidates) };
}

/**
 * Apply the allowlist: `cargo ` prefix, no unsafe characters, no backtick
 * (it would break the Markdown code span), length and count caps, de-duplicated
 * in first-seen order.
 */
export function sanitiseCargoCommands(candidates: unknown[]): string[] {
  const kept: string[] = [];
  for (const candidate of candidates) {
    if (kept.length >= MAX_BRIEF_COMMANDS) break;
    if (typeof candidate !== "string" || UNSAFE_CHARS.test(candidate)) {
      continue;
    }
    const command = candidate.trim();
    if (
      !command.startsWith("cargo ") ||
      command.length > MAX_BRIEF_COMMAND_LENGTH ||
      command.includes("`") ||
      kept.includes(command)
    ) continue;
    kept.push(command);
  }
  return kept;
}

function failed(reason: string): BriefRunResult {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return {
    status: "failed",
    reason: oneLine.length > MAX_REASON_LENGTH
      ? `${oneLine.slice(0, MAX_REASON_LENGTH)}…`
      : oneLine,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
