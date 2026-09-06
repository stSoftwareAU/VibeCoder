/**
 * Redaction of `git` message arguments at the spawn chokepoint (Issue #1284).
 *
 * A commit message is a public sink in exactly the way a PR comment is: once
 * `git push` lands it on a branch it is permanent history, mirrored by every
 * clone, and unlike a comment it cannot be edited away. `redactGhBodyArgs`
 * closed that leg for `gh` (Issue #3707) and the agent-side `gh` shim extended
 * it to the model's own calls (Issue #3938) — but `runGitCommand` masked
 * nothing, and the agent had no `git` shim at all, so
 * `git commit -m "$GH_TOKEN" && git push` reached a public branch with no
 * control anywhere in the path.
 *
 * This module is the `git` counterpart, and it follows the same rule as its
 * `gh` sibling: **only text-carrying arguments are rewritten; routing
 * arguments are left byte-for-byte alone**, so redaction can never redirect a
 * command. `git commit -C <sha>` and `git revert -m <parent-number>` name a
 * commit and a mainline, not prose, and are untouched.
 *
 * Scoping is by subcommand, because `-m` is not one flag in `git`: it is a
 * message in `commit`/`tag`/`merge`/`notes`/`stash`, a mainline number in
 * `revert`/`cherry-pick`, a rename in `branch`, and `--merge` (taking no
 * argument at all) in `rebase`. Consuming the following argument on the
 * strength of the letter alone would corrupt those commands. Leading global
 * options are skipped first, so `git -C /repo commit -m …` is scoped exactly
 * as `git commit -m …` is.
 *
 * Short-option clusters are parsed the way `git` parses them — `-am <text>`
 * and `-am<text>` both carry a message — but a cluster whose earlier letter
 * consumes the value (`-Sm keyid`) is left alone, which is also how `git`
 * reads it.
 *
 * ```mermaid
 * flowchart LR
 *     W["worker git call sites"] --> R["runGitCommand"]
 *     A["agent Bash: git …"] --> S["PATH shim: git"]
 *     S --> G["git_guard_cli.ts"]
 *     R --> X["redactGitMessageArgs"]
 *     G --> X
 *     X --> P["git subprocess → branch history"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/**
 * Reads the contents of a `-F <path>` message file. Throws when it cannot.
 *
 * Injected rather than calling `Deno.readTextFile*` directly so the redaction
 * stays a pure function of its inputs. Callers that supply no reader get
 * argv-only redaction and file references are left untouched.
 */
export type MessageFileReader = (path: string) => string;

/**
 * A message destined for branch history that could not be scanned for secrets.
 *
 * Raised rather than returning the arguments unchanged: an unscannable message
 * is a failure of the control, and committing it anyway would mask that
 * failure as success.
 */
export class UnredactableMessageError extends Error {
  /** The message source that could not be read (a path, or `-` for stdin). */
  readonly source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "UnredactableMessageError";
    this.source = source;
  }
}

/** How one `git` subcommand spells its message-carrying arguments. */
interface MessageSubcommand {
  /** `-m` / `--message` carries prose for this subcommand. */
  readonly message: boolean;
  /** `-F` / `--file` names a file holding that prose. */
  readonly file: boolean;
  /**
   * Short options that consume their value, so a cluster reaching one of them
   * has no message left to find. `git` itself reads `-Sm keyid` as
   * `--gpg-sign=m`, never as a message.
   */
  readonly valueShorts: ReadonlySet<string>;
}

/**
 * The subcommands whose `-m`/`-F` genuinely carry prose.
 *
 * Deliberately a short allowlist. `revert`/`cherry-pick` (`-m <mainline>`),
 * `branch` (`-m <newname>`) and `rebase` (`-m` = `--merge`, no argument) are
 * absent because their `-m` is routing, not text.
 */
const MESSAGE_SUBCOMMANDS: ReadonlyMap<string, MessageSubcommand> = new Map([
  // -C/-c <commit>, -t <template>, -S[keyid], -u[mode]
  ["commit", {
    message: true,
    file: true,
    valueShorts: new Set(["C", "c", "t", "S", "u"]),
  }],
  // -u <keyid>, -n <num> (list mode)
  ["tag", {
    message: true,
    file: true,
    valueShorts: new Set(["u", "n"]),
  }],
  // -s <strategy>, -X <option>, -S[keyid]
  ["merge", {
    message: true,
    file: true,
    valueShorts: new Set(["s", "X", "S"]),
  }],
  // -C/-c <object>
  ["notes", {
    message: true,
    file: true,
    valueShorts: new Set(["C", "c"]),
  }],
  ["stash", { message: true, file: false, valueShorts: new Set() }],
]);

/** Global `git` options that consume the argument after them. */
const GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/**
 * Index of the subcommand token, skipping `git`'s own leading options.
 *
 * `git -C /repo -c user.name=x commit …` must scope as `commit`, so the
 * options that consume a following argument are stepped over rather than
 * mistaken for the subcommand.
 *
 * @param args - Arguments about to be passed to the `git` binary.
 * @returns The index of the subcommand, or -1 when there is none.
 */
