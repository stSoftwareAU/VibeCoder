/**
 * Redaction of `gh` body arguments at the spawn chokepoint (Issue #3707).
 *
 * Comment and PR bodies are the worker's public sinks: whatever is passed as
 * `--body` (or `-f body=…`) is published to GitHub, often on a public repo.
 * Individual call sites were redacting inconsistently — `label_failure.ts`
 * masked its failure text, while the two PR-comment failure replies and the
 * question-failure comment embedded arbitrary text verbatim — so a token that
 * reached one of the unredacted sinks was published.
 *
 * Redacting per call site cannot hold: each new sink has to remember. This
 * module masks the published-text arguments once, inside `spawnGh`, so every
 * present and future public sink inherits redaction by construction.
 *
 * **Titles and label fields (Issue #1283).** A body was not the only public
 * sink reaching the chokepoint: `--title`, `-f title=`, `-f description=` and
 * `-f name=` are published just as widely — ~30 issue-create sites,
 * `editIssue`, `gh pr create`, the milestone and label REST calls — and they
 * passed through byte-for-byte, which is why `refinement_processor.ts` and
 * `revision_processor.ts` hand-wrapped `redactSecrets` around a new title. They
 * are now covered here, so a title inherits redaction like a body.
 *
 * Only published-text arguments are rewritten. Routing arguments — the repo
 * slug, the API path, `--label`, `--head`, reaction fields — are left
 * byte-for-byte alone so a mutation is never redirected by redaction.
 *
 * **Bodies read from a file (Issue #3938).** The worker process is not the only
 * caller of `gh`: the agent subprocess reaches the binary through the PATH
 * shim, and its everyday spelling is `--body-file <path>` as often as
 * `--body <text>`. Supply a {@link BodyFileReader} and the file's contents are
 * scanned too — when a secret is found the argument becomes an inline `--body`
 * carrying the masked text, so the agent's own file is never rewritten. A body
 * that cannot be scanned at all (stdin, an unreadable path) raises
 * {@link UnredactableBodyError} rather than being published unscanned. Callers
 * that pass no reader keep the argv-only behaviour.
 *
 * **`gh api --input <file>` bodies (Issue #92).** `gh api …/comments --input
 * body.json` POSTs the file's JSON as the request body — the same public sink
 * as a comment, invisible to the argv. Supply a reader (to scan) and a
 * {@link BodyFileWriter} (to materialise a masked copy) and the
 * {@link PUBLISHED_FIELD_KEYS} of the JSON body are redacted;
 * when something is masked the redacted JSON is written to a *fresh* temp file
 * and `--input` is pointed at that, so the agent's own file is never rewritten.
 * A body that is not a JSON object, or that hides a secret outside a redactable
 * field, raises {@link UnredactableBodyError} rather than being published
 * unscanned — unparseable never means unscanned.
 *
 * **Bodies piped on stdin (Issue #1254).** A `-` body source is invisible here:
 * the bytes never appear in argv. It therefore fails closed — unless the caller
 * declares it scans stdin itself (`stdinScanned`), which is what `spawnGh` now
 * does: it owns the bytes it writes to the child and puts them through
 * `redactSecrets` before the write, so `gh api --input -` is scanned rather
 * than refused.
 *
 * ```mermaid
 * flowchart LR
 *     C["comment / PR-body call sites"] --> S["spawnGh()"]
 *     A["agent gh calls"] --> G["gh guard shim"]
 *     S --> R["redactGhBodyArgs + reader/writer<br/>(--body, -b, --title, -f body=/title=…, --body-file, --input)"]
 *     S --> ST["redactSecrets(stdin)<br/>(--input - bodies)"]
 *     G --> R2["redactGhBodyArgs + reader/writer<br/>(argv, --body-file, --input)"]
 *     R --> GH["gh subprocess → GitHub"]
 *     ST --> GH
 *     R2 --> GH
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactSecrets } from "./secret_redaction.ts";
import { redactPromptLeakage } from "./prompt_leak_redaction.ts";
import { buildMaskedInstructionNotice, findMaskedInstructions } from "./masked_instructions.ts";
/**
 * The full mask applied to every body this module touches (Issue #1421).
 *
 * `redactSecrets` alone was the whole mask, so this chokepoint — the one
 * place the module doc promises "every present and future public sink
 * inherits redaction by construction" — carried no LLM07 backstop. Prompt
 * injection during an ordinary run (`work-on`, `planning`, `grill-me`,
 * `ci_fix`, revision) could have the agent echo the system prompt, the
 * `<coding_guidelines>` block or this run's `BOUNDARY_<id>` nonce into a
 * comment or PR body, and only secret-SHAPED text was masked on the way out.
 * `redactPromptLeakage` existed for exactly that and had one caller,
 * `answer_sanitiser.ts`, covering only the question-answering path.
 *
 * Order follows `answer_sanitiser.ts:100` — prompt-leak first, secrets
 * second. (The issue text describes the opposite order; the code is the
 * authority.) Whole-block scaffolding is collapsed to a placeholder first,
 * then the secret pass runs over what remains, so a token inside a block
 * cannot survive by being removed from the secret pass's view.
 *
 * One helper, used by every branch, so a body-carrying argument added later
 * cannot pick up half the mask.
 */ function maskBody(text) {
  return redactSecrets(redactPromptLeakage(text));
}
/**
 * The same mask, for a body that is not an argv element (Issue #1421).
 *
 * `gh api --input -` sends its body on stdin, which never passes through
 * `redactGhBodyArgs` because there is no argument to rewrite. Exported so
 * `spawnGh` can apply the identical mask to `options.stdin` and the
 * chokepoint's guarantee covers both routes rather than only the visible one.
 */ export function redactGhBodyText(text) {
  return maskBody(text);
}
/**
 * Flags whose following argument is published text.
 *
 * A title and a label/repo description are public sinks exactly like a body
 * (Issue #1283), so `--title` and `--description` join them — the latter
 * because `label_operations.ts` publishes the same text through the CLI
 * spelling as well as through `-f description=`.
 */ const TEXT_FLAGS = new Set([
  "--body",
  "-b",
  "--title",
  "--description"
]);
/**
 * `-t` is `--title` on `issue create` / `pr create` / `release create`, but
 * `--template` on `gh api`. Covered everywhere except `gh api`, so the shim's
 * everyday `gh issue create -t "<title>"` is masked while a `gh api` output
 * template is never rewritten.
 */ const TITLE_SHORTHAND = "-t";
