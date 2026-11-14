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
 *   over every commit the branch has ahead of the PR base — so
 *   content the execute phase's WIP checkpoints already pushed is checked
 *   before `gh pr create`.
 * - the babysitter's in-container repair command, via `runBabysitterTreeGate`,
 *   over its uncommitted tree before its READY response reaches the host.
 *
 * It does four things, in order:
 *
 * 1. Always runs a fast check over just the files the push introduces
 *    (`deno fmt --check`, `deno lint`, `deno test` (Issue #4930),
 *    `cargo fmt --check`, `markdownlint-cli2`, `cspell` and ShellCheck when the
 *    repo's CI runs them, and the Floci CloudFormation deploy test
 *    when the push changes `infra/cloudformation/` and the repo tracks its
 *    script), whatever the repo's own pre-flight list says and whatever the
 *    run budget — these checks are never skipped for budget; all but the Floci
 *    deploy test and the `deno test` run are cheap. The `deno test` check runs
 *    the changed test files, the same-named and co-located tests of changed
 *    sources and the tests whose text names a changed file or that import such
 *    a file, via the repo's own `test:unit` task so integration suites like
 *    CI's shards are excluded. A change under `prompts/`, or to a root's
 *    `deno.json`, `deno.jsonc` or `deno.lock`, has readers a name scan cannot
 *    find, so it runs that root's whole `test:unit` suite
 *    ({@link needsFullUnitSuite}), as does a root whose module graph the scan
 *    cannot follow ({@link unfollowableImportRoots}). A
 *    failing run is judged by `deno_test_baseline.ts`: a module-fetch failure
 *    is an infrastructure failure, and a test that fails the same way where the
 *    push forked (the merge-base with the base branch, the PR's base or the
 *    checkout's default branch, when one is known) is a
 *    `[PRE_PUSH_WARNING]` line, not a block, provided every failure of the run
 *    is accounted for and its serial pass ran.
 * 2. Then runs the CI cargo checks (Issue #4630): the `cargo clippy` and
 *    test-target `cargo test --no-run` commands the repo's pull-request
 *    workflows run, for each crate directory a pushed Rust file touches. Only
 *    when the push changes a Rust-relevant file, and only after a probe that
 *    the Rust toolchain runs here. These run only for a caller that passes
 *    `findCiCargo`: with none, no CI cargo check is planned or run. The
 *    agent's own pre-push hook (`lib/pre_push_gate_cli.ts`) receives the scan
 *    precomputed into its spec and passes it back as `findCiCargo`, with the
 *    spec's `compareRef` (the PR base, for a CI-fix or PR-feedback run) as
 *    `compareRef`. The worker's own gates pass
 *    `repoCiCargoChecks` directly: `git_push.ts` `gateUnpushedCommits`
 *    (`commitAndPushPending` Step 1b and the completion phase).
 * 3. Then runs the repo's `cargo deny check` (Issue #4626) for eligible
 *    workflows when intermediate pushes, ShellCheck-only repairs or
 *    `ciCargoOnly` repairs change a cargo input (a Cargo manifest, lock file,
 *    deny config or `.cargo/config.toml`). The whole-branch completion check
 *    (with a baseRef, and neither ShellCheck-only nor `ciCargoOnly`) runs it on
 *    every branch for eligible workflows, regardless of changed cargo inputs.
 *    Missing tools or an unreachable advisory database are infrastructure
 *    failures, except for an invocation CI allows to fail, whose failures of
 *    every kind are `[PRE_PUSH_WARNING]` lines.
 * 4. Then runs the repo's configured pre-flight commands.
 *
 * Every uncertainty fails closed: unparseable hook input, a failing `git`
 * call, an unquotable path, a ShellCheck policy the runner cannot interpret,
 * or a configured-but-missing check binary is an `Err`, never a pass. A CI
 * cargo command that cannot be reproduced here, or a Rust toolchain that is
 * not available, is reported as an infrastructure fault (not a verdict on the
 * commit) and never reduces the set of checks run.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { canRunBinary } from "./markdownlint_check.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import {
  type PreFlightGateError,
  type PreFlightRunner,
  runPreFlightGate,
  tokeniseCommand,
} from "./pre_flight_gate.ts";
import { runCargoDenyGate } from "./cargo_deny_gate.ts";
import {
  type DenoScopeConfig,
  inDenoScope,
  parseDenoScope,
} from "./deno_scope.ts";
import { INTEGRATION_TEST_FILES } from "./integration_test_manifest.ts";
import { stripJsonc } from "./jsonc.ts";
import {
  judgeDenoTestCheck,
  unitTestCommand,
  worktreeBaseline,
} from "./deno_test_baseline.ts";
// Types only: a value import would put the workflow scanner, and its bare
// `@std/yaml/parse` specifier, into the hook's runtime graph; the hook
// receives the scan precomputed into its spec instead (see the module
// header). The hook still reaches a YAML parser through cargo_deny_gate.ts.
import type {
  CiCargoCheck,
  CiCargoCheckKind,
  CiCargoScan,
} from "./ci_cargo_checks.ts";
import { isHostDiskFaultText } from "./host_fault.ts";
import { redactedHeadTail } from "./redacted_text.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { readRepoFile } from "./repo_file_read.ts";

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

/** The branch names the refs push (`refs/heads/` stripped), or undefined when none. */
function pushedBranches(refs: readonly PrePushRef[]): string[] | undefined {
  const names = refs.flatMap((ref) =>
    ref.remoteRef.startsWith("refs/heads/")
      ? [ref.remoteRef.slice("refs/heads/".length)]
      : []
  );
  return names.length === 0 ? undefined : names;
}

/**
 * List the files the push introduces: those touched by commits (including
 * the paths a merge commit itself changed: a conflict resolution or a fix
 * folded into the merge, never the files it merely brings in from the base)
 * reachable from the pushed tips but not from `baseRef` — by default no
 * remote-tracking ref (`--remotes`) — minus deletions, and only those that
 * still exist as regular files in the working tree. Files reached through a
 * symlinked parent directory are skipped too, since they resolve outside the
 * checkout. Sorted and unique. `includeDeleted` retains all touched paths
 * (unfiltered by the working tree) for configuration invalidation; callers
 * must filter execution targets separately.
 *
 * `baseRef` widens the range to everything the branch has ahead of that ref,
 * including commits a WIP checkpoint already pushed (Issue #3689). It must be
 * a ref the caller resolved itself; a value git could read as an option is
 * refused.
 *
 * `containToCheckout` (default true) is the symlinked-parent skip above. The CI
 * cargo planner passes false: it must still see a Rust file reached through a
 * symlinked crate directory, so the working-directory containment check can
 * refuse it as an infrastructure fault instead of the file being dropped
 * unseen (Issue #4630).
 */
export async function listPushedFiles(
  refs: PrePushRef[],
  cwd: string,
  git: PrePushGit,
  baseRef?: string,
  includeDeleted = false,
  containToCheckout = true,
): Promise<Result<string[], string>> {
  if (refs.length === 0) return { ok: true, value: [] };
  if (baseRef !== undefined && (baseRef === "" || baseRef.startsWith("-"))) {
    return { ok: false, error: `unsafe base ref ${JSON.stringify(baseRef)}` };
  }
  const result = await git(
    [
      "log",
      "--diff-merges=dense-combined",
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
  if (names.size === 0) return { ok: true, value: [] };
  let realCwd: string;
  try {
    realCwd = await Deno.realPath(cwd);
  } catch (err) {
    return {
      ok: false,
      error: `could not resolve checkout ${JSON.stringify(cwd)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const existing: string[] = [];
  for (const name of names) {
    try {
      const stat = await Deno.lstat(`${cwd}/${name}`);
      if (!stat.isFile) continue;
      // A symlinked parent directory (`dir -> /elsewhere`) makes `dir/file`
      // resolve outside the checkout even though its own lstat is a file.
      if (
        containToCheckout &&
        (await Deno.realPath(`${cwd}/${name}`)) !== `${realCwd}/${name}`
      ) {
        continue;
      }
      existing.push(name);
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
  /** Set on a `deno test` check: its deno root, repo-relative ("." for the top). */
  denoTestRoot?: string;
  /** Env the command runs with: the cargo-relevant env CI sets. Absent otherwise. */
  env?: Record<string, string>;
  /**
   * Set on a cargo command the repo's CI runs (Issue #4630): its kind, and the
   * `+toolchain` name when CI names one. Read by the capability probe and by
   * the failure classification.
   */
  cargo?: { kind: CiCargoCheckKind; toolchain?: string };
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
 * action's file selection is applied by the gate.
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
      const info = await shellcheckFileInfo(repoRoot, path);
      if (info === null) continue; // GitHub does not run symlinked workflows.
      text = await readBoundedPolicyFile(repoRoot, path, info);
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
    if (delegated.value !== null) {
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
    if (
      (actionFlags.value.length > 0 || commands.length > 0) &&
      /SHELLCHECK_OPTS/.test(text)
    ) {
      return {
        ok: false,
        error:
          `unsupported ShellCheck action option SHELLCHECK_OPTS in ${path}`,
      };
    }
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
      const match = SUPPORTED_SHELLCHECK_COMMAND.exec(command);
      if (!match) {
        return {
          ok: false,
          error: `unsupported ShellCheck command in ${path}: ${command}`,
        };
      }
      const args = tokeniseCommand(match[1] ?? "");
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

/**
 * The workflow command that delegates ShellCheck to a repository script —
 * directly or through scripts it calls — or null when none does (Issue #5046).
 */
/** A workflow `run:` step that runs ShellCheck in a shape the gate can't model. */
export interface ShellcheckDelegation {
  workflow: string;
  /** The step's `run:` body, run as GitHub runs it. */
  step: string;
}

/** The one ShellCheck command shape the gate turns into its own policy. */
const SUPPORTED_SHELLCHECK_COMMAND =
  /^find\s+\.\s+-name\s+["']\*\.sh["']\s+-type\s+f\s+-exec\s+shellcheck(?:\s+(.+?))?\s+\{\}\s+\+$/;

/**
 * Every tracked workflow step that runs ShellCheck through a repository
 * script, or inline in a shape other than the supported `find … -exec
 * shellcheck` (Issue #5046). The gate runs these steps as CI does rather than
 * refusing the push: the step — its script, baseline, exclusions and file
 * set — is the policy, and it cannot be rebuilt from outside.
 */
export async function shellcheckDelegations(
  repoRoot: string,
  tracked: readonly string[],
): Promise<Result<ShellcheckDelegation[], string>> {
  const delegations: ShellcheckDelegation[] = [];
  for (const path of tracked) {
    if (!path.startsWith(".github/workflows/") || !/\.ya?ml$/.test(path)) {
      continue;
    }
    let text: string;
    try {
      const info = await shellcheckFileInfo(repoRoot, path);
      if (info === null) continue;
      text = await readBoundedPolicyFile(repoRoot, path, info);
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
    for (const step of bodies.value) {
      const inline = executableShellCommands(step).filter(
        isShellcheckInvocation,
      );
      let delegates = inline.some((command) =>
        !SUPPORTED_SHELLCHECK_COMMAND.test(command)
      );
      if (!delegates) {
        const viaScript = await workflowDelegatesToShellcheck(
          repoRoot,
          tracked,
          [step],
        );
        if (!viaScript.ok) return viaScript;
        delegates = viaScript.value !== null;
      }
      if (!delegates) continue;
      if (step.includes("${{")) {
        return {
          ok: false,
          error:
            `repository CI runs ShellCheck in workflow ${path} through a step ` +
            "that uses workflow expressions, which the gate cannot run locally",
        };
      }
      delegations.push({ workflow: path, step });
    }
  }
  return { ok: true, value: delegations };
}

async function workflowDelegatesToShellcheck(
  repoRoot: string,
  tracked: readonly string[],
  runSteps: readonly string[],
): Promise<Result<string | null, string>> {
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
  for (const command of runSteps.flatMap(executableShellCommands)) {
    const entries = scriptCalls(command);
    if (entries.length === 0) continue;
    const reached = await scriptsReachShellcheck(
      repoRoot,
      entries,
      scriptCalls,
    );
    if (!reached.ok) return reached;
    if (reached.value) return { ok: true, value: command };
  }
  return { ok: true, value: null };
}

async function scriptsReachShellcheck(
  repoRoot: string,
  entries: readonly string[],
  scriptCalls: (body: string) => string[],
): Promise<Result<boolean, string>> {
  const pending = new Set(entries);
  const inspected = new Set<string>();
  while (pending.size > 0) {
    const path = pending.values().next().value as string;
    pending.delete(path);
    if (inspected.has(path)) continue;
    inspected.add(path);
    let text: string;
    try {
      const info = await shellcheckFileInfo(repoRoot, path);
      if (!info) throw new Error("not a regular in-repository file");
      text = await readBoundedPolicyFile(repoRoot, path, info);
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
  const wrappers = [
    "xargs",
    "parallel",
    "do",
    "time",
    "exec",
    "nice",
    "timeout",
  ];
  const wrapped = wrappers.includes(tokens[0] ?? "");
  // `bash -c '…'`, directly or under a wrapper such as `xargs -0 bash -c '…'`
  // (Issue #5046): the quoted body is a script of its own.
  const shellAt = tokens.findIndex((token, i) =>
    (i === 0 || wrapped) &&
    ["bash", "sh"].includes(token.split("/").at(-1) ?? "")
  );
  const commandOption = shellAt < 0
    ? -1
    : tokens.findIndex((token, i) =>
      i > shellAt && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)
    );
  const shellCommand = commandOption > 0 &&
    tokens[commandOption + 1] !== undefined &&
    executableShellCommands(tokens[commandOption + 1]!).some(
      isShellcheckInvocation,
    );
  const dockerImage = tokens[0] === "docker" &&
    tokens.some((token) =>
      /(?:^|\/)koalaman\/shellcheck(?::[^\s@]+)?(?:@[^\s]+)?$/.test(token)
    );
  // Only an executed `shellcheck` counts. A later argument that merely names
  // it — `command -v shellcheck`, `grep shellcheck`, a harness's label — is
  // not CI running ShellCheck over the repository (Issue #5046).
  const wrappedShellcheck = wrapped &&
    tokens.slice(1).some((token, index, rest) =>
      token.split("/").at(-1) === "shellcheck" &&
      rest[index + 1] !== "--version"
    );
  return ((tokens[0]?.split("/").at(-1)?.includes("shellcheck") ?? false) &&
    tokens[1] !== "--version") ||
    wrappedShellcheck || shellCommand || dockerImage ||
    (tokens[0] === "find" &&
      tokens.some((t, i) => t === "-exec" && tokens[i + 1] === "shellcheck"));
}

/** Inspect command positions, keeping quoted log/data strings out of discovery. */
function executableShellCommands(body: string): string[] {
  const commands: string[] = [];
  let inArray = false;
  // A `case` arm's pattern (`shellcheck)`, `*.sh | .shellcheckrc)`) is data,
  // not a command; only what follows the `)` runs (Issue #5046).
  let caseDepth = 0;
  for (let line of body.replace(/\\\r?\n\s*/g, " ").split("\n")) {
    if (/^\s*esac\b/.test(line)) {
      caseDepth = Math.max(0, caseDepth - 1);
      continue;
    }
    if (caseDepth > 0) {
      const arm = /^\s*\(?([^()]*)\)(.*)$/.exec(line);
      if (arm) line = arm[2]!;
    }
    if (/^\s*case\s.*\sin\s*(?:#.*)?$/.test(line)) {
      caseDepth++;
      continue;
    }
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

/**
 * Whether a changed path can change what a CI cargo command builds or checks:
 * a `.rs` file, a cargo manifest or lock, a toolchain pin, or a clippy config.
 * The same set gates whether the CI cargo checks are read at all.
 */
const RUST_CONFIG_NAMES = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "clippy.toml",
  ".clippy.toml",
];

function isRustRelevant(path: string): boolean {
  if (hasExtension(path, [".rs"])) return true;
  return RUST_CONFIG_NAMES.includes(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The argv as one command line for the pre-flight tokeniser. A token holding
 * whitespace or a quote is quoted; an empty token becomes `''`. A token that
 * cannot be quoted is an error, so the push is blocked rather than waved on.
 */
function argvCommand(argv: readonly string[]): Result<string, string> {
  const parts: string[] = [];
  for (const token of argv) {
    if (token !== "" && !/[\s'"]/.test(token)) {
      parts.push(token);
      continue;
    }
    const quoted = quoteForTokeniser(token);
    if (quoted === null) {
      return {
        ok: false,
        error: `cannot safely quote CI's cargo argument ${
          JSON.stringify(token)
        } (it contains both ' and ") — the push is blocked, not waved through`,
      };
    }
    parts.push(quoted);
  }
  return { ok: true, value: parts.join(" ") };
}

