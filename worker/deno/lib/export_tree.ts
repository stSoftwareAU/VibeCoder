/**
 * Shared file-walking helpers for the export pipeline stages — the branding
 * transform (Issue #4197) and the scrub gate (Issue #4196).
 *
 * Both stages run over the staged export tree, visit every regular file,
 * decide whether it is text, and skip what is not. Keeping that logic in one
 * place means the two stages agree on what "a text file" is, so a file the
 * transform rewrote is always a file the gate scans.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** Bytes inspected for a NUL when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

/** Directories never descended into: the staged repository's own metadata. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git"]);

/**
 * True when the bytes look binary — a NUL within the first 8 KiB, the same
 * heuristic git uses. Extension-agnostic on purpose: a `.md` with a NUL is
 * not text and a `.dat` without one is.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Decode bytes as UTF-8 text, or return `null` when the file is binary or is
 * not valid UTF-8 — either way it must be left untouched and unscanned.
 */
export function decodeTextOrNull(bytes: Uint8Array): string | null {
  if (isProbablyBinary(bytes)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * What a walk of the staged tree found: the regular files it will report, and
 * the symlinks it refused to follow.
 *
 * Symlinks are reported rather than discarded (Issue #1412). A symlink can be
 * committed to git and its *target path* is content — an entry pointing at an
 * operator home path publishes that path — so a walk that dropped them left
 * an input with no trace in any stage's verdict. The walk still never follows
 * one; it just says what it skipped, and the scrub gate turns each into a
 * blocking coverage finding.
 */
export interface TreeWalk {
  /** Regular files, as sorted root-relative paths using `/` separators. */
  files: string[];
  /** Symlinks found and not followed, sorted the same way. */
  symlinks: string[];
}

/**
 * Walk `root`, reporting every regular file beneath it and every symlink it
 * declined to follow. `.git/` is never entered.
 */
export async function walkTree(root: string): Promise<TreeWalk> {
  const walked: TreeWalk = { files: [], symlinks: [] };
  await walk(root, "", walked);
  walked.files.sort();
  walked.symlinks.sort();
  return walked;
}

/**
 * Every regular file beneath `root`, as sorted root-relative paths using `/`
 * separators. Symlinks are neither followed nor listed here — a caller that
 * must account for them reads {@link walkTree} instead.
 */
export async function listTreeFiles(root: string): Promise<string[]> {
  return (await walkTree(root)).files;
}

async function walk(
  root: string,
  relDir: string,
  out: TreeWalk,
): Promise<void> {
  const absDir = relDir === "" ? root : `${root}/${relDir}`;
  for await (const entry of Deno.readDir(absDir)) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isSymlink) {
      // Never followed: a symlink out of the staged tree would pull in files
      // the export never allowlisted. Recorded so it cannot vanish silently
      // — including one named like a skipped directory, because the walk
      // cannot know where it points without following it.
      out.symlinks.push(rel);
      continue;
    }
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, rel, out);
    } else if (entry.isFile) {
      out.files.push(rel);
    }
  }
}

/** The first path segment, or `(root)` for a top-level file. */
export function topLevelDirectory(rel: string): string {
  const slash = rel.indexOf("/");
  return slash === -1 ? "(root)" : rel.slice(0, slash);
}
