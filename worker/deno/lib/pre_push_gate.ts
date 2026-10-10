/**
 * Pre-push gate for the coding agent's own `git push` calls (Issue #3394).
 *
 * The per-repo pre-flight gate (Issue #3577, `pre_flight_gate.ts`) runs at the
 * worker's commit chokepoint. An agent that commits and pushes by itself never
 * passes through that chokepoint, so a doc-only push could reach the remote
 * without any check at all. This module is the logic behind a git `pre-push`
 * hook that closes that gap. It does two things, in order:
 *
 * 1. Always runs a fast format/lint check over just the files the push
 *    introduces (`deno fmt --check`, `deno lint`, `cargo fmt --check`,
 *    `markdownlint-cli2`), whatever the repo's own pre-flight list says and
 *    whatever the run budget — these checks are cheap and are never skipped.
 * 2. Then runs the repo's configured pre-flight commands.
 *
 * Every uncertainty fails closed: unparseable hook input, a failing `git`
 * call, an unquotable path, or a configured-but-missing markdownlint binary
 * is an `Err`, never a pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { outermostConfigDirs } from "./repo_formatters.ts";
import { canRunBinary } from "./markdownlint_check.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import { type PreFlightRunner, runPreFlightGate } from "./pre_flight_gate.ts";

/** One ref line from git's pre-push hook stdin. */
export interface PrePushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/**
 * Parse git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`
 * per line. Blank lines are ignored; anything malformed is an error (fail
 * closed). Deletions (all-zero local sha) push no content and are dropped.
 */
export function parsePrePushRefs(stdin: string): Result<PrePushRef[], string> {
  const refs: PrePushRef[] = [];
  for (const rawLine of stdin.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      return {
        ok: false,
        error: `malformed pre-push line (expected 4 fields): ${line}`,
      };
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields as [
      string,
      string,
      string,
      string,
    ];
    if (!SHA_PATTERN.test(localSha) || !SHA_PATTERN.test(remoteSha)) {
      return { ok: false, error: `malformed sha in pre-push line: ${line}` };
    }
    if (/^0+$/.test(localSha)) continue;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return { ok: true, value: refs };
}

/** Runs `git <args>` in `cwd`. Injectable for tests. */
export type PrePushGit = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Default {@link PrePushGit}: routes through the git chokepoint. A `Result`
 * error or a timeout comes back as a non-zero code with the message in
 * stderr, so the gate fails closed.
 */
export const defaultPrePushGit: PrePushGit = async (args, cwd) => {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  const { code, stdout, stderr } = result.value;
  if (code === TIMEOUT_EXIT_CODE) {
    return {
      code,
      stdout,
      stderr: stderr || `git ${args[0] ?? ""} timed out`,
    };
  }
  return { code, stdout, stderr };
};

/**
 * List the files the push introduces: those touched by commits reachable from
 * the pushed tips but from no remote-tracking ref, minus deletions, and only
 * those that still exist as files in the working tree. Sorted and unique.
 */
export async function listPushedFiles(
  refs: PrePushRef[],
  cwd: string,
  git: PrePushGit,
): Promise<Result<string[], string>> {
  if (refs.length === 0) return { ok: true, value: [] };
  const result = await git(
    [
      "log",
      "--no-merges",
      "--name-only",
      "-z",
      "--format=",
      "--diff-filter=d",
      ...refs.map((r) => r.localSha),
      "--not",
      "--remotes",
    ],
    cwd,
  );
  if (result.code !== 0) {
    return {
      ok: false,
      error: `git log failed (exit ${result.code}): ${result.stderr.trim()}`,
    };
  }
  // Observed shape: names separated by NUL, no commit separators with
  // `--format=`; stripping stray newlines keeps this robust regardless.
  const names = new Set<string>();
  for (const part of result.stdout.split("\0")) {
    const name = part.replace(/^\n+|\n+$/g, "");
    if (name !== "") names.add(name);
  }
  const existing: string[] = [];
  for (const name of names) {
    try {
      const stat = await Deno.lstat(`${cwd}/${name}`);
      if (stat.isFile) existing.push(name);
    } catch {
      // Not in the working tree (removed since, or a submodule): nothing to check.
    }
  }
  return { ok: true, value: existing.sort() };
}

/** One command to run for the changed files. */
export interface ChangedFileCheck {
  label: string;
  /** Absolute working directory. */
  cwd: string;
  command: string;
}

// SIMPLE-ON-PURPOSE: a fixed extension allow-list mirroring what `deno fmt`
// and `deno lint` handle by default. Ceiling: a repo that configures extra
// file types in deno.json is not checked for them here (they still reach
// the repo's own pre-flight commands). Upgrade when a repo needs more types.
const DENO_FORMAT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".md",
  ".markdown",
];
const DENO_LINT_EXTENSIONS = DENO_FORMAT_EXTENSIONS.slice(0, 8);
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

