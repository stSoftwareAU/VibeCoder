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
 * **Never silently degrades.** When `VIBE_BASE_DIR` names a checkout that does
 * not carry the guard module, the fallback to the running copy is announced
 * with a `[SECURITY]` warning naming both paths, rather than quietly handing
 * the agent back a boundary it can edit.
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

/** Test seams and the warning sink for {@link resolveGuardModulePath}. */
export interface GuardModulePathOptions {
  /** Environment lookup; defaults to the process environment. */
  env?: EnvLookup;
  /** Existence probe for the checkout candidate (test seam). */
  exists?: (path: string) => boolean;
  /** Sink for the loud warning when the checkout copy is unusable. */
  warn?: (message: string) => void;
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
 * Absolute path of a guard entry point, preferring the read-only checkout.
 *
 * @param fileName - Guard module file name, e.g. `gh_guard_cli.ts`.
 * @param opts - Environment lookup, existence probe and warning sink.
 * @returns The checkout copy when `VIBE_BASE_DIR` names one that carries the
 *   module; otherwise the copy this module is running from.
 * @throws If `fileName` is not a bare `*.ts` file name.
 */
export function resolveGuardModulePath(
  fileName: string,
  opts: GuardModulePathOptions = {},
): string {
  if (!GUARD_MODULE_NAME.test(fileName)) {
    throw new Error(
      `guard module name must be a bare *.ts file name, got: ${fileName}`,
    );
  }

  const running = decodeURIComponent(
    new URL(`./${fileName}`, import.meta.url).pathname,
  );

  const env = opts.env ?? processEnvLookup;
  let baseDir: string | undefined;
  try {
    baseDir = env("VIBE_BASE_DIR");
  } catch {
    // No --allow-env: the launcher's checkout cannot be named, and the
    // running copy is the only path there is.
    baseDir = undefined;
  }
  const trimmed = (baseDir ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return running;

  const candidate = `${trimmed}/${GUARD_MODULE_DIR}/${fileName}`;
  if (candidate === running) return running;
  const exists = opts.exists ?? fileExists;
  if (exists(candidate)) return candidate;

  const warn = opts.warn ?? ((m: string) => console.error(m));
  warn(
    `[SECURITY] [GUARD_MODULE_NOT_IN_CHECKOUT] ${candidate} is absent, so the ` +
      `guard runs from ${running} instead — the staged worker copy, which the ` +
      `coding agent's own uid can write to (Issue #1444).`,
  );
  return running;
}
