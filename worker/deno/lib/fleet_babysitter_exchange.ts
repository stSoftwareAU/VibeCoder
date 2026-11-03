import { readTextFileNoFollow } from "./file_utils.ts";

/** Milliseconds to wait for the read's open before giving up (Issue #4731). */
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

/**
 * A runner-owned directory for exchanging files with the repair agent
 * (Issue #4731). It sits outside the agent's write grants, so the runner
 * writes its trusted files here and the agent cannot plant a link in it.
 * Returns the canonical path, so callers can compare it with `realPath`.
 */
export async function createExchangeDir(prefix: string): Promise<string> {
  const created = await Deno.makeTempDir({ prefix });
  const dir = await Deno.realPath(created);
  await Deno.chmod(dir, 0o700);
  return dir;
}

/** A plain file name: no separator, no parent reference, not empty. */
function assertPlainName(name: string): void {
  if (
    name === "" || name === "." || name.includes("/") || name.includes("..")
  ) {
    throw new Error(
      `refused unsafe agent output name: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * The directory must be a real directory (not a symlink) and must be the
 * canonical path the caller passed, so a replaced parent cannot redirect the
 * read or the write.
 */
async function assertCanonicalDir(dir: string): Promise<void> {
  const stat = await Deno.lstat(dir);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new Error(`refused unsafe agent output directory: ${dir}`);
  }
  if (await Deno.realPath(dir) !== dir) {
    throw new Error(`refused unsafe agent output directory: ${dir}`);
  }
}

/**
 * Read a file the agent wrote in `dir` through the hardened no-follow reader.
 * An absent file is `null`. Any unsafe file (a link, FIFO, hard link, a
 * non-regular file, or one over `maxBytes`) throws before its bytes are used,
 * so the caller publishes nothing.
 */
export async function readAgentOutput(
  dir: string,
  name: string,
  options: {
    maxBytes: number;
    openTimeoutMs?: number;
    open?: typeof Deno.open;
  },
): Promise<string | null> {
  assertPlainName(name);
  await assertCanonicalDir(dir);
  const result = await readTextFileNoFollow(`${dir}/${name}`, {
    maxBytes: options.maxBytes,
    openTimeoutMs: options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
    open: options.open,
  });
  if (!result.ok) {
    throw new Error(
      `refused unsafe agent output ${name}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * The runner's own write into an exchange directory. `createNew` makes the
 * open exclusive, so a link or file the agent planted at `name` is never
 * followed or overwritten; the file is created owner-only.
 */
export async function writeExchangeFile(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  assertPlainName(name);
  await assertCanonicalDir(dir);
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, content, { createNew: true, mode: 0o600 });
  return path;
}
