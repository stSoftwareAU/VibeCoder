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
import { hasTraversalSegment } from "./custom_prompt_mounts.ts";

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

/**
 * Claims made by earlier entries: lower-cased `label::phase` → entry index.
 *
 * The phase is part of the key so a label owning two templates (`planning`
 * and `planning_critique`) can carry one entry each, while a second entry
 * claiming a phase already claimed is refused by index.
 */
type SeenClaims = Map<string, number>;

/**
 * What the parse needs beyond the raw block: the configured built-in label
 * names, and how a configured prompt path is resolved to where it is readable.
 *
 * The label names decide which entries override a built-in phase (Issue #849)
 * and default to the stock ones. Path resolution is the identity by default —
 * read on the host, the operator's path *is* the path. Inside the container the
 * launcher has mounted each prompt directory read-only and handed over the
 * host → in-container translation (Issue #850), so the same `.config.json`
 * serves both sides of the boundary.
 */
export interface CustomLabelPromptOptions extends Partial<BuiltInLabelNames> {
  /** Resolve a configured host path to where this run can read it. */
  resolvePath?: (promptPath: string) => string;
}

/** Validate one entry; `seen` carries the claims already accepted. */
function parseEntry(
  raw: unknown,
  index: number,
  seen: SeenClaims,
  names: BuiltInLabelNames,
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
  // Fail loud on an ambiguous mapping: two entries cannot claim one label —
  // nor, for an override, one phase — or whichever came first wins silently.
  const claim = `${label.toLowerCase()}::${overridesPhase ?? ""}`;
  if (seen.has(claim)) {
    reject(
      `${entryField}.label`,
      overridesPhase === undefined
        ? `duplicate label ${show(label)}`
        : `duplicate label ${show(label)} — phase "${overridesPhase}" is ` +
          `already overridden by custom_label_prompts[${seen.get(claim)}]`,
    );
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

  let content: string;
  try {
    content = Deno.readTextFileSync(promptPath);
  } catch (error) {
    reject(
      `${entryField}.prompt_path`,
      `is not a readable file: ${promptPath}${origin} (${
        (error as Error).message
      })`,
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

  seen.set(claim, index);
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
 *
 * @param raw - The `custom_label_prompts` value from `.config.json`
 * @param options - The configured built-in label names, which decide whether an
 *   entry overrides a built-in phase (Issue #849), and the host → container
 *   path translation (Issue #850). Callers holding a `WorkerConfig` must pass
 *   its resolved label names: the stock defaults used otherwise would resolve a
 *   renamed label to the wrong phase, or to none.
 * @returns The validated mappings, or the first fault
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
  const seen: SeenClaims = new Map();
  const { resolvePath = (path: string) => path, ...configuredNames } = options;
  const names: BuiltInLabelNames = {
    ...DEFAULT_BUILTIN_LABEL_NAMES,
    ...configuredNames,
  };
  try {
    for (let index = 0; index < raw.length; index++) {
      mappings.push(parseEntry(raw[index], index, seen, names, resolvePath));
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
 *
 * @param raw - The `custom_label_prompts` value from `.config.json`
 * @param options - The configured built-in label names and path translation
 *   (see {@link parseCustomLabelPrompts})
 * @returns The validated mappings
 * @throws When any entry is invalid
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
 * The label names are read from the same file (Issue #849), so the launcher
 * resolves an override exactly as `loadConfig` will inside the container. Left
 * to the stock defaults it would reject a fleet that renamed `planning` — a
 * valid configuration that the worker itself accepts.
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

  const file = parsed as Record<string, unknown>;
  return assertCustomLabelPrompts(
    file["custom_label_prompts"],
    configuredLabelNames(file),
  ).map((mapping) => mapping.promptPath);
}

/** The configurable built-in label names a raw `.config.json` object states. */
function configuredLabelNames(
  file: Record<string, unknown>,
): Partial<BuiltInLabelNames> {
  // `work_on_label` is deliberately absent: the three discovery labels are
  // hardwired in `lib/config_defaults.ts` and cannot be renamed (Issue #1834).
  const fields: [keyof BuiltInLabelNames, string][] = [
    ["planningLabel", "planning_label"],
    ["questionLabel", "question_label"],
    ["grillMeLabel", "grill_me_label"],
    ["quorumLabel", "quorum_label"],
    ["refineIssueLabel", "refine_issue_label"],
  ];
  const names: Partial<BuiltInLabelNames> = {};
  for (const [field, key] of fields) {
    const value = file[key];
    if (typeof value === "string" && value.length > 0) names[field] = value;
  }
  return names;
}

/**
 * The label names that **dispatch** a configured mapping (Issue #847, part of
 * #843).
 *
 * The trust gate (`operationalDispatchLabels`), the operational-label
 * verification in `label_security.ts`, and the reserved-label filters in
 * `github.ts` all need the label names without the prompt paths. Reading them
 * from this one helper keeps those guards in step with the validated config
 * rather than each rebuilding the list.
 *
 * An **override** is excluded (Issue #849): it names a built-in label that
 * already carries its own gate, so adding it here would change that label's
 * trust posture as a side effect of swapping its template. `work-on` is the
 * sharp case — it sits deliberately outside the AND-gated set, and an operator
 * who overrode its prompt would otherwise find the fleet's main discovery
 * label newly stripped on every untrusted or unattributable add. Only a new
 * label brings a new privileged dispatch with it.
 *
 * @param config - Worker configuration (or any object carrying the resolved list)
 * @returns The dispatching labels, in configuration order and original case
 */
export function customLabelPromptLabels(
  config: { customLabelPrompts: CustomLabelPromptMapping[] },
): string[] {
  return customDispatchMappings(config).map((mapping) => mapping.label);
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
