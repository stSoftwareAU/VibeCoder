/**
 * `.config.json` surface for a deployment's private environment extension
 * (Issue #978, parent #933).
 *
 * A deployment declares one extension — an operator-owned directory on the
 * host holding a `Containerfile` built `FROM` the standard image, and
 * optionally a start script the sandbox runs before the worker (Postgres,
 * Jenkins, …). The Vibe Coder clones nothing: the operator syncs their own
 * private repository into that directory themselves, matching the
 * `custom_label_prompts` precedent.
 *
 * This module is the trust boundary. Every later sub-issue of #933 (the
 * extension digest, the two-stage build, running the start script) assumes an
 * already-validated declaration, so a fault must be rejected **here**.
 *
 * ## Validation posture — fail loud
 *
 * Matching `lib/container_tools_config.ts`, and unlike the warn-and-default
 * `idle_task_cadence` parser: a malformed declaration is never repaired and
 * never partially applied. {@link parseContainerExtension} returns the first
 * fault as an error naming the offending field, and
 * {@link assertContainerExtension} throws it. A half-understood declaration
 * would mean building an unexpected image or running an unexpected script —
 * both worse than refusing to start (see `DESIGN-PRINCIPLES.md`, never fail
 * silently).
 *
 * ## Confinement
 *
 * `path` is an absolute host directory, and `containerfile`/`start` are
 * **relative to it** — the same prefix-confinement rule `container_tools`
 * enforces for `bin`/`env`. `path` itself may be neither the host home
 * directory, an ancestor of it, nor a filesystem root: the containment rule
 * Issue #850 established for operator-supplied host paths, enforced through
 * the same {@link isAtOrAbove} predicate the launcher's mount-source
 * allowlist uses. A traversal segment is refused outright, because
 * `/srv/../home/operator` **is** the home directory once resolved and no
 * string comparison would see it.
 *
 * The home directory compared against is the one **the reading process** is
 * running as. Host-side — the launcher, through
 * {@link readContainerExtensionSelection} — that is the operator's own home,
 * which is where the rule genuinely binds. In-container the worker's config
 * load compares against the container's `/home/vibe`, so the check there is a
 * second line rather than the first; the launcher has already refused the
 * declaration before any container starts.
 *
 * The standard public Vibe Coder is unchanged: an unconfigured deployment
 * parses exactly as it does today and installs nothing.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { ContainerExtensionSpec, Result } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import {
  isAbsolutePath,
  isAtOrAbove,
  isConfinedRelativePath,
  isRootPath,
  type LauncherPathStyle,
  normalisePath,
  pathStyleFor,
} from "./host_path_style.ts";

/** The Containerfile an extension builds when it names none. */
export const DEFAULT_EXTENSION_CONTAINERFILE = "Containerfile";

/** Keys the `container_extension` block may carry. */
const KNOWN_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  "path",
  "containerfile",
  "start",
]);

/** Options the parse takes; production callers pass nothing. */
export interface ContainerExtensionOptions {
  /**
   * Environment lookup used to find the host home directory (Issue #956).
   * Defaults to the process environment, so a test injects a fixed map
   * instead of mutating `Deno.env`.
   */
  env?: EnvLookup;
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short, safe rendering of an operator value for an error message. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Whether a string carries a NUL byte or a C0/C1 control character. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Failure carrying a message; the parse funnels every fault through this. */
class ExtensionError extends Error {}

/** Throw a fault naming the field it came from. */
function reject(field: string, detail: string): never {
  throw new ExtensionError(`${field}: ${detail}`);
}

/** Whether a path carries a `.` or `..` segment in either spelling. */
function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) =>
    segment === "." || segment === ".."
  );
}

/** Validate a required non-empty string field, free of control characters. */
function parseCleanString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    reject(field, `must be a non-empty string, got ${show(raw)}`);
  }
  if (hasControlCharacters(raw)) {
    reject(field, `must not contain NUL or control characters`);
  }
  return raw;
}

/** The home directory of the process reading the configuration. */
function homeDirectory(env: EnvLookup): string {
  return (env("HOME") ?? env("USERPROFILE") ?? "").trim();
}

/** Validate the absolute, contained `path`. */
function parsePath(raw: unknown, field: string, env: EnvLookup): string {
  const path = parseCleanString(raw, field);
  const style = pathStyleFor(path);

  if (!isAbsolutePath(path, style)) {
    reject(
      field,
      `must be an absolute host path, got ${show(path)}`,
    );
  }
  if (hasTraversalSegment(path)) {
    reject(
      field,
      `must not contain a "." or ".." segment, got ${show(path)} — a ` +
        `traversal resolves somewhere the containment checks never see`,
    );
  }
  if (isRootPath(path, style)) {
    reject(field, `must not be the filesystem root, got ${show(path)}`);
  }

  // Issue #850's containment rule for operator-supplied host paths: the
  // Vibe Coder controls its own workspace, not the home directory of whoever
  // runs it. A home directory the environment does not state is refused
  // rather than skipped — a containment rule that cannot be evaluated is not
  // a rule that passed (see `DESIGN-PRINCIPLES.md`, never fail silently).
  const home = homeDirectory(env);
  if (home === "") {
    reject(
      field,
      `cannot be checked for containment: neither HOME nor USERPROFILE is ` +
        `set, so the home directory this path must stay out of is unknown`,
    );
  }
  if (
    isAtOrAbove(normalisePath(path, style), normalisePath(home, style), style)
  ) {
    reject(
      field,
      `must not be the home directory (or an ancestor of it), got ` +
        `${show(path)}`,
    );
  }
  return path;
}

