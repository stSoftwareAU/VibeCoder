/**
 * Builds a directory chain past Linux PATH_MAX for walker tests
 * (Issues #5506, #5593).
 */

/** Name of each level in the deep chain (NAME_MAX is 255 bytes). */
const DEEP_LEVEL_NAME = "d".repeat(200);
/** 25 levels of 201 bytes each is about 5 KB, past Linux PATH_MAX (4096). */
const DEEP_LEVEL_COUNT = 25;

/**
 * Create a DEEP_LEVEL_COUNT-deep directory chain under `dir` with a `deep.md`
 * at the bottom. Each level is made relative to the previous one, so no single
 * syscall receives a path at or beyond PATH_MAX. Returns the absolute path of
 * the deepest directory.
 */
export async function makeDeepTree(dir: string): Promise<string> {
  const script = [
    "set -eu",
    'for name in "$@"; do mkdir -- "$name"; cd -- "$name"; done',
    "printf '# deep\\n' > deep.md",
  ].join("\n");
  const names = Array.from({ length: DEEP_LEVEL_COUNT }, () => DEEP_LEVEL_NAME);
  const { code, stderr } = await new Deno.Command("bash", {
    args: ["-c", script, "bash", ...names],
    cwd: dir,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `deep tree build failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return `${dir}/${names.join("/")}`;
}

/**
 * Remove a tree with `rm -rf`, which walks relative to each parent directory
 * and so copes with paths past PATH_MAX. Throws on failure rather than leaking
 * the temp tree silently.
 */
export async function removeTree(root: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("rm", {
    args: ["-rf", "--", root],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `rm -rf failed for ${root}: ${new TextDecoder().decode(stderr)}`,
    );
  }
}