const MARKDOWNLINT_CONFIGS = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
];

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Quote for the pre-flight tokeniser (`'…'` or `"…"` segments, no escapes).
 * Returns null when the value contains both quote kinds.
 */
function quoteForTokeniser(value: string): string | null {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}

function quoteAll(paths: string[]): Result<string, string> {
  const quoted: string[] = [];
  for (const path of paths) {
    // A leading dash would be read as an option.
    const arg = path.startsWith("-") ? `./${path}` : path;
    const q = quoteForTokeniser(arg);
    if (q === null) {
      return {
        ok: false,
        error: `cannot safely quote path ${JSON.stringify(path)} ` +
          `(it contains both ' and ") — the push is blocked, not waved through`,
      };
    }
    quoted.push(q);
  }
  return { ok: true, value: quoted.join(" ") };
}

/** Plan the always-on changed-file format/lint commands. */
export function planChangedFileChecks(
  changed: string[],
  tracked: string[],
  opts: { repoRoot: string; markdownlintBinary: string | null },
): Result<ChangedFileCheck[], string> {
  const checks: ChangedFileCheck[] = [];
  const dirCwd = (dir: string) =>
    dir === "." ? opts.repoRoot : `${opts.repoRoot}/${dir}`;

  for (
    const root of outermostConfigDirs(tracked, ["deno.json", "deno.jsonc"])
  ) {
    const under = root === "."
      ? changed
      : changed.filter((p) => p.startsWith(`${root}/`));
    const rel = root === "."
      ? under
      : under.map((p) => p.slice(root.length + 1));
    const groups: Array<[string, string[], readonly string[], string]> = [
      [
        "deno fmt",
        rel,
        DENO_FORMAT_EXTENSIONS,
        "deno fmt --check --permit-no-files",
      ],
      ["deno lint", rel, DENO_LINT_EXTENSIONS, "deno lint --permit-no-files"],
    ];
    for (const [label, files, extensions, base] of groups) {
      const matching = files.filter((f) => hasExtension(f, extensions));
      if (matching.length === 0) continue;
      const quoted = quoteAll(matching);
      if (!quoted.ok) return quoted;
      checks.push({
        label: `${label} (${root})`,
        cwd: dirCwd(root),
        command: `${base} ${quoted.value}`,
      });
    }
  }

  for (const root of outermostConfigDirs(tracked, ["Cargo.toml"])) {
    const touched = changed.some((p) =>
      hasExtension(p, [".rs"]) && (root === "." || p.startsWith(`${root}/`))
    );
    if (!touched) continue;
    checks.push({
      label: `cargo fmt (${root})`,
      cwd: dirCwd(root),
      command: "cargo fmt --all --check",
    });
  }

  const markdown = changed.filter((p) => hasExtension(p, MARKDOWN_EXTENSIONS));
  const configured = MARKDOWNLINT_CONFIGS.some((name) =>
    tracked.includes(name)
  );
  if (configured && markdown.length > 0) {
    if (opts.markdownlintBinary === null) {
      return {
        ok: false,
        error: "markdownlint is configured for this repository but " +
          "markdownlint-cli2 could not be found — the push is blocked, " +
          "not waved through",
      };
    }
    const binary = quoteForTokeniser(opts.markdownlintBinary);
    const quoted = quoteAll(markdown);
    if (binary === null) {
      return {
        ok: false,
        error: `cannot safely quote the markdownlint path ${
          JSON.stringify(opts.markdownlintBinary)
        }`,
      };
    }
    if (!quoted.ok) return quoted;
    checks.push({
      label: "markdownlint",
      cwd: opts.repoRoot,
      command: `${binary} ${quoted.value}`,
    });
  }

  return { ok: true, value: checks };
}

