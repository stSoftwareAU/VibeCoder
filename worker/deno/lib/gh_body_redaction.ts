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
 * module masks the body-carrying arguments once, inside `spawnGh`, so every
 * present and future public sink inherits redaction by construction.
 *
 * Only body-carrying arguments are rewritten. Routing arguments — the repo
 * slug, the API path, `--label`, reaction fields — are left byte-for-byte
 * alone so a mutation is never redirected by redaction.
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
 * {@link BodyFileWriter} (to materialise a masked copy) and the published-text
 * keys of the JSON body (`body`, `message`, `note`, `comment`) are redacted;
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
 *     S --> R["redactGhBodyArgs + reader/writer<br/>(argv, --body-file, --input)"]
 *     S --> ST["redactSecrets(stdin)<br/>(--input - bodies)"]
 *     G --> R2["redactGhBodyArgs + reader/writer<br/>(argv, --body-file, --input)"]
 *     R --> GH["gh subprocess → GitHub"]
 *     ST --> GH
 *     R2 --> GH
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/** Flags whose following argument is published text. */
const BODY_FLAGS = new Set(["--body", "-b"]);

/** Flags whose following argument names a file holding published text. */
const BODY_FILE_FLAGS = new Set(["--body-file", "-F"]);

/** Flag whose following argument names a file `gh api` sends as the body. */
const INPUT_FLAGS = new Set(["--input"]);

/** Flags that carry a `key=value` field; only these keys are published text. */
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

/** Field flags whose `key=@path` value is read from a file by `gh`. */
const FIELD_FILE_FLAGS = new Set(["-F", "--field"]);

/** `key=value` keys that end up as published text. */
const BODY_FIELD_KEYS = new Set(["body", "message", "note", "comment"]);

/**
 * Reads the contents of a `--body-file` path. Throws when it cannot.
 *
 * Injected rather than calling `Deno.readTextFile*` directly so the redaction
 * stays a pure function of its inputs, and so the worker chokepoint can opt
 * out of file reads altogether.
 */
export type BodyFileReader = (path: string) => string;

/**
 * Writes `content` to a fresh file and returns its path. Injected for the same
 * reason as {@link BodyFileReader}: it keeps this module a pure function of its
 * inputs (no `Deno` calls) and lets the caller decide where the masked copy of
 * a `--input` body lives (Issue #92). The agent's own file is never touched —
 * a redacted body always lands in a new file this writer creates.
 */
export type BodyFileWriter = (content: string) => string;

/**
 * A body destined for a public sink that could not be scanned for secrets.
 *
 * Raised rather than returning the arguments unchanged: an unscannable body is
 * a failure of the control, and publishing it anyway would mask that failure
 * as success (Issue #3234).
 */
export class UnredactableBodyError extends Error {
  /** The body source that could not be read (a path, or `-` for stdin). */
  readonly source: string;

  constructor(source: string, message: string) {
    super(message);
    this.name = "UnredactableBodyError";
    this.source = source;
  }
}

/**
 * Redact secrets from the body-carrying arguments of a `gh` invocation.
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
 * @returns A new array with body arguments redacted; all other arguments are
 *   returned unchanged. Every argument except a rewritten `--input` path is
 *   left byte-for-byte alone.
 * @throws UnredactableBodyError when a body source cannot be scanned.
 */
export function redactGhBodyArgs(
  args: readonly string[],
  readBodyFile?: BodyFileReader,
  writeBodyFile?: BodyFileWriter,
  stdinScanned = false,
): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    const arg = out[i] ?? "";
    const next = out[i + 1];

    // `--body <text>` / `-b <text>`
    if (BODY_FLAGS.has(arg) && next !== undefined) {
      out[i + 1] = redactSecrets(next);
      i++;
      continue;
    }

    // `--body=<text>`
    if (arg.startsWith("--body=")) {
      out[i] = `--body=${redactSecrets(arg.substring("--body=".length))}`;
      continue;
    }

    if (readBodyFile) {
      // `--body-file <path>` / `-F <path>` — the `-F` spelling only when the
      // value is not a `key=value` field (that form is handled below).
      if (
        BODY_FILE_FLAGS.has(arg) && next !== undefined && !next.includes("=")
      ) {
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
      out[i + 1] = redactFieldAssignment(
        next,
        FIELD_FILE_FLAGS.has(arg) ? readBodyFile : undefined,
        stdinScanned,
      );
      i++;
    }
  }
  return out;
}

/** Redact the value of a `key=value` field when the key is published text. */
function redactFieldAssignment(
  field: string,
  readBodyFile?: BodyFileReader,
  stdinScanned = false,
): string {
  const eq = field.indexOf("=");
  if (eq <= 0) return field;
  const key = field.substring(0, eq);
  if (!BODY_FIELD_KEYS.has(key.toLowerCase())) return field;
  const value = field.substring(eq + 1);

  // `-F body=@path` — gh reads the value from the file, so scan the file.
  if (readBodyFile && value.startsWith("@")) {
    const masked = maskedBodyFile(
      value.substring(1),
      readBodyFile,
      stdinScanned,
    );
    return masked === undefined ? field : `${key}=${masked}`;
  }

  return `${key}=${redactSecrets(value)}`;
}

