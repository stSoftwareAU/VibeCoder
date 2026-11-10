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
 * `credentials.json`, `service-account*.json` — Issue #3660), plus `/graft/`,
 * belt-and-braces cover for a *legacy* in-tree Graft code graph left behind
 * by an older worker build (Issue #2099). `graft_context.ts` now builds the
 * Graft index outside the working tree, under the git directory, precisely
 * so that repo-local lint/format tools which ignore git excludes (such as
 * `markdownlint-cli2`) never see it (Issue #2915); this pattern just keeps
 * any stale `graft/` directory a prior run left in place from being staged.
 * Also covers the CodeGraph index directory `/.codegraph/` (Issue #2155).
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
 * Link-free (Issue #1234): the clone is agent-writable and persists between
 * runs, so both files are read through `readTextFileNoFollow()` — a symlink,
 * hard link or non-regular target is refused with an error rather than read
 * and rewritten — and written through `atomicWrite()`, whose rename never
 * follows a link swapped in after the read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { atomicWrite, readTextFileNoFollow } from "./file_utils.ts";
/**
 * Mode for the repo files this module writes. Both are ordinary tracked repo
 * files, so they stay world-readable — unlike the 0600 state files
 * {@link atomicWrite} defaults to.
 */ const REPO_FILE_MODE = 0o644;
/** Marker comment that opens the Vibe Coder safety block. */ export const VIBE_CODER_BLOCK_MARKER = "# --- Vibe Coder safety patterns (Issue #1751) ---";
/** Marker comment that closes the Vibe Coder safety block. */ export const VIBE_CODER_BLOCK_END_MARKER = "# --- end Vibe Coder safety patterns ---";
/**
 * Canonical set of patterns every monitored repo's `.gitignore` must
 * contain. Order is significant — git evaluates ignore rules top-to-bottom,
 * so the broad `.*` ignore must precede the `!` re-allow rules.
 */ export const REQUIRED_GITIGNORE_PATTERNS = [
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
  // Graft's code graph — a per-run build artefact, never committed (#2099).
  "/graft/",
  // The CodeGraph index (Issue #2155): kept between runs, never committed.
  "/.codegraph/"
];
/** Marker comment that opens the Vibe Coder `.gitattributes` block. */ export const VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER = "# --- Vibe Coder gitattributes line-ending pins (Issue #2332) ---";
/** Marker comment that closes the Vibe Coder `.gitattributes` block. */ export const VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER = "# --- end Vibe Coder gitattributes ---";
/**
 * Canonical set of `.gitattributes` lines every monitored repo should
 * contain. Pins line endings for cross-platform sanity (LF for the text
 * formats the worker generates, CRLF for Windows batch scripts) and marks
 * common binary assets so git does not attempt line-ending conversion on
 * them.
 *
 * Order mirrors git-attributes precedence: the broad `* text=auto`
 * fallback first, then the per-extension overrides, then binary markers.
 */ export const REQUIRED_GITATTRIBUTES_LINES = [
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
  "*.eot binary"
];
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
 */ export async function ensureGitignorePatterns(repoPath) {
  const gitignorePath = `${repoPath}/.gitignore`;
  // Read link-free: `repoPath` is an agent-writable clone, so a planted
  // `.gitignore` symlink would otherwise be read through — and the
  // read-modify-write below would copy the link target's content into the
  // file it writes back (Issue #1234).
  const read = await readTextFileNoFollow(gitignorePath);
  if (!read.ok) return {
    ok: false,
    error: read.error
  };
  // Missing file is fine — we'll create it below.
  const existing = read.value ?? "";
  const presentLines = new Set(existing.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0 && !line.startsWith("#")));
  const added = [];
  const existed = [];
  for (const pattern of REQUIRED_GITIGNORE_PATTERNS){
    if (presentLines.has(pattern)) {
      existed.push(pattern);
    } else {
      added.push(pattern);
    }
  }
  if (added.length === 0) {
    return {
      ok: true,
      value: {
        added,
        existed
      }
    };
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
    ""
  ];
  const block = (needsLeadingNewline ? "\n" : "") + blockLines.join("\n");
  // Replace by atomic rename rather than writing in place: rename never
  // follows a link, so a link swapped in after the read is displaced, not
  // written through.
  const written = await atomicWrite({
    targetFile: gitignorePath,
    content: existing + block,
    mode: REPO_FILE_MODE
  });
  if (!written.ok) return {
    ok: false,
    error: written.error
  };
  return {
    ok: true,
    value: {
      added,
      existed
    }
  };
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
 */ export async function ensureGitattributesPatterns(repoPath) {
  const gitattributesPath = `${repoPath}/.gitattributes`;
  // Same link-free read as `ensureGitignorePatterns()` (Issue #1234).
  const read = await readTextFileNoFollow(gitattributesPath);
  if (!read.ok) return {
    ok: false,
    error: read.error
  };
  // Missing file is fine — we'll create it below.
  const existing = read.value ?? "";
  // Classify by full trimmed-line equality. Trimming removes the trailing
  // `\r` from a CRLF-terminated line, so CRLF-saved attribute files are
  // not falsely treated as missing every canonical line.
  const presentLines = new Set(existing.split("\n").map((line)=>line.trim()).filter((line)=>line.length > 0 && !line.startsWith("#")));
  const added = [];
  const existed = [];
  for (const line of REQUIRED_GITATTRIBUTES_LINES){
    if (presentLines.has(line)) {
      existed.push(line);
    } else {
      added.push(line);
    }
  }
  if (added.length === 0) {
    return {
      ok: true,
      value: {
        added,
        existed
      }
    };
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
    ""
  ];
  const block = (needsLeadingNewline ? "\n" : "") + blockLines.join("\n");
  // Replace by atomic rename rather than writing in place: rename never
  // follows a link, so a link swapped in after the read is displaced, not
  // written through.
  const written = await atomicWrite({
    targetFile: gitattributesPath,
    content: existing + block,
    mode: REPO_FILE_MODE
  });
  if (!written.ok) return {
    ok: false,
    error: written.error
  };
  return {
    ok: true,
    value: {
      added,
      existed
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRpZ25vcmVfZW5mb3JjZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBgLmdpdGlnbm9yZWAgZW5mb3JjZW1lbnQgZm9yIG1vbml0b3JlZCByZXBvc2l0b3JpZXMgKElzc3VlICMxNzU3LFxuICogcGFydCBvZiAjMTc1MSkuXG4gKlxuICogTWlycm9ycyB0aGUgZGVmZW5jZS1pbi1kZXB0aCBwYXR0ZXJuIHVzZWQgaW4gdGhlIFZpYmUgQ29kZXIgcmVwbydzIG93blxuICogYC5naXRpZ25vcmVgOiBpZ25vcmUgZXZlcnkgaGlkZGVuIGZpbGUgYnkgZGVmYXVsdCwgdGhlbiByZS1hbGxvdyBhIHNtYWxsXG4gKiBzZXQgb2Yga25vd24tc2FmZSBlbnRyaWVzIChgLmdpdGlnbm9yZWAsIGAuZ2l0aHViL2AsIGAudnNjb2RlL2AsXG4gKiBgLm1hcmtkb3dubGludC1jbGkyLmpzb25jYCwgYC5naXRhdHRyaWJ1dGVzYCksIHBsdXMgYmVsdC1hbmQtYnJhY2VzXG4gKiBwYXR0ZXJucyBmb3IgYC5jb25maWcqLmpzb25gLCBgKi5zZWNyZXQuanNvbmAsIGAuc2VjcmV0cy9gLCBgLmVudmAsIGFuZFxuICogYC5lbnYuKmAsIHBsdXMgdGhlIG5vbi1oaWRkZW4gcHJpdmF0ZS1rZXkgYW5kIGNyZWRlbnRpYWwgZmlsZW5hbWVzIHRoZVxuICogYC4qYCBydWxlIGNhbm5vdCByZWFjaCAoYCoucGVtYCwgYCoua2V5YCwgYCoucDEyYCwgYCoucGZ4YCwgYGlkX3JzYWAsXG4gKiBgY3JlZGVudGlhbHMuanNvbmAsIGBzZXJ2aWNlLWFjY291bnQqLmpzb25gIOKAlCBJc3N1ZSAjMzY2MCksIHBsdXMgYC9ncmFmdC9gLFxuICogYmVsdC1hbmQtYnJhY2VzIGNvdmVyIGZvciBhICpsZWdhY3kqIGluLXRyZWUgR3JhZnQgY29kZSBncmFwaCBsZWZ0IGJlaGluZFxuICogYnkgYW4gb2xkZXIgd29ya2VyIGJ1aWxkIChJc3N1ZSAjMjA5OSkuIGBncmFmdF9jb250ZXh0LnRzYCBub3cgYnVpbGRzIHRoZVxuICogR3JhZnQgaW5kZXggb3V0c2lkZSB0aGUgd29ya2luZyB0cmVlLCB1bmRlciB0aGUgZ2l0IGRpcmVjdG9yeSwgcHJlY2lzZWx5XG4gKiBzbyB0aGF0IHJlcG8tbG9jYWwgbGludC9mb3JtYXQgdG9vbHMgd2hpY2ggaWdub3JlIGdpdCBleGNsdWRlcyAoc3VjaCBhc1xuICogYG1hcmtkb3dubGludC1jbGkyYCkgbmV2ZXIgc2VlIGl0IChJc3N1ZSAjMjkxNSk7IHRoaXMgcGF0dGVybiBqdXN0IGtlZXBzXG4gKiBhbnkgc3RhbGUgYGdyYWZ0L2AgZGlyZWN0b3J5IGEgcHJpb3IgcnVuIGxlZnQgaW4gcGxhY2UgZnJvbSBiZWluZyBzdGFnZWQuXG4gKiBBbHNvIGNvdmVycyB0aGUgQ29kZUdyYXBoIGluZGV4IGRpcmVjdG9yeSBgLy5jb2RlZ3JhcGgvYCAoSXNzdWUgIzIxNTUpLlxuICpcbiAqIGBzZXR1cC5zaGAgaW52b2tlcyBgZW5zdXJlR2l0aWdub3JlUGF0dGVybnMoKWAgb25jZSB2aWEgdGhlXG4gKiBgZ2l0aWdub3JlLXN5bmNgIHN1YmNvbW1hbmQgKElzc3VlICMxNzc0KSBzbyB0aGF0IHNlY3JldC1iZWFyaW5nIGZpbGVzXG4gKiBjYW5ub3QgYWNjaWRlbnRhbGx5IGJlIHN0YWdlZCBieSB0aGUgd29ya2VyLCBldmVuIHdoZW4gdGhlIHVwc3RyZWFtXG4gKiByZXBvJ3Mgb3duIGAuZ2l0aWdub3JlYCBpcyBtaXNzaW5nIHRoZSBwcm90ZWN0aW9uLiBUaGUgcGVyLWl0ZXJhdGlvblxuICogYHNldHVwUmVwbygpYCBubyBsb25nZXIgYXBwbGllcyB0aGUgcGF0dGVybnMg4oCUIHJ1bm5pbmcgaXQgb24gZXZlcnlcbiAqIGNsb25lL3VwZGF0ZSB3YXMgcmVkdW5kYW50ICh0aGUgaW1tZWRpYXRlbHktcHJpb3IgYGdpdCByZXNldCAtLWhhcmRcbiAqIG9yaWdpbi88ZGVmYXVsdD5gIHdpcGVkIGFueSB1bmNvbW1pdHRlZCBwYXR0ZXJucyBhbnl3YXkpIGFuZCBwcm9kdWNlZFxuICogdGhlIG5vaXN5IGBbc2V0dXAtcmVwb10gZ2l0aWdub3JlOiAuLi5gIGxvZyBsaW5lcyB0aGF0IG1vdGl2YXRlZCB0aGVcbiAqIGNoYW5nZS4gRGVmZW5jZS1pbi1kZXB0aCBzdGlsbCByZWxpZXMgb24gdGhlIHByZS1jb21taXQgZ2F0ZVxuICogKGBwcmVfY29tbWl0X3NhZmV0eS50c2ApIHdoaWNoIHJ1bnMgb24gZXZlcnkgY29tbWl0LlxuICpcbiAqIElkZW1wb3RlbnQ6IHJlLXJ1bm5pbmcgb24gYSByZXBvIHRoYXQgYWxyZWFkeSBjb250YWlucyB0aGUgbWFya2VkXG4gKiBibG9jayBpcyBhIG5vLW9wIChubyBkdXBsaWNhdGUgbGluZXMsIGJ5dGUtaWRlbnRpY2FsIG91dHB1dCkuXG4gKlxuICogTGluay1mcmVlIChJc3N1ZSAjMTIzNCk6IHRoZSBjbG9uZSBpcyBhZ2VudC13cml0YWJsZSBhbmQgcGVyc2lzdHMgYmV0d2VlblxuICogcnVucywgc28gYm90aCBmaWxlcyBhcmUgcmVhZCB0aHJvdWdoIGByZWFkVGV4dEZpbGVOb0ZvbGxvdygpYCDigJQgYSBzeW1saW5rLFxuICogaGFyZCBsaW5rIG9yIG5vbi1yZWd1bGFyIHRhcmdldCBpcyByZWZ1c2VkIHdpdGggYW4gZXJyb3IgcmF0aGVyIHRoYW4gcmVhZFxuICogYW5kIHJld3JpdHRlbiDigJQgYW5kIHdyaXR0ZW4gdGhyb3VnaCBgYXRvbWljV3JpdGUoKWAsIHdob3NlIHJlbmFtZSBuZXZlclxuICogZm9sbG93cyBhIGxpbmsgc3dhcHBlZCBpbiBhZnRlciB0aGUgcmVhZC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGUsIHJlYWRUZXh0RmlsZU5vRm9sbG93IH0gZnJvbSBcIi4vZmlsZV91dGlscy50c1wiO1xuXG4vKipcbiAqIE1vZGUgZm9yIHRoZSByZXBvIGZpbGVzIHRoaXMgbW9kdWxlIHdyaXRlcy4gQm90aCBhcmUgb3JkaW5hcnkgdHJhY2tlZCByZXBvXG4gKiBmaWxlcywgc28gdGhleSBzdGF5IHdvcmxkLXJlYWRhYmxlIOKAlCB1bmxpa2UgdGhlIDA2MDAgc3RhdGUgZmlsZXNcbiAqIHtAbGluayBhdG9taWNXcml0ZX0gZGVmYXVsdHMgdG8uXG4gKi9cbmNvbnN0IFJFUE9fRklMRV9NT0RFID0gMG82NDQ7XG5cbi8qKiBNYXJrZXIgY29tbWVudCB0aGF0IG9wZW5zIHRoZSBWaWJlIENvZGVyIHNhZmV0eSBibG9jay4gKi9cbmV4cG9ydCBjb25zdCBWSUJFX0NPREVSX0JMT0NLX01BUktFUiA9XG4gIFwiIyAtLS0gVmliZSBDb2RlciBzYWZldHkgcGF0dGVybnMgKElzc3VlICMxNzUxKSAtLS1cIjtcblxuLyoqIE1hcmtlciBjb21tZW50IHRoYXQgY2xvc2VzIHRoZSBWaWJlIENvZGVyIHNhZmV0eSBibG9jay4gKi9cbmV4cG9ydCBjb25zdCBWSUJFX0NPREVSX0JMT0NLX0VORF9NQVJLRVIgPVxuICBcIiMgLS0tIGVuZCBWaWJlIENvZGVyIHNhZmV0eSBwYXR0ZXJucyAtLS1cIjtcblxuLyoqXG4gKiBDYW5vbmljYWwgc2V0IG9mIHBhdHRlcm5zIGV2ZXJ5IG1vbml0b3JlZCByZXBvJ3MgYC5naXRpZ25vcmVgIG11c3RcbiAqIGNvbnRhaW4uIE9yZGVyIGlzIHNpZ25pZmljYW50IOKAlCBnaXQgZXZhbHVhdGVzIGlnbm9yZSBydWxlcyB0b3AtdG8tYm90dG9tLFxuICogc28gdGhlIGJyb2FkIGAuKmAgaWdub3JlIG11c3QgcHJlY2VkZSB0aGUgYCFgIHJlLWFsbG93IHJ1bGVzLlxuICovXG5leHBvcnQgY29uc3QgUkVRVUlSRURfR0lUSUdOT1JFX1BBVFRFUk5TOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgLy8gSWdub3JlIGV2ZXJ5IGhpZGRlbiBmaWxlIGJ5IGRlZmF1bHQuXG4gIFwiLipcIixcbiAgLy8gUmUtYWxsb3cga25vd24tc2FmZSBoaWRkZW4gZW50cmllcy5cbiAgXCIhLmdpdGlnbm9yZVwiLFxuICBcIiEuZ2l0aHViXCIsXG4gIFwiIS52c2NvZGVcIixcbiAgXCIhLm1hcmtkb3dubGludC1jbGkyLmpzb25jXCIsXG4gIFwiIS5naXRhdHRyaWJ1dGVzXCIsXG4gIC8vIEJlbHQtYW5kLWJyYWNlcyBleHBsaWNpdCBpZ25vcmVzIGZvciBzZWNyZXQtYmVhcmluZyBmaWxlcy5cbiAgXCIuY29uZmlnLmpzb25cIixcbiAgXCIuY29uZmlnKi5qc29uXCIsXG4gIFwiKi5zZWNyZXQuanNvblwiLFxuICBcIi5zZWNyZXRzL1wiLFxuICBcIi5lbnZcIixcbiAgXCIuZW52LipcIixcbiAgLy8gUHJpdmF0ZSBrZXkgbWF0ZXJpYWwgYW5kIGNyZWRlbnRpYWwgZmlsZXMgKElzc3VlICMzNjYwKS4gTm9uZSBvZiB0aGVzZVxuICAvLyBiZWdpbiB3aXRoIGEgZG90LCBzbyB0aGUgYC4qYCBydWxlIGFib3ZlIGRvZXMgbm90IGNvdmVyIHRoZW0uXG4gIFwiKi5wZW1cIixcbiAgXCIqLmtleVwiLFxuICBcIioucDEyXCIsXG4gIFwiKi5wZnhcIixcbiAgXCJpZF9yc2FcIixcbiAgXCJpZF9yc2EuKlwiLFxuICBcImNyZWRlbnRpYWxzLmpzb25cIixcbiAgXCJzZXJ2aWNlLWFjY291bnQqLmpzb25cIixcbiAgLy8gR3JhZnQncyBjb2RlIGdyYXBoIOKAlCBhIHBlci1ydW4gYnVpbGQgYXJ0ZWZhY3QsIG5ldmVyIGNvbW1pdHRlZCAoIzIwOTkpLlxuICBcIi9ncmFmdC9cIixcbiAgLy8gVGhlIENvZGVHcmFwaCBpbmRleCAoSXNzdWUgIzIxNTUpOiBrZXB0IGJldHdlZW4gcnVucywgbmV2ZXIgY29tbWl0dGVkLlxuICBcIi8uY29kZWdyYXBoL1wiLFxuXTtcblxuLyoqIFJlc3VsdCBvZiBhbiBlbmZvcmNlbWVudCBwYXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbnN1cmVHaXRpZ25vcmVSZXN1bHQge1xuICAvKiogUGF0dGVybnMgdGhhdCB3ZXJlIG1pc3NpbmcgYW5kIGhhdmUganVzdCBiZWVuIGFwcGVuZGVkLiAqL1xuICBhZGRlZDogc3RyaW5nW107XG4gIC8qKiBQYXR0ZXJucyB0aGF0IHdlcmUgYWxyZWFkeSBwcmVzZW50IGJlZm9yZSB0aGUgcGFzcy4gKi9cbiAgZXhpc3RlZDogc3RyaW5nW107XG59XG5cbi8qKiBNYXJrZXIgY29tbWVudCB0aGF0IG9wZW5zIHRoZSBWaWJlIENvZGVyIGAuZ2l0YXR0cmlidXRlc2AgYmxvY2suICovXG5leHBvcnQgY29uc3QgVklCRV9DT0RFUl9HSVRBVFRSSUJVVEVTX0JMT0NLX01BUktFUiA9XG4gIFwiIyAtLS0gVmliZSBDb2RlciBnaXRhdHRyaWJ1dGVzIGxpbmUtZW5kaW5nIHBpbnMgKElzc3VlICMyMzMyKSAtLS1cIjtcblxuLyoqIE1hcmtlciBjb21tZW50IHRoYXQgY2xvc2VzIHRoZSBWaWJlIENvZGVyIGAuZ2l0YXR0cmlidXRlc2AgYmxvY2suICovXG5leHBvcnQgY29uc3QgVklCRV9DT0RFUl9HSVRBVFRSSUJVVEVTX0JMT0NLX0VORF9NQVJLRVIgPVxuICBcIiMgLS0tIGVuZCBWaWJlIENvZGVyIGdpdGF0dHJpYnV0ZXMgLS0tXCI7XG5cbi8qKlxuICogQ2Fub25pY2FsIHNldCBvZiBgLmdpdGF0dHJpYnV0ZXNgIGxpbmVzIGV2ZXJ5IG1vbml0b3JlZCByZXBvIHNob3VsZFxuICogY29udGFpbi4gUGlucyBsaW5lIGVuZGluZ3MgZm9yIGNyb3NzLXBsYXRmb3JtIHNhbml0eSAoTEYgZm9yIHRoZSB0ZXh0XG4gKiBmb3JtYXRzIHRoZSB3b3JrZXIgZ2VuZXJhdGVzLCBDUkxGIGZvciBXaW5kb3dzIGJhdGNoIHNjcmlwdHMpIGFuZCBtYXJrc1xuICogY29tbW9uIGJpbmFyeSBhc3NldHMgc28gZ2l0IGRvZXMgbm90IGF0dGVtcHQgbGluZS1lbmRpbmcgY29udmVyc2lvbiBvblxuICogdGhlbS5cbiAqXG4gKiBPcmRlciBtaXJyb3JzIGdpdC1hdHRyaWJ1dGVzIHByZWNlZGVuY2U6IHRoZSBicm9hZCBgKiB0ZXh0PWF1dG9gXG4gKiBmYWxsYmFjayBmaXJzdCwgdGhlbiB0aGUgcGVyLWV4dGVuc2lvbiBvdmVycmlkZXMsIHRoZW4gYmluYXJ5IG1hcmtlcnMuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVFVSVJFRF9HSVRBVFRSSUJVVEVTX0xJTkVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgLy8gQXV0by1kZXRlY3QgdGV4dCB2cyBiaW5hcnkgYXMgdGhlIGJhc2VsaW5lLlxuICBcIiogdGV4dD1hdXRvXCIsXG4gIC8vIFBpbiBMRiBmb3IgdGhlIHRleHQgZm9ybWF0cyB0aGUgd29ya2VyIGdlbmVyYXRlcyBhbmQgY29uc3VtZXMuXG4gIFwiKi5zaCB0ZXh0IGVvbD1sZlwiLFxuICBcIiouYmFzaCB0ZXh0IGVvbD1sZlwiLFxuICBcIioucHkgdGV4dCBlb2w9bGZcIixcbiAgXCIqLnlhbWwgdGV4dCBlb2w9bGZcIixcbiAgXCIqLnltbCB0ZXh0IGVvbD1sZlwiLFxuICBcIiouanNvbiB0ZXh0IGVvbD1sZlwiLFxuICAvLyBXaW5kb3dzIGJhdGNoIHNjcmlwdHMgbXVzdCBrZWVwIENSTEYuXG4gIFwiKi5iYXQgdGV4dCBlb2w9Y3JsZlwiLFxuICBcIiouY21kIHRleHQgZW9sPWNybGZcIixcbiAgLy8gQmluYXJ5IGFzc2V0IG1hcmtlcnMg4oCUIG5ldmVyIGxpbmUtZW5kaW5nIGNvbnZlcnQgdGhlc2UuXG4gIFwiKi5wbmcgYmluYXJ5XCIsXG4gIFwiKi5qcGcgYmluYXJ5XCIsXG4gIFwiKi5qcGVnIGJpbmFyeVwiLFxuICBcIiouZ2lmIGJpbmFyeVwiLFxuICBcIiouaWNvIGJpbmFyeVwiLFxuICBcIioucGRmIGJpbmFyeVwiLFxuICBcIiouemlwIGJpbmFyeVwiLFxuICBcIiouZ3ogYmluYXJ5XCIsXG4gIFwiKi50YXIgYmluYXJ5XCIsXG4gIFwiKi53b2ZmIGJpbmFyeVwiLFxuICBcIioud29mZjIgYmluYXJ5XCIsXG4gIFwiKi50dGYgYmluYXJ5XCIsXG4gIFwiKi5vdGYgYmluYXJ5XCIsXG4gIFwiKi5lb3QgYmluYXJ5XCIsXG5dO1xuXG4vKiogUmVzdWx0IG9mIGEgYC5naXRhdHRyaWJ1dGVzYCBlbmZvcmNlbWVudCBwYXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFbnN1cmVHaXRhdHRyaWJ1dGVzUmVzdWx0IHtcbiAgLyoqIExpbmVzIHRoYXQgd2VyZSBtaXNzaW5nIGFuZCBoYXZlIGp1c3QgYmVlbiBhcHBlbmRlZC4gKi9cbiAgYWRkZWQ6IHN0cmluZ1tdO1xuICAvKiogTGluZXMgdGhhdCB3ZXJlIGFscmVhZHkgcHJlc2VudCBiZWZvcmUgdGhlIHBhc3MuICovXG4gIGV4aXN0ZWQ6IHN0cmluZ1tdO1xufVxuXG4vKipcbiAqIElkZW1wb3RlbnRseSBlbnN1cmUgZXZlcnkgcmVxdWlyZWQgcGF0dGVybiBpcyBwcmVzZW50IGluIHRoZVxuICogYC5naXRpZ25vcmVgIGF0IHRoZSByb290IG9mIGByZXBvUGF0aGAuXG4gKlxuICogQmVoYXZpb3VyOlxuICogICAxLiBSZWFkIHRoZSBleGlzdGluZyBmaWxlIChvciB0cmVhdCBhcyBlbXB0eSB3aGVuIG1pc3NpbmcpLlxuICogICAyLiBDbGFzc2lmeSBlYWNoIGNhbm9uaWNhbCBwYXR0ZXJuIGFzIGFscmVhZHktcHJlc2VudCBvciBtaXNzaW5nLlxuICogICAzLiBJZiBhbnkgcGF0dGVybnMgYXJlIG1pc3NpbmcsIGFwcGVuZCBhIG1hcmtlZCBibG9jayBjb250YWluaW5nXG4gKiAgICAgIHRoZSBtaXNzaW5nIHBhdHRlcm5zIGluIHRoZWlyIGNhbm9uaWNhbCBvcmRlci4gRXhpc3RpbmcgdXNlclxuICogICAgICBjb250ZW50IGFib3ZlIGFuZCBiZWxvdyBpcyBsZWZ0IHVudG91Y2hlZC5cbiAqICAgNC4gV3JpdGUgdGhlIGZpbGUgYmFjaywgY3JlYXRpbmcgaXQgd2hlbiBuZWNlc3NhcnkuXG4gKlxuICogUmUtcnVubmluZyBvbiBhIGZ1bGx5LXByb3RlY3RlZCByZXBvIHdyaXRlcyBub3RoaW5nIGFuZCByZXR1cm5zIHRoZVxuICogZnVsbCBwYXR0ZXJuIHNldCBpbiB0aGUgYGV4aXN0ZWRgIGZpZWxkLlxuICpcbiAqIEBwYXJhbSByZXBvUGF0aCBBYnNvbHV0ZSBwYXRoIHRvIHRoZSByZXBvc2l0b3J5IHJvb3QuXG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCB0aGUgbGlzdHMgb2YgYWRkZWQgYW5kIHByZS1leGlzdGluZyBwYXR0ZXJucy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZUdpdGlnbm9yZVBhdHRlcm5zKFxuICByZXBvUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8RW5zdXJlR2l0aWdub3JlUmVzdWx0LCBFcnJvcj4+IHtcbiAgY29uc3QgZ2l0aWdub3JlUGF0aCA9IGAke3JlcG9QYXRofS8uZ2l0aWdub3JlYDtcblxuICAvLyBSZWFkIGxpbmstZnJlZTogYHJlcG9QYXRoYCBpcyBhbiBhZ2VudC13cml0YWJsZSBjbG9uZSwgc28gYSBwbGFudGVkXG4gIC8vIGAuZ2l0aWdub3JlYCBzeW1saW5rIHdvdWxkIG90aGVyd2lzZSBiZSByZWFkIHRocm91Z2gg4oCUIGFuZCB0aGVcbiAgLy8gcmVhZC1tb2RpZnktd3JpdGUgYmVsb3cgd291bGQgY29weSB0aGUgbGluayB0YXJnZXQncyBjb250ZW50IGludG8gdGhlXG4gIC8vIGZpbGUgaXQgd3JpdGVzIGJhY2sgKElzc3VlICMxMjM0KS5cbiAgY29uc3QgcmVhZCA9IGF3YWl0IHJlYWRUZXh0RmlsZU5vRm9sbG93KGdpdGlnbm9yZVBhdGgpO1xuICBpZiAoIXJlYWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlYWQuZXJyb3IgfTtcbiAgLy8gTWlzc2luZyBmaWxlIGlzIGZpbmUg4oCUIHdlJ2xsIGNyZWF0ZSBpdCBiZWxvdy5cbiAgY29uc3QgZXhpc3RpbmcgPSByZWFkLnZhbHVlID8/IFwiXCI7XG5cbiAgY29uc3QgcHJlc2VudExpbmVzID0gbmV3IFNldChcbiAgICBleGlzdGluZ1xuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCAmJiAhbGluZS5zdGFydHNXaXRoKFwiI1wiKSksXG4gICk7XG5cbiAgY29uc3QgYWRkZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4aXN0ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBSRVFVSVJFRF9HSVRJR05PUkVfUEFUVEVSTlMpIHtcbiAgICBpZiAocHJlc2VudExpbmVzLmhhcyhwYXR0ZXJuKSkge1xuICAgICAgZXhpc3RlZC5wdXNoKHBhdHRlcm4pO1xuICAgIH0gZWxzZSB7XG4gICAgICBhZGRlZC5wdXNoKHBhdHRlcm4pO1xuICAgIH1cbiAgfVxuXG4gIGlmIChhZGRlZC5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgYWRkZWQsIGV4aXN0ZWQgfSB9O1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIGFwcGVuZGVkIGJsb2NrLiBQcmVzZXJ2ZSB0cmFpbGluZyBuZXdsaW5lIGNvbnZlbnRpb25zOiBpZiB0aGVcbiAgLy8gZXhpc3RpbmcgY29udGVudCBsYWNrcyBhIGZpbmFsIG5ld2xpbmUsIGFkZCBvbmUgYmVmb3JlIHRoZSBibG9jayBzbyB0aGVcbiAgLy8gbWFya2VyIGNvbW1lbnQgc3RhcnRzIG9uIGl0cyBvd24gbGluZS5cbiAgY29uc3QgbmVlZHNMZWFkaW5nTmV3bGluZSA9IGV4aXN0aW5nLmxlbmd0aCA+IDAgJiYgIWV4aXN0aW5nLmVuZHNXaXRoKFwiXFxuXCIpO1xuICBjb25zdCBibG9ja0xpbmVzID0gW1xuICAgIFwiXCIsXG4gICAgVklCRV9DT0RFUl9CTE9DS19NQVJLRVIsXG4gICAgLi4uYWRkZWQsXG4gICAgVklCRV9DT0RFUl9CTE9DS19FTkRfTUFSS0VSLFxuICAgIFwiXCIsXG4gIF07XG4gIGNvbnN0IGJsb2NrID0gKG5lZWRzTGVhZGluZ05ld2xpbmUgPyBcIlxcblwiIDogXCJcIikgKyBibG9ja0xpbmVzLmpvaW4oXCJcXG5cIik7XG5cbiAgLy8gUmVwbGFjZSBieSBhdG9taWMgcmVuYW1lIHJhdGhlciB0aGFuIHdyaXRpbmcgaW4gcGxhY2U6IHJlbmFtZSBuZXZlclxuICAvLyBmb2xsb3dzIGEgbGluaywgc28gYSBsaW5rIHN3YXBwZWQgaW4gYWZ0ZXIgdGhlIHJlYWQgaXMgZGlzcGxhY2VkLCBub3RcbiAgLy8gd3JpdHRlbiB0aHJvdWdoLlxuICBjb25zdCB3cml0dGVuID0gYXdhaXQgYXRvbWljV3JpdGUoe1xuICAgIHRhcmdldEZpbGU6IGdpdGlnbm9yZVBhdGgsXG4gICAgY29udGVudDogZXhpc3RpbmcgKyBibG9jayxcbiAgICBtb2RlOiBSRVBPX0ZJTEVfTU9ERSxcbiAgfSk7XG4gIGlmICghd3JpdHRlbi5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogd3JpdHRlbi5lcnJvciB9O1xuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBhZGRlZCwgZXhpc3RlZCB9IH07XG59XG5cbi8qKlxuICogSWRlbXBvdGVudGx5IGVuc3VyZSBldmVyeSBjYW5vbmljYWwgYC5naXRhdHRyaWJ1dGVzYCBsaW5lIGlzIHByZXNlbnRcbiAqIGF0IHRoZSByb290IG9mIGByZXBvUGF0aGAuXG4gKlxuICogQmVoYXZpb3VyIG1pcnJvcnMge0BsaW5rIGVuc3VyZUdpdGlnbm9yZVBhdHRlcm5zfTpcbiAqICAgMS4gUmVhZCB0aGUgZXhpc3RpbmcgYC5naXRhdHRyaWJ1dGVzYCAob3IgdHJlYXQgYXMgZW1wdHkgd2hlbiBtaXNzaW5nKS5cbiAqICAgMi4gQ2xhc3NpZnkgZWFjaCBjYW5vbmljYWwgbGluZSBhcyBhbHJlYWR5LXByZXNlbnQgb3IgbWlzc2luZyBieVxuICogICAgICBmdWxsIHRyaW1tZWQtbGluZSBlcXVhbGl0eSAoc28gdHJhaWxpbmcgd2hpdGVzcGFjZSBvciBzdHJheSBDUlxuICogICAgICBieXRlcyBmcm9tIGEgQ1JMRiBob3N0IGRvIG5vdCBjYXVzZSBmYWxzZSBuZWdhdGl2ZXMpLlxuICogICAzLiBJZiBhbnkgbGluZXMgYXJlIG1pc3NpbmcsIGFwcGVuZCBhIG1hcmtlZCBibG9jayBjb250YWluaW5nIHRoZVxuICogICAgICBtaXNzaW5nIGxpbmVzLiBFeGlzdGluZyB1c2VyIGNvbnRlbnQgYWJvdmUgYW5kIGJlbG93IGlzIGxlZnRcbiAqICAgICAgdW50b3VjaGVkIChtZXJnZSDigJQgbmV2ZXIgY2xvYmJlciBhIHJlcG8ncyBvd24gYXR0cmlidXRlIHJ1bGVzKS5cbiAqICAgNC4gV3JpdGUgdGhlIGZpbGUgYmFjayB3aXRoIExGIGxpbmUgZW5kaW5ncywgY3JlYXRpbmcgaXQgd2hlblxuICogICAgICBuZWNlc3NhcnkuXG4gKlxuICogUmUtcnVubmluZyBvbiBhIGZ1bGx5LXByb3RlY3RlZCByZXBvIHdyaXRlcyBub3RoaW5nIGFuZCByZXR1cm5zIHRoZVxuICogZnVsbCBjYW5vbmljYWwgc2V0IGluIHRoZSBgZXhpc3RlZGAgZmllbGQuXG4gKlxuICogQHBhcmFtIHJlcG9QYXRoIEFic29sdXRlIHBhdGggdG8gdGhlIHJlcG9zaXRvcnkgcm9vdC5cbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIHRoZSBsaXN0cyBvZiBhZGRlZCBhbmQgcHJlLWV4aXN0aW5nIGxpbmVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlR2l0YXR0cmlidXRlc1BhdHRlcm5zKFxuICByZXBvUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8RW5zdXJlR2l0YXR0cmlidXRlc1Jlc3VsdCwgRXJyb3I+PiB7XG4gIGNvbnN0IGdpdGF0dHJpYnV0ZXNQYXRoID0gYCR7cmVwb1BhdGh9Ly5naXRhdHRyaWJ1dGVzYDtcblxuICAvLyBTYW1lIGxpbmstZnJlZSByZWFkIGFzIGBlbnN1cmVHaXRpZ25vcmVQYXR0ZXJucygpYCAoSXNzdWUgIzEyMzQpLlxuICBjb25zdCByZWFkID0gYXdhaXQgcmVhZFRleHRGaWxlTm9Gb2xsb3coZ2l0YXR0cmlidXRlc1BhdGgpO1xuICBpZiAoIXJlYWQub2spIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlYWQuZXJyb3IgfTtcbiAgLy8gTWlzc2luZyBmaWxlIGlzIGZpbmUg4oCUIHdlJ2xsIGNyZWF0ZSBpdCBiZWxvdy5cbiAgY29uc3QgZXhpc3RpbmcgPSByZWFkLnZhbHVlID8/IFwiXCI7XG5cbiAgLy8gQ2xhc3NpZnkgYnkgZnVsbCB0cmltbWVkLWxpbmUgZXF1YWxpdHkuIFRyaW1taW5nIHJlbW92ZXMgdGhlIHRyYWlsaW5nXG4gIC8vIGBcXHJgIGZyb20gYSBDUkxGLXRlcm1pbmF0ZWQgbGluZSwgc28gQ1JMRi1zYXZlZCBhdHRyaWJ1dGUgZmlsZXMgYXJlXG4gIC8vIG5vdCBmYWxzZWx5IHRyZWF0ZWQgYXMgbWlzc2luZyBldmVyeSBjYW5vbmljYWwgbGluZS5cbiAgY29uc3QgcHJlc2VudExpbmVzID0gbmV3IFNldChcbiAgICBleGlzdGluZ1xuICAgICAgLnNwbGl0KFwiXFxuXCIpXG4gICAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoKGxpbmUpID0+IGxpbmUubGVuZ3RoID4gMCAmJiAhbGluZS5zdGFydHNXaXRoKFwiI1wiKSksXG4gICk7XG5cbiAgY29uc3QgYWRkZWQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGV4aXN0ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiBSRVFVSVJFRF9HSVRBVFRSSUJVVEVTX0xJTkVTKSB7XG4gICAgaWYgKHByZXNlbnRMaW5lcy5oYXMobGluZSkpIHtcbiAgICAgIGV4aXN0ZWQucHVzaChsaW5lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYWRkZWQucHVzaChsaW5lKTtcbiAgICB9XG4gIH1cblxuICBpZiAoYWRkZWQubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGFkZGVkLCBleGlzdGVkIH0gfTtcbiAgfVxuXG4gIC8vIFNhbWUgdHJhaWxpbmctbmV3bGluZSBoYW5kbGluZyBhcyBgZW5zdXJlR2l0aWdub3JlUGF0dGVybnMoKWA6IGVuc3VyZVxuICAvLyB0aGUgbWFya2VyIGNvbW1lbnQgc3RhcnRzIG9uIGl0cyBvd24gbGluZSwgYW5kIGFsd2F5cyBlbWl0IExGIHNvIHRoZVxuICAvLyBjYW5vbmljYWwgYmxvY2sgZG9lcyBub3QgZmxpcCBiZXR3ZWVuIExGIGFuZCBDUkxGIGFjcm9zcyBob3N0IE9TZXMuXG4gIGNvbnN0IG5lZWRzTGVhZGluZ05ld2xpbmUgPSBleGlzdGluZy5sZW5ndGggPiAwICYmICFleGlzdGluZy5lbmRzV2l0aChcIlxcblwiKTtcbiAgY29uc3QgYmxvY2tMaW5lcyA9IFtcbiAgICBcIlwiLFxuICAgIFZJQkVfQ09ERVJfR0lUQVRUUklCVVRFU19CTE9DS19NQVJLRVIsXG4gICAgLi4uYWRkZWQsXG4gICAgVklCRV9DT0RFUl9HSVRBVFRSSUJVVEVTX0JMT0NLX0VORF9NQVJLRVIsXG4gICAgXCJcIixcbiAgXTtcbiAgY29uc3QgYmxvY2sgPSAobmVlZHNMZWFkaW5nTmV3bGluZSA/IFwiXFxuXCIgOiBcIlwiKSArIGJsb2NrTGluZXMuam9pbihcIlxcblwiKTtcblxuICAvLyBSZXBsYWNlIGJ5IGF0b21pYyByZW5hbWUgcmF0aGVyIHRoYW4gd3JpdGluZyBpbiBwbGFjZTogcmVuYW1lIG5ldmVyXG4gIC8vIGZvbGxvd3MgYSBsaW5rLCBzbyBhIGxpbmsgc3dhcHBlZCBpbiBhZnRlciB0aGUgcmVhZCBpcyBkaXNwbGFjZWQsIG5vdFxuICAvLyB3cml0dGVuIHRocm91Z2guXG4gIGNvbnN0IHdyaXR0ZW4gPSBhd2FpdCBhdG9taWNXcml0ZSh7XG4gICAgdGFyZ2V0RmlsZTogZ2l0YXR0cmlidXRlc1BhdGgsXG4gICAgY29udGVudDogZXhpc3RpbmcgKyBibG9jayxcbiAgICBtb2RlOiBSRVBPX0ZJTEVfTU9ERSxcbiAgfSk7XG4gIGlmICghd3JpdHRlbi5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogd3JpdHRlbi5lcnJvciB9O1xuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyBhZGRlZCwgZXhpc3RlZCB9IH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBeUNDLEdBR0QsU0FBUyxXQUFXLEVBQUUsb0JBQW9CLFFBQVEsa0JBQWtCO0FBRXBFOzs7O0NBSUMsR0FDRCxNQUFNLGlCQUFpQjtBQUV2QiwyREFBMkQsR0FDM0QsT0FBTyxNQUFNLDBCQUNYLHFEQUFxRDtBQUV2RCw0REFBNEQsR0FDNUQsT0FBTyxNQUFNLDhCQUNYLDJDQUEyQztBQUU3Qzs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLDhCQUFpRDtFQUM1RCx1Q0FBdUM7RUFDdkM7RUFDQSxzQ0FBc0M7RUFDdEM7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBLDZEQUE2RDtFQUM3RDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQSx5RUFBeUU7RUFDekUsZ0VBQWdFO0VBQ2hFO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQSwwRUFBMEU7RUFDMUU7RUFDQSx5RUFBeUU7RUFDekU7Q0FDRCxDQUFDO0FBVUYscUVBQXFFLEdBQ3JFLE9BQU8sTUFBTSx3Q0FDWCxvRUFBb0U7QUFFdEUsc0VBQXNFLEdBQ3RFLE9BQU8sTUFBTSw0Q0FDWCx5Q0FBeUM7QUFFM0M7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxNQUFNLCtCQUFrRDtFQUM3RCw4Q0FBOEM7RUFDOUM7RUFDQSxpRUFBaUU7RUFDakU7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0Esd0NBQXdDO0VBQ3hDO0VBQ0E7RUFDQSwwREFBMEQ7RUFDMUQ7RUFDQTtF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
// denoCacheMetadata=13919482830122372108,4074669168547198381