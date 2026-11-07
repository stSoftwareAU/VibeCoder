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
 *    `markdownlint-cli2`, `cspell` and ShellCheck when the repo's CI runs
 *    them, and the Floci CloudFormation deploy test
 *    when the push changes `infra/cloudformation/` and the repo tracks its
 *    script), whatever the repo's own pre-flight list says and whatever the
 *    run budget — these checks are never skipped for budget; all but the Floci
 *    deploy test are cheap.
 * 2. Then runs the repo's configured pre-flight commands.
 *
 * Every uncertainty fails closed: unparseable hook input, a failing `git`
 * call, an unquotable path, a ShellCheck policy the runner cannot interpret,
 * or a configured-but-missing check binary is an `Err`, never a pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { canRunBinary } from "./markdownlint_check.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import {
  type PreFlightRunner,
  runPreFlightGate,
  tokeniseCommand,
} from "./pre_flight_gate.ts";
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
 * `includeDeleted` retains all touched paths for configuration invalidation;
 * callers must filter execution targets separately.
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
  includeDeleted = false,
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
      ...(includeDeleted ? [] : ["--diff-filter=d"]),
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
  if (includeDeleted) return { ok: true, value: [...names].sort() };
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

/** ShellCheck policy read from a repository's runnable CI workflow. */
export interface ShellcheckPolicy {
  /** Pinned CI version, or null when CI uses an action's own ShellCheck. */
  version: string | null;
  flags: string[];
  configFiles: string[];
  workflowFiles: string[];
}

const SHELLCHECK_CONFIGS = new Set([".shellcheckrc", "shellcheckrc"]);

// ShellCheck options that take a value (`shellcheck --help`); the gate must
// consume the value, not read it as a positional argument.
const SHELLCHECK_SHORT_VALUE_OPTIONS = "esSoiPfW";
const SHELLCHECK_LONG_VALUE_OPTIONS = [
  "exclude",
  "shell",
  "severity",
  "enable",
  "include",
  "source-path",
  "format",
  "wiki-link-count",
];

function defaultShellcheckConfigs(tracked: readonly string[]): string[] {
  return tracked.filter((candidate) =>
    SHELLCHECK_CONFIGS.has(candidate.split("/").at(-1) ?? "")
  );
}

const SHELLCHECK_ACTION_SEVERITIES = ["error", "warning", "info", "style"];

/**
 * Flags for each `ludeeus/action-shellcheck` step in a workflow (the template
 * the worker syncs into Bash repositories). Only `scandir: .` and `severity`
 * are understood; any other input, a `SHELLCHECK_OPTS` override or another
 * ShellCheck action is an unsupported policy, never an implicit pass. The
 * action scans more extensions than `.sh`; the gate checks the `.sh` subset.
 */
