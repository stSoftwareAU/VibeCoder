/**
 * `PreToolUse` guard for the review round's Codex attempt (Issue #5083).
 *
 * A Claude round is held to run.sh's `--allowedTools`: Read/Grep/Glob, edits
 * only in the round's own directory, and Bash only for the round's shell
 * commands and read-only git subcommands. Codex runs with its CLI sandbox
 * bypassed (it needs bubblewrap, #4356), so the same limits are enforced here
 * as a command hook: {@link reviewRoundToolPolicy} reads them off the round's
 * Claude arguments, and {@link decideReviewRoundTool} refuses any shell
 * command not on the list, any write outside `/tmp` and the round directory,
 * and web fetches.
 *
 * Self-contained (relative imports only, no bare specifiers): the hook runs
 * as `deno run --no-config`, so no import map is available to it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { installConsoleRedaction } from "./console_redaction.ts";

/** What the round may do, read off its Claude arguments. */
export interface ReviewRoundToolPolicy {
  /** Allowed command prefixes, e.g. `gh`, `deno run`, `git log`. */
  commands: string[];
  /** Directories writes may land in (`--add-dir` and `Edit(...)` paths). */
  writeDirs: string[];
}

/** The guard's answer for one tool call. */
export type ReviewRoundToolDecision =
  | { deny: false }
  | { deny: true; reason: string };

/**
 * The round's tool policy from its `claude -p` arguments: `Bash(x:*)` rules
 * become command prefixes, `Edit(/dir/**)` rules and `--add-dir` values
 * become write directories.
 */
export function reviewRoundToolPolicy(
  claudeArgs: readonly string[],
): ReviewRoundToolPolicy {
  const commands: string[] = [];
  const writeDirs: string[] = [];
  for (let i = 0; i < claudeArgs.length; i++) {
    const arg = claudeArgs[i];
    if (arg === "--add-dir" && i + 1 < claudeArgs.length) {
      writeDirs.push(normalisePath(claudeArgs[++i] ?? "/"));
      continue;
    }
    if (arg !== "--allowedTools") continue;
    while (
      i + 1 < claudeArgs.length && !(claudeArgs[i + 1] ?? "--").startsWith("--")
    ) {
      const rule = claudeArgs[++i] ?? "";
      const bash = /^Bash\((.+):\*\)$/.exec(rule);
      if (bash) commands.push((bash[1] ?? "").trim());
      const edit = /^Edit\((.+?)(\/\*\*)?\)$/.exec(rule);
      if (edit) writeDirs.push(normalisePath(edit[1] ?? "/"));
    }
  }
  return { commands, writeDirs: [...new Set(writeDirs)] };
}

