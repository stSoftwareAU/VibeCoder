/**
 * `.config.json` surface for deployer-supplied container build-time tools
 * (Issue #69, parent #5).
 *
 * A deployment declares the extra tools its container image bakes in — Java and
 * Maven are the first expected use — as a top-level `container_tools` array.
 * Each entry is a **declarative archive install**: download → verify SHA-256 →
 * extract → expose `bin` directories on PATH → set `env`. No install commands,
 * no apt packages, no installer scripts.
 *
 * This module is the trust boundary. Every later sub-issue of #5 (the install
 * step, the Containerfile wiring, the image hash, PATH exposure) assumes an
 * already-validated spec, so a fault must be rejected **here**.
 *
 * ## Validation posture — fail loud
 *
 * Unlike the warn-and-default `idle_task_cadence` parser, a malformed tool spec
 * is never repaired and never partially applied: {@link parseContainerTools}
 * returns the first fault as an error naming the offending tool id and field,
 * and {@link assertContainerTools} throws it. A half-understood spec would mean
 * an unverified download or a PATH entry pointing outside the install prefix —
 * both worse than refusing to start (see `DESIGN-PRINCIPLES.md`, never fail
 * silently).
 *
 * ## Confinement
 *
 * The install prefix is fixed at `/opt/vibe-tools/<id>` and every `bin` entry
 * and `env` value is **relative to that prefix** (`""` is the prefix root). The
 * confinement is enforced here — an absolute path, a `~` prefix, or a `..` that
 * walks above the prefix is rejected — so no spec can aim PATH or `JAVA_HOME`
 * at an arbitrary host path.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type {
  ContainerToolArchitecture,
  ContainerToolArchMap,
  ContainerToolSpec,
  Result,
} from "../types.ts";

/** Architectures a spec may supply a download for. */
export const CONTAINER_TOOL_ARCHITECTURES:
  readonly ContainerToolArchitecture[] = ["amd64", "arm64", "noarch"];

/** Root of the fixed install prefix — a tool lands in `<root>/<id>`. */
export const CONTAINER_TOOL_PREFIX_ROOT = "/opt/vibe-tools";

/** Keys a `container_tools` entry may carry. */
const KNOWN_SPEC_KEYS: ReadonlySet<string> = new Set([
  "id",
  "version",
  "url",
  "sha256",
  "stripComponents",
  "bin",
  "env",
]);

/** Same rule as a provider id in `container/install-providers.sh`. */
const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A SHA-256 digest is exactly 64 hex characters. */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/** POSIX environment variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fixed install prefix for a tool id. */
export function containerToolPrefix(id: string): string {
  return `${CONTAINER_TOOL_PREFIX_ROOT}/${id}`;
}

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short, safe rendering of an operator value for an error message. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Failure carrying a message; `parse` funnels every fault through this. */
class SpecError extends Error {}

/** Throw a fault naming the field it came from. */
function reject(field: string, detail: string): never {
  throw new SpecError(`${field}: ${detail}`);
}

/**
 * Whether a `bin`/`env` value stays inside the install prefix.
 *
 * `""` is the prefix root. Anything absolute, `~`-anchored, NUL-bearing, or
 * walking above the prefix with `..` is out.
 */
function isConfinedRelativePath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("~")) return false;

  let depth = 0;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth--;
      if (depth < 0) return false;
      continue;
    }
    depth++;
  }
  return true;
}

/** Validate one architecture-keyed block (`url` or `sha256`). */
function parseArchMap(
  raw: unknown,
  field: string,
  validateValue: (value: unknown, archField: string) => string,
): ContainerToolArchMap {
  if (!isPlainObject(raw)) {
    reject(
      field,
      `must be an object keyed by architecture ` +
        `(${CONTAINER_TOOL_ARCHITECTURES.join(", ")}), got ${show(raw)}`,
    );
  }

  const map: ContainerToolArchMap = {};
  for (const [arch, value] of Object.entries(raw)) {
    if (
      !CONTAINER_TOOL_ARCHITECTURES.includes(arch as ContainerToolArchitecture)
    ) {
      reject(
        `${field}.${arch}`,
        `unknown architecture — expected one of ` +
          `${CONTAINER_TOOL_ARCHITECTURES.join(", ")}`,
      );
    }
    map[arch as ContainerToolArchitecture] = validateValue(
      value,
      `${field}.${arch}`,
    );
  }

  if (Object.keys(map).length === 0) {
    reject(
      field,
      `must supply at least one architecture ` +
        `(${CONTAINER_TOOL_ARCHITECTURES.join(", ")})`,
    );
  }
  return map;
}