function shellcheckActionFlags(
  text: string,
  path: string,
): Result<string[][], string> {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const flagsPerStep: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const uses = /^(\s*)(?:-\s+)?uses\s*:\s*([^\s#]+)/.exec(lines[i]!);
    if (!uses || !/shellcheck/i.test(uses[2]!)) continue;
    if (!/^ludeeus\/action-shellcheck@/.test(uses[2]!)) {
      return {
        ok: false,
        error: `unsupported ShellCheck action in workflow ${path}`,
      };
    }
    // The step runs from its `- ` line to the next line at that indent or less.
    let start = i;
    while (start > 0 && !/^\s*-\s/.test(lines[start]!)) start--;
    const stepIndent = indentOf(lines[start]!);
    let end = i + 1;
    while (
      end < lines.length &&
      (lines[end]!.trim() === "" || indentOf(lines[end]!) > stepIndent)
    ) end++;
    const step = lines.slice(start, end);
    if (step.some((line) => /SHELLCHECK_OPTS/.test(line))) {
      return {
        ok: false,
        error:
          `unsupported ShellCheck action option SHELLCHECK_OPTS in ${path}`,
      };
    }
    const flags: string[] = [];
    const withAt = step.findIndex((line) => /^\s*with\s*:\s*$/.test(line));
    if (withAt >= 0) {
      const withIndent = indentOf(step[withAt]!);
      for (const line of step.slice(withAt + 1)) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        if (indentOf(line) <= withIndent) break;
        const input = /^\s*([\w-]+)\s*:\s*["']?([^"'#\s]*)["']?\s*(?:#.*)?$/
          .exec(line);
        const [, key, value] = input ?? [];
        if (key === "scandir" && (value === "." || value === "./")) continue;
        if (
          key === "severity" && SHELLCHECK_ACTION_SEVERITIES.includes(value!)
        ) {
          flags.push(`--severity=${value}`);
          continue;
        }
        return {
          ok: false,
          error: `unsupported ShellCheck action option ${
            key ?? line.trim()
          } in ${path}`,
        };
      }
    }
    flagsPerStep.push(flags);
  }
  return { ok: true, value: flagsPerStep };
}

function isRepoRelativeShellcheckConfig(path: string): boolean {
  return !path.startsWith("/") &&
    !path.split(/[\\/]/).some((part) => part === "." || part === "..");
}

/**
 * Read the supported direct ShellCheck policy from tracked workflow steps.
 * A workflow that invokes ShellCheck in another shape is an incomplete policy,
 * never an implicit pass.
 */
export async function repoShellcheckPolicy(
  repoRoot: string,
  tracked: readonly string[],
): Promise<Result<ShellcheckPolicy | null, string>> {
  const policies: ShellcheckPolicy[] = [];
  for (const path of tracked) {
    if (!path.startsWith(".github/workflows/") || !/\.ya?ml$/.test(path)) {
      continue;
    }
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch (error) {
      return {
        ok: false,
        error: `cannot read tracked workflow ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const bodies = workflowRunStepBodies(text);
    if (!bodies.ok) return bodies;
    const runSteps = bodies.value;
    const delegated = await workflowDelegatesToShellcheck(
      repoRoot,
      tracked,
      runSteps,
    );
    if (!delegated.ok) return delegated;
    if (delegated.value) {
      return {
        ok: false,
        error:
          `repository CI delegates ShellCheck through a script in workflow ${path}`,
      };
    }
    const actionFlags = shellcheckActionFlags(text, path);
    if (!actionFlags.ok) return actionFlags;
    for (const flags of actionFlags.value) {
      policies.push({
        version: null,
        flags,
        configFiles: defaultShellcheckConfigs(tracked),
        workflowFiles: [path],
      });
    }
    const commands = runSteps.flatMap(executableShellCommands).filter(
      isShellcheckInvocation,
    );
    if (commands.length === 0) continue;
    if (
      /^\s*working-directory\s*:\s*(?!["']?\.["']?\s*(?:#.*)?$)/m.test(text)
    ) {
      return {
        ok: false,
        error:
          `ShellCheck workflow ${path} sets an unsupported working-directory`,
      };
    }
    const versions = [
      ...text.matchAll(
        /^\s*SHELLCHECK_VERSION\s*:\s*["']?(\d+\.\d+\.\d+)["']?\s*(?:#.*)?$/gm,
      ),
    ]
      .map((match) => match[1]!);
    const uniqueVersions = [...new Set(versions)];
    if (uniqueVersions.length !== 1) {
      return {
        ok: false,
        error:
          `ShellCheck workflow ${path} does not declare one supported pinned version`,
      };
    }
    const version = uniqueVersions[0]!;
    for (const command of commands) {
      const match =
        /^find\s+\.\s+-name\s+["']\*\.sh["']\s+-type\s+f\s+-exec\s+shellcheck\s+(.+?)\s+\{\}\s+\+$/
          .exec(
            command,
          );
      if (!match) {
        return {
          ok: false,
          error: `unsupported ShellCheck command in ${path}: ${command}`,
        };
      }
      const args = tokeniseCommand(match[1]!);
      const explicitConfigFiles: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (!arg.startsWith("-")) {
          return {
            ok: false,
            error:
              `unsupported positional ShellCheck argument in ${path}: ${command}`,
          };
        }
        if (
          arg === "--rcfile" || arg === "-rc" || arg.startsWith("--rcfile=")
        ) {
          const value = arg.startsWith("--rcfile=")
            ? arg.slice("--rcfile=".length)
            : args[++i];
          if (!value || value.startsWith("-")) {
            return { ok: false, error: `missing ShellCheck rcfile in ${path}` };
          }
          if (!isRepoRelativeShellcheckConfig(value)) {
            return {
              ok: false,
              error: `unsafe ShellCheck rcfile path in ${path}`,
            };
          }
          explicitConfigFiles.push(value);
        } else if (arg.startsWith("--")) {
          const [name, ...inline] = arg.slice(2).split("=");
          const takesValue = SHELLCHECK_LONG_VALUE_OPTIONS.includes(name!);
          if (takesValue && inline.length > 0) {
            if (inline.join("=") === "") {
              return {
                ok: false,
                error:
                  `missing value for ShellCheck option --${name} in ${path}`,
              };
            }
          } else if (takesValue) {
            const value = args[++i];
            if (!value || value.startsWith("-")) {
              return {
                ok: false,
                error: `missing value for ShellCheck option ${arg} in ${path}`,
              };
            }
          }
          // Other long options pass through unchanged; ShellCheck validates them.
        } else if (/^-[A-Za-z]$/.test(arg)) {
          if (SHELLCHECK_SHORT_VALUE_OPTIONS.includes(arg[1]!)) {
            const value = args[++i];
            if (!value || value.startsWith("-")) {
              return {
                ok: false,
                error: `missing value for ShellCheck option ${arg} in ${path}`,
              };
            }
          }
          // Other short options pass through unchanged; ShellCheck validates them.
        } else if (
          arg.length > 2 && SHELLCHECK_SHORT_VALUE_OPTIONS.includes(arg[1]!) &&
          /^-[A-Za-z]/.test(arg)
        ) {
          // Attached value (-Swarning): one token, nothing further to consume.
        } else {
          return {
            ok: false,
            error: `unsupported ShellCheck option ${arg} in ${path}`,
          };
        }
      }
      const configFiles = args.includes("--norc")
        ? []
        : explicitConfigFiles.length > 0
        ? explicitConfigFiles
        : defaultShellcheckConfigs(tracked);
      policies.push({
        version,
        flags: args,
        configFiles,
        workflowFiles: [path],
      });
    }
  }
  if (policies.length === 0) return { ok: true, value: null };
  const first = policies[0]!;
  if (
    policies.some((p) =>
      p.version !== first.version ||
      JSON.stringify(p.flags) !== JSON.stringify(first.flags) ||
      JSON.stringify(p.configFiles) !== JSON.stringify(first.configFiles)
    )
  ) {
    return {
      ok: false,
      error: "repository CI declares conflicting ShellCheck policies",
    };
  }
  return {
    ok: true,
    value: {
      ...first,
      workflowFiles: [...new Set(policies.flatMap((p) => p.workflowFiles))],
    },
  };
}

async function workflowDelegatesToShellcheck(
  repoRoot: string,
  tracked: readonly string[],
  runSteps: readonly string[],
): Promise<Result<boolean, string>> {
  const scriptCalls = (body: string): string[] =>
    executableShellCommands(body)
      .map((line) => {
        const tokens = tokeniseCommand(line);
        const first = tokens[0];
        if (
          first === "bash" || first === "sh" || first === "source" ||
          first === "."
        ) {
          return tokens.slice(1).find((t) => !t.startsWith("-")) ?? "";
        }
        return first ?? "";
      }).map((path) => path.startsWith("./") ? path.slice(2) : path)
      .filter((path) =>
        path.endsWith(".sh") &&
        isRepoRelativeShellcheckConfig(path) && tracked.includes(path)
      );
  const pending = new Set(runSteps.flatMap(scriptCalls));

  const inspected = new Set<string>();
  while (pending.size > 0) {
    const path = pending.values().next().value as string;
    pending.delete(path);
    if (inspected.has(path)) continue;
    inspected.add(path);
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch (error) {
      return {
        ok: false,
        error: `cannot read tracked workflow script ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (executableShellCommands(text).some(isShellcheckInvocation)) {
      return { ok: true, value: true };
    }
    for (const called of scriptCalls(text)) pending.add(called);
  }
  return { ok: true, value: false };
}

function isShellcheckInvocation(line: string): boolean {
  const tokens = tokeniseCommand(line);
  return (tokens[0]?.split("/").at(-1) === "shellcheck" &&
    tokens[1] !== "--version") ||
    (tokens[0] === "find" &&
      tokens.some((t, i) => t === "-exec" && tokens[i + 1] === "shellcheck"));
}

/** Inspect command positions, keeping quoted log/data strings out of discovery. */
function executableShellCommands(body: string): string[] {
  const commands: string[] = [];
  let inArray = false;
  for (const line of body.split("\n")) {
    if (inArray) {
      if (/^\s*\)/.test(line)) inArray = false;
      continue;
    }
    if (/^\s*(?:(?:readonly|local|declare)(?:\s+-\w+)*\s+)?\w+=\(/.test(line)) {
      inArray = !/\)\s*(?:#.*)?$/.test(line);
      continue;
    }
    const parts =
      line.match(/"[^"\n]*"|'[^'\n]*'|#[^\n]*|&&|\|\||[;|]|[^\s;|]+/g) ?? [];
    let current: string[] = [];
    const flush = () => {
      while (
        current.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0]!) ||
          ["if", "then", "elif", "else", "!", "sudo", "env", "command"]
            .includes(current[0]!))
      ) {
        current.shift();
      }
      if (current.length) commands.push(current.join(" "));
      current = [];
    };
    for (const part of parts) {
      if (part.startsWith("#")) break;
      if ([";", "|", "&&", "||"].includes(part)) flush();
      else current.push(part);
    }
    flush();
  }
  return commands;
}

