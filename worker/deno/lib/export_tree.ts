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
 * Every regular file beneath `root`, as sorted root-relative paths using `/`
 * separators. Symlinks are not followed (the export refuses them upstream)
 * and `.git/` is never entered.
 */
export async function listTreeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "", files);
  files.sort();
  return files;
}

async function walk(
  root: string,
  relDir: string,
  out: string[],
): Promise<void> {
  const absDir = relDir === "" ? root : `${root}/${relDir}`;
  for await (const entry of Deno.readDir(absDir)) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isSymlink) continue;
    if (entry.isDirectory) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, rel, out);
    } else if (entry.isFile) {
      out.push(rel);
    }
  }
}

/** The first path segment, or `(root)` for a top-level file. */
export function topLevelDirectory(rel: string): string {
  const slash = rel.indexOf("/");
  return slash === -1 ? "(root)" : rel.slice(0, slash);
}
