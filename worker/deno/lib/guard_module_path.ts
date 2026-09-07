/**
 * Where the agent-side guard entry points are executed from (Issue #1444).
 *
 * `container/entrypoint.sh` stages `worker/deno` onto VM-local storage for
 * speed and marks the copy writable, because the next launch's `rm -rf` cannot
 * empty a tree it has no write bit on (Issue #514). The uid that write bit
 * belongs to — `vibe` — is the uid the coding agent runs as, with unrestricted
 * Bash.
 *
 * That is harmless for ordinary worker code, which is already running, but the
 * `gh` and `git` guards are different: their wrapper scripts spawn a fresh
 * guard child per call, so the module is **re-read from disk on every
 * invocation**. Resolving it against `import.meta.url` pointed it at the
 * staged, agent-writable copy — a containment boundary the constrained party
 * could rewrite mid-run. This module resolves it against the checkout the
 * launcher named instead (`VIBE_BASE_DIR`, mounted read-only, Issue #514),
 * exactly as `PROMPTS_DIR` already does for the prompt templates.
 *
 * ```mermaid
 * flowchart LR
 *     E["entrypoint.sh"] -->|"cp -R + chmod u+w"| S["staged worker/deno<br/>(agent-writable)"]
 *     E -->|VIBE_BASE_DIR| C["mounted checkout<br/>(read-only)"]
 *     S --> D["worker driver"]
 *     D --> W["gh/git PATH wrapper"]
 *     W -->|"deno run (per call)"| G["gh_guard_cli.ts<br/>git_guard_cli.ts"]
 *     C --> G
 * ```
 *
 * **Fails closed, like the shim it serves.** A launcher that named a checkout
 * but cannot supply the guard from it is a broken containment boundary, not a
 * degradation to absorb: the resolution reports `degraded`, and
 * `installGhGuardShim` turns that into the same `blocked`/`degraded` verdict
 * every other uninstallable-shim fault takes ({@link GhGuardShimOutcome}), so
 * the agent is not spawned behind a guard it could rewrite.
 *
 * **No checkout named is not a degradation.** With `VIBE_BASE_DIR` unset
 * nothing was staged — a host run executes the checkout directly, so the
 * running copy *is* the checkout copy.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Path of `worker/deno/lib` relative to the checkout root. */
export const GUARD_MODULE_DIR = "worker/deno/lib";

/**
 * Guard entry points are plain file names in this directory — no separator, no
 * traversal. Callers are internal, so a bad name is a programming error and
 * fails loud rather than resolving somewhere unintended.
 */
const GUARD_MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*\.ts$/;

/** Test seams for {@link resolveGuardModulePath}. */
export interface GuardModulePathOptions {
  /** Environment lookup; defaults to the process environment. */
  env?: EnvLookup;
  /** Existence probe for the checkout candidate (test seam). */
  exists?: (path: string) => boolean;
}

/** Where a guard entry point resolved to, and whether that is safe to use. */
export interface GuardModuleResolution {
  /** Absolute path of the guard entry point. */
  path: string;
  /**
   * Why {@link path} is the running (agent-writable) copy even though a
   * checkout was named. Absent when the path is trustworthy; present means the
   * caller must refuse to install the shim.
   */
  degraded?: string;
}

/** Whether `path` is a readable file. A refused stat counts as absent. */
function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Resolve a guard entry point, preferring the read-only checkout.
 *
 * @param fileName - Guard module file name, e.g. `gh_guard_cli.ts`.
 * @param opts - Environment lookup and existence probe.
 * @returns The checkout copy when `VIBE_BASE_DIR` names one that carries the
 *   module; otherwise the running copy, marked `degraded` unless no checkout
 *   was named at all.
 * @throws If `fileName` is not a bare `*.ts` file name.
 */
export function resolveGuardModulePath(
  fileName: string,
  opts: GuardModulePathOptions = {},
): GuardModuleResolution {
  if (!GUARD_MODULE_NAME.test(fileName)) {
    throw new Error(
      `guard module name must be a bare *.ts file name, got: ${fileName}`,
    );
  }

  const running = decodeURIComponent(
    new URL(`./${fileName}`, import.meta.url).pathname,
  );

  /** The running copy, with the reason it is not the checkout's. */
  const degraded = (why: string): GuardModuleResolution => ({
    path: running,
    degraded: `[GUARD_MODULE_NOT_IN_CHECKOUT] ${why}, so the guard would run ` +
      `from ${running} — the staged worker copy, which the coding agent's own ` +
      `uid can write to (Issue #1444)`,
  });

  const env = opts.env ?? processEnvLookup;
  let baseDir: string | undefined;
  try {
    baseDir = env("VIBE_BASE_DIR");
  } catch (err) {
    // A denied `--allow-env` leaves the checkout unnameable, which lands on
    // exactly the same writable copy as a missing module — reported as loudly.
    return degraded(
      `VIBE_BASE_DIR could not be read (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const trimmed = (baseDir ?? "").trim().replace(/\/+$/, "");
  // Nothing was staged, so the running copy is the checkout copy.
  if (trimmed === "") return { path: running };

  const candidate = `${trimmed}/${GUARD_MODULE_DIR}/${fileName}`;
  if (candidate === running) return { path: running };
  const exists = opts.exists ?? fileExists;
  if (exists(candidate)) return { path: candidate };

  return degraded(`${candidate} is absent`);
}