/** An absolute path with `.`, `..` and repeated slashes resolved. */
export function normalisePath(path: string, cwd = "/"): string {
  const joined = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function inWriteDirs(
  path: string,
  cwd: string,
  policy: ReviewRoundToolPolicy,
): boolean {
  const target = normalisePath(path, cwd);
  if (target === "/dev/null") return true;
  return policy.writeDirs.some((dir) =>
    target === dir || target.startsWith(dir === "/" ? "/" : `${dir}/`)
  );
}

/** One simple command of a shell line: its words and its output targets. */
interface Segment {
  words: string[];
  redirects: string[];
}

/**
 * Split a shell line into simple commands, quote-aware. Returns null when the
 * line uses command or process substitution, which could run anything.
 */
function parseShell(line: string): Segment[] | null {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let pendingRedirect = false;
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects });
    }
    words = [];
    redirects = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && line[i + 1] === "(")) return null;
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (
      c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r"
    ) {
      // `2>&1` and `>&2` duplicate a descriptor; they write no file.
      if (c === "&" && line[i - 1] === ">") continue;
      endSegment();
    } else if (c === ">" || c === "<") {
      if (line[i + 1] === "(") return null;
      const output = c === ">";
      // A descriptor number before `>` (`2>`) is part of the operator.
      if (inWord && /^\d+$/.test(word) && !pendingRedirect) {
        word = "";
        inWord = false;
      } else endWord();
      if (line[i + 1] === ">") i++;
      if (line[i + 1] === "&") {
        // `>&1`: skip the descriptor.
        i++;
        while (/\d/.test(line[i + 1] ?? "")) i++;
        continue;
      }
      if (output) pendingRedirect = true;
      else {
        // An input file is read, not written: drop its word.
        while (line[i + 1] === " ") i++;
        while (i + 1 < line.length && !/[\s;|&<>]/.test(line[i + 1] ?? "")) i++;
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  endSegment();
  return segments;
}

/** Whether one shell line keeps to the round's commands and write paths. */
export function decideReviewRoundShell(
  line: string,
  cwd: string,
  policy: ReviewRoundToolPolicy,
): ReviewRoundToolDecision {
  const segments = parseShell(line);
  if (segments === null) {
    return {
      deny: true,
      reason: "command substitution is not allowed in a review round",
    };
  }
  for (const { words, redirects } of segments) {
    for (const target of redirects) {
      if (!inWriteDirs(target, cwd, policy)) {
        return {
          deny: true,
          reason: `writes go only under ${
            policy.writeDirs.join(" or ")
          }; ${target} is outside them`,
        };
      }
    }
    if (words.length === 0) continue;
    const text = words.join(" ");
    const allowed = policy.commands.some((cmd) =>
      text === cmd || text.startsWith(`${cmd} `)
    );
    if (!allowed) {
      return {
        deny: true,
        reason: `\`${words[0]}\` is not one of the round's shell commands (${
          policy.commands.join(", ")
        })`,
      };
    }
    if (words[0] === "mkdir") {
      const outside = words.slice(1).find((w) =>
        !w.startsWith("-") && !inWriteDirs(w, cwd, policy)
      );
      if (outside !== undefined) {
        return {
          deny: true,
          reason: `mkdir only under ${policy.writeDirs.join(" or ")}`,
        };
      }
    }
  }
  return { deny: false };
}

/** The files an `apply_patch` body adds, updates, deletes or moves to. */
function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  const header =
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
  for (const line of patch.split("\n")) {
    const match = header.exec(line.trim());
    if (match) targets.push((match[1] ?? match[2] ?? "").trim());
  }
  return targets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide one `PreToolUse` payload. A shell call is checked against the
 * round's commands, a file write against its write directories, and web
 * fetches are refused; any other tool (reads, plans) is left alone.
 */
export function decideReviewRoundTool(
  payload: unknown,
  policy: ReviewRoundToolPolicy,
  defaultCwd = "/",
): ReviewRoundToolDecision {
  if (!isRecord(payload)) {
    return { deny: true, reason: "unreadable hook payload" };
  }
  const tool = String(payload.tool_name ?? "");
  const input = isRecord(payload.tool_input) ? payload.tool_input : {};
  const cwd = typeof payload.cwd === "string" && payload.cwd !== ""
    ? payload.cwd
    : defaultCwd;
  const command = Array.isArray(input.command)
    ? input.command.map(String).join(" ")
    : typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
    ? input.cmd
    : undefined;
  const patch = typeof input.patch === "string"
    ? input.patch
    : typeof input.input === "string"
    ? input.input
    : command !== undefined && command.includes("*** Begin Patch")
    ? command
    : undefined;
  if (tool === "apply_patch" || patch !== undefined) {
    const outside = patchTargets(patch ?? "").find((path) =>
      !inWriteDirs(path, cwd, policy)
    );
    return outside === undefined ? { deny: false } : {
      deny: true,
      reason: `writes go only under ${
        policy.writeDirs.join(" or ")
      }; ${outside} is outside them`,
    };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return inWriteDirs(path, cwd, policy) ? { deny: false } : {
      deny: true,
      reason: `writes go only under ${
        policy.writeDirs.join(" or ")
      }; ${path} is outside them`,
    };
  }
  if (["WebFetch", "WebSearch", "web_search"].includes(tool)) {
    return { deny: true, reason: `${tool} is refused in a review round` };
  }
  if (command !== undefined) {
    return decideReviewRoundShell(command, cwd, policy);
  }
  return { deny: false };
}

/** The `PreToolUse` matchers the guard is registered under. */
export const REVIEW_ROUND_GUARD_MATCHERS: readonly string[] = [
  "Bash",
  "apply_patch",
  "Edit|Write|MultiEdit|NotebookEdit",
  "WebFetch|WebSearch|web_search",
];

/** The guard module's file name, beside this one. */
export const REVIEW_ROUND_GUARD_MODULE = "review_round_guard.ts";

/** POSIX single-quoted, safe in a hook's shell command line. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The hook settings that install the guard for one Codex attempt, as the
 * `settingsJson` `buildCodexArgs` translates to `-c hooks.PreToolUse=...`.
 * The policy travels base64-encoded in the command line, so no file is written.
 */
export function reviewRoundGuardSettings(
  policy: ReviewRoundToolPolicy,
  denoPath: string,
  guardModulePath: string,
): string {
  const encoded = btoa(JSON.stringify(policy));
  const command = `${quote(denoPath)} run --quiet --no-config --no-lock ` +
    `${quote(guardModulePath)} ${quote(encoded)}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: REVIEW_ROUND_GUARD_MATCHERS.map((matcher) => ({
        matcher,
        hooks: [{ type: "command", command }],
      })),
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

if (import.meta.main) {
  installConsoleRedaction();
  // A policy or payload it cannot read is refused: this guard is the only
  // limit on the Codex attempt's tools.
  let policy: ReviewRoundToolPolicy = { commands: [], writeDirs: [] };
  try {
    policy = JSON.parse(atob(Deno.args[0] ?? ""));
  } catch {
    // The empty policy refuses every command and write.
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(await readAll(Deno.stdin.readable));
  } catch {
    payload = null;
  }
  const decision = decideReviewRoundTool(payload, policy, Deno.cwd());
  if (decision.deny) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    }));
    console.error(`review round guard: ${decision.reason}`);
    Deno.exit(2);
  }
}
