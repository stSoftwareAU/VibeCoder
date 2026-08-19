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
 * ```mermaid
 * flowchart LR
 *     C["comment / PR-body call sites"] --> S["spawnGh()"]
 *     A["agent gh calls"] --> G["gh guard shim"]
 *     S --> R["redactGhBodyArgs<br/>(--body, -b, -f body=…)"]
 *     G --> R2["redactGhBodyArgs + reader<br/>(also --body-file contents)"]
 *     R --> GH["gh subprocess → GitHub"]
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
 *   contents of `--body-file` / `-F <path>` / `-F key=@path` arguments.
 * @returns A new array with body arguments redacted; all other arguments are
 *   returned unchanged. The argument count is always preserved.
 * @throws UnredactableBodyError when a body source cannot be scanned.
 */
export function redactGhBodyArgs(
  args: readonly string[],
  readBodyFile?: BodyFileReader,
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
        const masked = maskedBodyFile(next, readBodyFile);
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
        const masked = maskedBodyFile(path, readBodyFile);
        if (masked !== undefined) out[i] = `--body=${masked}`;
        continue;
      }
    }

    // `-f body=<text>` and friends.
    if (FIELD_FLAGS.has(arg) && next !== undefined) {
      out[i + 1] = redactFieldAssignment(
        next,
        FIELD_FILE_FLAGS.has(arg) ? readBodyFile : undefined,
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
): string {
  const eq = field.indexOf("=");
  if (eq <= 0) return field;
  const key = field.substring(0, eq);
  if (!BODY_FIELD_KEYS.has(key.toLowerCase())) return field;
  const value = field.substring(eq + 1);

  // `-F body=@path` — gh reads the value from the file, so scan the file.
  if (readBodyFile && value.startsWith("@")) {
    const masked = maskedBodyFile(value.substring(1), readBodyFile);
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
): string | undefined {
  if (path === "-") {
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
