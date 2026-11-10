/**
 * `.config.json` surface for deployer-supplied container build-time tools
 * (Issue #69, parent #5).
 *
 * A deployment declares the extra tools its container image bakes in as a
 * top-level `container_tools` array. The module never learns what they are:
 * an id, a version, a URL and a digest are all it reads.
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
 * walks above the prefix is rejected — so no spec can aim PATH or an
 * environment variable at an arbitrary host path.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ // The install prefix is an in-container POSIX path, so the shared confinement
// rule is applied in its POSIX spelling — the same predicate the
// `container_extension` validator uses (Issue #978).
import { isConfinedRelativePath } from "./host_path_style.ts";
/** Architectures a spec may supply a download for. */ export const CONTAINER_TOOL_ARCHITECTURES = [
  "amd64",
  "arm64",
  "noarch"
];
/** Root of the fixed install prefix — a tool lands in `<root>/<id>`. */ export const CONTAINER_TOOL_PREFIX_ROOT = "/opt/vibe-tools";
/** Keys a `container_tools` entry may carry. */ const KNOWN_SPEC_KEYS = new Set([
  "id",
  "version",
  "url",
  "sha256",
  "stripComponents",
  "bin",
  "env"
]);
/** Same rule as a provider id in `container/install-providers.sh`. */ const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** A SHA-256 digest is exactly 64 hex characters. */ const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
/** POSIX environment variable name. */ const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Fixed install prefix for a tool id. */ export function containerToolPrefix(id) {
  return `${CONTAINER_TOOL_PREFIX_ROOT}/${id}`;
}
/** Whether a value is a plain (non-array, non-null) object. */ function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Short, safe rendering of an operator value for an error message. */ function show(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
/** Failure carrying a message; `parse` funnels every fault through this. */ class SpecError extends Error {
}
/** Throw a fault naming the field it came from. */ function reject(field, detail) {
  throw new SpecError(`${field}: ${detail}`);
}
/** Validate one architecture-keyed block (`url` or `sha256`). */ function parseArchMap(raw, field, validateValue) {
  if (!isPlainObject(raw)) {
    reject(field, `must be an object keyed by architecture ` + `(${CONTAINER_TOOL_ARCHITECTURES.join(", ")}), got ${show(raw)}`);
  }
  const map = {};
  for (const [arch, value] of Object.entries(raw)){
    if (!CONTAINER_TOOL_ARCHITECTURES.includes(arch)) {
      reject(`${field}.${arch}`, `unknown architecture — expected one of ` + `${CONTAINER_TOOL_ARCHITECTURES.join(", ")}`);
    }
    map[arch] = validateValue(value, `${field}.${arch}`);
  }
  if (Object.keys(map).length === 0) {
    reject(field, `must supply at least one architecture ` + `(${CONTAINER_TOOL_ARCHITECTURES.join(", ")})`);
  }
  return map;
}
/** Validate a single download URL. */ function parseUrl(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    reject(field, `must be a non-empty string, got ${show(value)}`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch  {
    reject(field, `is not a valid URL: ${show(value)}`);
  }
  if (parsed.protocol !== "https:") {
    reject(field, `must use https:, got ${show(value)}`);
  }
  return value;
}
/** Validate a single SHA-256 digest, normalising it to lower case. */ function parseSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(field, `must be 64 hexadecimal characters, got ${show(value)}`);
  }
  return value.toLowerCase();
}
/** Every architecture with a URL must have a digest, and the reverse. */ function assertArchitecturesPair(url, sha256, field) {
  for (const arch of CONTAINER_TOOL_ARCHITECTURES){
    const hasUrl = url[arch] !== undefined;
    const hasSha = sha256[arch] !== undefined;
    if (hasUrl && !hasSha) {
      reject(`${field}.sha256.${arch}`, `missing — a url without a matching sha256 would be an unverified ` + `download`);
    }
    if (hasSha && !hasUrl) {
      reject(`${field}.url.${arch}`, `missing — sha256.${arch} has nothing to verify`);
    }
  }
}
/** Validate the optional `stripComponents` field. */ function parseStripComponents(raw, field) {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    reject(field, `must be a non-negative integer, got ${show(raw)}`);
  }
  return raw;
}
/** Validate the optional `bin` array. */ function parseBin(raw, field, prefix) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reject(field, `must be an array of prefix-relative paths, got ${show(raw)}`);
  }
  return raw.map((entry, index)=>{
    if (typeof entry !== "string") {
      reject(`${field}[${index}]`, `must be a string, got ${show(entry)}`);
    }
    if (!isConfinedRelativePath(entry)) {
      reject(`${field}[${index}]`, `must be relative to the install prefix ${prefix} — ` + `${show(entry)} is absolute or escapes it`);
    }
    return entry;
  });
}
/** Validate the optional `env` map. */ function parseEnv(raw, field, prefix) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    reject(field, `must be an object of environment variable names to prefix-relative ` + `paths, got ${show(raw)}`);
  }
  const env = {};
  for (const [name, value] of Object.entries(raw)){
    if (!ENV_NAME_PATTERN.test(name)) {
      reject(field, `${show(name)} is not a valid environment variable name`);
    }
    if (typeof value !== "string") {
      reject(`${field}.${name}`, `must be a string, got ${show(value)}`);
    }
    if (!isConfinedRelativePath(value)) {
      reject(`${field}.${name}`, `must be relative to the install prefix ${prefix} — ` + `${show(value)} is absolute or escapes it`);
    }
    env[name] = value;
  }
  return env;
}
/** Validate one entry; `seen` carries the ids already accepted. */ function parseSpec(raw, index, seen) {
  const entryField = `container_tools[${index}]`;
  if (!isPlainObject(raw)) {
    reject(entryField, `must be an object, got ${show(raw)}`);
  }
  const rawId = raw.id;
  if (typeof rawId !== "string" || !TOOL_ID_PATTERN.test(rawId)) {
    reject(`${entryField}.id`, `must be lower-case letters, digits and hyphens starting with a ` + `letter, got ${show(rawId)}`);
  }
  if (seen.has(rawId)) {
    reject(`${entryField}.id`, `duplicate tool id ${show(rawId)}`);
  }
  // Every later fault names the tool, so an operator can find it in the file.
  const field = `${entryField} ("${rawId}")`;
  for (const key of Object.keys(raw)){
    if (!KNOWN_SPEC_KEYS.has(key)) {
      reject(`${field}.${key}`, `unknown key — expected one of ${[
        ...KNOWN_SPEC_KEYS
      ].join(", ")}`);
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
    stripComponents: parseStripComponents(raw.stripComponents, `${field}.stripComponents`),
    bin: parseBin(raw.bin, `${field}.bin`, prefix),
    env: parseEnv(raw.env, `${field}.env`, prefix)
  };
}
/**
 * Validate the raw `container_tools` block from `.config.json`.
 *
 * Returns `ok` with an empty array when the key is absent, so callers treat
 * "missing" and "empty" the same way. Returns the **first** fault as an error
 * message naming the offending tool id and field — the block is never partially
 * accepted.
 */ export function parseContainerTools(raw) {
  if (raw === undefined || raw === null) return {
    ok: true,
    value: []
  };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `container_tools must be an array of tool specs, got ${show(raw)}`
    };
  }
  const tools = [];
  const seen = new Set();
  try {
    for(let index = 0; index < raw.length; index++){
      const spec = parseSpec(raw[index], index, seen);
      seen.add(spec.id);
      tools.push(spec);
    }
  } catch (error) {
    if (error instanceof SpecError) return {
      ok: false,
      error: error.message
    };
    throw error;
  }
  return {
    ok: true,
    value: tools
  };
}
/**
 * {@link parseContainerTools}, but throwing — the fail-loud entry point used at
 * config load so a malformed spec stops the worker before anything downloads.
 */ export function assertContainerTools(raw) {
  const result = parseContainerTools(raw);
  if (!result.ok) {
    throw new Error(`Invalid container_tools in .config.json: ${result.error}`);
  }
  return result.value;
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
 */ export async function readContainerToolsSelection(configFile) {
  let text;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {
      tools: []
    };
    throw new Error(`Cannot read container_tools: ${configFile} is unreadable ` + `(${error.message}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read container_tools: ${configFile} is not readable JSON ` + `(${error.message}). Fix it, or re-run ./setup.sh.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Cannot read container_tools: ${configFile} does not hold a JSON object.`);
  }
  const raw = parsed["container_tools"];
  const tools = assertContainerTools(raw);
  if (tools.length === 0) return {
    tools: []
  };
  return {
    tools,
    specJson: JSON.stringify(raw)
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb250YWluZXJfdG9vbHNfY29uZmlnLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogYC5jb25maWcuanNvbmAgc3VyZmFjZSBmb3IgZGVwbG95ZXItc3VwcGxpZWQgY29udGFpbmVyIGJ1aWxkLXRpbWUgdG9vbHNcbiAqIChJc3N1ZSAjNjksIHBhcmVudCAjNSkuXG4gKlxuICogQSBkZXBsb3ltZW50IGRlY2xhcmVzIHRoZSBleHRyYSB0b29scyBpdHMgY29udGFpbmVyIGltYWdlIGJha2VzIGluIGFzIGFcbiAqIHRvcC1sZXZlbCBgY29udGFpbmVyX3Rvb2xzYCBhcnJheS4gVGhlIG1vZHVsZSBuZXZlciBsZWFybnMgd2hhdCB0aGV5IGFyZTpcbiAqIGFuIGlkLCBhIHZlcnNpb24sIGEgVVJMIGFuZCBhIGRpZ2VzdCBhcmUgYWxsIGl0IHJlYWRzLlxuICogRWFjaCBlbnRyeSBpcyBhICoqZGVjbGFyYXRpdmUgYXJjaGl2ZSBpbnN0YWxsKio6IGRvd25sb2FkIOKGkiB2ZXJpZnkgU0hBLTI1NiDihpJcbiAqIGV4dHJhY3Qg4oaSIGV4cG9zZSBgYmluYCBkaXJlY3RvcmllcyBvbiBQQVRIIOKGkiBzZXQgYGVudmAuIE5vIGluc3RhbGwgY29tbWFuZHMsXG4gKiBubyBhcHQgcGFja2FnZXMsIG5vIGluc3RhbGxlciBzY3JpcHRzLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHRoZSB0cnVzdCBib3VuZGFyeS4gRXZlcnkgbGF0ZXIgc3ViLWlzc3VlIG9mICM1ICh0aGUgaW5zdGFsbFxuICogc3RlcCwgdGhlIENvbnRhaW5lcmZpbGUgd2lyaW5nLCB0aGUgaW1hZ2UgaGFzaCwgUEFUSCBleHBvc3VyZSkgYXNzdW1lcyBhblxuICogYWxyZWFkeS12YWxpZGF0ZWQgc3BlYywgc28gYSBmYXVsdCBtdXN0IGJlIHJlamVjdGVkICoqaGVyZSoqLlxuICpcbiAqICMjIFZhbGlkYXRpb24gcG9zdHVyZSDigJQgZmFpbCBsb3VkXG4gKlxuICogVW5saWtlIHRoZSB3YXJuLWFuZC1kZWZhdWx0IGBpZGxlX3Rhc2tfY2FkZW5jZWAgcGFyc2VyLCBhIG1hbGZvcm1lZCB0b29sIHNwZWNcbiAqIGlzIG5ldmVyIHJlcGFpcmVkIGFuZCBuZXZlciBwYXJ0aWFsbHkgYXBwbGllZDoge0BsaW5rIHBhcnNlQ29udGFpbmVyVG9vbHN9XG4gKiByZXR1cm5zIHRoZSBmaXJzdCBmYXVsdCBhcyBhbiBlcnJvciBuYW1pbmcgdGhlIG9mZmVuZGluZyB0b29sIGlkIGFuZCBmaWVsZCxcbiAqIGFuZCB7QGxpbmsgYXNzZXJ0Q29udGFpbmVyVG9vbHN9IHRocm93cyBpdC4gQSBoYWxmLXVuZGVyc3Rvb2Qgc3BlYyB3b3VsZCBtZWFuXG4gKiBhbiB1bnZlcmlmaWVkIGRvd25sb2FkIG9yIGEgUEFUSCBlbnRyeSBwb2ludGluZyBvdXRzaWRlIHRoZSBpbnN0YWxsIHByZWZpeCDigJRcbiAqIGJvdGggd29yc2UgdGhhbiByZWZ1c2luZyB0byBzdGFydCAoc2VlIGBERVNJR04tUFJJTkNJUExFUy5tZGAsIG5ldmVyIGZhaWxcbiAqIHNpbGVudGx5KS5cbiAqXG4gKiAjIyBDb25maW5lbWVudFxuICpcbiAqIFRoZSBpbnN0YWxsIHByZWZpeCBpcyBmaXhlZCBhdCBgL29wdC92aWJlLXRvb2xzLzxpZD5gIGFuZCBldmVyeSBgYmluYCBlbnRyeVxuICogYW5kIGBlbnZgIHZhbHVlIGlzICoqcmVsYXRpdmUgdG8gdGhhdCBwcmVmaXgqKiAoYFwiXCJgIGlzIHRoZSBwcmVmaXggcm9vdCkuIFRoZVxuICogY29uZmluZW1lbnQgaXMgZW5mb3JjZWQgaGVyZSDigJQgYW4gYWJzb2x1dGUgcGF0aCwgYSBgfmAgcHJlZml4LCBvciBhIGAuLmAgdGhhdFxuICogd2Fsa3MgYWJvdmUgdGhlIHByZWZpeCBpcyByZWplY3RlZCDigJQgc28gbm8gc3BlYyBjYW4gYWltIFBBVEggb3IgYW5cbiAqIGVudmlyb25tZW50IHZhcmlhYmxlIGF0IGFuIGFyYml0cmFyeSBob3N0IHBhdGguXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgQ29udGFpbmVyVG9vbEFyY2hpdGVjdHVyZSxcbiAgQ29udGFpbmVyVG9vbEFyY2hNYXAsXG4gIENvbnRhaW5lclRvb2xTcGVjLFxuICBSZXN1bHQsXG59IGZyb20gXCIuLi90eXBlcy50c1wiO1xuLy8gVGhlIGluc3RhbGwgcHJlZml4IGlzIGFuIGluLWNvbnRhaW5lciBQT1NJWCBwYXRoLCBzbyB0aGUgc2hhcmVkIGNvbmZpbmVtZW50XG4vLyBydWxlIGlzIGFwcGxpZWQgaW4gaXRzIFBPU0lYIHNwZWxsaW5nIOKAlCB0aGUgc2FtZSBwcmVkaWNhdGUgdGhlXG4vLyBgY29udGFpbmVyX2V4dGVuc2lvbmAgdmFsaWRhdG9yIHVzZXMgKElzc3VlICM5NzgpLlxuaW1wb3J0IHsgaXNDb25maW5lZFJlbGF0aXZlUGF0aCB9IGZyb20gXCIuL2hvc3RfcGF0aF9zdHlsZS50c1wiO1xuXG4vKiogQXJjaGl0ZWN0dXJlcyBhIHNwZWMgbWF5IHN1cHBseSBhIGRvd25sb2FkIGZvci4gKi9cbmV4cG9ydCBjb25zdCBDT05UQUlORVJfVE9PTF9BUkNISVRFQ1RVUkVTOlxuICByZWFkb25seSBDb250YWluZXJUb29sQXJjaGl0ZWN0dXJlW10gPSBbXCJhbWQ2NFwiLCBcImFybTY0XCIsIFwibm9hcmNoXCJdO1xuXG4vKiogUm9vdCBvZiB0aGUgZml4ZWQgaW5zdGFsbCBwcmVmaXgg4oCUIGEgdG9vbCBsYW5kcyBpbiBgPHJvb3Q+LzxpZD5gLiAqL1xuZXhwb3J0IGNvbnN0IENPTlRBSU5FUl9UT09MX1BSRUZJWF9ST09UID0gXCIvb3B0L3ZpYmUtdG9vbHNcIjtcblxuLyoqIEtleXMgYSBgY29udGFpbmVyX3Rvb2xzYCBlbnRyeSBtYXkgY2FycnkuICovXG5jb25zdCBLTk9XTl9TUEVDX0tFWVM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJpZFwiLFxuICBcInZlcnNpb25cIixcbiAgXCJ1cmxcIixcbiAgXCJzaGEyNTZcIixcbiAgXCJzdHJpcENvbXBvbmVudHNcIixcbiAgXCJiaW5cIixcbiAgXCJlbnZcIixcbl0pO1xuXG4vKiogU2FtZSBydWxlIGFzIGEgcHJvdmlkZXIgaWQgaW4gYGNvbnRhaW5lci9pbnN0YWxsLXByb3ZpZGVycy5zaGAuICovXG5jb25zdCBUT09MX0lEX1BBVFRFUk4gPSAvXlthLXpdW2EtejAtOS1dKiQvO1xuXG4vKiogQSBTSEEtMjU2IGRpZ2VzdCBpcyBleGFjdGx5IDY0IGhleCBjaGFyYWN0ZXJzLiAqL1xuY29uc3QgU0hBMjU2X1BBVFRFUk4gPSAvXlswLTlhLWZBLUZdezY0fSQvO1xuXG4vKiogUE9TSVggZW52aXJvbm1lbnQgdmFyaWFibGUgbmFtZS4gKi9cbmNvbnN0IEVOVl9OQU1FX1BBVFRFUk4gPSAvXltBLVphLXpfXVtBLVphLXowLTlfXSokLztcblxuLyoqIEZpeGVkIGluc3RhbGwgcHJlZml4IGZvciBhIHRvb2wgaWQuICovXG5leHBvcnQgZnVuY3Rpb24gY29udGFpbmVyVG9vbFByZWZpeChpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0NPTlRBSU5FUl9UT09MX1BSRUZJWF9ST09UfS8ke2lkfWA7XG59XG5cbi8qKiBXaGV0aGVyIGEgdmFsdWUgaXMgYSBwbGFpbiAobm9uLWFycmF5LCBub24tbnVsbCkgb2JqZWN0LiAqL1xuZnVuY3Rpb24gaXNQbGFpbk9iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKiBTaG9ydCwgc2FmZSByZW5kZXJpbmcgb2YgYW4gb3BlcmF0b3IgdmFsdWUgZm9yIGFuIGVycm9yIG1lc3NhZ2UuICovXG5mdW5jdGlvbiBzaG93KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiA/IEpTT04uc3RyaW5naWZ5KHZhbHVlKSA6IFN0cmluZyh2YWx1ZSk7XG59XG5cbi8qKiBGYWlsdXJlIGNhcnJ5aW5nIGEgbWVzc2FnZTsgYHBhcnNlYCBmdW5uZWxzIGV2ZXJ5IGZhdWx0IHRocm91Z2ggdGhpcy4gKi9cbmNsYXNzIFNwZWNFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbi8qKiBUaHJvdyBhIGZhdWx0IG5hbWluZyB0aGUgZmllbGQgaXQgY2FtZSBmcm9tLiAqL1xuZnVuY3Rpb24gcmVqZWN0KGZpZWxkOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgU3BlY0Vycm9yKGAke2ZpZWxkfTogJHtkZXRhaWx9YCk7XG59XG5cbi8qKiBWYWxpZGF0ZSBvbmUgYXJjaGl0ZWN0dXJlLWtleWVkIGJsb2NrIChgdXJsYCBvciBgc2hhMjU2YCkuICovXG5mdW5jdGlvbiBwYXJzZUFyY2hNYXAoXG4gIHJhdzogdW5rbm93bixcbiAgZmllbGQ6IHN0cmluZyxcbiAgdmFsaWRhdGVWYWx1ZTogKHZhbHVlOiB1bmtub3duLCBhcmNoRmllbGQ6IHN0cmluZykgPT4gc3RyaW5nLFxuKTogQ29udGFpbmVyVG9vbEFyY2hNYXAge1xuICBpZiAoIWlzUGxhaW5PYmplY3QocmF3KSkge1xuICAgIHJlamVjdChcbiAgICAgIGZpZWxkLFxuICAgICAgYG11c3QgYmUgYW4gb2JqZWN0IGtleWVkIGJ5IGFyY2hpdGVjdHVyZSBgICtcbiAgICAgICAgYCgke0NPTlRBSU5FUl9UT09MX0FSQ0hJVEVDVFVSRVMuam9pbihcIiwgXCIpfSksIGdvdCAke3Nob3cocmF3KX1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBtYXA6IENvbnRhaW5lclRvb2xBcmNoTWFwID0ge307XG4gIGZvciAoY29uc3QgW2FyY2gsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyYXcpKSB7XG4gICAgaWYgKFxuICAgICAgIUNPTlRBSU5FUl9UT09MX0FSQ0hJVEVDVFVSRVMuaW5jbHVkZXMoYXJjaCBhcyBDb250YWluZXJUb29sQXJjaGl0ZWN0dXJlKVxuICAgICkge1xuICAgICAgcmVqZWN0KFxuICAgICAgICBgJHtmaWVsZH0uJHthcmNofWAsXG4gICAgICAgIGB1bmtub3duIGFyY2hpdGVjdHVyZSDigJQgZXhwZWN0ZWQgb25lIG9mIGAgK1xuICAgICAgICAgIGAke0NPTlRBSU5FUl9UT09MX0FSQ0hJVEVDVFVSRVMuam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBtYXBbYXJjaCBhcyBDb250YWluZXJUb29sQXJjaGl0ZWN0dXJlXSA9IHZhbGlkYXRlVmFsdWUoXG4gICAgICB2YWx1ZSxcbiAgICAgIGAke2ZpZWxkfS4ke2FyY2h9YCxcbiAgICApO1xuICB9XG5cbiAgaWYgKE9iamVjdC5rZXlzKG1hcCkubGVuZ3RoID09PSAwKSB7XG4gICAgcmVqZWN0KFxuICAgICAgZmllbGQsXG4gICAgICBgbXVzdCBzdXBwbHkgYXQgbGVhc3Qgb25lIGFyY2hpdGVjdHVyZSBgICtcbiAgICAgICAgYCgke0NPTlRBSU5FUl9UT09MX0FSQ0hJVEVDVFVSRVMuam9pbihcIiwgXCIpfSlgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cblxuLyoqIFZhbGlkYXRlIGEgc2luZ2xlIGRvd25sb2FkIFVSTC4gKi9cbmZ1bmN0aW9uIHBhcnNlVXJsKHZhbHVlOiB1bmtub3duLCBmaWVsZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICByZWplY3QoZmllbGQsIGBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZywgZ290ICR7c2hvdyh2YWx1ZSl9YCk7XG4gIH1cbiAgbGV0IHBhcnNlZDogVVJMO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZWplY3QoZmllbGQsIGBpcyBub3QgYSB2YWxpZCBVUkw6ICR7c2hvdyh2YWx1ZSl9YCk7XG4gIH1cbiAgaWYgKHBhcnNlZC5wcm90b2NvbCAhPT0gXCJodHRwczpcIikge1xuICAgIHJlamVjdChmaWVsZCwgYG11c3QgdXNlIGh0dHBzOiwgZ290ICR7c2hvdyh2YWx1ZSl9YCk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogVmFsaWRhdGUgYSBzaW5nbGUgU0hBLTI1NiBkaWdlc3QsIG5vcm1hbGlzaW5nIGl0IHRvIGxvd2VyIGNhc2UuICovXG5mdW5jdGlvbiBwYXJzZVNoYTI1Nih2YWx1ZTogdW5rbm93biwgZmllbGQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWUpKSB7XG4gICAgcmVqZWN0KFxuICAgICAgZmllbGQsXG4gICAgICBgbXVzdCBiZSA2NCBoZXhhZGVjaW1hbCBjaGFyYWN0ZXJzLCBnb3QgJHtzaG93KHZhbHVlKX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlLnRvTG93ZXJDYXNlKCk7XG59XG5cbi8qKiBFdmVyeSBhcmNoaXRlY3R1cmUgd2l0aCBhIFVSTCBtdXN0IGhhdmUgYSBkaWdlc3QsIGFuZCB0aGUgcmV2ZXJzZS4gKi9cbmZ1bmN0aW9uIGFzc2VydEFyY2hpdGVjdHVyZXNQYWlyKFxuICB1cmw6IENvbnRhaW5lclRvb2xBcmNoTWFwLFxuICBzaGEyNTY6IENvbnRhaW5lclRvb2xBcmNoTWFwLFxuICBmaWVsZDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGZvciAoY29uc3QgYXJjaCBvZiBDT05UQUlORVJfVE9PTF9BUkNISVRFQ1RVUkVTKSB7XG4gICAgY29uc3QgaGFzVXJsID0gdXJsW2FyY2hdICE9PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgaGFzU2hhID0gc2hhMjU2W2FyY2hdICE9PSB1bmRlZmluZWQ7XG4gICAgaWYgKGhhc1VybCAmJiAhaGFzU2hhKSB7XG4gICAgICByZWplY3QoXG4gICAgICAgIGAke2ZpZWxkfS5zaGEyNTYuJHthcmNofWAsXG4gICAgICAgIGBtaXNzaW5nIOKAlCBhIHVybCB3aXRob3V0IGEgbWF0Y2hpbmcgc2hhMjU2IHdvdWxkIGJlIGFuIHVudmVyaWZpZWQgYCArXG4gICAgICAgICAgYGRvd25sb2FkYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChoYXNTaGEgJiYgIWhhc1VybCkge1xuICAgICAgcmVqZWN0KFxuICAgICAgICBgJHtmaWVsZH0udXJsLiR7YXJjaH1gLFxuICAgICAgICBgbWlzc2luZyDigJQgc2hhMjU2LiR7YXJjaH0gaGFzIG5vdGhpbmcgdG8gdmVyaWZ5YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbi8qKiBWYWxpZGF0ZSB0aGUgb3B0aW9uYWwgYHN0cmlwQ29tcG9uZW50c2AgZmllbGQuICovXG5mdW5jdGlvbiBwYXJzZVN0cmlwQ29tcG9uZW50cyhyYXc6IHVua25vd24sIGZpZWxkOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiAwO1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzSW50ZWdlcihyYXcpIHx8IHJhdyA8IDApIHtcbiAgICByZWplY3QoXG4gICAgICBmaWVsZCxcbiAgICAgIGBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGdvdCAke3Nob3cocmF3KX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHJhdztcbn1cblxuLyoqIFZhbGlkYXRlIHRoZSBvcHRpb25hbCBgYmluYCBhcnJheS4gKi9cbmZ1bmN0aW9uIHBhcnNlQmluKHJhdzogdW5rbm93biwgZmllbGQ6IHN0cmluZywgcHJlZml4OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFtdO1xuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgIHJlamVjdChcbiAgICAgIGZpZWxkLFxuICAgICAgYG11c3QgYmUgYW4gYXJyYXkgb2YgcHJlZml4LXJlbGF0aXZlIHBhdGhzLCBnb3QgJHtzaG93KHJhdyl9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiByYXcubWFwKChlbnRyeSwgaW5kZXgpID0+IHtcbiAgICBpZiAodHlwZW9mIGVudHJ5ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICByZWplY3QoYCR7ZmllbGR9WyR7aW5kZXh9XWAsIGBtdXN0IGJlIGEgc3RyaW5nLCBnb3QgJHtzaG93KGVudHJ5KX1gKTtcbiAgICB9XG4gICAgaWYgKCFpc0NvbmZpbmVkUmVsYXRpdmVQYXRoKGVudHJ5KSkge1xuICAgICAgcmVqZWN0KFxuICAgICAgICBgJHtmaWVsZH1bJHtpbmRleH1dYCxcbiAgICAgICAgYG11c3QgYmUgcmVsYXRpdmUgdG8gdGhlIGluc3RhbGwgcHJlZml4ICR7cHJlZml4fSDigJQgYCArXG4gICAgICAgICAgYCR7c2hvdyhlbnRyeSl9IGlzIGFic29sdXRlIG9yIGVzY2FwZXMgaXRgLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGVudHJ5O1xuICB9KTtcbn1cblxuLyoqIFZhbGlkYXRlIHRoZSBvcHRpb25hbCBgZW52YCBtYXAuICovXG5mdW5jdGlvbiBwYXJzZUVudihcbiAgcmF3OiB1bmtub3duLFxuICBmaWVsZDogc3RyaW5nLFxuICBwcmVmaXg6IHN0cmluZyxcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB7fTtcbiAgaWYgKCFpc1BsYWluT2JqZWN0KHJhdykpIHtcbiAgICByZWplY3QoXG4gICAgICBmaWVsZCxcbiAgICAgIGBtdXN0IGJlIGFuIG9iamVjdCBvZiBlbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lcyB0byBwcmVmaXgtcmVsYXRpdmUgYCArXG4gICAgICAgIGBwYXRocywgZ290ICR7c2hvdyhyYXcpfWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtuYW1lLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmF3KSkge1xuICAgIGlmICghRU5WX05BTUVfUEFUVEVSTi50ZXN0KG5hbWUpKSB7XG4gICAgICByZWplY3QoXG4gICAgICAgIGZpZWxkLFxuICAgICAgICBgJHtzaG93KG5hbWUpfSBpcyBub3QgYSB2YWxpZCBlbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJlamVjdChgJHtmaWVsZH0uJHtuYW1lfWAsIGBtdXN0IGJlIGEgc3RyaW5nLCBnb3QgJHtzaG93KHZhbHVlKX1gKTtcbiAgICB9XG4gICAgaWYgKCFpc0NvbmZpbmVkUmVsYXRpdmVQYXRoKHZhbHVlKSkge1xuICAgICAgcmVqZWN0KFxuICAgICAgICBgJHtmaWVsZH0uJHtuYW1lfWAsXG4gICAgICAgIGBtdXN0IGJlIHJlbGF0aXZlIHRvIHRoZSBpbnN0YWxsIHByZWZpeCAke3ByZWZpeH0g4oCUIGAgK1xuICAgICAgICAgIGAke3Nob3codmFsdWUpfSBpcyBhYnNvbHV0ZSBvciBlc2NhcGVzIGl0YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGVudltuYW1lXSA9IHZhbHVlO1xuICB9XG4gIHJldHVybiBlbnY7XG59XG5cbi8qKiBWYWxpZGF0ZSBvbmUgZW50cnk7IGBzZWVuYCBjYXJyaWVzIHRoZSBpZHMgYWxyZWFkeSBhY2NlcHRlZC4gKi9cbmZ1bmN0aW9uIHBhcnNlU3BlYyhcbiAgcmF3OiB1bmtub3duLFxuICBpbmRleDogbnVtYmVyLFxuICBzZWVuOiBTZXQ8c3RyaW5nPixcbik6IENvbnRhaW5lclRvb2xTcGVjIHtcbiAgY29uc3QgZW50cnlGaWVsZCA9IGBjb250YWluZXJfdG9vbHNbJHtpbmRleH1dYDtcbiAgaWYgKCFpc1BsYWluT2JqZWN0KHJhdykpIHtcbiAgICByZWplY3QoZW50cnlGaWVsZCwgYG11c3QgYmUgYW4gb2JqZWN0LCBnb3QgJHtzaG93KHJhdyl9YCk7XG4gIH1cblxuICBjb25zdCByYXdJZCA9IHJhdy5pZDtcbiAgaWYgKHR5cGVvZiByYXdJZCAhPT0gXCJzdHJpbmdcIiB8fCAhVE9PTF9JRF9QQVRURVJOLnRlc3QocmF3SWQpKSB7XG4gICAgcmVqZWN0KFxuICAgICAgYCR7ZW50cnlGaWVsZH0uaWRgLFxuICAgICAgYG11c3QgYmUgbG93ZXItY2FzZSBsZXR0ZXJzLCBkaWdpdHMgYW5kIGh5cGhlbnMgc3RhcnRpbmcgd2l0aCBhIGAgK1xuICAgICAgICBgbGV0dGVyLCBnb3QgJHtzaG93KHJhd0lkKX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKHNlZW4uaGFzKHJhd0lkKSkge1xuICAgIHJlamVjdChgJHtlbnRyeUZpZWxkfS5pZGAsIGBkdXBsaWNhdGUgdG9vbCBpZCAke3Nob3cocmF3SWQpfWApO1xuICB9XG5cbiAgLy8gRXZlcnkgbGF0ZXIgZmF1bHQgbmFtZXMgdGhlIHRvb2wsIHNvIGFuIG9wZXJhdG9yIGNhbiBmaW5kIGl0IGluIHRoZSBmaWxlLlxuICBjb25zdCBmaWVsZCA9IGAke2VudHJ5RmllbGR9IChcIiR7cmF3SWR9XCIpYDtcblxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhyYXcpKSB7XG4gICAgaWYgKCFLTk9XTl9TUEVDX0tFWVMuaGFzKGtleSkpIHtcbiAgICAgIHJlamVjdChcbiAgICAgICAgYCR7ZmllbGR9LiR7a2V5fWAsXG4gICAgICAgIGB1bmtub3duIGtleSDigJQgZXhwZWN0ZWQgb25lIG9mICR7Wy4uLktOT1dOX1NQRUNfS0VZU10uam9pbihcIiwgXCIpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHZlcnNpb24gPSByYXcudmVyc2lvbjtcbiAgaWYgKHR5cGVvZiB2ZXJzaW9uICE9PSBcInN0cmluZ1wiIHx8IHZlcnNpb24ubGVuZ3RoID09PSAwKSB7XG4gICAgcmVqZWN0KGAke2ZpZWxkfS52ZXJzaW9uYCwgYGlzIHJlcXVpcmVkIGFuZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ2ApO1xuICB9XG5cbiAgY29uc3QgdXJsID0gcGFyc2VBcmNoTWFwKHJhdy51cmwsIGAke2ZpZWxkfS51cmxgLCBwYXJzZVVybCk7XG4gIGNvbnN0IHNoYTI1NiA9IHBhcnNlQXJjaE1hcChyYXcuc2hhMjU2LCBgJHtmaWVsZH0uc2hhMjU2YCwgcGFyc2VTaGEyNTYpO1xuICBhc3NlcnRBcmNoaXRlY3R1cmVzUGFpcih1cmwsIHNoYTI1NiwgZmllbGQpO1xuXG4gIGNvbnN0IHByZWZpeCA9IGNvbnRhaW5lclRvb2xQcmVmaXgocmF3SWQpO1xuICByZXR1cm4ge1xuICAgIGlkOiByYXdJZCxcbiAgICB2ZXJzaW9uLFxuICAgIHVybCxcbiAgICBzaGEyNTYsXG4gICAgc3RyaXBDb21wb25lbnRzOiBwYXJzZVN0cmlwQ29tcG9uZW50cyhcbiAgICAgIHJhdy5zdHJpcENvbXBvbmVudHMsXG4gICAgICBgJHtmaWVsZH0uc3RyaXBDb21wb25lbnRzYCxcbiAgICApLFxuICAgIGJpbjogcGFyc2VCaW4ocmF3LmJpbiwgYCR7ZmllbGR9LmJpbmAsIHByZWZpeCksXG4gICAgZW52OiBwYXJzZUVudihyYXcuZW52LCBgJHtmaWVsZH0uZW52YCwgcHJlZml4KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGUgcmF3IGBjb250YWluZXJfdG9vbHNgIGJsb2NrIGZyb20gYC5jb25maWcuanNvbmAuXG4gKlxuICogUmV0dXJucyBgb2tgIHdpdGggYW4gZW1wdHkgYXJyYXkgd2hlbiB0aGUga2V5IGlzIGFic2VudCwgc28gY2FsbGVycyB0cmVhdFxuICogXCJtaXNzaW5nXCIgYW5kIFwiZW1wdHlcIiB0aGUgc2FtZSB3YXkuIFJldHVybnMgdGhlICoqZmlyc3QqKiBmYXVsdCBhcyBhbiBlcnJvclxuICogbWVzc2FnZSBuYW1pbmcgdGhlIG9mZmVuZGluZyB0b29sIGlkIGFuZCBmaWVsZCDigJQgdGhlIGJsb2NrIGlzIG5ldmVyIHBhcnRpYWxseVxuICogYWNjZXB0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvbnRhaW5lclRvb2xzKFxuICByYXc6IHVua25vd24sXG4pOiBSZXN1bHQ8Q29udGFpbmVyVG9vbFNwZWNbXSwgc3RyaW5nPiB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcgPT09IG51bGwpIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogW10gfTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBjb250YWluZXJfdG9vbHMgbXVzdCBiZSBhbiBhcnJheSBvZiB0b29sIHNwZWNzLCBnb3QgJHtzaG93KHJhdyl9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdG9vbHM6IENvbnRhaW5lclRvb2xTcGVjW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICB0cnkge1xuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCByYXcubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgICBjb25zdCBzcGVjID0gcGFyc2VTcGVjKHJhd1tpbmRleF0sIGluZGV4LCBzZWVuKTtcbiAgICAgIHNlZW4uYWRkKHNwZWMuaWQpO1xuICAgICAgdG9vbHMucHVzaChzcGVjKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgU3BlY0Vycm9yKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiBlcnJvci5tZXNzYWdlIH07XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0b29scyB9O1xufVxuXG4vKipcbiAqIHtAbGluayBwYXJzZUNvbnRhaW5lclRvb2xzfSwgYnV0IHRocm93aW5nIOKAlCB0aGUgZmFpbC1sb3VkIGVudHJ5IHBvaW50IHVzZWQgYXRcbiAqIGNvbmZpZyBsb2FkIHNvIGEgbWFsZm9ybWVkIHNwZWMgc3RvcHMgdGhlIHdvcmtlciBiZWZvcmUgYW55dGhpbmcgZG93bmxvYWRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Q29udGFpbmVyVG9vbHMocmF3OiB1bmtub3duKTogQ29udGFpbmVyVG9vbFNwZWNbXSB7XG4gIGNvbnN0IHJlc3VsdCA9IHBhcnNlQ29udGFpbmVyVG9vbHMocmF3KTtcbiAgaWYgKCFyZXN1bHQub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgY29udGFpbmVyX3Rvb2xzIGluIC5jb25maWcuanNvbjogJHtyZXN1bHQuZXJyb3J9YCk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdC52YWx1ZTtcbn1cblxuLyoqIEEgZGVwbG95bWVudCdzIHRvb2wgc2VsZWN0aW9uLCBhcyByZWFkIGZyb20gaXRzIGAuY29uZmlnLmpzb25gLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb250YWluZXJUb29sc1NlbGVjdGlvbiB7XG4gIC8qKiBUaGUgdmFsaWRhdGVkIHNwZWM7IGVtcHR5IHdoZW4gdGhlIGRlcGxveW1lbnQgc2VsZWN0cyBubyB0b29scy4gKi9cbiAgdG9vbHM6IENvbnRhaW5lclRvb2xTcGVjW107XG4gIC8qKlxuICAgKiBUaGUgZGVwbG95ZXIncyBvd24gc3BlYywgY29tcGFjdCBhbmQgdmVyYmF0aW0g4oCUIHdoYXQgdGhlIGJ1aWxkIGNhcnJpZXMgYXNcbiAgICogYFZJQkVfQ09OVEFJTkVSX1RPT0xTYCwgc28gYGluc3RhbGwtdG9vbHMuc2hgIHBhcnNlcyBleGFjdGx5IHdoYXQgd2FzXG4gICAqIHdyaXR0ZW4uIEFic2VudCB3aGVuIG5vIHRvb2xzIGFyZSBzZWxlY3RlZC5cbiAgICovXG4gIHNwZWNKc29uPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIGBjb250YWluZXJfdG9vbHNgIHNlbGVjdGlvbiBvdXQgb2YgYSBgLmNvbmZpZy5qc29uYC5cbiAqXG4gKiBUaGUgaG9zdC1zaWRlIGNhbGxlcnMgKHRoZSBsYXVuY2hlcidzIHBsYW4sIHRoZSBpbWFnZSBoYXNoKSBydW4gYmVmb3JlIHRoZVxuICogd29ya2VyIGxvYWRzIGl0cyBjb25maWd1cmF0aW9uLCBzbyB0aGV5IHJlYWQgdGhlIGZpbGUgZGlyZWN0bHkgdGhyb3VnaCBoZXJlXG4gKiByYXRoZXIgdGhhbiByZXN0YXRpbmcgdGhlIHBhcnNlLlxuICpcbiAqIEZhaWwtbG91ZCwgZXhjZXB0IGZvciBhbiBhYnNlbnQgZmlsZTogdGhlIGxhdW5jaGVycyBydW4gYWdhaW5zdCBjaGVja291dHNcbiAqIHRoYXQgaGF2ZSBub3QgYmVlbiBzZXQgdXAgeWV0LCBhbmQgXCJubyBjb25maWd1cmF0aW9uXCIgaXMgZ2VudWluZWx5IFwibm8gdG9vbHNcbiAqIHNlbGVjdGVkXCIuIEEgZmlsZSB0aGF0IGV4aXN0cyBidXQgaXMgdW5yZWFkYWJsZSwgaXMgbm90IGEgSlNPTiBvYmplY3QsIG9yXG4gKiBjYXJyaWVzIGEgbWFsZm9ybWVkIHNwZWMgdGhyb3dzIOKAlCBuYW1pbmcgdGhlIG9mZmVuZGluZyBmaWVsZCDigJQgcmF0aGVyIHRoYW5cbiAqIHF1aWV0bHkgaGFzaGluZyBvciBidWlsZGluZyBhIGRpZmZlcmVudCBzZWxlY3Rpb24uXG4gKlxuICogQHBhcmFtIGNvbmZpZ0ZpbGUgLSBQYXRoIHRvIHRoZSBkZXBsb3ltZW50J3MgYC5jb25maWcuanNvbmBcbiAqIEByZXR1cm5zIFRoZSB2YWxpZGF0ZWQgc3BlYyBhbmQgdGhlIHZlcmJhdGltIEpTT04gdGhlIGJ1aWxkIGNhcnJpZXNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRDb250YWluZXJUb29sc1NlbGVjdGlvbihcbiAgY29uZmlnRmlsZTogc3RyaW5nLFxuKTogUHJvbWlzZTxDb250YWluZXJUb29sc1NlbGVjdGlvbj4ge1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICB0cnkge1xuICAgIHRleHQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShjb25maWdGaWxlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIHsgdG9vbHM6IFtdIH07XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENhbm5vdCByZWFkIGNvbnRhaW5lcl90b29sczogJHtjb25maWdGaWxlfSBpcyB1bnJlYWRhYmxlIGAgK1xuICAgICAgICBgKCR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfSkuYCxcbiAgICApO1xuICB9XG5cbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVhZCBjb250YWluZXJfdG9vbHM6ICR7Y29uZmlnRmlsZX0gaXMgbm90IHJlYWRhYmxlIEpTT04gYCArXG4gICAgICAgIGAoJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9KS4gRml4IGl0LCBvciByZS1ydW4gLi9zZXR1cC5zaC5gLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVhZCBjb250YWluZXJfdG9vbHM6ICR7Y29uZmlnRmlsZX0gZG9lcyBub3QgaG9sZCBhIEpTT04gb2JqZWN0LmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJhdyA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW1wiY29udGFpbmVyX3Rvb2xzXCJdO1xuICBjb25zdCB0b29scyA9IGFzc2VydENvbnRhaW5lclRvb2xzKHJhdyk7XG4gIGlmICh0b29scy5sZW5ndGggPT09IDApIHJldHVybiB7IHRvb2xzOiBbXSB9O1xuICByZXR1cm4geyB0b29scywgc3BlY0pzb246IEpTT04uc3RyaW5naWZ5KHJhdykgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtDQyxHQVFELDhFQUE4RTtBQUM5RSxpRUFBaUU7QUFDakUscURBQXFEO0FBQ3JELFNBQVMsc0JBQXNCLFFBQVEsdUJBQXVCO0FBRTlELG9EQUFvRCxHQUNwRCxPQUFPLE1BQU0sK0JBQzRCO0VBQUM7RUFBUztFQUFTO0NBQVMsQ0FBQztBQUV0RSxzRUFBc0UsR0FDdEUsT0FBTyxNQUFNLDZCQUE2QixrQkFBa0I7QUFFNUQsOENBQThDLEdBQzlDLE1BQU0sa0JBQXVDLElBQUksSUFBSTtFQUNuRDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBRUQsb0VBQW9FLEdBQ3BFLE1BQU0sa0JBQWtCO0FBRXhCLG1EQUFtRCxHQUNuRCxNQUFNLGlCQUFpQjtBQUV2QixxQ0FBcUMsR0FDckMsTUFBTSxtQkFBbUI7QUFFekIsd0NBQXdDLEdBQ3hDLE9BQU8sU0FBUyxvQkFBb0IsRUFBVTtFQUM1QyxPQUFPLEdBQUcsMkJBQTJCLENBQUMsRUFBRSxJQUFJO0FBQzlDO0FBRUEsNkRBQTZELEdBQzdELFNBQVMsY0FBYyxLQUFjO0VBQ25DLE9BQU8sT0FBTyxVQUFVLFlBQVksVUFBVSxRQUFRLENBQUMsTUFBTSxPQUFPLENBQUM7QUFDdkU7QUFFQSxxRUFBcUUsR0FDckUsU0FBUyxLQUFLLEtBQWM7RUFDMUIsT0FBTyxPQUFPLFVBQVUsV0FBVyxLQUFLLFNBQVMsQ0FBQyxTQUFTLE9BQU87QUFDcEU7QUFFQSwwRUFBMEUsR0FDMUUsTUFBTSxrQkFBa0I7QUFBTztBQUUvQixpREFBaUQsR0FDakQsU0FBUyxPQUFPLEtBQWEsRUFBRSxNQUFjO0VBQzNDLE1BQU0sSUFBSSxVQUFVLEdBQUcsTUFBTSxFQUFF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
// denoCacheMetadata=1671144413616966760,15268566556325905180