export function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (!token.startsWith("-")) return i;
    if (GLOBAL_VALUE_OPTIONS.has(token)) i++;
  }
  return -1;
}

/**
 * Redact secrets from the message-carrying arguments of a `git` invocation.
 *
 * @param args - Arguments about to be passed to the `git` binary.
 * @param readMessageFile - Optional reader; supplying it extends redaction to
 *   the contents of `-F <path>` / `--file <path>` arguments, which are then
 *   rewritten to an inline masked `-m` so the caller's own file is never
 *   modified.
 * @returns A new array with message arguments redacted; every other argument
 *   is returned byte-for-byte unchanged. The argument count never changes.
 * @throws UnredactableMessageError when a message source cannot be scanned.
 */
export function redactGitMessageArgs(
  args: readonly string[],
  readMessageFile?: MessageFileReader,
): string[] {
  const out = [...args];
  const start = gitSubcommandIndex(out);
  if (start < 0) return out;
  const spec = MESSAGE_SUBCOMMANDS.get(out[start] ?? "");
  if (!spec) return out;

  for (let i = start + 1; i < out.length; i++) {
    const arg = out[i] ?? "";
    // Everything after `--` is a pathspec, never a message.
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;

    if (arg.startsWith("--")) {
      i = redactLongOption(out, i, spec, readMessageFile);
      continue;
    }
    i = redactShortCluster(out, i, spec, readMessageFile);
  }
  return out;
}

/**
 * Redact a `--message`/`--file` option in place.
 *
 * @returns The index the caller's loop should continue from (advanced by one
 *   when the option's value was a separate argument).
 */
function redactLongOption(
  out: string[],
  i: number,
  spec: MessageSubcommand,
  readMessageFile?: MessageFileReader,
): number {
  const arg = out[i] ?? "";
  const next = out[i + 1];

  if (spec.message && arg === "--message" && next !== undefined) {
    out[i + 1] = redactSecrets(next);
    return i + 1;
  }
  if (spec.message && arg.startsWith("--message=")) {
    const text = arg.substring("--message=".length);
    out[i] = `--message=${redactSecrets(text)}`;
    return i;
  }
  if (spec.file && arg === "--file" && next !== undefined) {
    const masked = maskedMessageFile(next, readMessageFile);
    if (masked !== undefined) {
      out[i] = "--message";
      out[i + 1] = masked;
    }
    return i + 1;
  }
  if (spec.file && arg.startsWith("--file=")) {
    const path = arg.substring("--file=".length);
    const masked = maskedMessageFile(path, readMessageFile);
    if (masked !== undefined) out[i] = `--message=${masked}`;
    return i;
  }
  return i;
}

/**
 * Redact a short-option cluster in place, the way `git` reads one.
 *
 * `-m`/`-F` take the rest of the cluster as their value when there is one and
 * the following argument otherwise; a cluster that reaches a value-consuming
 * letter first carries no message at all.
 *
 * @returns The index the caller's loop should continue from.
 */
function redactShortCluster(
  out: string[],
  i: number,
  spec: MessageSubcommand,
  readMessageFile?: MessageFileReader,
): number {
  const cluster = (out[i] ?? "").substring(1);
  for (let k = 0; k < cluster.length; k++) {
    const letter = cluster[k] ?? "";
    const head = `-${cluster.substring(0, k)}`;
    const tail = cluster.substring(k + 1);

    if (letter === "m" && spec.message) {
      if (tail.length > 0) {
        out[i] = `${head}m${redactSecrets(tail)}`;
        return i;
      }
      const next = out[i + 1];
      if (next === undefined) return i;
      out[i + 1] = redactSecrets(next);
      return i + 1;
    }

    if (letter === "F" && spec.file) {
      if (tail.length > 0) {
        const masked = maskedMessageFile(tail, readMessageFile);
        if (masked !== undefined) out[i] = `${head}m${masked}`;
        return i;
      }
      const next = out[i + 1];
      if (next === undefined) return i;
      const masked = maskedMessageFile(next, readMessageFile);
      if (masked !== undefined) {
        out[i] = `${head}m`;
        out[i + 1] = masked;
      }
      return i + 1;
    }

    // A letter that consumes its value ends the cluster for `git` too.
    if (spec.valueShorts.has(letter)) return i;
  }
  return i;
}

/**
 * Read a message file and return its masked contents, or undefined when there
 * was nothing to mask (the file reference is then left exactly as it was).
 *
 * With no reader supplied the caller opted into argv-only redaction, so the
 * reference is left alone.
 *
 * @throws UnredactableMessageError when the message cannot be read at all.
 */
function maskedMessageFile(
  path: string,
  readMessageFile?: MessageFileReader,
): string | undefined {
  if (!readMessageFile) return undefined;
  if (path === "-") {
    throw new UnredactableMessageError(
      path,
      "a git message read from stdin cannot be scanned for secrets — write " +
        "it to a file and pass -F <path>",
    );
  }
  let text: string;
  try {
    text = readMessageFile(path);
  } catch (err) {
    throw new UnredactableMessageError(
      path,
      `could not read the git message file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const masked = redactSecrets(text);
  return masked === text ? undefined : masked;
}
