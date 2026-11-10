/** Largest tracked file read whole; bigger files are refused. */
export const MAX_REPO_FILE_BYTES = 1024 * 1024;

/**
 * Read a file under `repoRoot` as text. Refuses an absolute or `.`/`..` path,
 * a symlink in any component below `repoRoot`, a non-regular file, and a file
 * over `maxBytes` (including one that grows after its size check). A missing
 * file throws `Deno.errors.NotFound`.
 */
export async function readRepoFile(
  repoRoot: string,
  relPath: string,
  maxBytes = MAX_REPO_FILE_BYTES,
): Promise<string> {
  const segments = relPath.split(/[\\/]/);
  // An empty path splits to [""], so the empty-segment check refuses it too.
  if (
    /^([\\/]|[A-Za-z]:)/.test(relPath) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`Refusing unsafe repo path: ${relPath}`);
  }
  // lstat each component (not repoRoot itself) so a symlink anywhere refuses.
  for (let i = 0; i < segments.length; i++) {
    const stat = await Deno.lstat(
      `${repoRoot}/${segments.slice(0, i + 1).join("/")}`,
    );
    if (stat.isSymlink) {
      throw new Error(`Refusing symlink in repo path: ${relPath}`);
    }
    if (i === segments.length - 1 && !stat.isFile) {
      throw new Error(`Refusing non-regular repo file: ${relPath}`);
    }
  }
  using file = await Deno.open(`${repoRoot}/${relPath}`, { read: true });
  const stat = await file.stat();
  if (!stat.isFile || stat.size > maxBytes) {
    throw new Error(
      `Repo file is not a regular file within the size cap: ${relPath}`,
    );
  }
  const bytes = new Uint8Array(maxBytes + 1);
  let used = 0;
  while (used < bytes.length) {
    const read = await file.read(bytes.subarray(used));
    if (read === null) return new TextDecoder().decode(bytes.subarray(0, used));
    used += read;
  }
  throw new Error(`Repo file exceeds the size cap: ${relPath}`);
}