function workflowRunStepBodies(text: string): Result<string[], string> {
  const bodies: string[] = [];
  const stepKey = /^(\s*)(?:-\s+)?run\s*:(.*)$/;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const step = stepKey.exec(line);
    if (!step) continue;
    const rest = (step[2] ?? "").trim();
    if (!/^[|>][-+0-9]*(?:\s+#.*)?$/.test(rest)) {
      if (/^[|>]/.test(rest)) {
        return {
          ok: false,
          error: `cannot interpret workflow run body: ${rest}`,
        };
      }
      bodies.push(/^(".*"|'.*')$/.test(rest) ? rest.slice(1, -1) : rest);
      continue;
    }
    const indent = (step[1] ?? "").length;
    const block: string[] = [];
    for (i++; i < lines.length; i++) {
      const next = lines[i]!.replace(/\r$/, "");
      if (next.trim() === "") {
        block.push("");
        continue;
      }
      if (next.length - next.trimStart().length <= indent) {
        i--;
        break;
      }
      block.push(next.trimStart());
    }
    bodies.push(block.join("\n"));
  }
  return { ok: true, value: bodies };
}

function shellcheckVersionOutput(text: string): string | null {
  return /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(text)?.[1] ?? null;
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

function quoteArguments(args: string[]): Result<string, string> {
  const quoted: string[] = [];
  for (const arg of args) {
    const value = quoteForTokeniser(arg);
    if (value === null) {
      return {
        ok: false,
        error: `cannot safely quote ShellCheck argument ${JSON.stringify(arg)}`,
      };
    }
    quoted.push(value);
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
    shellcheckPolicy?: ShellcheckPolicy | null;
    shellcheckBinary?: string | null;
    shellcheckFiles?: string[];
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

  if (opts.shellcheckPolicy && (opts.shellcheckFiles?.length ?? 0) > 0) {
    if (!opts.shellcheckBinary) {
      return {
        ok: false,
        error: "ShellCheck is required by repository CI but could not be found",
      };
    }
    const binary = quoteForTokeniser(opts.shellcheckBinary);
    if (binary === null) {
      return { ok: false, error: "cannot safely quote the ShellCheck path" };
    }
    const policy = opts.shellcheckPolicy;
    for (const file of opts.shellcheckFiles ?? []) {
      const explicit = policy.flags.some((a) =>
        a === "--rcfile" || a === "-rc" || a.startsWith("--rcfile=")
      );
      // Choose the nearest tracked config, matching ShellCheck's search order,
      // and stop at the repo root instead of falling back to the worker's HOME.
      let config: string | undefined;
      if (!explicit && !policy.flags.includes("--norc")) {
        let dir = file.includes("/")
          ? file.slice(0, file.lastIndexOf("/"))
          : "";
        for (;;) {
          config = [".shellcheckrc", "shellcheckrc"].map((name) =>
            dir ? `${dir}/${name}` : name
          )
            .find((candidate) => policy.configFiles.includes(candidate));
          if (config || dir === "") break;
          dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        }
      }
      const args = [
        ...policy.flags,
        ...(explicit || policy.flags.includes("--norc")
          ? []
          : config
          ? ["--rcfile", config]
          : ["--norc"]),
      ];
      const quoted = quoteArguments(args);
      if (!quoted.ok) return quoted;
      const files = quoteAll([file]);
      if (!files.ok) return files;
      checks.push({
        label: "shellcheck",
        cwd: opts.repoRoot,
        command: `${binary} ${quoted.value} ${files.value}`,
      });
    }
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

/** Find the `shellcheck` resolved by CI's `PATH`, in the same order. */
export function findShellcheckBinary(
  pathValue: string,
): Promise<string | null> {
  return findPathBinary("shellcheck", pathValue);
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

async function findPathBinary(
  name: string,
  pathValue: string,
): Promise<string | null> {
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

/** Output of `shellcheck --version`; injectable so unit tests need no host binary. */
export type ShellcheckVersionProbe = (
  binary: string,
  cwd: string,
) => Promise<{ code: number; stdout: string }>;

const defaultShellcheckVersionProbe: ShellcheckVersionProbe = async (
  binary,
  cwd,
) => {
  const out = await new Deno.Command(binary, {
    args: ["--version"],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: buildUntrustedCommandEnv(),
    clearEnv: true,
    signal: AbortSignal.timeout(10_000),
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

/** Whether a changed path can alter what the repository's ShellCheck CI checks. */
function touchesShellcheckSurface(changed: readonly string[]): boolean {
  return changed.some((p) =>
    p.endsWith(".sh") || SHELLCHECK_CONFIGS.has(p.split("/").at(-1) ?? "") ||
    (p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p))
  );
}

/**
 * Shared ShellCheck validation for hooks, completion and repair publication.
 * A policy the gate cannot read blocks only a push that touches a script, a
 * ShellCheck config or a workflow; any other push has nothing ShellCheck
 * could check, so an unsupported policy cannot make the repository
 * unpublishable.
 */
export async function runAffectedShellcheckChecks(opts: {
  cwd: string;
  changed: readonly string[];
  tracked: string[];
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
  findShellcheck?: (repoRoot: string) => Promise<string | null>;
  readShellcheckVersion?: ShellcheckVersionProbe;
}): Promise<Result<{ checksRun: string[] }, Error>> {
  const infrastructureFail = (message: string): Result<never, Error> => ({
    ok: false,
    error: new PrePushGateInfrastructureError(message),
  });
  const shellcheckPolicy = await repoShellcheckPolicy(opts.cwd, opts.tracked);
  if (!shellcheckPolicy.ok) {
    return touchesShellcheckSurface(opts.changed)
      ? infrastructureFail(shellcheckPolicy.error)
      : { ok: true, value: { checksRun: [] } };
  }
  const shellcheckTouchedConfigs = opts.changed.some((p) =>
    SHELLCHECK_CONFIGS.has(p.split("/").at(-1) ?? "") ||
    shellcheckPolicy.value?.configFiles.includes(p) ||
    (p.startsWith(".github/workflows/") && /\.ya?ml$/.test(p))
  );
  const shellcheckFiles = shellcheckPolicy.value &&
      (shellcheckTouchedConfigs || opts.changed.some((p) => p.endsWith(".sh")))
    ? (shellcheckTouchedConfigs
      ? opts.tracked.filter((p) => p.endsWith(".sh"))
      : opts.changed.filter((p) => p.endsWith(".sh")))
    : [];
  if (shellcheckPolicy.value && shellcheckFiles.length > 0) {
    for (const path of shellcheckPolicy.value.configFiles) {
      try {
        await Deno.readTextFile(`${opts.cwd}/${path}`);
      } catch (error) {
        return infrastructureFail(
          `cannot read ShellCheck configuration ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  const existingShellcheckFiles: string[] = [];
  for (const path of shellcheckFiles) {
    try {
      if ((await Deno.stat(`${opts.cwd}/${path}`)).isFile) {
        existingShellcheckFiles.push(path);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      return infrastructureFail(
        `cannot inspect changed ShellCheck file ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  let shellcheckBinary: string | null = null;
  if (shellcheckPolicy.value && existingShellcheckFiles.length > 0) {
    const find = opts.findShellcheck ??
      ((_root: string) => findShellcheckBinary(Deno.env.get("PATH") ?? ""));
    shellcheckBinary = await find(opts.cwd);
    if (!shellcheckBinary) {
      return infrastructureFail(
        "ShellCheck is required by repository CI but could not be found",
      );
    }
    const probe = opts.readShellcheckVersion ?? defaultShellcheckVersionProbe;
    let versionResult: { code: number; stdout: string };
    try {
      versionResult = await probe(shellcheckBinary, opts.cwd);
    } catch (error) {
      return infrastructureFail(
        `could not read ShellCheck version: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const actualVersion = shellcheckVersionOutput(versionResult.stdout);
    // A null policy version is an action-managed ShellCheck: nothing to pin.
    if (
      shellcheckPolicy.value.version !== null &&
      (versionResult.code !== 0 ||
        actualVersion !== shellcheckPolicy.value.version)
    ) {
      return infrastructureFail(
        `ShellCheck version mismatch: CI requires ${shellcheckPolicy.value.version}, ` +
          `worker has ${actualVersion ?? "an unreadable version"}`,
      );
    }
  }

  const plan = planChangedFileChecks([], [], {
    repoRoot: opts.cwd,
    markdownlintBinary: null,
    shellcheckPolicy: shellcheckPolicy.value,
    shellcheckBinary,
    shellcheckFiles: existingShellcheckFiles,
  });
  if (!plan.ok) return infrastructureFail(plan.error);
  const checksRun: string[] = [];
  for (const check of plan.value) {
    const result = await runPreFlightGate([check.command], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    });
    if (!result.ok) return result;
    checksRun.push(check.command);
  }
  return { ok: true, value: { checksRun } };
}

/** Check staged repair files, including configuration deletions, before commit. */
export async function gateStagedShellcheck(
  cwd: string,
  baseline = "HEAD",
): Promise<Result<{ checksRun: string[] }, Error>> {
  const paths = await defaultPrePushGit([
    "diff",
    "--cached",
    "--name-only",
    "-z",
    baseline,
    "--",
  ], cwd);
  const tracked = await defaultPrePushGit(["ls-files", "-z"], cwd);
  for (const result of [paths, tracked]) {
    if (result.code !== 0) {
      return {
        ok: false,
        error: new PrePushGateInfrastructureError(
          result.stderr || "cannot list staged ShellCheck inputs",
        ),
      };
    }
  }
  return runAffectedShellcheckChecks({
    cwd,
    changed: paths.stdout.split("\0").filter(Boolean),
    tracked: tracked.stdout.split("\0").filter(Boolean),
  });
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
  /** Repairs without configured pre-flight retain their existing formatter policy. */
  shellcheckOnly?: boolean;
  timeoutSeconds?: number;
  runner?: PreFlightRunner;
  git?: PrePushGit;
  findMarkdownlint?: (repoRoot: string) => Promise<string | null>;
  findCspell?: (repoRoot: string) => Promise<string | null>;
  findShellcheck?: (repoRoot: string) => Promise<string | null>;
  readShellcheckVersion?: ShellcheckVersionProbe;
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

  const touched = await listPushedFiles(
    refs.value,
    opts.cwd,
    git,
    opts.baseRef,
    true,
  );
  if (!touched.ok) return infrastructureFail(touched.error);
  const existing: string[] = [];
  for (const path of touched.value) {
    try {
      if ((await Deno.lstat(`${opts.cwd}/${path}`)).isFile) existing.push(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        return infrastructureFail(
          `cannot inspect pushed file ${path}: ${error}`,
        );
      }
    }
  }
  const changed = { value: opts.shellcheckOnly ? [] : existing };

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

  const shellcheck = await runAffectedShellcheckChecks({
    ...opts,
    changed: touched.value,
    tracked,
  });
  if (!shellcheck.ok) return shellcheck;

  const plan = planChangedFileChecks(changed.value, tracked, {
    repoRoot: opts.cwd,
    markdownlintBinary,
    cspellBinary,
    cspellInCi,
    denoScopes: await loadDenoScopes(opts.cwd, tracked),
  });
  if (!plan.ok) return fail(plan.error);

  const checksRun: string[] = [...shellcheck.value.checksRun];
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
