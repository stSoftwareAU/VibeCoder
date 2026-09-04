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
import type { BuiltInLabelNames } from "./builtin_prompt_overrides.ts";
import {
  DEFAULT_BUILTIN_LABEL_NAMES,
  resolveOverridePhase,
  validateOverrideTemplate,
} from "./builtin_prompt_overrides.ts";

/** Keys a `custom_label_prompts` entry may carry. */
const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "label",
  "prompt_path",
  // Issue #849: which built-in phase this entry overrides. Only meaningful on
  // a built-in label, and only needed for a phase whose label owns more than
  // one template (`planning` also owns `planning_critique`).
  "phase",
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

/** Labels and phases already claimed by earlier entries. */
interface SeenClaims {
  /** Lower-cased `label::phase` keys. */
  entries: Set<string>;
  /** Overridden phase → the entry index that claimed it. */
  phases: Map<string, number>;
}

/** Validate one entry; `seen` carries the claims already accepted. */
function parseEntry(
  raw: unknown,
  index: number,
  seen: SeenClaims,
  names: BuiltInLabelNames,
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
  const requestedPhase = raw.phase === undefined
    ? undefined
    : parseCleanString(raw.phase, `${entryField}.phase`);

  // Issue #849: a label matching a built-in one overrides that phase's
  // template rather than dispatching a new label. Resolved against the
  // *configured* label names, because a fleet may have renamed `planning`.
  const phaseResult = resolveOverridePhase(label, requestedPhase, names);
  if (!phaseResult.ok) {
    reject(
      requestedPhase === undefined
        ? `${entryField}.label`
        : `${entryField}.phase`,
      phaseResult.error,
    );
  }
  const overridesPhase = phaseResult.value;

  // RESERVED_LABELS already contains the three hardwired discovery labels
  // (top-priority/work-on/low-priority), so isReservedLabel's case-
  // insensitive check alone covers both lists the issue names. A built-in
  // label an override names is reserved *by design* — that is what makes it
  // an override — so the check only guards labels that dispatch anew.
  if (overridesPhase === undefined && isReservedLabel(label)) {
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
  const claim = `${label.toLowerCase()}::${overridesPhase ?? ""}`;
  if (seen.entries.has(claim)) {
    reject(`${entryField}.label`, `duplicate label ${show(label)}`);
  }
  // Fail loud on an ambiguous override: two entries cannot both supply the
  // template for one phase, or the phase silently runs whichever came first.
  if (overridesPhase !== undefined && seen.phases.has(overridesPhase)) {
    reject(
      `${entryField}.label`,
      `phase "${overridesPhase}" is already overridden by ` +
        `custom_label_prompts[${seen.phases.get(overridesPhase)}]`,
    );
  }

  const promptPath = parseCleanString(
    raw.prompt_path,
    `${entryField}.prompt_path`,
  );
  if (!promptPath.startsWith("/")) {
    reject(
      `${entryField}.prompt_path`,
      `must be an absolute path, got ${show(promptPath)}`,
    );
  }

  let content: string;
  try {
    content = Deno.readTextFileSync(promptPath);
  } catch (error) {
    reject(
      `${entryField}.prompt_path`,
      `is not a readable file: ${promptPath} (${(error as Error).message})`,
    );
  }

  // An override answers to the placeholder contract of the phase it replaces,
  // not to the `issue` one a new custom label runs (Issue #849).
  if (overridesPhase !== undefined) {
    const templateResult = validateOverrideTemplate(overridesPhase, content);
    if (!templateResult.ok) {
      reject(`${entryField}.prompt_path`, templateResult.error);
    }
  }

  seen.entries.add(claim);
  if (overridesPhase !== undefined) seen.phases.set(overridesPhase, index);
  return {
    label,
    promptPath,
    ...(overridesPhase !== undefined ? { overridesPhase } : {}),
  };
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
  names: BuiltInLabelNames = DEFAULT_BUILTIN_LABEL_NAMES,
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
  const seen: SeenClaims = { entries: new Set(), phases: new Map() };
  try {
    for (let index = 0; index < raw.length; index++) {
      mappings.push(parseEntry(raw[index], index, seen, names));
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
  names: BuiltInLabelNames = DEFAULT_BUILTIN_LABEL_NAMES,
): CustomLabelPromptMapping[] {
  const result = parseCustomLabelPrompts(raw, names);
  if (!result.ok) {
    throw new Error(
      `Invalid custom_label_prompts in .config.json: ${result.error}`,
    );
  }
  return result.value;
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

/**
 * The mappings that dispatch a **new** label (Issue #849).
 *
 * An override names a built-in label, which already has its own priority
 * handler; scanning for it again in the custom-label row would run, say, a
 * `planning`-labelled issue through the implementation phase. Only new labels
 * belong in that scan.
 *
 * @param config - Worker configuration (or any object carrying the list)
 * @returns The mappings with no built-in phase to override
 */
export function customDispatchMappings(
  config: { customLabelPrompts: CustomLabelPromptMapping[] },
): CustomLabelPromptMapping[] {
  return config.customLabelPrompts.filter(
    (mapping) => mapping.overridesPhase === undefined,
  );
}

/**
 * The mappings that override a built-in phase's template (Issue #849).
 *
 * Handed to the prompt builders, which resolve the template for the phase they
 * are building through `resolvePromptTemplate`.
 *
 * @param config - Worker configuration (or any object carrying the list)
 * @returns The mappings that replace a built-in phase template
 */
export function promptOverrideMappings(
  config: { customLabelPrompts: CustomLabelPromptMapping[] },
): CustomLabelPromptMapping[] {
  return config.customLabelPrompts.filter(
    (mapping) => mapping.overridesPhase !== undefined,
  );
}
