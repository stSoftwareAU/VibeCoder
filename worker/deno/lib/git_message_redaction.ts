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
 * The message `git` would have read from stdin (`-F -`), supplied by the
 * caller because this module performs no I/O of its own (Issue #1953).
 *
 * Reading it here is the only way a piped message can be scanned at all: the
 * guard runs as a subprocess *ahead* of the real `git`, and stdin can be
 * consumed once. So the guard consumes it, masks it, and hands the result back
 * inline as `-m <masked>` — exactly what a `-F <path>` message already becomes
 * — leaving the real `git` nothing to re-read. Callers that supply no source
 * keep the old fail-closed refusal.
 */
export interface StdinMessageSource {
  /**
   * Read the whole message from stdin.
   *
   * @throws UnredactableMessageError when the message cannot be scanned — no
   *   pipe at all (stdin is a terminal), or more bytes than the bound allows.
   */
  read(): string;
}

/** Everything this module needs to scan a message it cannot see in argv. */
export interface MessageSources {
  /** Reader for `-F <path>` contents; absent means argv-only redaction. */
  readMessageFile?: MessageFileReader;
  /** Source for a `-F -` message; absent means `-F -` fails closed. */
  stdin?: StdinMessageSource;
  /**
   * Called once per argument whose text was actually changed by masking.
   *
   * The guard used to infer this by comparing argv before and after, which a
   * stdin message breaks: its two arguments are rewritten whether or not
   * anything was masked, so the comparison would claim a redaction on every
   * piped commit. Reporting it from where the masking happens is exact.
   */
  onMasked?: () => void;
}

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
  /**
   * `git` reads the message from **stdin** when this subcommand is given no
   * message option at all — true only for `commit-tree` (Issue #1969).
   *
   * Such a command carries no argument naming its message, so it is refused
   * rather than run: the guard hands `git` an argv, and a message nothing in
   * that argv names is one it could only smuggle in by growing the argv the
   * shim verifies. The refusal names the flagged spellings, all of which are
   * scanned.
   */
  readonly stdinWithoutOption?: boolean;
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
  // The plumbing spelling, reachable from the agent's own shell: -p <parent>
  ["commit-tree", {
    message: true,
    file: true,
    valueShorts: new Set(["p", "S"]),
    stdinWithoutOption: true,
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

/** What one redaction pass learnt about the argv while rewriting it. */
interface PassState {
  /** True once an option naming the message (`-m`/`-F`, any spelling) was read. */
  sawMessageOption: boolean;
}

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
 * Accept either shape of the sources argument.
 *
 * The bare reader is the original signature and most call sites still use it;
 * the object form carries the stdin source added in Issue #1953.
 */
function normaliseSources(
  sources?: MessageFileReader | MessageSources,
): MessageSources {
  if (!sources) return {};
  return typeof sources === "function" ? { readMessageFile: sources } : sources;
}

/**
 * Mask `text`, telling the caller when masking actually changed something.
 *
 * Every masking in this module goes through here, so `onMasked` is a complete
 * account of what was rewritten — including a message that never appeared in
 * argv at all.
 */
function mask(text: string, sources: MessageSources): string {
  const masked = redactSecrets(text);
  if (masked !== text) sources.onMasked?.();
  return masked;
}

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
 * @param sources - Either a bare `-F <path>` reader (the original signature)
 *   or a {@link MessageSources} object. Supplying a reader extends redaction
 *   to the contents of `-F <path>` / `--file <path>` arguments; supplying a
 *   `stdin` source extends it to `-F -`. Either way the message is rewritten
 *   to an inline masked `-m`, so the caller's own file is never modified and
 *   the real `git` has nothing left to read.
 * @returns A new array with message arguments redacted; every other argument
 *   is returned byte-for-byte unchanged. The argument count never changes.
 * @throws UnredactableMessageError when a message source cannot be scanned —
 *   including a `commit-tree` given no message option at all, whose message
 *   `git` would take from stdin with nothing in the argv naming it (#1969).
 */
export function redactGitMessageArgs(
  args: readonly string[],
  sources?: MessageFileReader | MessageSources,
): string[] {
  const io = normaliseSources(sources);
  const out = [...args];
  const start = gitSubcommandIndex(out);
  if (start < 0) return out;
  const spec = MESSAGE_SUBCOMMANDS.get(out[start] ?? "");
  if (!spec) return out;

  const state: PassState = { sawMessageOption: false };
  for (let i = start + 1; i < out.length; i++) {
    const arg = out[i] ?? "";
    // Everything after `--` is a pathspec, never a message.
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;

    if (arg.startsWith("--")) {
      i = redactLongOption(out, i, spec, io, state);
      continue;
    }
    i = redactShortCluster(out, i, spec, io, state);
  }

  // Issue #1969: `git commit-tree <tree>` takes its message from stdin when no
  // option names one, so the argv the guard scans holds no message at all.
  // Refuse, naming the spellings that are scanned, rather than hand `git` a
  // command whose message this control never saw.
  if (spec.stdinWithoutOption && !state.sawMessageOption) {
    throw new UnredactableMessageError(
      "-",
      `git ${out[start]} with neither -m nor -F reads its commit message ` +
        "from standard input, where no argument names it and nothing can " +
        "scan it — pass the message with -m <text> or -F <path>, or pipe it " +
        "with -F -",
    );
  }
  return out;
}

/**
 * Whether this argv would take its message from stdin (`-F -`).
 *
 * Answered by running the redaction itself against a probe source rather than
 * by parsing the argv a second way: two parsers that disagree is exactly the
 * bug this module's subcommand scoping exists to avoid. The guard uses it to
 * decide whether to read stdin at all — `git am --message-id` reaches the
 * guard on the wrapper's deliberately over-matching fast path and must be
 * handed its own mbox untouched.
 *
 * @param args - Arguments about to be passed to the `git` binary.
 * @returns True when a message source of `-` is present and would be used.
 */
export function usesStdinMessage(args: readonly string[]): boolean {
  let needed = false;
  try {
    redactGitMessageArgs(args, {
      stdin: {
        read: () => {
          needed = true;
          return "";
        },
      },
    });
  } catch (err) {
    // A command this module refuses outright (`git commit-tree` with no
    // message option, Issue #1969) reads no stdin: the refusal is raised again
    // by the real pass and reported there, so swallowing it here cannot hide
    // it. Any other error is a bug and still escapes.
    if (!(err instanceof UnredactableMessageError)) throw err;
  }
  return needed;
}

/**
 * Whether `name` is an abbreviation `git` would expand to `full`.
 *
 * `git` accepts any unambiguous prefix of a long option, so `git commit --mess
 * "$TOKEN"` commits exactly as `--message` does. Matching the full spelling
 * alone would leave that as a one-character bypass of the whole control.
 *
 * `minLength` is the point at which the prefix stops colliding with another
 * option of these subcommands: `--fil` is the shortest unambiguous form of
 * `--file` (`--fi` collides with `--fixup`), and anything shorter `git` itself
 * rejects, so it can carry no message. `--message` needs no floor — the worst
 * a false match can do there is redact the value of some other `--m…` option,
 * and a routing value never matches a secret shape.
 */
function isLongOptionPrefix(
  name: string,
  full: string,
  minLength: number,
): boolean {
  return name.length >= minLength && name.length <= full.length &&
    full.startsWith(name);
}

/** Shortest prefix of `--file` that no other option of these subcommands shares. */
const FILE_PREFIX_MIN = 3;

/**
 * Split `--name` or `--name=value` into its parts, or undefined when `arg` is
 * not a long option.
 */
function splitLongOption(
  arg: string,
): { name: string; inlineValue?: string } | undefined {
  if (!arg.startsWith("--") || arg === "--") return undefined;
  const body = arg.substring(2);
  const eq = body.indexOf("=");
  if (eq < 0) return { name: body };
  return { name: body.substring(0, eq), inlineValue: body.substring(eq + 1) };
}

/**
 * Redact a `--message`/`--file` option — or any abbreviation of one — in place.
 *
 * @returns The index the caller's loop should continue from (advanced by one
 *   when the option's value was a separate argument).
 */
function redactLongOption(
  out: string[],
  i: number,
  spec: MessageSubcommand,
  sources: MessageSources,
  state: PassState,
): number {
  const parsed = splitLongOption(out[i] ?? "");
  if (!parsed) return i;
  const { name, inlineValue } = parsed;
  const next = out[i + 1];

  if (spec.message && isLongOptionPrefix(name, "message", 1)) {
    state.sawMessageOption = true;
    if (inlineValue !== undefined) {
      out[i] = `--message=${mask(inlineValue, sources)}`;
      return i;
    }
    if (next === undefined) return i;
    out[i + 1] = mask(next, sources);
    return i + 1;
  }

  if (spec.file && isLongOptionPrefix(name, "file", FILE_PREFIX_MIN)) {
    state.sawMessageOption = true;
    if (inlineValue !== undefined) {
      const masked = maskedMessageFile(inlineValue, sources);
      if (masked !== undefined) out[i] = `--message=${masked}`;
      return i;
    }
    if (next === undefined) return i;
    const masked = maskedMessageFile(next, sources);
    if (masked !== undefined) {
      out[i] = "--message";
      out[i + 1] = masked;
    }
    return i + 1;
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
  sources: MessageSources,
  state: PassState,
): number {
  const cluster = (out[i] ?? "").substring(1);
  for (let k = 0; k < cluster.length; k++) {
    const letter = cluster[k] ?? "";
    const head = `-${cluster.substring(0, k)}`;
    const tail = cluster.substring(k + 1);

    if (letter === "m" && spec.message) {
      state.sawMessageOption = true;
      if (tail.length > 0) {
        out[i] = `${head}m${mask(tail, sources)}`;
        return i;
      }
      const next = out[i + 1];
      if (next === undefined) return i;
      out[i + 1] = mask(next, sources);
      return i + 1;
    }

    if (letter === "F" && spec.file) {
      state.sawMessageOption = true;
      if (tail.length > 0) {
        const masked = maskedMessageFile(tail, sources);
        if (masked !== undefined) out[i] = `${head}m${masked}`;
        return i;
      }
      const next = out[i + 1];
      if (next === undefined) return i;
      const masked = maskedMessageFile(next, sources);
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
 * `-` is the message on stdin, and it is the one source that is **always**
 * returned rather than left alone (Issue #1953): stdin can be consumed once,
 * so once the guard has read it the real `git` must be handed the text in
 * argv whether or not a secret was found in it.
 *
 * With no reader supplied the caller opted into argv-only redaction, so a path
 * reference is left alone; with no stdin source supplied `-` fails closed,
 * which is what the worker's own chokepoint still does.
 *
 * @throws UnredactableMessageError when the message cannot be read at all.
 */
function maskedMessageFile(
  path: string,
  sources: MessageSources,
): string | undefined {
  if (path === "-") return maskedStdinMessage(sources);
  if (!sources.readMessageFile) return undefined;
  let text: string;
  try {
    text = sources.readMessageFile(path);
  } catch (err) {
    throw new UnredactableMessageError(
      path,
      `could not read the git message file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const masked = mask(text, sources);
  return masked === text ? undefined : masked;
}

/**
 * Consume the `-F -` message and return its masked text (Issue #1953).
 *
 * @throws UnredactableMessageError when no stdin source was supplied, or when
 *   the source itself could not produce a scannable message.
 */
function maskedStdinMessage(sources: MessageSources): string {
  if (!sources.stdin) {
    throw new UnredactableMessageError(
      "-",
      "a git message read from stdin cannot be scanned for secrets — write " +
        "it to a file and pass -F <path>",
    );
  }
  return mask(sources.stdin.read(), sources);
}
