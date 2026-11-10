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
 */ import { redactSecrets } from "./secret_redaction.ts";
/**
 * A message destined for branch history that could not be scanned for secrets.
 *
 * Raised rather than returning the arguments unchanged: an unscannable message
 * is a failure of the control, and committing it anyway would mask that
 * failure as success.
 */ export class UnredactableMessageError extends Error {
  /** The message source that could not be read (a path, or `-` for stdin). */ source;
  constructor(source, message){
    super(message);
    this.name = "UnredactableMessageError";
    this.source = source;
  }
}
/**
 * The subcommands whose `-m`/`-F` genuinely carry prose.
 *
 * Deliberately a short allowlist. `revert`/`cherry-pick` (`-m <mainline>`),
 * `branch` (`-m <newname>`) and `rebase` (`-m` = `--merge`, no argument) are
 * absent because their `-m` is routing, not text.
 */ const MESSAGE_SUBCOMMANDS = new Map([
  // -C/-c <commit>, -t <template>, -S[keyid], -u[mode]
  [
    "commit",
    {
      message: true,
      file: true,
      valueShorts: new Set([
        "C",
        "c",
        "t",
        "S",
        "u"
      ])
    }
  ],
  // The plumbing spelling, reachable from the agent's own shell: -p <parent>
  [
    "commit-tree",
    {
      message: true,
      file: true,
      valueShorts: new Set([
        "p",
        "S"
      ]),
      stdinWithoutOption: true
    }
  ],
  // -u <keyid>, -n <num> (list mode)
  [
    "tag",
    {
      message: true,
      file: true,
      valueShorts: new Set([
        "u",
        "n"
      ])
    }
  ],
  // -s <strategy>, -X <option>, -S[keyid]
  [
    "merge",
    {
      message: true,
      file: true,
      valueShorts: new Set([
        "s",
        "X",
        "S"
      ])
    }
  ],
  // -C/-c <object>
  [
    "notes",
    {
      message: true,
      file: true,
      valueShorts: new Set([
        "C",
        "c"
      ])
    }
  ],
  [
    "stash",
    {
      message: true,
      file: false,
      valueShorts: new Set()
    }
  ]
]);
/** Global `git` options that consume the argument after them. */ const GLOBAL_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env"
]);
/**
 * Accept either shape of the sources argument.
 *
 * The bare reader is the original signature and most call sites still use it;
 * the object form carries the stdin source added in Issue #1953.
 */ function normaliseSources(sources) {
  if (!sources) return {};
  return typeof sources === "function" ? {
    readMessageFile: sources
  } : sources;
}
/**
 * Mask `text`, telling the caller when masking actually changed something.
 *
 * Every masking in this module goes through here, so `onMasked` is a complete
 * account of what was rewritten — including a message that never appeared in
 * argv at all.
 */ function mask(text, sources) {
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
 */ export function gitSubcommandIndex(args) {
  for(let i = 0; i < args.length; i++){
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
 */ export function redactGitMessageArgs(args, sources) {
  const io = normaliseSources(sources);
  const out = [
    ...args
  ];
  const start = gitSubcommandIndex(out);
  if (start < 0) return out;
  const spec = MESSAGE_SUBCOMMANDS.get(out[start] ?? "");
  if (!spec) return out;
  const state = {
    sawMessageOption: false
  };
  for(let i = start + 1; i < out.length; i++){
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
    throw new UnredactableMessageError("-", `git ${out[start]} with neither -m nor -F reads its commit message ` + "from standard input, where no argument names it and nothing can " + "scan it — pass the message with -m <text> or -F <path>, or pipe it " + "with -F -");
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
 */ export function usesStdinMessage(args) {
  let needed = false;
  try {
    redactGitMessageArgs(args, {
      stdin: {
        read: ()=>{
          needed = true;
          return "";
        }
      }
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
 */ function isLongOptionPrefix(name, full, minLength) {
  return name.length >= minLength && name.length <= full.length && full.startsWith(name);
}
/** Shortest prefix of `--file` that no other option of these subcommands shares. */ const FILE_PREFIX_MIN = 3;
/**
 * Split `--name` or `--name=value` into its parts, or undefined when `arg` is
 * not a long option.
 */ function splitLongOption(arg) {
  if (!arg.startsWith("--") || arg === "--") return undefined;
  const body = arg.substring(2);
  const eq = body.indexOf("=");
  if (eq < 0) return {
    name: body
  };
  return {
    name: body.substring(0, eq),
    inlineValue: body.substring(eq + 1)
  };
}
/**
 * Redact a `--message`/`--file` option — or any abbreviation of one — in place.
 *
 * @returns The index the caller's loop should continue from (advanced by one
 *   when the option's value was a separate argument).
 */ function redactLongOption(out, i, spec, sources, state) {
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
 */ function redactShortCluster(out, i, spec, sources, state) {
  const cluster = (out[i] ?? "").substring(1);
  for(let k = 0; k < cluster.length; k++){
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
 */ function maskedMessageFile(path, sources) {
  if (path === "-") return maskedStdinMessage(sources);
  if (!sources.readMessageFile) return undefined;
  let text;
  try {
    text = sources.readMessageFile(path);
  } catch (err) {
    throw new UnredactableMessageError(path, `could not read the git message file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const masked = mask(text, sources);
  return masked === text ? undefined : masked;
}
/**
 * Consume the `-F -` message and return its masked text (Issue #1953).
 *
 * @throws UnredactableMessageError when no stdin source was supplied, or when
 *   the source itself could not produce a scannable message.
 */ function maskedStdinMessage(sources) {
  if (!sources.stdin) {
    throw new UnredactableMessageError("-", "a git message read from stdin cannot be scanned for secrets — write " + "it to a file and pass -F <path>");
  }
  return mask(sources.stdin.read(), sources);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfbWVzc2FnZV9yZWRhY3Rpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWRhY3Rpb24gb2YgYGdpdGAgbWVzc2FnZSBhcmd1bWVudHMgYXQgdGhlIHNwYXduIGNob2tlcG9pbnQgKElzc3VlICMxMjg0KS5cbiAqXG4gKiBBIGNvbW1pdCBtZXNzYWdlIGlzIGEgcHVibGljIHNpbmsgaW4gZXhhY3RseSB0aGUgd2F5IGEgUFIgY29tbWVudCBpczogb25jZVxuICogYGdpdCBwdXNoYCBsYW5kcyBpdCBvbiBhIGJyYW5jaCBpdCBpcyBwZXJtYW5lbnQgaGlzdG9yeSwgbWlycm9yZWQgYnkgZXZlcnlcbiAqIGNsb25lLCBhbmQgdW5saWtlIGEgY29tbWVudCBpdCBjYW5ub3QgYmUgZWRpdGVkIGF3YXkuIGByZWRhY3RHaEJvZHlBcmdzYFxuICogY2xvc2VkIHRoYXQgbGVnIGZvciBgZ2hgIChJc3N1ZSAjMzcwNykgYW5kIHRoZSBhZ2VudC1zaWRlIGBnaGAgc2hpbSBleHRlbmRlZFxuICogaXQgdG8gdGhlIG1vZGVsJ3Mgb3duIGNhbGxzIChJc3N1ZSAjMzkzOCkg4oCUIGJ1dCBgcnVuR2l0Q29tbWFuZGAgbWFza2VkXG4gKiBub3RoaW5nLCBhbmQgdGhlIGFnZW50IGhhZCBubyBgZ2l0YCBzaGltIGF0IGFsbCwgc29cbiAqIGBnaXQgY29tbWl0IC1tIFwiJEdIX1RPS0VOXCIgJiYgZ2l0IHB1c2hgIHJlYWNoZWQgYSBwdWJsaWMgYnJhbmNoIHdpdGggbm9cbiAqIGNvbnRyb2wgYW55d2hlcmUgaW4gdGhlIHBhdGguXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgdGhlIGBnaXRgIGNvdW50ZXJwYXJ0LCBhbmQgaXQgZm9sbG93cyB0aGUgc2FtZSBydWxlIGFzIGl0c1xuICogYGdoYCBzaWJsaW5nOiAqKm9ubHkgdGV4dC1jYXJyeWluZyBhcmd1bWVudHMgYXJlIHJld3JpdHRlbjsgcm91dGluZ1xuICogYXJndW1lbnRzIGFyZSBsZWZ0IGJ5dGUtZm9yLWJ5dGUgYWxvbmUqKiwgc28gcmVkYWN0aW9uIGNhbiBuZXZlciByZWRpcmVjdCBhXG4gKiBjb21tYW5kLiBgZ2l0IGNvbW1pdCAtQyA8c2hhPmAgYW5kIGBnaXQgcmV2ZXJ0IC1tIDxwYXJlbnQtbnVtYmVyPmAgbmFtZSBhXG4gKiBjb21taXQgYW5kIGEgbWFpbmxpbmUsIG5vdCBwcm9zZSwgYW5kIGFyZSB1bnRvdWNoZWQuXG4gKlxuICogU2NvcGluZyBpcyBieSBzdWJjb21tYW5kLCBiZWNhdXNlIGAtbWAgaXMgbm90IG9uZSBmbGFnIGluIGBnaXRgOiBpdCBpcyBhXG4gKiBtZXNzYWdlIGluIGBjb21taXRgL2B0YWdgL2BtZXJnZWAvYG5vdGVzYC9gc3Rhc2hgLCBhIG1haW5saW5lIG51bWJlciBpblxuICogYHJldmVydGAvYGNoZXJyeS1waWNrYCwgYSByZW5hbWUgaW4gYGJyYW5jaGAsIGFuZCBgLS1tZXJnZWAgKHRha2luZyBub1xuICogYXJndW1lbnQgYXQgYWxsKSBpbiBgcmViYXNlYC4gQ29uc3VtaW5nIHRoZSBmb2xsb3dpbmcgYXJndW1lbnQgb24gdGhlXG4gKiBzdHJlbmd0aCBvZiB0aGUgbGV0dGVyIGFsb25lIHdvdWxkIGNvcnJ1cHQgdGhvc2UgY29tbWFuZHMuIExlYWRpbmcgZ2xvYmFsXG4gKiBvcHRpb25zIGFyZSBza2lwcGVkIGZpcnN0LCBzbyBgZ2l0IC1DIC9yZXBvIGNvbW1pdCAtbSDigKZgIGlzIHNjb3BlZCBleGFjdGx5XG4gKiBhcyBgZ2l0IGNvbW1pdCAtbSDigKZgIGlzLlxuICpcbiAqIFNob3J0LW9wdGlvbiBjbHVzdGVycyBhcmUgcGFyc2VkIHRoZSB3YXkgYGdpdGAgcGFyc2VzIHRoZW0g4oCUIGAtYW0gPHRleHQ+YFxuICogYW5kIGAtYW08dGV4dD5gIGJvdGggY2FycnkgYSBtZXNzYWdlIOKAlCBidXQgYSBjbHVzdGVyIHdob3NlIGVhcmxpZXIgbGV0dGVyXG4gKiBjb25zdW1lcyB0aGUgdmFsdWUgKGAtU20ga2V5aWRgKSBpcyBsZWZ0IGFsb25lLCB3aGljaCBpcyBhbHNvIGhvdyBgZ2l0YFxuICogcmVhZHMgaXQuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgV1tcIndvcmtlciBnaXQgY2FsbCBzaXRlc1wiXSAtLT4gUltcInJ1bkdpdENvbW1hbmRcIl1cbiAqICAgICBBW1wiYWdlbnQgQmFzaDogZ2l0IOKAplwiXSAtLT4gU1tcIlBBVEggc2hpbTogZ2l0XCJdXG4gKiAgICAgUyAtLT4gR1tcImdpdF9ndWFyZF9jbGkudHNcIl1cbiAqICAgICBSIC0tPiBYW1wicmVkYWN0R2l0TWVzc2FnZUFyZ3NcIl1cbiAqICAgICBHIC0tPiBYXG4gKiAgICAgWCAtLT4gUFtcImdpdCBzdWJwcm9jZXNzIOKGkiBicmFuY2ggaGlzdG9yeVwiXVxuICogYGBgXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgcmVkYWN0U2VjcmV0cyB9IGZyb20gXCIuL3NlY3JldF9yZWRhY3Rpb24udHNcIjtcblxuLyoqXG4gKiBSZWFkcyB0aGUgY29udGVudHMgb2YgYSBgLUYgPHBhdGg+YCBtZXNzYWdlIGZpbGUuIFRocm93cyB3aGVuIGl0IGNhbm5vdC5cbiAqXG4gKiBJbmplY3RlZCByYXRoZXIgdGhhbiBjYWxsaW5nIGBEZW5vLnJlYWRUZXh0RmlsZSpgIGRpcmVjdGx5IHNvIHRoZSByZWRhY3Rpb25cbiAqIHN0YXlzIGEgcHVyZSBmdW5jdGlvbiBvZiBpdHMgaW5wdXRzLiBDYWxsZXJzIHRoYXQgc3VwcGx5IG5vIHJlYWRlciBnZXRcbiAqIGFyZ3Ytb25seSByZWRhY3Rpb24gYW5kIGZpbGUgcmVmZXJlbmNlcyBhcmUgbGVmdCB1bnRvdWNoZWQuXG4gKi9cbmV4cG9ydCB0eXBlIE1lc3NhZ2VGaWxlUmVhZGVyID0gKHBhdGg6IHN0cmluZykgPT4gc3RyaW5nO1xuXG4vKipcbiAqIFRoZSBtZXNzYWdlIGBnaXRgIHdvdWxkIGhhdmUgcmVhZCBmcm9tIHN0ZGluIChgLUYgLWApLCBzdXBwbGllZCBieSB0aGVcbiAqIGNhbGxlciBiZWNhdXNlIHRoaXMgbW9kdWxlIHBlcmZvcm1zIG5vIEkvTyBvZiBpdHMgb3duIChJc3N1ZSAjMTk1MykuXG4gKlxuICogUmVhZGluZyBpdCBoZXJlIGlzIHRoZSBvbmx5IHdheSBhIHBpcGVkIG1lc3NhZ2UgY2FuIGJlIHNjYW5uZWQgYXQgYWxsOiB0aGVcbiAqIGd1YXJkIHJ1bnMgYXMgYSBzdWJwcm9jZXNzICphaGVhZCogb2YgdGhlIHJlYWwgYGdpdGAsIGFuZCBzdGRpbiBjYW4gYmVcbiAqIGNvbnN1bWVkIG9uY2UuIFNvIHRoZSBndWFyZCBjb25zdW1lcyBpdCwgbWFza3MgaXQsIGFuZCBoYW5kcyB0aGUgcmVzdWx0IGJhY2tcbiAqIGlubGluZSBhcyBgLW0gPG1hc2tlZD5gIOKAlCBleGFjdGx5IHdoYXQgYSBgLUYgPHBhdGg+YCBtZXNzYWdlIGFscmVhZHkgYmVjb21lc1xuICog4oCUIGxlYXZpbmcgdGhlIHJlYWwgYGdpdGAgbm90aGluZyB0byByZS1yZWFkLiBDYWxsZXJzIHRoYXQgc3VwcGx5IG5vIHNvdXJjZVxuICoga2VlcCB0aGUgb2xkIGZhaWwtY2xvc2VkIHJlZnVzYWwuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RkaW5NZXNzYWdlU291cmNlIHtcbiAgLyoqXG4gICAqIFJlYWQgdGhlIHdob2xlIG1lc3NhZ2UgZnJvbSBzdGRpbi5cbiAgICpcbiAgICogQHRocm93cyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3Igd2hlbiB0aGUgbWVzc2FnZSBjYW5ub3QgYmUgc2Nhbm5lZCDigJQgbm9cbiAgICogICBwaXBlIGF0IGFsbCAoc3RkaW4gaXMgYSB0ZXJtaW5hbCksIG9yIG1vcmUgYnl0ZXMgdGhhbiB0aGUgYm91bmQgYWxsb3dzLlxuICAgKi9cbiAgcmVhZCgpOiBzdHJpbmc7XG59XG5cbi8qKiBFdmVyeXRoaW5nIHRoaXMgbW9kdWxlIG5lZWRzIHRvIHNjYW4gYSBtZXNzYWdlIGl0IGNhbm5vdCBzZWUgaW4gYXJndi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWVzc2FnZVNvdXJjZXMge1xuICAvKiogUmVhZGVyIGZvciBgLUYgPHBhdGg+YCBjb250ZW50czsgYWJzZW50IG1lYW5zIGFyZ3Ytb25seSByZWRhY3Rpb24uICovXG4gIHJlYWRNZXNzYWdlRmlsZT86IE1lc3NhZ2VGaWxlUmVhZGVyO1xuICAvKiogU291cmNlIGZvciBhIGAtRiAtYCBtZXNzYWdlOyBhYnNlbnQgbWVhbnMgYC1GIC1gIGZhaWxzIGNsb3NlZC4gKi9cbiAgc3RkaW4/OiBTdGRpbk1lc3NhZ2VTb3VyY2U7XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBwZXIgYXJndW1lbnQgd2hvc2UgdGV4dCB3YXMgYWN0dWFsbHkgY2hhbmdlZCBieSBtYXNraW5nLlxuICAgKlxuICAgKiBUaGUgZ3VhcmQgdXNlZCB0byBpbmZlciB0aGlzIGJ5IGNvbXBhcmluZyBhcmd2IGJlZm9yZSBhbmQgYWZ0ZXIsIHdoaWNoIGFcbiAgICogc3RkaW4gbWVzc2FnZSBicmVha3M6IGl0cyB0d28gYXJndW1lbnRzIGFyZSByZXdyaXR0ZW4gd2hldGhlciBvciBub3RcbiAgICogYW55dGhpbmcgd2FzIG1hc2tlZCwgc28gdGhlIGNvbXBhcmlzb24gd291bGQgY2xhaW0gYSByZWRhY3Rpb24gb24gZXZlcnlcbiAgICogcGlwZWQgY29tbWl0LiBSZXBvcnRpbmcgaXQgZnJvbSB3aGVyZSB0aGUgbWFza2luZyBoYXBwZW5zIGlzIGV4YWN0LlxuICAgKi9cbiAgb25NYXNrZWQ/OiAoKSA9PiB2b2lkO1xufVxuXG4vKipcbiAqIEEgbWVzc2FnZSBkZXN0aW5lZCBmb3IgYnJhbmNoIGhpc3RvcnkgdGhhdCBjb3VsZCBub3QgYmUgc2Nhbm5lZCBmb3Igc2VjcmV0cy5cbiAqXG4gKiBSYWlzZWQgcmF0aGVyIHRoYW4gcmV0dXJuaW5nIHRoZSBhcmd1bWVudHMgdW5jaGFuZ2VkOiBhbiB1bnNjYW5uYWJsZSBtZXNzYWdlXG4gKiBpcyBhIGZhaWx1cmUgb2YgdGhlIGNvbnRyb2wsIGFuZCBjb21taXR0aW5nIGl0IGFueXdheSB3b3VsZCBtYXNrIHRoYXRcbiAqIGZhaWx1cmUgYXMgc3VjY2Vzcy5cbiAqL1xuZXhwb3J0IGNsYXNzIFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLyoqIFRoZSBtZXNzYWdlIHNvdXJjZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkIChhIHBhdGgsIG9yIGAtYCBmb3Igc3RkaW4pLiAqL1xuICByZWFkb25seSBzb3VyY2U6IHN0cmluZztcblxuICBjb25zdHJ1Y3Rvcihzb3VyY2U6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3JcIjtcbiAgICB0aGlzLnNvdXJjZSA9IHNvdXJjZTtcbiAgfVxufVxuXG4vKiogSG93IG9uZSBgZ2l0YCBzdWJjb21tYW5kIHNwZWxscyBpdHMgbWVzc2FnZS1jYXJyeWluZyBhcmd1bWVudHMuICovXG5pbnRlcmZhY2UgTWVzc2FnZVN1YmNvbW1hbmQge1xuICAvKiogYC1tYCAvIGAtLW1lc3NhZ2VgIGNhcnJpZXMgcHJvc2UgZm9yIHRoaXMgc3ViY29tbWFuZC4gKi9cbiAgcmVhZG9ubHkgbWVzc2FnZTogYm9vbGVhbjtcbiAgLyoqIGAtRmAgLyBgLS1maWxlYCBuYW1lcyBhIGZpbGUgaG9sZGluZyB0aGF0IHByb3NlLiAqL1xuICByZWFkb25seSBmaWxlOiBib29sZWFuO1xuICAvKipcbiAgICogU2hvcnQgb3B0aW9ucyB0aGF0IGNvbnN1bWUgdGhlaXIgdmFsdWUsIHNvIGEgY2x1c3RlciByZWFjaGluZyBvbmUgb2YgdGhlbVxuICAgKiBoYXMgbm8gbWVzc2FnZSBsZWZ0IHRvIGZpbmQuIGBnaXRgIGl0c2VsZiByZWFkcyBgLVNtIGtleWlkYCBhc1xuICAgKiBgLS1ncGctc2lnbj1tYCwgbmV2ZXIgYXMgYSBtZXNzYWdlLlxuICAgKi9cbiAgcmVhZG9ubHkgdmFsdWVTaG9ydHM6IFJlYWRvbmx5U2V0PHN0cmluZz47XG4gIC8qKlxuICAgKiBgZ2l0YCByZWFkcyB0aGUgbWVzc2FnZSBmcm9tICoqc3RkaW4qKiB3aGVuIHRoaXMgc3ViY29tbWFuZCBpcyBnaXZlbiBub1xuICAgKiBtZXNzYWdlIG9wdGlvbiBhdCBhbGwg4oCUIHRydWUgb25seSBmb3IgYGNvbW1pdC10cmVlYCAoSXNzdWUgIzE5NjkpLlxuICAgKlxuICAgKiBTdWNoIGEgY29tbWFuZCBjYXJyaWVzIG5vIGFyZ3VtZW50IG5hbWluZyBpdHMgbWVzc2FnZSwgc28gaXQgaXMgcmVmdXNlZFxuICAgKiByYXRoZXIgdGhhbiBydW46IHRoZSBndWFyZCBoYW5kcyBgZ2l0YCBhbiBhcmd2LCBhbmQgYSBtZXNzYWdlIG5vdGhpbmcgaW5cbiAgICogdGhhdCBhcmd2IG5hbWVzIGlzIG9uZSBpdCBjb3VsZCBvbmx5IHNtdWdnbGUgaW4gYnkgZ3Jvd2luZyB0aGUgYXJndiB0aGVcbiAgICogc2hpbSB2ZXJpZmllcy4gVGhlIHJlZnVzYWwgbmFtZXMgdGhlIGZsYWdnZWQgc3BlbGxpbmdzLCBhbGwgb2Ygd2hpY2ggYXJlXG4gICAqIHNjYW5uZWQuXG4gICAqL1xuICByZWFkb25seSBzdGRpbldpdGhvdXRPcHRpb24/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFRoZSBzdWJjb21tYW5kcyB3aG9zZSBgLW1gL2AtRmAgZ2VudWluZWx5IGNhcnJ5IHByb3NlLlxuICpcbiAqIERlbGliZXJhdGVseSBhIHNob3J0IGFsbG93bGlzdC4gYHJldmVydGAvYGNoZXJyeS1waWNrYCAoYC1tIDxtYWlubGluZT5gKSxcbiAqIGBicmFuY2hgIChgLW0gPG5ld25hbWU+YCkgYW5kIGByZWJhc2VgIChgLW1gID0gYC0tbWVyZ2VgLCBubyBhcmd1bWVudCkgYXJlXG4gKiBhYnNlbnQgYmVjYXVzZSB0aGVpciBgLW1gIGlzIHJvdXRpbmcsIG5vdCB0ZXh0LlxuICovXG5jb25zdCBNRVNTQUdFX1NVQkNPTU1BTkRTOiBSZWFkb25seU1hcDxzdHJpbmcsIE1lc3NhZ2VTdWJjb21tYW5kPiA9IG5ldyBNYXAoW1xuICAvLyAtQy8tYyA8Y29tbWl0PiwgLXQgPHRlbXBsYXRlPiwgLVNba2V5aWRdLCAtdVttb2RlXVxuICBbXCJjb21taXRcIiwge1xuICAgIG1lc3NhZ2U6IHRydWUsXG4gICAgZmlsZTogdHJ1ZSxcbiAgICB2YWx1ZVNob3J0czogbmV3IFNldChbXCJDXCIsIFwiY1wiLCBcInRcIiwgXCJTXCIsIFwidVwiXSksXG4gIH1dLFxuICAvLyBUaGUgcGx1bWJpbmcgc3BlbGxpbmcsIHJlYWNoYWJsZSBmcm9tIHRoZSBhZ2VudCdzIG93biBzaGVsbDogLXAgPHBhcmVudD5cbiAgW1wiY29tbWl0LXRyZWVcIiwge1xuICAgIG1lc3NhZ2U6IHRydWUsXG4gICAgZmlsZTogdHJ1ZSxcbiAgICB2YWx1ZVNob3J0czogbmV3IFNldChbXCJwXCIsIFwiU1wiXSksXG4gICAgc3RkaW5XaXRob3V0T3B0aW9uOiB0cnVlLFxuICB9XSxcbiAgLy8gLXUgPGtleWlkPiwgLW4gPG51bT4gKGxpc3QgbW9kZSlcbiAgW1widGFnXCIsIHtcbiAgICBtZXNzYWdlOiB0cnVlLFxuICAgIGZpbGU6IHRydWUsXG4gICAgdmFsdWVTaG9ydHM6IG5ldyBTZXQoW1widVwiLCBcIm5cIl0pLFxuICB9XSxcbiAgLy8gLXMgPHN0cmF0ZWd5PiwgLVggPG9wdGlvbj4sIC1TW2tleWlkXVxuICBbXCJtZXJnZVwiLCB7XG4gICAgbWVzc2FnZTogdHJ1ZSxcbiAgICBmaWxlOiB0cnVlLFxuICAgIHZhbHVlU2hvcnRzOiBuZXcgU2V0KFtcInNcIiwgXCJYXCIsIFwiU1wiXSksXG4gIH1dLFxuICAvLyAtQy8tYyA8b2JqZWN0PlxuICBbXCJub3Rlc1wiLCB7XG4gICAgbWVzc2FnZTogdHJ1ZSxcbiAgICBmaWxlOiB0cnVlLFxuICAgIHZhbHVlU2hvcnRzOiBuZXcgU2V0KFtcIkNcIiwgXCJjXCJdKSxcbiAgfV0sXG4gIFtcInN0YXNoXCIsIHsgbWVzc2FnZTogdHJ1ZSwgZmlsZTogZmFsc2UsIHZhbHVlU2hvcnRzOiBuZXcgU2V0KCkgfV0sXG5dKTtcblxuLyoqIFdoYXQgb25lIHJlZGFjdGlvbiBwYXNzIGxlYXJudCBhYm91dCB0aGUgYXJndiB3aGlsZSByZXdyaXRpbmcgaXQuICovXG5pbnRlcmZhY2UgUGFzc1N0YXRlIHtcbiAgLyoqIFRydWUgb25jZSBhbiBvcHRpb24gbmFtaW5nIHRoZSBtZXNzYWdlIChgLW1gL2AtRmAsIGFueSBzcGVsbGluZykgd2FzIHJlYWQuICovXG4gIHNhd01lc3NhZ2VPcHRpb246IGJvb2xlYW47XG59XG5cbi8qKiBHbG9iYWwgYGdpdGAgb3B0aW9ucyB0aGF0IGNvbnN1bWUgdGhlIGFyZ3VtZW50IGFmdGVyIHRoZW0uICovXG5jb25zdCBHTE9CQUxfVkFMVUVfT1BUSU9OUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcIi1DXCIsXG4gIFwiLWNcIixcbiAgXCItLWdpdC1kaXJcIixcbiAgXCItLXdvcmstdHJlZVwiLFxuICBcIi0tbmFtZXNwYWNlXCIsXG4gIFwiLS1leGVjLXBhdGhcIixcbiAgXCItLXN1cGVyLXByZWZpeFwiLFxuICBcIi0tY29uZmlnLWVudlwiLFxuXSk7XG5cbi8qKlxuICogQWNjZXB0IGVpdGhlciBzaGFwZSBvZiB0aGUgc291cmNlcyBhcmd1bWVudC5cbiAqXG4gKiBUaGUgYmFyZSByZWFkZXIgaXMgdGhlIG9yaWdpbmFsIHNpZ25hdHVyZSBhbmQgbW9zdCBjYWxsIHNpdGVzIHN0aWxsIHVzZSBpdDtcbiAqIHRoZSBvYmplY3QgZm9ybSBjYXJyaWVzIHRoZSBzdGRpbiBzb3VyY2UgYWRkZWQgaW4gSXNzdWUgIzE5NTMuXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZVNvdXJjZXMoXG4gIHNvdXJjZXM/OiBNZXNzYWdlRmlsZVJlYWRlciB8IE1lc3NhZ2VTb3VyY2VzLFxuKTogTWVzc2FnZVNvdXJjZXMge1xuICBpZiAoIXNvdXJjZXMpIHJldHVybiB7fTtcbiAgcmV0dXJuIHR5cGVvZiBzb3VyY2VzID09PSBcImZ1bmN0aW9uXCIgPyB7IHJlYWRNZXNzYWdlRmlsZTogc291cmNlcyB9IDogc291cmNlcztcbn1cblxuLyoqXG4gKiBNYXNrIGB0ZXh0YCwgdGVsbGluZyB0aGUgY2FsbGVyIHdoZW4gbWFza2luZyBhY3R1YWxseSBjaGFuZ2VkIHNvbWV0aGluZy5cbiAqXG4gKiBFdmVyeSBtYXNraW5nIGluIHRoaXMgbW9kdWxlIGdvZXMgdGhyb3VnaCBoZXJlLCBzbyBgb25NYXNrZWRgIGlzIGEgY29tcGxldGVcbiAqIGFjY291bnQgb2Ygd2hhdCB3YXMgcmV3cml0dGVuIOKAlCBpbmNsdWRpbmcgYSBtZXNzYWdlIHRoYXQgbmV2ZXIgYXBwZWFyZWQgaW5cbiAqIGFyZ3YgYXQgYWxsLlxuICovXG5mdW5jdGlvbiBtYXNrKHRleHQ6IHN0cmluZywgc291cmNlczogTWVzc2FnZVNvdXJjZXMpOiBzdHJpbmcge1xuICBjb25zdCBtYXNrZWQgPSByZWRhY3RTZWNyZXRzKHRleHQpO1xuICBpZiAobWFza2VkICE9PSB0ZXh0KSBzb3VyY2VzLm9uTWFza2VkPy4oKTtcbiAgcmV0dXJuIG1hc2tlZDtcbn1cblxuLyoqXG4gKiBJbmRleCBvZiB0aGUgc3ViY29tbWFuZCB0b2tlbiwgc2tpcHBpbmcgYGdpdGAncyBvd24gbGVhZGluZyBvcHRpb25zLlxuICpcbiAqIGBnaXQgLUMgL3JlcG8gLWMgdXNlci5uYW1lPXggY29tbWl0IOKApmAgbXVzdCBzY29wZSBhcyBgY29tbWl0YCwgc28gdGhlXG4gKiBvcHRpb25zIHRoYXQgY29uc3VtZSBhIGZvbGxvd2luZyBhcmd1bWVudCBhcmUgc3RlcHBlZCBvdmVyIHJhdGhlciB0aGFuXG4gKiBtaXN0YWtlbiBmb3IgdGhlIHN1YmNvbW1hbmQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgYWJvdXQgdG8gYmUgcGFzc2VkIHRvIHRoZSBgZ2l0YCBiaW5hcnkuXG4gKiBAcmV0dXJucyBUaGUgaW5kZXggb2YgdGhlIHN1YmNvbW1hbmQsIG9yIC0xIHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdpdFN1YmNvbW1hbmRJbmRleChhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXSA/PyBcIlwiO1xuICAgIGlmICghdG9rZW4uc3RhcnRzV2l0aChcIi1cIikpIHJldHVybiBpO1xuICAgIGlmIChHTE9CQUxfVkFMVUVfT1BUSU9OUy5oYXModG9rZW4pKSBpKys7XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuXG4vKipcbiAqIFJlZGFjdCBzZWNyZXRzIGZyb20gdGhlIG1lc3NhZ2UtY2FycnlpbmcgYXJndW1lbnRzIG9mIGEgYGdpdGAgaW52b2NhdGlvbi5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBhYm91dCB0byBiZSBwYXNzZWQgdG8gdGhlIGBnaXRgIGJpbmFyeS5cbiAqIEBwYXJhbSBzb3VyY2VzIC0gRWl0aGVyIGEgYmFyZSBgLUYgPHBhdGg+YCByZWFkZXIgKHRoZSBvcmlnaW5hbCBzaWduYXR1cmUpXG4gKiAgIG9yIGEge0BsaW5rIE1lc3NhZ2VTb3VyY2VzfSBvYmplY3QuIFN1cHBseWluZyBhIHJlYWRlciBleHRlbmRzIHJlZGFjdGlvblxuICogICB0byB0aGUgY29udGVudHMgb2YgYC1GIDxwYXRoPmAgLyBgLS1maWxlIDxwYXRoPmAgYXJndW1lbnRzOyBzdXBwbHlpbmcgYVxuICogICBgc3RkaW5gIHNvdXJjZSBleHRlbmRzIGl0IHRvIGAtRiAtYC4gRWl0aGVyIHdheSB0aGUgbWVzc2FnZSBpcyByZXdyaXR0ZW5cbiAqICAgdG8gYW4gaW5saW5lIG1hc2tlZCBgLW1gLCBzbyB0aGUgY2FsbGVyJ3Mgb3duIGZpbGUgaXMgbmV2ZXIgbW9kaWZpZWQgYW5kXG4gKiAgIHRoZSByZWFsIGBnaXRgIGhhcyBub3RoaW5nIGxlZnQgdG8gcmVhZC5cbiAqIEByZXR1cm5zIEEgbmV3IGFycmF5IHdpdGggbWVzc2FnZSBhcmd1bWVudHMgcmVkYWN0ZWQ7IGV2ZXJ5IG90aGVyIGFyZ3VtZW50XG4gKiAgIGlzIHJldHVybmVkIGJ5dGUtZm9yLWJ5dGUgdW5jaGFuZ2VkLiBUaGUgYXJndW1lbnQgY291bnQgbmV2ZXIgY2hhbmdlcy5cbiAqIEB0aHJvd3MgVW5yZWRhY3RhYmxlTWVzc2FnZUVycm9yIHdoZW4gYSBtZXNzYWdlIHNvdXJjZSBjYW5ub3QgYmUgc2Nhbm5lZCDigJRcbiAqICAgaW5jbHVkaW5nIGEgYGNvbW1pdC10cmVlYCBnaXZlbiBubyBtZXNzYWdlIG9wdGlvbiBhdCBhbGwsIHdob3NlIG1lc3NhZ2VcbiAqICAgYGdpdGAgd291bGQgdGFrZSBmcm9tIHN0ZGluIHdpdGggbm90aGluZyBpbiB0aGUgYXJndiBuYW1pbmcgaXQgKCMxOTY5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdEdpdE1lc3NhZ2VBcmdzKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgc291cmNlcz86IE1lc3NhZ2VGaWxlUmVhZGVyIHwgTWVzc2FnZVNvdXJjZXMsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGlvID0gbm9ybWFsaXNlU291cmNlcyhzb3VyY2VzKTtcbiAgY29uc3Qgb3V0ID0gWy4uLmFyZ3NdO1xuICBjb25zdCBzdGFydCA9IGdpdFN1YmNvbW1hbmRJbmRleChvdXQpO1xuICBpZiAoc3RhcnQgPCAwKSByZXR1cm4gb3V0O1xuICBjb25zdCBzcGVjID0gTUVTU0FHRV9TVUJDT01NQU5EUy5nZXQob3V0W3N0YXJ0XSA/PyBcIlwiKTtcbiAgaWYgKCFzcGVjKSByZXR1cm4gb3V0O1xuXG4gIGNvbnN0IHN0YXRlOiBQYXNzU3RhdGUgPSB7IHNhd01lc3NhZ2VPcHRpb246IGZhbHNlIH07XG4gIGZvciAobGV0IGkgPSBzdGFydCArIDE7IGkgPCBvdXQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhcmcgPSBvdXRbaV0gPz8gXCJcIjtcbiAgICAvLyBFdmVyeXRoaW5nIGFmdGVyIGAtLWAgaXMgYSBwYXRoc3BlYywgbmV2ZXIgYSBtZXNzYWdlLlxuICAgIGlmIChhcmcgPT09IFwiLS1cIikgYnJlYWs7XG4gICAgaWYgKCFhcmcuc3RhcnRzV2l0aChcIi1cIikgfHwgYXJnID09PSBcIi1cIikgY29udGludWU7XG5cbiAgICBpZiAoYXJnLnN0YXJ0c1dpdGgoXCItLVwiKSkge1xuICAgICAgaSA9IHJlZGFjdExvbmdPcHRpb24ob3V0LCBpLCBzcGVjLCBpbywgc3RhdGUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGkgPSByZWRhY3RTaG9ydENsdXN0ZXIob3V0LCBpLCBzcGVjLCBpbywgc3RhdGUpO1xuICB9XG5cbiAgLy8gSXNzdWUgIzE5Njk6IGBnaXQgY29tbWl0LXRyZWUgPHRyZWU+YCB0YWtlcyBpdHMgbWVzc2FnZSBmcm9tIHN0ZGluIHdoZW4gbm9cbiAgLy8gb3B0aW9uIG5hbWVzIG9uZSwgc28gdGhlIGFyZ3YgdGhlIGd1YXJkIHNjYW5zIGhvbGRzIG5vIG1lc3NhZ2UgYXQgYWxsLlxuICAvLyBSZWZ1c2UsIG5hbWluZyB0aGUgc3BlbGxpbmdzIHRoYXQgYXJlIHNjYW5uZWQsIHJhdGhlciB0aGFuIGhhbmQgYGdpdGAgYVxuICAvLyBjb21tYW5kIHdob3NlIG1lc3NhZ2UgdGhpcyBjb250cm9sIG5ldmVyIHNhdy5cbiAgaWYgKHNwZWMuc3RkaW5XaXRob3V0T3B0aW9uICYmICFzdGF0ZS5zYXdNZXNzYWdlT3B0aW9uKSB7XG4gICAgdGhyb3cgbmV3IFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcihcbiAgICAgIFwiLVwiLFxuICAgICAgYGdpdCAke291dFtzdGFydF19IHdpdGggbmVpdGhlciAtbSBub3IgLUYgcmVhZHMgaXRzIGNvbW1pdCBtZXNzYWdlIGAgK1xuICAgICAgICBcImZyb20gc3RhbmRhcmQgaW5wdXQsIHdoZXJlIG5vIGFyZ3VtZW50IG5hbWVzIGl0IGFuZCBub3RoaW5nIGNhbiBcIiArXG4gICAgICAgIFwic2NhbiBpdCDigJQgcGFzcyB0aGUgbWVzc2FnZSB3aXRoIC1tIDx0ZXh0PiBvciAtRiA8cGF0aD4sIG9yIHBpcGUgaXQgXCIgK1xuICAgICAgICBcIndpdGggLUYgLVwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgYXJndiB3b3VsZCB0YWtlIGl0cyBtZXNzYWdlIGZyb20gc3RkaW4gKGAtRiAtYCkuXG4gKlxuICogQW5zd2VyZWQgYnkgcnVubmluZyB0aGUgcmVkYWN0aW9uIGl0c2VsZiBhZ2FpbnN0IGEgcHJvYmUgc291cmNlIHJhdGhlciB0aGFuXG4gKiBieSBwYXJzaW5nIHRoZSBhcmd2IGEgc2Vjb25kIHdheTogdHdvIHBhcnNlcnMgdGhhdCBkaXNhZ3JlZSBpcyBleGFjdGx5IHRoZVxuICogYnVnIHRoaXMgbW9kdWxlJ3Mgc3ViY29tbWFuZCBzY29waW5nIGV4aXN0cyB0byBhdm9pZC4gVGhlIGd1YXJkIHVzZXMgaXQgdG9cbiAqIGRlY2lkZSB3aGV0aGVyIHRvIHJlYWQgc3RkaW4gYXQgYWxsIOKAlCBgZ2l0IGFtIC0tbWVzc2FnZS1pZGAgcmVhY2hlcyB0aGVcbiAqIGd1YXJkIG9uIHRoZSB3cmFwcGVyJ3MgZGVsaWJlcmF0ZWx5IG92ZXItbWF0Y2hpbmcgZmFzdCBwYXRoIGFuZCBtdXN0IGJlXG4gKiBoYW5kZWQgaXRzIG93biBtYm94IHVudG91Y2hlZC5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBhYm91dCB0byBiZSBwYXNzZWQgdG8gdGhlIGBnaXRgIGJpbmFyeS5cbiAqIEByZXR1cm5zIFRydWUgd2hlbiBhIG1lc3NhZ2Ugc291cmNlIG9mIGAtYCBpcyBwcmVzZW50IGFuZCB3b3VsZCBiZSB1c2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXNlc1N0ZGluTWVzc2FnZShhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBsZXQgbmVlZGVkID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmVkYWN0R2l0TWVzc2FnZUFyZ3MoYXJncywge1xuICAgICAgc3RkaW46IHtcbiAgICAgICAgcmVhZDogKCkgPT4ge1xuICAgICAgICAgIG5lZWRlZCA9IHRydWU7XG4gICAgICAgICAgcmV0dXJuIFwiXCI7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBBIGNvbW1hbmQgdGhpcyBtb2R1bGUgcmVmdXNlcyBvdXRyaWdodCAoYGdpdCBjb21taXQtdHJlZWAgd2l0aCBub1xuICAgIC8vIG1lc3NhZ2Ugb3B0aW9uLCBJc3N1ZSAjMTk2OSkgcmVhZHMgbm8gc3RkaW46IHRoZSByZWZ1c2FsIGlzIHJhaXNlZCBhZ2FpblxuICAgIC8vIGJ5IHRoZSByZWFsIHBhc3MgYW5kIHJlcG9ydGVkIHRoZXJlLCBzbyBzd2FsbG93aW5nIGl0IGhlcmUgY2Fubm90IGhpZGVcbiAgICAvLyBpdC4gQW55IG90aGVyIGVycm9yIGlzIGEgYnVnIGFuZCBzdGlsbCBlc2NhcGVzLlxuICAgIGlmICghKGVyciBpbnN0YW5jZW9mIFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcikpIHRocm93IGVycjtcbiAgfVxuICByZXR1cm4gbmVlZGVkO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYG5hbWVgIGlzIGFuIGFiYnJldmlhdGlvbiBgZ2l0YCB3b3VsZCBleHBhbmQgdG8gYGZ1bGxgLlxuICpcbiAqIGBnaXRgIGFjY2VwdHMgYW55IHVuYW1iaWd1b3VzIHByZWZpeCBvZiBhIGxvbmcgb3B0aW9uLCBzbyBgZ2l0IGNvbW1pdCAtLW1lc3NcbiAqIFwiJFRPS0VOXCJgIGNvbW1pdHMgZXhhY3RseSBhcyBgLS1tZXNzYWdlYCBkb2VzLiBNYXRjaGluZyB0aGUgZnVsbCBzcGVsbGluZ1xuICogYWxvbmUgd291bGQgbGVhdmUgdGhhdCBhcyBhIG9uZS1jaGFyYWN0ZXIgYnlwYXNzIG9mIHRoZSB3aG9sZSBjb250cm9sLlxuICpcbiAqIGBtaW5MZW5ndGhgIGlzIHRoZSBwb2ludCBhdCB3aGljaCB0aGUgcHJlZml4IHN0b3BzIGNvbGxpZGluZyB3aXRoIGFub3RoZXJcbiAqIG9wdGlvbiBvZiB0aGVzZSBzdWJjb21tYW5kczogYC0tZmlsYCBpcyB0aGUgc2hvcnRlc3QgdW5hbWJpZ3VvdXMgZm9ybSBvZlxuICogYC0tZmlsZWAgKGAtLWZpYCBjb2xsaWRlcyB3aXRoIGAtLWZpeHVwYCksIGFuZCBhbnl0aGluZyBzaG9ydGVyIGBnaXRgIGl0c2VsZlxuICogcmVqZWN0cywgc28gaXQgY2FuIGNhcnJ5IG5vIG1lc3NhZ2UuIGAtLW1lc3NhZ2VgIG5lZWRzIG5vIGZsb29yIOKAlCB0aGUgd29yc3RcbiAqIGEgZmFsc2UgbWF0Y2ggY2FuIGRvIHRoZXJlIGlzIHJlZGFjdCB0aGUgdmFsdWUgb2Ygc29tZSBvdGhlciBgLS1t4oCmYCBvcHRpb24sXG4gKiBhbmQgYSByb3V0aW5nIHZhbHVlIG5ldmVyIG1hdGNoZXMgYSBzZWNyZXQgc2hhcGUuXG4gKi9cbmZ1bmN0aW9uIGlzTG9uZ09wdGlvblByZWZpeChcbiAgbmFtZTogc3RyaW5nLFxuICBmdWxsOiBzdHJpbmcsXG4gIG1pbkxlbmd0aDogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBuYW1lLmxlbmd0aCA+PSBtaW5MZW5ndGggJiYgbmFtZS5sZW5ndGggPD0gZnVsbC5sZW5ndGggJiZcbiAgICBmdWxsLnN0YXJ0c1dpdGgobmFtZSk7XG59XG5cbi8qKiBTaG9ydGVzdCBwcmVmaXggb2YgYC0tZmlsZWAgdGhhdCBubyBvdGhlciBvcHRpb24gb2YgdGhlc2Ugc3ViY29tbWFuZHMgc2hhcmVzLiAqL1xuY29uc3QgRklMRV9QUkVGSVhfTUlOID0gMztcblxuLyoqXG4gKiBTcGxpdCBgLS1uYW1lYCBvciBgLS1uYW1lPXZhbHVlYCBpbnRvIGl0cyBwYXJ0cywgb3IgdW5kZWZpbmVkIHdoZW4gYGFyZ2AgaXNcbiAqIG5vdCBhIGxvbmcgb3B0aW9uLlxuICovXG5mdW5jdGlvbiBzcGxpdExvbmdPcHRpb24oXG4gIGFyZzogc3RyaW5nLFxuKTogeyBuYW1lOiBzdHJpbmc7IGlubGluZVZhbHVlPzogc3RyaW5nIH0gfCB1bmRlZmluZWQge1xuICBpZiAoIWFyZy5zdGFydHNXaXRoKFwiLS1cIikgfHwgYXJnID09PSBcIi0tXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGJvZHkgPSBhcmcuc3Vic3RyaW5nKDIpO1xuICBjb25zdCBlcSA9IGJvZHkuaW5kZXhPZihcIj1cIik7XG4gIGlmIChlcSA8IDApIHJldHVybiB7IG5hbWU6IGJvZHkgfTtcbiAgcmV0dXJuIHsgbmFtZTogYm9keS5zdWJzdHJpbmcoMCwgZXEpLCBpbmxpbmVWYWx1ZTogYm9keS5zdWJzdHJpbmcoZXEgKyAxKSB9O1xufVxuXG4vKipcbiAqIFJlZGFjdCBhIGAtLW1lc3NhZ2VgL2AtLWZpbGVgIG9wdGlvbiDigJQgb3IgYW55IGFiYnJldmlhdGlvbiBvZiBvbmUg4oCUIGluIHBsYWNlLlxuICpcbiAqIEByZXR1cm5zIFRoZSBpbmRleCB0aGUgY2FsbGVyJ3MgbG9vcCBzaG91bGQgY29udGludWUgZnJvbSAoYWR2YW5jZWQgYnkgb25lXG4gKiAgIHdoZW4gdGhlIG9wdGlvbidzIHZhbHVlIHdhcyBhIHNlcGFyYXRlIGFyZ3VtZW50KS5cbiAqL1xuZnVuY3Rpb24gcmVkYWN0TG9uZ09wdGlvbihcbiAgb3V0OiBzdHJpbmdbXSxcbiAgaTogbnVtYmVyLFxuICBzcGVjOiBNZXNzYWdlU3ViY29tbWFuZCxcbiAgc291cmNlczogTWVzc2FnZVNvdXJjZXMsXG4gIHN0YXRlOiBQYXNzU3RhdGUsXG4pOiBudW1iZXIge1xuICBjb25zdCBwYXJzZWQgPSBzcGxpdExvbmdPcHRpb24ob3V0W2ldID8/IFwiXCIpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuIGk7XG4gIGNvbnN0IHsgbmFtZSwgaW5saW5lVmFsdWUgfSA9IHBhcnNlZDtcbiAgY29uc3QgbmV4dCA9IG91dFtpICsgMV07XG5cbiAgaWYgKHNwZWMubWVzc2FnZSAmJiBpc0xvbmdPcHRpb25QcmVmaXgobmFtZSwgXCJtZXNzYWdlXCIsIDEpKSB7XG4gICAgc3RhdGUuc2F3TWVzc2FnZU9wdGlvbiA9IHRydWU7XG4gICAgaWYgKGlubGluZVZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIG91dFtpXSA9IGAtLW1lc3NhZ2U9JHttYXNrKGlubGluZVZhbHVlLCBzb3VyY2VzKX1gO1xuICAgICAgcmV0dXJuIGk7XG4gICAgfVxuICAgIGlmIChuZXh0ID09PSB1bmRlZmluZWQpIHJldHVybiBpO1xuICAgIG91dFtpICsgMV0gPSBtYXNrKG5leHQsIHNvdXJjZXMpO1xuICAgIHJldHVybiBpICsgMTtcbiAgfVxuXG4gIGlmIChzcGVjLmZpbGUgJiYgaXNMb25nT3B0aW9uUHJlZml4KG5hbWUsIFwiZmlsZVwiLCBGSUxFX1BSRUZJWF9NSU4pKSB7XG4gICAgc3RhdGUuc2F3TWVzc2FnZU9wdGlvbiA9IHRydWU7XG4gICAgaWYgKGlubGluZVZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IG1hc2tlZCA9IG1hc2tlZE1lc3NhZ2VGaWxlKGlubGluZVZhbHVlLCBzb3VyY2VzKTtcbiAgICAgIGlmIChtYXNrZWQgIT09IHVuZGVmaW5lZCkgb3V0W2ldID0gYC0tbWVzc2FnZT0ke21hc2tlZH1gO1xuICAgICAgcmV0dXJuIGk7XG4gICAgfVxuICAgIGlmIChuZXh0ID09PSB1bmRlZmluZWQpIHJldHVybiBpO1xuICAgIGNvbnN0IG1hc2tlZCA9IG1hc2tlZE1lc3NhZ2VGaWxlKG5leHQsIHNvdXJjZXMpO1xuICAgIGlmIChtYXNrZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgb3V0W2ldID0gXCItLW1lc3NhZ2VcIjtcbiAgICAgIG91dFtpICsgMV0gPSBtYXNrZWQ7XG4gICAgfVxuICAgIHJldHVybiBpICsgMTtcbiAgfVxuXG4gIHJldHVybiBpO1xufVxuXG4vKipcbiAqIFJlZGFjdCBhIHNob3J0LW9wdGlvbiBjbHVzdGVyIGluIHBsYWNlLCB0aGUgd2F5IGBnaXRgIHJlYWRzIG9uZS5cbiAqXG4gKiBgLW1gL2AtRmAgdGFrZSB0aGUgcmVzdCBvZiB0aGUgY2x1c3RlciBhcyB0aGVpciB2YWx1ZSB3aGVuIHRoZXJlIGlzIG9uZSBhbmRcbiAqIHRoZSBmb2xsb3dpbmcgYXJndW1lbnQgb3RoZXJ3aXNlOyBhIGNsdXN0ZXIgdGhhdCByZWFjaGVzIGEgdmFsdWUtY29uc3VtaW5nXG4gKiBsZXR0ZXIgZmlyc3QgY2FycmllcyBubyBtZXNzYWdlIGF0IGFsbC5cbiAqXG4gKiBAcmV0dXJucyBUaGUgaW5kZXggdGhlIGNhbGxlcidzIGxvb3Agc2hvdWxkIGNvbnRpbnVlIGZyb20uXG4gKi9cbmZ1bmN0aW9uIHJlZGFjdFNob3J0Q2x1c3RlcihcbiAgb3V0OiBzdHJpbmdbXSxcbiAgaTogbnVtYmVyLFxuICBzcGVjOiBNZXNzYWdlU3ViY29tbWFuZCxcbiAgc291cmNlczogTWVzc2FnZVNvdXJjZXMsXG4gIHN0YXRlOiBQYXNzU3RhdGUsXG4pOiBudW1iZXIge1xuICBjb25zdCBjbHVzdGVyID0gKG91dFtpXSA/PyBcIlwiKS5zdWJzdHJpbmcoMSk7XG4gIGZvciAobGV0IGsgPSAwOyBrIDwgY2x1c3Rlci5sZW5ndGg7IGsrKykge1xuICAgIGNvbnN0IGxldHRlciA9IGNsdXN0ZXJba10gPz8gXCJcIjtcbiAgICBjb25zdCBoZWFkID0gYC0ke2NsdXN0ZXIuc3Vic3RyaW5nKDAsIGspfWA7XG4gICAgY29uc3QgdGFpbCA9IGNsdXN0ZXIuc3Vic3RyaW5nKGsgKyAxKTtcblxuICAgIGlmIChsZXR0ZXIgPT09IFwibVwiICYmIHNwZWMubWVzc2FnZSkge1xuICAgICAgc3RhdGUuc2F3TWVzc2FnZU9wdGlvbiA9IHRydWU7XG4gICAgICBpZiAodGFpbC5sZW5ndGggPiAwKSB7XG4gICAgICAgIG91dFtpXSA9IGAke2hlYWR9bSR7bWFzayh0YWlsLCBzb3VyY2VzKX1gO1xuICAgICAgICByZXR1cm4gaTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5leHQgPSBvdXRbaSArIDFdO1xuICAgICAgaWYgKG5leHQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGk7XG4gICAgICBvdXRbaSArIDFdID0gbWFzayhuZXh0LCBzb3VyY2VzKTtcbiAgICAgIHJldHVybiBpICsgMTtcbiAgICB9XG5cbiAgICBpZiAobGV0dGVyID09PSBcIkZcIiAmJiBzcGVjLmZpbGUpIHtcbiAgICAgIHN0YXRlLnNhd01lc3NhZ2VPcHRpb24gPSB0cnVlO1xuICAgICAgaWYgKHRhaWwubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBtYXNrZWQgPSBtYXNrZWRNZXNzYWdlRmlsZSh0YWlsLCBzb3VyY2VzKTtcbiAgICAgICAgaWYgKG1hc2tlZCAhPT0gdW5kZWZpbmVkKSBvdXRbaV0gPSBgJHtoZWFkfW0ke21hc2tlZH1gO1xuICAgICAgICByZXR1cm4gaTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG5leHQgPSBvdXRbaSArIDFdO1xuICAgICAgaWYgKG5leHQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGk7XG4gICAgICBjb25zdCBtYXNrZWQgPSBtYXNrZWRNZXNzYWdlRmlsZShuZXh0LCBzb3VyY2VzKTtcbiAgICAgIGlmIChtYXNrZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBvdXRbaV0gPSBgJHtoZWFkfW1gO1xuICAgICAgICBvdXRbaSArIDFdID0gbWFza2VkO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGkgKyAxO1xuICAgIH1cblxuICAgIC8vIEEgbGV0dGVyIHRoYXQgY29uc3VtZXMgaXRzIHZhbHVlIGVuZHMgdGhlIGNsdXN0ZXIgZm9yIGBnaXRgIHRvby5cbiAgICBpZiAoc3BlYy52YWx1ZVNob3J0cy5oYXMobGV0dGVyKSkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIGk7XG59XG5cbi8qKlxuICogUmVhZCBhIG1lc3NhZ2UgZmlsZSBhbmQgcmV0dXJuIGl0cyBtYXNrZWQgY29udGVudHMsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZXJlXG4gKiB3YXMgbm90aGluZyB0byBtYXNrICh0aGUgZmlsZSByZWZlcmVuY2UgaXMgdGhlbiBsZWZ0IGV4YWN0bHkgYXMgaXQgd2FzKS5cbiAqXG4gKiBgLWAgaXMgdGhlIG1lc3NhZ2Ugb24gc3RkaW4sIGFuZCBpdCBpcyB0aGUgb25lIHNvdXJjZSB0aGF0IGlzICoqYWx3YXlzKipcbiAqIHJldHVybmVkIHJhdGhlciB0aGFuIGxlZnQgYWxvbmUgKElzc3VlICMxOTUzKTogc3RkaW4gY2FuIGJlIGNvbnN1bWVkIG9uY2UsXG4gKiBzbyBvbmNlIHRoZSBndWFyZCBoYXMgcmVhZCBpdCB0aGUgcmVhbCBgZ2l0YCBtdXN0IGJlIGhhbmRlZCB0aGUgdGV4dCBpblxuICogYXJndiB3aGV0aGVyIG9yIG5vdCBhIHNlY3JldCB3YXMgZm91bmQgaW4gaXQuXG4gKlxuICogV2l0aCBubyByZWFkZXIgc3VwcGxpZWQgdGhlIGNhbGxlciBvcHRlZCBpbnRvIGFyZ3Ytb25seSByZWRhY3Rpb24sIHNvIGEgcGF0aFxuICogcmVmZXJlbmNlIGlzIGxlZnQgYWxvbmU7IHdpdGggbm8gc3RkaW4gc291cmNlIHN1cHBsaWVkIGAtYCBmYWlscyBjbG9zZWQsXG4gKiB3aGljaCBpcyB3aGF0IHRoZSB3b3JrZXIncyBvd24gY2hva2Vwb2ludCBzdGlsbCBkb2VzLlxuICpcbiAqIEB0aHJvd3MgVW5yZWRhY3RhYmxlTWVzc2FnZUVycm9yIHdoZW4gdGhlIG1lc3NhZ2UgY2Fubm90IGJlIHJlYWQgYXQgYWxsLlxuICovXG5mdW5jdGlvbiBtYXNrZWRNZXNzYWdlRmlsZShcbiAgcGF0aDogc3RyaW5nLFxuICBzb3VyY2VzOiBNZXNzYWdlU291cmNlcyxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmIChwYXRoID09PSBcIi1cIikgcmV0dXJuIG1hc2tlZFN0ZGluTWVzc2FnZShzb3VyY2VzKTtcbiAgaWYgKCFzb3VyY2VzLnJlYWRNZXNzYWdlRmlsZSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0ZXh0ID0gc291cmNlcy5yZWFkTWVzc2FnZUZpbGUocGF0aCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IoXG4gICAgICBwYXRoLFxuICAgICAgYGNvdWxkIG5vdCByZWFkIHRoZSBnaXQgbWVzc2FnZSBmaWxlICR7cGF0aH06ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBtYXNrZWQgPSBtYXNrKHRleHQsIHNvdXJjZXMpO1xuICByZXR1cm4gbWFza2VkID09PSB0ZXh0ID8gdW5kZWZpbmVkIDogbWFza2VkO1xufVxuXG4vKipcbiAqIENvbnN1bWUgdGhlIGAtRiAtYCBtZXNzYWdlIGFuZCByZXR1cm4gaXRzIG1hc2tlZCB0ZXh0IChJc3N1ZSAjMTk1MykuXG4gKlxuICogQHRocm93cyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3Igd2hlbiBubyBzdGRpbiBzb3VyY2Ugd2FzIHN1cHBsaWVkLCBvciB3aGVuXG4gKiAgIHRoZSBzb3VyY2UgaXRzZWxmIGNvdWxkIG5vdCBwcm9kdWNlIGEgc2Nhbm5hYmxlIG1lc3NhZ2UuXG4gKi9cbmZ1bmN0aW9uIG1hc2tlZFN0ZGluTWVzc2FnZShzb3VyY2VzOiBNZXNzYWdlU291cmNlcyk6IHN0cmluZyB7XG4gIGlmICghc291cmNlcy5zdGRpbikge1xuICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IoXG4gICAgICBcIi1cIixcbiAgICAgIFwiYSBnaXQgbWVzc2FnZSByZWFkIGZyb20gc3RkaW4gY2Fubm90IGJlIHNjYW5uZWQgZm9yIHNlY3JldHMg4oCUIHdyaXRlIFwiICtcbiAgICAgICAgXCJpdCB0byBhIGZpbGUgYW5kIHBhc3MgLUYgPHBhdGg+XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbWFzayhz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
// denoCacheMetadata=11107333335697520722,14011764556823202366