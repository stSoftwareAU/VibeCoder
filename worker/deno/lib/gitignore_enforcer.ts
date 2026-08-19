/**
 * `.gitignore` enforcement for monitored repositories (Issue #1757,
 * part of #1751).
 *
 * Mirrors the defence-in-depth pattern used in the Vibe Coder repo's own
 * `.gitignore`: ignore every hidden file by default, then re-allow a small
 * set of known-safe entries (`.gitignore`, `.github/`, `.vscode/`,
 * `.markdownlint-cli2.jsonc`, `.gitattributes`), plus belt-and-braces
 * patterns for `.config*.json`, `*.secret.json`, `.secrets/`, `.env`, and
 * `.env.*`, plus the non-hidden private-key and credential filenames the
 * `.*` rule cannot reach (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`,
 * `credentials.json`, `service-account*.json` — Issue #3660).
 *
 * `setup.sh` invokes `ensureGitignorePatterns()` once via the
 * `gitignore-sync` subcommand (Issue #1774) so that secret-bearing files
 * cannot accidentally be staged by the worker, even when the upstream
 * repo's own `.gitignore` is missing the protection. The per-iteration
 * `setupRepo()` no longer applies the patterns — running it on every
 * clone/update was redundant (the immediately-prior `git reset --hard
 * origin/<default>` wiped any uncommitted patterns anyway) and produced
 * the noisy `[setup-repo] gitignore: ...` log lines that motivated the
 * change. Defence-in-depth still relies on the pre-commit gate
 * (`pre_commit_safety.ts`) which runs on every commit.
 *
 * Idempotent: re-running on a repo that already contains the marked
 * block is a no-op (no duplicate lines, byte-identical output).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";

/** Marker comment that opens the Vibe Coder safety block. */
export const VIBE_CODER_BLOCK_MARKER =
  "# --- Vibe Coder safety patterns (Issue #1751) ---";

/** Marker comment that closes the Vibe Coder safety block. */
export const VIBE_CODER_BLOCK_END_MARKER =
  "# --- end Vibe Coder safety patterns ---";

/**
 * Canonical set of patterns every monitored repo's `.gitignore` must
 * contain. Order is significant — git evaluates ignore rules top-to-bottom,
 * so the broad `.*` ignore must precede the `!` re-allow rules.
 */
export const REQUIRED_GITIGNORE_PATTERNS: readonly string[] = [
  // Ignore every hidden file by default.
  ".*",
  // Re-allow known-safe hidden entries.
  "!.gitignore",
  "!.github",
  "!.vscode",
  "!.markdownlint-cli2.jsonc",
  "!.gitattributes",
  // Belt-and-braces explicit ignores for secret-bearing files.
  ".config.json",
  ".config*.json",
  "*.secret.json",
  ".secrets/",
  ".env",
  ".env.*",
  // Private key material and credential files (Issue #3660). None of these
  // begin with a dot, so the `.*` rule above does not cover them.
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "credentials.json",
  "service-account*.json",
];

/** Result of an enforcement pass. */
export interface EnsureGitignoreResult {
  /** Patterns that were missing and have just been appended. */
  added: string[];
  /** Patterns that were already present before the pass. */
  existed: string[];
}

/** Marker comment that opens the Vibe Coder `.gitattributes` block. */
export const VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER =
  "# --- Vibe Coder gitattributes line-ending pins (Issue #2332) ---";

/** Marker comment that closes the Vibe Coder `.gitattributes` block. */
export const VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER =
  "# --- end Vibe Coder gitattributes ---";

/**
 * Canonical set of `.gitattributes` lines every monitored repo should
 * contain. Pins line endings for cross-platform sanity (LF for the text
 * formats the worker generates, CRLF for Windows batch scripts) and marks
 * common binary assets so git does not attempt line-ending conversion on
 * them.
 *
 * Order mirrors git-attributes precedence: the broad `* text=auto`
 * fallback first, then the per-extension overrides, then binary markers.
 */
export const REQUIRED_GITATTRIBUTES_LINES: readonly string[] = [
  // Auto-detect text vs binary as the baseline.
  "* text=auto",
  // Pin LF for the text formats the worker generates and consumes.
  "*.sh text eol=lf",
  "*.bash text eol=lf",
  "*.py text eol=lf",
  "*.yaml text eol=lf",
  "*.yml text eol=lf",
  "*.json text eol=lf",
  // Windows batch scripts must keep CRLF.
  "*.bat text eol=crlf",
  "*.cmd text eol=crlf",
  // Binary asset markers — never line-ending convert these.
  "*.png binary",
  "*.jpg binary",
  "*.jpeg binary",
  "*.gif binary",
  "*.ico binary",
  "*.pdf binary",
  "*.zip binary",
  "*.gz binary",
  "*.tar binary",
  "*.woff binary",
  "*.woff2 binary",
  "*.ttf binary",
  "*.otf binary",
  "*.eot binary",
];