/** Validate a single download URL. */
function parseUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    reject(field, `must be a non-empty string, got ${show(value)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    reject(field, `is not a valid URL: ${show(value)}`);
  }
  if (parsed.protocol !== "https:") {
    reject(field, `must use https:, got ${show(value)}`);
  }
  return value;
}

/** Validate a single SHA-256 digest, normalising it to lower case. */
function parseSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(
      field,
      `must be 64 hexadecimal characters, got ${show(value)}`,
    );
  }
  return value.toLowerCase();
}

/** Every architecture with a URL must have a digest, and the reverse. */
function assertArchitecturesPair(
  url: ContainerToolArchMap,
  sha256: ContainerToolArchMap,
  field: string,
): void {
  for (const arch of CONTAINER_TOOL_ARCHITECTURES) {
    const hasUrl = url[arch] !== undefined;
    const hasSha = sha256[arch] !== undefined;
    if (hasUrl && !hasSha) {
      reject(
        `${field}.sha256.${arch}`,
        `missing — a url without a matching sha256 would be an unverified ` +
          `download`,
      );
    }
    if (hasSha && !hasUrl) {
      reject(
        `${field}.url.${arch}`,
        `missing — sha256.${arch} has nothing to verify`,
      );
    }
  }
}

/** Validate the optional `stripComponents` field. */
function parseStripComponents(raw: unknown, field: string): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    reject(
      field,
      `must be a non-negative integer, got ${show(raw)}`,
    );
  }
  return raw;
}

/** Validate the optional `bin` array. */
function parseBin(raw: unknown, field: string, prefix: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reject(
      field,
      `must be an array of prefix-relative paths, got ${show(raw)}`,
    );
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "string") {
      reject(`${field}[${index}]`, `must be a string, got ${show(entry)}`);
    }
    if (!isConfinedRelativePath(entry)) {
      reject(
        `${field}[${index}]`,
        `must be relative to the install prefix ${prefix} — ` +
          `${show(entry)} is absolute or escapes it`,
      );
    }
    return entry;
  });
}

/** Validate the optional `env` map. */
function parseEnv(
  raw: unknown,
  field: string,
  prefix: string,
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    reject(
      field,
      `must be an object of environment variable names to prefix-relative ` +
        `paths, got ${show(raw)}`,
    );
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      reject(
        field,
        `${show(name)} is not a valid environment variable name`,
      );
    }
    if (typeof value !== "string") {
      reject(`${field}.${name}`, `must be a string, got ${show(value)}`);
    }
    if (!isConfinedRelativePath(value)) {
      reject(
        `${field}.${name}`,
        `must be relative to the install prefix ${prefix} — ` +
          `${show(value)} is absolute or escapes it`,
      );
    }
    env[name] = value;
  }
  return env;
}

/** Validate one entry; `seen` carries the ids already accepted. */
function parseSpec(
  raw: unknown,
  index: number,
  seen: Set<string>,
): ContainerToolSpec {
  const entryField = `container_tools[${index}]`;
  if (!isPlainObject(raw)) {
    reject(entryField, `must be an object, got ${show(raw)}`);
  }

  const rawId = raw.id;
  if (typeof rawId !== "string" || !TOOL_ID_PATTERN.test(rawId)) {
    reject(
      `${entryField}.id`,
      `must be lower-case letters, digits and hyphens starting with a ` +
        `letter, got ${show(rawId)}`,
    );
  }
  if (seen.has(rawId)) {
    reject(`${entryField}.id`, `duplicate tool id ${show(rawId)}`);
  }

  // Every later fault names the tool, so an operator can find it in the file.
  const field = `${entryField} ("${rawId}")`;

  for (const key of Object.keys(raw)) {
    if (!KNOWN_SPEC_KEYS.has(key)) {
      reject(
        `${field}.${key}`,
        `unknown key — expected one of ${[...KNOWN_SPEC_KEYS].join(", ")}`,
      );
    }
  }

  const version = raw.version;
  if (typeof version !== "string" || version.length === 0) {
    reject(`${field}.version`, `is required and must be a non-empty string`);
  }

  const url = parseArchMap(raw.url, `${field}.url`, parseUrl);
  const sha256 = parseArchMap(raw.sha256, `${field}.sha256`, parseSha256);
  assertArchitecturesPair(url, sha256, field);

  const prefix = containerToolPrefix(rawId);
  return {
    id: rawId,
    version,
    url,
    sha256,
    stripComponents: parseStripComponents(
      raw.stripComponents,
      `${field}.stripComponents`,
    ),
    bin: parseBin(raw.bin, `${field}.bin`, prefix),
    env: parseEnv(raw.env, `${field}.env`, prefix),
  };
}

/**
 * Validate the raw `container_tools` block from `.config.json`.
 *
 * Returns `ok` with an empty array when the key is absent, so callers treat
 * "missing" and "empty" the same way. Returns the **first** fault as an error
 * message naming the offending tool id and field — the block is never partially
 * accepted.
 */
export function parseContainerTools(
  raw: unknown,
): Result<ContainerToolSpec[], string> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `container_tools must be an array of tool specs, got ${show(raw)}`,
    };
  }

  const tools: ContainerToolSpec[] = [];
  const seen = new Set<string>();
  try {
    for (let index = 0; index < raw.length; index++) {
      const spec = parseSpec(raw[index], index, seen);
      seen.add(spec.id);
      tools.push(spec);
    }
  } catch (error) {
    if (error instanceof SpecError) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, value: tools };
}

/**
 * {@link parseContainerTools}, but throwing — the fail-loud entry point used at
 * config load so a malformed spec stops the worker before anything downloads.
 */
export function assertContainerTools(raw: unknown): ContainerToolSpec[] {
  const result = parseContainerTools(raw);
  if (!result.ok) {
    throw new Error(`Invalid container_tools in .config.json: ${result.error}`);
  }
  return result.value;
}

/** A deployment's tool selection, as read from its `.config.json`. */
export interface ContainerToolsSelection {
  /** The validated spec; empty when the deployment selects no tools. */
  tools: ContainerToolSpec[];
  /**
   * The deployer's own spec, compact and verbatim — what the build carries as
   * `VIBE_CONTAINER_TOOLS`, so `install-tools.sh` parses exactly what was
   * written. Absent when no tools are selected.
   */
  specJson?: string;
}

/**
 * Read the `container_tools` selection out of a `.config.json`.
 *
 * The host-side callers (the launcher's plan, the image hash) run before the
 * worker loads its configuration, so they read the file directly through here
 * rather than restating the parse.
 *
 * Fail-loud, except for an absent file: the launchers run against checkouts
 * that have not been set up yet, and "no configuration" is genuinely "no tools
 * selected". A file that exists but is unreadable, is not a JSON object, or
 * carries a malformed spec throws — naming the offending field — rather than
 * quietly hashing or building a different selection.
 *
 * @param configFile - Path to the deployment's `.config.json`
 * @returns The validated spec and the verbatim JSON the build carries
 */
export async function readContainerToolsSelection(
  configFile: string,
): Promise<ContainerToolsSelection> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { tools: [] };
    throw new Error(
      `Cannot read container_tools: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read container_tools: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot read container_tools: ${configFile} does not hold a JSON object.`,
    );
  }

  const raw = (parsed as Record<string, unknown>)["container_tools"];
  const tools = assertContainerTools(raw);
  if (tools.length === 0) return { tools: [] };
  return { tools, specJson: JSON.stringify(raw) };
}
