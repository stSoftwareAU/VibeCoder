/**
 * Pre-push gate: the logic behind the coding agent's git `pre-push` hook
 * (Issue #3394) and the worker's own gates over commits the agent never
 * pushed (Issue #3689).
 *
 * The per-repo pre-flight gate (`pre_flight_gate.ts`) runs at the worker's
 * commit chokepoint. An agent that commits and pushes by itself never passes
 * through that chokepoint, so a doc-only push could reach the remote without
 * any check at all. Callers of {@link runPrePushGate}:
 *
 * - the agent's `pre-push` hook (its own `git push`);
 * - `commitAndPushPending` Step 1b, via `gateUnpushedCommits`, over commits
 *   not yet on any remote (final-mile callers that pass a `preFlight` spec);
 * - the issue completion phase, via `gateUnpushedCommits` with a `baseRef`,
 *   over every non-merge commit the branch has ahead of the PR base — so
 *   content the execute phase's WIP checkpoints already pushed is checked
 *   before `gh pr create`.
 *
 * It does two things, in order:
 *
 * 1. Always runs a fast check over just the files the push introduces
 *    (`deno fmt --check`, `deno lint`, `cargo fmt --check`,
 *    `markdownlint-cli2`, `cspell` when the repo's CI runs it, plus the sweep
 *    ledger `sweptAt` ancestry check, and the Floci CloudFormation deploy test
 *    when the push changes `infra/cloudformation/` and the repo tracks its
 *    script), whatever the repo's own pre-flight list says and whatever the
 *    run budget — these checks are never skipped for budget; all but the Floci
 *    deploy test are cheap.
 * 2. Then runs the repo's configured pre-flight commands.
 *
 * Every uncertainty fails closed: unparseable hook input, a failing `git`
 * call, an unquotable path, or a configured-but-missing markdownlint or
 * cspell binary is an `Err`, never a pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { canRunBinary } from "./markdownlint_check.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import { type PreFlightRunner, runPreFlightGate } from "./pre_flight_gate.ts";
import { checkSweptAtAncestry } from "./pre_push_sweep_check.ts";
import {
  type DenoScopeConfig,
  inDenoScope,
  parseDenoScope,
} from "./deno_scope.ts";

/**
 * The gate could not read the repository state it needs: a `git log`,
 * `ls-files` or history-deepening call failed or timed out (PR #3716 review).
 * It is no verdict on the branch's content, so callers that classify a failed
 * run (the completion phase) must not blame the branch for it. The gate still
 * fails closed: it is an `Err`, never a pass.
 */
export class PrePushGateInfrastructureError extends Error {
  readonly kind = "infrastructure" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrePushGateInfrastructureError";
  }
}

/**
 * Pick the outermost directories tracked config files live in.
 *
 * A nested `a/b/Cargo.toml` under an already-kept `a/Cargo.toml` is dropped —
 * `cargo fmt --all` at `a` already reaches it via the workspace — but
 * `webx/deno.json` is never treated as nested under a kept `web`.
 *
 * @param paths - Repo-relative paths, `/`-separated (as `git ls-files` prints).
 * @param configNames - Basenames that mark a formatter's root (e.g. `Cargo.toml`).
 */