/**
 * Find a runnable `markdownlint-cli2`: the repo's own install first, then the
 * first working one on `PATH`; null when neither runs.
 */
export async function findMarkdownlintBinary(
  repoRoot: string,
  pathValue: string,
): Promise<string | null> {
  const local = `${repoRoot}/node_modules/.bin/markdownlint-cli2`;
  try {
    if ((await Deno.stat(local)).isFile && await canRunBinary(local)) {
      return local;
    }
  } catch {
    // Not installed locally; fall through to PATH.
  }
  for (const dir of pathValue.split(":")) {
    if (dir === "") continue;
    const candidate = `${dir}/markdownlint-cli2`;
    try {
      if (
        (await Deno.stat(candidate)).isFile && await canRunBinary(candidate)
      ) {
        return candidate;
      }
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/**
 * Run the pre-push gate: the always-on changed-file checks first, then the
 * repo's pre-flight commands. `checksRun` lists the changed-file commands run.
 * The changed-file checks run whatever the run
 * budget — they are fast and never skipped. Any git, parse or planning error
 * is an `Err`, never a pass.
 */
export async function runPrePushGate(opts: {
  cwd: string;
  stdin: string;
  preFlightCommands: readonly string[];
  timeoutSeconds?: number;
  runner?: PreFlightRunner;
  git?: PrePushGit;
  findMarkdownlint?: (repoRoot: string) => Promise<string | null>;
}): Promise<Result<{ checksRun: string[] }, Error>> {
  const git = opts.git ?? defaultPrePushGit;
  const fail = (message: string): Result<never, Error> => ({
    ok: false,
    error: new Error(message),
  });

  const refs = parsePrePushRefs(opts.stdin);
  if (!refs.ok) return fail(refs.error);

  const changed = await listPushedFiles(refs.value, opts.cwd, git);
  if (!changed.ok) return fail(changed.error);

  const lsFiles = await git(["ls-files", "-z"], opts.cwd);
  if (lsFiles.code !== 0) {
    return fail(
      `git ls-files failed (exit ${lsFiles.code}): ${lsFiles.stderr.trim()}`,
    );
  }
  const tracked = lsFiles.stdout.split("\0").filter((p) => p !== "");

  const needsMarkdownlint = changed.value.some((p) =>
    hasExtension(p, MARKDOWN_EXTENSIONS)
  );
  let markdownlintBinary: string | null = null;
  if (needsMarkdownlint) {
    const find = opts.findMarkdownlint ??
      ((root: string) =>
        findMarkdownlintBinary(root, Deno.env.get("PATH") ?? ""));
    markdownlintBinary = await find(opts.cwd);
  }

  const plan = planChangedFileChecks(changed.value, tracked, {
    repoRoot: opts.cwd,
    markdownlintBinary,
  });
  if (!plan.ok) return fail(plan.error);

  const checksRun: string[] = [];
  for (const check of plan.value) {
    const result = await runPreFlightGate([check.command], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    });
    if (!result.ok) return { ok: false, error: result.error };
    checksRun.push(check.command);
  }

  const preFlight = await runPreFlightGate(opts.preFlightCommands, {
    cwd: opts.cwd,
    runner: opts.runner,
    timeoutSeconds: opts.timeoutSeconds,
  });
  if (!preFlight.ok) return { ok: false, error: preFlight.error };

  return { ok: true, value: { checksRun } };
}
