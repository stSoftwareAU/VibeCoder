/**
 * Throwaway `container_extension` directories for the tests that drive the
 * real preflight, the launch resolution and setup's report (Issue #982).
 *
 * The three suites all need the same fixture — an operator-shaped extension
 * directory on a temporary path — so they share one, and a change to what a
 * complete definition looks like is made once.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Write a file inside an extension directory, creating its parents.
 *
 * @param root - The extension directory
 * @param relative - The file's path relative to it, `/`-separated
 * @param contents - What to write
 */
export async function writeExtensionFile(
  root: string,
  relative: string,
  contents: string,
): Promise<void> {
  const path = `${root}/${relative}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, contents);
}

/**
 * A throwaway extension directory carrying a complete definition: a
 * Containerfile that layers on the standard image, a start script, and a
 * data file beside them.
 *
 * @returns The directory's path; the caller removes it
 */
export async function makeExtensionDir(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-fixture-" });
  await writeExtensionFile(
    root,
    "Containerfile",
    "ARG VIBE_BASE_IMAGE\nFROM ${VIBE_BASE_IMAGE}\nRUN id\n",
  );
  await writeExtensionFile(
    root,
    "start.sh",
    "#!/bin/sh\nservice postgres start\n",
  );
  await writeExtensionFile(
    root,
    "seed/schema.sql",
    "CREATE TABLE jobs (id int);\n",
  );
  return root;
}

/**
 * Remove fixture paths, tolerating one the case itself already removed.
 *
 * @param paths - The paths to remove
 */
export async function discardFixture(...paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