/**
 * Read a body file and return its masked contents, or undefined when there was
 * nothing to mask (in which case the file reference is left as it was).
 *
 * @throws UnredactableBodyError when the body cannot be read at all.
 */
function maskedBodyFile(
  path: string,
  readBodyFile: BodyFileReader,
  stdinScanned: boolean,
): string | undefined {
  if (path === "-") {
    // The caller pipes — and redacts — those bytes itself (Issue #1254), so
    // the body is scanned; only an unscanned stdin body fails closed.
    if (stdinScanned) return undefined;
    throw new UnredactableBodyError(
      path,
      "a body read from stdin cannot be scanned for secrets — write it to a " +
        "file and pass --body-file <path>",
    );
  }
  let text: string;
  try {
    text = readBodyFile(path);
  } catch (err) {
    throw new UnredactableBodyError(
      path,
      `could not read the body file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const masked = redactSecrets(text);
  return masked === text ? undefined : masked;
}

/**
 * Read a `--input` body file and return its masked JSON, or undefined when
 * there was nothing to mask (the `--input` reference is then left as it was).
 *
 * @throws UnredactableBodyError when the body cannot be read or safely masked.
 */
function maskedInputFile(
  path: string,
  readBodyFile: BodyFileReader,
  stdinScanned: boolean,
): string | undefined {
  if (path === "-") {
    // See `maskedBodyFile`: scanned by the caller, so nothing to refuse.
    if (stdinScanned) return undefined;
    throw new UnredactableBodyError(
      path,
      "a request body read from stdin cannot be scanned for secrets — write " +
        "it to a file and pass --input <path>",
    );
  }
  let text: string;
  try {
    text = readBodyFile(path);
  } catch (err) {
    throw new UnredactableBodyError(
      path,
      `could not read the --input body file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return maskedJsonBody(text);
}

/**
 * Mask the published-text keys of a JSON request body.
 *
 * Redacts the string values of {@link BODY_FIELD_KEYS} on the top-level
 * object, mirroring the `-f body=…` field rules. Returns the re-serialised
 * JSON when a value changed, or undefined when nothing needed masking. Fails
 * closed on a secret it cannot place structurally: a non-object body, or a
 * secret surviving in any field the key-scan does not cover — an unparseable
 * or off-field secret must never pass through unscanned.
 *
 * @throws UnredactableBodyError when the body hides a secret it cannot mask.
 */
function maskedJsonBody(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return rawBodyFallback(text);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return rawBodyFallback(text);
  }
  const obj = doc as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (BODY_FIELD_KEYS.has(key.toLowerCase()) && typeof value === "string") {
      const redacted = redactSecrets(value);
      if (redacted !== value) {
        obj[key] = redacted;
        changed = true;
      }
    }
  }
  const serialised = changed ? JSON.stringify(obj) : text;
  // A secret the key-scan could not reach — a non-body field, a nested value —
  // still survives here. Fail closed rather than publish it unscanned.
  if (redactSecrets(serialised) !== serialised) {
    throw new UnredactableBodyError(
      "<input-body>",
      "the --input body carries a secret outside its redactable body " +
        "field(s) and cannot be safely masked — remove it or pass the body " +
        "inline with -f body=…",
    );
  }
  return changed ? serialised : undefined;
}

/**
 * Handle an `--input` body that is not a JSON object: not something whose keys
 * can be redacted. Do not let unparseable mean unscanned — fail closed when a
 * secret is present, otherwise leave the reference untouched.
 *
 * @throws UnredactableBodyError when a non-object body contains a secret.
 */
function rawBodyFallback(text: string): undefined {
  if (redactSecrets(text) !== text) {
    throw new UnredactableBodyError(
      "<input-body>",
      "the --input body is not a JSON object and contains a secret, so it " +
        "cannot be safely masked — send a JSON object body or remove the " +
        "secret",
    );
  }
  return undefined;
}

/**
 * Write a masked `--input` body to a fresh file and return its path, so the
 * agent's own file is never rewritten. Fails closed when no writer is supplied
 * — a body that needed masking must not be published from its original file.
 *
 * @throws UnredactableBodyError when masking was needed but no writer exists.
 */
function materialiseMaskedBody(
  content: string,
  writeBodyFile?: BodyFileWriter,
): string {
  if (!writeBodyFile) {
    throw new UnredactableBodyError(
      "<input-body>",
      "the --input body needed masking but no writer was supplied to " +
        "materialise the redacted copy",
    );
  }
  return writeBodyFile(content);
}