export function outermostConfigDirs(
  paths: string[],
  configNames: readonly string[],
): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const base = slash === -1 ? path : path.slice(slash + 1);
    if (!configNames.includes(base)) continue;
    const dir = slash === -1 ? "." : path.slice(0, slash);
    dirs.add(dir === "" ? "." : dir);
  }
  const sorted = [...dirs].sort();
  const kept: string[] = [];
  for (const dir of sorted) {
    const hasKeptAncestor = kept.some((k) =>
      k === "." || dir.startsWith(`${k}/`)
    );
    if (!hasKeptAncestor) kept.push(dir);
  }
  return kept;
}

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
 * List the files the push introduces: those touched by non-merge commits
 * reachable from the pushed tips but not from `baseRef` — by default no
 * remote-tracking ref (`--remotes`) — minus deletions, and only those that
 * still exist as files in the working tree. Sorted and unique.
 *
 * `baseRef` widens the range to everything the branch has ahead of that ref,
 * including commits a WIP checkpoint already pushed (Issue #3689). It must be
 * a ref the caller resolved itself; a value git could read as an option is
 * refused.
 */
export async function listPushedFiles(
  refs: PrePushRef[],
  cwd: string,
  git: PrePushGit,
  baseRef?: string,
): Promise<Result<string[], string>> {
  if (refs.length === 0) return { ok: true, value: [] };
  if (baseRef !== undefined && (baseRef === "" || baseRef.startsWith("-"))) {
    return { ok: false, error: `unsafe base ref ${JSON.stringify(baseRef)}` };
  }
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
      baseRef ?? "--remotes",
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

// SIMPLE-ON-PURPOSE: fixed deno fmt/lint extension allow-list, extra types a repo configures are left to its pre-flight — upgrade when a repo needs another type checked on push
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
/**
 * What the worker's own formatters may rewrite: the code half of the
 * `deno fmt` list. Markdown is never handed to `deno fmt` — it re-wraps whole
 * documents and trips markdownlint MD018 — so a Markdown miss is left to the
 * check to report.
 */
const DENO_CODE_FORMAT_EXTENSIONS = DENO_FORMAT_EXTENSIONS.filter((ext) =>
  !MARKDOWN_EXTENSIONS.includes(ext)
);

/** Extensions the Spelling workflow's glob covers (`**\/*.{md,html,js,ts,css,sh}`). */
const CSPELL_EXTENSIONS = [
  ".md",
  ".markdown",
  ".html",
  ".js",
  ".ts",
  ".css",
  ".sh",
];

/** Config names cspell finds on its own when run from the repo root. */
const CSPELL_ROOT_CONFIGS = [
  "cspell.json",
  ".cspell.json",
  "cSpell.json",
  "cspell.yaml",
  "cspell.yml",
  ...["json", "jsonc", "js", "cjs", "mjs", "yaml", "yml"].flatMap((ext) => [
    `cspell.config.${ext}`,
    `.cspell.config.${ext}`,
  ]),
];

/** Non-root config locations; cspell needs `--config` to find these. */
const CSPELL_NESTED_CONFIGS = ["docs/cspell.json"];

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

/**
 * The Floci CloudFormation deploy test `.github/workflows/floci.yml` runs in
 * CI (Issue #3727). A push that changes a file under its directory runs it,
 * so a deterministic deploy error is caught before the push. The script fails
 * closed when Floci cannot be started, when the `aws` CLI is missing or when a
 * stack misses `CREATE_COMPLETE`; with no Docker socket (the worker container)
 * it prints `SKIPPED (needs Docker): <template>` for a template that creates an
 * `AWS::EC2::Instance` and leaves that template to CI.
 */
const FLOCI_TEST_SCRIPT = "infra/cloudformation/test-floci.sh";
const FLOCI_TEST_DIR = "infra/cloudformation/";

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

/**
 * Plan the always-on changed-file format/lint commands. `denoScopes` maps a
 * deno root to its parsed include/exclude config: explicit paths override
 * deno's own `include`, so a file the repo's `deno fmt` / `deno lint` would
 * not check is dropped here instead of being passed to deno. A root with no
 * entry is unfiltered.
 */
export function planChangedFileChecks(
  changed: string[],
  tracked: string[],
  opts: {
    repoRoot: string;
    markdownlintBinary: string | null;
    /** Resolved cspell binary; absent or null means "not found". */
    cspellBinary?: string | null;
    /**
     * Whether the repo's own CI runs cspell. When false, a tracked cspell
     * config is not enough to run the check: the push is not blocked on a
     * tool CI would never run. Defaults to false, so a caller that does not
     * read the workflows cannot block on cspell by accident.
     */
    cspellInCi?: boolean;
    denoScopes?: Record<string, DenoScopeConfig>;
  },
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
    const scope = opts.denoScopes?.[root];
    const groups: Array<
      ["fmt" | "lint", string[], readonly string[], string]
    > = [
      [
        "fmt",
        rel,
        DENO_FORMAT_EXTENSIONS,
        "deno fmt --check --permit-no-files",
      ],
      ["lint", rel, DENO_LINT_EXTENSIONS, "deno lint --permit-no-files"],
    ];
    for (const [tool, files, extensions, base] of groups) {
      const label = `deno ${tool}`;
      const matching = files.filter((f) =>
        hasExtension(f, extensions) &&
        (scope === undefined || inDenoScope(f, scope, tool))
      );
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

  const rootCspell = CSPELL_ROOT_CONFIGS.find((name) => tracked.includes(name));
  const nestedCspell = CSPELL_NESTED_CONFIGS.find((name) =>
    tracked.includes(name)
  );
  const spelling = changed.filter((p) => hasExtension(p, CSPELL_EXTENSIONS));
  const cspellInCi = opts.cspellInCi ?? false;
  if ((rootCspell || nestedCspell) && cspellInCi && spelling.length > 0) {
    if (!opts.cspellBinary) {
      return {
        ok: false,
        error: "cspell is configured for this repository but cspell could " +
          "not be found — the push is blocked, not waved through",
      };
    }
    const binary = quoteForTokeniser(opts.cspellBinary);
    const quoted = quoteAll(spelling);
    if (binary === null) {
      return {
        ok: false,
        error: `cannot safely quote the cspell path ${
          JSON.stringify(opts.cspellBinary)
        }`,
      };
    }
    if (!quoted.ok) return quoted;
    const config = rootCspell ? "" : `--config ${nestedCspell} `;
    checks.push({
      label: "cspell",
      cwd: opts.repoRoot,
      command:
        `${binary} --no-progress --no-summary --no-must-find-files ${config}${quoted.value}`,
    });
  }

  if (
    tracked.includes(FLOCI_TEST_SCRIPT) &&
    changed.some((p) => p.startsWith(FLOCI_TEST_DIR))
  ) {
    checks.push({
      label: "floci cloudformation",
      cwd: opts.repoRoot,
      command: `bash ${FLOCI_TEST_SCRIPT}`,
    });
  }

  return { ok: true, value: checks };
}

/** One formatter invocation that fixes what a changed-file check would flag. */
export interface FormatterFix {
  tool: "cargo fmt" | "deno fmt";
  /** Repo-relative directory the formatter runs in; "." for the root. */
  dir: string;
  /** Argv, run without a shell. */
  cmd: string[];
  /** Repo-relative pathspecs staged after the formatter runs. */
  paths: string[];
}

/**
 * Plan the formatter runs that fix what {@link planChangedFileChecks}'s
 * `deno fmt --check` and `cargo fmt --check` would flag, over the same files:
 * `deno fmt` gets the changed code files under each deno root that the
 * repo's own fmt scope covers (never Markdown), and `cargo fmt --all` runs
 * for a cargo root whose `.rs` files changed — the same whole-workspace scope
 * its check enforces.
 */
export function planFormatterFixes(
  changed: readonly string[],
  tracked: string[],
  denoScopes: Record<string, DenoScopeConfig> = {},
): FormatterFix[] {
  const fixes: FormatterFix[] = [];
  for (
    const root of outermostConfigDirs(tracked, ["deno.json", "deno.jsonc"])
  ) {
    const scope = denoScopes[root];
    const files = changed.filter((p) =>
      (root === "." || p.startsWith(`${root}/`)) &&
      hasExtension(p, DENO_CODE_FORMAT_EXTENSIONS)
    ).map((p) => ({
      repoPath: p,
      rel: root === "." ? p : p.slice(root.length + 1),
    })).filter((f) => scope === undefined || inDenoScope(f.rel, scope, "fmt"));
    if (files.length === 0) continue;
    fixes.push({
      tool: "deno fmt",
      dir: root,
      cmd: [
        "deno",
        "fmt",
        "--permit-no-files",
        // A leading dash would be read as an option.
        ...files.map((f) => f.rel.startsWith("-") ? `./${f.rel}` : f.rel),
      ],
      paths: files.map((f) => f.repoPath),
    });
  }
  for (const root of outermostConfigDirs(tracked, ["Cargo.toml"])) {
    const changedRs = changed.filter((p) =>
      hasExtension(p, [".rs"]) && (root === "." || p.startsWith(`${root}/`))
    );
    if (changedRs.length === 0) continue;
    fixes.push({
      tool: "cargo fmt",
      dir: root,
      cmd: ["cargo", "fmt", "--all"],
      paths: changedRs,
    });
  }
  return fixes;
}

/**
 * Parse each deno root's `deno.json` / `deno.jsonc` scope from the working
 * tree. A root whose config is unreadable or unparseable is left out, so its
 * files are checked unfiltered and deno itself reports the broken config.
 */
export async function loadDenoScopes(
  repoRoot: string,
  tracked: string[],
): Promise<Record<string, DenoScopeConfig>> {
  const scopes: Record<string, DenoScopeConfig> = {};
  for (
    const root of outermostConfigDirs(tracked, ["deno.json", "deno.jsonc"])
  ) {
    const dir = root === "." ? repoRoot : `${repoRoot}/${root}`;
    for (const name of ["deno.json", "deno.jsonc"]) {
      let text: string;
      try {
        text = await Deno.readTextFile(`${dir}/${name}`);
      } catch {
        continue; // This config name is absent; try the other.
      }
      const parsed = parseDenoScope(text);
      if (parsed !== null) scopes[root] = parsed;
      break; // Deno prefers deno.json; do not fall through to deno.jsonc.
    }
  }
  return scopes;
}

/**
 * Find a runnable `markdownlint-cli2`: the repo's own install first, then the
 * first working one on `PATH`; null when neither runs.
 */
export function findMarkdownlintBinary(
  repoRoot: string,
  pathValue: string,
): Promise<string | null> {
  return findBinary("markdownlint-cli2", repoRoot, pathValue);
}

/**
 * Whether the repo's own CI runs cspell: a tracked workflow under
 * `.github/workflows/` with a `run:` or `uses:` step that names cspell.
 * Comment lines are ignored. A repo with a cspell config but no such step
 * is not blocked by cspell, since its required CI never runs it.
 */
export async function repoCiRunsCspell(
  repoRoot: string,
  tracked: readonly string[],
): Promise<boolean> {
  for (const path of tracked) {
    if (!path.startsWith(".github/workflows/")) continue;
    if (!/\.ya?ml$/.test(path)) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch {
      continue;
    }
    if (workflowRunsCspell(text)) return true;
  }
  return false;
}

/**
 * Whether one workflow file's text runs cspell: a `run:` or `uses:` step
 * whose command or action names cspell, on the same line or inside a
 * block scalar (`run: |`) under it. Comment lines are ignored. A cspell run
 * reached only through a script the step calls (`npm run spellcheck`) is not
 * detected, and the docs say so.
 */
export function workflowRunsCspell(text: string): boolean {
  const stepKey = /^(\s*)(?:-\s+)?(?:run|uses)\s*:(.*)$/;
  const cspellWord = /\bcspell\b/i;
  let blockIndent: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (blockIndent !== null) {
      if (line.trim() === "") continue;
      const indent = line.length - line.trimStart().length;
      if (indent > blockIndent) {
        if (!line.trimStart().startsWith("#") && cspellWord.test(line)) {
          return true;
        }
        continue;
      }
      blockIndent = null;
    }
    const step = stepKey.exec(line);
    if (!step) continue;
    const rest = (step[2] ?? "").trim();
    if (/^[|>][-+0-9]*$/.test(rest)) {
      blockIndent = (step[1] ?? "").length;
      continue;
    }
    if (cspellWord.test(rest)) return true;
  }
  return false;
}

/** Find a runnable `cspell`: the repo's own install first, then `PATH`. */
export function findCspellBinary(
  repoRoot: string,
  pathValue: string,
): Promise<string | null> {
  return findBinary("cspell", repoRoot, pathValue);
}

async function findBinary(
  name: string,
  repoRoot: string,
  pathValue: string,
): Promise<string | null> {
  const local = `${repoRoot}/node_modules/.bin/${name}`;
  try {
    if ((await Deno.stat(local)).isFile && await canRunBinary(local)) {
      return local;
    }
  } catch {
    // Not installed locally; fall through to PATH.
  }
  for (const dir of pathValue.split(":")) {
    if (dir === "") continue;
    const candidate = `${dir}/${name}`;
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
 * budget — they are never skipped; all but the Floci deploy test are fast. Any
 * git, parse or planning error is an `Err`, never a pass.
 */
export async function runPrePushGate(opts: {
  cwd: string;
  stdin: string;
  preFlightCommands: readonly string[];
  timeoutSeconds?: number;
  runner?: PreFlightRunner;
  git?: PrePushGit;
  findMarkdownlint?: (repoRoot: string) => Promise<string | null>;
  findCspell?: (repoRoot: string) => Promise<string | null>;
  /** Default branch ref for the sweptAt check; resolved from origin/HEAD when absent. */
  defaultRef?: string;
  /**
   * Check every non-merge commit ahead of this ref instead of only commits on
   * no remote-tracking ref (Issue #3689: the completion phase's pre-PR check).
   */
  baseRef?: string;
}): Promise<Result<{ checksRun: string[] }, Error>> {
  const git = opts.git ?? defaultPrePushGit;
  const fail = (message: string): Result<never, Error> => ({
    ok: false,
    error: new Error(message),
  });

  const infrastructureFail = (message: string): Result<never, Error> => ({
    ok: false,
    error: new PrePushGateInfrastructureError(message),
  });

  const refs = parsePrePushRefs(opts.stdin);
  if (!refs.ok) return fail(refs.error);

  const changed = await listPushedFiles(
    refs.value,
    opts.cwd,
    git,
    opts.baseRef,
  );
  if (!changed.ok) return infrastructureFail(changed.error);

  const lsFiles = await git(["ls-files", "-z"], opts.cwd);
  if (lsFiles.code !== 0) {
    return infrastructureFail(
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

  const cspellInCi = await repoCiRunsCspell(opts.cwd, tracked);
  const needsCspell = cspellInCi &&
    changed.value.some((p) => hasExtension(p, CSPELL_EXTENSIONS)) &&
    [...CSPELL_ROOT_CONFIGS, ...CSPELL_NESTED_CONFIGS].some((n) =>
      tracked.includes(n)
    );
  let cspellBinary: string | null = null;
  if (needsCspell) {
    const find = opts.findCspell ??
      ((root: string) => findCspellBinary(root, Deno.env.get("PATH") ?? ""));
    cspellBinary = await find(opts.cwd);
  }

  const plan = planChangedFileChecks(changed.value, tracked, {
    repoRoot: opts.cwd,
    markdownlintBinary,
    cspellBinary,
    cspellInCi,
    denoScopes: await loadDenoScopes(opts.cwd, tracked),
  });
  if (!plan.ok) return fail(plan.error);

  const sweep = await checkSweptAtAncestry({
    cwd: opts.cwd,
    changed: changed.value,
    git,
    defaultRef: opts.defaultRef,
  });
  if (!sweep.ok) {
    return sweep.infrastructure
      ? infrastructureFail(sweep.error)
      : fail(sweep.error);
  }

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