/** Result of a `.gitattributes` enforcement pass. */
export interface EnsureGitattributesResult {
  /** Lines that were missing and have just been appended. */
  added: string[];
  /** Lines that were already present before the pass. */
  existed: string[];
}

/**
 * Idempotently ensure every required pattern is present in the
 * `.gitignore` at the root of `repoPath`.
 *
 * Behaviour:
 *   1. Read the existing file (or treat as empty when missing).
 *   2. Classify each canonical pattern as already-present or missing.
 *   3. If any patterns are missing, append a marked block containing
 *      the missing patterns in their canonical order. Existing user
 *      content above and below is left untouched.
 *   4. Write the file back, creating it when necessary.
 *
 * Re-running on a fully-protected repo writes nothing and returns the
 * full pattern set in the `existed` field.
 *
 * @param repoPath Absolute path to the repository root.
 * @returns Result with the lists of added and pre-existing patterns.
 */
export async function ensureGitignorePatterns(
  repoPath: string,
): Promise<Result<EnsureGitignoreResult, Error>> {
  const gitignorePath = `${repoPath}/.gitignore`;

  let existing = "";
  try {
    existing = await Deno.readTextFile(gitignorePath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    // Missing file is fine — we'll create it below.
  }

  const presentLines = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  const added: string[] = [];
  const existed: string[] = [];
  for (const pattern of REQUIRED_GITIGNORE_PATTERNS) {
    if (presentLines.has(pattern)) {
      existed.push(pattern);
    } else {
      added.push(pattern);
    }
  }

  if (added.length === 0) {
    return { ok: true, value: { added, existed } };
  }

  // Build the appended block. Preserve trailing newline conventions: if the
  // existing content lacks a final newline, add one before the block so the
  // marker comment starts on its own line.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const blockLines = [
    "",
    VIBE_CODER_BLOCK_MARKER,
    ...added,
    VIBE_CODER_BLOCK_END_MARKER,
    "",
  ];
  const block = (needsLeadingNewline ? "\n" : "") + blockLines.join("\n");

  try {
    await Deno.writeTextFile(gitignorePath, existing + block);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return { ok: true, value: { added, existed } };
}

/**
 * Idempotently ensure every canonical `.gitattributes` line is present
 * at the root of `repoPath`.
 *
 * Behaviour mirrors {@link ensureGitignorePatterns}:
 *   1. Read the existing `.gitattributes` (or treat as empty when missing).
 *   2. Classify each canonical line as already-present or missing by
 *      full trimmed-line equality (so trailing whitespace or stray CR
 *      bytes from a CRLF host do not cause false negatives).
 *   3. If any lines are missing, append a marked block containing the
 *      missing lines. Existing user content above and below is left
 *      untouched (merge — never clobber a repo's own attribute rules).
 *   4. Write the file back with LF line endings, creating it when
 *      necessary.
 *
 * Re-running on a fully-protected repo writes nothing and returns the
 * full canonical set in the `existed` field.
 *
 * @param repoPath Absolute path to the repository root.
 * @returns Result with the lists of added and pre-existing lines.
 */
export async function ensureGitattributesPatterns(
  repoPath: string,
): Promise<Result<EnsureGitattributesResult, Error>> {
  const gitattributesPath = `${repoPath}/.gitattributes`;

  let existing = "";
  try {
    existing = await Deno.readTextFile(gitattributesPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    // Missing file is fine — we'll create it below.
  }

  // Classify by full trimmed-line equality. Trimming removes the trailing
  // `\r` from a CRLF-terminated line, so CRLF-saved attribute files are
  // not falsely treated as missing every canonical line.
  const presentLines = new Set(
    existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  const added: string[] = [];
  const existed: string[] = [];
  for (const line of REQUIRED_GITATTRIBUTES_LINES) {
    if (presentLines.has(line)) {
      existed.push(line);
    } else {
      added.push(line);
    }
  }

  if (added.length === 0) {
    return { ok: true, value: { added, existed } };
  }

  // Same trailing-newline handling as `ensureGitignorePatterns()`: ensure
  // the marker comment starts on its own line, and always emit LF so the
  // canonical block does not flip between LF and CRLF across host OSes.
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const blockLines = [
    "",
    VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER,
    ...added,
    VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER,
    "",
  ];
  const block = (needsLeadingNewline ? "\n" : "") + blockLines.join("\n");

  try {
    await Deno.writeTextFile(gitattributesPath, existing + block);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return { ok: true, value: { added, existed } };
}