/**
 * The CI cargo checks in gate order: directories keep the scan's order, and
 * within one directory the clippy run comes before the test-target compile.
 */
function cargoCheckOrder(checks: readonly CiCargoCheck[]): CiCargoCheck[] {
  const dirs = [...new Set(checks.map((c) => c.workingDirectory))];
  return dirs.flatMap((dir) => {
    const here = checks.filter((c) => c.workingDirectory === dir);
    return [
      ...here.filter((c) => c.kind === "clippy"),
      ...here.filter((c) => c.kind === "test-build"),
    ];
  });
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
 * The root-relative test files a root's `deno test` check runs: each changed
 * `_test.ts` anywhere under the root; for each changed non-test `.ts` source
 * outside `tests/`, its `tests/<name>_test.ts` sibling and its co-located
 * `<dir>/<name>_test.ts` sibling (a source under `tests/`, such as a support
 * helper, has no sibling); and the `referenced` tests
 * ({@link loadReferencedUnitTests}) whose text names a changed file. Only files
 * `tracked` still holds count, so a deleted test is not run. Deduplicated and
 * sorted.
 */
function plannedUnitTestFiles(
  rel: string[],
  tracked: string[],
  root: string,
  referenced: readonly string[],
): string[] {
  const trackedSet = new Set(tracked);
  const isTracked = (file: string) =>
    trackedSet.has(root === "." ? file : `${root}/${file}`);
  const testFiles = new Set<string>();
  for (const file of referenced) {
    if (isTracked(file)) testFiles.add(file);
  }
  for (const file of rel) {
    if (file.endsWith("_test.ts")) {
      if (isTracked(file)) testFiles.add(file);
    } else if (file.endsWith(".ts") && !file.startsWith("tests/")) {
      const base = file.slice(file.lastIndexOf("/") + 1, -".ts".length);
      const dir = file.slice(0, file.lastIndexOf("/") + 1);
      for (const sibling of [`tests/${base}_test.ts`, `${dir}${base}_test.ts`]) {
        if (isTracked(sibling)) testFiles.add(sibling);
      }
    }
  }
  // The unit runner refuses a list with no unit suite in it, and CI's unit
  // shards do not run the integration suites, so a changed one is left out.
  return [...testFiles].filter((f) => !INTEGRATION_TEST_FILES.includes(f))
    .sort();
}

/**
 * Plan the always-on changed-file format, lint and unit-test commands.
 * `denoScopes` maps a deno root to its parsed include/exclude config: explicit
 * paths override deno's own `include`, so a file the repo's `deno fmt` /
 * `deno lint` would not check is dropped here instead of being passed to deno.
 * A root with no entry is unfiltered. `denoUnitTestRoots` lists the roots
 * whose changed tests get a `deno test` check (see
 * {@link loadDenoUnitTestRoots}); absent means no `deno test` check. The check
 * runs the changed test files, the same-named and co-located tests of changed
 * sources and the `denoReferencedTests` beside them, via the repo's own
 * `test:unit` task, so
 * integration suites like CI's shards are not run here.
 *
 * `ciCargo` (Issue #4630) is the CI cargo scan. Each of its checks is planned,
 * after the cargo fmt check, when the push changes a Rust-relevant file under
 * the check's working directory (`.` is anywhere). Absent means no CI cargo
 * checks are planned. Only `runPrePushGate` supplies it, and only when its
 * caller passes `findCiCargo` (see the module header).
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
    /** Pushed paths for unit tests and markdownlint when formatting is skipped. */
    validationChanged?: string[];
    /** Deno roots whose `test:unit` task the changed tests run through. */
    denoUnitTestRoots?: string[];
    /**
     * Per deno root, the root-relative tests whose text names a changed file
     * (see {@link loadReferencedUnitTests}); they run beside the changed tests.
     */
    denoReferencedTests?: Record<string, string[]>;
    /**
     * Deno roots whose whole `test:unit` suite runs, with no file list (see
     * {@link needsFullUnitSuite} and {@link unfollowableImportRoots}); it covers
     * the changed and referenced tests.
     */
    denoFullUnitRoots?: string[];
    /** The cargo clippy and test-target commands CI runs (Issue #4630). */
    ciCargo?: CiCargoScan;
    /**
     * The changed files the CI cargo checks are planned from. Defaults to
     * `changed`; the gate passes the list that keeps a file reached through a
     * symlinked parent directory, so a crate directory that resolves outside the
     * checkout is refused rather than skipped (Issue #4630).
     */
    cargoChanged?: string[];
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
    if (opts.denoUnitTestRoots?.includes(root)) {
      if (opts.denoFullUnitRoots?.includes(root)) {
        checks.push({
          label: `deno test (${root})`,
          cwd: dirCwd(root),
          command: "deno task test:unit",
          denoTestRoot: root,
        });
        continue;
      }
      const unitTestFiles = plannedUnitTestFiles(
        (opts.validationChanged ?? changed)
          .filter((p) => root === "." || p.startsWith(`${root}/`))
          .map((p) => root === "." ? p : p.slice(root.length + 1)),
        tracked,
        root,
        opts.denoReferencedTests?.[root] ?? [],
      );
      if (unitTestFiles.length > 0) {
        const quoted = quoteAll(unitTestFiles);
        if (!quoted.ok) return quoted;
        checks.push({
          label: `deno test (${root})`,
          cwd: dirCwd(root),
          command: `deno task test:unit ${quoted.value}`,
          denoTestRoot: root,
        });
      }
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

  const markdown = (opts.validationChanged ?? changed).filter((p) =>
    hasExtension(p, MARKDOWN_EXTENSIONS)
  );
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

  const seenCargo = new Set<string>();
  const cargoChanged = opts.cargoChanged ?? changed;
  for (const check of cargoCheckOrder(opts.ciCargo?.checks ?? [])) {
    const dir = check.workingDirectory;
    const touched = cargoChanged.some((p) =>
      isRustRelevant(p) && (dir === "." || p.startsWith(`${dir}/`))
    );
    if (!touched) continue;
    const command = argvCommand(check.argv);
    if (!command.ok) return command;
    const cwd = dirCwd(dir);
    const key = JSON.stringify([cwd, command.value, check.env]);
    if (seenCargo.has(key)) continue;
    seenCargo.add(key);
    const toolchain = check.argv[1]?.startsWith("+")
      ? check.argv[1].slice(1)
      : undefined;
    checks.push({
      label: `${
        check.kind === "clippy" ? "cargo clippy" : "cargo test --no-run"
      } (${dir})`,
      cwd,
      command: command.value,
      env: check.env,
      cargo: {
        kind: check.kind,
        ...(toolchain === undefined ? {} : { toolchain }),
      },
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
 * tree. An unreadable or unparseable config leaves formatting unfiltered;
 * unit-test discovery separately refuses such a config before validation.
 * A symlink anywhere in the path, or a file over the size cap, is unreadable.
 */
export async function loadDenoScopes(
  repoRoot: string,
  tracked: string[],
): Promise<Record<string, DenoScopeConfig>> {
  const scopes: Record<string, DenoScopeConfig> = {};
  for (
    const root of outermostConfigDirs(tracked, ["deno.json", "deno.jsonc"])
  ) {
    const config = await readDenoConfigText(repoRoot, root, false);
    if (config === null) continue;
    const parsed = parseDenoScope(config.text);
    if (parsed !== null) scopes[root] = parsed;
  }
  return scopes;
}

/**
 * A deno root's config: `deno.json`, else `deno.jsonc`. Scope discovery may
 * ignore an unreadable file; unit-test discovery refuses it, so an unreadable
 * primary config cannot silently select the secondary config. Missing files
 * may fall through on both paths; null means neither config could be read.
 */
async function readDenoConfigText(
  repoRoot: string,
  root: string,
  refuseUnreadable: boolean,
): Promise<{ path: string; text: string } | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = root === "." ? name : `${root}/${name}`;
    try {
      return { path, text: await readRepoFile(repoRoot, path) };
    } catch (error) {
      if (refuseUnreadable && !(error instanceof Deno.errors.NotFound)) {
        throw new Error(`cannot read ${path}; unit tests were not checked`, {
          cause: error,
        });
      }
    }
  }
  return null;
}

/** Whether a deno.json(c) document's `tasks` object defines `test:unit`. */
function definesUnitTestTask(text: string, path: string): boolean {
  const stripped = stripJsonc(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`cannot parse ${path}; unit tests were not checked`);
  }
  if (parsed === null) return false;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`cannot parse ${path}; unit tests were not checked`);
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (tasks === undefined || tasks === null) return false;
  if (typeof tasks !== "object" || Array.isArray(tasks)) {
    throw new Error(
      `cannot read task definitions in ${path}; unit tests were not checked`,
    );
  }
  return Object.hasOwn(tasks, "test:unit");
}

/**
 * The deno roots whose config defines a `test:unit` task (Issue #4930), so the
 * gate can run the repo's own unit suite for changed tests. Root discovery
 * matches {@link loadDenoScopes}. An unreadable or unparseable config, or a
 * `tasks` value that is neither an object nor null, throws rather than silently
 * dropping its tests.
 * Missing configs and valid configs without `test:unit` remain ineligible.
 */
export async function loadDenoUnitTestRoots(
  repoRoot: string,
  tracked: string[],
): Promise<string[]> {
  const roots: string[] = [];
  for (
    const root of outermostConfigDirs(tracked, ["deno.json", "deno.jsonc"])
  ) {
    const config = await readDenoConfigText(repoRoot, root, true);
    if (config === null) continue;
    if (definesUnitTestTask(config.text, config.path)) roots.push(root);
  }
  return roots;
}

/**
 * Strings whose presence in a test's source marks it as reading `file` (a
 * repo-relative path): its base name when no other tracked file shares it
 * (else its last two segments), and, for a non-`.ts` file such
 * as a doc or prompt, its directory followed by `/` (a test that lists it) and
 * each ancestor directory followed by `/${` so a path built in a template
 * literal is caught. A deliberate over-approximation: running an
 * unrelated test costs time, missing a reader lets a break reach CI.
 */
function referenceTokens(
  file: string,
  basenameCounts: ReadonlyMap<string, number>,
): string[] {
  const parts = file.split("/");
  const base = parts[parts.length - 1] as string;
  // The last two segments (or the base name) are a substring of the path, so a
  // text naming the whole path matches them too and the path needs no token.
  const tokens = [
    basenameCounts.get(base) === 1 ? base : parts.slice(-2).join("/"),
  ];
  if (!file.endsWith(".ts")) {
    // A test that lists the directory names neither the file nor a template.
    if (parts.length > 1) tokens.push(`${parts.slice(0, -1).join("/")}/`);
    for (let i = 1; i < parts.length; i++) {
      tokens.push(`${parts.slice(0, i).join("/")}/\${`);
    }
  }
  return tokens;
}

/** The `./x.ts` / `../x.ts` module specifiers quoted in a TypeScript source. */
function relativeTsSpecifiers(text: string): string[] {
  return [...text.matchAll(/["'`](\.{1,2}\/[^"'`\s]+\.ts)["'`]/g)].map((m) =>
    m[1] as string
  );
}

/** `specifier` resolved against the directory of `from`, both tracked paths. */
function resolveSpecifier(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/**
 * Per deno root, the root-relative `_test.ts` files a change can break (Issue
 * #4930), wherever they live under the root, so a change to a source, doc or
 * prompt runs the tests that depend on it, not only a same-named one. A
 * TypeScript file under the root is a seed when it is changed, or when it is a
 * `_test.ts` or sits under `tests/` and its text names a changed file (see
 * {@link referenceTokens}) or calls `loadPrompt` with the changed prompt's
 * literal type; a test is selected when it is a seed or imports one, directly
 * or through other files (relative `.ts` specifiers). Changed tests themselves
 * are left out (they run anyway). A tracked file that cannot be read is
 * skipped.
 */
export async function loadReferencedUnitTests(
  repoRoot: string,
  tracked: string[],
  changed: string[],
  roots: string[],
): Promise<Record<string, string[]>> {
  const basenameCounts = new Map<string, number>();
  for (const path of tracked) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const tokens = [
    ...new Set(
      changed.filter((p) => !p.endsWith("_test.ts")).flatMap((p) =>
        referenceTokens(p, basenameCounts)
      ),
    ),
  ];
  const promptTypes = new Set(changed.flatMap((path) => {
    const match = /(?:^|\/)prompts\/([^/]+)\/prompt\.md$/.exec(path);
    return match ? [match[1]!] : [];
  }));
  const referenced: Record<string, string[]> = {};
  if (tokens.length === 0) return referenced;
  for (const root of roots) {
    const prefix = root === "." ? "" : `${root}/`;
    const importers = new Map<string, string[]>();
    const seeds = new Set(changed);
    const testPaths: string[] = [];
    for (const path of tracked) {
      if (!path.startsWith(prefix) || !path.endsWith(".ts")) continue;
      let text: string;
      try {
        text = await readRepoFile(repoRoot, path);
      } catch {
        continue; // Deleted, a symlink or unreadable: nothing to run.
      }
      for (const specifier of relativeTsSpecifiers(text)) {
        const target = resolveSpecifier(path, specifier);
        importers.set(target, [...(importers.get(target) ?? []), path]);
      }
      const isTest = path.endsWith("_test.ts");
      if (isTest) testPaths.push(path);
      // Only the test tree and the tests are read for names: a source that
      // merely quotes a doc path in a message depends on nothing, and one that
      // does read it has a test that names it.
      if (!isTest && !path.startsWith(`${prefix}tests/`)) continue;
      // Prompt readers pass a type to loadPrompt rather than spelling its path.
      // This is a conservative dependency scan: a quoted example may select an
      // extra test, but never exempts a real loader call.
      const loadsPrompt = [
        ...text.matchAll(/\bloadPrompt\s*\(\s*["'`]([^"'`]+)["'`]/g),
      ]
        .some((match) => promptTypes.has(match[1]!));
      if (tokens.some((t) => text.includes(t)) || loadsPrompt) seeds.add(path);
    }
    const reached = new Set(seeds);
    const queue = [...seeds];
    for (const file of queue) {
      for (const importer of importers.get(file) ?? []) {
        if (!reached.has(importer)) {
          reached.add(importer);
          queue.push(importer);
        }
      }
    }
    referenced[root] = testPaths
      .filter((t) => reached.has(t) && !changed.includes(t))
      .map((t) => t.slice(prefix.length));
  }
  return referenced;
}

/**
 * A dynamic `import` call whose argument is neither a plain string literal nor
 * a template literal without a substitution, so the module it loads cannot be
 * read from the source. Each alternative starts with a different character,
 * so the match cannot backtrack exponentially on a long run of spaces.
 */
const COMPUTED_DYNAMIC_IMPORT =
  /\bimport\s*\((?!\s*(?:"[^"\n]*"|'[^'\n]*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`)\s*[,)])/;

/**
 * Whether a deno.json(c) maps an import specifier, in `imports` or in a
 * `scopes` entry, to a local path. An unparseable config counts: its aliases
 * are unknown.
 */
function declaresLocalImportTarget(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const { imports, scopes } = parsed as { imports?: unknown; scopes?: unknown };
  const mapTargets = (map: unknown): unknown[] =>
    typeof map === "object" && map !== null ? Object.values(map) : [];
  return [...mapTargets(imports), ...mapTargets(scopes).flatMap(mapTargets)]
    .some((target) =>
      typeof target === "string" && /^(?:\.{1,2}\/|\/|file:)/.test(target)
    );
}

/**
 * The roots among `roots` whose module graph the relative-specifier scan of
 * {@link loadReferencedUnitTests} cannot follow, so the root's whole
 * `test:unit` suite must run (Issue #4930). A root is one when its config maps
 * an import specifier to a local path (`./`, `../`, `/` or `file:`) in
 * `imports` or `scopes`, or when a tracked `.ts` under it has a computed
 * dynamic import call (see {@link COMPUTED_DYNAMIC_IMPORT}). This is a text
 * match, so a comment or string that spells such a call also counts: it
 * over-selects the whole suite, which fails closed. A tracked file that cannot
 * be read is skipped, as in {@link loadReferencedUnitTests}.
 */
export async function unfollowableImportRoots(
  repoRoot: string,
  tracked: string[],
  roots: string[],
): Promise<string[]> {
  const unfollowable: string[] = [];
  for (const root of roots) {
    const prefix = root === "." ? "" : `${root}/`;
    const config = await readDenoConfigText(repoRoot, root, false);
    if (config !== null && declaresLocalImportTarget(config.text)) {
      unfollowable.push(root);
      continue;
    }
    for (const path of tracked) {
      if (!path.startsWith(prefix) || !path.endsWith(".ts")) continue;
      let text: string;
      try {
        text = await readRepoFile(repoRoot, path);
      } catch {
        continue; // Deleted, a symlink or unreadable: nothing to read.
      }
      if (COMPUTED_DYNAMIC_IMPORT.test(text)) {
        unfollowable.push(root);
        break;
      }
    }
  }
  return unfollowable;
}

/**
 * Whether a push touches a file whose readers a name scan cannot find, so the
 * root's whole `test:unit` suite runs instead of a selected list (PR #5034
 * review): anything under a `prompts/` directory (a test reaches a prompt
 * through a loader or a prompt builder, not by spelling its path) and the
 * root's own `deno.json`, `deno.jsonc` or `deno.lock` (every test depends on
 * them). `paths` should include deleted paths.
 */
export function needsFullUnitSuite(
  paths: readonly string[],
  root: string,
): boolean {
  const prefix = root === "." ? "" : `${root}/`;
  return paths.some((p) =>
    /(?:^|\/)prompts\//.test(p) ||
    (p.startsWith(prefix) &&
      ["deno.json", "deno.jsonc", "deno.lock"].includes(p.slice(prefix.length)))
  );
}

/**
 * The commit a push forked from, where a `deno test` failure is compared.
 *
 * With `compareRef` (the PR's base) it is the merge-base of the pushed heads
 * and that ref: the point the PR left its base, or the base commit a later
 * merge brought in. A repair push must not compare against the PR's own
 * previous head, where a test the repair leaves red is red too. Without a
 * `compareRef` it is the parent of the oldest commit not already on a remote.
 * A shallow checkout is deepened first (`ensureHistoryDepth`). Null when the
 * fork still cannot be found, for example the deepen failed: the comparison is
 * then unavailable and the failure blocks.
 */
async function pushForkCommit(
  refs: readonly PrePushRef[],
  cwd: string,
  git: PrePushGit,
  compareRef?: string,
): Promise<string | null> {
  if (refs.length === 0) return null;
  if (
    compareRef !== undefined &&
    (compareRef === "" || compareRef.startsWith("-"))
  ) {
    return null;
  }
  if (compareRef !== undefined) {
    // The worker's clones are `--depth=1`: deepen until the heads meet the
    // base before asking for their merge-base (a no-op on a full clone). A
    // deepen that fails leaves the baseline unavailable, as a missing
    // merge-base does.
    const deepened = await ensureHistoryDepth(
      [compareRef, ...refs.map((r) => r.localSha)],
      {
        // The runner pins every git call to `cwd`; no `cwd` option is needed.
        gitRunner: async (args) => ({ ok: true, value: await git(args, cwd) }),
      },
    );
    if (!deepened.ok) return null;
    const mergeBase = await git(
      ["merge-base", compareRef, ...refs.map((r) => r.localSha)],
      cwd,
    );
    const sha = mergeBase.stdout.split("\n")[0]?.trim() ?? "";
    return mergeBase.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }
  const oldest = await git(
    [
      "rev-list",
      "--reverse",
      ...refs.map((r) => r.localSha),
      "--not",
      "--remotes",
    ],
    cwd,
  );
  const first = oldest.stdout.split("\n")[0]?.trim();
  if (oldest.code !== 0 || !first) return null;
  const parent = await git(["rev-parse", "--verify", `${first}^`], cwd);
  const sha = parent.stdout.trim();
  return parent.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
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
 * is not blocked by cspell, since its required CI never runs it. A symlink
 * anywhere in the path, or a file over the size cap, is unreadable and skipped.
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
      text = await readRepoFile(repoRoot, path);
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
async function touchesShellcheckSurface(
  root: string,
  changed: readonly string[],
): Promise<boolean> {
  for (const p of changed) {
    const name = p.split("/").at(-1) ?? "";
    if (
      /\.(?:sh|bash|ksh|zsh|shlib)$/.test(p) || ACTION_SHELL_NAMES.has(name) ||
      SHELLCHECK_CONFIGS.has(name)
    ) return true;
    if (!name.includes(".")) {
      try {
        const info = await shellcheckFileInfo(root, p);
        if (info?.isFile && await actionShellcheckFile(root, p, info)) {
          return true;
        }
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof Deno.errors.NotADirectory)
        ) throw error;
      }
    }
  }
  return false;
}

const ACTION_SHELL_NAMES = new Set([
  ".bashrc",
  "bashrc",
  ".bash_aliases",
  ".bash_completion",
  ".bash_login",
  ".bash_logout",
  ".bash_profile",
  "bash_profile",
  "suid_profile",
  ".zlogin",
  "zlogin",
  ".zlogout",
  "zlogout",
  ".zprofile",
  "zprofile",
  ".zsenv",
  "zsenv",
  ".zshrc",
  "zshrc",
  ".profile",
  "profile",
]);

async function actionShellcheckFile(
  root: string,
  path: string,
  info: Deno.FileInfo,
): Promise<boolean> {
  const name = path.split("/").at(-1)!;
  if (
    path.split("/").includes(".git") || path.endsWith(".go") || name === "mvnw"
  ) return false;
  if (
    /\.(?:sh|bash|ksh|zsh|shlib)$/.test(name) || ACTION_SHELL_NAMES.has(name)
  ) return true;
  if (name.includes(".") || !((info.mode ?? 0) & 0o111)) return false;
  const file = await Deno.open(`${root}/${path}`, { read: true });
  try {
    const bytes = new Uint8Array(4096);
    const count = await file.read(bytes);
    return /^#! *\/[^ ]*\/(?:env *)?[abk]*sh/.test(
      new TextDecoder().decode(bytes.subarray(0, count ?? 0)).split("\n")[0]!,
    );
  } finally {
    file.close();
  }
}

async function shellcheckFileInfo(
  cwd: string,
  path: string,
): Promise<Deno.FileInfo | null> {
  const parts = path.split("/");
  let current = cwd;
  for (const [index, part] of parts.entries()) {
    current += `/${part}`;
    const info = await Deno.lstat(current);
    if (info.isSymlink) return null;
    if (index === parts.length - 1) return info;
    if (!info.isDirectory) return null;
  }
  return null;
}

const MAX_POLICY_BYTES = 1024 * 1024;

async function readBoundedPolicyFile(
  root: string,
  path: string,
  info: Deno.FileInfo,
): Promise<string> {
  if (!info.isFile || info.size > MAX_POLICY_BYTES) {
    throw new Error("not a regular file or exceeds policy size limit");
  }
  const file = await Deno.open(`${root}/${path}`, { read: true });
  try {
    const bytes = new Uint8Array(MAX_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = await file.read(bytes.subarray(length));
      if (count === null) break;
      length += count;
    }
    if (length > MAX_POLICY_BYTES) throw new Error("exceeds policy size limit");
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    file.close();
  }
}

/**
 * Shared ShellCheck validation for hooks, completion and repair publication.
 * A policy the gate cannot read blocks only a push that touches a script, a
 * ShellCheck config or a ShellCheck workflow; any other push has nothing ShellCheck
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
  const changedWorkflows = opts.changed.filter((path) =>
    path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path) &&
    opts.tracked.includes(path)
  );
  let shellcheckWorkflowChanged = false;
  for (const path of changedWorkflows) {
    const policy = await repoShellcheckPolicy(opts.cwd, [
      path,
      ...opts.tracked.filter((p) => !p.startsWith(".github/workflows/")),
    ]);
    if (!policy.ok || policy.value !== null) shellcheckWorkflowChanged = true;
  }
  const delegations = await shellcheckDelegations(opts.cwd, opts.tracked);
  if (delegations.ok && delegations.value.length > 0) {
    // Issue #5046: CI runs ShellCheck through the repository's own script,
    // so run that script here exactly as CI does. A finding fails the push
    // as a lint failure; only a missing ShellCheck is infrastructure.
    let touched: boolean;
    try {
      touched = shellcheckWorkflowChanged ||
        await touchesShellcheckSurface(opts.cwd, opts.changed);
    } catch (error) {
      return infrastructureFail(
        `cannot inspect changed ShellCheck file: ${error}`,
      );
    }
    if (!touched) return { ok: true, value: { checksRun: [] } };
    const find = opts.findShellcheck ??
      ((_root: string) => findShellcheckBinary(Deno.env.get("PATH") ?? ""));
    if (!await find(opts.cwd)) {
      return infrastructureFail(
        "ShellCheck is required by repository CI but could not be found",
      );
    }
    const checksRun: string[] = [];
    const seenSteps = new Set<string>();
    for (const { workflow, step } of delegations.value) {
      if (seenSteps.has(step)) continue;
      seenSteps.add(step);
      // Written outside the checkout and run as GitHub runs a `run:` step.
      const script = await Deno.makeTempFile({ suffix: ".sh" });
      try {
        await Deno.writeTextFile(script, `${step}\n`);
        const command = `bash --noprofile --norc -eo pipefail ${script}`;
        const result = await runPreFlightGate([command], {
          cwd: opts.cwd,
          runner: opts.runner,
          timeoutSeconds: opts.timeoutSeconds,
        });
        if (!result.ok) return result;
      } finally {
        await Deno.remove(script).catch(() => {});
      }
      checksRun.push(`ShellCheck step of ${workflow}`);
    }
    return { ok: true, value: { checksRun } };
  }
  if (!shellcheckPolicy.ok || !delegations.ok) {
    const error = !delegations.ok
      ? delegations.error
      : !shellcheckPolicy.ok
      ? shellcheckPolicy.error
      : "";
    try {
      return await touchesShellcheckSurface(opts.cwd, opts.changed) ||
          shellcheckWorkflowChanged
        ? infrastructureFail(error)
        : { ok: true, value: { checksRun: [] } };
    } catch (error) {
      return infrastructureFail(
        `cannot inspect changed ShellCheck file: ${error}`,
      );
    }
  }
  const shellcheckTouchedConfigs =
    opts.changed.some((p) =>
      SHELLCHECK_CONFIGS.has(p.split("/").at(-1) ?? "") ||
      shellcheckPolicy.value?.configFiles.includes(p)
    ) || shellcheckWorkflowChanged;
  const shellcheckFiles = shellcheckPolicy.value
    ? (shellcheckTouchedConfigs ? opts.tracked : opts.changed)
    : [];
  const existingShellcheckFiles: string[] = [];
  for (const path of shellcheckFiles) {
    try {
      const info = await shellcheckFileInfo(opts.cwd, path);
      if (
        info?.isFile &&
        (shellcheckPolicy.value?.version === null
          ? await actionShellcheckFile(opts.cwd, path, info)
          : path.endsWith(".sh"))
      ) {
        existingShellcheckFiles.push(path);
      }
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) continue;
      return infrastructureFail(
        `cannot inspect changed ShellCheck file ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (shellcheckPolicy.value && existingShellcheckFiles.length > 0) {
    for (const path of shellcheckPolicy.value.configFiles) {
      try {
        const info = await shellcheckFileInfo(opts.cwd, path);
        if (!info?.isFile) {
          return infrastructureFail(
            `cannot read ShellCheck configuration ${path}: not a regular file`,
          );
        }
        await readBoundedPolicyFile(opts.cwd, path, info);
      } catch (error) {
        return infrastructureFail(
          `cannot read ShellCheck configuration ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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

/**
 * The first line of a command's output that is not blank, for a message.
 */
function firstOutputLine(output: string): string {
  return output.split("\n").map((line) => line.trim()).find((line) =>
    line !== ""
  ) ?? "(no output)";
}

/**
 * Why a CI cargo check's working directory may not be used: it is missing, or
 * it resolves (through a symlink, say) outside the repository. Both paths are
 * resolved fully before the comparison. Null when it is the repository or
 * inside it.
 */
async function cwdEscape(
  repoRoot: string,
  cwd: string,
): Promise<string | null> {
  let root: string;
  let dir: string;
  try {
    root = await Deno.realPath(repoRoot);
    dir = await Deno.realPath(cwd);
  } catch {
    return `working directory ${cwd} is missing or cannot be resolved`;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (dir === root || dir.startsWith(prefix)) return null;
  return `working directory ${cwd} resolves outside the repository`;
}

/**
 * A line of tool output that quotes source or annotates a diagnostic, rather
 * than reporting the tool's own failure: a gutter line (`12 |  code` or a bare
 * `  |`), a `-->` location, or a `= note` / `= help` annotation. Each test is
 * anchored and linear in the line length.
 */
function isQuotedSourceLine(line: string): boolean {
  const trimmed = line.trim();
  return /^\d*\s*\|/.test(trimmed) || trimmed.startsWith("-->") ||
    trimmed.startsWith("= note") || trimmed.startsWith("= help");
}

/**
 * Whether one line of cargo, rustc or rustup output says that the toolchain,
 * component or target the command asked for is not installed here. That is the
 * host's state, not a verdict on the commit. The tests are anchored on the
 * line start, use `includes` and run once per line, so they are linear.
 */
function isMissingRustCapabilityLine(line: string): boolean {
  const text = line.trim();
  if (text.startsWith("error:")) {
    return text.includes("is not installed") ||
      text.includes("rustup could not choose a version") ||
      text.includes("is not applicable to the") ||
      text.includes("unavailable for download") ||
      text.includes("does not support target");
  }
  // rustc's own note when the standard library of a `--target` is absent.
  return text.startsWith("= note:") &&
    text.includes("target may not be installed");
}

/**
 * Whether a failed CI cargo check reflects the host rather than the commit: the
 * command could not start or timed out, or it exited non-zero with host
 * disk-full output, with output saying the toolchain, component or target is
 * not installed, or with a cargo registry or git-dependency network refusal.
 * Disk-full text counts only in the tool's own lines, so a source excerpt that
 * quotes it does not turn a lint failure into a host fault. The disk-full test
 * is `isHostDiskFaultText` in `host_fault.ts`; the network test is
 * {@link cargoNetworkFaultLine}.
 */
function cargoNetworkFaultLine(lines: string[]): string | undefined {
  return lines.find((line) =>
    !isQuotedSourceLine(line) &&
    /^(?:(?:warning|error): )?spurious network error|^(?:\[\d+\] )?(?:fatal: unable to access|failed to download|download of config\.json failed|Could not resolve host|Couldn't resolve host|Couldn't connect|failed to connect|Network is unreachable|Connection (?:refused|timed out|reset))/i
      .test(line.trim())
  )?.trim().replace(/\/\/[^\s/@]+@/g, "//***@");
}

function isHostFaultOfCheck(error: PreFlightGateError): boolean {
  if (error.reason === "not-started" || error.reason === "timeout") return true;
  if (error.reason !== "non-zero-exit") return false;
  const lines = error.output.split("\n");
  if (lines.some(isMissingRustCapabilityLine)) return true;
  const toolLines = lines.filter((line) => !isQuotedSourceLine(line));
  if (cargoNetworkFaultLine(toolLines) !== undefined) return true;
  return isHostDiskFaultText(toolLines.join("\n"));
}

/**
 * Probes the Rust toolchain of every CI cargo check before any of them runs:
 * one `cargo [+toolchain] --version` per distinct directory, toolchain and env,
 * and `cargo [+toolchain] clippy --version` where a clippy check uses that
 * toolchain. Returns why the toolchain is unavailable, or null when every probe
 * passed. A directory that is missing or leaves the repository is reported the
 * same way. A `--target` is not probed here: rustc names a missing one in its
 * own output, which {@link isHostFaultOfCheck} reads.
 */
async function probeCargoToolchains(
  cargoChecks: readonly ChangedFileCheck[],
  opts: {
    cwd: string;
    runner?: PreFlightRunner;
    timeoutSeconds?: number;
  },
): Promise<string | null> {
  const groups = new Map<
    string,
    { check: ChangedFileCheck; clippy: boolean }
  >();
  for (const check of cargoChecks) {
    const escape = await cwdEscape(opts.cwd, check.cwd);
    if (escape !== null) {
      return `CI's ${check.label} cannot run here: ${escape}`;
    }
    const key = JSON.stringify([
      check.cwd,
      check.cargo?.toolchain ?? null,
      Object.entries(check.env ?? {}).sort(),
    ]);
    const group = groups.get(key) ?? { check, clippy: false };
    if (check.cargo?.kind === "clippy") group.clippy = true;
    groups.set(key, group);
  }
  for (const { check, clippy } of groups.values()) {
    const toolchain = check.cargo?.toolchain === undefined
      ? []
      : [`+${check.cargo.toolchain}`];
    const probes = [["cargo", ...toolchain, "--version"]];
    if (clippy) probes.push(["cargo", ...toolchain, "clippy", "--version"]);
    const probe = await runPreFlightGate(
      probes.map((argv) => argv.join(" ")),
      {
        cwd: check.cwd,
        env: check.env,
        runner: opts.runner,
        timeoutSeconds: opts.timeoutSeconds,
      },
    );
    if (!probe.ok) {
      const how = probe.error.reason === "not-started"
        ? "could not be started"
        : probe.error.reason === "timeout"
        ? "timed out"
        : `exited ${probe.error.exitCode}`;
      return `Rust toolchain unavailable here: \`${probe.error.command}\` ${how}: ${
        firstOutputLine(probe.error.output)
      }`;
    }
  }
  return null;
}

/** A git ref that is safe to hand to `git` as a revision: no option, no `..`. */
const SAFE_COMPARE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/**
 * The error-level diagnostics of a failed cargo run, each as `message @ file`
 * (the line number is dropped, since a push moves lines), or the message alone
 * when no `-->` location follows, with how many times it appears. Summary
 * lines that count other diagnostics are left out so the counts do not depend
 * on them.
 *
 * Warning lines are left out (Issue #4630 review): a warning never fails a CI
 * cargo command (under `-D warnings` the lint is already printed as `error:`),
 * so a warning the push adds, or cargo's own `warning: build failed, waiting
 * for other jobs to finish...`, must not turn a failure the base already has
 * into a verdict on the push.
 */
function diagnosticSignatures(output: string): Map<string, number> {
  const found = new Map<string, number>();
  const lines = output.split("\n").map((line) => line.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const head = /^error(?:\[[A-Za-z0-9]{1,20}\])?: /.exec(line);
    if (head === null) continue;
    const message = line.slice(head[0].length);
    if (
      message.includes("could not compile") ||
      message.startsWith("aborting due to") ||
      message.includes(" generated ") || message.includes("previous error")
    ) continue;
    const next = lines[i + 1] ?? "";
    const file = next.startsWith("-->")
      ? next.slice(3).trim().split(":")[0] ?? ""
      : "";
    const key = file === "" ? message : `${message} @ ${file}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return found;
}

/**
 * The commit the checked-out head forked from `tip`: `git merge-base HEAD tip`,
 * after deepening a shallow checkout until the two share an ancestor. `null`
 * when it cannot be established (no common ancestor, or history that cannot be
 * fetched), which the caller treats as unknown, never as a pass.
 */
async function baseCommitOfHead(
  git: PrePushGit,
  repoRoot: string,
  tip: string,
): Promise<string | null> {
  const deepened = await ensureHistoryDepth(["HEAD", tip], { cwd: repoRoot });
  if (!deepened.ok) return null;
  const mergeBase = await git(["merge-base", "HEAD", tip], repoRoot);
  const sha = mergeBase.stdout.trim();
  return mergeBase.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * Whether a CI cargo check that failed on this push fails on the PR base too,
 * with every diagnostic the push shows, no more often than the base (Issue
 * #4630 review: a failure the base already has is not this repair's defect).
 * The check runs again, as CI wrote it, in a detached worktree of `ref`.
 *
 * The push is compared with the refreshed tip of `ref` and, when the checked-out
 * head forked from an older commit, with that fork point too (the base merge
 * comes after this gate, so a failure the head inherited and the tip has since
 * fixed is the base's). Returns `"same"` when either fails with every
 * diagnostic the push shows (matched by message, file and count; not line),
 * `"different"` when neither does (the base passes, lacks the check directory
 * or lacks a diagnostic the push shows), and
 * `"unknown"` when neither can
 * be established: an unsafe or unresolvable ref, a push output with no readable
 * diagnostic, a working directory outside the repo, a worktree that cannot be
 * made, a remote base fetch that fails, or a base run that times out, cannot
 * start or fails for the host. Remote base refs are refreshed before resolution.
 * Callers turn `"unknown"` into an infrastructure fault, never a verdict.
 *
 * SIMPLE-ON-PURPOSE: a diagnostic is matched by message, file and count, not line — upgrade when a moved instance of a repeated diagnostic must be told from a new one
 */
async function failsOnBaseToo(args: {
  repoRoot: string;
  ref: string;
  check: ChangedFileCheck;
  headOutput: string;
  git: PrePushGit;
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
}): Promise<"same" | "different" | "unknown"> {
  if (!SAFE_COMPARE_REF.test(args.ref) || args.ref.includes("..")) {
    return "unknown";
  }
  const headSignatures = diagnosticSignatures(args.headOutput);
  if (headSignatures.size === 0) return "unknown";
  const prefix = args.repoRoot.endsWith("/")
    ? args.repoRoot
    : `${args.repoRoot}/`;
  const relative = args.check.cwd === args.repoRoot
    ? ""
    : args.check.cwd.startsWith(prefix)
    ? args.check.cwd.slice(prefix.length)
    : null;
  if (relative === null) return "unknown";
  // Repair checkouts may have fetched only the PR head. Refresh the base
  // before comparing; a stale tracking ref is not evidence about today's base.
  const remoteBranch = args.ref.startsWith("refs/remotes/origin/")
    ? args.ref.slice("refs/remotes/origin/".length)
    : args.ref.startsWith("origin/")
    ? args.ref.slice("origin/".length)
    : undefined;
  if (remoteBranch !== undefined) {
    const fetched = await args.git(
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`,
      ],
      args.repoRoot,
    );
    if (fetched.code !== 0) return "unknown";
  }
  const resolved = await args.git(
    ["rev-parse", "--verify", "--quiet", `${args.ref}^{commit}`],
    args.repoRoot,
  );
  const sha = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return "unknown";

  const runOnCommit = async (
    sha: string,
  ): Promise<"same" | "different" | "unknown"> => {
    const scratch = await Deno.makeTempDir({ prefix: "vibe-base-check-" });
    const tree = `${scratch}/tree`;
    let added = false;
    try {
      const add = await args.git(
        ["worktree", "add", "--detach", tree, sha],
        args.repoRoot,
      );
      if (add.code !== 0) return "unknown";
      added = true;
      const baseCwd = relative === "" ? tree : `${tree}/${relative}`;
      try {
        if (!(await Deno.stat(baseCwd)).isDirectory) return "different";
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return "different";
        return "unknown";
      }
      const base = await runPreFlightGate([args.check.command], {
        cwd: baseCwd,
        env: args.check.env,
        runner: args.runner,
        timeoutSeconds: args.timeoutSeconds,
      });
      if (base.ok) return "different";
      if (base.error.reason !== "non-zero-exit") return "unknown";
      if (isHostFaultOfCheck(base.error)) return "unknown";
      const baseSignatures = diagnosticSignatures(base.error.output);
      return [...headSignatures].every(([sig, count]) =>
          count <= (baseSignatures.get(sig) ?? 0)
        )
        ? "same"
        : "different";
    } finally {
      if (added) {
        const removed = await args.git(
          ["worktree", "remove", "--force", tree],
          args.repoRoot,
        );
        if (removed.code !== 0) {
          console.warn(
            `[PRE_PUSH_WARNING] could not remove the base worktree ${tree}: ${
              firstOutputLine(removed.stderr)
            }`,
          );
        }
      }
      await Deno.remove(scratch, { recursive: true });
    }
  };

  const atTip = await runOnCommit(sha);
  if (atTip === "same") return "same";
  // The pushed head may have been built on an older base than the refreshed
  // tip (the base merge comes after this gate), so a failure it inherited and
  // the base has since fixed is the base's, not this repair's.
  const forkPoint = await baseCommitOfHead(args.git, args.repoRoot, sha);
  if (forkPoint === null) return atTip === "different" ? "unknown" : atTip;
  if (forkPoint === sha) return atTip;
  const atForkPoint = await runOnCommit(forkPoint);
  if (atForkPoint === "same") return "same";
  return atTip === "unknown" || atForkPoint === "unknown"
    ? "unknown"
    : "different";
}

/**
 * Run the pre-push gate: the always-on changed-file checks first (cargo fmt
 * among them), then the CI cargo checks (Issue #4630) when a Rust-relevant file
 * changed, then the repo's `cargo deny check` (Issue #4626), then the repo's
 * pre-flight commands. `checksRun` lists the changed-file, CI cargo and
 * cargo-deny commands run.
 * The changed-file checks run whatever the run
 * budget — they are never skipped; all but the Floci deploy test and the
 * `deno test` run are fast. Any git, parse or planning error is an `Err`, never
 * a pass. A `deno test` run that could not fetch a module is a
 * {@link PrePushGateInfrastructureError}. A `deno test` failure that the push's
 * fork commit shares (same test, same file) is a `[PRE_PUSH_WARNING]` line, not
 * an `Err`, when every failure of the run is accounted for (see
 * `deno_test_baseline.ts`).
 *
 * The CI cargo checks are read from the repo's pull-request workflows by
 * `findCiCargo`, which is opt-in with no default: a caller that does not pass it
 * gets no CI cargo check, planned or run. The agent's own pre-push hook passes
 * it too, from a scan the worker precomputes into the hook spec before the agent
 * runs, so the hook never imports the workflow scanner (`ci_cargo_checks.ts`
 * and its bare `@std/yaml/parse` specifier) itself — it still reaches a YAML
 * parser through `cargo_deny_gate.ts`; the worker's gates in `git_push.ts` pass it directly. When the scan holds a
 * command that cannot be reproduced here (including a scan the worker could not
 * produce before the agent ran), the push fails with a
 * {@link PrePushGateInfrastructureError}. Before the first CI cargo command
 * runs, every distinct Rust toolchain the plan uses is probed (`cargo +T
 * --version`, and `cargo +T clippy --version` for a clippy check). A CI cargo
 * command that fails to start, times out, fails with host disk-full output,
 * fails with a cargo registry or git-dependency network refusal, or fails with
 * rustup or rustc output saying its toolchain, component or `--target` is not
 * installed is also an infrastructure fault. Any other failing CI cargo command
 * blocks the push, with its output, unless `compareRef` (or `baseRef`) is set
 * and the same command, run in a detached worktree of that ref, fails with every
 * diagnostic the push shows: a failure the PR base already has is then no
 * verdict on the push and is reported as a warning. When `compareRef` is set
 * but that comparison cannot be made (an unusable or unknown ref, a worktree
 * that cannot be made, a base run that times out, cannot start or fails for the
 * host, or a push output with no readable diagnostic), the failure is also an
 * infrastructure fault, not a verdict. The agent's own hook sets `compareRef`
 * only for a run handed the PR base; with none, a failing check is a verdict.
 *
 * `ciCargoOnly` (repair pushes of repos with no pre-flight configuration, where
 * only the CI cargo checks should gate) runs nothing but those CI cargo checks,
 * the repository's ShellCheck policy (Issue #4631), the cargo-deny gate
 * (Issue #4626), which every gate run applies, and, as every repair push does,
 * the `deno test` check and markdownlint for the pushed paths (Issue #4930):
 * the changed files are still listed and the CI cargo scan still read, but the
 * other changed-file checks (fmt, lint, cspell, Floci), their binary lookups
 * and the repo's pre-flight commands are skipped. Only the Rust-relevant changed
 * files are planned for those, so no other checker's planning error can block
 * the push. With no
 * `findCiCargo`, `ciCargoOnly` plans and runs no cargo check. `shellcheckOnly`
 * plans no changed-file check at all, so it reads no CI cargo scan either.
 *
 * The cargo-deny gate runs for eligible workflows when the pushed paths include
 * a cargo input (a Cargo manifest, lock file, deny config or
 * `.cargo/config.toml`); intermediate pushes, ShellCheck-only repairs and
 * `ciCargoOnly` repairs all work this way. The whole-branch completion check
 * (with a baseRef, and neither ShellCheck-only nor `ciCargoOnly`) runs it on
 * every branch for eligible workflows, regardless of changed cargo inputs. A
 * cargo-deny failure that shows the tool or advisory database could not be
 * reached is a {@link PrePushGateInfrastructureError}.
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
  /** Run only the CI cargo checks (see the doc comment above). */
  ciCargoOnly?: boolean;
  /**
   * Reads the repo's CI cargo checks (the worker passes `repoCiCargoChecks`).
   * Opt-in with no default: absent, no CI cargo check is planned or run. Only
   * called when a Rust-relevant file changed.
   */
  findCiCargo?: (
    repoRoot: string,
    tracked: readonly string[],
  ) => Promise<CiCargoScan>;
  findShellcheck?: (repoRoot: string) => Promise<string | null>;
  readShellcheckVersion?: ShellcheckVersionProbe;
  /**
   * Check every commit ahead of this ref instead of only commits on
   * no remote-tracking ref (Issue #3689: the completion phase's pre-PR check).
   */
  baseRef?: string;
  /**
   * The PR's base branch (for example `main`), for a push that has no `baseRef`. A `deno test` failure is then compared at the merge-base with
   * `origin/<baselineBranch>`, not at the PR's own previous head, which a
   * repair that leaves a test red would otherwise match.
   */
  baselineBranch?: string;
  /**
   * The PR base the CI cargo checks are compared with: a check that fails here
   * and fails the same way on this ref is not a verdict on the push. Defaults
   * to `baseRef`. Without either, a failing CI cargo check always blocks.
   */
  compareRef?: string;
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
  const contained = await listPushedFiles(
    refs.value,
    opts.cwd,
    git,
    opts.baseRef,
  );
  if (!contained.ok) return infrastructureFail(contained.error);
  const uncontained = await listPushedFiles(
    refs.value,
    opts.cwd,
    git,
    opts.baseRef,
    false,
    false,
  );
  if (!uncontained.ok) return infrastructureFail(uncontained.error);
  // A shellcheck-only gate plans no changed-file check; the CI cargo checks
  // need the changed files, so `ciCargoOnly` keeps them.
  const changed = {
    value: opts.shellcheckOnly && !opts.ciCargoOnly ? [] : contained.value,
  };
  const cargoChanged = opts.shellcheckOnly && !opts.ciCargoOnly
    ? []
    : uncontained.value;

  const lsFiles = await git(["ls-files", "-z"], opts.cwd);
  if (lsFiles.code !== 0) {
    return infrastructureFail(
      `git ls-files failed (exit ${lsFiles.code}): ${lsFiles.stderr.trim()}`,
    );
  }
  const tracked = lsFiles.stdout.split("\0").filter((p) => p !== "");
  // In CI-cargo-only mode just the Rust-relevant files are considered, so no
  // other checker is looked up or planned.
  const considered = opts.ciCargoOnly
    ? changed.value.filter(isRustRelevant)
    : changed.value;

  const needsMarkdownlint = contained.value.some((p) =>
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
    considered.some((p) => hasExtension(p, CSPELL_EXTENSIONS)) &&
    [...CSPELL_ROOT_CONFIGS, ...CSPELL_NESTED_CONFIGS].some((n) =>
      tracked.includes(n)
    );
  let cspellBinary: string | null = null;
  if (needsCspell) {
    const find = opts.findCspell ??
      ((root: string) => findCspellBinary(root, Deno.env.get("PATH") ?? ""));
    cspellBinary = await find(opts.cwd);
  }

  // The CI cargo scan is read only when a Rust-relevant file changed. A command
  // the scan cannot reproduce fails the push before anything runs, so it is
  // never dropped from the checked set without a word.
  let ciCargo: CiCargoScan | undefined;
  if (opts.findCiCargo && cargoChanged.some(isRustRelevant)) {
    const scan = await opts.findCiCargo(opts.cwd, tracked);
    if (scan.unverifiable.length > 0) {
      return infrastructureFail(
        `CI's cargo checks cannot be reproduced locally: ${
          scan.unverifiable.join("; ")
        }`,
      );
    }
    ciCargo = scan;
  }

  const shellcheck = await runAffectedShellcheckChecks({
    ...opts,
    changed: touched.value,
    tracked,
  });
  if (!shellcheck.ok) return shellcheck;

  let denoUnitTestRoots: string[];
  try {
    denoUnitTestRoots = await loadDenoUnitTestRoots(opts.cwd, tracked);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // Only a root the push touches is checked for a graph the scan cannot follow.
  const unfollowable = await unfollowableImportRoots(
    opts.cwd,
    tracked,
    denoUnitTestRoots.filter((root) =>
      touched.value.some((p) => root === "." || p.startsWith(`${root}/`))
    ),
  );
  const plan = planChangedFileChecks(considered, tracked, {
    repoRoot: opts.cwd,
    markdownlintBinary,
    cspellBinary,
    cspellInCi,
    denoScopes: await loadDenoScopes(opts.cwd, tracked),
    denoUnitTestRoots,
    denoFullUnitRoots: denoUnitTestRoots.filter((root) =>
      needsFullUnitSuite(touched.value, root) || unfollowable.includes(root)
    ),
    validationChanged: contained.value,
    denoReferencedTests: await loadReferencedUnitTests(
      opts.cwd,
      tracked,
      // Deleted and renamed-away paths too: a test can still name them.
      touched.value,
      denoUnitTestRoots,
    ),
    ciCargo,
    cargoChanged,
  });
  if (!plan.ok) return fail(plan.error);

  // CI-cargo-only mode keeps the CI cargo checks and, as every repair push
  // does, the pushed paths' unit tests and markdownlint (Issue #4930).
  const checks = opts.ciCargoOnly
    ? plan.value.filter((c) =>
      c.cargo !== undefined || c.denoTestRoot !== undefined ||
      c.label === "markdownlint"
    )
    : plan.value;
  const cargoChecks = checks.filter((c) => c.cargo !== undefined);
  const compareRef = opts.compareRef ?? opts.baseRef;
  let probed = false;
  const checksRun: string[] = [...shellcheck.value.checksRun];
  for (const check of checks) {
    if (check.cargo === undefined) {
      const result = await runPreFlightGate([check.command], {
        cwd: check.cwd,
        runner: opts.runner,
        timeoutSeconds: opts.timeoutSeconds,
      });
      if (!result.ok) {
        if (check.denoTestRoot === undefined) {
          return { ok: false, error: result.error };
        }
        const root = check.denoTestRoot;
        const outcome = await judgeDenoTestCheck({
          error: result.error,
          command: check.command,
          baseCommand: unitTestCommand,
          run: (command) =>
            runPreFlightGate([command], {
              cwd: check.cwd,
              runner: opts.runner,
              timeoutSeconds: opts.timeoutSeconds,
            }),
          baseline: {
            // The fork commit is looked up only when a test actually failed.
            runAtBase: async (command, files) => {
              const forkSha = await pushForkCommit(
                refs.value,
                opts.cwd,
                git,
                opts.baseRef ??
                  (opts.baselineBranch === undefined
                    ? undefined
                    : `origin/${opts.baselineBranch}`),
              );
              if (forkSha === null) return null;
              return await worktreeBaseline({
                cwd: opts.cwd,
                root,
                forkSha,
                git,
                runner: opts.runner,
                timeoutSeconds: opts.timeoutSeconds,
              }).runAtBase(command, files);
            },
          },
        });
        if (outcome.kind === "infrastructure") {
          return infrastructureFail(outcome.message);
        }
        if (outcome.kind === "verdict") {
          return { ok: false, error: outcome.error };
        }
        // An established base failure is reported, never counted as run or a block.
        console.warn(
          `[PRE_PUSH_WARNING] deno test (${root}): ${outcome.warning}`,
        );
        continue;
      }
      checksRun.push(check.command);
      continue;
    }

    // Before the first CI cargo command, every toolchain the plan uses is
    // probed (not only this check's), in its own directory and env: a toolchain
    // that is missing or cannot start is no verdict on the commit, and no CI
    // cargo command is run past it.
    if (!probed) {
      probed = true;
      const unavailable = await probeCargoToolchains(cargoChecks, opts);
      if (unavailable !== null) return infrastructureFail(unavailable);
    }

    const result = await runPreFlightGate([check.command], {
      cwd: check.cwd,
      env: check.env,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    });
    if (!result.ok) {
      if (isHostFaultOfCheck(result.error)) {
        return infrastructureFail(
          `CI's ${check.label} (\`${check.command}\`) did not finish on this host (${result.error.reason}): ${
            redactSecrets(
              cargoNetworkFaultLine(result.error.output.split("\n")) ??
                firstOutputLine(result.error.output),
            )
          } — a host fault, not a verdict on the commit`,
        );
      }
      // A failure the PR base already has is not this repair's defect.
      if (compareRef !== undefined) {
        const comparison = await failsOnBaseToo({
          repoRoot: opts.cwd,
          ref: compareRef,
          check,
          headOutput: result.error.output,
          git,
          runner: opts.runner,
          timeoutSeconds: opts.timeoutSeconds,
        });
        if (comparison === "unknown") {
          return infrastructureFail(
            "Could not compare the failed CI cargo check against the PR base. " +
              "Head diagnostics (comparison unavailable):\n" +
              redactedHeadTail(result.error.output, 1200, 600),
          );
        }
        if (comparison === "same") {
          console.warn(
            `[PRE_PUSH_WARNING] CI's ${check.label} (\`${check.command}\`) fails the same way on ${compareRef}: not a verdict on this push`,
          );
          continue;
        }
      }
      return { ok: false, error: result.error };
    }
    checksRun.push(check.command);
  }

  const cargoDeny = await runCargoDenyGate({
    cwd: opts.cwd,
    changed: contained.value,
    always: !opts.shellcheckOnly && !opts.ciCargoOnly &&
      opts.baseRef !== undefined,
    // The touched paths decide a workflow's `paths` filter only over the whole
    // branch; a push of the newest commits alone would miss earlier ones.
    context: {
      touched: opts.baseRef === undefined ? undefined : touched.value,
      branches: pushedBranches(refs.value),
    },
    tracked,
    runner: opts.runner,
    timeoutSeconds: opts.timeoutSeconds,
  });
  if (!cargoDeny.ok) {
    return cargoDeny.error.kind === "infrastructure"
      ? infrastructureFail(cargoDeny.error.message)
      : fail(cargoDeny.error.message);
  }
  checksRun.push(...cargoDeny.value.checksRun);
  // A check CI allows to fail is reported, never counted as run or a block.
  for (const warning of cargoDeny.value.warnings) {
    console.warn(`[PRE_PUSH_WARNING] cargo deny: ${warning}`);
  }

  const preFlight = await runPreFlightGate(
    opts.ciCargoOnly ? [] : opts.preFlightCommands,
    {
      cwd: opts.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    },
  );
  if (!preFlight.ok) return { ok: false, error: preFlight.error };

  return { ok: true, value: { checksRun } };
}
