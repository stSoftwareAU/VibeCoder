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
 * and web fetches. The shell parser fails closed: a line using syntax it does
 * not model (substitution, `$'...'`, an unquoted here-document, an expanded
 * write target) is refused rather than guessed at.
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
 * The word a redirect operator is waiting for: an output file, an input
 * (read, so dropped), `>&word` (a descriptor when the word is digits or `-`,
 * otherwise a file), or a here-document's end marker.
 */
type PendingRedirect = "out" | "in" | "dup-out" | "heredoc" | "heredoc-strip";

/**
 * Split a shell line into simple commands, quote-aware. Returns null for any
 * syntax it does not model, so the caller refuses the line: command or
 * process substitution, `$'...'` and `$"..."` quoting, a here-document whose
 * end marker is unquoted (its body would be expanded), a redirect with no
 * target, or an unterminated quote. Comments are dropped, `>&file`, `&>file`,
 * `>|file` and `<>file` count as writes, and an input redirect's target is
 * read with the same quote-aware word reader as every other word.
 */
function parseShell(line: string): Segment[] | null {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let quote: "'" | '"' | null = null;
  let pending: PendingRedirect | null = null;
  const heredocs: { marker: string; strip: boolean }[] = [];
  let failed = false;
  const endWord = () => {
    if (!inWord) return;
    if (pending === "out") redirects.push(word);
    else if (pending === "dup-out") {
      if (quoted || !/^(\d+-?|-)$/.test(word)) redirects.push(word);
    } else if (pending === "heredoc" || pending === "heredoc-strip") {
      // An unquoted marker means the body is expanded, so it could run code.
      if (!quoted) failed = true;
      heredocs.push({ marker: word, strip: pending === "heredoc-strip" });
    } else if (pending === null) words.push(word);
    pending = null;
    word = "";
    inWord = false;
    quoted = false;
  };
  const endSegment = () => {
    endWord();
    if (pending !== null) failed = true;
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects });
    }
    words = [];
    redirects = [];
  };
  /** Skip the here-document bodies that start after the newline at `i`. */
  const skipHeredocs = (i: number): number => {
    let at = i;
    while (heredocs.length > 0) {
      const { marker, strip } = heredocs.shift()!;
      let found = false;
      while (at < line.length) {
        const next = line.indexOf("\n", at + 1);
        const stop = next === -1 ? line.length : next;
        let body = line.slice(at + 1, stop);
        if (strip) body = body.replace(/^\t+/, "");
        at = stop;
        if (body === marker) {
          found = true;
          break;
        }
      }
      if (!found) return -1;
    }
    return at;
  };
  for (let i = 0; i < line.length; i++) {
    if (failed) return null;
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && line[i + 1] === "(")) return null;
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && line[i + 1] === "\n") i++;
      else if (c === "\\" && /[$`"\\]/.test(line[i + 1] ?? "")) {
        word += line[++i];
      } else word += c;
      continue;
    }
    if (c === "$" && (line[i + 1] === "'" || line[i + 1] === '"')) {
      return null;
    }
    if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (i + 1 < line.length && line[i + 1] !== "\n") i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      quoted = true;
    } else if (c === "\\" && line[i + 1] === "\n") {
      i++;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
      quoted = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "&" && line[i + 1] === ">") {
      // `&>file` and `&>>file` send both streams to a file.
      endWord();
      if (pending !== null) return null;
      i++;
      if (line[i + 1] === ">") i++;
      pending = "out";
    } else if (
      c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r" ||
      c === "(" || c === ")"
    ) {
      endSegment();
      if (failed) return null;
      if (c === "\n" && heredocs.length > 0) {
        const at = skipHeredocs(i);
        if (at < 0) return null;
        i = at;
      }
    } else if (c === ">" || c === "<") {
      // A descriptor number before the operator (`2>`) is part of it.
      if (inWord && !quoted && /^\d+$/.test(word) && pending === null) {
        word = "";
        inWord = false;
      } else endWord();
      if (pending !== null) return null;
      const next = line[i + 1];
      if (c === ">") {
        if (next === ">" || next === "|") i++;
        if (line[i + 1] === "&") {
          if (next === ">" || next === "|") return null;
          i++;
          pending = "dup-out";
        } else pending = "out";
      } else if (next === "<") {
        i++;
        if (line[i + 1] === "<") {
          i++;
          pending = "in";
        } else if (line[i + 1] === "-") {
          i++;
          pending = "heredoc-strip";
        } else pending = "heredoc";
      } else if (next === ">") {
        // `<>file` opens the file for writing too.
        i++;
        pending = "out";
      } else {
        if (next === "&") i++;
        pending = "in";
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  endSegment();
  if (failed || heredocs.length > 0) return null;
  return segments;
}

/**
 * Whether a write target would be changed by the shell before it is opened:
 * a parameter, tilde or brace expansion, or a glob. The guard checks the
 * literal path, so any of these is refused.
 */
function expands(target: string): boolean {
  return /[$`{}~*?[\]]/.test(target);
}

