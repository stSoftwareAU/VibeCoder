/**
 * `.config.json` surface for operator-defined custom label → prompt file
 * mappings (Issue #846, part of #843).
 *
 * An operator can dispatch a GitHub label to a prompt template that lives
 * outside the public repository — an absolute path on the host — so the
 * Vibe Coder can be extended with private prompts without publishing them.
 * This module is the trust boundary: dispatch (a later sub-issue of #843)
 * assumes an already-validated mapping.
 *
 * ## Validation posture — fail loud
 *
 * Matching `lib/container_tools_config.ts`'s posture (and unlike the
 * warn-and-default `idle_task_cadence` parser): a malformed mapping is never
 * repaired and never partially applied. {@link parseCustomLabelPrompts}
 * returns the first fault as an error naming the offending entry and field,
 * and {@link assertCustomLabelPrompts} throws it. A silently dropped mapping
 * is exactly the failure #843 rules out — an operator who added a mapping
 * and saw it silently ignored would never know their extension never
 * dispatched.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { CustomLabelPromptMapping, Result } from "../types.ts";
import { isReservedLabel } from "./config_defaults.ts";
import { isWorkerAppliableLabel } from "./worker_label_guard.ts";
import { hasTraversalSegment } from "./custom_prompt_mounts.ts";

/** Keys a `custom_label_prompts` entry may carry. */
const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "label",
  "prompt_path",
]);

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short, safe rendering of an operator value for an error message. */
function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Whether a string contains a NUL byte or a C0/C1 control character. */
function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Failure carrying a message; `parse` funnels every fault through this. */
class MappingError extends Error {}

/** Throw a fault naming the field it came from. */
function reject(field: string, detail: string): never {
  throw new MappingError(`${field}: ${detail}`);
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

/**
 * How a configured prompt path is resolved to where it is readable.
 *
 * The identity by default — read on the host, the operator's path *is* the
 * path. Inside the container the launcher has mounted each prompt directory
 * read-only and handed over the host → in-container translation (Issue #850),
 * so the same `.config.json` serves both sides of the boundary.
 */
export interface CustomLabelPromptOptions {
  /** Resolve a configured host path to where this run can read it. */
  resolvePath?: (promptPath: string) => string;
}

/** Validate one entry; `seenLabels` carries the labels already accepted. */
function parseEntry(
  raw: unknown,
  index: number,
  seenLabels: Set<string>,
  resolvePath: (promptPath: string) => string,
): CustomLabelPromptMapping {
  const entryField = `custom_label_prompts[${index}]`;
  if (!isPlainObject(raw)) {
    reject(entryField, `must be an object, got ${show(raw)}`);
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      reject(
        entryField,
        `unknown key "${key}" — expected one of ${
          [...KNOWN_ENTRY_KEYS].join(", ")
        }`,
      );
    }
  }

  const label = parseCleanString(raw.label, `${entryField}.label`);
  // RESERVED_LABELS already contains the three hardwired discovery labels
  // (top-priority/work-on/low-priority), so isReservedLabel's case-
  // insensitive check alone covers both lists the issue names.
  if (isReservedLabel(label)) {
    reject(
      `${entryField}.label`,
      `"${label}" is a reserved or discovery label and cannot be remapped`,
    );
  }
  // Issue #847: a custom label dispatches a privileged phase, so the worker
  // must never self-apply one — the creation-time filters treat it as
  // reserved. A label the worker legitimately applies itself (`idle-task`,
  // `security`, `severity:high`, …) would therefore be stripped from the
  // worker's own issues, starving the very flow that files them. Those labels
  // are not in RESERVED_LABELS by design, so refuse the collision at config
  // load rather than let it fail silently at runtime.
  if (isWorkerAppliableLabel(label)) {
    reject(
      `${entryField}.label`,
      `"${label}" is a label the worker applies itself and cannot be remapped`,
    );
  }
  if (seenLabels.has(label.toLowerCase())) {
    reject(`${entryField}.label`, `duplicate label ${show(label)}`);
  }

  const configuredPath = parseCleanString(
    raw.prompt_path,
    `${entryField}.prompt_path`,
  );
  if (!configuredPath.startsWith("/")) {
    reject(
      `${entryField}.prompt_path`,
      `must be an absolute path, got ${show(configuredPath)}`,
    );
  }
  // Issue #850: in container mode the containing directory of this path is
  // bind-mounted, and the mount-source allowlist compares strings — so a
  // traversal segment would derive a source the allowlist never judged
  // (`/srv/../home/operator` is the home directory once resolved). Refused at
  // the trust boundary, in both run modes, rather than only at launch.
  if (hasTraversalSegment(configuredPath)) {
    reject(
      `${entryField}.prompt_path`,
      `must not contain a "." or ".." segment, got ${show(configuredPath)}`,
    );
  }

  // Validated — and, from here on, used — at the path this run can actually
  // read it at: inside the container that is the launcher's read-only mount
  // of the operator's directory (Issue #850).
  const promptPath = resolvePath(configuredPath);
  const origin = promptPath === configuredPath
    ? ""
    : ` (mounted from ${configuredPath})`;

  try {
    Deno.readTextFileSync(promptPath);
  } catch (error) {
    reject(
      `${entryField}.prompt_path`,
      `is not a readable file: ${promptPath}${origin} (${
        (error as Error).message
      })`,
    );
  }

  seenLabels.add(label.toLowerCase());
  return { label, promptPath };
}