/** Subcommand for which {@link TITLE_SHORTHAND} means `--template` instead. */ const TEMPLATE_SUBCOMMAND = "api";
/** `--flag=<text>` spellings whose value is published text. */ const TEXT_FLAG_PREFIXES = [
  "--body=",
  "--title=",
  "--description="
];
/** Flags whose following argument names a file holding published text. */ const BODY_FILE_FLAGS = new Set([
  "--body-file",
  "-F"
]);
/** Flag whose following argument names a file `gh api` sends as the body. */ const INPUT_FLAGS = new Set([
  "--input"
]);
/** Flags that carry a `key=value` field; only these keys are published text. */ const FIELD_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field"
]);
/** Field flags whose `key=@path` value is read from a file by `gh`. */ const FIELD_FILE_FLAGS = new Set([
  "-F",
  "--field"
]);
/**
 * `key=value` keys that end up as published text.
 *
 * `title`, `description` and `name` joined the body-shaped keys in Issue
 * #1283: `-f title=` creates issues, PRs and milestones, and `-f name=` /
 * `-f description=` create labels — every one of them a public sink. Keys that
 * route a mutation (`owner`, `head`, `assignee`, a reaction's `content`) stay
 * off this list so redaction can never redirect a call.
 *
 * `name` is the one key that is published text in some calls (a label's name)
 * and a routing variable in others (`gh api graphql -F name=<repo>`). Masking
 * is shape-specific, so a repository name — which cannot match a secret rule —
 * survives byte-for-byte; only a `name` that genuinely looks like a credential
 * is rewritten, and that is a value no call should be sending.
 */ const PUBLISHED_FIELD_KEYS = new Set([
  "body",
  "message",
  "note",
  "comment",
  "title",
  "description",
  "name"
]);
/**
 * A body destined for a public sink that could not be scanned for secrets.
 *
 * Raised rather than returning the arguments unchanged: an unscannable body is
 * a failure of the control, and publishing it anyway would mask that failure
 * as success (Issue #3234).
 */ export class UnredactableBodyError extends Error {
  /** The body source that could not be read (a path, or `-` for stdin). */ source;
  constructor(source, message){
    super(message);
    this.name = "UnredactableBodyError";
    this.source = source;
  }
}
/**
 * Redact secrets from the published-text arguments of a `gh` invocation —
 * bodies, titles, and the label/milestone fields GitHub renders publicly.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @param readBodyFile - Optional reader; supplying it extends redaction to the
 *   contents of `--body-file` / `-F <path>` / `-F key=@path` / `--input`
 *   arguments.
 * @param writeBodyFile - Optional writer; needed only to materialise a masked
 *   copy of an `--input` body. When an `--input` body needs masking and no
 *   writer is supplied, the call fails closed rather than publish it.
 * @param stdinScanned - Set by a caller that owns the bytes it pipes to the
 *   child and redacts them itself (`spawnGh`, Issue #1254). A `-` body source
 *   is then genuinely scanned, so it passes through instead of failing closed.
 *   Leave it unset whenever stdin is out of the caller's hands — the refusal
 *   is what stops an unscanned body being published.
 * @returns A new array with published-text arguments redacted; all other
 *   arguments are returned unchanged. Every argument except a rewritten
 *   `--input` path is left byte-for-byte alone.
 * @throws UnredactableBodyError when a body source cannot be scanned.
 */ export function redactGhBodyArgs(args, readBodyFile, writeBodyFile, stdinScanned = false) {
  const out = [
    ...args
  ];
  const titleShorthandIsText = out[0] !== TEMPLATE_SUBCOMMAND;
  for(let i = 0; i < out.length; i++){
    const arg = out[i] ?? "";
    const next = out[i + 1];
    // `--body <text>` / `-b <text>` / `--title <text>` / `-t <text>`
    const isTextFlag = TEXT_FLAGS.has(arg) || titleShorthandIsText && arg === TITLE_SHORTHAND;
    if (isTextFlag && next !== undefined) {
      out[i + 1] = maskBody(next);
      i++;
      continue;
    }
    // `--body=<text>` / `--title=<text>`
    const prefix = TEXT_FLAG_PREFIXES.find((p)=>arg.startsWith(p));
    if (prefix !== undefined) {
      out[i] = `${prefix}${maskBody(arg.substring(prefix.length))}`;
      continue;
    }
    if (readBodyFile) {
      // `--body-file <path>` / `-F <path>` — the `-F` spelling only when the
      // value is not a `key=value` field (that form is handled below).
      if (BODY_FILE_FLAGS.has(arg) && next !== undefined && !next.includes("=")) {
        const masked = maskedBodyFile(next, readBodyFile, stdinScanned);
        if (masked !== undefined) {
          out[i] = "--body";
          out[i + 1] = masked;
        }
        i++;
        continue;
      }
      // `--body-file=<path>`
      if (arg.startsWith("--body-file=")) {
        const path = arg.substring("--body-file=".length);
        const masked = maskedBodyFile(path, readBodyFile, stdinScanned);
        if (masked !== undefined) out[i] = `--body=${masked}`;
        continue;
      }
      // `--input <path>` — `gh api` POSTs the file's JSON as the request body.
      if (INPUT_FLAGS.has(arg) && next !== undefined) {
        const masked = maskedInputFile(next, readBodyFile, stdinScanned);
        if (masked !== undefined) {
          out[i + 1] = materialiseMaskedBody(masked, writeBodyFile);
        }
        i++;
        continue;
      }
      // `--input=<path>`
      if (arg.startsWith("--input=")) {
        const path = arg.substring("--input=".length);
        const masked = maskedInputFile(path, readBodyFile, stdinScanned);
        if (masked !== undefined) {
          out[i] = `--input=${materialiseMaskedBody(masked, writeBodyFile)}`;
        }
        continue;
      }
    }
    // `-f body=<text>` and friends.
    if (FIELD_FLAGS.has(arg) && next !== undefined) {
      out[i + 1] = redactFieldAssignment(next, FIELD_FILE_FLAGS.has(arg) ? readBodyFile : undefined, stdinScanned);
      i++;
    }
  }
  flagMaskedInstructionOnIssueCreate(out);
  return out;
}
/**
 * Say so when an issue is about to be filed with an unreadable instruction
 * (Issue #2390).
 *
 * The mask above is right to be blunt, and a blunt mask has false positives:
 * fourteen audit issues were published reading "Add `persist-credentials:
 * ***REDACTED***`" and nobody was told. Refusing to file would lose the
 * finding, and unmasking is never on the table, so the issue is filed **with a
 * visible notice** naming the masked lines, and one `[MASKED_INSTRUCTION_FILED]`
 * line is logged so a false positive is fixed at its source.
 *
 * Runs after the loop, so it sees the body whichever spelling carried it —
 * every `--body-file` form has already been rewritten to `--body` by then.
 * Only `gh issue create`: a comment or a PR body is not a set of instructions
 * the fleet will later be handed.
 */ function flagMaskedInstructionOnIssueCreate(out) {
  if (out[0] !== "issue" || out[1] !== "create") return;
  for(let i = 2; i < out.length; i++){
    const arg = out[i] ?? "";
    const inline = arg.startsWith("--body=");
    if (!inline && arg !== "--body" && arg !== "-b") continue;
    const at = inline ? i : i + 1;
    const body = inline ? arg.substring("--body=".length) : out[at];
    if (body === undefined) return;
    const hits = findMaskedInstructions(body);
    if (hits.length === 0) return;
    console.error(`[MASKED_INSTRUCTION_FILED] an issue is being filed whose instructions ` + `carry a mask placeholder (line ${hits.map((h)=>h.line).join(", ")}). If the masked value is not a secret, the redaction rule that ` + `matched it has a false positive — fix the rule. The issue carries a ` + `notice and the pickup path will ask for the value (Issue #2390).`);
    const flagged = body + buildMaskedInstructionNotice(hits);
    out[at] = inline ? `--body=${flagged}` : flagged;
    return;
  }
}
/** Redact the value of a `key=value` field when the key is published text. */ function redactFieldAssignment(field, readBodyFile, stdinScanned = false) {
  const eq = field.indexOf("=");
  if (eq <= 0) return field;
  const key = field.substring(0, eq);
  if (!PUBLISHED_FIELD_KEYS.has(key.toLowerCase())) return field;
  const value = field.substring(eq + 1);
  // `-F body=@path` — gh reads the value from the file, so scan the file.
  if (readBodyFile && value.startsWith("@")) {
    const masked = maskedBodyFile(value.substring(1), readBodyFile, stdinScanned);
    return masked === undefined ? field : `${key}=${masked}`;
  }
  return `${key}=${maskBody(value)}`;
}
/**
 * Read a body file and return its masked contents, or undefined when there was
 * nothing to mask (in which case the file reference is left as it was).
 *
 * @throws UnredactableBodyError when the body cannot be read at all.
 */ function maskedBodyFile(path, readBodyFile, stdinScanned) {
  if (path === "-") {
    // The caller pipes — and redacts — those bytes itself (Issue #1254), so
    // the body is scanned; only an unscanned stdin body fails closed.
    if (stdinScanned) return undefined;
    throw new UnredactableBodyError(path, "a body read from stdin cannot be scanned for secrets — write it to a " + "file and pass --body-file <path>");
  }
  let text;
  try {
    text = readBodyFile(path);
  } catch (err) {
    throw new UnredactableBodyError(path, `could not read the body file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const masked = maskBody(text);
  return masked === text ? undefined : masked;
}
/**
 * Read a `--input` body file and return its masked JSON, or undefined when
 * there was nothing to mask (the `--input` reference is then left as it was).
 *
 * @throws UnredactableBodyError when the body cannot be read or safely masked.
 */ function maskedInputFile(path, readBodyFile, stdinScanned) {
  if (path === "-") {
    // See `maskedBodyFile`: scanned by the caller, so nothing to refuse.
    if (stdinScanned) return undefined;
    throw new UnredactableBodyError(path, "a request body read from stdin cannot be scanned for secrets — write " + "it to a file and pass --input <path>");
  }
  let text;
  try {
    text = readBodyFile(path);
  } catch (err) {
    throw new UnredactableBodyError(path, `could not read the --input body file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return maskedJsonBody(text);
}
/**
 * Mask the published-text keys of a JSON request body.
 *
 * Redacts the string values of {@link PUBLISHED_FIELD_KEYS} on the top-level
 * object, mirroring the `-f body=…` field rules. Returns the re-serialised
 * JSON when a value changed, or undefined when nothing needed masking. Fails
 * closed on a secret it cannot place structurally: a non-object body, or a
 * secret surviving in any field the key-scan does not cover — an unparseable
 * or off-field secret must never pass through unscanned.
 *
 * @throws UnredactableBodyError when the body hides a secret it cannot mask.
 */ function maskedJsonBody(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch  {
    return rawBodyFallback(text);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return rawBodyFallback(text);
  }
  const obj = doc;
  let changed = false;
  for (const key of Object.keys(obj)){
    const value = obj[key];
    if (PUBLISHED_FIELD_KEYS.has(key.toLowerCase()) && typeof value === "string") {
      const redacted = maskBody(value);
      if (redacted !== value) {
        obj[key] = redacted;
        changed = true;
      }
    }
  }
  const serialised = changed ? JSON.stringify(obj) : text;
  // A secret the key-scan could not reach — a non-body field, a nested value —
  // still survives here. Fail closed rather than publish it unscanned.
  if (maskBody(serialised) !== serialised) {
    throw new UnredactableBodyError("<input-body>", "the --input body carries a secret outside its redactable body " + "field(s) and cannot be safely masked — remove it or pass the body " + "inline with -f body=…");
  }
  return changed ? serialised : undefined;
}
/**
 * Handle an `--input` body that is not a JSON object: not something whose keys
 * can be redacted. Do not let unparseable mean unscanned — fail closed when a
 * secret is present, otherwise leave the reference untouched.
 *
 * @throws UnredactableBodyError when a non-object body contains a secret.
 */ function rawBodyFallback(text) {
  if (maskBody(text) !== text) {
    throw new UnredactableBodyError("<input-body>", "the --input body is not a JSON object and contains a secret, so it " + "cannot be safely masked — send a JSON object body or remove the " + "secret");
  }
  return undefined;
}
/**
 * Write a masked `--input` body to a fresh file and return its path, so the
 * agent's own file is never rewritten. Fails closed when no writer is supplied
 * — a body that needed masking must not be published from its original file.
 *
 * @throws UnredactableBodyError when masking was needed but no writer exists.
 */ function materialiseMaskedBody(content, writeBodyFile) {
  if (!writeBodyFile) {
    throw new UnredactableBodyError("<input-body>", "the --input body needed masking but no writer was supplied to " + "materialise the redacted copy");
  }
  return writeBodyFile(content);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9ib2R5X3JlZGFjdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlZGFjdGlvbiBvZiBgZ2hgIGJvZHkgYXJndW1lbnRzIGF0IHRoZSBzcGF3biBjaG9rZXBvaW50IChJc3N1ZSAjMzcwNykuXG4gKlxuICogQ29tbWVudCBhbmQgUFIgYm9kaWVzIGFyZSB0aGUgd29ya2VyJ3MgcHVibGljIHNpbmtzOiB3aGF0ZXZlciBpcyBwYXNzZWQgYXNcbiAqIGAtLWJvZHlgIChvciBgLWYgYm9keT3igKZgKSBpcyBwdWJsaXNoZWQgdG8gR2l0SHViLCBvZnRlbiBvbiBhIHB1YmxpYyByZXBvLlxuICogSW5kaXZpZHVhbCBjYWxsIHNpdGVzIHdlcmUgcmVkYWN0aW5nIGluY29uc2lzdGVudGx5IOKAlCBgbGFiZWxfZmFpbHVyZS50c2BcbiAqIG1hc2tlZCBpdHMgZmFpbHVyZSB0ZXh0LCB3aGlsZSB0aGUgdHdvIFBSLWNvbW1lbnQgZmFpbHVyZSByZXBsaWVzIGFuZCB0aGVcbiAqIHF1ZXN0aW9uLWZhaWx1cmUgY29tbWVudCBlbWJlZGRlZCBhcmJpdHJhcnkgdGV4dCB2ZXJiYXRpbSDigJQgc28gYSB0b2tlbiB0aGF0XG4gKiByZWFjaGVkIG9uZSBvZiB0aGUgdW5yZWRhY3RlZCBzaW5rcyB3YXMgcHVibGlzaGVkLlxuICpcbiAqIFJlZGFjdGluZyBwZXIgY2FsbCBzaXRlIGNhbm5vdCBob2xkOiBlYWNoIG5ldyBzaW5rIGhhcyB0byByZW1lbWJlci4gVGhpc1xuICogbW9kdWxlIG1hc2tzIHRoZSBwdWJsaXNoZWQtdGV4dCBhcmd1bWVudHMgb25jZSwgaW5zaWRlIGBzcGF3bkdoYCwgc28gZXZlcnlcbiAqIHByZXNlbnQgYW5kIGZ1dHVyZSBwdWJsaWMgc2luayBpbmhlcml0cyByZWRhY3Rpb24gYnkgY29uc3RydWN0aW9uLlxuICpcbiAqICoqVGl0bGVzIGFuZCBsYWJlbCBmaWVsZHMgKElzc3VlICMxMjgzKS4qKiBBIGJvZHkgd2FzIG5vdCB0aGUgb25seSBwdWJsaWNcbiAqIHNpbmsgcmVhY2hpbmcgdGhlIGNob2tlcG9pbnQ6IGAtLXRpdGxlYCwgYC1mIHRpdGxlPWAsIGAtZiBkZXNjcmlwdGlvbj1gIGFuZFxuICogYC1mIG5hbWU9YCBhcmUgcHVibGlzaGVkIGp1c3QgYXMgd2lkZWx5IOKAlCB+MzAgaXNzdWUtY3JlYXRlIHNpdGVzLFxuICogYGVkaXRJc3N1ZWAsIGBnaCBwciBjcmVhdGVgLCB0aGUgbWlsZXN0b25lIGFuZCBsYWJlbCBSRVNUIGNhbGxzIOKAlCBhbmQgdGhleVxuICogcGFzc2VkIHRocm91Z2ggYnl0ZS1mb3ItYnl0ZSwgd2hpY2ggaXMgd2h5IGByZWZpbmVtZW50X3Byb2Nlc3Nvci50c2AgYW5kXG4gKiBgcmV2aXNpb25fcHJvY2Vzc29yLnRzYCBoYW5kLXdyYXBwZWQgYHJlZGFjdFNlY3JldHNgIGFyb3VuZCBhIG5ldyB0aXRsZS4gVGhleVxuICogYXJlIG5vdyBjb3ZlcmVkIGhlcmUsIHNvIGEgdGl0bGUgaW5oZXJpdHMgcmVkYWN0aW9uIGxpa2UgYSBib2R5LlxuICpcbiAqIE9ubHkgcHVibGlzaGVkLXRleHQgYXJndW1lbnRzIGFyZSByZXdyaXR0ZW4uIFJvdXRpbmcgYXJndW1lbnRzIOKAlCB0aGUgcmVwb1xuICogc2x1ZywgdGhlIEFQSSBwYXRoLCBgLS1sYWJlbGAsIGAtLWhlYWRgLCByZWFjdGlvbiBmaWVsZHMg4oCUIGFyZSBsZWZ0XG4gKiBieXRlLWZvci1ieXRlIGFsb25lIHNvIGEgbXV0YXRpb24gaXMgbmV2ZXIgcmVkaXJlY3RlZCBieSByZWRhY3Rpb24uXG4gKlxuICogKipCb2RpZXMgcmVhZCBmcm9tIGEgZmlsZSAoSXNzdWUgIzM5MzgpLioqIFRoZSB3b3JrZXIgcHJvY2VzcyBpcyBub3QgdGhlIG9ubHlcbiAqIGNhbGxlciBvZiBgZ2hgOiB0aGUgYWdlbnQgc3VicHJvY2VzcyByZWFjaGVzIHRoZSBiaW5hcnkgdGhyb3VnaCB0aGUgUEFUSFxuICogc2hpbSwgYW5kIGl0cyBldmVyeWRheSBzcGVsbGluZyBpcyBgLS1ib2R5LWZpbGUgPHBhdGg+YCBhcyBvZnRlbiBhc1xuICogYC0tYm9keSA8dGV4dD5gLiBTdXBwbHkgYSB7QGxpbmsgQm9keUZpbGVSZWFkZXJ9IGFuZCB0aGUgZmlsZSdzIGNvbnRlbnRzIGFyZVxuICogc2Nhbm5lZCB0b28g4oCUIHdoZW4gYSBzZWNyZXQgaXMgZm91bmQgdGhlIGFyZ3VtZW50IGJlY29tZXMgYW4gaW5saW5lIGAtLWJvZHlgXG4gKiBjYXJyeWluZyB0aGUgbWFza2VkIHRleHQsIHNvIHRoZSBhZ2VudCdzIG93biBmaWxlIGlzIG5ldmVyIHJld3JpdHRlbi4gQSBib2R5XG4gKiB0aGF0IGNhbm5vdCBiZSBzY2FubmVkIGF0IGFsbCAoc3RkaW4sIGFuIHVucmVhZGFibGUgcGF0aCkgcmFpc2VzXG4gKiB7QGxpbmsgVW5yZWRhY3RhYmxlQm9keUVycm9yfSByYXRoZXIgdGhhbiBiZWluZyBwdWJsaXNoZWQgdW5zY2FubmVkLiBDYWxsZXJzXG4gKiB0aGF0IHBhc3Mgbm8gcmVhZGVyIGtlZXAgdGhlIGFyZ3Ytb25seSBiZWhhdmlvdXIuXG4gKlxuICogKipgZ2ggYXBpIC0taW5wdXQgPGZpbGU+YCBib2RpZXMgKElzc3VlICM5MikuKiogYGdoIGFwaSDigKYvY29tbWVudHMgLS1pbnB1dFxuICogYm9keS5qc29uYCBQT1NUcyB0aGUgZmlsZSdzIEpTT04gYXMgdGhlIHJlcXVlc3QgYm9keSDigJQgdGhlIHNhbWUgcHVibGljIHNpbmtcbiAqIGFzIGEgY29tbWVudCwgaW52aXNpYmxlIHRvIHRoZSBhcmd2LiBTdXBwbHkgYSByZWFkZXIgKHRvIHNjYW4pIGFuZCBhXG4gKiB7QGxpbmsgQm9keUZpbGVXcml0ZXJ9ICh0byBtYXRlcmlhbGlzZSBhIG1hc2tlZCBjb3B5KSBhbmQgdGhlXG4gKiB7QGxpbmsgUFVCTElTSEVEX0ZJRUxEX0tFWVN9IG9mIHRoZSBKU09OIGJvZHkgYXJlIHJlZGFjdGVkO1xuICogd2hlbiBzb21ldGhpbmcgaXMgbWFza2VkIHRoZSByZWRhY3RlZCBKU09OIGlzIHdyaXR0ZW4gdG8gYSAqZnJlc2gqIHRlbXAgZmlsZVxuICogYW5kIGAtLWlucHV0YCBpcyBwb2ludGVkIGF0IHRoYXQsIHNvIHRoZSBhZ2VudCdzIG93biBmaWxlIGlzIG5ldmVyIHJld3JpdHRlbi5cbiAqIEEgYm9keSB0aGF0IGlzIG5vdCBhIEpTT04gb2JqZWN0LCBvciB0aGF0IGhpZGVzIGEgc2VjcmV0IG91dHNpZGUgYSByZWRhY3RhYmxlXG4gKiBmaWVsZCwgcmFpc2VzIHtAbGluayBVbnJlZGFjdGFibGVCb2R5RXJyb3J9IHJhdGhlciB0aGFuIGJlaW5nIHB1Ymxpc2hlZFxuICogdW5zY2FubmVkIOKAlCB1bnBhcnNlYWJsZSBuZXZlciBtZWFucyB1bnNjYW5uZWQuXG4gKlxuICogKipCb2RpZXMgcGlwZWQgb24gc3RkaW4gKElzc3VlICMxMjU0KS4qKiBBIGAtYCBib2R5IHNvdXJjZSBpcyBpbnZpc2libGUgaGVyZTpcbiAqIHRoZSBieXRlcyBuZXZlciBhcHBlYXIgaW4gYXJndi4gSXQgdGhlcmVmb3JlIGZhaWxzIGNsb3NlZCDigJQgdW5sZXNzIHRoZSBjYWxsZXJcbiAqIGRlY2xhcmVzIGl0IHNjYW5zIHN0ZGluIGl0c2VsZiAoYHN0ZGluU2Nhbm5lZGApLCB3aGljaCBpcyB3aGF0IGBzcGF3bkdoYCBub3dcbiAqIGRvZXM6IGl0IG93bnMgdGhlIGJ5dGVzIGl0IHdyaXRlcyB0byB0aGUgY2hpbGQgYW5kIHB1dHMgdGhlbSB0aHJvdWdoXG4gKiBgcmVkYWN0U2VjcmV0c2AgYmVmb3JlIHRoZSB3cml0ZSwgc28gYGdoIGFwaSAtLWlucHV0IC1gIGlzIHNjYW5uZWQgcmF0aGVyXG4gKiB0aGFuIHJlZnVzZWQuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgQ1tcImNvbW1lbnQgLyBQUi1ib2R5IGNhbGwgc2l0ZXNcIl0gLS0+IFNbXCJzcGF3bkdoKClcIl1cbiAqICAgICBBW1wiYWdlbnQgZ2ggY2FsbHNcIl0gLS0+IEdbXCJnaCBndWFyZCBzaGltXCJdXG4gKiAgICAgUyAtLT4gUltcInJlZGFjdEdoQm9keUFyZ3MgKyByZWFkZXIvd3JpdGVyPGJyLz4oLS1ib2R5LCAtYiwgLS10aXRsZSwgLWYgYm9keT0vdGl0bGU94oCmLCAtLWJvZHktZmlsZSwgLS1pbnB1dClcIl1cbiAqICAgICBTIC0tPiBTVFtcInJlZGFjdFNlY3JldHMoc3RkaW4pPGJyLz4oLS1pbnB1dCAtIGJvZGllcylcIl1cbiAqICAgICBHIC0tPiBSMltcInJlZGFjdEdoQm9keUFyZ3MgKyByZWFkZXIvd3JpdGVyPGJyLz4oYXJndiwgLS1ib2R5LWZpbGUsIC0taW5wdXQpXCJdXG4gKiAgICAgUiAtLT4gR0hbXCJnaCBzdWJwcm9jZXNzIOKGkiBHaXRIdWJcIl1cbiAqICAgICBTVCAtLT4gR0hcbiAqICAgICBSMiAtLT4gR0hcbiAqIGBgYFxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IHJlZGFjdFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQgeyByZWRhY3RQcm9tcHRMZWFrYWdlIH0gZnJvbSBcIi4vcHJvbXB0X2xlYWtfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQge1xuICBidWlsZE1hc2tlZEluc3RydWN0aW9uTm90aWNlLFxuICBmaW5kTWFza2VkSW5zdHJ1Y3Rpb25zLFxufSBmcm9tIFwiLi9tYXNrZWRfaW5zdHJ1Y3Rpb25zLnRzXCI7XG5cbi8qKlxuICogVGhlIGZ1bGwgbWFzayBhcHBsaWVkIHRvIGV2ZXJ5IGJvZHkgdGhpcyBtb2R1bGUgdG91Y2hlcyAoSXNzdWUgIzE0MjEpLlxuICpcbiAqIGByZWRhY3RTZWNyZXRzYCBhbG9uZSB3YXMgdGhlIHdob2xlIG1hc2ssIHNvIHRoaXMgY2hva2Vwb2ludCDigJQgdGhlIG9uZVxuICogcGxhY2UgdGhlIG1vZHVsZSBkb2MgcHJvbWlzZXMgXCJldmVyeSBwcmVzZW50IGFuZCBmdXR1cmUgcHVibGljIHNpbmtcbiAqIGluaGVyaXRzIHJlZGFjdGlvbiBieSBjb25zdHJ1Y3Rpb25cIiDigJQgY2FycmllZCBubyBMTE0wNyBiYWNrc3RvcC4gUHJvbXB0XG4gKiBpbmplY3Rpb24gZHVyaW5nIGFuIG9yZGluYXJ5IHJ1biAoYHdvcmstb25gLCBgcGxhbm5pbmdgLCBgZ3JpbGwtbWVgLFxuICogYGNpX2ZpeGAsIHJldmlzaW9uKSBjb3VsZCBoYXZlIHRoZSBhZ2VudCBlY2hvIHRoZSBzeXN0ZW0gcHJvbXB0LCB0aGVcbiAqIGA8Y29kaW5nX2d1aWRlbGluZXM+YCBibG9jayBvciB0aGlzIHJ1bidzIGBCT1VOREFSWV88aWQ+YCBub25jZSBpbnRvIGFcbiAqIGNvbW1lbnQgb3IgUFIgYm9keSwgYW5kIG9ubHkgc2VjcmV0LVNIQVBFRCB0ZXh0IHdhcyBtYXNrZWQgb24gdGhlIHdheSBvdXQuXG4gKiBgcmVkYWN0UHJvbXB0TGVha2FnZWAgZXhpc3RlZCBmb3IgZXhhY3RseSB0aGF0IGFuZCBoYWQgb25lIGNhbGxlcixcbiAqIGBhbnN3ZXJfc2FuaXRpc2VyLnRzYCwgY292ZXJpbmcgb25seSB0aGUgcXVlc3Rpb24tYW5zd2VyaW5nIHBhdGguXG4gKlxuICogT3JkZXIgZm9sbG93cyBgYW5zd2VyX3Nhbml0aXNlci50czoxMDBgIOKAlCBwcm9tcHQtbGVhayBmaXJzdCwgc2VjcmV0c1xuICogc2Vjb25kLiAoVGhlIGlzc3VlIHRleHQgZGVzY3JpYmVzIHRoZSBvcHBvc2l0ZSBvcmRlcjsgdGhlIGNvZGUgaXMgdGhlXG4gKiBhdXRob3JpdHkuKSBXaG9sZS1ibG9jayBzY2FmZm9sZGluZyBpcyBjb2xsYXBzZWQgdG8gYSBwbGFjZWhvbGRlciBmaXJzdCxcbiAqIHRoZW4gdGhlIHNlY3JldCBwYXNzIHJ1bnMgb3ZlciB3aGF0IHJlbWFpbnMsIHNvIGEgdG9rZW4gaW5zaWRlIGEgYmxvY2tcbiAqIGNhbm5vdCBzdXJ2aXZlIGJ5IGJlaW5nIHJlbW92ZWQgZnJvbSB0aGUgc2VjcmV0IHBhc3MncyB2aWV3LlxuICpcbiAqIE9uZSBoZWxwZXIsIHVzZWQgYnkgZXZlcnkgYnJhbmNoLCBzbyBhIGJvZHktY2FycnlpbmcgYXJndW1lbnQgYWRkZWQgbGF0ZXJcbiAqIGNhbm5vdCBwaWNrIHVwIGhhbGYgdGhlIG1hc2suXG4gKi9cbmZ1bmN0aW9uIG1hc2tCb2R5KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiByZWRhY3RTZWNyZXRzKHJlZGFjdFByb21wdExlYWthZ2UodGV4dCkpO1xufVxuXG4vKipcbiAqIFRoZSBzYW1lIG1hc2ssIGZvciBhIGJvZHkgdGhhdCBpcyBub3QgYW4gYXJndiBlbGVtZW50IChJc3N1ZSAjMTQyMSkuXG4gKlxuICogYGdoIGFwaSAtLWlucHV0IC1gIHNlbmRzIGl0cyBib2R5IG9uIHN0ZGluLCB3aGljaCBuZXZlciBwYXNzZXMgdGhyb3VnaFxuICogYHJlZGFjdEdoQm9keUFyZ3NgIGJlY2F1c2UgdGhlcmUgaXMgbm8gYXJndW1lbnQgdG8gcmV3cml0ZS4gRXhwb3J0ZWQgc29cbiAqIGBzcGF3bkdoYCBjYW4gYXBwbHkgdGhlIGlkZW50aWNhbCBtYXNrIHRvIGBvcHRpb25zLnN0ZGluYCBhbmQgdGhlXG4gKiBjaG9rZXBvaW50J3MgZ3VhcmFudGVlIGNvdmVycyBib3RoIHJvdXRlcyByYXRoZXIgdGhhbiBvbmx5IHRoZSB2aXNpYmxlIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZGFjdEdoQm9keVRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1hc2tCb2R5KHRleHQpO1xufVxuXG4vKipcbiAqIEZsYWdzIHdob3NlIGZvbGxvd2luZyBhcmd1bWVudCBpcyBwdWJsaXNoZWQgdGV4dC5cbiAqXG4gKiBBIHRpdGxlIGFuZCBhIGxhYmVsL3JlcG8gZGVzY3JpcHRpb24gYXJlIHB1YmxpYyBzaW5rcyBleGFjdGx5IGxpa2UgYSBib2R5XG4gKiAoSXNzdWUgIzEyODMpLCBzbyBgLS10aXRsZWAgYW5kIGAtLWRlc2NyaXB0aW9uYCBqb2luIHRoZW0g4oCUIHRoZSBsYXR0ZXJcbiAqIGJlY2F1c2UgYGxhYmVsX29wZXJhdGlvbnMudHNgIHB1Ymxpc2hlcyB0aGUgc2FtZSB0ZXh0IHRocm91Z2ggdGhlIENMSVxuICogc3BlbGxpbmcgYXMgd2VsbCBhcyB0aHJvdWdoIGAtZiBkZXNjcmlwdGlvbj1gLlxuICovXG5jb25zdCBURVhUX0ZMQUdTID0gbmV3IFNldChbXCItLWJvZHlcIiwgXCItYlwiLCBcIi0tdGl0bGVcIiwgXCItLWRlc2NyaXB0aW9uXCJdKTtcblxuLyoqXG4gKiBgLXRgIGlzIGAtLXRpdGxlYCBvbiBgaXNzdWUgY3JlYXRlYCAvIGBwciBjcmVhdGVgIC8gYHJlbGVhc2UgY3JlYXRlYCwgYnV0XG4gKiBgLS10ZW1wbGF0ZWAgb24gYGdoIGFwaWAuIENvdmVyZWQgZXZlcnl3aGVyZSBleGNlcHQgYGdoIGFwaWAsIHNvIHRoZSBzaGltJ3NcbiAqIGV2ZXJ5ZGF5IGBnaCBpc3N1ZSBjcmVhdGUgLXQgXCI8dGl0bGU+XCJgIGlzIG1hc2tlZCB3aGlsZSBhIGBnaCBhcGlgIG91dHB1dFxuICogdGVtcGxhdGUgaXMgbmV2ZXIgcmV3cml0dGVuLlxuICovXG5jb25zdCBUSVRMRV9TSE9SVEhBTkQgPSBcIi10XCI7XG5cbi8qKiBTdWJjb21tYW5kIGZvciB3aGljaCB7QGxpbmsgVElUTEVfU0hPUlRIQU5EfSBtZWFucyBgLS10ZW1wbGF0ZWAgaW5zdGVhZC4gKi9cbmNvbnN0IFRFTVBMQVRFX1NVQkNPTU1BTkQgPSBcImFwaVwiO1xuXG4vKiogYC0tZmxhZz08dGV4dD5gIHNwZWxsaW5ncyB3aG9zZSB2YWx1ZSBpcyBwdWJsaXNoZWQgdGV4dC4gKi9cbmNvbnN0IFRFWFRfRkxBR19QUkVGSVhFUyA9IFtcIi0tYm9keT1cIiwgXCItLXRpdGxlPVwiLCBcIi0tZGVzY3JpcHRpb249XCJdO1xuXG4vKiogRmxhZ3Mgd2hvc2UgZm9sbG93aW5nIGFyZ3VtZW50IG5hbWVzIGEgZmlsZSBob2xkaW5nIHB1Ymxpc2hlZCB0ZXh0LiAqL1xuY29uc3QgQk9EWV9GSUxFX0ZMQUdTID0gbmV3IFNldChbXCItLWJvZHktZmlsZVwiLCBcIi1GXCJdKTtcblxuLyoqIEZsYWcgd2hvc2UgZm9sbG93aW5nIGFyZ3VtZW50IG5hbWVzIGEgZmlsZSBgZ2ggYXBpYCBzZW5kcyBhcyB0aGUgYm9keS4gKi9cbmNvbnN0IElOUFVUX0ZMQUdTID0gbmV3IFNldChbXCItLWlucHV0XCJdKTtcblxuLyoqIEZsYWdzIHRoYXQgY2FycnkgYSBga2V5PXZhbHVlYCBmaWVsZDsgb25seSB0aGVzZSBrZXlzIGFyZSBwdWJsaXNoZWQgdGV4dC4gKi9cbmNvbnN0IEZJRUxEX0ZMQUdTID0gbmV3IFNldChbXCItZlwiLCBcIi1GXCIsIFwiLS1maWVsZFwiLCBcIi0tcmF3LWZpZWxkXCJdKTtcblxuLyoqIEZpZWxkIGZsYWdzIHdob3NlIGBrZXk9QHBhdGhgIHZhbHVlIGlzIHJlYWQgZnJvbSBhIGZpbGUgYnkgYGdoYC4gKi9cbmNvbnN0IEZJRUxEX0ZJTEVfRkxBR1MgPSBuZXcgU2V0KFtcIi1GXCIsIFwiLS1maWVsZFwiXSk7XG5cbi8qKlxuICogYGtleT12YWx1ZWAga2V5cyB0aGF0IGVuZCB1cCBhcyBwdWJsaXNoZWQgdGV4dC5cbiAqXG4gKiBgdGl0bGVgLCBgZGVzY3JpcHRpb25gIGFuZCBgbmFtZWAgam9pbmVkIHRoZSBib2R5LXNoYXBlZCBrZXlzIGluIElzc3VlXG4gKiAjMTI4MzogYC1mIHRpdGxlPWAgY3JlYXRlcyBpc3N1ZXMsIFBScyBhbmQgbWlsZXN0b25lcywgYW5kIGAtZiBuYW1lPWAgL1xuICogYC1mIGRlc2NyaXB0aW9uPWAgY3JlYXRlIGxhYmVscyDigJQgZXZlcnkgb25lIG9mIHRoZW0gYSBwdWJsaWMgc2luay4gS2V5cyB0aGF0XG4gKiByb3V0ZSBhIG11dGF0aW9uIChgb3duZXJgLCBgaGVhZGAsIGBhc3NpZ25lZWAsIGEgcmVhY3Rpb24ncyBgY29udGVudGApIHN0YXlcbiAqIG9mZiB0aGlzIGxpc3Qgc28gcmVkYWN0aW9uIGNhbiBuZXZlciByZWRpcmVjdCBhIGNhbGwuXG4gKlxuICogYG5hbWVgIGlzIHRoZSBvbmUga2V5IHRoYXQgaXMgcHVibGlzaGVkIHRleHQgaW4gc29tZSBjYWxscyAoYSBsYWJlbCdzIG5hbWUpXG4gKiBhbmQgYSByb3V0aW5nIHZhcmlhYmxlIGluIG90aGVycyAoYGdoIGFwaSBncmFwaHFsIC1GIG5hbWU9PHJlcG8+YCkuIE1hc2tpbmdcbiAqIGlzIHNoYXBlLXNwZWNpZmljLCBzbyBhIHJlcG9zaXRvcnkgbmFtZSDigJQgd2hpY2ggY2Fubm90IG1hdGNoIGEgc2VjcmV0IHJ1bGUg4oCUXG4gKiBzdXJ2aXZlcyBieXRlLWZvci1ieXRlOyBvbmx5IGEgYG5hbWVgIHRoYXQgZ2VudWluZWx5IGxvb2tzIGxpa2UgYSBjcmVkZW50aWFsXG4gKiBpcyByZXdyaXR0ZW4sIGFuZCB0aGF0IGlzIGEgdmFsdWUgbm8gY2FsbCBzaG91bGQgYmUgc2VuZGluZy5cbiAqL1xuY29uc3QgUFVCTElTSEVEX0ZJRUxEX0tFWVMgPSBuZXcgU2V0KFtcbiAgXCJib2R5XCIsXG4gIFwibWVzc2FnZVwiLFxuICBcIm5vdGVcIixcbiAgXCJjb21tZW50XCIsXG4gIFwidGl0bGVcIixcbiAgXCJkZXNjcmlwdGlvblwiLFxuICBcIm5hbWVcIixcbl0pO1xuXG4vKipcbiAqIFJlYWRzIHRoZSBjb250ZW50cyBvZiBhIGAtLWJvZHktZmlsZWAgcGF0aC4gVGhyb3dzIHdoZW4gaXQgY2Fubm90LlxuICpcbiAqIEluamVjdGVkIHJhdGhlciB0aGFuIGNhbGxpbmcgYERlbm8ucmVhZFRleHRGaWxlKmAgZGlyZWN0bHkgc28gdGhlIHJlZGFjdGlvblxuICogc3RheXMgYSBwdXJlIGZ1bmN0aW9uIG9mIGl0cyBpbnB1dHMsIGFuZCBzbyB0aGUgd29ya2VyIGNob2tlcG9pbnQgY2FuIG9wdFxuICogb3V0IG9mIGZpbGUgcmVhZHMgYWx0b2dldGhlci5cbiAqL1xuZXhwb3J0IHR5cGUgQm9keUZpbGVSZWFkZXIgPSAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cbi8qKlxuICogV3JpdGVzIGBjb250ZW50YCB0byBhIGZyZXNoIGZpbGUgYW5kIHJldHVybnMgaXRzIHBhdGguIEluamVjdGVkIGZvciB0aGUgc2FtZVxuICogcmVhc29uIGFzIHtAbGluayBCb2R5RmlsZVJlYWRlcn06IGl0IGtlZXBzIHRoaXMgbW9kdWxlIGEgcHVyZSBmdW5jdGlvbiBvZiBpdHNcbiAqIGlucHV0cyAobm8gYERlbm9gIGNhbGxzKSBhbmQgbGV0cyB0aGUgY2FsbGVyIGRlY2lkZSB3aGVyZSB0aGUgbWFza2VkIGNvcHkgb2ZcbiAqIGEgYC0taW5wdXRgIGJvZHkgbGl2ZXMgKElzc3VlICM5MikuIFRoZSBhZ2VudCdzIG93biBmaWxlIGlzIG5ldmVyIHRvdWNoZWQg4oCUXG4gKiBhIHJlZGFjdGVkIGJvZHkgYWx3YXlzIGxhbmRzIGluIGEgbmV3IGZpbGUgdGhpcyB3cml0ZXIgY3JlYXRlcy5cbiAqL1xuZXhwb3J0IHR5cGUgQm9keUZpbGVXcml0ZXIgPSAoY29udGVudDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cbi8qKlxuICogQSBib2R5IGRlc3RpbmVkIGZvciBhIHB1YmxpYyBzaW5rIHRoYXQgY291bGQgbm90IGJlIHNjYW5uZWQgZm9yIHNlY3JldHMuXG4gKlxuICogUmFpc2VkIHJhdGhlciB0aGFuIHJldHVybmluZyB0aGUgYXJndW1lbnRzIHVuY2hhbmdlZDogYW4gdW5zY2FubmFibGUgYm9keSBpc1xuICogYSBmYWlsdXJlIG9mIHRoZSBjb250cm9sLCBhbmQgcHVibGlzaGluZyBpdCBhbnl3YXkgd291bGQgbWFzayB0aGF0IGZhaWx1cmVcbiAqIGFzIHN1Y2Nlc3MgKElzc3VlICMzMjM0KS5cbiAqL1xuZXhwb3J0IGNsYXNzIFVucmVkYWN0YWJsZUJvZHlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLyoqIFRoZSBib2R5IHNvdXJjZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkIChhIHBhdGgsIG9yIGAtYCBmb3Igc3RkaW4pLiAqL1xuICByZWFkb25seSBzb3VyY2U6IHN0cmluZztcblxuICBjb25zdHJ1Y3Rvcihzb3VyY2U6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJVbnJlZGFjdGFibGVCb2R5RXJyb3JcIjtcbiAgICB0aGlzLnNvdXJjZSA9IHNvdXJjZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZGFjdCBzZWNyZXRzIGZyb20gdGhlIHB1Ymxpc2hlZC10ZXh0IGFyZ3VtZW50cyBvZiBhIGBnaGAgaW52b2NhdGlvbiDigJRcbiAqIGJvZGllcywgdGl0bGVzLCBhbmQgdGhlIGxhYmVsL21pbGVzdG9uZSBmaWVsZHMgR2l0SHViIHJlbmRlcnMgcHVibGljbHkuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgYWJvdXQgdG8gYmUgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqIEBwYXJhbSByZWFkQm9keUZpbGUgLSBPcHRpb25hbCByZWFkZXI7IHN1cHBseWluZyBpdCBleHRlbmRzIHJlZGFjdGlvbiB0byB0aGVcbiAqICAgY29udGVudHMgb2YgYC0tYm9keS1maWxlYCAvIGAtRiA8cGF0aD5gIC8gYC1GIGtleT1AcGF0aGAgLyBgLS1pbnB1dGBcbiAqICAgYXJndW1lbnRzLlxuICogQHBhcmFtIHdyaXRlQm9keUZpbGUgLSBPcHRpb25hbCB3cml0ZXI7IG5lZWRlZCBvbmx5IHRvIG1hdGVyaWFsaXNlIGEgbWFza2VkXG4gKiAgIGNvcHkgb2YgYW4gYC0taW5wdXRgIGJvZHkuIFdoZW4gYW4gYC0taW5wdXRgIGJvZHkgbmVlZHMgbWFza2luZyBhbmQgbm9cbiAqICAgd3JpdGVyIGlzIHN1cHBsaWVkLCB0aGUgY2FsbCBmYWlscyBjbG9zZWQgcmF0aGVyIHRoYW4gcHVibGlzaCBpdC5cbiAqIEBwYXJhbSBzdGRpblNjYW5uZWQgLSBTZXQgYnkgYSBjYWxsZXIgdGhhdCBvd25zIHRoZSBieXRlcyBpdCBwaXBlcyB0byB0aGVcbiAqICAgY2hpbGQgYW5kIHJlZGFjdHMgdGhlbSBpdHNlbGYgKGBzcGF3bkdoYCwgSXNzdWUgIzEyNTQpLiBBIGAtYCBib2R5IHNvdXJjZVxuICogICBpcyB0aGVuIGdlbnVpbmVseSBzY2FubmVkLCBzbyBpdCBwYXNzZXMgdGhyb3VnaCBpbnN0ZWFkIG9mIGZhaWxpbmcgY2xvc2VkLlxuICogICBMZWF2ZSBpdCB1bnNldCB3aGVuZXZlciBzdGRpbiBpcyBvdXQgb2YgdGhlIGNhbGxlcidzIGhhbmRzIOKAlCB0aGUgcmVmdXNhbFxuICogICBpcyB3aGF0IHN0b3BzIGFuIHVuc2Nhbm5lZCBib2R5IGJlaW5nIHB1Ymxpc2hlZC5cbiAqIEByZXR1cm5zIEEgbmV3IGFycmF5IHdpdGggcHVibGlzaGVkLXRleHQgYXJndW1lbnRzIHJlZGFjdGVkOyBhbGwgb3RoZXJcbiAqICAgYXJndW1lbnRzIGFyZSByZXR1cm5lZCB1bmNoYW5nZWQuIEV2ZXJ5IGFyZ3VtZW50IGV4Y2VwdCBhIHJld3JpdHRlblxuICogICBgLS1pbnB1dGAgcGF0aCBpcyBsZWZ0IGJ5dGUtZm9yLWJ5dGUgYWxvbmUuXG4gKiBAdGhyb3dzIFVucmVkYWN0YWJsZUJvZHlFcnJvciB3aGVuIGEgYm9keSBzb3VyY2UgY2Fubm90IGJlIHNjYW5uZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWRhY3RHaEJvZHlBcmdzKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgcmVhZEJvZHlGaWxlPzogQm9keUZpbGVSZWFkZXIsXG4gIHdyaXRlQm9keUZpbGU/OiBCb2R5RmlsZVdyaXRlcixcbiAgc3RkaW5TY2FubmVkID0gZmFsc2UsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dCA9IFsuLi5hcmdzXTtcbiAgY29uc3QgdGl0bGVTaG9ydGhhbmRJc1RleHQgPSBvdXRbMF0gIT09IFRFTVBMQVRFX1NVQkNPTU1BTkQ7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXJnID0gb3V0W2ldID8/IFwiXCI7XG4gICAgY29uc3QgbmV4dCA9IG91dFtpICsgMV07XG5cbiAgICAvLyBgLS1ib2R5IDx0ZXh0PmAgLyBgLWIgPHRleHQ+YCAvIGAtLXRpdGxlIDx0ZXh0PmAgLyBgLXQgPHRleHQ+YFxuICAgIGNvbnN0IGlzVGV4dEZsYWcgPSBURVhUX0ZMQUdTLmhhcyhhcmcpIHx8XG4gICAgICAodGl0bGVTaG9ydGhhbmRJc1RleHQgJiYgYXJnID09PSBUSVRMRV9TSE9SVEhBTkQpO1xuICAgIGlmIChpc1RleHRGbGFnICYmIG5leHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgb3V0W2kgKyAxXSA9IG1hc2tCb2R5KG5leHQpO1xuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gYC0tYm9keT08dGV4dD5gIC8gYC0tdGl0bGU9PHRleHQ+YFxuICAgIGNvbnN0IHByZWZpeCA9IFRFWFRfRkxBR19QUkVGSVhFUy5maW5kKChwKSA9PiBhcmcuc3RhcnRzV2l0aChwKSk7XG4gICAgaWYgKHByZWZpeCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBvdXRbaV0gPSBgJHtwcmVmaXh9JHttYXNrQm9keShhcmcuc3Vic3RyaW5nKHByZWZpeC5sZW5ndGgpKX1gO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKHJlYWRCb2R5RmlsZSkge1xuICAgICAgLy8gYC0tYm9keS1maWxlIDxwYXRoPmAgLyBgLUYgPHBhdGg+YCDigJQgdGhlIGAtRmAgc3BlbGxpbmcgb25seSB3aGVuIHRoZVxuICAgICAgLy8gdmFsdWUgaXMgbm90IGEgYGtleT12YWx1ZWAgZmllbGQgKHRoYXQgZm9ybSBpcyBoYW5kbGVkIGJlbG93KS5cbiAgICAgIGlmIChcbiAgICAgICAgQk9EWV9GSUxFX0ZMQUdTLmhhcyhhcmcpICYmIG5leHQgIT09IHVuZGVmaW5lZCAmJiAhbmV4dC5pbmNsdWRlcyhcIj1cIilcbiAgICAgICkge1xuICAgICAgICBjb25zdCBtYXNrZWQgPSBtYXNrZWRCb2R5RmlsZShuZXh0LCByZWFkQm9keUZpbGUsIHN0ZGluU2Nhbm5lZCk7XG4gICAgICAgIGlmIChtYXNrZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIG91dFtpXSA9IFwiLS1ib2R5XCI7XG4gICAgICAgICAgb3V0W2kgKyAxXSA9IG1hc2tlZDtcbiAgICAgICAgfVxuICAgICAgICBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBgLS1ib2R5LWZpbGU9PHBhdGg+YFxuICAgICAgaWYgKGFyZy5zdGFydHNXaXRoKFwiLS1ib2R5LWZpbGU9XCIpKSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBhcmcuc3Vic3RyaW5nKFwiLS1ib2R5LWZpbGU9XCIubGVuZ3RoKTtcbiAgICAgICAgY29uc3QgbWFza2VkID0gbWFza2VkQm9keUZpbGUocGF0aCwgcmVhZEJvZHlGaWxlLCBzdGRpblNjYW5uZWQpO1xuICAgICAgICBpZiAobWFza2VkICE9PSB1bmRlZmluZWQpIG91dFtpXSA9IGAtLWJvZHk9JHttYXNrZWR9YDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIGAtLWlucHV0IDxwYXRoPmAg4oCUIGBnaCBhcGlgIFBPU1RzIHRoZSBmaWxlJ3MgSlNPTiBhcyB0aGUgcmVxdWVzdCBib2R5LlxuICAgICAgaWYgKElOUFVUX0ZMQUdTLmhhcyhhcmcpICYmIG5leHQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBtYXNrZWQgPSBtYXNrZWRJbnB1dEZpbGUobmV4dCwgcmVhZEJvZHlGaWxlLCBzdGRpblNjYW5uZWQpO1xuICAgICAgICBpZiAobWFza2VkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBvdXRbaSArIDFdID0gbWF0ZXJpYWxpc2VNYXNrZWRCb2R5KG1hc2tlZCwgd3JpdGVCb2R5RmlsZSk7XG4gICAgICAgIH1cbiAgICAgICAgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gYC0taW5wdXQ9PHBhdGg+YFxuICAgICAgaWYgKGFyZy5zdGFydHNXaXRoKFwiLS1pbnB1dD1cIikpIHtcbiAgICAgICAgY29uc3QgcGF0aCA9IGFyZy5zdWJzdHJpbmcoXCItLWlucHV0PVwiLmxlbmd0aCk7XG4gICAgICAgIGNvbnN0IG1hc2tlZCA9IG1hc2tlZElucHV0RmlsZShwYXRoLCByZWFkQm9keUZpbGUsIHN0ZGluU2Nhbm5lZCk7XG4gICAgICAgIGlmIChtYXNrZWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIG91dFtpXSA9IGAtLWlucHV0PSR7bWF0ZXJpYWxpc2VNYXNrZWRCb2R5KG1hc2tlZCwgd3JpdGVCb2R5RmlsZSl9YDtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBgLWYgYm9keT08dGV4dD5gIGFuZCBmcmllbmRzLlxuICAgIGlmIChGSUVMRF9GTEFHUy5oYXMoYXJnKSAmJiBuZXh0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIG91dFtpICsgMV0gPSByZWRhY3RGaWVsZEFzc2lnbm1lbnQoXG4gICAgICAgIG5leHQsXG4gICAgICAgIEZJRUxEX0ZJTEVfRkxBR1MuaGFzKGFyZykgPyByZWFkQm9keUZpbGUgOiB1bmRlZmluZWQsXG4gICAgICAgIHN0ZGluU2Nhbm5lZCxcbiAgICAgICk7XG4gICAgICBpKys7XG4gICAgfVxuICB9XG4gIGZsYWdNYXNrZWRJbnN0cnVjdGlvbk9uSXNzdWVDcmVhdGUob3V0KTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBTYXkgc28gd2hlbiBhbiBpc3N1ZSBpcyBhYm91dCB0byBiZSBmaWxlZCB3aXRoIGFuIHVucmVhZGFibGUgaW5zdHJ1Y3Rpb25cbiAqIChJc3N1ZSAjMjM5MCkuXG4gKlxuICogVGhlIG1hc2sgYWJvdmUgaXMgcmlnaHQgdG8gYmUgYmx1bnQsIGFuZCBhIGJsdW50IG1hc2sgaGFzIGZhbHNlIHBvc2l0aXZlczpcbiAqIGZvdXJ0ZWVuIGF1ZGl0IGlzc3VlcyB3ZXJlIHB1Ymxpc2hlZCByZWFkaW5nIFwiQWRkIGBwZXJzaXN0LWNyZWRlbnRpYWxzOlxuICogKioqUkVEQUNURUQqKipgXCIgYW5kIG5vYm9keSB3YXMgdG9sZC4gUmVmdXNpbmcgdG8gZmlsZSB3b3VsZCBsb3NlIHRoZVxuICogZmluZGluZywgYW5kIHVubWFza2luZyBpcyBuZXZlciBvbiB0aGUgdGFibGUsIHNvIHRoZSBpc3N1ZSBpcyBmaWxlZCAqKndpdGggYVxuICogdmlzaWJsZSBub3RpY2UqKiBuYW1pbmcgdGhlIG1hc2tlZCBsaW5lcywgYW5kIG9uZSBgW01BU0tFRF9JTlNUUlVDVElPTl9GSUxFRF1gXG4gKiBsaW5lIGlzIGxvZ2dlZCBzbyBhIGZhbHNlIHBvc2l0aXZlIGlzIGZpeGVkIGF0IGl0cyBzb3VyY2UuXG4gKlxuICogUnVucyBhZnRlciB0aGUgbG9vcCwgc28gaXQgc2VlcyB0aGUgYm9keSB3aGljaGV2ZXIgc3BlbGxpbmcgY2FycmllZCBpdCDigJRcbiAqIGV2ZXJ5IGAtLWJvZHktZmlsZWAgZm9ybSBoYXMgYWxyZWFkeSBiZWVuIHJld3JpdHRlbiB0byBgLS1ib2R5YCBieSB0aGVuLlxuICogT25seSBgZ2ggaXNzdWUgY3JlYXRlYDogYSBjb21tZW50IG9yIGEgUFIgYm9keSBpcyBub3QgYSBzZXQgb2YgaW5zdHJ1Y3Rpb25zXG4gKiB0aGUgZmxlZXQgd2lsbCBsYXRlciBiZSBoYW5kZWQuXG4gKi9cbmZ1bmN0aW9uIGZsYWdNYXNrZWRJbnN0cnVjdGlvbk9uSXNzdWVDcmVhdGUob3V0OiBzdHJpbmdbXSk6IHZvaWQge1xuICBpZiAob3V0WzBdICE9PSBcImlzc3VlXCIgfHwgb3V0WzFdICE9PSBcImNyZWF0ZVwiKSByZXR1cm47XG4gIGZvciAobGV0IGkgPSAyOyBpIDwgb3V0Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXJnID0gb3V0W2ldID8/IFwiXCI7XG4gICAgY29uc3QgaW5saW5lID0gYXJnLnN0YXJ0c1dpdGgoXCItLWJvZHk9XCIpO1xuICAgIGlmICghaW5saW5lICYmIGFyZyAhPT0gXCItLWJvZHlcIiAmJiBhcmcgIT09IFwiLWJcIikgY29udGludWU7XG4gICAgY29uc3QgYXQgPSBpbmxpbmUgPyBpIDogaSArIDE7XG4gICAgY29uc3QgYm9keSA9IGlubGluZSA/IGFyZy5zdWJzdHJpbmcoXCItLWJvZHk9XCIubGVuZ3RoKSA6IG91dFthdF07XG4gICAgaWYgKGJvZHkgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIGNvbnN0IGhpdHMgPSBmaW5kTWFza2VkSW5zdHJ1Y3Rpb25zKGJvZHkpO1xuICAgIGlmIChoaXRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICBgW01BU0tFRF9JTlNUUlVDVElPTl9GSUxFRF0gYW4gaXNzdWUgaXMgYmVpbmcgZmlsZWQgd2hvc2UgaW5zdHJ1Y3Rpb25zIGAgK1xuICAgICAgICBgY2FycnkgYSBtYXNrIHBsYWNlaG9sZGVyIChsaW5lICR7XG4gICAgICAgICAgaGl0cy5tYXAoKGgpID0+IGgubGluZSkuam9pbihcIiwgXCIpXG4gICAgICAgIH0pLiBJZiB0aGUgbWFza2VkIHZhbHVlIGlzIG5vdCBhIHNlY3JldCwgdGhlIHJlZGFjdGlvbiBydWxlIHRoYXQgYCArXG4gICAgICAgIGBtYXRjaGVkIGl0IGhhcyBhIGZhbHNlIHBvc2l0aXZlIOKAlCBmaXggdGhlIHJ1bGUuIFRoZSBpc3N1ZSBjYXJyaWVzIGEgYCArXG4gICAgICAgIGBub3RpY2UgYW5kIHRoZSBwaWNrdXAgcGF0aCB3aWxsIGFzayBmb3IgdGhlIHZhbHVlIChJc3N1ZSAjMjM5MCkuYCxcbiAgICApO1xuICAgIGNvbnN0IGZsYWdnZWQgPSBib2R5ICsgYnVpbGRNYXNrZWRJbnN0cnVjdGlvbk5vdGljZShoaXRzKTtcbiAgICBvdXRbYXRdID0gaW5saW5lID8gYC0tYm9keT0ke2ZsYWdnZWR9YCA6IGZsYWdnZWQ7XG4gICAgcmV0dXJuO1xuICB9XG59XG5cbi8qKiBSZWRhY3QgdGhlIHZhbHVlIG9mIGEgYGtleT12YWx1ZWAgZmllbGQgd2hlbiB0aGUga2V5IGlzIHB1Ymxpc2hlZCB0ZXh0LiAqL1xuZnVuY3Rpb24gcmVkYWN0RmllbGRBc3NpZ25tZW50KFxuICBmaWVsZDogc3RyaW5nLFxuICByZWFkQm9keUZpbGU/OiBCb2R5RmlsZVJlYWRlcixcbiAgc3RkaW5TY2FubmVkID0gZmFsc2UsXG4pOiBzdHJpbmcge1xuICBjb25zdCBlcSA9IGZpZWxkLmluZGV4T2YoXCI9XCIpO1xuICBpZiAoZXEgPD0gMCkgcmV0dXJuIGZpZWxkO1xuICBjb25zdCBrZXkgPSBmaWVsZC5zdWJzdHJpbmcoMCwgZXEpO1xuICBpZiAoIVBVQkxJU0hFRF9GSUVMRF9LRVlTLmhhcyhrZXkudG9Mb3dlckNhc2UoKSkpIHJldHVybiBmaWVsZDtcbiAgY29uc3QgdmFsdWUgPSBmaWVsZC5zdWJzdHJpbmcoZXEgKyAxKTtcblxuICAvLyBgLUYgYm9keT1AcGF0aGAg4oCUIGdoIHJlYWRzIHRoZSB2YWx1ZSBmcm9tIHRoZSBmaWxlLCBzbyBzY2FuIHRoZSBmaWxlLlxuICBpZiAocmVhZEJvZHlGaWxlICYmIHZhbHVlLnN0YXJ0c1dpdGgoXCJAXCIpKSB7XG4gICAgY29uc3QgbWFza2VkID0gbWFza2VkQm9keUZpbGUoXG4gICAgICB2YWx1ZS5zdWJzdHJpbmcoMSksXG4gICAgICByZWFkQm9keUZpbGUsXG4gICAgICBzdGRpblNjYW5uZWQsXG4gICAgKTtcbiAgICByZXR1cm4gbWFza2VkID09PSB1bmRlZmluZWQgPyBmaWVsZCA6IGAke2tleX09JHttYXNrZWR9YDtcbiAgfVxuXG4gIHJldHVybiBgJHtrZXl9PSR7bWFza0JvZHkodmFsdWUpfWA7XG59XG5cbi8qKlxuICogUmVhZCBhIGJvZHkgZmlsZSBhbmQgcmV0dXJuIGl0cyBtYXNrZWQgY29udGVudHMsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZXJlIHdhc1xuICogbm90aGluZyB0byBtYXNrIChpbiB3aGljaCBjYXNlIHRoZSBmaWxlIHJlZmVyZW5jZSBpcyBsZWZ0IGFzIGl0IHdhcykuXG4gKlxuICogQHRocm93cyBVbnJlZGFjdGFibGVCb2R5RXJyb3Igd2hlbiB0aGUgYm9keSBjYW5ub3QgYmUgcmVhZCBhdCBhbGwuXG4gKi9cbmZ1bmN0aW9uIG1hc2tlZEJvZHlGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIHJlYWRCb2R5RmlsZTogQm9keUZpbGVSZWFkZXIsXG4gIHN0ZGluU2Nhbm5lZDogYm9vbGVhbixcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmIChwYXRoID09PSBcIi1cIikge1xuICAgIC8vIFRoZSBjYWxsZXIgcGlwZXMg4oCUIGFuZCByZWRhY3RzIOKAlCB0aG9zZSBieXRlcyBpdHNlbGYgKElzc3VlICMxMjU0KSwgc29cbiAgICAvLyB0aGUgYm9keSBpcyBzY2FubmVkOyBvbmx5IGFuIHVuc2Nhbm5lZCBzdGRpbiBib2R5IGZhaWxzIGNsb3NlZC5cbiAgICBpZiAoc3RkaW5TY2FubmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVCb2R5RXJyb3IoXG4gICAgICBwYXRoLFxuICAgICAgXCJhIGJvZHkgcmVhZCBmcm9tIHN0ZGluIGNhbm5vdCBiZSBzY2FubmVkIGZvciBzZWNyZXRzIOKAlCB3cml0ZSBpdCB0byBhIFwiICtcbiAgICAgICAgXCJmaWxlIGFuZCBwYXNzIC0tYm9keS1maWxlIDxwYXRoPlwiLFxuICAgICk7XG4gIH1cbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0ZXh0ID0gcmVhZEJvZHlGaWxlKHBhdGgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0aHJvdyBuZXcgVW5yZWRhY3RhYmxlQm9keUVycm9yKFxuICAgICAgcGF0aCxcbiAgICAgIGBjb3VsZCBub3QgcmVhZCB0aGUgYm9keSBmaWxlICR7cGF0aH06ICR7XG4gICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBtYXNrZWQgPSBtYXNrQm9keSh0ZXh0KTtcbiAgcmV0dXJuIG1hc2tlZCA9PT0gdGV4dCA/IHVuZGVmaW5lZCA6IG1hc2tlZDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0taW5wdXRgIGJvZHkgZmlsZSBhbmQgcmV0dXJuIGl0cyBtYXNrZWQgSlNPTiwgb3IgdW5kZWZpbmVkIHdoZW5cbiAqIHRoZXJlIHdhcyBub3RoaW5nIHRvIG1hc2sgKHRoZSBgLS1pbnB1dGAgcmVmZXJlbmNlIGlzIHRoZW4gbGVmdCBhcyBpdCB3YXMpLlxuICpcbiAqIEB0aHJvd3MgVW5yZWRhY3RhYmxlQm9keUVycm9yIHdoZW4gdGhlIGJvZHkgY2Fubm90IGJlIHJlYWQgb3Igc2FmZWx5IG1hc2tlZC5cbiAqL1xuZnVuY3Rpb24gbWFza2VkSW5wdXRGaWxlKFxuICBwYXRoOiBzdHJpbmcsXG4gIHJlYWRCb2R5RmlsZTogQm9keUZpbGVSZWFkZXIsXG4gIHN0ZGluU2Nhbm5lZDogYm9vbGVhbixcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmIChwYXRoID09PSBcIi1cIikge1xuICAgIC8vIFNlZSBgbWFza2VkQm9keUZpbGVgOiBzY2FubmVkIGJ5IHRoZSBjYWxsZXIsIHNvIG5vdGhpbmcgdG8gcmVmdXNlLlxuICAgIGlmIChzdGRpblNjYW5uZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgdGhyb3cgbmV3IFVucmVkYWN0YWJsZUJvZHlFcnJvcihcbiAgICAgIHBhdGgsXG4gICAgICBcImEgcmVxdWVzdCBib2R5IHJlYWQgZnJvbSBzdGRpbiBjYW5ub3QgYmUgc2Nhbm5lZCBmb3Igc2VjcmV0cyDigJQgd3JpdGUgXCIgK1xuICAgICAgICBcIml0IHRvIGEgZmlsZSBhbmQgcGFzcyAtLWlucHV0IDxwYXRoPlwiLFxuICAgICk7XG4gIH1cbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0ZXh0ID0gcmVhZEJvZHlGaWxlKHBhdGgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0aHJvdyBuZXcgVW5yZWRhY3RhYmxlQm9keUVycm9yKFxuICAgICAgcGF0aCxcbiAgICAgIGBjb3VsZCBub3QgcmVhZCB0aGUgLS1pbnB1dCBib2R5IGZpbGUgJHtwYXRofTogJHtcbiAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiBtYXNrZWRKc29uQm9keSh0ZXh0KTtcbn1cblxuLyoqXG4gKiBNYXNrIHRoZSBwdWJsaXNoZWQtdGV4dCBrZXlzIG9mIGEgSlNPTiByZXF1ZXN0IGJvZHkuXG4gKlxuICogUmVkYWN0cyB0aGUgc3RyaW5nIHZhbHVlcyBvZiB7QGxpbmsgUFVCTElTSEVEX0ZJRUxEX0tFWVN9IG9uIHRoZSB0b3AtbGV2ZWxcbiAqIG9iamVjdCwgbWlycm9yaW5nIHRoZSBgLWYgYm9keT3igKZgIGZpZWxkIHJ1bGVzLiBSZXR1cm5zIHRoZSByZS1zZXJpYWxpc2VkXG4gKiBKU09OIHdoZW4gYSB2YWx1ZSBjaGFuZ2VkLCBvciB1bmRlZmluZWQgd2hlbiBub3RoaW5nIG5lZWRlZCBtYXNraW5nLiBGYWlsc1xuICogY2xvc2VkIG9uIGEgc2VjcmV0IGl0IGNhbm5vdCBwbGFjZSBzdHJ1Y3R1cmFsbHk6IGEgbm9uLW9iamVjdCBib2R5LCBvciBhXG4gKiBzZWNyZXQgc3Vydml2aW5nIGluIGFueSBmaWVsZCB0aGUga2V5LXNjYW4gZG9lcyBub3QgY292ZXIg4oCUIGFuIHVucGFyc2VhYmxlXG4gKiBvciBvZmYtZmllbGQgc2VjcmV0IG11c3QgbmV2ZXIgcGFzcyB0aHJvdWdoIHVuc2Nhbm5lZC5cbiAqXG4gKiBAdGhyb3dzIFVucmVkYWN0YWJsZUJvZHlFcnJvciB3aGVuIHRoZSBib2R5IGhpZGVzIGEgc2VjcmV0IGl0IGNhbm5vdCBtYXNrLlxuICovXG5mdW5jdGlvbiBtYXNrZWRKc29uQm9keSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBsZXQgZG9jOiB1bmtub3duO1xuICB0cnkge1xuICAgIGRvYyA9IEpTT04ucGFyc2UodGV4dCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiByYXdCb2R5RmFsbGJhY2sodGV4dCk7XG4gIH1cbiAgaWYgKGRvYyA9PT0gbnVsbCB8fCB0eXBlb2YgZG9jICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgIHJldHVybiByYXdCb2R5RmFsbGJhY2sodGV4dCk7XG4gIH1cbiAgY29uc3Qgb2JqID0gZG9jIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBsZXQgY2hhbmdlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhvYmopKSB7XG4gICAgY29uc3QgdmFsdWUgPSBvYmpba2V5XTtcbiAgICBpZiAoXG4gICAgICBQVUJMSVNIRURfRklFTERfS0VZUy5oYXMoa2V5LnRvTG93ZXJDYXNlKCkpICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIlxuICAgICkge1xuICAgICAgY29uc3QgcmVkYWN0ZWQgPSBtYXNrQm9keSh2YWx1ZSk7XG4gICAgICBpZiAocmVkYWN0ZWQgIT09IHZhbHVlKSB7XG4gICAgICAgIG9ialtrZXldID0gcmVkYWN0ZWQ7XG4gICAgICAgIGNoYW5nZWQgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBjb25zdCBzZXJpYWxpc2VkID0gY2hhbmdlZCA/IEpTT04uc3RyaW5naWZ5KG9iaikgOiB0ZXh0O1xuICAvLyBBIHNlY3JldCB0aGUga2V5LXNjYW4gY291bGQgbm90IHJlYWNoIOKAlCBhIG5vbi1ib2R5IGZpZWxkLCBhIG5lc3RlZCB2YWx1ZSDigJRcbiAgLy8gc3RpbGwgc3Vydml2ZXMgaGVyZS4gRmFpbCBjbG9zZWQgcmF0aGVyIHRoYW4gcHVibGlzaCBpdCB1bnNjYW5uZWQuXG4gIGlmIChtYXNrQm9keShzZXJpYWxpc2VkKSAhPT0gc2VyaWFsaXNlZCkge1xuICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVCb2R5RXJyb3IoXG4gICAgICBcIjxpbnB1dC1ib2R5PlwiLFxuICAgICAgXCJ0aGUgLS1pbnB1dCBib2R5IGNhcnJpZXMgYSBzZWNyZXQgb3V0c2lkZSBpdHMgcmVkYWN0YWJsZSBib2R5IFwiICtcbiAgICAgICAgXCJmaWVsZChzKSBhbmQgY2Fubm90IGJlIHNhZmVseSBtYXNrZWQg4oCUIHJlbW92ZSBpdCBvciBwYXNzIHRoZSBib2R5IFwiICtcbiAgICAgICAgXCJpbmxpbmUgd2l0aCAtZiBib2R5PeKAplwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGNoYW5nZWQgPyBzZXJpYWxpc2VkIDogdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEhhbmRsZSBhbiBgLS1pbnB1dGAgYm9keSB0aGF0IGlzIG5vdCBhIEpTT04gb2JqZWN0OiBub3Qgc29tZXRoaW5nIHdob3NlIGtleXNcbiAqIGNhbiBiZSByZWRhY3RlZC4gRG8gbm90IGxldCB1bnBhcnNlYWJsZSBtZWFuIHVuc2Nhbm5lZCDigJQgZmFpbCBjbG9zZWQgd2hlbiBhXG4gKiBzZWNyZXQgaXMgcHJlc2VudCwgb3RoZXJ3aXNlIGxlYXZlIHRoZSByZWZlcmVuY2UgdW50b3VjaGVkLlxuICpcbiAqIEB0aHJvd3MgVW5yZWRhY3RhYmxlQm9keUVycm9yIHdoZW4gYSBub24tb2JqZWN0IGJvZHkgY29udGFpbnMgYSBzZWNyZXQuXG4gKi9cbmZ1bmN0aW9uIHJhd0JvZHlGYWxsYmFjayh0ZXh0OiBzdHJpbmcpOiB1bmRlZmluZWQge1xuICBpZiAobWFza0JvZHkodGV4dCkgIT09IHRleHQpIHtcbiAgICB0aHJvdyBuZXcgVW5yZWRhY3RhYmxlQm9keUVycm9yKFxuICAgICAgXCI8aW5wdXQtYm9keT5cIixcbiAgICAgIFwidGhlIC0taW5wdXQgYm9keSBpcyBub3QgYSBKU09OIG9iamVjdCBhbmQgY29udGFpbnMgYSBzZWNyZXQsIHNvIGl0IFwiICtcbiAgICAgICAgXCJjYW5ub3QgYmUgc2FmZWx5IG1hc2tlZCDigJQgc2VuZCBhIEpTT04gb2JqZWN0IGJvZHkgb3IgcmVtb3ZlIHRoZSBcIiArXG4gICAgICAgIFwic2VjcmV0XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFdyaXRlIGEgbWFza2VkIGAtLWlucHV0YCBib2R5IHRvIGEgZnJlc2ggZmlsZSBhbmQgcmV0dXJuIGl0cyBwYXRoLCBzbyB0aGVcbiAqIGFnZW50J3Mgb3duIGZpbGUgaXMgbmV2ZXIgcmV3cml0dGVuLiBGYWlscyBjbG9zZWQgd2hlbiBubyB3cml0ZXIgaXMgc3VwcGxpZWRcbiAqIOKAlCBhIGJvZHkgdGhhdCBuZWVkZWQgbWFza2luZyBtdXN0IG5vdCBiZSBwdWJsaXNoZWQgZnJvbSBpdHMgb3JpZ2luYWwgZmlsZS5cbiAqXG4gKiBAdGhyb3dzIFVucmVkYWN0YWJsZUJvZHlFcnJvciB3aGVuIG1hc2tpbmcgd2FzIG5lZWRlZCBidXQgbm8gd3JpdGVyIGV4aXN0cy5cbiAqL1xuZnVuY3Rpb24gbWF0ZXJpYWxpc2VNYXNrZWRCb2R5KFxuICBjb250ZW50OiBzdHJpbmcsXG4gIHdyaXRlQm9keUZpbGU/OiBCb2R5RmlsZVdyaXRlcixcbik6IHN0cmluZyB7XG4gIGlmICghd3JpdGVCb2R5RmlsZSkge1xuICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVCb2R5RXJyb3IoXG4gICAgICBcIjxpbnB1dC1ib2R5PlwiLFxuICAgICAgXCJ0aGUgLS1pbnB1dCBib2R5IG5lZWRlZCBtYXNraW5nIGJ1dCBubyB3cml0ZXIgd2FzIHN1cHBsaWVkIHRvIFwiICtcbiAgICAgICAgXCJtYXRlcmlhbGlzZSB0aGUgcmVkYWN0ZWQgY29weVwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHdyaXRlQm9keUZpbGUoY29udGVudCk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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
// denoCacheMetadata=7116443561585439089,7111277962144398197