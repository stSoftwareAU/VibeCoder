/**
 * Where the `gh`/`git` guard modules are executed from (Issue #1444).
 *
 * The guard wrappers on the agent's PATH spawn a fresh Deno child for every
 * `gh` and `git` call the agent makes, and that child executes a guard entry
 * point named by absolute path. Both entry points used to be resolved from
 * `import.meta.url` — relative to the RUNNING module.
 *
 * In the container the worker does not run from the mounted checkout. For
 * speed, `container/entrypoint.sh` copies `worker/deno` onto local storage
 * and makes the copy writable so the next launch's `rm -rf` can replace it
 * (Issue #514), then runs the driver from there. So `import.meta.url` pointed
 * into that writable copy, and the guard the wrapper executed was a file the
 * coding agent's own uid could rewrite — and one re-read on every call rather
 * than loaded once at start-up.
 *
 * That inverts the control. The write-repo allowlist check, the reserved-label
 * denylist, the credential-disclosure guard, the endpoint host check
 * (Issue #1420) and the run-scoped credential wiring (Issue #1423) all
 * re-enter through those modules. A control the constrained party can edit,
 * which is re-read on each use, is advice rather than a boundary.
 *
 * The fix is the one already applied to the worker's INSTRUCTIONS. The same
 * entrypoint block pins `PROMPTS_DIR="${BASE_DIR}/prompts"` so prompt
 * templates resolve to the read-only mount instead of the staged copy; this
 * does the same for the modules that ENFORCE, using the `VIBE_BASE_DIR` the
 * launcher already exports (`container_launch.ts`).
 *
 * ## Why it falls back rather than insisting
 *
 * `VIBE_BASE_DIR` is absent outside the container — tests, a developer host —
 * and a layout that does not carry the module at the expected path would
 * otherwise fail every `gh` call the agent makes. So the checkout copy is
 * preferred **when it is actually there**, and the module-relative path
 * remains the fallback. That is not a weakness an agent can exploit: the
 * checkout is a read-only mount, so the file it would have to remove to force
 * the fallback is one it cannot remove.
 *
 * Nothing here changes the staging block. The staged copy still exists, is
 * still writable, and is still removable by the next launch — the recovery
 * path `chmod -R u+w` exists for is untouched. Only the guard's own entry
 * point moves.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** The checkout path the container launcher exports (`container_launch.ts`). */
export const BASE_DIR_ENV = "VIBE_BASE_DIR";

/** Where the guard modules sit beneath the checkout root. */
export const GUARD_MODULE_SUBDIR = "worker/deno/lib";

/** Environment lookup seam. */
export type GuardEnvLookup = (name: string) => string | undefined;

/** Existence probe seam, so the resolver is testable without a filesystem. */
export type GuardFileExists = (path: string) => boolean;

const processEnv: GuardEnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const realFileExists: GuardFileExists = (path) => {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
};

/**
 * Absolute path of a guard entry point, preferring the read-only checkout.
 *
 * @param fileName - Guard module file name, e.g. `gh_guard_cli.ts`.
 * @param moduleUrl - The calling module's `import.meta.url`, used for the
 *   fallback so the resolved path stays beside the caller.
 * @param env - Environment lookup (injectable for tests).
 * @param exists - Existence probe (injectable for tests).
 * @returns The checkout copy when the launcher named a checkout that actually
 *   carries the module; otherwise the module-relative path.
 */
export function resolveGuardModulePath(
  fileName: string,
  moduleUrl: string,
  env: GuardEnvLookup = processEnv,
  exists: GuardFileExists = realFileExists,
): string {
  const moduleRelative = decodeURIComponent(
    new URL(`./${fileName}`, moduleUrl).pathname,
  );

  const baseDir = env(BASE_DIR_ENV)?.trim();
  if (!baseDir) return moduleRelative;

  const fromCheckout = `${
    baseDir.replace(/\/+$/, "")
  }/${GUARD_MODULE_SUBDIR}/${fileName}`;
  return exists(fromCheckout) ? fromCheckout : moduleRelative;
}
