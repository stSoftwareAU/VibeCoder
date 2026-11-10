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
 *
 * It does two things, in order:
 *
 * 1. Always runs a fast check over just the files the push introduces
 *    (`deno fmt --check`, `deno lint`, `deno test` (Issue #4930),
 *    `cargo fmt --check`, `markdownlint-cli2`, `cspell` and ShellCheck when the
 *    repo's CI runs them, and the Floci CloudFormation deploy test
 *    when the push changes `infra/cloudformation/` and the repo tracks its
 *    script), whatever the repo's own pre-flight list says and whatever the
 *    run budget — these checks are never skipped for budget; all but the Floci
 *    deploy test and the `deno test` run are cheap. The `deno test` check is a
 *    targeted subset: the changed test files and the same-named tests of changed
 *    sources, run via the repo's own `test:unit` task so integration suites like
 *    CI's shards are excluded. Then the repo's `cargo deny check` (Issue #4626)
 *    runs for eligible workflows when intermediate pushes or ShellCheck-only
 *    repairs change a cargo input (a Cargo manifest, lock file, deny config or
 *    `.cargo/config.toml`). The whole-branch
 *    completion check (with a baseRef and not ShellCheck-only) runs it on every
 *    branch for eligible workflows, regardless of changed cargo inputs.
 *    Missing tools or an unreachable advisory database
 *    are infrastructure failures, except for an invocation CI allows to fail,
 *    whose failures of every kind are `[PRE_PUSH_WARNING]` lines.
 * 2. Then runs the repo's configured pre-flight commands.
 *
 * Every uncertainty fails closed: unparseable hook input, a failing `git`
 * call, an unquotable path, a ShellCheck policy the runner cannot interpret,
 * or a configured-but-missing check binary is an `Err`, never a pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { canRunBinary } from "./markdownlint_check.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import { runPreFlightGate, tokeniseCommand } from "./pre_flight_gate.ts";
import { runCargoDenyGate } from "./cargo_deny_gate.ts";
import { inDenoScope, parseDenoScope } from "./deno_scope.ts";
import { stripJsonc } from "./jsonc.ts";
/**
 * The gate could not read the repository state it needs: a `git log`,
 * `ls-files` or history-deepening call failed or timed out (PR #3716 review).
 * It is no verdict on the branch's content, so callers that classify a failed
 * run (the completion phase) must not blame the branch for it. The gate still
 * fails closed: it is an `Err`, never a pass.
 */ export class PrePushGateInfrastructureError extends Error {
  kind = "infrastructure";
  constructor(message, options){
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
 */ export function outermostConfigDirs(paths, configNames) {
  const dirs = new Set();
  for (const path of paths){
    const slash = path.lastIndexOf("/");
    const base = slash === -1 ? path : path.slice(slash + 1);
    if (!configNames.includes(base)) continue;
    const dir = slash === -1 ? "." : path.slice(0, slash);
    dirs.add(dir === "" ? "." : dir);
  }
  const sorted = [
    ...dirs
  ].sort();
  const kept = [];
  for (const dir of sorted){
    const hasKeptAncestor = kept.some((k)=>k === "." || dir.startsWith(`${k}/`));
    if (!hasKeptAncestor) kept.push(dir);
  }
  return kept;
}
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;
/**
 * Parse git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>`
 * per line. Blank lines are ignored; anything malformed is an error (fail
 * closed). Deletions (all-zero local sha) push no content and are dropped.
 */ export function parsePrePushRefs(stdin) {
  const refs = [];
  for (const rawLine of stdin.split("\n")){
    const line = rawLine.trim();
    if (line === "") continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      return {
        ok: false,
        error: `malformed pre-push line (expected 4 fields): ${line}`
      };
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!SHA_PATTERN.test(localSha) || !SHA_PATTERN.test(remoteSha)) {
      return {
        ok: false,
        error: `malformed sha in pre-push line: ${line}`
      };
    }
    if (/^0+$/.test(localSha)) continue;
    refs.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha
    });
  }
  return {
    ok: true,
    value: refs
  };
}
/**
 * Default {@link PrePushGit}: routes through the git chokepoint. A `Result`
 * error or a timeout comes back as a non-zero code with the message in
 * stderr, so the gate fails closed.
 */ export const defaultPrePushGit = async (args, cwd)=>{
  const result = await runGitCommand(args, {
    cwd
  });
  if (!result.ok) {
    return {
      code: 1,
      stdout: "",
      stderr: result.error.message
    };
  }
  const { code, stdout, stderr } = result.value;
  if (code === TIMEOUT_EXIT_CODE) {
    return {
      code,
      stdout,
      stderr: stderr || `git ${args[0] ?? ""} timed out`
    };
  }
  return {
    code,
    stdout,
    stderr
  };
};
/** The branch names the refs push (`refs/heads/` stripped), or undefined when none. */ function pushedBranches(refs) {
  const names = refs.flatMap((ref)=>ref.remoteRef.startsWith("refs/heads/") ? [
      ref.remoteRef.slice("refs/heads/".length)
    ] : []);
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
 */ export async function listPushedFiles(refs, cwd, git, baseRef, includeDeleted = false) {
  if (refs.length === 0) return {
    ok: true,
    value: []
  };
  if (baseRef !== undefined && (baseRef === "" || baseRef.startsWith("-"))) {
    return {
      ok: false,
      error: `unsafe base ref ${JSON.stringify(baseRef)}`
    };
  }
  const result = await git([
    "log",
    "--diff-merges=dense-combined",
    "--name-only",
    "-z",
    "--format=",
    ...includeDeleted ? [] : [
      "--diff-filter=d"
    ],
    ...refs.map((r)=>r.localSha),
    "--not",
    baseRef ?? "--remotes"
  ], cwd);
  if (result.code !== 0) {
    return {
      ok: false,
      error: `git log failed (exit ${result.code}): ${result.stderr.trim()}`
    };
  }
  // Observed shape: names separated by NUL, no commit separators with
  // `--format=`; stripping stray newlines keeps this robust regardless.
  const names = new Set();
  for (const part of result.stdout.split("\0")){
    const name = part.replace(/^\n+|\n+$/g, "");
    if (name !== "") names.add(name);
  }
  if (includeDeleted) return {
    ok: true,
    value: [
      ...names
    ].sort()
  };
  if (names.size === 0) return {
    ok: true,
    value: []
  };
  let realCwd;
  try {
    realCwd = await Deno.realPath(cwd);
  } catch (err) {
    return {
      ok: false,
      error: `could not resolve checkout ${JSON.stringify(cwd)}: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const existing = [];
  for (const name of names){
    try {
      const stat = await Deno.lstat(`${cwd}/${name}`);
      if (!stat.isFile) continue;
      // A symlinked parent directory (`dir -> /elsewhere`) makes `dir/file`
      // resolve outside the checkout even though its own lstat is a file.
      if (await Deno.realPath(`${cwd}/${name}`) !== `${realCwd}/${name}`) {
        continue;
      }
      existing.push(name);
    } catch  {
    // Not in the working tree (removed since, or a submodule): nothing to check.
    }
  }
  return {
    ok: true,
    value: existing.sort()
  };
}
const SHELLCHECK_CONFIGS = new Set([
  ".shellcheckrc",
  "shellcheckrc"
]);
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
  "wiki-link-count"
];
function defaultShellcheckConfigs(tracked) {
  return tracked.filter((candidate)=>SHELLCHECK_CONFIGS.has(candidate.split("/").at(-1) ?? ""));
}
const SHELLCHECK_ACTION_SEVERITIES = [
  "error",
  "warning",
  "info",
  "style"
];
/**
 * Flags for each `ludeeus/action-shellcheck` step in a workflow (the template
 * the worker syncs into Bash repositories). Only `scandir: .` and `severity`
 * are understood; any other input, a `SHELLCHECK_OPTS` override or another
 * ShellCheck action is an unsupported policy, never an implicit pass. The
 * action's file selection is applied by the gate.
 */ function shellcheckActionFlags(text, path) {
  const lines = text.split("\n").map((line)=>line.replace(/\r$/, ""));
  const indentOf = (line)=>line.length - line.trimStart().length;
  const flagsPerStep = [];
  for(let i = 0; i < lines.length; i++){
    const uses = /^(\s*)(?:-\s+)?uses\s*:\s*([^\s#]+)/.exec(lines[i]);
    if (!uses || !/shellcheck/i.test(uses[2])) continue;
    if (!/^ludeeus\/action-shellcheck@/.test(uses[2])) {
      return {
        ok: false,
        error: `unsupported ShellCheck action in workflow ${path}`
      };
    }
    // The step runs from its `- ` line to the next line at that indent or less.
    let start = i;
    while(start > 0 && !/^\s*-\s/.test(lines[start]))start--;
    const stepIndent = indentOf(lines[start]);
    let end = i + 1;
    while(end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > stepIndent))end++;
    const step = lines.slice(start, end);
    if (step.some((line)=>/SHELLCHECK_OPTS/.test(line))) {
      return {
        ok: false,
        error: `unsupported ShellCheck action option SHELLCHECK_OPTS in ${path}`
      };
    }
    const flags = [];
    const withAt = step.findIndex((line)=>/^\s*with\s*:\s*$/.test(line));
    if (withAt >= 0) {
      const withIndent = indentOf(step[withAt]);
      for (const line of step.slice(withAt + 1)){
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        if (indentOf(line) <= withIndent) break;
        const input = /^\s*([\w-]+)\s*:\s*["']?([^"'#\s]*)["']?\s*(?:#.*)?$/.exec(line);
        const [, key, value] = input ?? [];
        if (key === "scandir" && (value === "." || value === "./")) continue;
        if (key === "severity" && SHELLCHECK_ACTION_SEVERITIES.includes(value)) {
          flags.push(`--severity=${value}`);
          continue;
        }
        return {
          ok: false,
          error: `unsupported ShellCheck action option ${key ?? line.trim()} in ${path}`
        };
      }
    }
    flagsPerStep.push(flags);
  }
  return {
    ok: true,
    value: flagsPerStep
  };
}
function isRepoRelativeShellcheckConfig(path) {
  return !path.startsWith("/") && !path.split(/[\\/]/).some((part)=>part === "." || part === "..");
}
/**
 * Read the supported direct ShellCheck policy from tracked workflow steps.
 * A workflow that invokes ShellCheck in another shape is an incomplete policy,
 * never an implicit pass.
 */ export async function repoShellcheckPolicy(repoRoot, tracked) {
  const policies = [];
  for (const path of tracked){
    if (!path.startsWith(".github/workflows/") || !/\.ya?ml$/.test(path)) {
      continue;
    }
    let text;
    try {
      const info = await shellcheckFileInfo(repoRoot, path);
      if (info === null) continue; // GitHub does not run symlinked workflows.
      text = await readBoundedPolicyFile(repoRoot, path, info);
    } catch (error) {
      return {
        ok: false,
        error: `cannot read tracked workflow ${path}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    const bodies = workflowRunStepBodies(text);
    if (!bodies.ok) return bodies;
    const runSteps = bodies.value;
    const delegated = await workflowDelegatesToShellcheck(repoRoot, tracked, runSteps);
    if (!delegated.ok) return delegated;
    if (delegated.value) {
      return {
        ok: false,
        error: `repository CI delegates ShellCheck through a script in workflow ${path}`
      };
    }
    const actionFlags = shellcheckActionFlags(text, path);
    if (!actionFlags.ok) return actionFlags;
    for (const flags of actionFlags.value){
      policies.push({
        version: null,
        flags,
        configFiles: defaultShellcheckConfigs(tracked),
        workflowFiles: [
          path
        ]
      });
    }
    const commands = runSteps.flatMap(executableShellCommands).filter(isShellcheckInvocation);
    if ((actionFlags.value.length > 0 || commands.length > 0) && /SHELLCHECK_OPTS/.test(text)) {
      return {
        ok: false,
        error: `unsupported ShellCheck action option SHELLCHECK_OPTS in ${path}`
      };
    }
    if (commands.length === 0) continue;
    if (/^\s*working-directory\s*:\s*(?!["']?\.["']?\s*(?:#.*)?$)/m.test(text)) {
      return {
        ok: false,
        error: `ShellCheck workflow ${path} sets an unsupported working-directory`
      };
    }
    const versions = [
      ...text.matchAll(/^\s*SHELLCHECK_VERSION\s*:\s*["']?(\d+\.\d+\.\d+)["']?\s*(?:#.*)?$/gm)
    ].map((match)=>match[1]);
    const uniqueVersions = [
      ...new Set(versions)
    ];
    if (uniqueVersions.length !== 1) {
      return {
        ok: false,
        error: `ShellCheck workflow ${path} does not declare one supported pinned version`
      };
    }
    const version = uniqueVersions[0];
    for (const command of commands){
      const match = /^find\s+\.\s+-name\s+["']\*\.sh["']\s+-type\s+f\s+-exec\s+shellcheck(?:\s+(.+?))?\s+\{\}\s+\+$/.exec(command);
      if (!match) {
        return {
          ok: false,
          error: `unsupported ShellCheck command in ${path}: ${command}`
        };
      }
      const args = tokeniseCommand(match[1] ?? "");
      const explicitConfigFiles = [];
      for(let i = 0; i < args.length; i++){
        const arg = args[i];
        if (!arg.startsWith("-")) {
          return {
            ok: false,
            error: `unsupported positional ShellCheck argument in ${path}: ${command}`
          };
        }
        if (arg === "--rcfile" || arg === "-rc" || arg.startsWith("--rcfile=")) {
          const value = arg.startsWith("--rcfile=") ? arg.slice("--rcfile=".length) : args[++i];
          if (!value || value.startsWith("-")) {
            return {
              ok: false,
              error: `missing ShellCheck rcfile in ${path}`
            };
          }
          if (!isRepoRelativeShellcheckConfig(value)) {
            return {
              ok: false,
              error: `unsafe ShellCheck rcfile path in ${path}`
            };
          }
          explicitConfigFiles.push(value);
        } else if (arg.startsWith("--")) {
          const [name, ...inline] = arg.slice(2).split("=");
          const takesValue = SHELLCHECK_LONG_VALUE_OPTIONS.includes(name);
          if (takesValue && inline.length > 0) {
            if (inline.join("=") === "") {
              return {
                ok: false,
                error: `missing value for ShellCheck option --${name} in ${path}`
              };
            }
          } else if (takesValue) {
            const value = args[++i];
            if (!value || value.startsWith("-")) {
              return {
                ok: false,
                error: `missing value for ShellCheck option ${arg} in ${path}`
              };
            }
          }
        // Other long options pass through unchanged; ShellCheck validates them.
        } else if (/^-[A-Za-z]$/.test(arg)) {
          if (SHELLCHECK_SHORT_VALUE_OPTIONS.includes(arg[1])) {
            const value = args[++i];
            if (!value || value.startsWith("-")) {
              return {
                ok: false,
                error: `missing value for ShellCheck option ${arg} in ${path}`
              };
            }
          }
        // Other short options pass through unchanged; ShellCheck validates them.
        } else if (arg.length > 2 && SHELLCHECK_SHORT_VALUE_OPTIONS.includes(arg[1]) && /^-[A-Za-z]/.test(arg)) {
        // Attached value (-Swarning): one token, nothing further to consume.
        } else {
          return {
            ok: false,
            error: `unsupported ShellCheck option ${arg} in ${path}`
          };
        }
      }
      const configFiles = args.includes("--norc") ? [] : explicitConfigFiles.length > 0 ? explicitConfigFiles : defaultShellcheckConfigs(tracked);
      policies.push({
        version,
        flags: args,
        configFiles,
        workflowFiles: [
          path
        ]
      });
    }
  }
  if (policies.length === 0) return {
    ok: true,
    value: null
  };
  const first = policies[0];
  if (policies.some((p)=>p.version !== first.version || JSON.stringify(p.flags) !== JSON.stringify(first.flags) || JSON.stringify(p.configFiles) !== JSON.stringify(first.configFiles))) {
    return {
      ok: false,
      error: "repository CI declares conflicting ShellCheck policies"
    };
  }
  return {
    ok: true,
    value: {
      ...first,
      workflowFiles: [
        ...new Set(policies.flatMap((p)=>p.workflowFiles))
      ]
    }
  };
}
async function workflowDelegatesToShellcheck(repoRoot, tracked, runSteps) {
  const scriptCalls = (body)=>executableShellCommands(body).map((line)=>{
      const tokens = tokeniseCommand(line);
      const first = tokens[0];
      if (first === "bash" || first === "sh" || first === "source" || first === ".") {
        return tokens.slice(1).find((t)=>!t.startsWith("-")) ?? "";
      }
      return first ?? "";
    }).map((path)=>path.startsWith("./") ? path.slice(2) : path).filter((path)=>path.endsWith(".sh") && isRepoRelativeShellcheckConfig(path) && tracked.includes(path));
  const pending = new Set(runSteps.flatMap(scriptCalls));
  const inspected = new Set();
  while(pending.size > 0){
    const path = pending.values().next().value;
    pending.delete(path);
    if (inspected.has(path)) continue;
    inspected.add(path);
    let text;
    try {
      const info = await shellcheckFileInfo(repoRoot, path);
      if (!info) throw new Error("not a regular in-repository file");
      text = await readBoundedPolicyFile(repoRoot, path, info);
    } catch (error) {
      return {
        ok: false,
        error: `cannot read tracked workflow script ${path}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (executableShellCommands(text).some(isShellcheckInvocation)) {
      return {
        ok: true,
        value: true
      };
    }
    for (const called of scriptCalls(text))pending.add(called);
  }
  return {
    ok: true,
    value: false
  };
}
function isShellcheckInvocation(line) {
  const tokens = tokeniseCommand(line);
  const commandOption = tokens.findIndex((token, i)=>i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token));
  const shellCommand = [
    "bash",
    "sh"
  ].includes(tokens[0]?.split("/").at(-1) ?? "") && commandOption > 0 && tokens[commandOption + 1] !== undefined && executableShellCommands(tokens[commandOption + 1]).some(isShellcheckInvocation);
  const dockerImage = tokens[0] === "docker" && tokens.some((token)=>/(?:^|\/)koalaman\/shellcheck(?::[^\s@]+)?(?:@[^\s]+)?$/.test(token));
  const indirect = ![
    "echo",
    "printf",
    "apt",
    "apt-get",
    "brew",
    "curl",
    "wget",
    "tar",
    "mv",
    "cp",
    "chmod",
    "install"
  ].includes(tokens[0] ?? "") && tokens.slice(1).some((token, index, rest)=>(token.split("/").at(-1)?.includes("shellcheck") ?? false) && rest[index + 1] !== "--version");
  const wrapped = [
    "xargs",
    "parallel",
    "do",
    "time",
    "exec",
    "nice",
    "timeout"
  ].includes(tokens[0] ?? "") && tokens.slice(1).some((token, index, rest)=>token.split("/").at(-1) === "shellcheck" && rest[index + 1] !== "--version");
  return (tokens[0]?.split("/").at(-1)?.includes("shellcheck") ?? false) && tokens[1] !== "--version" || wrapped || shellCommand || dockerImage || indirect || tokens[0] === "find" && tokens.some((t, i)=>t === "-exec" && tokens[i + 1] === "shellcheck");
}
/** Inspect command positions, keeping quoted log/data strings out of discovery. */ function executableShellCommands(body) {
  const commands = [];
  let inArray = false;
  for (const line of body.replace(/\\\r?\n\s*/g, " ").split("\n")){
    if (inArray) {
      if (/^\s*\)/.test(line)) inArray = false;
      continue;
    }
    if (/^\s*(?:(?:readonly|local|declare)(?:\s+-\w+)*\s+)?\w+=\(/.test(line)) {
      inArray = !/\)\s*(?:#.*)?$/.test(line);
      continue;
    }
    const parts = line.match(/"[^"\n]*"|'[^'\n]*'|#[^\n]*|&&|\|\||[;|]|[^\s;|]+/g) ?? [];
    let current = [];
    const flush = ()=>{
      while(current.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0]) || [
        "if",
        "then",
        "elif",
        "else",
        "!",
        "sudo",
        "env",
        "command"
      ].includes(current[0]))){
        current.shift();
      }
      if (current.length) commands.push(current.join(" "));
      current = [];
    };
    for (const part of parts){
      if (part.startsWith("#")) break;
      if ([
        ";",
        "|",
        "&&",
        "||"
      ].includes(part)) flush();
      else current.push(part);
    }
    flush();
  }
  return commands;
}
function workflowRunStepBodies(text) {
  const bodies = [];
  const stepKey = /^(\s*)(?:-\s+)?run\s*:(.*)$/;
  const lines = text.split("\n");
  for(let i = 0; i < lines.length; i++){
    const line = lines[i].replace(/\r$/, "");
    const step = stepKey.exec(line);
    if (!step) continue;
    const rest = (step[2] ?? "").trim();
    if (!/^[|>][-+0-9]*(?:\s+#.*)?$/.test(rest)) {
      if (/^[|>]/.test(rest)) {
        return {
          ok: false,
          error: `cannot interpret workflow run body: ${rest}`
        };
      }
      bodies.push(/^(".*"|'.*')$/.test(rest) ? rest.slice(1, -1) : rest);
      continue;
    }
    const indent = (step[1] ?? "").length;
    const block = [];
    for(i++; i < lines.length; i++){
      const next = lines[i].replace(/\r$/, "");
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
  return {
    ok: true,
    value: bodies
  };
}
function shellcheckVersionOutput(text) {
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
  ".markdown"
];
const DENO_LINT_EXTENSIONS = DENO_FORMAT_EXTENSIONS.slice(0, 8);
const MARKDOWN_EXTENSIONS = [
  ".md",
  ".markdown"
];
/**
 * What the worker's own formatters may rewrite: the code half of the
 * `deno fmt` list. Markdown is never handed to `deno fmt` — it re-wraps whole
 * documents and trips markdownlint MD018 — so a Markdown miss is left to the
 * check to report.
 */ const DENO_CODE_FORMAT_EXTENSIONS = DENO_FORMAT_EXTENSIONS.filter((ext)=>!MARKDOWN_EXTENSIONS.includes(ext));
/** Extensions the Spelling workflow's glob covers (`**\/*.{md,html,js,ts,css,sh}`). */ const CSPELL_EXTENSIONS = [
  ".md",
  ".markdown",
  ".html",
  ".js",
  ".ts",
  ".css",
  ".sh"
];
/** Config names cspell finds on its own when run from the repo root. */ const CSPELL_ROOT_CONFIGS = [
  "cspell.json",
  ".cspell.json",
  "cSpell.json",
  "cspell.yaml",
  "cspell.yml",
  ...[
    "json",
    "jsonc",
    "js",
    "cjs",
    "mjs",
    "yaml",
    "yml"
  ].flatMap((ext)=>[
      `cspell.config.${ext}`,
      `.cspell.config.${ext}`
    ])
];
/** Non-root config locations; cspell needs `--config` to find these. */ const CSPELL_NESTED_CONFIGS = [
  "docs/cspell.json"
];
const MARKDOWNLINT_CONFIGS = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml"
];
/**
 * The Floci CloudFormation deploy test `.github/workflows/floci.yml` runs in
 * CI (Issue #3727). A push that changes a file under its directory runs it,
 * so a deterministic deploy error is caught before the push. The script fails
 * closed when Floci cannot be started, when the `aws` CLI is missing or when a
 * stack misses `CREATE_COMPLETE`; with no Docker socket (the worker container)
 * it prints `SKIPPED (needs Docker): <template>` for a template that creates an
 * `AWS::EC2::Instance` and leaves that template to CI.
 */ const FLOCI_TEST_SCRIPT = "infra/cloudformation/test-floci.sh";
const FLOCI_TEST_DIR = "infra/cloudformation/";
function hasExtension(path, extensions) {
  const lower = path.toLowerCase();
  return extensions.some((ext)=>lower.endsWith(ext));
}
/**
 * Quote for the pre-flight tokeniser (`'…'` or `"…"` segments, no escapes).
 * Returns null when the value contains both quote kinds.
 */ function quoteForTokeniser(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}
function quoteAll(paths) {
  const quoted = [];
  for (const path of paths){
    // A leading dash would be read as an option.
    const arg = path.startsWith("-") ? `./${path}` : path;
    const q = quoteForTokeniser(arg);
    if (q === null) {
      return {
        ok: false,
        error: `cannot safely quote path ${JSON.stringify(path)} ` + `(it contains both ' and ") — the push is blocked, not waved through`
      };
    }
    quoted.push(q);
  }
  return {
    ok: true,
    value: quoted.join(" ")
  };
}
function quoteArguments(args) {
  const quoted = [];
  for (const arg of args){
    const value = quoteForTokeniser(arg);
    if (value === null) {
      return {
        ok: false,
        error: `cannot safely quote ShellCheck argument ${JSON.stringify(arg)}`
      };
    }
    quoted.push(value);
  }
  return {
    ok: true,
    value: quoted.join(" ")
  };
}
/**
 * The root-relative test files a root's `deno test` check runs: each changed
 * `_test.ts` under `tests/`, plus the `tests/<name>_test.ts` sibling of each
 * changed non-test `.ts` source outside `tests/`. Only files `tracked` still
 * holds count, so a deleted test is not run. Deduplicated and sorted.
 */ function plannedUnitTestFiles(rel, tracked, root) {
  const trackedSet = new Set(tracked);
  const isTracked = (file)=>trackedSet.has(root === "." ? file : `${root}/${file}`);
  const testFiles = new Set();
  for (const file of rel){
    if (file.startsWith("tests/") && file.endsWith("_test.ts")) {
      if (isTracked(file)) testFiles.add(file);
    } else if (file.endsWith(".ts") && !file.endsWith("_test.ts") && !file.startsWith("tests/")) {
      const base = file.slice(file.lastIndexOf("/") + 1, -".ts".length);
      const sibling = `tests/${base}_test.ts`;
      if (isTracked(sibling)) testFiles.add(sibling);
    }
  }
  return [
    ...testFiles
  ].sort();
}
/**
 * Plan the always-on changed-file format, lint and unit-test commands.
 * `denoScopes` maps a deno root to its parsed include/exclude config: explicit
 * paths override deno's own `include`, so a file the repo's `deno fmt` /
 * `deno lint` would not check is dropped here instead of being passed to deno.
 * A root with no entry is unfiltered. `denoUnitTestRoots` lists the roots
 * whose changed tests get a `deno test` check (see
 * {@link loadDenoUnitTestRoots}); absent means no `deno test` check. It is a
 * targeted subset — changed test files and their same-named tests — run via
 * the repo's own `test:unit` task, so integration suites like CI's shards are
 * not run here.
 */ export function planChangedFileChecks(changed, tracked, opts) {
  const checks = [];
  const dirCwd = (dir)=>dir === "." ? opts.repoRoot : `${opts.repoRoot}/${dir}`;
  for (const root of outermostConfigDirs(tracked, [
    "deno.json",
    "deno.jsonc"
  ])){
    const under = root === "." ? changed : changed.filter((p)=>p.startsWith(`${root}/`));
    const rel = root === "." ? under : under.map((p)=>p.slice(root.length + 1));
    const scope = opts.denoScopes?.[root];
    const groups = [
      [
        "fmt",
        rel,
        DENO_FORMAT_EXTENSIONS,
        "deno fmt --check --permit-no-files"
      ],
      [
        "lint",
        rel,
        DENO_LINT_EXTENSIONS,
        "deno lint --permit-no-files"
      ]
    ];
    for (const [tool, files, extensions, base] of groups){
      const label = `deno ${tool}`;
      const matching = files.filter((f)=>hasExtension(f, extensions) && (scope === undefined || inDenoScope(f, scope, tool)));
      if (matching.length === 0) continue;
      const quoted = quoteAll(matching);
      if (!quoted.ok) return quoted;
      checks.push({
        label: `${label} (${root})`,
        cwd: dirCwd(root),
        command: `${base} ${quoted.value}`
      });
    }
    if (opts.denoUnitTestRoots?.includes(root)) {
      const unitTestFiles = plannedUnitTestFiles(rel, tracked, root);
      if (unitTestFiles.length > 0) {
        const quoted = quoteAll(unitTestFiles);
        if (!quoted.ok) return quoted;
        checks.push({
          label: `deno test (${root})`,
          cwd: dirCwd(root),
          command: `deno task test:unit ${quoted.value}`
        });
      }
    }
  }
  for (const root of outermostConfigDirs(tracked, [
    "Cargo.toml"
  ])){
    const touched = changed.some((p)=>hasExtension(p, [
        ".rs"
      ]) && (root === "." || p.startsWith(`${root}/`)));
    if (!touched) continue;
    checks.push({
      label: `cargo fmt (${root})`,
      cwd: dirCwd(root),
      command: "cargo fmt --all --check"
    });
  }
  const markdown = changed.filter((p)=>hasExtension(p, MARKDOWN_EXTENSIONS));
  const configured = MARKDOWNLINT_CONFIGS.some((name)=>tracked.includes(name));
  if (configured && markdown.length > 0) {
    if (opts.markdownlintBinary === null) {
      return {
        ok: false,
        error: "markdownlint is configured for this repository but " + "markdownlint-cli2 could not be found — the push is blocked, " + "not waved through"
      };
    }
    const binary = quoteForTokeniser(opts.markdownlintBinary);
    const quoted = quoteAll(markdown);
    if (binary === null) {
      return {
        ok: false,
        error: `cannot safely quote the markdownlint path ${JSON.stringify(opts.markdownlintBinary)}`
      };
    }
    if (!quoted.ok) return quoted;
    checks.push({
      label: "markdownlint",
      cwd: opts.repoRoot,
      command: `${binary} ${quoted.value}`
    });
  }
  const rootCspell = CSPELL_ROOT_CONFIGS.find((name)=>tracked.includes(name));
  const nestedCspell = CSPELL_NESTED_CONFIGS.find((name)=>tracked.includes(name));
  const spelling = changed.filter((p)=>hasExtension(p, CSPELL_EXTENSIONS));
  const cspellInCi = opts.cspellInCi ?? false;
  if ((rootCspell || nestedCspell) && cspellInCi && spelling.length > 0) {
    if (!opts.cspellBinary) {
      return {
        ok: false,
        error: "cspell is configured for this repository but cspell could " + "not be found — the push is blocked, not waved through"
      };
    }
    const binary = quoteForTokeniser(opts.cspellBinary);
    const quoted = quoteAll(spelling);
    if (binary === null) {
      return {
        ok: false,
        error: `cannot safely quote the cspell path ${JSON.stringify(opts.cspellBinary)}`
      };
    }
    if (!quoted.ok) return quoted;
    const config = rootCspell ? "" : `--config ${nestedCspell} `;
    checks.push({
      label: "cspell",
      cwd: opts.repoRoot,
      command: `${binary} --no-progress --no-summary --no-must-find-files ${config}${quoted.value}`
    });
  }
  if (tracked.includes(FLOCI_TEST_SCRIPT) && changed.some((p)=>p.startsWith(FLOCI_TEST_DIR))) {
    checks.push({
      label: "floci cloudformation",
      cwd: opts.repoRoot,
      command: `bash ${FLOCI_TEST_SCRIPT}`
    });
  }
  if (opts.shellcheckPolicy && (opts.shellcheckFiles?.length ?? 0) > 0) {
    if (!opts.shellcheckBinary) {
      return {
        ok: false,
        error: "ShellCheck is required by repository CI but could not be found"
      };
    }
    const binary = quoteForTokeniser(opts.shellcheckBinary);
    if (binary === null) {
      return {
        ok: false,
        error: "cannot safely quote the ShellCheck path"
      };
    }
    const policy = opts.shellcheckPolicy;
    for (const file of opts.shellcheckFiles ?? []){
      const explicit = policy.flags.some((a)=>a === "--rcfile" || a === "-rc" || a.startsWith("--rcfile="));
      // Choose the nearest tracked config, matching ShellCheck's search order,
      // and stop at the repo root instead of falling back to the worker's HOME.
      let config;
      if (!explicit && !policy.flags.includes("--norc")) {
        let dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
        for(;;){
          config = [
            ".shellcheckrc",
            "shellcheckrc"
          ].map((name)=>dir ? `${dir}/${name}` : name).find((candidate)=>policy.configFiles.includes(candidate));
          if (config || dir === "") break;
          dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        }
      }
      const args = [
        ...policy.flags,
        ...explicit || policy.flags.includes("--norc") ? [] : config ? [
          "--rcfile",
          config
        ] : [
          "--norc"
        ]
      ];
      const quoted = quoteArguments(args);
      if (!quoted.ok) return quoted;
      const files = quoteAll([
        file
      ]);
      if (!files.ok) return files;
      checks.push({
        label: "shellcheck",
        cwd: opts.repoRoot,
        command: `${binary} ${quoted.value} ${files.value}`
      });
    }
  }
  return {
    ok: true,
    value: checks
  };
}
/**
 * Plan the formatter runs that fix what {@link planChangedFileChecks}'s
 * `deno fmt --check` and `cargo fmt --check` would flag, over the same files:
 * `deno fmt` gets the changed code files under each deno root that the
 * repo's own fmt scope covers (never Markdown), and `cargo fmt --all` runs
 * for a cargo root whose `.rs` files changed — the same whole-workspace scope
 * its check enforces.
 */ export function planFormatterFixes(changed, tracked, denoScopes = {}) {
  const fixes = [];
  for (const root of outermostConfigDirs(tracked, [
    "deno.json",
    "deno.jsonc"
  ])){
    const scope = denoScopes[root];
    const files = changed.filter((p)=>(root === "." || p.startsWith(`${root}/`)) && hasExtension(p, DENO_CODE_FORMAT_EXTENSIONS)).map((p)=>({
        repoPath: p,
        rel: root === "." ? p : p.slice(root.length + 1)
      })).filter((f)=>scope === undefined || inDenoScope(f.rel, scope, "fmt"));
    if (files.length === 0) continue;
    fixes.push({
      tool: "deno fmt",
      dir: root,
      cmd: [
        "deno",
        "fmt",
        "--permit-no-files",
        // A leading dash would be read as an option.
        ...files.map((f)=>f.rel.startsWith("-") ? `./${f.rel}` : f.rel)
      ],
      paths: files.map((f)=>f.repoPath)
    });
  }
  for (const root of outermostConfigDirs(tracked, [
    "Cargo.toml"
  ])){
    const changedRs = changed.filter((p)=>hasExtension(p, [
        ".rs"
      ]) && (root === "." || p.startsWith(`${root}/`)));
    if (changedRs.length === 0) continue;
    fixes.push({
      tool: "cargo fmt",
      dir: root,
      cmd: [
        "cargo",
        "fmt",
        "--all"
      ],
      paths: changedRs
    });
  }
  return fixes;
}
/**
 * Parse each deno root's `deno.json` / `deno.jsonc` scope from the working
 * tree. A root whose config is unreadable or unparseable is left out, so its
 * files are checked unfiltered and deno itself reports the broken config.
 */ export async function loadDenoScopes(repoRoot, tracked) {
  const scopes = {};
  for (const root of outermostConfigDirs(tracked, [
    "deno.json",
    "deno.jsonc"
  ])){
    const text = await readDenoConfigText(repoRoot, root);
    if (text === null) continue;
    const parsed = parseDenoScope(text);
    if (parsed !== null) scopes[root] = parsed;
  }
  return scopes;
}
/**
 * A deno root's config text: `deno.json`, else `deno.jsonc` when `deno.json` is
 * absent or unreadable; null when neither can be read. Deno prefers
 * `deno.json`, so the two are never both used.
 */ async function readDenoConfigText(repoRoot, root) {
  const dir = root === "." ? repoRoot : `${repoRoot}/${root}`;
  for (const name of [
    "deno.json",
    "deno.jsonc"
  ]){
    try {
      return await Deno.readTextFile(`${dir}/${name}`);
    } catch  {
    // This config name is absent or unreadable; try the other.
    }
  }
  return null;
}
/** Whether a deno.json(c) document's `tasks` object defines `test:unit`. */ function definesUnitTestTask(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch  {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const tasks = parsed.tasks;
  return true || typeof tasks === "object" && tasks !== null && !Array.isArray(tasks) && Object.hasOwn(tasks, "test:unit");
}
/**
 * The deno roots whose config defines a `test:unit` task (Issue #4930), so the
 * gate can run the repo's own unit suite for changed tests. Root discovery
 * matches {@link loadDenoScopes}; a root whose config is unreadable or
 * unparseable is left out.
 */ export async function loadDenoUnitTestRoots(repoRoot, tracked) {
  const roots = [];
  for (const root of outermostConfigDirs(tracked, [
    "deno.json",
    "deno.jsonc"
  ])){
    const text = await readDenoConfigText(repoRoot, root);
    if (text !== null && definesUnitTestTask(text)) roots.push(root);
  }
  return roots;
}
/**
 * Find a runnable `markdownlint-cli2`: the repo's own install first, then the
 * first working one on `PATH`; null when neither runs.
 */ export function findMarkdownlintBinary(repoRoot, pathValue) {
  return findBinary("markdownlint-cli2", repoRoot, pathValue);
}
/**
 * Whether the repo's own CI runs cspell: a tracked workflow under
 * `.github/workflows/` with a `run:` or `uses:` step that names cspell.
 * Comment lines are ignored. A repo with a cspell config but no such step
 * is not blocked by cspell, since its required CI never runs it.
 */ export async function repoCiRunsCspell(repoRoot, tracked) {
  for (const path of tracked){
    if (!path.startsWith(".github/workflows/")) continue;
    if (!/\.ya?ml$/.test(path)) continue;
    let text;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch  {
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
 */ export function workflowRunsCspell(text) {
  const stepKey = /^(\s*)(?:-\s+)?(?:run|uses)\s*:(.*)$/;
  const cspellWord = /\bcspell\b/i;
  let blockIndent = null;
  for (const raw of text.split("\n")){
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
/** Find a runnable `cspell`: the repo's own install first, then `PATH`. */ export function findCspellBinary(repoRoot, pathValue) {
  return findBinary("cspell", repoRoot, pathValue);
}
/** Find the `shellcheck` resolved by CI's `PATH`, in the same order. */ export function findShellcheckBinary(pathValue) {
  return findPathBinary("shellcheck", pathValue);
}
async function findBinary(name, repoRoot, pathValue) {
  const local = `${repoRoot}/node_modules/.bin/${name}`;
  try {
    if ((await Deno.stat(local)).isFile && await canRunBinary(local)) {
      return local;
    }
  } catch  {
  // Not installed locally; fall through to PATH.
  }
  for (const dir of pathValue.split(":")){
    if (dir === "") continue;
    const candidate = `${dir}/${name}`;
    try {
      if ((await Deno.stat(candidate)).isFile && await canRunBinary(candidate)) {
        return candidate;
      }
    } catch  {
    // Not in this directory.
    }
  }
  return null;
}
async function findPathBinary(name, pathValue) {
  for (const dir of pathValue.split(":")){
    if (dir === "") continue;
    const candidate = `${dir}/${name}`;
    try {
      if ((await Deno.stat(candidate)).isFile && await canRunBinary(candidate)) {
        return candidate;
      }
    } catch  {
    // Not in this directory.
    }
  }
  return null;
}
const defaultShellcheckVersionProbe = async (binary, cwd)=>{
  const out = await new Deno.Command(binary, {
    args: [
      "--version"
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: buildUntrustedCommandEnv(),
    clearEnv: true,
    signal: AbortSignal.timeout(10_000)
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout)
  };
};
/** Whether a changed path can alter what the repository's ShellCheck CI checks. */ async function touchesShellcheckSurface(root, changed) {
  for (const p of changed){
    const name = p.split("/").at(-1) ?? "";
    if (/\.(?:sh|bash|ksh|zsh|shlib)$/.test(p) || ACTION_SHELL_NAMES.has(name) || SHELLCHECK_CONFIGS.has(name)) return true;
    if (!name.includes(".")) {
      try {
        const info = await shellcheckFileInfo(root, p);
        if (info?.isFile && await actionShellcheckFile(root, p, info)) {
          return true;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound) && !(error instanceof Deno.errors.NotADirectory)) throw error;
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
  "profile"
]);
async function actionShellcheckFile(root, path, info) {
  const name = path.split("/").at(-1);
  if (path.split("/").includes(".git") || path.endsWith(".go") || name === "mvnw") return false;
  if (/\.(?:sh|bash|ksh|zsh|shlib)$/.test(name) || ACTION_SHELL_NAMES.has(name)) return true;
  if (name.includes(".") || !((info.mode ?? 0) & 0o111)) return false;
  const file = await Deno.open(`${root}/${path}`, {
    read: true
  });
  try {
    const bytes = new Uint8Array(4096);
    const count = await file.read(bytes);
    return /^#! *\/[^ ]*\/(?:env *)?[abk]*sh/.test(new TextDecoder().decode(bytes.subarray(0, count ?? 0)).split("\n")[0]);
  } finally{
    file.close();
  }
}
async function shellcheckFileInfo(cwd, path) {
  const parts = path.split("/");
  let current = cwd;
  for (const [index, part] of parts.entries()){
    current += `/${part}`;
    const info = await Deno.lstat(current);
    if (info.isSymlink) return null;
    if (index === parts.length - 1) return info;
    if (!info.isDirectory) return null;
  }
  return null;
}
const MAX_POLICY_BYTES = 1024 * 1024;
async function readBoundedPolicyFile(root, path, info) {
  if (!info.isFile || info.size > MAX_POLICY_BYTES) {
    throw new Error("not a regular file or exceeds policy size limit");
  }
  const file = await Deno.open(`${root}/${path}`, {
    read: true
  });
  try {
    const bytes = new Uint8Array(MAX_POLICY_BYTES + 1);
    let length = 0;
    while(length < bytes.length){
      const count = await file.read(bytes.subarray(length));
      if (count === null) break;
      length += count;
    }
    if (length > MAX_POLICY_BYTES) throw new Error("exceeds policy size limit");
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally{
    file.close();
  }
}
/**
 * Shared ShellCheck validation for hooks, completion and repair publication.
 * A policy the gate cannot read blocks only a push that touches a script, a
 * ShellCheck config or a ShellCheck workflow; any other push has nothing ShellCheck
 * could check, so an unsupported policy cannot make the repository
 * unpublishable.
 */ export async function runAffectedShellcheckChecks(opts) {
  const infrastructureFail = (message)=>({
      ok: false,
      error: new PrePushGateInfrastructureError(message)
    });
  const shellcheckPolicy = await repoShellcheckPolicy(opts.cwd, opts.tracked);
  const changedWorkflows = opts.changed.filter((path)=>path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path) && opts.tracked.includes(path));
  let shellcheckWorkflowChanged = false;
  for (const path of changedWorkflows){
    const policy = await repoShellcheckPolicy(opts.cwd, [
      path,
      ...opts.tracked.filter((p)=>!p.startsWith(".github/workflows/"))
    ]);
    if (!policy.ok || policy.value !== null) shellcheckWorkflowChanged = true;
  }
  if (!shellcheckPolicy.ok) {
    try {
      return await touchesShellcheckSurface(opts.cwd, opts.changed) || shellcheckWorkflowChanged ? infrastructureFail(shellcheckPolicy.error) : {
        ok: true,
        value: {
          checksRun: []
        }
      };
    } catch (error) {
      return infrastructureFail(`cannot inspect changed ShellCheck file: ${error}`);
    }
  }
  const shellcheckTouchedConfigs = opts.changed.some((p)=>SHELLCHECK_CONFIGS.has(p.split("/").at(-1) ?? "") || shellcheckPolicy.value?.configFiles.includes(p)) || shellcheckWorkflowChanged;
  const shellcheckFiles = shellcheckPolicy.value ? shellcheckTouchedConfigs ? opts.tracked : opts.changed : [];
  const existingShellcheckFiles = [];
  for (const path of shellcheckFiles){
    try {
      const info = await shellcheckFileInfo(opts.cwd, path);
      if (info?.isFile && (shellcheckPolicy.value?.version === null ? await actionShellcheckFile(opts.cwd, path, info) : path.endsWith(".sh"))) {
        existingShellcheckFiles.push(path);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory) continue;
      return infrastructureFail(`cannot inspect changed ShellCheck file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (shellcheckPolicy.value && existingShellcheckFiles.length > 0) {
    for (const path of shellcheckPolicy.value.configFiles){
      try {
        const info = await shellcheckFileInfo(opts.cwd, path);
        if (!info?.isFile) {
          return infrastructureFail(`cannot read ShellCheck configuration ${path}: not a regular file`);
        }
        await readBoundedPolicyFile(opts.cwd, path, info);
      } catch (error) {
        return infrastructureFail(`cannot read ShellCheck configuration ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  let shellcheckBinary = null;
  if (shellcheckPolicy.value && existingShellcheckFiles.length > 0) {
    const find = opts.findShellcheck ?? ((_root)=>findShellcheckBinary(Deno.env.get("PATH") ?? ""));
    shellcheckBinary = await find(opts.cwd);
    if (!shellcheckBinary) {
      return infrastructureFail("ShellCheck is required by repository CI but could not be found");
    }
    const probe = opts.readShellcheckVersion ?? defaultShellcheckVersionProbe;
    let versionResult;
    try {
      versionResult = await probe(shellcheckBinary, opts.cwd);
    } catch (error) {
      return infrastructureFail(`could not read ShellCheck version: ${error instanceof Error ? error.message : String(error)}`);
    }
    const actualVersion = shellcheckVersionOutput(versionResult.stdout);
    // A null policy version is an action-managed ShellCheck: nothing to pin.
    if (shellcheckPolicy.value.version !== null && (versionResult.code !== 0 || actualVersion !== shellcheckPolicy.value.version)) {
      return infrastructureFail(`ShellCheck version mismatch: CI requires ${shellcheckPolicy.value.version}, ` + `worker has ${actualVersion ?? "an unreadable version"}`);
    }
  }
  const plan = planChangedFileChecks([], [], {
    repoRoot: opts.cwd,
    markdownlintBinary: null,
    shellcheckPolicy: shellcheckPolicy.value,
    shellcheckBinary,
    shellcheckFiles: existingShellcheckFiles
  });
  if (!plan.ok) return infrastructureFail(plan.error);
  const checksRun = [];
  for (const check of plan.value){
    const result = await runPreFlightGate([
      check.command
    ], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds
    });
    if (!result.ok) return result;
    checksRun.push(check.command);
  }
  return {
    ok: true,
    value: {
      checksRun
    }
  };
}
/**
 * Run the pre-push gate: the always-on changed-file checks first, then the
 * repo's `cargo deny check` (Issue #4626), then the repo's pre-flight commands.
 * Intermediate pushes and ShellCheck-only repairs run eligible workflows when
 * pushed paths include a cargo input. The whole-branch completion check (with a
 * baseRef and not ShellCheck-only) runs eligible workflows on every branch,
 * regardless of changed cargo inputs. `checksRun`
 * lists the changed-file and cargo-deny commands run. The changed-file checks
 * and the cargo-deny gate run whatever the run budget — they are never skipped;
 * all but the Floci deploy test and the `deno test` run are fast. Any git, parse or planning error is
 * an `Err`, never a pass. A cargo-deny failure that shows the tool or advisory
 * database could not be reached is a {@link PrePushGateInfrastructureError}.
 */ export async function runPrePushGate(opts) {
  const git = opts.git ?? defaultPrePushGit;
  const fail = (message)=>({
      ok: false,
      error: new Error(message)
    });
  const infrastructureFail = (message)=>({
      ok: false,
      error: new PrePushGateInfrastructureError(message)
    });
  const refs = parsePrePushRefs(opts.stdin);
  if (!refs.ok) return fail(refs.error);
  const touched = await listPushedFiles(refs.value, opts.cwd, git, opts.baseRef, true);
  if (!touched.ok) return infrastructureFail(touched.error);
  const contained = await listPushedFiles(refs.value, opts.cwd, git, opts.baseRef);
  if (!contained.ok) return infrastructureFail(contained.error);
  const changed = {
    value: opts.shellcheckOnly ? [] : contained.value
  };
  const lsFiles = await git([
    "ls-files",
    "-z"
  ], opts.cwd);
  if (lsFiles.code !== 0) {
    return infrastructureFail(`git ls-files failed (exit ${lsFiles.code}): ${lsFiles.stderr.trim()}`);
  }
  const tracked = lsFiles.stdout.split("\0").filter((p)=>p !== "");
  const needsMarkdownlint = changed.value.some((p)=>hasExtension(p, MARKDOWN_EXTENSIONS));
  let markdownlintBinary = null;
  if (needsMarkdownlint) {
    const find = opts.findMarkdownlint ?? ((root)=>findMarkdownlintBinary(root, Deno.env.get("PATH") ?? ""));
    markdownlintBinary = await find(opts.cwd);
  }
  const cspellInCi = await repoCiRunsCspell(opts.cwd, tracked);
  const needsCspell = cspellInCi && changed.value.some((p)=>hasExtension(p, CSPELL_EXTENSIONS)) && [
    ...CSPELL_ROOT_CONFIGS,
    ...CSPELL_NESTED_CONFIGS
  ].some((n)=>tracked.includes(n));
  let cspellBinary = null;
  if (needsCspell) {
    const find = opts.findCspell ?? ((root)=>findCspellBinary(root, Deno.env.get("PATH") ?? ""));
    cspellBinary = await find(opts.cwd);
  }
  const shellcheck = await runAffectedShellcheckChecks({
    ...opts,
    changed: touched.value,
    tracked
  });
  if (!shellcheck.ok) return shellcheck;
  const plan = planChangedFileChecks(changed.value, tracked, {
    repoRoot: opts.cwd,
    markdownlintBinary,
    cspellBinary,
    cspellInCi,
    denoScopes: await loadDenoScopes(opts.cwd, tracked),
    denoUnitTestRoots: await loadDenoUnitTestRoots(opts.cwd, tracked)
  });
  if (!plan.ok) return fail(plan.error);
  const checksRun = [
    ...shellcheck.value.checksRun
  ];
  for (const check of plan.value){
    const result = await runPreFlightGate([
      check.command
    ], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds
    });
    if (!result.ok) return {
      ok: false,
      error: result.error
    };
    checksRun.push(check.command);
  }
  const cargoDeny = await runCargoDenyGate({
    cwd: opts.cwd,
    changed: contained.value,
    always: !opts.shellcheckOnly && opts.baseRef !== undefined,
    // The touched paths decide a workflow's `paths` filter only over the whole
    // branch; a push of the newest commits alone would miss earlier ones.
    context: {
      touched: opts.baseRef === undefined ? undefined : touched.value,
      branches: pushedBranches(refs.value)
    },
    tracked,
    runner: opts.runner,
    timeoutSeconds: opts.timeoutSeconds
  });
  if (!cargoDeny.ok) {
    return cargoDeny.error.kind === "infrastructure" ? infrastructureFail(cargoDeny.error.message) : fail(cargoDeny.error.message);
  }
  checksRun.push(...cargoDeny.value.checksRun);
  // A check CI allows to fail is reported, never counted as run or a block.
  for (const warning of cargoDeny.value.warnings){
    console.warn(`[PRE_PUSH_WARNING] cargo deny: ${warning}`);
  }
  const preFlight = await runPreFlightGate(opts.preFlightCommands, {
    cwd: opts.cwd,
    runner: opts.runner,
    timeoutSeconds: opts.timeoutSeconds
  });
  if (!preFlight.ok) return {
    ok: false,
    error: preFlight.error
  };
  return {
    ok: true,
    value: {
      checksRun
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcmVfcHVzaF9nYXRlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUHJlLXB1c2ggZ2F0ZTogdGhlIGxvZ2ljIGJlaGluZCB0aGUgY29kaW5nIGFnZW50J3MgZ2l0IGBwcmUtcHVzaGAgaG9va1xuICogKElzc3VlICMzMzk0KSBhbmQgdGhlIHdvcmtlcidzIG93biBnYXRlcyBvdmVyIGNvbW1pdHMgdGhlIGFnZW50IG5ldmVyXG4gKiBwdXNoZWQgKElzc3VlICMzNjg5KS5cbiAqXG4gKiBUaGUgcGVyLXJlcG8gcHJlLWZsaWdodCBnYXRlIChgcHJlX2ZsaWdodF9nYXRlLnRzYCkgcnVucyBhdCB0aGUgd29ya2VyJ3NcbiAqIGNvbW1pdCBjaG9rZXBvaW50LiBBbiBhZ2VudCB0aGF0IGNvbW1pdHMgYW5kIHB1c2hlcyBieSBpdHNlbGYgbmV2ZXIgcGFzc2VzXG4gKiB0aHJvdWdoIHRoYXQgY2hva2Vwb2ludCwgc28gYSBkb2Mtb25seSBwdXNoIGNvdWxkIHJlYWNoIHRoZSByZW1vdGUgd2l0aG91dFxuICogYW55IGNoZWNrIGF0IGFsbC4gQ2FsbGVycyBvZiB7QGxpbmsgcnVuUHJlUHVzaEdhdGV9OlxuICpcbiAqIC0gdGhlIGFnZW50J3MgYHByZS1wdXNoYCBob29rIChpdHMgb3duIGBnaXQgcHVzaGApO1xuICogLSBgY29tbWl0QW5kUHVzaFBlbmRpbmdgIFN0ZXAgMWIsIHZpYSBgZ2F0ZVVucHVzaGVkQ29tbWl0c2AsIG92ZXIgY29tbWl0c1xuICogICBub3QgeWV0IG9uIGFueSByZW1vdGUgKGZpbmFsLW1pbGUgY2FsbGVycyB0aGF0IHBhc3MgYSBgcHJlRmxpZ2h0YCBzcGVjKTtcbiAqIC0gdGhlIGlzc3VlIGNvbXBsZXRpb24gcGhhc2UsIHZpYSBgZ2F0ZVVucHVzaGVkQ29tbWl0c2Agd2l0aCBhIGBiYXNlUmVmYCxcbiAqICAgb3ZlciBldmVyeSBjb21taXQgdGhlIGJyYW5jaCBoYXMgYWhlYWQgb2YgdGhlIFBSIGJhc2Ug4oCUIHNvXG4gKiAgIGNvbnRlbnQgdGhlIGV4ZWN1dGUgcGhhc2UncyBXSVAgY2hlY2twb2ludHMgYWxyZWFkeSBwdXNoZWQgaXMgY2hlY2tlZFxuICogICBiZWZvcmUgYGdoIHByIGNyZWF0ZWAuXG4gKlxuICogSXQgZG9lcyB0d28gdGhpbmdzLCBpbiBvcmRlcjpcbiAqXG4gKiAxLiBBbHdheXMgcnVucyBhIGZhc3QgY2hlY2sgb3ZlciBqdXN0IHRoZSBmaWxlcyB0aGUgcHVzaCBpbnRyb2R1Y2VzXG4gKiAgICAoYGRlbm8gZm10IC0tY2hlY2tgLCBgZGVubyBsaW50YCwgYGRlbm8gdGVzdGAgKElzc3VlICM0OTMwKSxcbiAqICAgIGBjYXJnbyBmbXQgLS1jaGVja2AsIGBtYXJrZG93bmxpbnQtY2xpMmAsIGBjc3BlbGxgIGFuZCBTaGVsbENoZWNrIHdoZW4gdGhlXG4gKiAgICByZXBvJ3MgQ0kgcnVucyB0aGVtLCBhbmQgdGhlIEZsb2NpIENsb3VkRm9ybWF0aW9uIGRlcGxveSB0ZXN0XG4gKiAgICB3aGVuIHRoZSBwdXNoIGNoYW5nZXMgYGluZnJhL2Nsb3VkZm9ybWF0aW9uL2AgYW5kIHRoZSByZXBvIHRyYWNrcyBpdHNcbiAqICAgIHNjcmlwdCksIHdoYXRldmVyIHRoZSByZXBvJ3Mgb3duIHByZS1mbGlnaHQgbGlzdCBzYXlzIGFuZCB3aGF0ZXZlciB0aGVcbiAqICAgIHJ1biBidWRnZXQg4oCUIHRoZXNlIGNoZWNrcyBhcmUgbmV2ZXIgc2tpcHBlZCBmb3IgYnVkZ2V0OyBhbGwgYnV0IHRoZSBGbG9jaVxuICogICAgZGVwbG95IHRlc3QgYW5kIHRoZSBgZGVubyB0ZXN0YCBydW4gYXJlIGNoZWFwLiBUaGUgYGRlbm8gdGVzdGAgY2hlY2sgaXMgYVxuICogICAgdGFyZ2V0ZWQgc3Vic2V0OiB0aGUgY2hhbmdlZCB0ZXN0IGZpbGVzIGFuZCB0aGUgc2FtZS1uYW1lZCB0ZXN0cyBvZiBjaGFuZ2VkXG4gKiAgICBzb3VyY2VzLCBydW4gdmlhIHRoZSByZXBvJ3Mgb3duIGB0ZXN0OnVuaXRgIHRhc2sgc28gaW50ZWdyYXRpb24gc3VpdGVzIGxpa2VcbiAqICAgIENJJ3Mgc2hhcmRzIGFyZSBleGNsdWRlZC4gVGhlbiB0aGUgcmVwbydzIGBjYXJnbyBkZW55IGNoZWNrYCAoSXNzdWUgIzQ2MjYpXG4gKiAgICBydW5zIGZvciBlbGlnaWJsZSB3b3JrZmxvd3Mgd2hlbiBpbnRlcm1lZGlhdGUgcHVzaGVzIG9yIFNoZWxsQ2hlY2stb25seVxuICogICAgcmVwYWlycyBjaGFuZ2UgYSBjYXJnbyBpbnB1dCAoYSBDYXJnbyBtYW5pZmVzdCwgbG9jayBmaWxlLCBkZW55IGNvbmZpZyBvclxuICogICAgYC5jYXJnby9jb25maWcudG9tbGApLiBUaGUgd2hvbGUtYnJhbmNoXG4gKiAgICBjb21wbGV0aW9uIGNoZWNrICh3aXRoIGEgYmFzZVJlZiBhbmQgbm90IFNoZWxsQ2hlY2stb25seSkgcnVucyBpdCBvbiBldmVyeVxuICogICAgYnJhbmNoIGZvciBlbGlnaWJsZSB3b3JrZmxvd3MsIHJlZ2FyZGxlc3Mgb2YgY2hhbmdlZCBjYXJnbyBpbnB1dHMuXG4gKiAgICBNaXNzaW5nIHRvb2xzIG9yIGFuIHVucmVhY2hhYmxlIGFkdmlzb3J5IGRhdGFiYXNlXG4gKiAgICBhcmUgaW5mcmFzdHJ1Y3R1cmUgZmFpbHVyZXMsIGV4Y2VwdCBmb3IgYW4gaW52b2NhdGlvbiBDSSBhbGxvd3MgdG8gZmFpbCxcbiAqICAgIHdob3NlIGZhaWx1cmVzIG9mIGV2ZXJ5IGtpbmQgYXJlIGBbUFJFX1BVU0hfV0FSTklOR11gIGxpbmVzLlxuICogMi4gVGhlbiBydW5zIHRoZSByZXBvJ3MgY29uZmlndXJlZCBwcmUtZmxpZ2h0IGNvbW1hbmRzLlxuICpcbiAqIEV2ZXJ5IHVuY2VydGFpbnR5IGZhaWxzIGNsb3NlZDogdW5wYXJzZWFibGUgaG9vayBpbnB1dCwgYSBmYWlsaW5nIGBnaXRgXG4gKiBjYWxsLCBhbiB1bnF1b3RhYmxlIHBhdGgsIGEgU2hlbGxDaGVjayBwb2xpY3kgdGhlIHJ1bm5lciBjYW5ub3QgaW50ZXJwcmV0LFxuICogb3IgYSBjb25maWd1cmVkLWJ1dC1taXNzaW5nIGNoZWNrIGJpbmFyeSBpcyBhbiBgRXJyYCwgbmV2ZXIgYSBwYXNzLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgY2FuUnVuQmluYXJ5IH0gZnJvbSBcIi4vbWFya2Rvd25saW50X2NoZWNrLnRzXCI7XG5pbXBvcnQgeyBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYgfSBmcm9tIFwiLi91bnRydXN0ZWRfY29tbWFuZF9lbnYudHNcIjtcbmltcG9ydCB7IHJ1bkdpdENvbW1hbmQsIFRJTUVPVVRfRVhJVF9DT0RFIH0gZnJvbSBcIi4vZ2l0X3RpbWVvdXQudHNcIjtcbmltcG9ydCB7XG4gIHR5cGUgUHJlRmxpZ2h0UnVubmVyLFxuICBydW5QcmVGbGlnaHRHYXRlLFxuICB0b2tlbmlzZUNvbW1hbmQsXG59IGZyb20gXCIuL3ByZV9mbGlnaHRfZ2F0ZS50c1wiO1xuaW1wb3J0IHsgcnVuQ2FyZ29EZW55R2F0ZSB9IGZyb20gXCIuL2NhcmdvX2RlbnlfZ2F0ZS50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBEZW5vU2NvcGVDb25maWcsXG4gIGluRGVub1Njb3BlLFxuICBwYXJzZURlbm9TY29wZSxcbn0gZnJvbSBcIi4vZGVub19zY29wZS50c1wiO1xuaW1wb3J0IHsgc3RyaXBKc29uYyB9IGZyb20gXCIuL2pzb25jLnRzXCI7XG5cbi8qKlxuICogVGhlIGdhdGUgY291bGQgbm90IHJlYWQgdGhlIHJlcG9zaXRvcnkgc3RhdGUgaXQgbmVlZHM6IGEgYGdpdCBsb2dgLFxuICogYGxzLWZpbGVzYCBvciBoaXN0b3J5LWRlZXBlbmluZyBjYWxsIGZhaWxlZCBvciB0aW1lZCBvdXQgKFBSICMzNzE2IHJldmlldykuXG4gKiBJdCBpcyBubyB2ZXJkaWN0IG9uIHRoZSBicmFuY2gncyBjb250ZW50LCBzbyBjYWxsZXJzIHRoYXQgY2xhc3NpZnkgYSBmYWlsZWRcbiAqIHJ1biAodGhlIGNvbXBsZXRpb24gcGhhc2UpIG11c3Qgbm90IGJsYW1lIHRoZSBicmFuY2ggZm9yIGl0LiBUaGUgZ2F0ZSBzdGlsbFxuICogZmFpbHMgY2xvc2VkOiBpdCBpcyBhbiBgRXJyYCwgbmV2ZXIgYSBwYXNzLlxuICovXG5leHBvcnQgY2xhc3MgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kID0gXCJpbmZyYXN0cnVjdHVyZVwiIGFzIGNvbnN0O1xuXG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgb3B0aW9ucz86IHsgY2F1c2U/OiB1bmtub3duIH0pIHtcbiAgICBzdXBlcihtZXNzYWdlLCBvcHRpb25zKTtcbiAgICB0aGlzLm5hbWUgPSBcIlByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvclwiO1xuICB9XG59XG5cbi8qKlxuICogUGljayB0aGUgb3V0ZXJtb3N0IGRpcmVjdG9yaWVzIHRyYWNrZWQgY29uZmlnIGZpbGVzIGxpdmUgaW4uXG4gKlxuICogQSBuZXN0ZWQgYGEvYi9DYXJnby50b21sYCB1bmRlciBhbiBhbHJlYWR5LWtlcHQgYGEvQ2FyZ28udG9tbGAgaXMgZHJvcHBlZCDigJRcbiAqIGBjYXJnbyBmbXQgLS1hbGxgIGF0IGBhYCBhbHJlYWR5IHJlYWNoZXMgaXQgdmlhIHRoZSB3b3Jrc3BhY2Ug4oCUIGJ1dFxuICogYHdlYngvZGVuby5qc29uYCBpcyBuZXZlciB0cmVhdGVkIGFzIG5lc3RlZCB1bmRlciBhIGtlcHQgYHdlYmAuXG4gKlxuICogQHBhcmFtIHBhdGhzIC0gUmVwby1yZWxhdGl2ZSBwYXRocywgYC9gLXNlcGFyYXRlZCAoYXMgYGdpdCBscy1maWxlc2AgcHJpbnRzKS5cbiAqIEBwYXJhbSBjb25maWdOYW1lcyAtIEJhc2VuYW1lcyB0aGF0IG1hcmsgYSBmb3JtYXR0ZXIncyByb290IChlLmcuIGBDYXJnby50b21sYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvdXRlcm1vc3RDb25maWdEaXJzKFxuICBwYXRoczogc3RyaW5nW10sXG4gIGNvbmZpZ05hbWVzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICBjb25zdCBzbGFzaCA9IHBhdGgubGFzdEluZGV4T2YoXCIvXCIpO1xuICAgIGNvbnN0IGJhc2UgPSBzbGFzaCA9PT0gLTEgPyBwYXRoIDogcGF0aC5zbGljZShzbGFzaCArIDEpO1xuICAgIGlmICghY29uZmlnTmFtZXMuaW5jbHVkZXMoYmFzZSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGRpciA9IHNsYXNoID09PSAtMSA/IFwiLlwiIDogcGF0aC5zbGljZSgwLCBzbGFzaCk7XG4gICAgZGlycy5hZGQoZGlyID09PSBcIlwiID8gXCIuXCIgOiBkaXIpO1xuICB9XG4gIGNvbnN0IHNvcnRlZCA9IFsuLi5kaXJzXS5zb3J0KCk7XG4gIGNvbnN0IGtlcHQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZGlyIG9mIHNvcnRlZCkge1xuICAgIGNvbnN0IGhhc0tlcHRBbmNlc3RvciA9IGtlcHQuc29tZSgoaykgPT5cbiAgICAgIGsgPT09IFwiLlwiIHx8IGRpci5zdGFydHNXaXRoKGAke2t9L2ApXG4gICAgKTtcbiAgICBpZiAoIWhhc0tlcHRBbmNlc3Rvcikga2VwdC5wdXNoKGRpcik7XG4gIH1cbiAgcmV0dXJuIGtlcHQ7XG59XG5cbi8qKiBPbmUgcmVmIGxpbmUgZnJvbSBnaXQncyBwcmUtcHVzaCBob29rIHN0ZGluLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcmVQdXNoUmVmIHtcbiAgbG9jYWxSZWY6IHN0cmluZztcbiAgbG9jYWxTaGE6IHN0cmluZztcbiAgcmVtb3RlUmVmOiBzdHJpbmc7XG4gIHJlbW90ZVNoYTogc3RyaW5nO1xufVxuXG5jb25zdCBTSEFfUEFUVEVSTiA9IC9eWzAtOWEtZl17NDAsNjR9JC87XG5cbi8qKlxuICogUGFyc2UgZ2l0J3MgcHJlLXB1c2ggc3RkaW46IGA8bG9jYWwgcmVmPiA8bG9jYWwgc2hhPiA8cmVtb3RlIHJlZj4gPHJlbW90ZSBzaGE+YFxuICogcGVyIGxpbmUuIEJsYW5rIGxpbmVzIGFyZSBpZ25vcmVkOyBhbnl0aGluZyBtYWxmb3JtZWQgaXMgYW4gZXJyb3IgKGZhaWxcbiAqIGNsb3NlZCkuIERlbGV0aW9ucyAoYWxsLXplcm8gbG9jYWwgc2hhKSBwdXNoIG5vIGNvbnRlbnQgYW5kIGFyZSBkcm9wcGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VQcmVQdXNoUmVmcyhzdGRpbjogc3RyaW5nKTogUmVzdWx0PFByZVB1c2hSZWZbXSwgc3RyaW5nPiB7XG4gIGNvbnN0IHJlZnM6IFByZVB1c2hSZWZbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJhd0xpbmUgb2Ygc3RkaW4uc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3TGluZS50cmltKCk7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGZpZWxkcyA9IGxpbmUuc3BsaXQoL1xccysvKTtcbiAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gNCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogYG1hbGZvcm1lZCBwcmUtcHVzaCBsaW5lIChleHBlY3RlZCA0IGZpZWxkcyk6ICR7bGluZX1gLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgW2xvY2FsUmVmLCBsb2NhbFNoYSwgcmVtb3RlUmVmLCByZW1vdGVTaGFdID0gZmllbGRzIGFzIFtcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyxcbiAgICAgIHN0cmluZyxcbiAgICBdO1xuICAgIGlmICghU0hBX1BBVFRFUk4udGVzdChsb2NhbFNoYSkgfHwgIVNIQV9QQVRURVJOLnRlc3QocmVtb3RlU2hhKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYG1hbGZvcm1lZCBzaGEgaW4gcHJlLXB1c2ggbGluZTogJHtsaW5lfWAgfTtcbiAgICB9XG4gICAgaWYgKC9eMCskLy50ZXN0KGxvY2FsU2hhKSkgY29udGludWU7XG4gICAgcmVmcy5wdXNoKHsgbG9jYWxSZWYsIGxvY2FsU2hhLCByZW1vdGVSZWYsIHJlbW90ZVNoYSB9KTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHJlZnMgfTtcbn1cblxuLyoqIFJ1bnMgYGdpdCA8YXJncz5gIGluIGBjd2RgLiBJbmplY3RhYmxlIGZvciB0ZXN0cy4gKi9cbmV4cG9ydCB0eXBlIFByZVB1c2hHaXQgPSAoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBjd2Q6IHN0cmluZyxcbikgPT4gUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgc3Rkb3V0OiBzdHJpbmc7IHN0ZGVycjogc3RyaW5nIH0+O1xuXG4vKipcbiAqIERlZmF1bHQge0BsaW5rIFByZVB1c2hHaXR9OiByb3V0ZXMgdGhyb3VnaCB0aGUgZ2l0IGNob2tlcG9pbnQuIEEgYFJlc3VsdGBcbiAqIGVycm9yIG9yIGEgdGltZW91dCBjb21lcyBiYWNrIGFzIGEgbm9uLXplcm8gY29kZSB3aXRoIHRoZSBtZXNzYWdlIGluXG4gKiBzdGRlcnIsIHNvIHRoZSBnYXRlIGZhaWxzIGNsb3NlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IGRlZmF1bHRQcmVQdXNoR2l0OiBQcmVQdXNoR2l0ID0gYXN5bmMgKGFyZ3MsIGN3ZCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5HaXRDb21tYW5kKGFyZ3MsIHsgY3dkIH0pO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHJldHVybiB7IGNvZGU6IDEsIHN0ZG91dDogXCJcIiwgc3RkZXJyOiByZXN1bHQuZXJyb3IubWVzc2FnZSB9O1xuICB9XG4gIGNvbnN0IHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIgfSA9IHJlc3VsdC52YWx1ZTtcbiAgaWYgKGNvZGUgPT09IFRJTUVPVVRfRVhJVF9DT0RFKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvZGUsXG4gICAgICBzdGRvdXQsXG4gICAgICBzdGRlcnI6IHN0ZGVyciB8fCBgZ2l0ICR7YXJnc1swXSA/PyBcIlwifSB0aW1lZCBvdXRgLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIgfTtcbn07XG5cbi8qKiBUaGUgYnJhbmNoIG5hbWVzIHRoZSByZWZzIHB1c2ggKGByZWZzL2hlYWRzL2Agc3RyaXBwZWQpLCBvciB1bmRlZmluZWQgd2hlbiBub25lLiAqL1xuZnVuY3Rpb24gcHVzaGVkQnJhbmNoZXMocmVmczogcmVhZG9ubHkgUHJlUHVzaFJlZltdKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuICBjb25zdCBuYW1lcyA9IHJlZnMuZmxhdE1hcCgocmVmKSA9PlxuICAgIHJlZi5yZW1vdGVSZWYuc3RhcnRzV2l0aChcInJlZnMvaGVhZHMvXCIpXG4gICAgICA/IFtyZWYucmVtb3RlUmVmLnNsaWNlKFwicmVmcy9oZWFkcy9cIi5sZW5ndGgpXVxuICAgICAgOiBbXVxuICApO1xuICByZXR1cm4gbmFtZXMubGVuZ3RoID09PSAwID8gdW5kZWZpbmVkIDogbmFtZXM7XG59XG5cbi8qKlxuICogTGlzdCB0aGUgZmlsZXMgdGhlIHB1c2ggaW50cm9kdWNlczogdGhvc2UgdG91Y2hlZCBieSBjb21taXRzIChpbmNsdWRpbmdcbiAqIHRoZSBwYXRocyBhIG1lcmdlIGNvbW1pdCBpdHNlbGYgY2hhbmdlZDogYSBjb25mbGljdCByZXNvbHV0aW9uIG9yIGEgZml4XG4gKiBmb2xkZWQgaW50byB0aGUgbWVyZ2UsIG5ldmVyIHRoZSBmaWxlcyBpdCBtZXJlbHkgYnJpbmdzIGluIGZyb20gdGhlIGJhc2UpXG4gKiByZWFjaGFibGUgZnJvbSB0aGUgcHVzaGVkIHRpcHMgYnV0IG5vdCBmcm9tIGBiYXNlUmVmYCDigJQgYnkgZGVmYXVsdCBub1xuICogcmVtb3RlLXRyYWNraW5nIHJlZiAoYC0tcmVtb3Rlc2ApIOKAlCBtaW51cyBkZWxldGlvbnMsIGFuZCBvbmx5IHRob3NlIHRoYXRcbiAqIHN0aWxsIGV4aXN0IGFzIHJlZ3VsYXIgZmlsZXMgaW4gdGhlIHdvcmtpbmcgdHJlZS4gRmlsZXMgcmVhY2hlZCB0aHJvdWdoIGFcbiAqIHN5bWxpbmtlZCBwYXJlbnQgZGlyZWN0b3J5IGFyZSBza2lwcGVkIHRvbywgc2luY2UgdGhleSByZXNvbHZlIG91dHNpZGUgdGhlXG4gKiBjaGVja291dC4gU29ydGVkIGFuZCB1bmlxdWUuIGBpbmNsdWRlRGVsZXRlZGAgcmV0YWlucyBhbGwgdG91Y2hlZCBwYXRoc1xuICogKHVuZmlsdGVyZWQgYnkgdGhlIHdvcmtpbmcgdHJlZSkgZm9yIGNvbmZpZ3VyYXRpb24gaW52YWxpZGF0aW9uOyBjYWxsZXJzXG4gKiBtdXN0IGZpbHRlciBleGVjdXRpb24gdGFyZ2V0cyBzZXBhcmF0ZWx5LlxuICpcbiAqIGBiYXNlUmVmYCB3aWRlbnMgdGhlIHJhbmdlIHRvIGV2ZXJ5dGhpbmcgdGhlIGJyYW5jaCBoYXMgYWhlYWQgb2YgdGhhdCByZWYsXG4gKiBpbmNsdWRpbmcgY29tbWl0cyBhIFdJUCBjaGVja3BvaW50IGFscmVhZHkgcHVzaGVkIChJc3N1ZSAjMzY4OSkuIEl0IG11c3QgYmVcbiAqIGEgcmVmIHRoZSBjYWxsZXIgcmVzb2x2ZWQgaXRzZWxmOyBhIHZhbHVlIGdpdCBjb3VsZCByZWFkIGFzIGFuIG9wdGlvbiBpc1xuICogcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RQdXNoZWRGaWxlcyhcbiAgcmVmczogUHJlUHVzaFJlZltdLFxuICBjd2Q6IHN0cmluZyxcbiAgZ2l0OiBQcmVQdXNoR2l0LFxuICBiYXNlUmVmPzogc3RyaW5nLFxuICBpbmNsdWRlRGVsZXRlZCA9IGZhbHNlLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nW10sIHN0cmluZz4+IHtcbiAgaWYgKHJlZnMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IFtdIH07XG4gIGlmIChiYXNlUmVmICE9PSB1bmRlZmluZWQgJiYgKGJhc2VSZWYgPT09IFwiXCIgfHwgYmFzZVJlZi5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBgdW5zYWZlIGJhc2UgcmVmICR7SlNPTi5zdHJpbmdpZnkoYmFzZVJlZil9YCB9O1xuICB9XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdpdChcbiAgICBbXG4gICAgICBcImxvZ1wiLFxuICAgICAgXCItLWRpZmYtbWVyZ2VzPWRlbnNlLWNvbWJpbmVkXCIsXG4gICAgICBcIi0tbmFtZS1vbmx5XCIsXG4gICAgICBcIi16XCIsXG4gICAgICBcIi0tZm9ybWF0PVwiLFxuICAgICAgLi4uKGluY2x1ZGVEZWxldGVkID8gW10gOiBbXCItLWRpZmYtZmlsdGVyPWRcIl0pLFxuICAgICAgLi4ucmVmcy5tYXAoKHIpID0+IHIubG9jYWxTaGEpLFxuICAgICAgXCItLW5vdFwiLFxuICAgICAgYmFzZVJlZiA/PyBcIi0tcmVtb3Rlc1wiLFxuICAgIF0sXG4gICAgY3dkLFxuICApO1xuICBpZiAocmVzdWx0LmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBnaXQgbG9nIGZhaWxlZCAoZXhpdCAke3Jlc3VsdC5jb2RlfSk6ICR7cmVzdWx0LnN0ZGVyci50cmltKCl9YCxcbiAgICB9O1xuICB9XG4gIC8vIE9ic2VydmVkIHNoYXBlOiBuYW1lcyBzZXBhcmF0ZWQgYnkgTlVMLCBubyBjb21taXQgc2VwYXJhdG9ycyB3aXRoXG4gIC8vIGAtLWZvcm1hdD1gOyBzdHJpcHBpbmcgc3RyYXkgbmV3bGluZXMga2VlcHMgdGhpcyByb2J1c3QgcmVnYXJkbGVzcy5cbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBwYXJ0IG9mIHJlc3VsdC5zdGRvdXQuc3BsaXQoXCJcXDBcIikpIHtcbiAgICBjb25zdCBuYW1lID0gcGFydC5yZXBsYWNlKC9eXFxuK3xcXG4rJC9nLCBcIlwiKTtcbiAgICBpZiAobmFtZSAhPT0gXCJcIikgbmFtZXMuYWRkKG5hbWUpO1xuICB9XG4gIGlmIChpbmNsdWRlRGVsZXRlZCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbLi4ubmFtZXNdLnNvcnQoKSB9O1xuICBpZiAobmFtZXMuc2l6ZSA9PT0gMCkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbXSB9O1xuICBsZXQgcmVhbEN3ZDogc3RyaW5nO1xuICB0cnkge1xuICAgIHJlYWxDd2QgPSBhd2FpdCBEZW5vLnJlYWxQYXRoKGN3ZCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogYGNvdWxkIG5vdCByZXNvbHZlIGNoZWNrb3V0ICR7SlNPTi5zdHJpbmdpZnkoY3dkKX06ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgfTtcbiAgfVxuICBjb25zdCBleGlzdGluZzogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLmxzdGF0KGAke2N3ZH0vJHtuYW1lfWApO1xuICAgICAgaWYgKCFzdGF0LmlzRmlsZSkgY29udGludWU7XG4gICAgICAvLyBBIHN5bWxpbmtlZCBwYXJlbnQgZGlyZWN0b3J5IChgZGlyIC0+IC9lbHNld2hlcmVgKSBtYWtlcyBgZGlyL2ZpbGVgXG4gICAgICAvLyByZXNvbHZlIG91dHNpZGUgdGhlIGNoZWNrb3V0IGV2ZW4gdGhvdWdoIGl0cyBvd24gbHN0YXQgaXMgYSBmaWxlLlxuICAgICAgaWYgKChhd2FpdCBEZW5vLnJlYWxQYXRoKGAke2N3ZH0vJHtuYW1lfWApKSAhPT0gYCR7cmVhbEN3ZH0vJHtuYW1lfWApIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBleGlzdGluZy5wdXNoKG5hbWUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTm90IGluIHRoZSB3b3JraW5nIHRyZWUgKHJlbW92ZWQgc2luY2UsIG9yIGEgc3VibW9kdWxlKTogbm90aGluZyB0byBjaGVjay5cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBleGlzdGluZy5zb3J0KCkgfTtcbn1cblxuLyoqIE9uZSBjb21tYW5kIHRvIHJ1biBmb3IgdGhlIGNoYW5nZWQgZmlsZXMuICovXG5leHBvcnQgaW50ZXJmYWNlIENoYW5nZWRGaWxlQ2hlY2sge1xuICBsYWJlbDogc3RyaW5nO1xuICAvKiogQWJzb2x1dGUgd29ya2luZyBkaXJlY3RvcnkuICovXG4gIGN3ZDogc3RyaW5nO1xuICBjb21tYW5kOiBzdHJpbmc7XG59XG5cbi8qKiBTaGVsbENoZWNrIHBvbGljeSByZWFkIGZyb20gYSByZXBvc2l0b3J5J3MgcnVubmFibGUgQ0kgd29ya2Zsb3cuICovXG5leHBvcnQgaW50ZXJmYWNlIFNoZWxsY2hlY2tQb2xpY3kge1xuICAvKiogUGlubmVkIENJIHZlcnNpb24sIG9yIG51bGwgd2hlbiBDSSB1c2VzIGFuIGFjdGlvbidzIG93biBTaGVsbENoZWNrLiAqL1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICBmbGFnczogc3RyaW5nW107XG4gIGNvbmZpZ0ZpbGVzOiBzdHJpbmdbXTtcbiAgd29ya2Zsb3dGaWxlczogc3RyaW5nW107XG59XG5cbmNvbnN0IFNIRUxMQ0hFQ0tfQ09ORklHUyA9IG5ldyBTZXQoW1wiLnNoZWxsY2hlY2tyY1wiLCBcInNoZWxsY2hlY2tyY1wiXSk7XG5cbi8vIFNoZWxsQ2hlY2sgb3B0aW9ucyB0aGF0IHRha2UgYSB2YWx1ZSAoYHNoZWxsY2hlY2sgLS1oZWxwYCk7IHRoZSBnYXRlIG11c3Rcbi8vIGNvbnN1bWUgdGhlIHZhbHVlLCBub3QgcmVhZCBpdCBhcyBhIHBvc2l0aW9uYWwgYXJndW1lbnQuXG5jb25zdCBTSEVMTENIRUNLX1NIT1JUX1ZBTFVFX09QVElPTlMgPSBcImVzU29pUGZXXCI7XG5jb25zdCBTSEVMTENIRUNLX0xPTkdfVkFMVUVfT1BUSU9OUyA9IFtcbiAgXCJleGNsdWRlXCIsXG4gIFwic2hlbGxcIixcbiAgXCJzZXZlcml0eVwiLFxuICBcImVuYWJsZVwiLFxuICBcImluY2x1ZGVcIixcbiAgXCJzb3VyY2UtcGF0aFwiLFxuICBcImZvcm1hdFwiLFxuICBcIndpa2ktbGluay1jb3VudFwiLFxuXTtcblxuZnVuY3Rpb24gZGVmYXVsdFNoZWxsY2hlY2tDb25maWdzKHRyYWNrZWQ6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICByZXR1cm4gdHJhY2tlZC5maWx0ZXIoKGNhbmRpZGF0ZSkgPT5cbiAgICBTSEVMTENIRUNLX0NPTkZJR1MuaGFzKGNhbmRpZGF0ZS5zcGxpdChcIi9cIikuYXQoLTEpID8/IFwiXCIpXG4gICk7XG59XG5cbmNvbnN0IFNIRUxMQ0hFQ0tfQUNUSU9OX1NFVkVSSVRJRVMgPSBbXCJlcnJvclwiLCBcIndhcm5pbmdcIiwgXCJpbmZvXCIsIFwic3R5bGVcIl07XG5cbi8qKlxuICogRmxhZ3MgZm9yIGVhY2ggYGx1ZGVldXMvYWN0aW9uLXNoZWxsY2hlY2tgIHN0ZXAgaW4gYSB3b3JrZmxvdyAodGhlIHRlbXBsYXRlXG4gKiB0aGUgd29ya2VyIHN5bmNzIGludG8gQmFzaCByZXBvc2l0b3JpZXMpLiBPbmx5IGBzY2FuZGlyOiAuYCBhbmQgYHNldmVyaXR5YFxuICogYXJlIHVuZGVyc3Rvb2Q7IGFueSBvdGhlciBpbnB1dCwgYSBgU0hFTExDSEVDS19PUFRTYCBvdmVycmlkZSBvciBhbm90aGVyXG4gKiBTaGVsbENoZWNrIGFjdGlvbiBpcyBhbiB1bnN1cHBvcnRlZCBwb2xpY3ksIG5ldmVyIGFuIGltcGxpY2l0IHBhc3MuIFRoZVxuICogYWN0aW9uJ3MgZmlsZSBzZWxlY3Rpb24gaXMgYXBwbGllZCBieSB0aGUgZ2F0ZS5cbiAqL1xuZnVuY3Rpb24gc2hlbGxjaGVja0FjdGlvbkZsYWdzKFxuICB0ZXh0OiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbik6IFJlc3VsdDxzdHJpbmdbXVtdLCBzdHJpbmc+IHtcbiAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpLm1hcCgobGluZSkgPT4gbGluZS5yZXBsYWNlKC9cXHIkLywgXCJcIikpO1xuICBjb25zdCBpbmRlbnRPZiA9IChsaW5lOiBzdHJpbmcpID0+IGxpbmUubGVuZ3RoIC0gbGluZS50cmltU3RhcnQoKS5sZW5ndGg7XG4gIGNvbnN0IGZsYWdzUGVyU3RlcDogc3RyaW5nW11bXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdXNlcyA9IC9eKFxccyopKD86LVxccyspP3VzZXNcXHMqOlxccyooW15cXHMjXSspLy5leGVjKGxpbmVzW2ldISk7XG4gICAgaWYgKCF1c2VzIHx8ICEvc2hlbGxjaGVjay9pLnRlc3QodXNlc1syXSEpKSBjb250aW51ZTtcbiAgICBpZiAoIS9ebHVkZWV1c1xcL2FjdGlvbi1zaGVsbGNoZWNrQC8udGVzdCh1c2VzWzJdISkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGB1bnN1cHBvcnRlZCBTaGVsbENoZWNrIGFjdGlvbiBpbiB3b3JrZmxvdyAke3BhdGh9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIFRoZSBzdGVwIHJ1bnMgZnJvbSBpdHMgYC0gYCBsaW5lIHRvIHRoZSBuZXh0IGxpbmUgYXQgdGhhdCBpbmRlbnQgb3IgbGVzcy5cbiAgICBsZXQgc3RhcnQgPSBpO1xuICAgIHdoaWxlIChzdGFydCA+IDAgJiYgIS9eXFxzKi1cXHMvLnRlc3QobGluZXNbc3RhcnRdISkpIHN0YXJ0LS07XG4gICAgY29uc3Qgc3RlcEluZGVudCA9IGluZGVudE9mKGxpbmVzW3N0YXJ0XSEpO1xuICAgIGxldCBlbmQgPSBpICsgMTtcbiAgICB3aGlsZSAoXG4gICAgICBlbmQgPCBsaW5lcy5sZW5ndGggJiZcbiAgICAgIChsaW5lc1tlbmRdIS50cmltKCkgPT09IFwiXCIgfHwgaW5kZW50T2YobGluZXNbZW5kXSEpID4gc3RlcEluZGVudClcbiAgICApIGVuZCsrO1xuICAgIGNvbnN0IHN0ZXAgPSBsaW5lcy5zbGljZShzdGFydCwgZW5kKTtcbiAgICBpZiAoc3RlcC5zb21lKChsaW5lKSA9PiAvU0hFTExDSEVDS19PUFRTLy50ZXN0KGxpbmUpKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjpcbiAgICAgICAgICBgdW5zdXBwb3J0ZWQgU2hlbGxDaGVjayBhY3Rpb24gb3B0aW9uIFNIRUxMQ0hFQ0tfT1BUUyBpbiAke3BhdGh9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGZsYWdzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHdpdGhBdCA9IHN0ZXAuZmluZEluZGV4KChsaW5lKSA9PiAvXlxccyp3aXRoXFxzKjpcXHMqJC8udGVzdChsaW5lKSk7XG4gICAgaWYgKHdpdGhBdCA+PSAwKSB7XG4gICAgICBjb25zdCB3aXRoSW5kZW50ID0gaW5kZW50T2Yoc3RlcFt3aXRoQXRdISk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3RlcC5zbGljZSh3aXRoQXQgKyAxKSkge1xuICAgICAgICBpZiAobGluZS50cmltKCkgPT09IFwiXCIgfHwgbGluZS50cmltKCkuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoaW5kZW50T2YobGluZSkgPD0gd2l0aEluZGVudCkgYnJlYWs7XG4gICAgICAgIGNvbnN0IGlucHV0ID0gL15cXHMqKFtcXHctXSspXFxzKjpcXHMqW1wiJ10/KFteXCInI1xcc10qKVtcIiddP1xccyooPzojLiopPyQvXG4gICAgICAgICAgLmV4ZWMobGluZSk7XG4gICAgICAgIGNvbnN0IFssIGtleSwgdmFsdWVdID0gaW5wdXQgPz8gW107XG4gICAgICAgIGlmIChrZXkgPT09IFwic2NhbmRpclwiICYmICh2YWx1ZSA9PT0gXCIuXCIgfHwgdmFsdWUgPT09IFwiLi9cIikpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoXG4gICAgICAgICAga2V5ID09PSBcInNldmVyaXR5XCIgJiYgU0hFTExDSEVDS19BQ1RJT05fU0VWRVJJVElFUy5pbmNsdWRlcyh2YWx1ZSEpXG4gICAgICAgICkge1xuICAgICAgICAgIGZsYWdzLnB1c2goYC0tc2V2ZXJpdHk9JHt2YWx1ZX1gKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogYHVuc3VwcG9ydGVkIFNoZWxsQ2hlY2sgYWN0aW9uIG9wdGlvbiAke1xuICAgICAgICAgICAga2V5ID8/IGxpbmUudHJpbSgpXG4gICAgICAgICAgfSBpbiAke3BhdGh9YCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgZmxhZ3NQZXJTdGVwLnB1c2goZmxhZ3MpO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZmxhZ3NQZXJTdGVwIH07XG59XG5cbmZ1bmN0aW9uIGlzUmVwb1JlbGF0aXZlU2hlbGxjaGVja0NvbmZpZyhwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuICFwYXRoLnN0YXJ0c1dpdGgoXCIvXCIpICYmXG4gICAgIXBhdGguc3BsaXQoL1tcXFxcL10vKS5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSBcIi5cIiB8fCBwYXJ0ID09PSBcIi4uXCIpO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIHN1cHBvcnRlZCBkaXJlY3QgU2hlbGxDaGVjayBwb2xpY3kgZnJvbSB0cmFja2VkIHdvcmtmbG93IHN0ZXBzLlxuICogQSB3b3JrZmxvdyB0aGF0IGludm9rZXMgU2hlbGxDaGVjayBpbiBhbm90aGVyIHNoYXBlIGlzIGFuIGluY29tcGxldGUgcG9saWN5LFxuICogbmV2ZXIgYW4gaW1wbGljaXQgcGFzcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcG9TaGVsbGNoZWNrUG9saWN5KFxuICByZXBvUm9vdDogc3RyaW5nLFxuICB0cmFja2VkOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFByb21pc2U8UmVzdWx0PFNoZWxsY2hlY2tQb2xpY3kgfCBudWxsLCBzdHJpbmc+PiB7XG4gIGNvbnN0IHBvbGljaWVzOiBTaGVsbGNoZWNrUG9saWN5W10gPSBbXTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIHRyYWNrZWQpIHtcbiAgICBpZiAoIXBhdGguc3RhcnRzV2l0aChcIi5naXRodWIvd29ya2Zsb3dzL1wiKSB8fCAhL1xcLnlhP21sJC8udGVzdChwYXRoKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBzaGVsbGNoZWNrRmlsZUluZm8ocmVwb1Jvb3QsIHBhdGgpO1xuICAgICAgaWYgKGluZm8gPT09IG51bGwpIGNvbnRpbnVlOyAvLyBHaXRIdWIgZG9lcyBub3QgcnVuIHN5bWxpbmtlZCB3b3JrZmxvd3MuXG4gICAgICB0ZXh0ID0gYXdhaXQgcmVhZEJvdW5kZWRQb2xpY3lGaWxlKHJlcG9Sb290LCBwYXRoLCBpbmZvKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogYGNhbm5vdCByZWFkIHRyYWNrZWQgd29ya2Zsb3cgJHtwYXRofTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBib2RpZXMgPSB3b3JrZmxvd1J1blN0ZXBCb2RpZXModGV4dCk7XG4gICAgaWYgKCFib2RpZXMub2spIHJldHVybiBib2RpZXM7XG4gICAgY29uc3QgcnVuU3RlcHMgPSBib2RpZXMudmFsdWU7XG4gICAgY29uc3QgZGVsZWdhdGVkID0gYXdhaXQgd29ya2Zsb3dEZWxlZ2F0ZXNUb1NoZWxsY2hlY2soXG4gICAgICByZXBvUm9vdCxcbiAgICAgIHRyYWNrZWQsXG4gICAgICBydW5TdGVwcyxcbiAgICApO1xuICAgIGlmICghZGVsZWdhdGVkLm9rKSByZXR1cm4gZGVsZWdhdGVkO1xuICAgIGlmIChkZWxlZ2F0ZWQudmFsdWUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6XG4gICAgICAgICAgYHJlcG9zaXRvcnkgQ0kgZGVsZWdhdGVzIFNoZWxsQ2hlY2sgdGhyb3VnaCBhIHNjcmlwdCBpbiB3b3JrZmxvdyAke3BhdGh9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGFjdGlvbkZsYWdzID0gc2hlbGxjaGVja0FjdGlvbkZsYWdzKHRleHQsIHBhdGgpO1xuICAgIGlmICghYWN0aW9uRmxhZ3Mub2spIHJldHVybiBhY3Rpb25GbGFncztcbiAgICBmb3IgKGNvbnN0IGZsYWdzIG9mIGFjdGlvbkZsYWdzLnZhbHVlKSB7XG4gICAgICBwb2xpY2llcy5wdXNoKHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgZmxhZ3MsXG4gICAgICAgIGNvbmZpZ0ZpbGVzOiBkZWZhdWx0U2hlbGxjaGVja0NvbmZpZ3ModHJhY2tlZCksXG4gICAgICAgIHdvcmtmbG93RmlsZXM6IFtwYXRoXSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjb25zdCBjb21tYW5kcyA9IHJ1blN0ZXBzLmZsYXRNYXAoZXhlY3V0YWJsZVNoZWxsQ29tbWFuZHMpLmZpbHRlcihcbiAgICAgIGlzU2hlbGxjaGVja0ludm9jYXRpb24sXG4gICAgKTtcbiAgICBpZiAoXG4gICAgICAoYWN0aW9uRmxhZ3MudmFsdWUubGVuZ3RoID4gMCB8fCBjb21tYW5kcy5sZW5ndGggPiAwKSAmJlxuICAgICAgL1NIRUxMQ0hFQ0tfT1BUUy8udGVzdCh0ZXh0KVxuICAgICkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjpcbiAgICAgICAgICBgdW5zdXBwb3J0ZWQgU2hlbGxDaGVjayBhY3Rpb24gb3B0aW9uIFNIRUxMQ0hFQ0tfT1BUUyBpbiAke3BhdGh9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChjb21tYW5kcy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGlmIChcbiAgICAgIC9eXFxzKndvcmtpbmctZGlyZWN0b3J5XFxzKjpcXHMqKD8hW1wiJ10/XFwuW1wiJ10/XFxzKig/OiMuKik/JCkvbS50ZXN0KHRleHQpXG4gICAgKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOlxuICAgICAgICAgIGBTaGVsbENoZWNrIHdvcmtmbG93ICR7cGF0aH0gc2V0cyBhbiB1bnN1cHBvcnRlZCB3b3JraW5nLWRpcmVjdG9yeWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCB2ZXJzaW9ucyA9IFtcbiAgICAgIC4uLnRleHQubWF0Y2hBbGwoXG4gICAgICAgIC9eXFxzKlNIRUxMQ0hFQ0tfVkVSU0lPTlxccyo6XFxzKltcIiddPyhcXGQrXFwuXFxkK1xcLlxcZCspW1wiJ10/XFxzKig/OiMuKik/JC9nbSxcbiAgICAgICksXG4gICAgXVxuICAgICAgLm1hcCgobWF0Y2gpID0+IG1hdGNoWzFdISk7XG4gICAgY29uc3QgdW5pcXVlVmVyc2lvbnMgPSBbLi4ubmV3IFNldCh2ZXJzaW9ucyldO1xuICAgIGlmICh1bmlxdWVWZXJzaW9ucy5sZW5ndGggIT09IDEpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6XG4gICAgICAgICAgYFNoZWxsQ2hlY2sgd29ya2Zsb3cgJHtwYXRofSBkb2VzIG5vdCBkZWNsYXJlIG9uZSBzdXBwb3J0ZWQgcGlubmVkIHZlcnNpb25gLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgdmVyc2lvbiA9IHVuaXF1ZVZlcnNpb25zWzBdITtcbiAgICBmb3IgKGNvbnN0IGNvbW1hbmQgb2YgY29tbWFuZHMpIHtcbiAgICAgIGNvbnN0IG1hdGNoID1cbiAgICAgICAgL15maW5kXFxzK1xcLlxccystbmFtZVxccytbXCInXVxcKlxcLnNoW1wiJ11cXHMrLXR5cGVcXHMrZlxccystZXhlY1xccytzaGVsbGNoZWNrKD86XFxzKyguKz8pKT9cXHMrXFx7XFx9XFxzK1xcKyQvXG4gICAgICAgICAgLmV4ZWMoXG4gICAgICAgICAgICBjb21tYW5kLFxuICAgICAgICAgICk7XG4gICAgICBpZiAoIW1hdGNoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBgdW5zdXBwb3J0ZWQgU2hlbGxDaGVjayBjb21tYW5kIGluICR7cGF0aH06ICR7Y29tbWFuZH1gLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgY29uc3QgYXJncyA9IHRva2VuaXNlQ29tbWFuZChtYXRjaFsxXSA/PyBcIlwiKTtcbiAgICAgIGNvbnN0IGV4cGxpY2l0Q29uZmlnRmlsZXM6IHN0cmluZ1tdID0gW107XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY29uc3QgYXJnID0gYXJnc1tpXSE7XG4gICAgICAgIGlmICghYXJnLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgICBgdW5zdXBwb3J0ZWQgcG9zaXRpb25hbCBTaGVsbENoZWNrIGFyZ3VtZW50IGluICR7cGF0aH06ICR7Y29tbWFuZH1gLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIGFyZyA9PT0gXCItLXJjZmlsZVwiIHx8IGFyZyA9PT0gXCItcmNcIiB8fCBhcmcuc3RhcnRzV2l0aChcIi0tcmNmaWxlPVwiKVxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IGFyZy5zdGFydHNXaXRoKFwiLS1yY2ZpbGU9XCIpXG4gICAgICAgICAgICA/IGFyZy5zbGljZShcIi0tcmNmaWxlPVwiLmxlbmd0aClcbiAgICAgICAgICAgIDogYXJnc1srK2ldO1xuICAgICAgICAgIGlmICghdmFsdWUgfHwgdmFsdWUuc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IGBtaXNzaW5nIFNoZWxsQ2hlY2sgcmNmaWxlIGluICR7cGF0aH1gIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICghaXNSZXBvUmVsYXRpdmVTaGVsbGNoZWNrQ29uZmlnKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICBlcnJvcjogYHVuc2FmZSBTaGVsbENoZWNrIHJjZmlsZSBwYXRoIGluICR7cGF0aH1gLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZXhwbGljaXRDb25maWdGaWxlcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgfSBlbHNlIGlmIChhcmcuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICAgICAgY29uc3QgW25hbWUsIC4uLmlubGluZV0gPSBhcmcuc2xpY2UoMikuc3BsaXQoXCI9XCIpO1xuICAgICAgICAgIGNvbnN0IHRha2VzVmFsdWUgPSBTSEVMTENIRUNLX0xPTkdfVkFMVUVfT1BUSU9OUy5pbmNsdWRlcyhuYW1lISk7XG4gICAgICAgICAgaWYgKHRha2VzVmFsdWUgJiYgaW5saW5lLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGlmIChpbmxpbmUuam9pbihcIj1cIikgPT09IFwiXCIpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgICAgICAgZXJyb3I6XG4gICAgICAgICAgICAgICAgICBgbWlzc2luZyB2YWx1ZSBmb3IgU2hlbGxDaGVjayBvcHRpb24gLS0ke25hbWV9IGluICR7cGF0aH1gLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSBpZiAodGFrZXNWYWx1ZSkge1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBhcmdzWysraV07XG4gICAgICAgICAgICBpZiAoIXZhbHVlIHx8IHZhbHVlLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGVycm9yOiBgbWlzc2luZyB2YWx1ZSBmb3IgU2hlbGxDaGVjayBvcHRpb24gJHthcmd9IGluICR7cGF0aH1gLFxuICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBPdGhlciBsb25nIG9wdGlvbnMgcGFzcyB0aHJvdWdoIHVuY2hhbmdlZDsgU2hlbGxDaGVjayB2YWxpZGF0ZXMgdGhlbS5cbiAgICAgICAgfSBlbHNlIGlmICgvXi1bQS1aYS16XSQvLnRlc3QoYXJnKSkge1xuICAgICAgICAgIGlmIChTSEVMTENIRUNLX1NIT1JUX1ZBTFVFX09QVElPTlMuaW5jbHVkZXMoYXJnWzFdISkpIHtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gYXJnc1srK2ldO1xuICAgICAgICAgICAgaWYgKCF2YWx1ZSB8fCB2YWx1ZS5zdGFydHNXaXRoKFwiLVwiKSkge1xuICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBlcnJvcjogYG1pc3NpbmcgdmFsdWUgZm9yIFNoZWxsQ2hlY2sgb3B0aW9uICR7YXJnfSBpbiAke3BhdGh9YCxcbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gT3RoZXIgc2hvcnQgb3B0aW9ucyBwYXNzIHRocm91Z2ggdW5jaGFuZ2VkOyBTaGVsbENoZWNrIHZhbGlkYXRlcyB0aGVtLlxuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIGFyZy5sZW5ndGggPiAyICYmIFNIRUxMQ0hFQ0tfU0hPUlRfVkFMVUVfT1BUSU9OUy5pbmNsdWRlcyhhcmdbMV0hKSAmJlxuICAgICAgICAgIC9eLVtBLVphLXpdLy50ZXN0KGFyZylcbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gQXR0YWNoZWQgdmFsdWUgKC1Td2FybmluZyk6IG9uZSB0b2tlbiwgbm90aGluZyBmdXJ0aGVyIHRvIGNvbnN1bWUuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIGVycm9yOiBgdW5zdXBwb3J0ZWQgU2hlbGxDaGVjayBvcHRpb24gJHthcmd9IGluICR7cGF0aH1gLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IGNvbmZpZ0ZpbGVzID0gYXJncy5pbmNsdWRlcyhcIi0tbm9yY1wiKVxuICAgICAgICA/IFtdXG4gICAgICAgIDogZXhwbGljaXRDb25maWdGaWxlcy5sZW5ndGggPiAwXG4gICAgICAgID8gZXhwbGljaXRDb25maWdGaWxlc1xuICAgICAgICA6IGRlZmF1bHRTaGVsbGNoZWNrQ29uZmlncyh0cmFja2VkKTtcbiAgICAgIHBvbGljaWVzLnB1c2goe1xuICAgICAgICB2ZXJzaW9uLFxuICAgICAgICBmbGFnczogYXJncyxcbiAgICAgICAgY29uZmlnRmlsZXMsXG4gICAgICAgIHdvcmtmbG93RmlsZXM6IFtwYXRoXSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICBpZiAocG9saWNpZXMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgY29uc3QgZmlyc3QgPSBwb2xpY2llc1swXSE7XG4gIGlmIChcbiAgICBwb2xpY2llcy5zb21lKChwKSA9PlxuICAgICAgcC52ZXJzaW9uICE9PSBmaXJzdC52ZXJzaW9uIHx8XG4gICAgICBKU09OLnN0cmluZ2lmeShwLmZsYWdzKSAhPT0gSlNPTi5zdHJpbmdpZnkoZmlyc3QuZmxhZ3MpIHx8XG4gICAgICBKU09OLnN0cmluZ2lmeShwLmNvbmZpZ0ZpbGVzKSAhPT0gSlNPTi5zdHJpbmdpZnkoZmlyc3QuY29uZmlnRmlsZXMpXG4gICAgKVxuICApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IFwicmVwb3NpdG9yeSBDSSBkZWNsYXJlcyBjb25mbGljdGluZyBTaGVsbENoZWNrIHBvbGljaWVzXCIsXG4gICAgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIHZhbHVlOiB7XG4gICAgICAuLi5maXJzdCxcbiAgICAgIHdvcmtmbG93RmlsZXM6IFsuLi5uZXcgU2V0KHBvbGljaWVzLmZsYXRNYXAoKHApID0+IHAud29ya2Zsb3dGaWxlcykpXSxcbiAgICB9LFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3b3JrZmxvd0RlbGVnYXRlc1RvU2hlbGxjaGVjayhcbiAgcmVwb1Jvb3Q6IHN0cmluZyxcbiAgdHJhY2tlZDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJ1blN0ZXBzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IFByb21pc2U8UmVzdWx0PGJvb2xlYW4sIHN0cmluZz4+IHtcbiAgY29uc3Qgc2NyaXB0Q2FsbHMgPSAoYm9keTogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgICBleGVjdXRhYmxlU2hlbGxDb21tYW5kcyhib2R5KVxuICAgICAgLm1hcCgobGluZSkgPT4ge1xuICAgICAgICBjb25zdCB0b2tlbnMgPSB0b2tlbmlzZUNvbW1hbmQobGluZSk7XG4gICAgICAgIGNvbnN0IGZpcnN0ID0gdG9rZW5zWzBdO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZmlyc3QgPT09IFwiYmFzaFwiIHx8IGZpcnN0ID09PSBcInNoXCIgfHwgZmlyc3QgPT09IFwic291cmNlXCIgfHxcbiAgICAgICAgICBmaXJzdCA9PT0gXCIuXCJcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIHRva2Vucy5zbGljZSgxKS5maW5kKCh0KSA9PiAhdC5zdGFydHNXaXRoKFwiLVwiKSkgPz8gXCJcIjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmlyc3QgPz8gXCJcIjtcbiAgICAgIH0pLm1hcCgocGF0aCkgPT4gcGF0aC5zdGFydHNXaXRoKFwiLi9cIikgPyBwYXRoLnNsaWNlKDIpIDogcGF0aClcbiAgICAgIC5maWx0ZXIoKHBhdGgpID0+XG4gICAgICAgIHBhdGguZW5kc1dpdGgoXCIuc2hcIikgJiZcbiAgICAgICAgaXNSZXBvUmVsYXRpdmVTaGVsbGNoZWNrQ29uZmlnKHBhdGgpICYmIHRyYWNrZWQuaW5jbHVkZXMocGF0aClcbiAgICAgICk7XG4gIGNvbnN0IHBlbmRpbmcgPSBuZXcgU2V0KHJ1blN0ZXBzLmZsYXRNYXAoc2NyaXB0Q2FsbHMpKTtcblxuICBjb25zdCBpbnNwZWN0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgd2hpbGUgKHBlbmRpbmcuc2l6ZSA+IDApIHtcbiAgICBjb25zdCBwYXRoID0gcGVuZGluZy52YWx1ZXMoKS5uZXh0KCkudmFsdWUgYXMgc3RyaW5nO1xuICAgIHBlbmRpbmcuZGVsZXRlKHBhdGgpO1xuICAgIGlmIChpbnNwZWN0ZWQuaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICBpbnNwZWN0ZWQuYWRkKHBhdGgpO1xuICAgIGxldCB0ZXh0OiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBzaGVsbGNoZWNrRmlsZUluZm8ocmVwb1Jvb3QsIHBhdGgpO1xuICAgICAgaWYgKCFpbmZvKSB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSByZWd1bGFyIGluLXJlcG9zaXRvcnkgZmlsZVwiKTtcbiAgICAgIHRleHQgPSBhd2FpdCByZWFkQm91bmRlZFBvbGljeUZpbGUocmVwb1Jvb3QsIHBhdGgsIGluZm8pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBgY2Fubm90IHJlYWQgdHJhY2tlZCB3b3JrZmxvdyBzY3JpcHQgJHtwYXRofTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAoZXhlY3V0YWJsZVNoZWxsQ29tbWFuZHModGV4dCkuc29tZShpc1NoZWxsY2hlY2tJbnZvY2F0aW9uKSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0cnVlIH07XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2FsbGVkIG9mIHNjcmlwdENhbGxzKHRleHQpKSBwZW5kaW5nLmFkZChjYWxsZWQpO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogZmFsc2UgfTtcbn1cblxuZnVuY3Rpb24gaXNTaGVsbGNoZWNrSW52b2NhdGlvbihsaW5lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdG9rZW5zID0gdG9rZW5pc2VDb21tYW5kKGxpbmUpO1xuICBjb25zdCBjb21tYW5kT3B0aW9uID0gdG9rZW5zLmZpbmRJbmRleCgodG9rZW4sIGkpID0+XG4gICAgaSA+IDAgJiYgL14tW2EtekEtWl0qY1thLXpBLVpdKiQvLnRlc3QodG9rZW4pXG4gICk7XG4gIGNvbnN0IHNoZWxsQ29tbWFuZCA9XG4gICAgW1wiYmFzaFwiLCBcInNoXCJdLmluY2x1ZGVzKHRva2Vuc1swXT8uc3BsaXQoXCIvXCIpLmF0KC0xKSA/PyBcIlwiKSAmJlxuICAgIGNvbW1hbmRPcHRpb24gPiAwICYmIHRva2Vuc1tjb21tYW5kT3B0aW9uICsgMV0gIT09IHVuZGVmaW5lZCAmJlxuICAgIGV4ZWN1dGFibGVTaGVsbENvbW1hbmRzKHRva2Vuc1tjb21tYW5kT3B0aW9uICsgMV0hKS5zb21lKFxuICAgICAgaXNTaGVsbGNoZWNrSW52b2NhdGlvbixcbiAgICApO1xuICBjb25zdCBkb2NrZXJJbWFnZSA9IHRva2Vuc1swXSA9PT0gXCJkb2NrZXJcIiAmJlxuICAgIHRva2Vucy5zb21lKCh0b2tlbikgPT5cbiAgICAgIC8oPzpefFxcLylrb2FsYW1hblxcL3NoZWxsY2hlY2soPzo6W15cXHNAXSspPyg/OkBbXlxcc10rKT8kLy50ZXN0KHRva2VuKVxuICAgICk7XG4gIGNvbnN0IGluZGlyZWN0ID0gIVtcbiAgICBcImVjaG9cIixcbiAgICBcInByaW50ZlwiLFxuICAgIFwiYXB0XCIsXG4gICAgXCJhcHQtZ2V0XCIsXG4gICAgXCJicmV3XCIsXG4gICAgXCJjdXJsXCIsXG4gICAgXCJ3Z2V0XCIsXG4gICAgXCJ0YXJcIixcbiAgICBcIm12XCIsXG4gICAgXCJjcFwiLFxuICAgIFwiY2htb2RcIixcbiAgICBcImluc3RhbGxcIixcbiAgXVxuICAgIC5pbmNsdWRlcyh0b2tlbnNbMF0gPz8gXCJcIikgJiZcbiAgICB0b2tlbnMuc2xpY2UoMSkuc29tZSgodG9rZW4sIGluZGV4LCByZXN0KSA9PlxuICAgICAgKHRva2VuLnNwbGl0KFwiL1wiKS5hdCgtMSk/LmluY2x1ZGVzKFwic2hlbGxjaGVja1wiKSA/PyBmYWxzZSkgJiZcbiAgICAgIHJlc3RbaW5kZXggKyAxXSAhPT0gXCItLXZlcnNpb25cIlxuICAgICk7XG4gIGNvbnN0IHdyYXBwZWQgPSBbXCJ4YXJnc1wiLCBcInBhcmFsbGVsXCIsIFwiZG9cIiwgXCJ0aW1lXCIsIFwiZXhlY1wiLCBcIm5pY2VcIiwgXCJ0aW1lb3V0XCJdXG4gICAgLmluY2x1ZGVzKHRva2Vuc1swXSA/PyBcIlwiKSAmJlxuICAgIHRva2Vucy5zbGljZSgxKS5zb21lKCh0b2tlbiwgaW5kZXgsIHJlc3QpID0+XG4gICAgICB0b2tlbi5zcGxpdChcIi9cIikuYXQoLTEpID09PSBcInNoZWxsY2hlY2tcIiAmJlxuICAgICAgcmVzdFtpbmRleCArIDFdICE9PSBcIi0tdmVyc2lvblwiXG4gICAgKTtcbiAgcmV0dXJuICgodG9rZW5zWzBdPy5zcGxpdChcIi9cIikuYXQoLTEpPy5pbmNsdWRlcyhcInNoZWxsY2hlY2tcIikgPz8gZmFsc2UpICYmXG4gICAgdG9rZW5zWzFdICE9PSBcIi0tdmVyc2lvblwiKSB8fFxuICAgIHdyYXBwZWQgfHwgc2hlbGxDb21tYW5kIHx8IGRvY2tlckltYWdlIHx8IGluZGlyZWN0IHx8XG4gICAgKHRva2Vuc1swXSA9PT0gXCJmaW5kXCIgJiZcbiAgICAgIHRva2Vucy5zb21lKCh0LCBpKSA9PiB0ID09PSBcIi1leGVjXCIgJiYgdG9rZW5zW2kgKyAxXSA9PT0gXCJzaGVsbGNoZWNrXCIpKTtcbn1cblxuLyoqIEluc3BlY3QgY29tbWFuZCBwb3NpdGlvbnMsIGtlZXBpbmcgcXVvdGVkIGxvZy9kYXRhIHN0cmluZ3Mgb3V0IG9mIGRpc2NvdmVyeS4gKi9cbmZ1bmN0aW9uIGV4ZWN1dGFibGVTaGVsbENvbW1hbmRzKGJvZHk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgY29tbWFuZHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBpbkFycmF5ID0gZmFsc2U7XG4gIGZvciAoY29uc3QgbGluZSBvZiBib2R5LnJlcGxhY2UoL1xcXFxcXHI/XFxuXFxzKi9nLCBcIiBcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoaW5BcnJheSkge1xuICAgICAgaWYgKC9eXFxzKlxcKS8udGVzdChsaW5lKSkgaW5BcnJheSA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICgvXlxccyooPzooPzpyZWFkb25seXxsb2NhbHxkZWNsYXJlKSg/OlxccystXFx3KykqXFxzKyk/XFx3Kz1cXCgvLnRlc3QobGluZSkpIHtcbiAgICAgIGluQXJyYXkgPSAhL1xcKVxccyooPzojLiopPyQvLnRlc3QobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgcGFydHMgPVxuICAgICAgbGluZS5tYXRjaCgvXCJbXlwiXFxuXSpcInwnW14nXFxuXSonfCNbXlxcbl0qfCYmfFxcfFxcfHxbO3xdfFteXFxzO3xdKy9nKSA/PyBbXTtcbiAgICBsZXQgY3VycmVudDogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBmbHVzaCA9ICgpID0+IHtcbiAgICAgIHdoaWxlIChcbiAgICAgICAgY3VycmVudC5sZW5ndGggJiZcbiAgICAgICAgKC9eW0EtWmEtel9dW0EtWmEtejAtOV9dKj0vLnRlc3QoY3VycmVudFswXSEpIHx8XG4gICAgICAgICAgW1wiaWZcIiwgXCJ0aGVuXCIsIFwiZWxpZlwiLCBcImVsc2VcIiwgXCIhXCIsIFwic3Vkb1wiLCBcImVudlwiLCBcImNvbW1hbmRcIl1cbiAgICAgICAgICAgIC5pbmNsdWRlcyhjdXJyZW50WzBdISkpXG4gICAgICApIHtcbiAgICAgICAgY3VycmVudC5zaGlmdCgpO1xuICAgICAgfVxuICAgICAgaWYgKGN1cnJlbnQubGVuZ3RoKSBjb21tYW5kcy5wdXNoKGN1cnJlbnQuam9pbihcIiBcIikpO1xuICAgICAgY3VycmVudCA9IFtdO1xuICAgIH07XG4gICAgZm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG4gICAgICBpZiAocGFydC5zdGFydHNXaXRoKFwiI1wiKSkgYnJlYWs7XG4gICAgICBpZiAoW1wiO1wiLCBcInxcIiwgXCImJlwiLCBcInx8XCJdLmluY2x1ZGVzKHBhcnQpKSBmbHVzaCgpO1xuICAgICAgZWxzZSBjdXJyZW50LnB1c2gocGFydCk7XG4gICAgfVxuICAgIGZsdXNoKCk7XG4gIH1cbiAgcmV0dXJuIGNvbW1hbmRzO1xufVxuXG5mdW5jdGlvbiB3b3JrZmxvd1J1blN0ZXBCb2RpZXModGV4dDogc3RyaW5nKTogUmVzdWx0PHN0cmluZ1tdLCBzdHJpbmc+IHtcbiAgY29uc3QgYm9kaWVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzdGVwS2V5ID0gL14oXFxzKikoPzotXFxzKyk/cnVuXFxzKjooLiopJC87XG4gIGNvbnN0IGxpbmVzID0gdGV4dC5zcGxpdChcIlxcblwiKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXSEucmVwbGFjZSgvXFxyJC8sIFwiXCIpO1xuICAgIGNvbnN0IHN0ZXAgPSBzdGVwS2V5LmV4ZWMobGluZSk7XG4gICAgaWYgKCFzdGVwKSBjb250aW51ZTtcbiAgICBjb25zdCByZXN0ID0gKHN0ZXBbMl0gPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICghL15bfD5dWy0rMC05XSooPzpcXHMrIy4qKT8kLy50ZXN0KHJlc3QpKSB7XG4gICAgICBpZiAoL15bfD5dLy50ZXN0KHJlc3QpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBgY2Fubm90IGludGVycHJldCB3b3JrZmxvdyBydW4gYm9keTogJHtyZXN0fWAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBib2RpZXMucHVzaCgvXihcIi4qXCJ8Jy4qJykkLy50ZXN0KHJlc3QpID8gcmVzdC5zbGljZSgxLCAtMSkgOiByZXN0KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBpbmRlbnQgPSAoc3RlcFsxXSA/PyBcIlwiKS5sZW5ndGg7XG4gICAgY29uc3QgYmxvY2s6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChpKys7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgbmV4dCA9IGxpbmVzW2ldIS5yZXBsYWNlKC9cXHIkLywgXCJcIik7XG4gICAgICBpZiAobmV4dC50cmltKCkgPT09IFwiXCIpIHtcbiAgICAgICAgYmxvY2sucHVzaChcIlwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAobmV4dC5sZW5ndGggLSBuZXh0LnRyaW1TdGFydCgpLmxlbmd0aCA8PSBpbmRlbnQpIHtcbiAgICAgICAgaS0tO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGJsb2NrLnB1c2gobmV4dC50cmltU3RhcnQoKSk7XG4gICAgfVxuICAgIGJvZGllcy5wdXNoKGJsb2NrLmpvaW4oXCJcXG5cIikpO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogYm9kaWVzIH07XG59XG5cbmZ1bmN0aW9uIHNoZWxsY2hlY2tWZXJzaW9uT3V0cHV0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gL152ZXJzaW9uOlxccyooXFxkK1xcLlxcZCtcXC5cXGQrKVxccyokL20uZXhlYyh0ZXh0KT8uWzFdID8/IG51bGw7XG59XG5cbi8vIFNJTVBMRS1PTi1QVVJQT1NFOiBmaXhlZCBkZW5vIGZtdC9saW50IGV4dGVuc2lvbiBhbGxvdy1saXN0LCBleHRyYSB0eXBlcyBhIHJlcG8gY29uZmlndXJlcyBhcmUgbGVmdCB0byBpdHMgcHJlLWZsaWdodCDigJQgdXBncmFkZSB3aGVuIGEgcmVwbyBuZWVkcyBhbm90aGVyIHR5cGUgY2hlY2tlZCBvbiBwdXNoXG5jb25zdCBERU5PX0ZPUk1BVF9FWFRFTlNJT05TID0gW1xuICBcIi50c1wiLFxuICBcIi50c3hcIixcbiAgXCIuanNcIixcbiAgXCIuanN4XCIsXG4gIFwiLm1qc1wiLFxuICBcIi5janNcIixcbiAgXCIubXRzXCIsXG4gIFwiLmN0c1wiLFxuICBcIi5qc29uXCIsXG4gIFwiLmpzb25jXCIsXG4gIFwiLm1kXCIsXG4gIFwiLm1hcmtkb3duXCIsXG5dO1xuY29uc3QgREVOT19MSU5UX0VYVEVOU0lPTlMgPSBERU5PX0ZPUk1BVF9FWFRFTlNJT05TLnNsaWNlKDAsIDgpO1xuY29uc3QgTUFSS0RPV05fRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiXTtcbi8qKlxuICogV2hhdCB0aGUgd29ya2VyJ3Mgb3duIGZvcm1hdHRlcnMgbWF5IHJld3JpdGU6IHRoZSBjb2RlIGhhbGYgb2YgdGhlXG4gKiBgZGVubyBmbXRgIGxpc3QuIE1hcmtkb3duIGlzIG5ldmVyIGhhbmRlZCB0byBgZGVubyBmbXRgIOKAlCBpdCByZS13cmFwcyB3aG9sZVxuICogZG9jdW1lbnRzIGFuZCB0cmlwcyBtYXJrZG93bmxpbnQgTUQwMTgg4oCUIHNvIGEgTWFya2Rvd24gbWlzcyBpcyBsZWZ0IHRvIHRoZVxuICogY2hlY2sgdG8gcmVwb3J0LlxuICovXG5jb25zdCBERU5PX0NPREVfRk9STUFUX0VYVEVOU0lPTlMgPSBERU5PX0ZPUk1BVF9FWFRFTlNJT05TLmZpbHRlcigoZXh0KSA9PlxuICAhTUFSS0RPV05fRVhURU5TSU9OUy5pbmNsdWRlcyhleHQpXG4pO1xuXG4vKiogRXh0ZW5zaW9ucyB0aGUgU3BlbGxpbmcgd29ya2Zsb3cncyBnbG9iIGNvdmVycyAoYCoqXFwvKi57bWQsaHRtbCxqcyx0cyxjc3Msc2h9YCkuICovXG5jb25zdCBDU1BFTExfRVhURU5TSU9OUyA9IFtcbiAgXCIubWRcIixcbiAgXCIubWFya2Rvd25cIixcbiAgXCIuaHRtbFwiLFxuICBcIi5qc1wiLFxuICBcIi50c1wiLFxuICBcIi5jc3NcIixcbiAgXCIuc2hcIixcbl07XG5cbi8qKiBDb25maWcgbmFtZXMgY3NwZWxsIGZpbmRzIG9uIGl0cyBvd24gd2hlbiBydW4gZnJvbSB0aGUgcmVwbyByb290LiAqL1xuY29uc3QgQ1NQRUxMX1JPT1RfQ09ORklHUyA9IFtcbiAgXCJjc3BlbGwuanNvblwiLFxuICBcIi5jc3BlbGwuanNvblwiLFxuICBcImNTcGVsbC5qc29uXCIsXG4gIFwiY3NwZWxsLnlhbWxcIixcbiAgXCJjc3BlbGwueW1sXCIsXG4gIC4uLltcImpzb25cIiwgXCJqc29uY1wiLCBcImpzXCIsIFwiY2pzXCIsIFwibWpzXCIsIFwieWFtbFwiLCBcInltbFwiXS5mbGF0TWFwKChleHQpID0+IFtcbiAgICBgY3NwZWxsLmNvbmZpZy4ke2V4dH1gLFxuICAgIGAuY3NwZWxsLmNvbmZpZy4ke2V4dH1gLFxuICBdKSxcbl07XG5cbi8qKiBOb24tcm9vdCBjb25maWcgbG9jYXRpb25zOyBjc3BlbGwgbmVlZHMgYC0tY29uZmlnYCB0byBmaW5kIHRoZXNlLiAqL1xuY29uc3QgQ1NQRUxMX05FU1RFRF9DT05GSUdTID0gW1wiZG9jcy9jc3BlbGwuanNvblwiXTtcblxuY29uc3QgTUFSS0RPV05MSU5UX0NPTkZJR1MgPSBbXG4gIFwiLm1hcmtkb3dubGludC1jbGkyLmpzb25jXCIsXG4gIFwiLm1hcmtkb3dubGludC1jbGkyLnlhbWxcIixcbiAgXCIubWFya2Rvd25saW50LWNsaTIuY2pzXCIsXG4gIFwiLm1hcmtkb3dubGludC1jbGkyLm1qc1wiLFxuICBcIi5tYXJrZG93bmxpbnQuanNvbmNcIixcbiAgXCIubWFya2Rvd25saW50Lmpzb25cIixcbiAgXCIubWFya2Rvd25saW50LnlhbWxcIixcbiAgXCIubWFya2Rvd25saW50LnltbFwiLFxuXTtcblxuLyoqXG4gKiBUaGUgRmxvY2kgQ2xvdWRGb3JtYXRpb24gZGVwbG95IHRlc3QgYC5naXRodWIvd29ya2Zsb3dzL2Zsb2NpLnltbGAgcnVucyBpblxuICogQ0kgKElzc3VlICMzNzI3KS4gQSBwdXNoIHRoYXQgY2hhbmdlcyBhIGZpbGUgdW5kZXIgaXRzIGRpcmVjdG9yeSBydW5zIGl0LFxuICogc28gYSBkZXRlcm1pbmlzdGljIGRlcGxveSBlcnJvciBpcyBjYXVnaHQgYmVmb3JlIHRoZSBwdXNoLiBUaGUgc2NyaXB0IGZhaWxzXG4gKiBjbG9zZWQgd2hlbiBGbG9jaSBjYW5ub3QgYmUgc3RhcnRlZCwgd2hlbiB0aGUgYGF3c2AgQ0xJIGlzIG1pc3Npbmcgb3Igd2hlbiBhXG4gKiBzdGFjayBtaXNzZXMgYENSRUFURV9DT01QTEVURWA7IHdpdGggbm8gRG9ja2VyIHNvY2tldCAodGhlIHdvcmtlciBjb250YWluZXIpXG4gKiBpdCBwcmludHMgYFNLSVBQRUQgKG5lZWRzIERvY2tlcik6IDx0ZW1wbGF0ZT5gIGZvciBhIHRlbXBsYXRlIHRoYXQgY3JlYXRlcyBhblxuICogYEFXUzo6RUMyOjpJbnN0YW5jZWAgYW5kIGxlYXZlcyB0aGF0IHRlbXBsYXRlIHRvIENJLlxuICovXG5jb25zdCBGTE9DSV9URVNUX1NDUklQVCA9IFwiaW5mcmEvY2xvdWRmb3JtYXRpb24vdGVzdC1mbG9jaS5zaFwiO1xuY29uc3QgRkxPQ0lfVEVTVF9ESVIgPSBcImluZnJhL2Nsb3VkZm9ybWF0aW9uL1wiO1xuXG5mdW5jdGlvbiBoYXNFeHRlbnNpb24ocGF0aDogc3RyaW5nLCBleHRlbnNpb25zOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IHBhdGgudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGV4dGVuc2lvbnMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqXG4gKiBRdW90ZSBmb3IgdGhlIHByZS1mbGlnaHQgdG9rZW5pc2VyIChgJ+KApidgIG9yIGBcIuKAplwiYCBzZWdtZW50cywgbm8gZXNjYXBlcykuXG4gKiBSZXR1cm5zIG51bGwgd2hlbiB0aGUgdmFsdWUgY29udGFpbnMgYm90aCBxdW90ZSBraW5kcy5cbiAqL1xuZnVuY3Rpb24gcXVvdGVGb3JUb2tlbmlzZXIodmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXZhbHVlLmluY2x1ZGVzKFwiJ1wiKSkgcmV0dXJuIGAnJHt2YWx1ZX0nYDtcbiAgaWYgKCF2YWx1ZS5pbmNsdWRlcygnXCInKSkgcmV0dXJuIGBcIiR7dmFsdWV9XCJgO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gcXVvdGVBbGwocGF0aHM6IHN0cmluZ1tdKTogUmVzdWx0PHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IHF1b3RlZDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gICAgLy8gQSBsZWFkaW5nIGRhc2ggd291bGQgYmUgcmVhZCBhcyBhbiBvcHRpb24uXG4gICAgY29uc3QgYXJnID0gcGF0aC5zdGFydHNXaXRoKFwiLVwiKSA/IGAuLyR7cGF0aH1gIDogcGF0aDtcbiAgICBjb25zdCBxID0gcXVvdGVGb3JUb2tlbmlzZXIoYXJnKTtcbiAgICBpZiAocSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogYGNhbm5vdCBzYWZlbHkgcXVvdGUgcGF0aCAke0pTT04uc3RyaW5naWZ5KHBhdGgpfSBgICtcbiAgICAgICAgICBgKGl0IGNvbnRhaW5zIGJvdGggJyBhbmQgXCIpIOKAlCB0aGUgcHVzaCBpcyBibG9ja2VkLCBub3Qgd2F2ZWQgdGhyb3VnaGAsXG4gICAgICB9O1xuICAgIH1cbiAgICBxdW90ZWQucHVzaChxKTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHF1b3RlZC5qb2luKFwiIFwiKSB9O1xufVxuXG5mdW5jdGlvbiBxdW90ZUFyZ3VtZW50cyhhcmdzOiBzdHJpbmdbXSk6IFJlc3VsdDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBxdW90ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgYXJnIG9mIGFyZ3MpIHtcbiAgICBjb25zdCB2YWx1ZSA9IHF1b3RlRm9yVG9rZW5pc2VyKGFyZyk7XG4gICAgaWYgKHZhbHVlID09PSBudWxsKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBgY2Fubm90IHNhZmVseSBxdW90ZSBTaGVsbENoZWNrIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkoYXJnKX1gLFxuICAgICAgfTtcbiAgICB9XG4gICAgcXVvdGVkLnB1c2godmFsdWUpO1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcXVvdGVkLmpvaW4oXCIgXCIpIH07XG59XG5cbi8qKlxuICogVGhlIHJvb3QtcmVsYXRpdmUgdGVzdCBmaWxlcyBhIHJvb3QncyBgZGVubyB0ZXN0YCBjaGVjayBydW5zOiBlYWNoIGNoYW5nZWRcbiAqIGBfdGVzdC50c2AgdW5kZXIgYHRlc3RzL2AsIHBsdXMgdGhlIGB0ZXN0cy88bmFtZT5fdGVzdC50c2Agc2libGluZyBvZiBlYWNoXG4gKiBjaGFuZ2VkIG5vbi10ZXN0IGAudHNgIHNvdXJjZSBvdXRzaWRlIGB0ZXN0cy9gLiBPbmx5IGZpbGVzIGB0cmFja2VkYCBzdGlsbFxuICogaG9sZHMgY291bnQsIHNvIGEgZGVsZXRlZCB0ZXN0IGlzIG5vdCBydW4uIERlZHVwbGljYXRlZCBhbmQgc29ydGVkLlxuICovXG5mdW5jdGlvbiBwbGFubmVkVW5pdFRlc3RGaWxlcyhcbiAgcmVsOiBzdHJpbmdbXSxcbiAgdHJhY2tlZDogc3RyaW5nW10sXG4gIHJvb3Q6IHN0cmluZyxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgdHJhY2tlZFNldCA9IG5ldyBTZXQodHJhY2tlZCk7XG4gIGNvbnN0IGlzVHJhY2tlZCA9IChmaWxlOiBzdHJpbmcpID0+XG4gICAgdHJhY2tlZFNldC5oYXMocm9vdCA9PT0gXCIuXCIgPyBmaWxlIDogYCR7cm9vdH0vJHtmaWxlfWApO1xuICBjb25zdCB0ZXN0RmlsZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHJlbCkge1xuICAgIGlmIChmaWxlLnN0YXJ0c1dpdGgoXCJ0ZXN0cy9cIikgJiYgZmlsZS5lbmRzV2l0aChcIl90ZXN0LnRzXCIpKSB7XG4gICAgICBpZiAoaXNUcmFja2VkKGZpbGUpKSB0ZXN0RmlsZXMuYWRkKGZpbGUpO1xuICAgIH0gZWxzZSBpZiAoXG4gICAgICBmaWxlLmVuZHNXaXRoKFwiLnRzXCIpICYmICFmaWxlLmVuZHNXaXRoKFwiX3Rlc3QudHNcIikgJiZcbiAgICAgICFmaWxlLnN0YXJ0c1dpdGgoXCJ0ZXN0cy9cIilcbiAgICApIHtcbiAgICAgIGNvbnN0IGJhc2UgPSBmaWxlLnNsaWNlKGZpbGUubGFzdEluZGV4T2YoXCIvXCIpICsgMSwgLVwiLnRzXCIubGVuZ3RoKTtcbiAgICAgIGNvbnN0IHNpYmxpbmcgPSBgdGVzdHMvJHtiYXNlfV90ZXN0LnRzYDtcbiAgICAgIGlmIChpc1RyYWNrZWQoc2libGluZykpIHRlc3RGaWxlcy5hZGQoc2libGluZyk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4udGVzdEZpbGVzXS5zb3J0KCk7XG59XG5cbi8qKlxuICogUGxhbiB0aGUgYWx3YXlzLW9uIGNoYW5nZWQtZmlsZSBmb3JtYXQsIGxpbnQgYW5kIHVuaXQtdGVzdCBjb21tYW5kcy5cbiAqIGBkZW5vU2NvcGVzYCBtYXBzIGEgZGVubyByb290IHRvIGl0cyBwYXJzZWQgaW5jbHVkZS9leGNsdWRlIGNvbmZpZzogZXhwbGljaXRcbiAqIHBhdGhzIG92ZXJyaWRlIGRlbm8ncyBvd24gYGluY2x1ZGVgLCBzbyBhIGZpbGUgdGhlIHJlcG8ncyBgZGVubyBmbXRgIC9cbiAqIGBkZW5vIGxpbnRgIHdvdWxkIG5vdCBjaGVjayBpcyBkcm9wcGVkIGhlcmUgaW5zdGVhZCBvZiBiZWluZyBwYXNzZWQgdG8gZGVuby5cbiAqIEEgcm9vdCB3aXRoIG5vIGVudHJ5IGlzIHVuZmlsdGVyZWQuIGBkZW5vVW5pdFRlc3RSb290c2AgbGlzdHMgdGhlIHJvb3RzXG4gKiB3aG9zZSBjaGFuZ2VkIHRlc3RzIGdldCBhIGBkZW5vIHRlc3RgIGNoZWNrIChzZWVcbiAqIHtAbGluayBsb2FkRGVub1VuaXRUZXN0Um9vdHN9KTsgYWJzZW50IG1lYW5zIG5vIGBkZW5vIHRlc3RgIGNoZWNrLiBJdCBpcyBhXG4gKiB0YXJnZXRlZCBzdWJzZXQg4oCUIGNoYW5nZWQgdGVzdCBmaWxlcyBhbmQgdGhlaXIgc2FtZS1uYW1lZCB0ZXN0cyDigJQgcnVuIHZpYVxuICogdGhlIHJlcG8ncyBvd24gYHRlc3Q6dW5pdGAgdGFzaywgc28gaW50ZWdyYXRpb24gc3VpdGVzIGxpa2UgQ0kncyBzaGFyZHMgYXJlXG4gKiBub3QgcnVuIGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gIGNoYW5nZWQ6IHN0cmluZ1tdLFxuICB0cmFja2VkOiBzdHJpbmdbXSxcbiAgb3B0czoge1xuICAgIHJlcG9Sb290OiBzdHJpbmc7XG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBzdHJpbmcgfCBudWxsO1xuICAgIC8qKiBSZXNvbHZlZCBjc3BlbGwgYmluYXJ5OyBhYnNlbnQgb3IgbnVsbCBtZWFucyBcIm5vdCBmb3VuZFwiLiAqL1xuICAgIGNzcGVsbEJpbmFyeT86IHN0cmluZyB8IG51bGw7XG4gICAgLyoqXG4gICAgICogV2hldGhlciB0aGUgcmVwbydzIG93biBDSSBydW5zIGNzcGVsbC4gV2hlbiBmYWxzZSwgYSB0cmFja2VkIGNzcGVsbFxuICAgICAqIGNvbmZpZyBpcyBub3QgZW5vdWdoIHRvIHJ1biB0aGUgY2hlY2s6IHRoZSBwdXNoIGlzIG5vdCBibG9ja2VkIG9uIGFcbiAgICAgKiB0b29sIENJIHdvdWxkIG5ldmVyIHJ1bi4gRGVmYXVsdHMgdG8gZmFsc2UsIHNvIGEgY2FsbGVyIHRoYXQgZG9lcyBub3RcbiAgICAgKiByZWFkIHRoZSB3b3JrZmxvd3MgY2Fubm90IGJsb2NrIG9uIGNzcGVsbCBieSBhY2NpZGVudC5cbiAgICAgKi9cbiAgICBjc3BlbGxJbkNpPzogYm9vbGVhbjtcbiAgICBkZW5vU2NvcGVzPzogUmVjb3JkPHN0cmluZywgRGVub1Njb3BlQ29uZmlnPjtcbiAgICAvKiogRGVubyByb290cyB3aG9zZSBgdGVzdDp1bml0YCB0YXNrIHRoZSBjaGFuZ2VkIHRlc3RzIHJ1biB0aHJvdWdoLiAqL1xuICAgIGRlbm9Vbml0VGVzdFJvb3RzPzogc3RyaW5nW107XG4gICAgc2hlbGxjaGVja1BvbGljeT86IFNoZWxsY2hlY2tQb2xpY3kgfCBudWxsO1xuICAgIHNoZWxsY2hlY2tCaW5hcnk/OiBzdHJpbmcgfCBudWxsO1xuICAgIHNoZWxsY2hlY2tGaWxlcz86IHN0cmluZ1tdO1xuICB9LFxuKTogUmVzdWx0PENoYW5nZWRGaWxlQ2hlY2tbXSwgc3RyaW5nPiB7XG4gIGNvbnN0IGNoZWNrczogQ2hhbmdlZEZpbGVDaGVja1tdID0gW107XG4gIGNvbnN0IGRpckN3ZCA9IChkaXI6IHN0cmluZykgPT5cbiAgICBkaXIgPT09IFwiLlwiID8gb3B0cy5yZXBvUm9vdCA6IGAke29wdHMucmVwb1Jvb3R9LyR7ZGlyfWA7XG5cbiAgZm9yIChcbiAgICBjb25zdCByb290IG9mIG91dGVybW9zdENvbmZpZ0RpcnModHJhY2tlZCwgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSlcbiAgKSB7XG4gICAgY29uc3QgdW5kZXIgPSByb290ID09PSBcIi5cIlxuICAgICAgPyBjaGFuZ2VkXG4gICAgICA6IGNoYW5nZWQuZmlsdGVyKChwKSA9PiBwLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkpO1xuICAgIGNvbnN0IHJlbCA9IHJvb3QgPT09IFwiLlwiXG4gICAgICA/IHVuZGVyXG4gICAgICA6IHVuZGVyLm1hcCgocCkgPT4gcC5zbGljZShyb290Lmxlbmd0aCArIDEpKTtcbiAgICBjb25zdCBzY29wZSA9IG9wdHMuZGVub1Njb3Blcz8uW3Jvb3RdO1xuICAgIGNvbnN0IGdyb3VwczogQXJyYXk8XG4gICAgICBbXCJmbXRcIiB8IFwibGludFwiLCBzdHJpbmdbXSwgcmVhZG9ubHkgc3RyaW5nW10sIHN0cmluZ11cbiAgICA+ID0gW1xuICAgICAgW1xuICAgICAgICBcImZtdFwiLFxuICAgICAgICByZWwsXG4gICAgICAgIERFTk9fRk9STUFUX0VYVEVOU0lPTlMsXG4gICAgICAgIFwiZGVubyBmbXQgLS1jaGVjayAtLXBlcm1pdC1uby1maWxlc1wiLFxuICAgICAgXSxcbiAgICAgIFtcImxpbnRcIiwgcmVsLCBERU5PX0xJTlRfRVhURU5TSU9OUywgXCJkZW5vIGxpbnQgLS1wZXJtaXQtbm8tZmlsZXNcIl0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IFt0b29sLCBmaWxlcywgZXh0ZW5zaW9ucywgYmFzZV0gb2YgZ3JvdXBzKSB7XG4gICAgICBjb25zdCBsYWJlbCA9IGBkZW5vICR7dG9vbH1gO1xuICAgICAgY29uc3QgbWF0Y2hpbmcgPSBmaWxlcy5maWx0ZXIoKGYpID0+XG4gICAgICAgIGhhc0V4dGVuc2lvbihmLCBleHRlbnNpb25zKSAmJlxuICAgICAgICAoc2NvcGUgPT09IHVuZGVmaW5lZCB8fCBpbkRlbm9TY29wZShmLCBzY29wZSwgdG9vbCkpXG4gICAgICApO1xuICAgICAgaWYgKG1hdGNoaW5nLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBjb25zdCBxdW90ZWQgPSBxdW90ZUFsbChtYXRjaGluZyk7XG4gICAgICBpZiAoIXF1b3RlZC5vaykgcmV0dXJuIHF1b3RlZDtcbiAgICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgICAgbGFiZWw6IGAke2xhYmVsfSAoJHtyb290fSlgLFxuICAgICAgICBjd2Q6IGRpckN3ZChyb290KSxcbiAgICAgICAgY29tbWFuZDogYCR7YmFzZX0gJHtxdW90ZWQudmFsdWV9YCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAob3B0cy5kZW5vVW5pdFRlc3RSb290cz8uaW5jbHVkZXMocm9vdCkpIHtcbiAgICAgIGNvbnN0IHVuaXRUZXN0RmlsZXMgPSBwbGFubmVkVW5pdFRlc3RGaWxlcyhyZWwsIHRyYWNrZWQsIHJvb3QpO1xuICAgICAgaWYgKHVuaXRUZXN0RmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBxdW90ZWQgPSBxdW90ZUFsbCh1bml0VGVzdEZpbGVzKTtcbiAgICAgICAgaWYgKCFxdW90ZWQub2spIHJldHVybiBxdW90ZWQ7XG4gICAgICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgICAgICBsYWJlbDogYGRlbm8gdGVzdCAoJHtyb290fSlgLFxuICAgICAgICAgIGN3ZDogZGlyQ3dkKHJvb3QpLFxuICAgICAgICAgIGNvbW1hbmQ6IGBkZW5vIHRhc2sgdGVzdDp1bml0ICR7cXVvdGVkLnZhbHVlfWAsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3Qgcm9vdCBvZiBvdXRlcm1vc3RDb25maWdEaXJzKHRyYWNrZWQsIFtcIkNhcmdvLnRvbWxcIl0pKSB7XG4gICAgY29uc3QgdG91Y2hlZCA9IGNoYW5nZWQuc29tZSgocCkgPT5cbiAgICAgIGhhc0V4dGVuc2lvbihwLCBbXCIucnNcIl0pICYmIChyb290ID09PSBcIi5cIiB8fCBwLnN0YXJ0c1dpdGgoYCR7cm9vdH0vYCkpXG4gICAgKTtcbiAgICBpZiAoIXRvdWNoZWQpIGNvbnRpbnVlO1xuICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBgY2FyZ28gZm10ICgke3Jvb3R9KWAsXG4gICAgICBjd2Q6IGRpckN3ZChyb290KSxcbiAgICAgIGNvbW1hbmQ6IFwiY2FyZ28gZm10IC0tYWxsIC0tY2hlY2tcIixcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IG1hcmtkb3duID0gY2hhbmdlZC5maWx0ZXIoKHApID0+IGhhc0V4dGVuc2lvbihwLCBNQVJLRE9XTl9FWFRFTlNJT05TKSk7XG4gIGNvbnN0IGNvbmZpZ3VyZWQgPSBNQVJLRE9XTkxJTlRfQ09ORklHUy5zb21lKChuYW1lKSA9PlxuICAgIHRyYWNrZWQuaW5jbHVkZXMobmFtZSlcbiAgKTtcbiAgaWYgKGNvbmZpZ3VyZWQgJiYgbWFya2Rvd24ubGVuZ3RoID4gMCkge1xuICAgIGlmIChvcHRzLm1hcmtkb3dubGludEJpbmFyeSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogXCJtYXJrZG93bmxpbnQgaXMgY29uZmlndXJlZCBmb3IgdGhpcyByZXBvc2l0b3J5IGJ1dCBcIiArXG4gICAgICAgICAgXCJtYXJrZG93bmxpbnQtY2xpMiBjb3VsZCBub3QgYmUgZm91bmQg4oCUIHRoZSBwdXNoIGlzIGJsb2NrZWQsIFwiICtcbiAgICAgICAgICBcIm5vdCB3YXZlZCB0aHJvdWdoXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBiaW5hcnkgPSBxdW90ZUZvclRva2VuaXNlcihvcHRzLm1hcmtkb3dubGludEJpbmFyeSk7XG4gICAgY29uc3QgcXVvdGVkID0gcXVvdGVBbGwobWFya2Rvd24pO1xuICAgIGlmIChiaW5hcnkgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGBjYW5ub3Qgc2FmZWx5IHF1b3RlIHRoZSBtYXJrZG93bmxpbnQgcGF0aCAke1xuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG9wdHMubWFya2Rvd25saW50QmluYXJ5KVxuICAgICAgICB9YCxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmICghcXVvdGVkLm9rKSByZXR1cm4gcXVvdGVkO1xuICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIm1hcmtkb3dubGludFwiLFxuICAgICAgY3dkOiBvcHRzLnJlcG9Sb290LFxuICAgICAgY29tbWFuZDogYCR7YmluYXJ5fSAke3F1b3RlZC52YWx1ZX1gLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3Qgcm9vdENzcGVsbCA9IENTUEVMTF9ST09UX0NPTkZJR1MuZmluZCgobmFtZSkgPT4gdHJhY2tlZC5pbmNsdWRlcyhuYW1lKSk7XG4gIGNvbnN0IG5lc3RlZENzcGVsbCA9IENTUEVMTF9ORVNURURfQ09ORklHUy5maW5kKChuYW1lKSA9PlxuICAgIHRyYWNrZWQuaW5jbHVkZXMobmFtZSlcbiAgKTtcbiAgY29uc3Qgc3BlbGxpbmcgPSBjaGFuZ2VkLmZpbHRlcigocCkgPT4gaGFzRXh0ZW5zaW9uKHAsIENTUEVMTF9FWFRFTlNJT05TKSk7XG4gIGNvbnN0IGNzcGVsbEluQ2kgPSBvcHRzLmNzcGVsbEluQ2kgPz8gZmFsc2U7XG4gIGlmICgocm9vdENzcGVsbCB8fCBuZXN0ZWRDc3BlbGwpICYmIGNzcGVsbEluQ2kgJiYgc3BlbGxpbmcubGVuZ3RoID4gMCkge1xuICAgIGlmICghb3B0cy5jc3BlbGxCaW5hcnkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IFwiY3NwZWxsIGlzIGNvbmZpZ3VyZWQgZm9yIHRoaXMgcmVwb3NpdG9yeSBidXQgY3NwZWxsIGNvdWxkIFwiICtcbiAgICAgICAgICBcIm5vdCBiZSBmb3VuZCDigJQgdGhlIHB1c2ggaXMgYmxvY2tlZCwgbm90IHdhdmVkIHRocm91Z2hcIixcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IGJpbmFyeSA9IHF1b3RlRm9yVG9rZW5pc2VyKG9wdHMuY3NwZWxsQmluYXJ5KTtcbiAgICBjb25zdCBxdW90ZWQgPSBxdW90ZUFsbChzcGVsbGluZyk7XG4gICAgaWYgKGJpbmFyeSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogYGNhbm5vdCBzYWZlbHkgcXVvdGUgdGhlIGNzcGVsbCBwYXRoICR7XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkob3B0cy5jc3BlbGxCaW5hcnkpXG4gICAgICAgIH1gLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKCFxdW90ZWQub2spIHJldHVybiBxdW90ZWQ7XG4gICAgY29uc3QgY29uZmlnID0gcm9vdENzcGVsbCA/IFwiXCIgOiBgLS1jb25maWcgJHtuZXN0ZWRDc3BlbGx9IGA7XG4gICAgY2hlY2tzLnB1c2goe1xuICAgICAgbGFiZWw6IFwiY3NwZWxsXCIsXG4gICAgICBjd2Q6IG9wdHMucmVwb1Jvb3QsXG4gICAgICBjb21tYW5kOlxuICAgICAgICBgJHtiaW5hcnl9IC0tbm8tcHJvZ3Jlc3MgLS1uby1zdW1tYXJ5IC0tbm8tbXVzdC1maW5kLWZpbGVzICR7Y29uZmlnfSR7cXVvdGVkLnZhbHVlfWAsXG4gICAgfSk7XG4gIH1cblxuICBpZiAoXG4gICAgdHJhY2tlZC5pbmNsdWRlcyhGTE9DSV9URVNUX1NDUklQVCkgJiZcbiAgICBjaGFuZ2VkLnNvbWUoKHApID0+IHAuc3RhcnRzV2l0aChGTE9DSV9URVNUX0RJUikpXG4gICkge1xuICAgIGNoZWNrcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcImZsb2NpIGNsb3VkZm9ybWF0aW9uXCIsXG4gICAgICBjd2Q6IG9wdHMucmVwb1Jvb3QsXG4gICAgICBjb21tYW5kOiBgYmFzaCAke0ZMT0NJX1RFU1RfU0NSSVBUfWAsXG4gICAgfSk7XG4gIH1cblxuICBpZiAob3B0cy5zaGVsbGNoZWNrUG9saWN5ICYmIChvcHRzLnNoZWxsY2hlY2tGaWxlcz8ubGVuZ3RoID8/IDApID4gMCkge1xuICAgIGlmICghb3B0cy5zaGVsbGNoZWNrQmluYXJ5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBcIlNoZWxsQ2hlY2sgaXMgcmVxdWlyZWQgYnkgcmVwb3NpdG9yeSBDSSBidXQgY291bGQgbm90IGJlIGZvdW5kXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBiaW5hcnkgPSBxdW90ZUZvclRva2VuaXNlcihvcHRzLnNoZWxsY2hlY2tCaW5hcnkpO1xuICAgIGlmIChiaW5hcnkgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IFwiY2Fubm90IHNhZmVseSBxdW90ZSB0aGUgU2hlbGxDaGVjayBwYXRoXCIgfTtcbiAgICB9XG4gICAgY29uc3QgcG9saWN5ID0gb3B0cy5zaGVsbGNoZWNrUG9saWN5O1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiBvcHRzLnNoZWxsY2hlY2tGaWxlcyA/PyBbXSkge1xuICAgICAgY29uc3QgZXhwbGljaXQgPSBwb2xpY3kuZmxhZ3Muc29tZSgoYSkgPT5cbiAgICAgICAgYSA9PT0gXCItLXJjZmlsZVwiIHx8IGEgPT09IFwiLXJjXCIgfHwgYS5zdGFydHNXaXRoKFwiLS1yY2ZpbGU9XCIpXG4gICAgICApO1xuICAgICAgLy8gQ2hvb3NlIHRoZSBuZWFyZXN0IHRyYWNrZWQgY29uZmlnLCBtYXRjaGluZyBTaGVsbENoZWNrJ3Mgc2VhcmNoIG9yZGVyLFxuICAgICAgLy8gYW5kIHN0b3AgYXQgdGhlIHJlcG8gcm9vdCBpbnN0ZWFkIG9mIGZhbGxpbmcgYmFjayB0byB0aGUgd29ya2VyJ3MgSE9NRS5cbiAgICAgIGxldCBjb25maWc6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICghZXhwbGljaXQgJiYgIXBvbGljeS5mbGFncy5pbmNsdWRlcyhcIi0tbm9yY1wiKSkge1xuICAgICAgICBsZXQgZGlyID0gZmlsZS5pbmNsdWRlcyhcIi9cIilcbiAgICAgICAgICA/IGZpbGUuc2xpY2UoMCwgZmlsZS5sYXN0SW5kZXhPZihcIi9cIikpXG4gICAgICAgICAgOiBcIlwiO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgY29uZmlnID0gW1wiLnNoZWxsY2hlY2tyY1wiLCBcInNoZWxsY2hlY2tyY1wiXS5tYXAoKG5hbWUpID0+XG4gICAgICAgICAgICBkaXIgPyBgJHtkaXJ9LyR7bmFtZX1gIDogbmFtZVxuICAgICAgICAgIClcbiAgICAgICAgICAgIC5maW5kKChjYW5kaWRhdGUpID0+IHBvbGljeS5jb25maWdGaWxlcy5pbmNsdWRlcyhjYW5kaWRhdGUpKTtcbiAgICAgICAgICBpZiAoY29uZmlnIHx8IGRpciA9PT0gXCJcIikgYnJlYWs7XG4gICAgICAgICAgZGlyID0gZGlyLmluY2x1ZGVzKFwiL1wiKSA/IGRpci5zbGljZSgwLCBkaXIubGFzdEluZGV4T2YoXCIvXCIpKSA6IFwiXCI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICAgIC4uLnBvbGljeS5mbGFncyxcbiAgICAgICAgLi4uKGV4cGxpY2l0IHx8IHBvbGljeS5mbGFncy5pbmNsdWRlcyhcIi0tbm9yY1wiKVxuICAgICAgICAgID8gW11cbiAgICAgICAgICA6IGNvbmZpZ1xuICAgICAgICAgID8gW1wiLS1yY2ZpbGVcIiwgY29uZmlnXVxuICAgICAgICAgIDogW1wiLS1ub3JjXCJdKSxcbiAgICAgIF07XG4gICAgICBjb25zdCBxdW90ZWQgPSBxdW90ZUFyZ3VtZW50cyhhcmdzKTtcbiAgICAgIGlmICghcXVvdGVkLm9rKSByZXR1cm4gcXVvdGVkO1xuICAgICAgY29uc3QgZmlsZXMgPSBxdW90ZUFsbChbZmlsZV0pO1xuICAgICAgaWYgKCFmaWxlcy5vaykgcmV0dXJuIGZpbGVzO1xuICAgICAgY2hlY2tzLnB1c2goe1xuICAgICAgICBsYWJlbDogXCJzaGVsbGNoZWNrXCIsXG4gICAgICAgIGN3ZDogb3B0cy5yZXBvUm9vdCxcbiAgICAgICAgY29tbWFuZDogYCR7YmluYXJ5fSAke3F1b3RlZC52YWx1ZX0gJHtmaWxlcy52YWx1ZX1gLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBjaGVja3MgfTtcbn1cblxuLyoqIE9uZSBmb3JtYXR0ZXIgaW52b2NhdGlvbiB0aGF0IGZpeGVzIHdoYXQgYSBjaGFuZ2VkLWZpbGUgY2hlY2sgd291bGQgZmxhZy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRm9ybWF0dGVyRml4IHtcbiAgdG9vbDogXCJjYXJnbyBmbXRcIiB8IFwiZGVubyBmbXRcIjtcbiAgLyoqIFJlcG8tcmVsYXRpdmUgZGlyZWN0b3J5IHRoZSBmb3JtYXR0ZXIgcnVucyBpbjsgXCIuXCIgZm9yIHRoZSByb290LiAqL1xuICBkaXI6IHN0cmluZztcbiAgLyoqIEFyZ3YsIHJ1biB3aXRob3V0IGEgc2hlbGwuICovXG4gIGNtZDogc3RyaW5nW107XG4gIC8qKiBSZXBvLXJlbGF0aXZlIHBhdGhzcGVjcyBzdGFnZWQgYWZ0ZXIgdGhlIGZvcm1hdHRlciBydW5zLiAqL1xuICBwYXRoczogc3RyaW5nW107XG59XG5cbi8qKlxuICogUGxhbiB0aGUgZm9ybWF0dGVyIHJ1bnMgdGhhdCBmaXggd2hhdCB7QGxpbmsgcGxhbkNoYW5nZWRGaWxlQ2hlY2tzfSdzXG4gKiBgZGVubyBmbXQgLS1jaGVja2AgYW5kIGBjYXJnbyBmbXQgLS1jaGVja2Agd291bGQgZmxhZywgb3ZlciB0aGUgc2FtZSBmaWxlczpcbiAqIGBkZW5vIGZtdGAgZ2V0cyB0aGUgY2hhbmdlZCBjb2RlIGZpbGVzIHVuZGVyIGVhY2ggZGVubyByb290IHRoYXQgdGhlXG4gKiByZXBvJ3Mgb3duIGZtdCBzY29wZSBjb3ZlcnMgKG5ldmVyIE1hcmtkb3duKSwgYW5kIGBjYXJnbyBmbXQgLS1hbGxgIHJ1bnNcbiAqIGZvciBhIGNhcmdvIHJvb3Qgd2hvc2UgYC5yc2AgZmlsZXMgY2hhbmdlZCDigJQgdGhlIHNhbWUgd2hvbGUtd29ya3NwYWNlIHNjb3BlXG4gKiBpdHMgY2hlY2sgZW5mb3JjZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuRm9ybWF0dGVyRml4ZXMoXG4gIGNoYW5nZWQ6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICB0cmFja2VkOiBzdHJpbmdbXSxcbiAgZGVub1Njb3BlczogUmVjb3JkPHN0cmluZywgRGVub1Njb3BlQ29uZmlnPiA9IHt9LFxuKTogRm9ybWF0dGVyRml4W10ge1xuICBjb25zdCBmaXhlczogRm9ybWF0dGVyRml4W10gPSBbXTtcbiAgZm9yIChcbiAgICBjb25zdCByb290IG9mIG91dGVybW9zdENvbmZpZ0RpcnModHJhY2tlZCwgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSlcbiAgKSB7XG4gICAgY29uc3Qgc2NvcGUgPSBkZW5vU2NvcGVzW3Jvb3RdO1xuICAgIGNvbnN0IGZpbGVzID0gY2hhbmdlZC5maWx0ZXIoKHApID0+XG4gICAgICAocm9vdCA9PT0gXCIuXCIgfHwgcC5zdGFydHNXaXRoKGAke3Jvb3R9L2ApKSAmJlxuICAgICAgaGFzRXh0ZW5zaW9uKHAsIERFTk9fQ09ERV9GT1JNQVRfRVhURU5TSU9OUylcbiAgICApLm1hcCgocCkgPT4gKHtcbiAgICAgIHJlcG9QYXRoOiBwLFxuICAgICAgcmVsOiByb290ID09PSBcIi5cIiA/IHAgOiBwLnNsaWNlKHJvb3QubGVuZ3RoICsgMSksXG4gICAgfSkpLmZpbHRlcigoZikgPT4gc2NvcGUgPT09IHVuZGVmaW5lZCB8fCBpbkRlbm9TY29wZShmLnJlbCwgc2NvcGUsIFwiZm10XCIpKTtcbiAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBmaXhlcy5wdXNoKHtcbiAgICAgIHRvb2w6IFwiZGVubyBmbXRcIixcbiAgICAgIGRpcjogcm9vdCxcbiAgICAgIGNtZDogW1xuICAgICAgICBcImRlbm9cIixcbiAgICAgICAgXCJmbXRcIixcbiAgICAgICAgXCItLXBlcm1pdC1uby1maWxlc1wiLFxuICAgICAgICAvLyBBIGxlYWRpbmcgZGFzaCB3b3VsZCBiZSByZWFkIGFzIGFuIG9wdGlvbi5cbiAgICAgICAgLi4uZmlsZXMubWFwKChmKSA9PiBmLnJlbC5zdGFydHNXaXRoKFwiLVwiKSA/IGAuLyR7Zi5yZWx9YCA6IGYucmVsKSxcbiAgICAgIF0sXG4gICAgICBwYXRoczogZmlsZXMubWFwKChmKSA9PiBmLnJlcG9QYXRoKSxcbiAgICB9KTtcbiAgfVxuICBmb3IgKGNvbnN0IHJvb3Qgb2Ygb3V0ZXJtb3N0Q29uZmlnRGlycyh0cmFja2VkLCBbXCJDYXJnby50b21sXCJdKSkge1xuICAgIGNvbnN0IGNoYW5nZWRScyA9IGNoYW5nZWQuZmlsdGVyKChwKSA9PlxuICAgICAgaGFzRXh0ZW5zaW9uKHAsIFtcIi5yc1wiXSkgJiYgKHJvb3QgPT09IFwiLlwiIHx8IHAuc3RhcnRzV2l0aChgJHtyb290fS9gKSlcbiAgICApO1xuICAgIGlmIChjaGFuZ2VkUnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICBmaXhlcy5wdXNoKHtcbiAgICAgIHRvb2w6IFwiY2FyZ28gZm10XCIsXG4gICAgICBkaXI6IHJvb3QsXG4gICAgICBjbWQ6IFtcImNhcmdvXCIsIFwiZm10XCIsIFwiLS1hbGxcIl0sXG4gICAgICBwYXRoczogY2hhbmdlZFJzLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBmaXhlcztcbn1cblxuLyoqXG4gKiBQYXJzZSBlYWNoIGRlbm8gcm9vdCdzIGBkZW5vLmpzb25gIC8gYGRlbm8uanNvbmNgIHNjb3BlIGZyb20gdGhlIHdvcmtpbmdcbiAqIHRyZWUuIEEgcm9vdCB3aG9zZSBjb25maWcgaXMgdW5yZWFkYWJsZSBvciB1bnBhcnNlYWJsZSBpcyBsZWZ0IG91dCwgc28gaXRzXG4gKiBmaWxlcyBhcmUgY2hlY2tlZCB1bmZpbHRlcmVkIGFuZCBkZW5vIGl0c2VsZiByZXBvcnRzIHRoZSBicm9rZW4gY29uZmlnLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZERlbm9TY29wZXMoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4gIHRyYWNrZWQ6IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBEZW5vU2NvcGVDb25maWc+PiB7XG4gIGNvbnN0IHNjb3BlczogUmVjb3JkPHN0cmluZywgRGVub1Njb3BlQ29uZmlnPiA9IHt9O1xuICBmb3IgKFxuICAgIGNvbnN0IHJvb3Qgb2Ygb3V0ZXJtb3N0Q29uZmlnRGlycyh0cmFja2VkLCBbXCJkZW5vLmpzb25cIiwgXCJkZW5vLmpzb25jXCJdKVxuICApIHtcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVhZERlbm9Db25maWdUZXh0KHJlcG9Sb290LCByb290KTtcbiAgICBpZiAodGV4dCA9PT0gbnVsbCkgY29udGludWU7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VEZW5vU2NvcGUodGV4dCk7XG4gICAgaWYgKHBhcnNlZCAhPT0gbnVsbCkgc2NvcGVzW3Jvb3RdID0gcGFyc2VkO1xuICB9XG4gIHJldHVybiBzY29wZXM7XG59XG5cbi8qKlxuICogQSBkZW5vIHJvb3QncyBjb25maWcgdGV4dDogYGRlbm8uanNvbmAsIGVsc2UgYGRlbm8uanNvbmNgIHdoZW4gYGRlbm8uanNvbmAgaXNcbiAqIGFic2VudCBvciB1bnJlYWRhYmxlOyBudWxsIHdoZW4gbmVpdGhlciBjYW4gYmUgcmVhZC4gRGVubyBwcmVmZXJzXG4gKiBgZGVuby5qc29uYCwgc28gdGhlIHR3byBhcmUgbmV2ZXIgYm90aCB1c2VkLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkRGVub0NvbmZpZ1RleHQoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4gIHJvb3Q6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBkaXIgPSByb290ID09PSBcIi5cIiA/IHJlcG9Sb290IDogYCR7cmVwb1Jvb3R9LyR7cm9vdH1gO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoYCR7ZGlyfS8ke25hbWV9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaGlzIGNvbmZpZyBuYW1lIGlzIGFic2VudCBvciB1bnJlYWRhYmxlOyB0cnkgdGhlIG90aGVyLlxuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFdoZXRoZXIgYSBkZW5vLmpzb24oYykgZG9jdW1lbnQncyBgdGFza3NgIG9iamVjdCBkZWZpbmVzIGB0ZXN0OnVuaXRgLiAqL1xuZnVuY3Rpb24gZGVmaW5lc1VuaXRUZXN0VGFzayh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHN0cmlwSnNvbmModGV4dCkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCB0YXNrcyA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnRhc2tzO1xuICByZXR1cm4gdHJ1ZSB8fCB0eXBlb2YgdGFza3MgPT09IFwib2JqZWN0XCIgJiYgdGFza3MgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodGFza3MpICYmXG4gICAgT2JqZWN0Lmhhc093bih0YXNrcywgXCJ0ZXN0OnVuaXRcIik7XG59XG5cbi8qKlxuICogVGhlIGRlbm8gcm9vdHMgd2hvc2UgY29uZmlnIGRlZmluZXMgYSBgdGVzdDp1bml0YCB0YXNrIChJc3N1ZSAjNDkzMCksIHNvIHRoZVxuICogZ2F0ZSBjYW4gcnVuIHRoZSByZXBvJ3Mgb3duIHVuaXQgc3VpdGUgZm9yIGNoYW5nZWQgdGVzdHMuIFJvb3QgZGlzY292ZXJ5XG4gKiBtYXRjaGVzIHtAbGluayBsb2FkRGVub1Njb3Blc307IGEgcm9vdCB3aG9zZSBjb25maWcgaXMgdW5yZWFkYWJsZSBvclxuICogdW5wYXJzZWFibGUgaXMgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkRGVub1VuaXRUZXN0Um9vdHMoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4gIHRyYWNrZWQ6IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICBjb25zdCByb290czogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChcbiAgICBjb25zdCByb290IG9mIG91dGVybW9zdENvbmZpZ0RpcnModHJhY2tlZCwgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSlcbiAgKSB7XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlYWREZW5vQ29uZmlnVGV4dChyZXBvUm9vdCwgcm9vdCk7XG4gICAgaWYgKHRleHQgIT09IG51bGwgJiYgZGVmaW5lc1VuaXRUZXN0VGFzayh0ZXh0KSkgcm9vdHMucHVzaChyb290KTtcbiAgfVxuICByZXR1cm4gcm9vdHM7XG59XG5cbi8qKlxuICogRmluZCBhIHJ1bm5hYmxlIGBtYXJrZG93bmxpbnQtY2xpMmA6IHRoZSByZXBvJ3Mgb3duIGluc3RhbGwgZmlyc3QsIHRoZW4gdGhlXG4gKiBmaXJzdCB3b3JraW5nIG9uZSBvbiBgUEFUSGA7IG51bGwgd2hlbiBuZWl0aGVyIHJ1bnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTWFya2Rvd25saW50QmluYXJ5KFxuICByZXBvUm9vdDogc3RyaW5nLFxuICBwYXRoVmFsdWU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICByZXR1cm4gZmluZEJpbmFyeShcIm1hcmtkb3dubGludC1jbGkyXCIsIHJlcG9Sb290LCBwYXRoVmFsdWUpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIHJlcG8ncyBvd24gQ0kgcnVucyBjc3BlbGw6IGEgdHJhY2tlZCB3b3JrZmxvdyB1bmRlclxuICogYC5naXRodWIvd29ya2Zsb3dzL2Agd2l0aCBhIGBydW46YCBvciBgdXNlczpgIHN0ZXAgdGhhdCBuYW1lcyBjc3BlbGwuXG4gKiBDb21tZW50IGxpbmVzIGFyZSBpZ25vcmVkLiBBIHJlcG8gd2l0aCBhIGNzcGVsbCBjb25maWcgYnV0IG5vIHN1Y2ggc3RlcFxuICogaXMgbm90IGJsb2NrZWQgYnkgY3NwZWxsLCBzaW5jZSBpdHMgcmVxdWlyZWQgQ0kgbmV2ZXIgcnVucyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcG9DaVJ1bnNDc3BlbGwoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4gIHRyYWNrZWQ6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGZvciAoY29uc3QgcGF0aCBvZiB0cmFja2VkKSB7XG4gICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoXCIuZ2l0aHViL3dvcmtmbG93cy9cIikpIGNvbnRpbnVlO1xuICAgIGlmICghL1xcLnlhP21sJC8udGVzdChwYXRoKSkgY29udGludWU7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgdGV4dCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGAke3JlcG9Sb290fS8ke3BhdGh9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHdvcmtmbG93UnVuc0NzcGVsbCh0ZXh0KSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgb25lIHdvcmtmbG93IGZpbGUncyB0ZXh0IHJ1bnMgY3NwZWxsOiBhIGBydW46YCBvciBgdXNlczpgIHN0ZXBcbiAqIHdob3NlIGNvbW1hbmQgb3IgYWN0aW9uIG5hbWVzIGNzcGVsbCwgb24gdGhlIHNhbWUgbGluZSBvciBpbnNpZGUgYVxuICogYmxvY2sgc2NhbGFyIChgcnVuOiB8YCkgdW5kZXIgaXQuIENvbW1lbnQgbGluZXMgYXJlIGlnbm9yZWQuIEEgY3NwZWxsIHJ1blxuICogcmVhY2hlZCBvbmx5IHRocm91Z2ggYSBzY3JpcHQgdGhlIHN0ZXAgY2FsbHMgKGBucG0gcnVuIHNwZWxsY2hlY2tgKSBpcyBub3RcbiAqIGRldGVjdGVkLCBhbmQgdGhlIGRvY3Mgc2F5IHNvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd29ya2Zsb3dSdW5zQ3NwZWxsKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBzdGVwS2V5ID0gL14oXFxzKikoPzotXFxzKyk/KD86cnVufHVzZXMpXFxzKjooLiopJC87XG4gIGNvbnN0IGNzcGVsbFdvcmQgPSAvXFxiY3NwZWxsXFxiL2k7XG4gIGxldCBibG9ja0luZGVudDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgcmF3IG9mIHRleHQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3LnJlcGxhY2UoL1xcciQvLCBcIlwiKTtcbiAgICBpZiAoYmxvY2tJbmRlbnQgIT09IG51bGwpIHtcbiAgICAgIGlmIChsaW5lLnRyaW0oKSA9PT0gXCJcIikgY29udGludWU7XG4gICAgICBjb25zdCBpbmRlbnQgPSBsaW5lLmxlbmd0aCAtIGxpbmUudHJpbVN0YXJ0KCkubGVuZ3RoO1xuICAgICAgaWYgKGluZGVudCA+IGJsb2NrSW5kZW50KSB7XG4gICAgICAgIGlmICghbGluZS50cmltU3RhcnQoKS5zdGFydHNXaXRoKFwiI1wiKSAmJiBjc3BlbGxXb3JkLnRlc3QobGluZSkpIHtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGJsb2NrSW5kZW50ID0gbnVsbDtcbiAgICB9XG4gICAgY29uc3Qgc3RlcCA9IHN0ZXBLZXkuZXhlYyhsaW5lKTtcbiAgICBpZiAoIXN0ZXApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJlc3QgPSAoc3RlcFsyXSA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKC9eW3w+XVstKzAtOV0qJC8udGVzdChyZXN0KSkge1xuICAgICAgYmxvY2tJbmRlbnQgPSAoc3RlcFsxXSA/PyBcIlwiKS5sZW5ndGg7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNzcGVsbFdvcmQudGVzdChyZXN0KSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogRmluZCBhIHJ1bm5hYmxlIGBjc3BlbGxgOiB0aGUgcmVwbydzIG93biBpbnN0YWxsIGZpcnN0LCB0aGVuIGBQQVRIYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQ3NwZWxsQmluYXJ5KFxuICByZXBvUm9vdDogc3RyaW5nLFxuICBwYXRoVmFsdWU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICByZXR1cm4gZmluZEJpbmFyeShcImNzcGVsbFwiLCByZXBvUm9vdCwgcGF0aFZhbHVlKTtcbn1cblxuLyoqIEZpbmQgdGhlIGBzaGVsbGNoZWNrYCByZXNvbHZlZCBieSBDSSdzIGBQQVRIYCwgaW4gdGhlIHNhbWUgb3JkZXIuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZFNoZWxsY2hlY2tCaW5hcnkoXG4gIHBhdGhWYWx1ZTogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIHJldHVybiBmaW5kUGF0aEJpbmFyeShcInNoZWxsY2hlY2tcIiwgcGF0aFZhbHVlKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmluZEJpbmFyeShcbiAgbmFtZTogc3RyaW5nLFxuICByZXBvUm9vdDogc3RyaW5nLFxuICBwYXRoVmFsdWU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBsb2NhbCA9IGAke3JlcG9Sb290fS9ub2RlX21vZHVsZXMvLmJpbi8ke25hbWV9YDtcbiAgdHJ5IHtcbiAgICBpZiAoKGF3YWl0IERlbm8uc3RhdChsb2NhbCkpLmlzRmlsZSAmJiBhd2FpdCBjYW5SdW5CaW5hcnkobG9jYWwpKSB7XG4gICAgICByZXR1cm4gbG9jYWw7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBOb3QgaW5zdGFsbGVkIGxvY2FsbHk7IGZhbGwgdGhyb3VnaCB0byBQQVRILlxuICB9XG4gIGZvciAoY29uc3QgZGlyIG9mIHBhdGhWYWx1ZS5zcGxpdChcIjpcIikpIHtcbiAgICBpZiAoZGlyID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSBgJHtkaXJ9LyR7bmFtZX1gO1xuICAgIHRyeSB7XG4gICAgICBpZiAoXG4gICAgICAgIChhd2FpdCBEZW5vLnN0YXQoY2FuZGlkYXRlKSkuaXNGaWxlICYmIGF3YWl0IGNhblJ1bkJpbmFyeShjYW5kaWRhdGUpXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE5vdCBpbiB0aGlzIGRpcmVjdG9yeS5cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmRQYXRoQmluYXJ5KFxuICBuYW1lOiBzdHJpbmcsXG4gIHBhdGhWYWx1ZTogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGZvciAoY29uc3QgZGlyIG9mIHBhdGhWYWx1ZS5zcGxpdChcIjpcIikpIHtcbiAgICBpZiAoZGlyID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSBgJHtkaXJ9LyR7bmFtZX1gO1xuICAgIHRyeSB7XG4gICAgICBpZiAoXG4gICAgICAgIChhd2FpdCBEZW5vLnN0YXQoY2FuZGlkYXRlKSkuaXNGaWxlICYmIGF3YWl0IGNhblJ1bkJpbmFyeShjYW5kaWRhdGUpXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE5vdCBpbiB0aGlzIGRpcmVjdG9yeS5cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBPdXRwdXQgb2YgYHNoZWxsY2hlY2sgLS12ZXJzaW9uYDsgaW5qZWN0YWJsZSBzbyB1bml0IHRlc3RzIG5lZWQgbm8gaG9zdCBiaW5hcnkuICovXG5leHBvcnQgdHlwZSBTaGVsbGNoZWNrVmVyc2lvblByb2JlID0gKFxuICBiaW5hcnk6IHN0cmluZyxcbiAgY3dkOiBzdHJpbmcsXG4pID0+IFByb21pc2U8eyBjb2RlOiBudW1iZXI7IHN0ZG91dDogc3RyaW5nIH0+O1xuXG5jb25zdCBkZWZhdWx0U2hlbGxjaGVja1ZlcnNpb25Qcm9iZTogU2hlbGxjaGVja1ZlcnNpb25Qcm9iZSA9IGFzeW5jIChcbiAgYmluYXJ5LFxuICBjd2QsXG4pID0+IHtcbiAgY29uc3Qgb3V0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZChiaW5hcnksIHtcbiAgICBhcmdzOiBbXCItLXZlcnNpb25cIl0sXG4gICAgY3dkLFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgIGVudjogYnVpbGRVbnRydXN0ZWRDb21tYW5kRW52KCksXG4gICAgY2xlYXJFbnY6IHRydWUsXG4gICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDEwXzAwMCksXG4gIH0pLm91dHB1dCgpO1xuICByZXR1cm4geyBjb2RlOiBvdXQuY29kZSwgc3Rkb3V0OiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0LnN0ZG91dCkgfTtcbn07XG5cbi8qKiBXaGV0aGVyIGEgY2hhbmdlZCBwYXRoIGNhbiBhbHRlciB3aGF0IHRoZSByZXBvc2l0b3J5J3MgU2hlbGxDaGVjayBDSSBjaGVja3MuICovXG5hc3luYyBmdW5jdGlvbiB0b3VjaGVzU2hlbGxjaGVja1N1cmZhY2UoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2hhbmdlZDogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgZm9yIChjb25zdCBwIG9mIGNoYW5nZWQpIHtcbiAgICBjb25zdCBuYW1lID0gcC5zcGxpdChcIi9cIikuYXQoLTEpID8/IFwiXCI7XG4gICAgaWYgKFxuICAgICAgL1xcLig/OnNofGJhc2h8a3NofHpzaHxzaGxpYikkLy50ZXN0KHApIHx8IEFDVElPTl9TSEVMTF9OQU1FUy5oYXMobmFtZSkgfHxcbiAgICAgIFNIRUxMQ0hFQ0tfQ09ORklHUy5oYXMobmFtZSlcbiAgICApIHJldHVybiB0cnVlO1xuICAgIGlmICghbmFtZS5pbmNsdWRlcyhcIi5cIikpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBzaGVsbGNoZWNrRmlsZUluZm8ocm9vdCwgcCk7XG4gICAgICAgIGlmIChpbmZvPy5pc0ZpbGUgJiYgYXdhaXQgYWN0aW9uU2hlbGxjaGVja0ZpbGUocm9vdCwgcCwgaW5mbykpIHtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICEoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgJiZcbiAgICAgICAgICAhKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90QURpcmVjdG9yeSlcbiAgICAgICAgKSB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5jb25zdCBBQ1RJT05fU0hFTExfTkFNRVMgPSBuZXcgU2V0KFtcbiAgXCIuYmFzaHJjXCIsXG4gIFwiYmFzaHJjXCIsXG4gIFwiLmJhc2hfYWxpYXNlc1wiLFxuICBcIi5iYXNoX2NvbXBsZXRpb25cIixcbiAgXCIuYmFzaF9sb2dpblwiLFxuICBcIi5iYXNoX2xvZ291dFwiLFxuICBcIi5iYXNoX3Byb2ZpbGVcIixcbiAgXCJiYXNoX3Byb2ZpbGVcIixcbiAgXCJzdWlkX3Byb2ZpbGVcIixcbiAgXCIuemxvZ2luXCIsXG4gIFwiemxvZ2luXCIsXG4gIFwiLnpsb2dvdXRcIixcbiAgXCJ6bG9nb3V0XCIsXG4gIFwiLnpwcm9maWxlXCIsXG4gIFwienByb2ZpbGVcIixcbiAgXCIuenNlbnZcIixcbiAgXCJ6c2VudlwiLFxuICBcIi56c2hyY1wiLFxuICBcInpzaHJjXCIsXG4gIFwiLnByb2ZpbGVcIixcbiAgXCJwcm9maWxlXCIsXG5dKTtcblxuYXN5bmMgZnVuY3Rpb24gYWN0aW9uU2hlbGxjaGVja0ZpbGUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBpbmZvOiBEZW5vLkZpbGVJbmZvLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IG5hbWUgPSBwYXRoLnNwbGl0KFwiL1wiKS5hdCgtMSkhO1xuICBpZiAoXG4gICAgcGF0aC5zcGxpdChcIi9cIikuaW5jbHVkZXMoXCIuZ2l0XCIpIHx8IHBhdGguZW5kc1dpdGgoXCIuZ29cIikgfHwgbmFtZSA9PT0gXCJtdm53XCJcbiAgKSByZXR1cm4gZmFsc2U7XG4gIGlmIChcbiAgICAvXFwuKD86c2h8YmFzaHxrc2h8enNofHNobGliKSQvLnRlc3QobmFtZSkgfHwgQUNUSU9OX1NIRUxMX05BTUVTLmhhcyhuYW1lKVxuICApIHJldHVybiB0cnVlO1xuICBpZiAobmFtZS5pbmNsdWRlcyhcIi5cIikgfHwgISgoaW5mby5tb2RlID8/IDApICYgMG8xMTEpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZpbGUgPSBhd2FpdCBEZW5vLm9wZW4oYCR7cm9vdH0vJHtwYXRofWAsIHsgcmVhZDogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KDQwOTYpO1xuICAgIGNvbnN0IGNvdW50ID0gYXdhaXQgZmlsZS5yZWFkKGJ5dGVzKTtcbiAgICByZXR1cm4gL14jISAqXFwvW14gXSpcXC8oPzplbnYgKik/W2Fia10qc2gvLnRlc3QoXG4gICAgICBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoYnl0ZXMuc3ViYXJyYXkoMCwgY291bnQgPz8gMCkpLnNwbGl0KFwiXFxuXCIpWzBdISxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGZpbGUuY2xvc2UoKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzaGVsbGNoZWNrRmlsZUluZm8oXG4gIGN3ZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPERlbm8uRmlsZUluZm8gfCBudWxsPiB7XG4gIGNvbnN0IHBhcnRzID0gcGF0aC5zcGxpdChcIi9cIik7XG4gIGxldCBjdXJyZW50ID0gY3dkO1xuICBmb3IgKGNvbnN0IFtpbmRleCwgcGFydF0gb2YgcGFydHMuZW50cmllcygpKSB7XG4gICAgY3VycmVudCArPSBgLyR7cGFydH1gO1xuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBEZW5vLmxzdGF0KGN1cnJlbnQpO1xuICAgIGlmIChpbmZvLmlzU3ltbGluaykgcmV0dXJuIG51bGw7XG4gICAgaWYgKGluZGV4ID09PSBwYXJ0cy5sZW5ndGggLSAxKSByZXR1cm4gaW5mbztcbiAgICBpZiAoIWluZm8uaXNEaXJlY3RvcnkpIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5jb25zdCBNQVhfUE9MSUNZX0JZVEVTID0gMTAyNCAqIDEwMjQ7XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb3VuZGVkUG9saWN5RmlsZShcbiAgcm9vdDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGluZm86IERlbm8uRmlsZUluZm8sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBpZiAoIWluZm8uaXNGaWxlIHx8IGluZm8uc2l6ZSA+IE1BWF9QT0xJQ1lfQllURVMpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3QgYSByZWd1bGFyIGZpbGUgb3IgZXhjZWVkcyBwb2xpY3kgc2l6ZSBsaW1pdFwiKTtcbiAgfVxuICBjb25zdCBmaWxlID0gYXdhaXQgRGVuby5vcGVuKGAke3Jvb3R9LyR7cGF0aH1gLCB7IHJlYWQ6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShNQVhfUE9MSUNZX0JZVEVTICsgMSk7XG4gICAgbGV0IGxlbmd0aCA9IDA7XG4gICAgd2hpbGUgKGxlbmd0aCA8IGJ5dGVzLmxlbmd0aCkge1xuICAgICAgY29uc3QgY291bnQgPSBhd2FpdCBmaWxlLnJlYWQoYnl0ZXMuc3ViYXJyYXkobGVuZ3RoKSk7XG4gICAgICBpZiAoY291bnQgPT09IG51bGwpIGJyZWFrO1xuICAgICAgbGVuZ3RoICs9IGNvdW50O1xuICAgIH1cbiAgICBpZiAobGVuZ3RoID4gTUFYX1BPTElDWV9CWVRFUykgdGhyb3cgbmV3IEVycm9yKFwiZXhjZWVkcyBwb2xpY3kgc2l6ZSBsaW1pdFwiKTtcbiAgICByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGJ5dGVzLnN1YmFycmF5KDAsIGxlbmd0aCkpO1xuICB9IGZpbmFsbHkge1xuICAgIGZpbGUuY2xvc2UoKTtcbiAgfVxufVxuXG4vKipcbiAqIFNoYXJlZCBTaGVsbENoZWNrIHZhbGlkYXRpb24gZm9yIGhvb2tzLCBjb21wbGV0aW9uIGFuZCByZXBhaXIgcHVibGljYXRpb24uXG4gKiBBIHBvbGljeSB0aGUgZ2F0ZSBjYW5ub3QgcmVhZCBibG9ja3Mgb25seSBhIHB1c2ggdGhhdCB0b3VjaGVzIGEgc2NyaXB0LCBhXG4gKiBTaGVsbENoZWNrIGNvbmZpZyBvciBhIFNoZWxsQ2hlY2sgd29ya2Zsb3c7IGFueSBvdGhlciBwdXNoIGhhcyBub3RoaW5nIFNoZWxsQ2hlY2tcbiAqIGNvdWxkIGNoZWNrLCBzbyBhbiB1bnN1cHBvcnRlZCBwb2xpY3kgY2Fubm90IG1ha2UgdGhlIHJlcG9zaXRvcnlcbiAqIHVucHVibGlzaGFibGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Mob3B0czoge1xuICBjd2Q6IHN0cmluZztcbiAgY2hhbmdlZDogcmVhZG9ubHkgc3RyaW5nW107XG4gIHRyYWNrZWQ6IHN0cmluZ1tdO1xuICBydW5uZXI/OiBQcmVGbGlnaHRSdW5uZXI7XG4gIHRpbWVvdXRTZWNvbmRzPzogbnVtYmVyO1xuICBmaW5kU2hlbGxjaGVjaz86IChyZXBvUm9vdDogc3RyaW5nKSA9PiBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICByZWFkU2hlbGxjaGVja1ZlcnNpb24/OiBTaGVsbGNoZWNrVmVyc2lvblByb2JlO1xufSk6IFByb21pc2U8UmVzdWx0PHsgY2hlY2tzUnVuOiBzdHJpbmdbXSB9LCBFcnJvcj4+IHtcbiAgY29uc3QgaW5mcmFzdHJ1Y3R1cmVGYWlsID0gKG1lc3NhZ2U6IHN0cmluZyk6IFJlc3VsdDxuZXZlciwgRXJyb3I+ID0+ICh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKG1lc3NhZ2UpLFxuICB9KTtcbiAgY29uc3Qgc2hlbGxjaGVja1BvbGljeSA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KG9wdHMuY3dkLCBvcHRzLnRyYWNrZWQpO1xuICBjb25zdCBjaGFuZ2VkV29ya2Zsb3dzID0gb3B0cy5jaGFuZ2VkLmZpbHRlcigocGF0aCkgPT5cbiAgICBwYXRoLnN0YXJ0c1dpdGgoXCIuZ2l0aHViL3dvcmtmbG93cy9cIikgJiYgL1xcLnlhP21sJC8udGVzdChwYXRoKSAmJlxuICAgIG9wdHMudHJhY2tlZC5pbmNsdWRlcyhwYXRoKVxuICApO1xuICBsZXQgc2hlbGxjaGVja1dvcmtmbG93Q2hhbmdlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgY2hhbmdlZFdvcmtmbG93cykge1xuICAgIGNvbnN0IHBvbGljeSA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KG9wdHMuY3dkLCBbXG4gICAgICBwYXRoLFxuICAgICAgLi4ub3B0cy50cmFja2VkLmZpbHRlcigocCkgPT4gIXAuc3RhcnRzV2l0aChcIi5naXRodWIvd29ya2Zsb3dzL1wiKSksXG4gICAgXSk7XG4gICAgaWYgKCFwb2xpY3kub2sgfHwgcG9saWN5LnZhbHVlICE9PSBudWxsKSBzaGVsbGNoZWNrV29ya2Zsb3dDaGFuZ2VkID0gdHJ1ZTtcbiAgfVxuICBpZiAoIXNoZWxsY2hlY2tQb2xpY3kub2spIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IHRvdWNoZXNTaGVsbGNoZWNrU3VyZmFjZShvcHRzLmN3ZCwgb3B0cy5jaGFuZ2VkKSB8fFxuICAgICAgICAgIHNoZWxsY2hlY2tXb3JrZmxvd0NoYW5nZWRcbiAgICAgICAgPyBpbmZyYXN0cnVjdHVyZUZhaWwoc2hlbGxjaGVja1BvbGljeS5lcnJvcilcbiAgICAgICAgOiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBjaGVja3NSdW46IFtdIH0gfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgcmV0dXJuIGluZnJhc3RydWN0dXJlRmFpbChcbiAgICAgICAgYGNhbm5vdCBpbnNwZWN0IGNoYW5nZWQgU2hlbGxDaGVjayBmaWxlOiAke2Vycm9yfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBzaGVsbGNoZWNrVG91Y2hlZENvbmZpZ3MgPVxuICAgIG9wdHMuY2hhbmdlZC5zb21lKChwKSA9PlxuICAgICAgU0hFTExDSEVDS19DT05GSUdTLmhhcyhwLnNwbGl0KFwiL1wiKS5hdCgtMSkgPz8gXCJcIikgfHxcbiAgICAgIHNoZWxsY2hlY2tQb2xpY3kudmFsdWU/LmNvbmZpZ0ZpbGVzLmluY2x1ZGVzKHApXG4gICAgKSB8fCBzaGVsbGNoZWNrV29ya2Zsb3dDaGFuZ2VkO1xuICBjb25zdCBzaGVsbGNoZWNrRmlsZXMgPSBzaGVsbGNoZWNrUG9saWN5LnZhbHVlXG4gICAgPyAoc2hlbGxjaGVja1RvdWNoZWRDb25maWdzID8gb3B0cy50cmFja2VkIDogb3B0cy5jaGFuZ2VkKVxuICAgIDogW107XG4gIGNvbnN0IGV4aXN0aW5nU2hlbGxjaGVja0ZpbGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBhdGggb2Ygc2hlbGxjaGVja0ZpbGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBzaGVsbGNoZWNrRmlsZUluZm8ob3B0cy5jd2QsIHBhdGgpO1xuICAgICAgaWYgKFxuICAgICAgICBpbmZvPy5pc0ZpbGUgJiZcbiAgICAgICAgKHNoZWxsY2hlY2tQb2xpY3kudmFsdWU/LnZlcnNpb24gPT09IG51bGxcbiAgICAgICAgICA/IGF3YWl0IGFjdGlvblNoZWxsY2hlY2tGaWxlKG9wdHMuY3dkLCBwYXRoLCBpbmZvKVxuICAgICAgICAgIDogcGF0aC5lbmRzV2l0aChcIi5zaFwiKSlcbiAgICAgICkge1xuICAgICAgICBleGlzdGluZ1NoZWxsY2hlY2tGaWxlcy5wdXNoKHBhdGgpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoXG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQgfHxcbiAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RBRGlyZWN0b3J5XG4gICAgICApIGNvbnRpbnVlO1xuICAgICAgcmV0dXJuIGluZnJhc3RydWN0dXJlRmFpbChcbiAgICAgICAgYGNhbm5vdCBpbnNwZWN0IGNoYW5nZWQgU2hlbGxDaGVjayBmaWxlICR7cGF0aH06ICR7XG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICAgIH1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHNoZWxsY2hlY2tQb2xpY3kudmFsdWUgJiYgZXhpc3RpbmdTaGVsbGNoZWNrRmlsZXMubGVuZ3RoID4gMCkge1xuICAgIGZvciAoY29uc3QgcGF0aCBvZiBzaGVsbGNoZWNrUG9saWN5LnZhbHVlLmNvbmZpZ0ZpbGVzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgc2hlbGxjaGVja0ZpbGVJbmZvKG9wdHMuY3dkLCBwYXRoKTtcbiAgICAgICAgaWYgKCFpbmZvPy5pc0ZpbGUpIHtcbiAgICAgICAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmVGYWlsKFxuICAgICAgICAgICAgYGNhbm5vdCByZWFkIFNoZWxsQ2hlY2sgY29uZmlndXJhdGlvbiAke3BhdGh9OiBub3QgYSByZWd1bGFyIGZpbGVgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgcmVhZEJvdW5kZWRQb2xpY3lGaWxlKG9wdHMuY3dkLCBwYXRoLCBpbmZvKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHJldHVybiBpbmZyYXN0cnVjdHVyZUZhaWwoXG4gICAgICAgICAgYGNhbm5vdCByZWFkIFNoZWxsQ2hlY2sgY29uZmlndXJhdGlvbiAke3BhdGh9OiAke1xuICAgICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICAgICAgfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGxldCBzaGVsbGNoZWNrQmluYXJ5OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaWYgKHNoZWxsY2hlY2tQb2xpY3kudmFsdWUgJiYgZXhpc3RpbmdTaGVsbGNoZWNrRmlsZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGZpbmQgPSBvcHRzLmZpbmRTaGVsbGNoZWNrID8/XG4gICAgICAoKF9yb290OiBzdHJpbmcpID0+IGZpbmRTaGVsbGNoZWNrQmluYXJ5KERlbm8uZW52LmdldChcIlBBVEhcIikgPz8gXCJcIikpO1xuICAgIHNoZWxsY2hlY2tCaW5hcnkgPSBhd2FpdCBmaW5kKG9wdHMuY3dkKTtcbiAgICBpZiAoIXNoZWxsY2hlY2tCaW5hcnkpIHtcbiAgICAgIHJldHVybiBpbmZyYXN0cnVjdHVyZUZhaWwoXG4gICAgICAgIFwiU2hlbGxDaGVjayBpcyByZXF1aXJlZCBieSByZXBvc2l0b3J5IENJIGJ1dCBjb3VsZCBub3QgYmUgZm91bmRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHByb2JlID0gb3B0cy5yZWFkU2hlbGxjaGVja1ZlcnNpb24gPz8gZGVmYXVsdFNoZWxsY2hlY2tWZXJzaW9uUHJvYmU7XG4gICAgbGV0IHZlcnNpb25SZXN1bHQ6IHsgY29kZTogbnVtYmVyOyBzdGRvdXQ6IHN0cmluZyB9O1xuICAgIHRyeSB7XG4gICAgICB2ZXJzaW9uUmVzdWx0ID0gYXdhaXQgcHJvYmUoc2hlbGxjaGVja0JpbmFyeSwgb3B0cy5jd2QpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmVGYWlsKFxuICAgICAgICBgY291bGQgbm90IHJlYWQgU2hlbGxDaGVjayB2ZXJzaW9uOiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGFjdHVhbFZlcnNpb24gPSBzaGVsbGNoZWNrVmVyc2lvbk91dHB1dCh2ZXJzaW9uUmVzdWx0LnN0ZG91dCk7XG4gICAgLy8gQSBudWxsIHBvbGljeSB2ZXJzaW9uIGlzIGFuIGFjdGlvbi1tYW5hZ2VkIFNoZWxsQ2hlY2s6IG5vdGhpbmcgdG8gcGluLlxuICAgIGlmIChcbiAgICAgIHNoZWxsY2hlY2tQb2xpY3kudmFsdWUudmVyc2lvbiAhPT0gbnVsbCAmJlxuICAgICAgKHZlcnNpb25SZXN1bHQuY29kZSAhPT0gMCB8fFxuICAgICAgICBhY3R1YWxWZXJzaW9uICE9PSBzaGVsbGNoZWNrUG9saWN5LnZhbHVlLnZlcnNpb24pXG4gICAgKSB7XG4gICAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmVGYWlsKFxuICAgICAgICBgU2hlbGxDaGVjayB2ZXJzaW9uIG1pc21hdGNoOiBDSSByZXF1aXJlcyAke3NoZWxsY2hlY2tQb2xpY3kudmFsdWUudmVyc2lvbn0sIGAgK1xuICAgICAgICAgIGB3b3JrZXIgaGFzICR7YWN0dWFsVmVyc2lvbiA/PyBcImFuIHVucmVhZGFibGUgdmVyc2lvblwifWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHBsYW4gPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoW10sIFtdLCB7XG4gICAgcmVwb1Jvb3Q6IG9wdHMuY3dkLFxuICAgIG1hcmtkb3dubGludEJpbmFyeTogbnVsbCxcbiAgICBzaGVsbGNoZWNrUG9saWN5OiBzaGVsbGNoZWNrUG9saWN5LnZhbHVlLFxuICAgIHNoZWxsY2hlY2tCaW5hcnksXG4gICAgc2hlbGxjaGVja0ZpbGVzOiBleGlzdGluZ1NoZWxsY2hlY2tGaWxlcyxcbiAgfSk7XG4gIGlmICghcGxhbi5vaykgcmV0dXJuIGluZnJhc3RydWN0dXJlRmFpbChwbGFuLmVycm9yKTtcbiAgY29uc3QgY2hlY2tzUnVuOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGNoZWNrIG9mIHBsYW4udmFsdWUpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVGbGlnaHRHYXRlKFtjaGVjay5jb21tYW5kXSwge1xuICAgICAgY3dkOiBjaGVjay5jd2QsXG4gICAgICBydW5uZXI6IG9wdHMucnVubmVyLFxuICAgICAgdGltZW91dFNlY29uZHM6IG9wdHMudGltZW91dFNlY29uZHMsXG4gICAgfSk7XG4gICAgaWYgKCFyZXN1bHQub2spIHJldHVybiByZXN1bHQ7XG4gICAgY2hlY2tzUnVuLnB1c2goY2hlY2suY29tbWFuZCk7XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGNoZWNrc1J1biB9IH07XG59XG5cbi8qKlxuICogUnVuIHRoZSBwcmUtcHVzaCBnYXRlOiB0aGUgYWx3YXlzLW9uIGNoYW5nZWQtZmlsZSBjaGVja3MgZmlyc3QsIHRoZW4gdGhlXG4gKiByZXBvJ3MgYGNhcmdvIGRlbnkgY2hlY2tgIChJc3N1ZSAjNDYyNiksIHRoZW4gdGhlIHJlcG8ncyBwcmUtZmxpZ2h0IGNvbW1hbmRzLlxuICogSW50ZXJtZWRpYXRlIHB1c2hlcyBhbmQgU2hlbGxDaGVjay1vbmx5IHJlcGFpcnMgcnVuIGVsaWdpYmxlIHdvcmtmbG93cyB3aGVuXG4gKiBwdXNoZWQgcGF0aHMgaW5jbHVkZSBhIGNhcmdvIGlucHV0LiBUaGUgd2hvbGUtYnJhbmNoIGNvbXBsZXRpb24gY2hlY2sgKHdpdGggYVxuICogYmFzZVJlZiBhbmQgbm90IFNoZWxsQ2hlY2stb25seSkgcnVucyBlbGlnaWJsZSB3b3JrZmxvd3Mgb24gZXZlcnkgYnJhbmNoLFxuICogcmVnYXJkbGVzcyBvZiBjaGFuZ2VkIGNhcmdvIGlucHV0cy4gYGNoZWNrc1J1bmBcbiAqIGxpc3RzIHRoZSBjaGFuZ2VkLWZpbGUgYW5kIGNhcmdvLWRlbnkgY29tbWFuZHMgcnVuLiBUaGUgY2hhbmdlZC1maWxlIGNoZWNrc1xuICogYW5kIHRoZSBjYXJnby1kZW55IGdhdGUgcnVuIHdoYXRldmVyIHRoZSBydW4gYnVkZ2V0IOKAlCB0aGV5IGFyZSBuZXZlciBza2lwcGVkO1xuICogYWxsIGJ1dCB0aGUgRmxvY2kgZGVwbG95IHRlc3QgYW5kIHRoZSBgZGVubyB0ZXN0YCBydW4gYXJlIGZhc3QuIEFueSBnaXQsIHBhcnNlIG9yIHBsYW5uaW5nIGVycm9yIGlzXG4gKiBhbiBgRXJyYCwgbmV2ZXIgYSBwYXNzLiBBIGNhcmdvLWRlbnkgZmFpbHVyZSB0aGF0IHNob3dzIHRoZSB0b29sIG9yIGFkdmlzb3J5XG4gKiBkYXRhYmFzZSBjb3VsZCBub3QgYmUgcmVhY2hlZCBpcyBhIHtAbGluayBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3J9LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUHJlUHVzaEdhdGUob3B0czoge1xuICBjd2Q6IHN0cmluZztcbiAgc3RkaW46IHN0cmluZztcbiAgcHJlRmxpZ2h0Q29tbWFuZHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogUmVwYWlycyB3aXRob3V0IGNvbmZpZ3VyZWQgcHJlLWZsaWdodCByZXRhaW4gdGhlaXIgZXhpc3RpbmcgZm9ybWF0dGVyIHBvbGljeS4gKi9cbiAgc2hlbGxjaGVja09ubHk/OiBib29sZWFuO1xuICB0aW1lb3V0U2Vjb25kcz86IG51bWJlcjtcbiAgcnVubmVyPzogUHJlRmxpZ2h0UnVubmVyO1xuICBnaXQ/OiBQcmVQdXNoR2l0O1xuICBmaW5kTWFya2Rvd25saW50PzogKHJlcG9Sb290OiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIGZpbmRDc3BlbGw/OiAocmVwb1Jvb3Q6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgZmluZFNoZWxsY2hlY2s/OiAocmVwb1Jvb3Q6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgcmVhZFNoZWxsY2hlY2tWZXJzaW9uPzogU2hlbGxjaGVja1ZlcnNpb25Qcm9iZTtcbiAgLyoqXG4gICAqIENoZWNrIGV2ZXJ5IGNvbW1pdCBhaGVhZCBvZiB0aGlzIHJlZiBpbnN0ZWFkIG9mIG9ubHkgY29tbWl0cyBvblxuICAgKiBubyByZW1vdGUtdHJhY2tpbmcgcmVmIChJc3N1ZSAjMzY4OTogdGhlIGNvbXBsZXRpb24gcGhhc2UncyBwcmUtUFIgY2hlY2spLlxuICAgKi9cbiAgYmFzZVJlZj86IHN0cmluZztcbn0pOiBQcm9taXNlPFJlc3VsdDx7IGNoZWNrc1J1bjogc3RyaW5nW10gfSwgRXJyb3I+PiB7XG4gIGNvbnN0IGdpdCA9IG9wdHMuZ2l0ID8/IGRlZmF1bHRQcmVQdXNoR2l0O1xuICBjb25zdCBmYWlsID0gKG1lc3NhZ2U6IHN0cmluZyk6IFJlc3VsdDxuZXZlciwgRXJyb3I+ID0+ICh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IobWVzc2FnZSksXG4gIH0pO1xuXG4gIGNvbnN0IGluZnJhc3RydWN0dXJlRmFpbCA9IChtZXNzYWdlOiBzdHJpbmcpOiBSZXN1bHQ8bmV2ZXIsIEVycm9yPiA9PiAoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IFByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvcihtZXNzYWdlKSxcbiAgfSk7XG5cbiAgY29uc3QgcmVmcyA9IHBhcnNlUHJlUHVzaFJlZnMob3B0cy5zdGRpbik7XG4gIGlmICghcmVmcy5vaykgcmV0dXJuIGZhaWwocmVmcy5lcnJvcik7XG5cbiAgY29uc3QgdG91Y2hlZCA9IGF3YWl0IGxpc3RQdXNoZWRGaWxlcyhcbiAgICByZWZzLnZhbHVlLFxuICAgIG9wdHMuY3dkLFxuICAgIGdpdCxcbiAgICBvcHRzLmJhc2VSZWYsXG4gICAgdHJ1ZSxcbiAgKTtcbiAgaWYgKCF0b3VjaGVkLm9rKSByZXR1cm4gaW5mcmFzdHJ1Y3R1cmVGYWlsKHRvdWNoZWQuZXJyb3IpO1xuICBjb25zdCBjb250YWluZWQgPSBhd2FpdCBsaXN0UHVzaGVkRmlsZXMoXG4gICAgcmVmcy52YWx1ZSxcbiAgICBvcHRzLmN3ZCxcbiAgICBnaXQsXG4gICAgb3B0cy5iYXNlUmVmLFxuICApO1xuICBpZiAoIWNvbnRhaW5lZC5vaykgcmV0dXJuIGluZnJhc3RydWN0dXJlRmFpbChjb250YWluZWQuZXJyb3IpO1xuICBjb25zdCBjaGFuZ2VkID0geyB2YWx1ZTogb3B0cy5zaGVsbGNoZWNrT25seSA/IFtdIDogY29udGFpbmVkLnZhbHVlIH07XG5cbiAgY29uc3QgbHNGaWxlcyA9IGF3YWl0IGdpdChbXCJscy1maWxlc1wiLCBcIi16XCJdLCBvcHRzLmN3ZCk7XG4gIGlmIChsc0ZpbGVzLmNvZGUgIT09IDApIHtcbiAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmVGYWlsKFxuICAgICAgYGdpdCBscy1maWxlcyBmYWlsZWQgKGV4aXQgJHtsc0ZpbGVzLmNvZGV9KTogJHtsc0ZpbGVzLnN0ZGVyci50cmltKCl9YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHRyYWNrZWQgPSBsc0ZpbGVzLnN0ZG91dC5zcGxpdChcIlxcMFwiKS5maWx0ZXIoKHApID0+IHAgIT09IFwiXCIpO1xuXG4gIGNvbnN0IG5lZWRzTWFya2Rvd25saW50ID0gY2hhbmdlZC52YWx1ZS5zb21lKChwKSA9PlxuICAgIGhhc0V4dGVuc2lvbihwLCBNQVJLRE9XTl9FWFRFTlNJT05TKVxuICApO1xuICBsZXQgbWFya2Rvd25saW50QmluYXJ5OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaWYgKG5lZWRzTWFya2Rvd25saW50KSB7XG4gICAgY29uc3QgZmluZCA9IG9wdHMuZmluZE1hcmtkb3dubGludCA/P1xuICAgICAgKChyb290OiBzdHJpbmcpID0+XG4gICAgICAgIGZpbmRNYXJrZG93bmxpbnRCaW5hcnkocm9vdCwgRGVuby5lbnYuZ2V0KFwiUEFUSFwiKSA/PyBcIlwiKSk7XG4gICAgbWFya2Rvd25saW50QmluYXJ5ID0gYXdhaXQgZmluZChvcHRzLmN3ZCk7XG4gIH1cblxuICBjb25zdCBjc3BlbGxJbkNpID0gYXdhaXQgcmVwb0NpUnVuc0NzcGVsbChvcHRzLmN3ZCwgdHJhY2tlZCk7XG4gIGNvbnN0IG5lZWRzQ3NwZWxsID0gY3NwZWxsSW5DaSAmJlxuICAgIGNoYW5nZWQudmFsdWUuc29tZSgocCkgPT4gaGFzRXh0ZW5zaW9uKHAsIENTUEVMTF9FWFRFTlNJT05TKSkgJiZcbiAgICBbLi4uQ1NQRUxMX1JPT1RfQ09ORklHUywgLi4uQ1NQRUxMX05FU1RFRF9DT05GSUdTXS5zb21lKChuKSA9PlxuICAgICAgdHJhY2tlZC5pbmNsdWRlcyhuKVxuICAgICk7XG4gIGxldCBjc3BlbGxCaW5hcnk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBpZiAobmVlZHNDc3BlbGwpIHtcbiAgICBjb25zdCBmaW5kID0gb3B0cy5maW5kQ3NwZWxsID8/XG4gICAgICAoKHJvb3Q6IHN0cmluZykgPT4gZmluZENzcGVsbEJpbmFyeShyb290LCBEZW5vLmVudi5nZXQoXCJQQVRIXCIpID8/IFwiXCIpKTtcbiAgICBjc3BlbGxCaW5hcnkgPSBhd2FpdCBmaW5kKG9wdHMuY3dkKTtcbiAgfVxuXG4gIGNvbnN0IHNoZWxsY2hlY2sgPSBhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Moe1xuICAgIC4uLm9wdHMsXG4gICAgY2hhbmdlZDogdG91Y2hlZC52YWx1ZSxcbiAgICB0cmFja2VkLFxuICB9KTtcbiAgaWYgKCFzaGVsbGNoZWNrLm9rKSByZXR1cm4gc2hlbGxjaGVjaztcblxuICBjb25zdCBwbGFuID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKGNoYW5nZWQudmFsdWUsIHRyYWNrZWQsIHtcbiAgICByZXBvUm9vdDogb3B0cy5jd2QsXG4gICAgbWFya2Rvd25saW50QmluYXJ5LFxuICAgIGNzcGVsbEJpbmFyeSxcbiAgICBjc3BlbGxJbkNpLFxuICAgIGRlbm9TY29wZXM6IGF3YWl0IGxvYWREZW5vU2NvcGVzKG9wdHMuY3dkLCB0cmFja2VkKSxcbiAgICBkZW5vVW5pdFRlc3RSb290czogYXdhaXQgbG9hZERlbm9Vbml0VGVzdFJvb3RzKG9wdHMuY3dkLCB0cmFja2VkKSxcbiAgfSk7XG4gIGlmICghcGxhbi5vaykgcmV0dXJuIGZhaWwocGxhbi5lcnJvcik7XG5cbiAgY29uc3QgY2hlY2tzUnVuOiBzdHJpbmdbXSA9IFsuLi5zaGVsbGNoZWNrLnZhbHVlLmNoZWNrc1J1bl07XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgcGxhbi52YWx1ZSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZUZsaWdodEdhdGUoW2NoZWNrLmNvbW1hbmRdLCB7XG4gICAgICBjd2Q6IGNoZWNrLmN3ZCxcbiAgICAgIHJ1bm5lcjogb3B0cy5ydW5uZXIsXG4gICAgICB0aW1lb3V0U2Vjb25kczogb3B0cy50aW1lb3V0U2Vjb25kcyxcbiAgICB9KTtcbiAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcmVzdWx0LmVycm9yIH07XG4gICAgY2hlY2tzUnVuLnB1c2goY2hlY2suY29tbWFuZCk7XG4gIH1cblxuICBjb25zdCBjYXJnb0RlbnkgPSBhd2FpdCBydW5DYXJnb0RlbnlHYXRlKHtcbiAgICBjd2Q6IG9wdHMuY3dkLFxuICAgIGNoYW5nZWQ6IGNvbnRhaW5lZC52YWx1ZSxcbiAgICBhbHdheXM6ICFvcHRzLnNoZWxsY2hlY2tPbmx5ICYmIG9wdHMuYmFzZVJlZiAhPT0gdW5kZWZpbmVkLFxuICAgIC8vIFRoZSB0b3VjaGVkIHBhdGhzIGRlY2lkZSBhIHdvcmtmbG93J3MgYHBhdGhzYCBmaWx0ZXIgb25seSBvdmVyIHRoZSB3aG9sZVxuICAgIC8vIGJyYW5jaDsgYSBwdXNoIG9mIHRoZSBuZXdlc3QgY29tbWl0cyBhbG9uZSB3b3VsZCBtaXNzIGVhcmxpZXIgb25lcy5cbiAgICBjb250ZXh0OiB7XG4gICAgICB0b3VjaGVkOiBvcHRzLmJhc2VSZWYgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvdWNoZWQudmFsdWUsXG4gICAgICBicmFuY2hlczogcHVzaGVkQnJhbmNoZXMocmVmcy52YWx1ZSksXG4gICAgfSxcbiAgICB0cmFja2VkLFxuICAgIHJ1bm5lcjogb3B0cy5ydW5uZXIsXG4gICAgdGltZW91dFNlY29uZHM6IG9wdHMudGltZW91dFNlY29uZHMsXG4gIH0pO1xuICBpZiAoIWNhcmdvRGVueS5vaykge1xuICAgIHJldHVybiBjYXJnb0RlbnkuZXJyb3Iua2luZCA9PT0gXCJpbmZyYXN0cnVjdHVyZVwiXG4gICAgICA/IGluZnJhc3RydWN0dXJlRmFpbChjYXJnb0RlbnkuZXJyb3IubWVzc2FnZSlcbiAgICAgIDogZmFpbChjYXJnb0RlbnkuZXJyb3IubWVzc2FnZSk7XG4gIH1cbiAgY2hlY2tzUnVuLnB1c2goLi4uY2FyZ29EZW55LnZhbHVlLmNoZWNrc1J1bik7XG4gIC8vIEEgY2hlY2sgQ0kgYWxsb3dzIHRvIGZhaWwgaXMgcmVwb3J0ZWQsIG5ldmVyIGNvdW50ZWQgYXMgcnVuIG9yIGEgYmxvY2suXG4gIGZvciAoY29uc3Qgd2FybmluZyBvZiBjYXJnb0RlbnkudmFsdWUud2FybmluZ3MpIHtcbiAgICBjb25zb2xlLndhcm4oYFtQUkVfUFVTSF9XQVJOSU5HXSBjYXJnbyBkZW55OiAke3dhcm5pbmd9YCk7XG4gIH1cblxuICBjb25zdCBwcmVGbGlnaHQgPSBhd2FpdCBydW5QcmVGbGlnaHRHYXRlKG9wdHMucHJlRmxpZ2h0Q29tbWFuZHMsIHtcbiAgICBjd2Q6IG9wdHMuY3dkLFxuICAgIHJ1bm5lcjogb3B0cy5ydW5uZXIsXG4gICAgdGltZW91dFNlY29uZHM6IG9wdHMudGltZW91dFNlY29uZHMsXG4gIH0pO1xuICBpZiAoIXByZUZsaWdodC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogcHJlRmxpZ2h0LmVycm9yIH07XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGNoZWNrc1J1biB9IH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E4Q0MsR0FHRCxTQUFTLFlBQVksUUFBUSwwQkFBMEI7QUFDdkQsU0FBUyx3QkFBd0IsUUFBUSw2QkFBNkI7QUFDdEUsU0FBUyxhQUFhLEVBQUUsaUJBQWlCLFFBQVEsbUJBQW1CO0FBQ3BFLFNBRUUsZ0JBQWdCLEVBQ2hCLGVBQWUsUUFDVix1QkFBdUI7QUFDOUIsU0FBUyxnQkFBZ0IsUUFBUSx1QkFBdUI7QUFDeEQsU0FFRSxXQUFXLEVBQ1gsY0FBYyxRQUNULGtCQUFrQjtBQUN6QixTQUFTLFVBQVUsUUFBUSxhQUFhO0FBRXhDOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSx1Q0FBdUM7RUFDekMsT0FBTyxpQkFBMEI7RUFFMUMsWUFBWSxPQUFlLEVBQUUsT0FBNkIsQ0FBRTtJQUMxRCxLQUFLLENBQUMsU0FBUztJQUNmLElBQUksQ0FBQyxJQUFJLEdBQUc7RUFD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
// denoCacheMetadata=10166050244892359529,7100767549513643383