/**
 * Validate the raw `custom_label_prompts` block from `.config.json`.
 *
 * Returns `ok` with an empty array when the key is absent, so an operator
 * who never opts in gets today's behaviour unchanged. Returns the **first**
 * fault as an error message naming the offending entry and field — the list
 * is never partially accepted.
 */
export function parseCustomLabelPrompts(
  raw: unknown,
  options: CustomLabelPromptOptions = {},
): Result<CustomLabelPromptMapping[], string> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        `custom_label_prompts must be an array of label/prompt_path mappings, got ${
          show(raw)
        }`,
    };
  }

  const mappings: CustomLabelPromptMapping[] = [];
  const seenLabels = new Set<string>();
  const resolvePath = options.resolvePath ?? ((path: string) => path);
  try {
    for (let index = 0; index < raw.length; index++) {
      mappings.push(parseEntry(raw[index], index, seenLabels, resolvePath));
    }
  } catch (error) {
    if (error instanceof MappingError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  return { ok: true, value: mappings };
}

/**
 * {@link parseCustomLabelPrompts}, but throwing — the fail-loud entry point
 * used at config load so a malformed, colliding or unreadable mapping stops
 * the worker before a custom label could ever dispatch silently.
 */
export function assertCustomLabelPrompts(
  raw: unknown,
  options: CustomLabelPromptOptions = {},
): CustomLabelPromptMapping[] {
  const result = parseCustomLabelPrompts(raw, options);
  if (!result.ok) {
    throw new Error(
      `Invalid custom_label_prompts in .config.json: ${result.error}`,
    );
  }
  return result.value;
}

/**
 * The configured prompt paths, read straight from a `.config.json` on disk
 * (Issue #850, part of #843).
 *
 * Used by the container launcher, which must know which host directories to
 * mount before any worker has loaded a configuration. Absent file → no
 * mappings, which is what an unconfigured host has always had. A file that
 * exists but cannot be read, is not JSON, or states a malformed mapping is
 * **not** treated as unconfigured: it throws, because launching without the
 * mount would leave every custom label failing at dispatch inside the
 * container.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The configured absolute host prompt paths, in configuration order
 * @throws When the file exists but is unreadable, is not a JSON object, or
 *   carries an invalid `custom_label_prompts` block
 */
export async function readConfiguredCustomPromptPaths(
  configFile: string,
): Promise<string[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new Error(
      `Cannot read the custom prompt mappings: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read the custom prompt mappings: ${configFile} is not valid ` +
        `JSON (${(error as Error).message}).`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Cannot read the custom prompt mappings: ${configFile} is not a JSON ` +
        `object.`,
    );
  }

  const raw = (parsed as Record<string, unknown>)["custom_label_prompts"];
  return assertCustomLabelPrompts(raw).map((mapping) => mapping.promptPath);
}

/**
 * The label names of every configured mapping (Issue #847, part of #843).
 *
 * The trust gate (`operationalDispatchLabels`), the operational-label
 * verification in `label_security.ts`, and the reserved-label filters in
 * `github.ts` all need the label names without the prompt paths. Reading them
 * from this one helper keeps those guards in step with the validated config
 * rather than each rebuilding the list.
 *
 * @param config - Worker configuration (or any object carrying the resolved list)
 * @returns The configured labels, in configuration order and original case
 */
export function customLabelPromptLabels(
  config: { customLabelPrompts: CustomLabelPromptMapping[] },
): string[] {
  return config.customLabelPrompts.map((mapping) => mapping.label);
}

/**
 * Resolve the configured prompt file for a GitHub label, if any (Issue #846,
 * part of #843).
 *
 * A pure lookup against the already-validated `WorkerConfig.customLabelPrompts`
 * list — the trust gate (#847) and dispatch (#848) build on this rather than
 * re-parsing the raw config. Comparison is case-insensitive, matching GitHub's
 * own label handling and `isReservedLabel`.
 *
 * @param config - Worker configuration (or any object carrying the resolved list)
 * @param label - The GitHub label to look up
 * @returns The mapping's absolute prompt path, or `undefined` when no mapping
 *   is configured for that label
 */
export function customLabelPromptPath(
  config: { customLabelPrompts: CustomLabelPromptMapping[] },
  label: string,
): string | undefined {
  const target = label.toLowerCase();
  return config.customLabelPrompts.find((mapping) =>
    mapping.label.toLowerCase() === target
  )?.promptPath;
}