/** Validate an optional path relative to the extension directory. */
function parseConfinedPath(
  raw: unknown,
  field: string,
  extensionPath: string,
  style: LauncherPathStyle,
): string | undefined {
  if (raw === undefined) return undefined;
  const value = parseCleanString(raw, field);
  if (!isConfinedRelativePath(value, style)) {
    reject(
      field,
      `must be relative to the extension directory ${extensionPath} — ` +
        `${show(value)} is absolute or escapes it`,
    );
  }
  return value;
}

/**
 * Validate the raw `container_extension` block from `.config.json`.
 *
 * Returns `ok` with `undefined` when the key is absent, so a deployment that
 * never opts in behaves exactly as it does today. Returns the **first** fault
 * as an error message naming the offending field — the block is never
 * partially accepted.
 *
 * @param raw - The value of the `container_extension` key, untrusted
 * @param options - Environment lookup override (tests inject a fixed map)
 * @returns The validated declaration, or the first fault
 */
export function parseContainerExtension(
  raw: unknown,
  options: ContainerExtensionOptions = {},
): Result<ContainerExtensionSpec | undefined, string> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error:
        `container_extension must be an object declaring the extension path, ` +
        `got ${show(raw)}`,
    };
  }

  const env = options.env ?? processEnvLookup;
  try {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_EXTENSION_KEYS.has(key)) {
        reject(
          `container_extension.${key}`,
          `unknown key — expected one of ${
            [...KNOWN_EXTENSION_KEYS].join(", ")
          }`,
        );
      }
    }

    const path = parsePath(raw.path, "container_extension.path", env);
    // The two relative fields are judged in the spelling their directory is
    // written in, so a Windows deployment's `..\..` escapes as surely as a
    // POSIX deployment's `../..`.
    const style = pathStyleFor(path);
    const containerfile = parseConfinedPath(
      raw.containerfile,
      "container_extension.containerfile",
      path,
      style,
    ) ?? DEFAULT_EXTENSION_CONTAINERFILE;
    const start = parseConfinedPath(
      raw.start,
      "container_extension.start",
      path,
      style,
    );

    // `start` stays absent rather than empty: a toolchain-only extension has
    // no service to start, and the later sub-issues branch on that.
    const spec: ContainerExtensionSpec = start === undefined
      ? { path, containerfile }
      : { path, containerfile, start };
    return { ok: true, value: spec };
  } catch (error) {
    if (error instanceof ExtensionError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * {@link parseContainerExtension}, but throwing — the fail-loud entry point
 * used at config load so a malformed declaration stops the worker before
 * anything is built or run.
 *
 * @param raw - The value of the `container_extension` key, untrusted
 * @param options - Environment lookup override (tests inject a fixed map)
 * @returns The validated declaration, or `undefined` when the key is absent
 * @throws When the block is malformed, naming the offending field
 */
export function assertContainerExtension(
  raw: unknown,
  options: ContainerExtensionOptions = {},
): ContainerExtensionSpec | undefined {
  const result = parseContainerExtension(raw, options);
  if (!result.ok) {
    throw new Error(
      `Invalid container_extension in .config.json: ${result.error}`,
    );
  }
  return result.value;
}

/**
 * Read the `container_extension` selection out of a `.config.json`.
 *
 * The host-side callers (the launcher's plan, the extension digest) run
 * before the worker loads its configuration, so they read the file directly
 * through here rather than restating the parse. Reading it host-side is also
 * where the home-directory containment rule genuinely binds: in-container the
 * home directory is the container's, not the operator's.
 *
 * Fail-loud, except for an absent file: the launchers run against checkouts
 * that have not been set up yet, and "no configuration" is genuinely "no
 * extension declared". A file that exists but is unreadable, is not a JSON
 * object, or carries a malformed block throws — naming the offending field —
 * rather than quietly building a different image.
 *
 * @param configFile - Path to the deployment's `.config.json`
 * @param options - Environment lookup override (tests inject a fixed map)
 * @returns The validated declaration, or `undefined` when none is declared
 */
export async function readContainerExtensionSelection(
  configFile: string,
  options: ContainerExtensionOptions = {},
): Promise<ContainerExtensionSpec | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `Cannot read container_extension: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read container_extension: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot read container_extension: ${configFile} does not hold a JSON ` +
        `object.`,
    );
  }

  const raw = (parsed as Record<string, unknown>)["container_extension"];
  return assertContainerExtension(raw, options);
}