/** Shell builtins that move the working directory a relative path resolves from. */
const CHANGE_DIRECTORY_COMMANDS = ["cd", "pushd", "popd"];

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
      reason:
        "command substitution, $'...' quoting, an unquoted here-document " +
        "or other shell syntax the guard cannot check is not allowed in a " +
        "review round",
    };
  }
  // `cd` is on the round's command list and the guard does not follow it, so
  // a relative target after one would resolve against a directory the guard
  // has not seen. On such a line only absolute write targets are checkable.
  const changesDirectory = segments.some(({ words }) =>
    CHANGE_DIRECTORY_COMMANDS.includes(words[0] ?? "")
  );
  const relativeAfterCd = (target: string): boolean =>
    changesDirectory && !target.startsWith("/");
  const relativeDenial = (target: string): ReviewRoundToolDecision => ({
    deny: true,
    reason:
      `a write or mkdir target must be an absolute path on a line that changes directory: ${target}`,
  });
  for (const { words, redirects } of segments) {
    for (const target of redirects) {
      if (relativeAfterCd(target)) return relativeDenial(target);
      if (expands(target)) {
        return {
          deny: true,
          reason:
            `a write target must be a literal path, with no $, ~, braces or globs: ${target}`,
        };
      }
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
      const relative = words.slice(1).find((w) =>
        !w.startsWith("-") && relativeAfterCd(w)
      );
      if (relative !== undefined) return relativeDenial(relative);
      const outside = words.slice(1).find((w) =>
        !w.startsWith("-") && (expands(w) || !inWriteDirs(w, cwd, policy))
      );
      if (outside !== undefined) {
        return {
          deny: true,
          reason: `mkdir only under ${
            policy.writeDirs.join(" or ")
          }, at a literal path with no $, ~, braces or globs`,
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
 * The patch in a shell line that is only an `apply_patch` call fed by a
 * here-document with a quoted end marker, or null for anything else. A quoted
 * here-document's body is literal, so nothing in it runs; any other shell
 * text around a patch has to go through the shell check instead.
 */
function applyPatchHeredoc(command: string): string | null {
  const match =
    /^\s*(?:apply_patch|applypatch)\s+<<-?\s*(['"])(\w+)\1[ \t]*\n(\*\*\* Begin Patch\n[\s\S]*\n\*\*\* End Patch)[ \t]*\n\2\s*$/
      .exec(command);
  if (!match) return null;
  const marker = match[2] ?? "";
  const body = match[3] ?? "";
  // A body line equal to the marker would end the here-document early.
  if (body.split("\n").some((l) => l.replace(/^\t+/, "") === marker)) {
    return null;
  }
  return body;
}

function decidePatch(
  patch: string,
  cwd: string,
  policy: ReviewRoundToolPolicy,
): ReviewRoundToolDecision {
  const outside = patchTargets(patch).find((path) =>
    !inWriteDirs(path, cwd, policy)
  );
  return outside === undefined ? { deny: false } : {
    deny: true,
    reason: `writes go only under ${
      policy.writeDirs.join(" or ")
    }; ${outside} is outside them`,
  };
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
  const argv = Array.isArray(input.command) ? input.command.map(String) : null;
  // `["bash", "-lc", script]` runs the script; any other argv is checked as
  // the shell line its words make.
  const command = argv !== null
    ? (argv.length === 3 &&
        /^(?:\/(?:usr\/)?bin\/)?(?:ba)?sh$/.test(argv[0] ?? "") &&
        /^-l?c$/.test(argv[1] ?? "")
      ? argv[2]
      : argv.join(" "))
    : typeof input.command === "string"
    ? input.command
    : typeof input.cmd === "string"
    ? input.cmd
    : undefined;
  const patchField = typeof input.patch === "string"
    ? input.patch
    : typeof input.input === "string"
    ? input.input
    : undefined;
  if (tool === "apply_patch") {
    return decidePatch(patchField ?? command ?? "", cwd, policy);
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
  // `["apply_patch", patch]` is an argv: the patch is never seen by a shell.
  if (argv !== null && /^(?:apply_patch|applypatch)$/.test(argv[0] ?? "")) {
    return decidePatch(argv[1] ?? "", cwd, policy);
  }
  if (command !== undefined) {
    if (command.includes("*** Begin Patch")) {
      const patch = applyPatchHeredoc(command);
      if (patch === null) {
        return {
          deny: true,
          reason:
            "a patch in a shell command must be a bare apply_patch call with a quoted here-document",
        };
      }
      return decidePatch(patch, cwd, policy);
    }
    return decideReviewRoundShell(command, cwd, policy);
  }
  if (patchField !== undefined) return decidePatch(patchField, cwd, policy);
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
