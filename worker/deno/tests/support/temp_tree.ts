/**
 * Temp-tree teardown for tests that hand a directory to a child process
 * (Issue #1135).
 *
 * `setup_credential_provisioning_test.ts` went red on CI with every
 * assertion green and only its teardown failing:
 *
 * ```text
 * provision_vibe_credentials - is idempotent across repeated runs
 * error: Error: Directory not empty (os error 39): remove '/tmp/a608138619c33790'
 * ```
 *
 * `ENOTEMPTY` from a **recursive** remove is not "the directory had
 * contents" — recursive removal handles that. It means an entry appeared
 * inside the tree while it was being walked. Letting that reach the
 * reporter as the test's own result is the most expensive way a suite can
 * be wrong: the reader's first assumption is that credential provisioning
 * broke, which it had not.
 *
 * So the removal is retried for a bounded window — and never in silence.
 * A removal that only succeeded on a retry says so, and a tree that
 * outlasts the window fails loudly, naming its surviving entries, because
 * a tree that will not go away is a leak somebody has to look at. The
 * failure text says it is a teardown failure so nobody spends an hour on
 * the behaviour under test again.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/** Removal attempts before a surviving tree is reported as a leak. */
export const REMOVAL_ATTEMPTS = 10;

/** Wait between attempts — ten attempts span half a second. */
export const RETRY_INTERVAL_MS = 50;

/** Injectable seams; every default is the real filesystem. */
export interface RemoveTempTreeDeps {
  /** Remove the tree, recursively. */
  remove: (dir: string) => Promise<void>;
  /** Everything still inside the tree, for the failure message. */
  list: (dir: string) => Promise<string[]>;
  /** Wait between attempts. */
  sleep: (ms: number) => Promise<void>;
  /** Where the retry note goes. */
  warn: (message: string) => void;
}

/** Every entry under `dir`, relative to it, deepest path last. */
export async function listTree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(path)) {
      const relative = `${prefix}${entry.name}`;
      found.push(relative);
      if (entry.isDirectory) {
        await walk(`${path}/${entry.name}`, `${relative}/`);
      }
    }
  };
  try {
    await walk(dir, "");
  } catch (error) {
    // A tree that has just gone is the good outcome, not a fault. Anything
    // else is reported inside the listing rather than swallowed.
    if (!(error instanceof Deno.errors.NotFound)) {
      found.push(`<listing failed: ${error}>`);
    }
  }
  return found.sort();
}

const DEFAULT_DEPS: RemoveTempTreeDeps = {
  remove: (dir) => Deno.remove(dir, { recursive: true }),
  list: listTree,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  warn: (message) => console.warn(message),
};

/**
 * Remove a temp tree, tolerating a writer that was still finishing.
 *
 * Throws only when the tree genuinely will not go away, and then says so in
 * the words of a teardown failure, with the surviving entries named.
 */
export async function removeTempTree(
  dir: string,
  deps: Partial<RemoveTempTreeDeps> = {},
): Promise<void> {
  const { remove, list, sleep, warn } = { ...DEFAULT_DEPS, ...deps };
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOVAL_ATTEMPTS; attempt++) {
    try {
      await remove(dir);
      if (attempt > 1) {
        warn(
          `Temp tree ${dir} only came away on attempt ${attempt} of ` +
            `${REMOVAL_ATTEMPTS}: something outside the test was still ` +
            `writing into it when teardown started (Issue #1135). Last ` +
            `removal error: ${describe(lastError)}`,
        );
      }
      return;
    } catch (error) {
      // Already gone is the outcome teardown wanted.
      if (error instanceof Deno.errors.NotFound) return;
      lastError = error;
      if (attempt < REMOVAL_ATTEMPTS) await sleep(RETRY_INTERVAL_MS);
    }
  }
  const survivors = await list(dir);
  throw new Error(
    `Teardown could not remove the temp tree ${dir} after ` +
      `${REMOVAL_ATTEMPTS} attempts over ` +
      `${REMOVAL_ATTEMPTS * RETRY_INTERVAL_MS} ms. This is a cleanup ` +
      `failure, not a failure of the behaviour under test — something is ` +
      `still writing into the tree (Issue #1135). Surviving entries: ` +
      `${survivors.length > 0 ? survivors.join(", ") : "(none listed)"}. ` +
      `Last removal error: ${describe(lastError)}`,
  );
}

/**
 * Run `fn` with a fresh temp directory and remove it however `fn` ends.
 *
 * A failure of the behaviour under test always wins: when the body throws,
 * a teardown problem is reported beside that failure rather than replacing
 * it, so the assertion the reader needs is never overwritten by a cleanup
 * error raised out of a `finally`.
 */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
  options: Deno.MakeTempOptions = {},
): Promise<T> {
  const dir = await Deno.makeTempDir(options);
  let value: T;
  try {
    value = await fn(dir);
  } catch (bodyError) {
    await removeTempTree(dir).catch((cleanupError: unknown) => {
      console.error(describe(cleanupError));
    });
    throw bodyError;
  }
  await removeTempTree(dir);
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
